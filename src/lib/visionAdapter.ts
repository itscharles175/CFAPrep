/**
 * Multimodal (vision) adapter for the local OpenAI-compatible chat endpoint.
 *
 * Mirrors the text-only `generateText` helper in `localLlm.js` but builds a
 * multi-part user message that includes one or more images alongside the
 * prompt text. Targets the same endpoints LM Studio (port 1234) and Ollama
 * (port 11434) expose; both accept `{ type: 'image_url', image_url: { url: 'data:<mime>;base64,<…>' } }`
 * segments when the loaded model is multimodal (e.g. Gemma 3/4 family).
 *
 * Kept deliberately small and decoupled from the saved settings store so it
 * can be reused from contexts that already know which model to call.
 */

import { DEFAULT_LLM_SETTINGS, getLlmSettings } from './localLlm';
import { normalizeLoopbackHttpBaseUrl } from './localUrlPolicy';
import { stripThink } from './stripThink';

export interface VisionImageInput {
  /** PNG/JPEG/WebP bytes encoded as base64 (no data URL prefix; we add it). */
  base64: string;
  /** Optional mime type. Defaults to 'image/png'. */
  mime?: 'image/png' | 'image/jpeg' | 'image/webp';
}

export interface VisionGenerateOptions {
  prompt: string;
  images: VisionImageInput[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  settings?: { baseUrl?: string; model?: string };
  signal?: AbortSignal;
}

export interface VisionGenerateResult {
  text: string;
  usedImages: number;
}

/**
 * Trim a trailing slash from a base URL so we can safely append `/chat/completions`.
 * Kept local to avoid coupling against the `.js` module beyond what's needed.
 */
function normalizeBaseUrl(baseUrl: string | undefined): string {
  return normalizeLoopbackHttpBaseUrl(
    baseUrl || DEFAULT_LLM_SETTINGS.baseUrl,
    'Local vision model base URL',
  );
}

/** Build the data URL for an image input, defaulting mime to PNG. */
function toDataUrl(image: VisionImageInput): string {
  const mime = image.mime || 'image/png';
  return `data:${mime};base64,${image.base64}`;
}

/**
 * Send a multi-part chat completion (text + images) to the local model and
 * return the raw model text plus a confirmation of the image count we sent.
 *
 * Errors are wrapped in the same actionable CORS message `generateText` uses
 * so the UI can surface a single consistent fix.
 */
export async function generateTextWithImages(
  opts: VisionGenerateOptions,
): Promise<VisionGenerateResult> {
  const settings = opts.settings ?? (await getLlmSettings());
  const base = normalizeBaseUrl(settings?.baseUrl);
  const model = (settings?.model || DEFAULT_LLM_SETTINGS.model).trim();

  const images = Array.isArray(opts.images) ? opts.images : [];
  const userContent: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  > = [];
  userContent.push({ type: 'text', text: String(opts.prompt ?? '') });
  for (const image of images) {
    userContent.push({ type: 'image_url', image_url: { url: toDataUrl(image) } });
  }

  const messages: Array<
    { role: 'system'; content: string } | { role: 'user'; content: typeof userContent }
  > = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: userContent });

  const body: Record<string, unknown> = {
    model,
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.3,
    messages,
  };
  if (typeof opts.maxTokens === 'number' && Number.isFinite(opts.maxTokens)) {
    body.max_tokens = opts.maxTokens;
  }

  let response: Response;
  try {
    response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
    throw new Error(
      `Could not reach ${base} from the browser. If you are using LM Studio, open its Developer / Server panel and enable CORS for "*" (then restart the server). For Ollama, start it with OLLAMA_ORIGINS=* set. The desktop (Tauri) shell does not need this — it calls the model natively.`,
      { cause: error as Error | undefined },
    );
  }
  if (!response.ok) throw new Error(`Local model server responded ${response.status}.`);
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data?.choices?.[0]?.message?.content || '';
  return { text: stripThink(String(content)), usedImages: images.length };
}
