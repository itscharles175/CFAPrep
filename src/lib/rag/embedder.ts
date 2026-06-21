/**
 * RAG-2 — host HYBRID retrieval: a local embedder + background backfill.
 *
 * The storage driver's `chunks.search` ALREADY blends vector + BM25 when a query
 * embedding is supplied AND the candidate rows carry embeddings (see
 * dexieDriver.ts). The blend was dormant because nothing on the host ever
 * PRODUCED embeddings. This module fills that gap, fully offline-first:
 *
 *   - `embedText(text)` / `embedTexts(texts)` POST to the local model server's
 *     OpenAI-compatible `/v1/embeddings` endpoint (LM Studio / Ollama). When the
 *     server is unreachable (offline), returns `null` / `[]` — NEVER throws — so
 *     the caller transparently falls back to BM25-only retrieval.
 *
 *   - `backfillChunkEmbeddings()` walks the `chunks` namespace, finds rows
 *     WITHOUT an embedding, embeds them in batches, and writes them back via the
 *     existing `chunks.upsert` (no StorageDriver change). It's idempotent +
 *     resumable: each pass embeds only the not-yet-embedded remainder, and it
 *     bails cleanly the moment the server stops responding.
 *
 * The base URL is resolved through the SAME `getLlmSettings()` + `normalizeBaseUrl`
 * the rest of the host LLM path uses, so the offline/no-cloud egress guard (only
 * loopback / private-LAN hosts) is inherited — embeddings of curriculum text can
 * never be POSTed to a public endpoint.
 *
 * Vector-blend ON/OFF is a measured decision (see ragEval embedding harness):
 * the host wires the query embedding into retrieval only when it improves nDCG on
 * the golden set; otherwise this stays available but the blend is left flag-OFF.
 */

import { getLlmSettings, DEFAULT_LLM_SETTINGS } from '../localLlm';
import { getStorage } from '../storage';
import type { SourceChunkInput } from '../storage/types';

/** Reuse the host's loopback/private-LAN egress guard semantics. */
function isLocalLlmHost(hostname: string): boolean {
  const h = (hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

function normalizeBaseUrl(baseUrl?: string): string {
  const raw = (baseUrl || DEFAULT_LLM_SETTINGS.baseUrl).trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(raw);
    if (!isLocalLlmHost(parsed.hostname)) return DEFAULT_LLM_SETTINGS.baseUrl;
  } catch {
    return DEFAULT_LLM_SETTINGS.baseUrl;
  }
  return raw;
}

export interface EmbedderSettings {
  baseUrl?: string;
  /** Embedding model id. Falls back to the chat model when unset. */
  embeddingModel?: string;
  model?: string;
}

export interface EmbedOptions {
  settings?: EmbedderSettings;
  signal?: AbortSignal;
  /** Per-request timeout (ms). Default 20s. */
  timeoutMs?: number;
  /**
   * Test seam — override the raw fetch. Receives the endpoint + JSON body and
   * must resolve to the parsed `/v1/embeddings` response (or throw to simulate
   * an offline server). Defaults to the real `fetch`.
   */
  fetchImpl?: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
}

interface EmbeddingsResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
}

async function resolveBaseUrl(settings?: EmbedderSettings): Promise<string> {
  if (settings?.baseUrl) return normalizeBaseUrl(settings.baseUrl);
  try {
    const saved = await getLlmSettings();
    return normalizeBaseUrl(saved?.baseUrl);
  } catch {
    return DEFAULT_LLM_SETTINGS.baseUrl;
  }
}

async function resolveModel(settings?: EmbedderSettings): Promise<string> {
  if (settings?.embeddingModel) return settings.embeddingModel;
  if (settings?.model) return settings.model;
  try {
    const saved = await getLlmSettings();
    return saved?.model || DEFAULT_LLM_SETTINGS.model;
  } catch {
    return DEFAULT_LLM_SETTINGS.model;
  }
}

/**
 * Embed one or more texts via the local `/v1/embeddings` endpoint. Returns one
 * vector per input in order. OFFLINE-GRACEFUL: returns `null` (never throws) when
 * the server is unreachable / errors / returns an unusable shape, so callers fall
 * back to BM25-only retrieval.
 */
