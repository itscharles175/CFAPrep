import { getStorage } from './storage';
import { normalizeLoopbackHttpBaseUrl } from './localUrlPolicy';
import { secureVault, type SecureCipher, type SecureVault } from './secureVault';

// Embedded open-notebook integration. open-notebook runs as a local Tauri
// sidecar (FastAPI on :5055, backed by SurrealDB and a surreal-commands job
// worker). It gives QuantVault a real RAG pipeline — notebooks, embedded
// sources, and grounded "ask" answers — over the user's own CFA curriculum.
// Fully offline: the backend, the vector store, and the model (LM Studio /
// Ollama, via open-notebook's openai_compatible provider) all run locally.
//
// The request shapes below mirror the endpoints proven end-to-end in the
// Wave-0 spike (see docs/SPIKE-FINDINGS.md):
//   GET    /api/models                 -> [{ id, type: 'language' | 'embedding' }]
//   GET    /api/notebooks              -> Notebook[]
//   POST   /api/notebooks {name,...}   -> Notebook
//   GET    /api/sources?notebook_id    -> Source[]
//   POST   /api/sources/json {...}     -> Source        (embed=true queues a job)
//   DELETE /api/sources/{id}
//   POST   /api/search/ask/simple {...}-> { answer, ... }

const SETTINGS_KEY = 'open-notebook';
const SECURE_CACHE_SCHEME = 'secure-vault-open-notebook-cache.v1';

let openNotebookSecureVault: SecureVault = secureVault;

export function setOpenNotebookSecureVaultForTesting(vault: SecureVault | null) {
  openNotebookSecureVault = vault ?? secureVault;
}

export interface OpenNotebookSettings {
  /** When false, the UI hides RAG features and never calls the backend. */
  enabled: boolean;
  /** Base URL of the embedded FastAPI sidecar. */
  baseUrl: string;
}

export const DEFAULT_OPEN_NOTEBOOK_SETTINGS: OpenNotebookSettings = {
  enabled: false,
  baseUrl: 'http://localhost:5055',
};

export interface OnbModel {
  id: string;
  type: 'language' | 'embedding' | string;
  name?: string;
  provider?: string;
}

export interface OnbNotebook {
  id: string;
  name: string;
  description?: string;
  archived?: boolean;
  source_count?: number;
  note_count?: number;
}

export interface OnbSource {
  id: string;
  title?: string;
  notebook_id?: string;
}

export interface OnbAskAnswer {
  answer: string;
  /** open-notebook returns supporting context/citations under varying keys. */
  context?: unknown;
}

export interface OnbConnection {
  ok: boolean;
  error?: string;
  models?: OnbModel[];
  /** First language model id, convenient default for ask flows. */
  languageModel?: string;
  /** First embedding model id. */
  embeddingModel?: string;
}

function normalizeBaseUrl(baseUrl?: string): string {
  return normalizeLoopbackHttpBaseUrl(
    baseUrl || DEFAULT_OPEN_NOTEBOOK_SETTINGS.baseUrl,
    'open-notebook base URL',
  );
}

export async function getOpenNotebookSettings(): Promise<OpenNotebookSettings> {
  try {
    const row = await getStorage().settings.get(SETTINGS_KEY);
    const loaded = { ...DEFAULT_OPEN_NOTEBOOK_SETTINGS, ...((row?.value as Partial<OpenNotebookSettings>) || {}) };
    return { ...loaded, baseUrl: normalizeBaseUrl(loaded.baseUrl) };
  } catch {
    return { ...DEFAULT_OPEN_NOTEBOOK_SETTINGS };
  }
}

