/**
 * Multi-speaker AI study podcasts via local kokoro-js TTS.
 *
 * High-level flow:
 *   1. `generatePodcastScript`   — calls the local LLM (Gemma via LM Studio)
 *      to turn a topic + grounded source excerpts into a Coach/Student
 *      dialog script.
 *   2. `loadKokoroOnDemand`      — lazy-loads kokoro-js on first use; the
 *      ~80MB ONNX model is cached in IndexedDB by transformers.js so the
 *      second use is offline.
 *   3. `synthesizePodcastScript` — iterates the script and calls kokoro
 *      with a different voice per role; returns a list of Blobs ready to
 *      drive an <audio> tag (or be stitched into one WAV).
 *
 * Storage:
 *   - Script cached at `podcast:script:<level>:<topic>` so repeated
 *     opens don't pay the LLM cost.  Audio is NOT cached on disk —
 *     blobs are object-URLs only for the current session.
 *
 * Voice mapping:
 *   - 'coach'   → af_heart   (American Female, warm explainer)
 *   - 'student' → am_michael (American Male, curious learner)
 *   Both are baked-in kokoro voices and don't need extra downloads.
 */

import { getStorage } from './storage';
import { generateText as llmGenerateText } from './localLlm';

export const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

/** Voice mapping per speaker role. */
export const PODCAST_VOICES = {
  coach: 'af_heart',
  student: 'am_michael',
} as const;

export type PodcastRole = keyof typeof PODCAST_VOICES;

export interface PodcastLine {
  role: PodcastRole;
  text: string;
}

export interface PodcastScript {
  level: string;
  topic: string;
  title: string;
  lines: PodcastLine[];
  generatedAt: string;
  sourceExcerpts?: string[];
}

export interface PodcastSegment {
  role: PodcastRole;
  text: string;
  audio: Blob;
  durationSeconds: number;
}

interface MinimalLlmClient {
  generateText(input: { prompt: string; system?: string; maxTokens?: number }): Promise<{ text: string }>;
}

function scriptCacheKey(level: string, topic: string): string {
  return `podcast:script:${level}:${topic}`;
}

const SCRIPT_SYSTEM_PROMPT = `You are scripting a two-person study podcast for a CFA exam-prep app.

Two roles:
- Coach: a calm subject-matter expert who explains concepts cleanly.
- Student: a curious learner who asks the questions a real candidate would ask.

The script must be:
- A back-and-forth dialog, alternating Coach and Student lines.
- 8 to 14 lines total.
- Anchored in the provided source excerpts when relevant — do not invent facts not supported by them.
- Free of formulas in TeX or LaTeX (read aloud the meaning, not the symbols).
- Free of stage directions, brackets, or speaker names mid-line (the role label is metadata).
- Plain text only — no markdown, no HTML.

Output strictly as JSON of the shape:
  { "lines": [ { "role": "coach" | "student", "text": "..." } ] }

Begin with a Coach line setting the topic. End with a Coach line summarising the key takeaway.`;

function parseScriptResponse(raw: string): PodcastLine[] {
  // Extract the JSON object — accept fenced code blocks, raw JSON, or noisy preamble.
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Model output did not contain a JSON object.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    throw new Error(`Could not parse model JSON: ${(err as Error).message}`);
  }
  const lines = (parsed as { lines?: unknown }).lines;
  if (!Array.isArray(lines)) throw new Error('Model JSON missing `lines` array.');
  const out: PodcastLine[] = [];
  for (const item of lines) {
    const obj = item as { role?: unknown; text?: unknown };
    const roleStr = typeof obj.role === 'string' ? obj.role.trim().toLowerCase() : '';
    const text = typeof obj.text === 'string' ? obj.text.trim() : '';
    if (!text) continue;
    if (roleStr === 'coach' || roleStr === 'student') {
      out.push({ role: roleStr, text });
    }
  }
  if (out.length < 4) throw new Error(`Model produced only ${out.length} usable lines (need >=4).`);
  return out;
}

