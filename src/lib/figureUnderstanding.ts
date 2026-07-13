/**
 * Figure-understanding helper.
 *
 * Wraps the multimodal vision adapter with an exam-prep-focused system prompt
 * and parses the model's JSON response into a structured `FigureExplanation`.
 *
 * Intentionally tolerant of fenced code blocks (LM Studio's Gemma loads
 * sometimes wrap JSON in ```json … ``` regardless of instructions) and
 * structurally validates the result so a malformed/hallucinated answer never
 * reaches the UI as a half-rendered card.
 */

import { generateTextWithImages } from './visionAdapter';

export interface FigureExplanation {
  topic: string;
  /** 1-2 sentence plain-English description of what the figure shows. */
  summary: string;
  /** 2-5 bullet points covering implications or formulas. */
  bullets: string[];
  /** For charts: "x: yield, y: bond price" — empty string if not applicable. */
  axes?: string;
  generatedAt: string;
}

export interface ExplainCurriculumFigureOptions {
  imageBase64: string;
  mime?: 'image/png' | 'image/jpeg' | 'image/webp';
  topicTitle: string;
  /** Optional small text excerpt above/below the figure to anchor interpretation. */
  contextHint?: string;
  settings?: { baseUrl?: string; model?: string };
  signal?: AbortSignal;
}

const SYSTEM_PROMPT =
  'You are explaining a figure or chart from a CFA exam-prep curriculum. ' +
  'Be concise, exam-focused, and only describe what you can actually see in the image. ' +
  'Do not invent data points, numbers, or labels that are not visible. ' +
  'Respond as JSON with this exact shape and nothing else: ' +
  '{ "summary": string, "bullets": string[], "axes": string }. ' +
  'For non-chart figures (e.g. a diagram or table), use an empty string for "axes". ' +
  'Keep bullets to 2-5 entries.';

/** Strip a single ```json …``` or ``` …``` fence if present, then return the inner text. */
function stripFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1] : text;
}

/** Slice the first `{ … }` block out of arbitrary model output. */
function extractObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}

/**
 * Ask the local multimodal model to describe a curriculum figure and parse
 * the response into a structured `FigureExplanation`.
 *
 * Throws when the response is empty, unparseable, or missing the required
 * `summary` field — the UI surfaces that error directly so the user can pick
 * a different model or image.
 */
export async function explainCurriculumFigure(
  opts: ExplainCurriculumFigureOptions,
): Promise<FigureExplanation> {
  const promptParts: string[] = [`Topic: ${opts.topicTitle}`];
  if (opts.contextHint && opts.contextHint.trim()) {
    promptParts.push(`Context (text near the figure):\n${opts.contextHint.trim()}`);
  }
  promptParts.push(
    'Describe the attached figure for an exam candidate. Return strict JSON as instructed.',
  );

  const { text } = await generateTextWithImages({
    prompt: promptParts.join('\n\n'),
    images: [{ base64: opts.imageBase64, mime: opts.mime }],
    system: SYSTEM_PROMPT,
    temperature: 0.2,
    settings: opts.settings,
    signal: opts.signal,
  });

  if (!text || !text.trim()) {
    throw new Error('The model returned an empty figure description. Try a more capable vision model.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractObject(stripFence(text)));
  } catch {
    throw new Error('The model did not return parseable JSON for the figure. Try a more capable vision model.');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('The model returned a non-object response for the figure.');
  }
  const obj = parsed as { summary?: unknown; bullets?: unknown; axes?: unknown };

  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  if (!summary) {
    throw new Error('The model response was missing a non-empty "summary" field.');
  }

  const bulletsRaw = Array.isArray(obj.bullets) ? obj.bullets : [];
  const bullets = bulletsRaw
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim())
    .slice(0, 5);

  const axes = typeof obj.axes === 'string' ? obj.axes.trim() : '';

  return {
    topic: opts.topicTitle,
    summary,
    bullets,
    ...(axes ? { axes } : {}),
    generatedAt: new Date().toISOString(),
  };
}