export async function embedTexts(texts: string[], options: EmbedOptions = {}): Promise<number[][] | null> {
  const inputs = (texts || []).map((t) => String(t ?? ''));
  if (inputs.length === 0) return [];

  const base = await resolveBaseUrl(options.settings);
  const model = await resolveModel(options.settings);
  const endpoint = `${base}/embeddings`;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as EmbedOptions['fetchImpl']);
  if (!fetchImpl) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  const onAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: inputs }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as EmbeddingsResponse;
    const rows = Array.isArray(data?.data) ? data.data : [];
    if (rows.length === 0) return null;
    // Honour the `index` field when present so order is guaranteed. Fill with a
    // dense `null` sentinel (NOT a sparse array — `.some()` skips holes, which
    // would let a partial response slip through the completeness check below).
    const out: Array<number[] | null> = new Array(inputs.length).fill(null);
    rows.forEach((row, i) => {
      const idx = typeof row.index === 'number' ? row.index : i;
      if (Array.isArray(row.embedding) && row.embedding.length > 0 && idx >= 0 && idx < inputs.length) {
        out[idx] = row.embedding;
      }
    });
    // Reject if any slot is missing (partial/garbled response) → BM25 fallback.
    if (out.some((v) => !Array.isArray(v) || v.length === 0)) return null;
    return out as number[][];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener('abort', onAbort);
  }
}

/** Embed a single query/text. `null` when offline (BM25-only fallback). */
export async function embedText(text: string, options: EmbedOptions = {}): Promise<number[] | null> {
  const vectors = await embedTexts([text], options);
  return vectors && vectors[0] ? vectors[0] : null;
}

export interface BackfillOptions extends EmbedOptions {
  /** How many chunks to embed per server round-trip. Default 16. */
  batchSize?: number;
  /** Cap total chunks embedded this pass (resumable across passes). Default 256. */
  maxChunks?: number;
  /** Only backfill chunks for this domain (optional narrowing). */
  domain?: string;
  /**
   * Test seam — supply the candidate rows directly instead of scanning the
   * driver via the generic `table()` primitive. Each must be a stored chunk row.
   */
  loadChunks?: () => Promise<SourceChunkInput[]>;
}

export interface BackfillReport {
  /** Chunks found without an embedding (subject to maxChunks cap). */
  pending: number;
  /** Chunks successfully embedded + written back this pass. */
  embedded: number;
  /** True when the embedder was unreachable (offline) — nothing was changed. */
  offline: boolean;
}

/**
 * Background backfill: embed not-yet-embedded chunks and write them back via the
 * existing `chunks.upsert` (DATA-1: we READ rows through the generic `table()`
 * primitive — `getStorage().table('sourceChunks')` — and never touch the
 * StorageDriver interface).
 *
 * Idempotent + resumable: each call embeds only rows lacking `embedding`, capped
 * at `maxChunks`; rerun to continue. OFFLINE-GRACEFUL: the first failed embed
 * batch ends the pass with `offline:true` and zero writes — NEVER throws.
 */
export async function backfillChunkEmbeddings(options: BackfillOptions = {}): Promise<BackfillReport> {
  const batchSize = Math.max(1, options.batchSize ?? 16);
  const maxChunks = Math.max(1, options.maxChunks ?? 256);
  const storage = getStorage();

  // Load candidate rows: either the test seam, or a scan via the generic table().
  let rows: SourceChunkInput[];
  try {
    if (options.loadChunks) {
      rows = await options.loadChunks();
    } else if (typeof storage.table === 'function') {
      rows = await storage.table<SourceChunkInput>('sourceChunks').toArray();
    } else {
      return { pending: 0, embedded: 0, offline: false };
    }
  } catch {
    return { pending: 0, embedded: 0, offline: false };
  }

  const pendingRows = rows.filter((r) => {
    if (options.domain && r.domain !== options.domain) return false;
    return !(Array.isArray(r.embedding) && r.embedding.length > 0) && typeof r.text === 'string' && r.text.trim().length > 0;
  });
  const slice = pendingRows.slice(0, maxChunks);
  if (slice.length === 0) return { pending: 0, embedded: 0, offline: false };

  if (!storage.chunks) return { pending: slice.length, embedded: 0, offline: false };

  let embedded = 0;
  for (let i = 0; i < slice.length; i += batchSize) {
    const batch = slice.slice(i, i + batchSize);
    const vectors = await embedTexts(
      batch.map((r) => r.text),
      { settings: options.settings, signal: options.signal, timeoutMs: options.timeoutMs, fetchImpl: options.fetchImpl },
    );
    if (!vectors) {
      // Server went away (offline). Stop; what we wrote so far persists.
      return { pending: slice.length, embedded, offline: embedded === 0 };
    }
    for (let j = 0; j < batch.length; j += 1) {
      const vec = vectors[j];
      if (!Array.isArray(vec) || vec.length === 0) continue;
      try {
        await storage.chunks.upsert({ ...batch[j], embedding: vec });
        embedded += 1;
      } catch {
        // A single failed write shouldn't abort the whole pass.
      }
    }
  }

  return { pending: slice.length, embedded, offline: false };
}