/**
 * Ask the local LLM to produce a Coach/Student script.  Caches the result
 * keyed by (level, topic).  Pass `forceRefresh` to ignore the cache.
 */
export async function generatePodcastScript({
  level,
  topic,
  title,
  sourceExcerpts,
  forceRefresh = false,
  client,
}: {
  level: string;
  topic: string;
  title: string;
  sourceExcerpts?: string[];
  forceRefresh?: boolean;
  client?: MinimalLlmClient;
}): Promise<PodcastScript> {
  const storage = getStorage();
  if (!forceRefresh) {
    const cached = await storage.settings.get(scriptCacheKey(level, topic));
    if (cached?.value) return cached.value as PodcastScript;
  }

  const llm: MinimalLlmClient = client ?? { generateText: llmGenerateText };
  const userPrompt = [
    `Topic: ${title}`,
    `Level: ${level}`,
    sourceExcerpts && sourceExcerpts.length
      ? `Source excerpts (use these when grounding the dialog):\n${sourceExcerpts
          .map((s, i) => `[${i + 1}] ${s}`)
          .join('\n\n')}`
      : 'No source excerpts provided — keep the dialog general but exam-relevant.',
    'Produce the JSON script now.',
  ].join('\n\n');

  const { text } = await llm.generateText({
    prompt: userPrompt,
    system: SCRIPT_SYSTEM_PROMPT,
    maxTokens: 1500,
  });
  const lines = parseScriptResponse(text);
  const script: PodcastScript = {
    level,
    topic,
    title,
    lines,
    generatedAt: new Date().toISOString(),
    sourceExcerpts,
  };
  await storage.settings.put({
    key: scriptCacheKey(level, topic),
    value: script,
    updatedAt: script.generatedAt,
  });
  return script;
}

// Kokoro TTS — lazy singleton.  The 80MB model only downloads on first use.
type KokoroProgressCallback = (info: { status: string; progress?: number }) => void;
interface KokoroLike {
  generate(
    text: string,
    options?: { voice?: string; speed?: number },
  ): Promise<{ toBlob(): Blob; audio: Float32Array; sampling_rate: number }>;
}

let kokoroPromise: Promise<KokoroLike> | null = null;

export async function loadKokoroOnDemand(
  onProgress?: KokoroProgressCallback,
): Promise<KokoroLike> {
  if (!kokoroPromise) {
    kokoroPromise = (async () => {
      const { KokoroTTS } = await import('kokoro-js');
      const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        dtype: 'q8',
        progress_callback: onProgress,
      });
      return tts as unknown as KokoroLike;
    })().catch((err) => {
      kokoroPromise = null;
      throw err;
    });
  }
  return kokoroPromise;
}

export function resetKokoroLoader(): void {
  kokoroPromise = null;
}

/**
 * Synthesize each line of a script with kokoro.
 *
 * `onLine` is called after each line completes — useful for streaming the
 * audio out without waiting for the whole script.
 */
export async function synthesizePodcastScript(
  script: PodcastScript,
  options: {
    onLine?: (segment: PodcastSegment, index: number) => void;
    onProgress?: KokoroProgressCallback;
  } = {},
): Promise<PodcastSegment[]> {
  const tts = await loadKokoroOnDemand(options.onProgress);
  const segments: PodcastSegment[] = [];
  for (let i = 0; i < script.lines.length; i++) {
    const line = script.lines[i];
    const result = await tts.generate(line.text, { voice: PODCAST_VOICES[line.role], speed: 1 });
    const blob = result.toBlob();
    const durationSeconds =
      result.audio && result.sampling_rate
        ? result.audio.length / result.sampling_rate
        : 0;
    const segment: PodcastSegment = { role: line.role, text: line.text, audio: blob, durationSeconds };
    segments.push(segment);
    options.onLine?.(segment, i);
  }
  return segments;
}