export async function saveOpenNotebookSettings(
  settings: Partial<OpenNotebookSettings>,
): Promise<OpenNotebookSettings> {
  const merged = {
    ...DEFAULT_OPEN_NOTEBOOK_SETTINGS,
    ...settings,
    baseUrl: normalizeBaseUrl(settings.baseUrl || DEFAULT_OPEN_NOTEBOOK_SETTINGS.baseUrl),
  };
  await getStorage().settings.put({ key: SETTINGS_KEY, value: merged, updatedAt: new Date().toISOString() });
  return merged;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function request<T>(baseUrl: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const base = normalizeBaseUrl(baseUrl);
  const { method = 'GET', body, signal, timeoutMs = 300_000 } = opts;

  // Compose the caller's signal with an internal timeout so a stalled job
  // (embedding/synthesis can be slow on the first run) never hangs forever.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body != null ? { 'Content-Type': 'application/json' } : undefined,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`open-notebook ${method} ${path} -> ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : null) as T;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

export async function checkOpenNotebookConnection(
  settings?: Pick<OpenNotebookSettings, 'baseUrl'>,
): Promise<OnbConnection> {
  try {
    const base = normalizeBaseUrl(settings?.baseUrl);
    const models = await request<OnbModel[]>(base, '/api/models', { timeoutMs: 8_000 });
    const list = Array.isArray(models) ? models : [];
    const languageModel = list.find((m) => m.type === 'language')?.id;
    const embeddingModel = list.find((m) => m.type === 'embedding')?.id;
    return { ok: true, models: list, languageModel, embeddingModel };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not reach the open-notebook backend.' };
  }
}

export async function listModels(settings?: Pick<OpenNotebookSettings, 'baseUrl'>): Promise<OnbModel[]> {
  const list = await request<OnbModel[]>(normalizeBaseUrl(settings?.baseUrl), '/api/models', { timeoutMs: 8_000 });
  return Array.isArray(list) ? list : [];
}

export async function listNotebooks(settings?: Pick<OpenNotebookSettings, 'baseUrl'>): Promise<OnbNotebook[]> {
  const list = await request<OnbNotebook[]>(normalizeBaseUrl(settings?.baseUrl), '/api/notebooks', { timeoutMs: 10_000 });
  return Array.isArray(list) ? list : [];
}

export async function deleteNotebook(baseUrl: string, notebookId: string): Promise<void> {
  await request(normalizeBaseUrl(baseUrl), `/api/notebooks/${encodeURIComponent(notebookId)}`, {
    method: 'DELETE',
    timeoutMs: 15_000,
  });
}

export async function listSources(settings?: Pick<OpenNotebookSettings, 'baseUrl'>): Promise<OnbSource[]> {
  const list = await request<OnbSource[]>(normalizeBaseUrl(settings?.baseUrl), '/api/sources', { timeoutMs: 15_000 });
  return Array.isArray(list) ? list : [];
}

/** Fetch all sources once and return an id -> title map for citation rendering. */
export async function fetchSourceTitleMap(baseUrl: string): Promise<Map<string, string>> {
  const sources = await listSources({ baseUrl });
  const map = new Map<string, string>();
  for (const source of sources) {
    if (source?.id && source.title) map.set(source.id, source.title);
  }
  return map;
}

// ---------------------------------------------------------------------------
// INT-3 — shared retrieval surface.
//
// The host curriculum RAG (`localRag.ts`) retrieves over the storage driver's
// `ChunkSearch` interface. INT-3 unions that with the open-notebook sources the
// user has embedded, so a grounded answer can cite BOTH the candidate's CFA
// curriculum AND their notebook sources (incl. LSAT material surfaced through
// the same backend) behind one call site.
//
// open-notebook is OPTIONAL (OPS-5): when the sidecar is disabled/unreachable
// the helpers below resolve to an empty list rather than throwing, so the union
// degrades cleanly to host-only retrieval.
// ---------------------------------------------------------------------------

/** A notebook source surfaced as a curriculum-chunk-shaped retrieval hit. */
export interface NotebookSourceHit {
  /** open-notebook source id (e.g. "source:abc"). */
  id: string;
  title: string;
  /** Best-effort excerpt of the matched source text (may be empty). */
  text: string;
  /** Human locator for citation chips — the source title by default. */
  locator: string;
  /** 0..1 lexical-overlap score against the query — higher is better. */
  score: number;
}

interface SearchNotebookSourcesParams {
  baseUrl: string;
  query: string;
  /** Max hits to return. Default 6. */
  limit?: number;
  signal?: AbortSignal;
}

/** Tokenise a query into lowercase word stems for lexical overlap scoring. */
function queryTokens(query: string): string[] {
  return (query.toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter(
    (token, i, all) => all.indexOf(token) === i,
  );
}

/**
 * Score how well a source's searchable text matches the query, in [0,1]. Counts
 * distinct query tokens that appear in the text over the total token count, so a
 * source touching every query term scores 1 and an unrelated source scores 0.
 * Lexical-only on purpose: it is a cheap pre-filter to surface candidate
 * notebook sources into the union without a second embedding round-trip.
 */
function lexicalOverlap(tokens: string[], haystack: string): number {
  if (tokens.length === 0) return 0;
  const lower = haystack.toLowerCase();
  let hits = 0;
  for (const token of tokens) {
    if (lower.includes(token)) hits += 1;
  }
  return hits / tokens.length;
}

/**
 * Search the user's embedded open-notebook sources for ones relevant to
 * `query`, returned as curriculum-chunk-shaped {@link NotebookSourceHit}s so the
 * host RAG (`localRag.ts`) can union them with its own chunks.
 *
 * DEGRADE-GRACEFULLY (OPS-5): returns `[]` — never throws — when open-notebook
 * is disabled, unreachable, or returns nothing, so the caller falls back to
 * host-only retrieval transparently.
 *
 * The match is a lightweight lexical-overlap pre-filter over the source titles
 * (the cheap, network-free signal open-notebook exposes via `/api/sources`).
 * It deliberately does NOT run open-notebook's heavy `ask/simple` synthesis —
 * that stays the explicit, user-initiated path in `askGrounded`.
 */
export async function searchNotebookSources(
  params: SearchNotebookSourcesParams,
): Promise<NotebookSourceHit[]> {
  const query = (params.query || '').trim();
  if (!query) return [];
  const tokens = queryTokens(query);
  let sources: OnbSource[];
  try {
    sources = await listSources({ baseUrl: params.baseUrl });
  } catch {
    // Sidecar absent/unreachable (OPS-5) — degrade to host-only retrieval.
    return [];
  }
  if (params.signal?.aborted) return [];

  const limit = Math.max(1, params.limit ?? 6);
  const scored: NotebookSourceHit[] = [];
  for (const source of sources) {
    if (!source?.id) continue;
    const title = source.title || source.id;
    const score = lexicalOverlap(tokens, title);
    if (score <= 0) continue;
    scored.push({ id: source.id, title, text: title, locator: title, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Whether the host should attempt to union open-notebook sources into retrieval.
 * True only when the embedded notebook is enabled AND reachable, so callers can
 * skip the source lookup entirely on the common (notebook-disabled) path.
 * Never throws — any failure means "treat as unavailable".
 */
export async function notebookSourcesAvailable(
  settings?: Pick<OpenNotebookSettings, 'enabled' | 'baseUrl'>,
): Promise<boolean> {
  const resolved = settings ?? (await getOpenNotebookSettings().catch(() => null));
  if (!resolved || !resolved.enabled) return false;
  const conn = await checkOpenNotebookConnection({ baseUrl: resolved.baseUrl }).catch(() => null);
  return Boolean(conn?.ok);
}

export async function createNotebook(
  baseUrl: string,
  name: string,
  description = '',
): Promise<OnbNotebook> {
  return request<OnbNotebook>(baseUrl, '/api/notebooks', {
    method: 'POST',
    body: { name, description },
    timeoutMs: 15_000,
  });
}

/**
 * Add a text source to a notebook. With `embed: true`, open-notebook queues an
 * embedding job on the surreal-commands worker; the chunks become searchable
 * once that job completes (typically a few seconds for a module's worth of text).
 */
export async function addTextSource(
  baseUrl: string,
  params: { notebookId: string; title: string; content: string; embed?: boolean; signal?: AbortSignal },
): Promise<OnbSource> {
  return request<OnbSource>(baseUrl, '/api/sources/json', {
    method: 'POST',
    body: {
      notebook_id: params.notebookId,
      type: 'text',
      title: params.title,
      content: params.content,
      embed: params.embed ?? true,
    },
    signal: params.signal,
    timeoutMs: 120_000,
  });
}

export interface AskParams {
  baseUrl: string;
  question: string;
  /** Model id used for all three open-notebook stages. Defaults to first language model. */
  model?: string;
  signal?: AbortSignal;
}

/**
 * Run open-notebook's "ask" RAG flow (strategy -> per-source answer ->
 * final synthesis) and return the synthesized, source-grounded answer.
 */
export async function askGrounded(params: AskParams): Promise<OnbAskAnswer> {
  const base = normalizeBaseUrl(params.baseUrl);
  let model = params.model;
  if (!model) {
    const conn = await checkOpenNotebookConnection({ baseUrl: base });
    if (!conn.ok) throw new Error(conn.error || 'open-notebook backend is unavailable.');
    if (!conn.languageModel) throw new Error('No language model is registered in open-notebook.');
    model = conn.languageModel;
  }
  const result = await request<OnbAskAnswer>(base, '/api/search/ask/simple', {
    method: 'POST',
    body: {
      question: params.question,
      strategy_model: model,
      answer_model: model,
      final_answer_model: model,
    },
    signal: params.signal,
    timeoutMs: 300_000,
  });
  return result || { answer: '' };
}

const NOTEBOOK_MAP_KEY = 'open-notebook:topic-notebooks';

export interface TopicNotebookEntry {
  notebookId: string;
  sourceId?: string;
}

// Old shape was Record<string, string> (just the notebook id). New shape pairs
// it with the seeded source id so chatWithSource can scope grounding properly.
// Migration: any string value is interpreted as a notebookId with no sourceId
// (we'll re-seed on next ensureTopicNotebook call).
type TopicNotebookMap = Record<string, TopicNotebookEntry | string>;

async function loadTopicNotebookMap(): Promise<Record<string, TopicNotebookEntry>> {
  try {
    const row = await getStorage().settings.get(NOTEBOOK_MAP_KEY);
    const raw = row ? await decodeOpenNotebookCacheValue<TopicNotebookMap>(NOTEBOOK_MAP_KEY, row.value, {}) : {};
    const normalized: Record<string, TopicNotebookEntry> = {};
    for (const [key, value] of Object.entries(raw)) {
      normalized[key] = typeof value === 'string' ? { notebookId: value } : value;
    }
    return normalized;
  } catch (err) {
    if (err instanceof Error && /Secure Vault/i.test(err.message)) throw err;
    return {};
  }
}

async function saveTopicNotebookMap(map: Record<string, TopicNotebookEntry>): Promise<void> {
  await getStorage().settings.put({
    key: NOTEBOOK_MAP_KEY,
    value: await encodeOpenNotebookCacheValue(NOTEBOOK_MAP_KEY, map),
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Ensure a per-topic notebook + source exist (reusing them across sessions via
 * a local id map), seeding the source with the supplied curriculum text the
 * first time. Idempotent: a topic maps to a single stable notebook+source.
 * Returns both ids — pass the sourceId to chatWithSource for properly scoped
 * grounded answers.
 */
export async function ensureTopicNotebook(params: {
  baseUrl: string;
  topicKey: string;
  topicTitle: string;
  seedChunks?: { locator?: string; text: string }[];
  signal?: AbortSignal;
}): Promise<TopicNotebookEntry> {
  const base = normalizeBaseUrl(params.baseUrl);
  const map = await loadTopicNotebookMap();
  const existing = map[params.topicKey];

  const existingNotebooks = await listNotebooks({ baseUrl: base });
  const existingNotebook =
    existing?.notebookId && existingNotebooks.some((n) => n.id === existing.notebookId);

  if (existing?.notebookId && existingNotebook) {
    if (existing.sourceId) return existing;
    // Migrated from the legacy string-only map: notebook exists but we don't
    // yet know its source id. Adopt the notebook's first existing source
    // rather than seeding a duplicate.
    const existingSources = await request<OnbSource[]>(
      base,
      `/api/sources?notebook_id=${encodeURIComponent(existing.notebookId)}`,
      { timeoutMs: 10_000 },
    );
    const adopted = Array.isArray(existingSources) ? existingSources[0] : null;
    if (adopted?.id) {
      const entry: TopicNotebookEntry = { notebookId: existing.notebookId, sourceId: adopted.id };
      map[params.topicKey] = entry;
      await saveTopicNotebookMap(map);
      return entry;
    }
    // No existing sources to adopt — fall through to seed a fresh one.
  }

  const notebook = existingNotebook
    ? { id: existing!.notebookId, name: params.topicTitle }
    : await createNotebook(base, `CFA: ${params.topicTitle}`, `QuantVault topic ${params.topicKey}`);

  let sourceId: string | undefined;
  if (params.seedChunks && params.seedChunks.length > 0) {
    // Seed the WHOLE topic. open-notebook re-chunks + embeds internally and
    // retrieves the most relevant section per question, so a too-small seed
    // gives the model only the topic's front-matter and forces "not enough
    // info" replies on questions about deeper sections.
    const content = params.seedChunks
      .map((c) => (c.locator ? `[${c.locator}] ${c.text}` : c.text))
      .join('\n\n')
      .slice(0, 400_000);
    if (content.trim()) {
      const source = await addTextSource(base, {
        notebookId: notebook.id,
        title: params.topicTitle,
        content,
        embed: true,
        signal: params.signal,
      });
      sourceId = source.id;
    }
  }

  const entry: TopicNotebookEntry = { notebookId: notebook.id, sourceId };
  map[params.topicKey] = entry;
  await saveTopicNotebookMap(map);
  return entry;
}

export interface SourceChatAnswer {
  answer: string;
  citationSources: string[];
}

interface CreateSourceChatSessionResponse {
  id: string;
}

/**
 * Send a question against a single source and return the grounded answer.
 *
 * Uses open-notebook's per-source chat: it creates an ephemeral chat session
 * for the source, posts the message, and parses the streaming response (a
 * sequence of `data: {json}` lines carrying typed events). Grounding is
 * naturally scoped to this source's embeddings — unlike `/api/search/ask/simple`
 * which searches every source globally.
 */
export async function chatWithSource(params: {
  baseUrl: string;
  sourceId: string;
  message: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<SourceChatAnswer> {
  const base = normalizeBaseUrl(params.baseUrl);
  const session = await request<CreateSourceChatSessionResponse>(
    base,
    `/api/sources/${encodeURIComponent(params.sourceId)}/chat/sessions`,
    {
      method: 'POST',
      body: { source_id: params.sourceId, title: 'QuantVault ask', ...(params.model ? { model_override: params.model } : {}) },
      timeoutMs: 15_000,
      signal: params.signal,
    },
  );

  // The messages endpoint streams Server-Sent-Events-like `data: {json}` lines.
  // Read as text (waits for `complete`) and pull out the assistant turn.
  const url = `${base}/api/sources/${encodeURIComponent(params.sourceId)}/chat/sessions/${encodeURIComponent(session.id)}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: params.message, ...(params.model ? { model_override: params.model } : {}) }),
    signal: params.signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`open-notebook chat POST -> ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }
  const text = await response.text();
  return parseSourceChatStream(text);
}

export interface OnbTransformation {
  id: string;
  name: string;
  description?: string;
}

export async function listTransformations(
  settings?: Pick<OpenNotebookSettings, 'baseUrl'>,
): Promise<OnbTransformation[]> {
  const list = await request<OnbTransformation[]>(
    normalizeBaseUrl(settings?.baseUrl),
    '/api/transformations',
    { timeoutMs: 10_000 },
  );
  return Array.isArray(list) ? list : [];
}

export interface OnbSourceInsight {
  id: string;
  insight_type?: string;
  content?: string;
  created?: string;
}

export async function listSourceInsights(
  baseUrl: string,
  sourceId: string,
): Promise<OnbSourceInsight[]> {
  const list = await request<OnbSourceInsight[]>(
    normalizeBaseUrl(baseUrl),
    `/api/sources/${encodeURIComponent(sourceId)}/insights`,
    { timeoutMs: 10_000 },
  );
  return Array.isArray(list) ? list : [];
}

/**
 * Kick off open-notebook's "insight" pipeline for a source — applying a
 * transformation (e.g. "Key Insights", "Dense Summary") via the worker queue.
 * Returns the pending command record; insights become queryable via
 * `listSourceInsights` after the worker finishes (typically tens of seconds).
 */
export async function triggerSourceInsight(params: {
  baseUrl: string;
  sourceId: string;
  transformationId: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<{ status: string; command_id?: string }> {
  return request<{ status: string; command_id?: string }>(
    normalizeBaseUrl(params.baseUrl),
    `/api/sources/${encodeURIComponent(params.sourceId)}/insights`,
    {
      method: 'POST',
      body: { transformation_id: params.transformationId, ...(params.model ? { model_id: params.model } : {}) },
      signal: params.signal,
      timeoutMs: 30_000,
    },
  );
}

/**
 * Ensure a source has at least one insight generated, so per-source chat can
 * answer from real content rather than just the source title. Looks up the
 * named transformation (default: "Key Insights"), kicks off generation if
 * needed, then polls until insights appear or `maxWaitMs` elapses.
 * Idempotent — a no-op if insights already exist.
 *
 * Returns true if insights are now present, false on timeout.
 */
export async function ensureSourceInsights(params: {
  baseUrl: string;
  sourceId: string;
  /** Transformation name to look up; defaults to "Key Insights". */
  transformationName?: string;
  /** Override the language model used to synthesize insights. */
  model?: string;
  /** How long to poll before giving up. Default: 120 seconds. */
  maxWaitMs?: number;
  signal?: AbortSignal;
}): Promise<boolean> {
  const base = normalizeBaseUrl(params.baseUrl);
  const existing = await listSourceInsights(base, params.sourceId);
  if (existing.length > 0) return true;

  const transformations = await listTransformations({ baseUrl: base });
  const wanted = (params.transformationName || 'Key Insights').toLowerCase();
  const transformation =
    transformations.find((t) => t.name?.toLowerCase() === wanted) ||
    transformations.find((t) => t.name?.toLowerCase().includes(wanted)) ||
    transformations[0];
  if (!transformation) return false;

  await triggerSourceInsight({
    baseUrl: base,
    sourceId: params.sourceId,
    transformationId: transformation.id,
    model: params.model,
    signal: params.signal,
  });

  const deadline = Date.now() + (params.maxWaitMs ?? 120_000);
  while (Date.now() < deadline) {
    if (params.signal?.aborted) return false;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const insights = await listSourceInsights(base, params.sourceId);
    if (insights.length > 0) return true;
  }
  return false;
}

/** Exported for tests. Parses the `data: {json}` stream from the chat endpoint. */
export function parseSourceChatStream(text: string): SourceChatAnswer {
  let answer = '';
  let citationSources: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let event: { type?: string; content?: string; data?: { sources?: string[] } } | null = null;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!event) continue;
    if (event.type === 'ai_message' && typeof event.content === 'string') {
      answer = event.content; // last ai_message wins (typically there's one)
    } else if (event.type === 'context_indicators' && event.data?.sources) {
      citationSources = event.data.sources;
    }
  }
  return { answer, citationSources };
}

export interface CachedGroundedAnswer {
  question: string;
  answer: string;
  answeredAt: string;
}

interface SecureOpenNotebookCacheValue {
  v: 1;
  scheme: typeof SECURE_CACHE_SCHEME;
  payload: SecureCipher;
}

function answerCacheKey(level: string, topic: string): string {
  return `open-notebook:answer:${level}:${topic}`;
}

function isAnswerCacheKey(key: string): boolean {
  return key === NOTEBOOK_MAP_KEY || key.startsWith('open-notebook:answer:') || key.startsWith('open-notebook:answer-history:');
}

function isSecureOpenNotebookCacheValue(value: unknown): value is SecureOpenNotebookCacheValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as SecureOpenNotebookCacheValue).v === 1 &&
    (value as SecureOpenNotebookCacheValue).scheme === SECURE_CACHE_SCHEME &&
    typeof (value as SecureOpenNotebookCacheValue).payload?.iv === 'string' &&
    typeof (value as SecureOpenNotebookCacheValue).payload?.ct === 'string'
  );
}

function assertOpenNotebookCacheUnlocked(vault: SecureVault = openNotebookSecureVault) {
  if (!vault.isUnlocked()) {
    throw new Error('Secure Vault is enabled but locked. Unlock it before reading or writing encrypted open-notebook settings rows.');
  }
}

async function encodeOpenNotebookCacheValue(
  key: string,
  value: unknown,
  vault: SecureVault = openNotebookSecureVault,
): Promise<unknown> {
  if (!isAnswerCacheKey(key) || !vault.isEnabled()) return value;
  assertOpenNotebookCacheUnlocked(vault);
  return {
    v: 1,
    scheme: SECURE_CACHE_SCHEME,
    payload: await vault.encrypt(JSON.stringify(value)),
  } satisfies SecureOpenNotebookCacheValue;
}

async function decodeOpenNotebookCacheValue<T>(
  key: string,
  value: unknown,
  fallback: T,
  vault: SecureVault = openNotebookSecureVault,
): Promise<T> {
  if (!isAnswerCacheKey(key) || !isSecureOpenNotebookCacheValue(value)) return (value as T) ?? fallback;
  assertOpenNotebookCacheUnlocked(vault);
  return JSON.parse(await vault.decrypt(value.payload)) as T;
}

export async function encryptExistingOpenNotebookAnswerCacheForSecureVault(vault: SecureVault = openNotebookSecureVault) {
  if (!vault.isEnabled()) return { encrypted: 0, alreadyEncrypted: 0 };
  assertOpenNotebookCacheUnlocked(vault);
  const settings = getStorage().settings;
  const rows = (await settings.toArray()).filter((row) => isAnswerCacheKey(row.key));
  let encrypted = 0;
  let alreadyEncrypted = 0;
  for (const row of rows) {
    if (isSecureOpenNotebookCacheValue(row.value)) {
      alreadyEncrypted += 1;
      continue;
    }
    await settings.put({
      ...row,
      value: await encodeOpenNotebookCacheValue(row.key, row.value, vault),
      updatedAt: new Date().toISOString(),
    });
    encrypted += 1;
  }
  return { encrypted, alreadyEncrypted };
}

export async function decryptEncryptedOpenNotebookAnswerCacheForSecureVault(vault: SecureVault = openNotebookSecureVault) {
  assertOpenNotebookCacheUnlocked(vault);
  const settings = getStorage().settings;
  const rows = (await settings.toArray()).filter(
    (row) => isAnswerCacheKey(row.key) && isSecureOpenNotebookCacheValue(row.value),
  );
  let decrypted = 0;
  for (const row of rows) {
    await settings.put({
      ...row,
      value: await decodeOpenNotebookCacheValue(row.key, row.value, row.value, vault),
      updatedAt: new Date().toISOString(),
    });
    decrypted += 1;
  }
  return { decrypted };
}

/** Last grounded Q&A for a topic, so it survives navigation/reload. */
export async function getCachedGroundedAnswer(
  level: string,
  topic: string,
): Promise<CachedGroundedAnswer | null> {
  try {
    const key = answerCacheKey(level, topic);
    const row = await getStorage().settings.get(key);
    return row ? await decodeOpenNotebookCacheValue<CachedGroundedAnswer | null>(key, row.value, null) : null;
  } catch {
    return null;
  }
}

export async function saveCachedGroundedAnswer(
  level: string,
  topic: string,
  entry: { question: string; answer: string },
): Promise<CachedGroundedAnswer> {
  const payload: CachedGroundedAnswer = { ...entry, answeredAt: new Date().toISOString() };
  const key = answerCacheKey(level, topic);
  await getStorage().settings.put({
    key,
    value: await encodeOpenNotebookCacheValue(key, payload),
    updatedAt: payload.answeredAt,
  });
  // Also append to the rolling history (capped at 10 entries per topic).
  await appendCachedGroundedAnswerHistory(level, topic, payload);
  return payload;
}

const ANSWER_HISTORY_MAX = 10;

function answerHistoryCacheKey(level: string, topic: string): string {
  return `open-notebook:answer-history:${level}:${topic}`;
}

/** Last N grounded answers for a topic (newest first). */
export async function getCachedGroundedAnswerHistory(
  level: string,
  topic: string,
): Promise<CachedGroundedAnswer[]> {
  try {
    const key = answerHistoryCacheKey(level, topic);
    const row = await getStorage().settings.get(key);
    const list = row ? await decodeOpenNotebookCacheValue<CachedGroundedAnswer[]>(key, row.value, []) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function appendCachedGroundedAnswerHistory(
  level: string,
  topic: string,
  entry: CachedGroundedAnswer,
): Promise<void> {
  try {
    const prior = await getCachedGroundedAnswerHistory(level, topic);
    // Dedupe: skip if the previous head matches this question+answer exactly.
    const filtered =
      prior[0] && prior[0].question === entry.question && prior[0].answer === entry.answer
        ? prior.slice(1)
        : prior;
    const next = [entry, ...filtered].slice(0, ANSWER_HISTORY_MAX);
    const key = answerHistoryCacheKey(level, topic);
    await getStorage().settings.put({
      key,
      value: await encodeOpenNotebookCacheValue(key, next),
      updatedAt: entry.answeredAt,
    });
  } catch {
    // Best-effort history — never block the primary save.
  }
}
