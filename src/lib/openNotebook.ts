import { db } from './progressStore';

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
  return (baseUrl || DEFAULT_OPEN_NOTEBOOK_SETTINGS.baseUrl).trim().replace(/\/+$/, '');
}

export async function getOpenNotebookSettings(): Promise<OpenNotebookSettings> {
  try {
    const row = await db.settings.get(SETTINGS_KEY);
    return { ...DEFAULT_OPEN_NOTEBOOK_SETTINGS, ...((row?.value as Partial<OpenNotebookSettings>) || {}) };
  } catch {
    return { ...DEFAULT_OPEN_NOTEBOOK_SETTINGS };
  }
}

export async function saveOpenNotebookSettings(
  settings: Partial<OpenNotebookSettings>,
): Promise<OpenNotebookSettings> {
  const merged = { ...DEFAULT_OPEN_NOTEBOOK_SETTINGS, ...settings };
  await db.settings.put({ key: SETTINGS_KEY, value: merged, updatedAt: new Date().toISOString() });
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
  const base = normalizeBaseUrl(settings?.baseUrl);
  try {
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
    const row = await db.settings.get(NOTEBOOK_MAP_KEY);
    const raw = (row?.value as TopicNotebookMap) || {};
    const normalized: Record<string, TopicNotebookEntry> = {};
    for (const [key, value] of Object.entries(raw)) {
      normalized[key] = typeof value === 'string' ? { notebookId: value } : value;
    }
    return normalized;
  } catch {
    return {};
  }
}

async function saveTopicNotebookMap(map: Record<string, TopicNotebookEntry>): Promise<void> {
  await db.settings.put({ key: NOTEBOOK_MAP_KEY, value: map, updatedAt: new Date().toISOString() });
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

function answerCacheKey(level: string, topic: string): string {
  return `open-notebook:answer:${level}:${topic}`;
}

/** Last grounded Q&A for a topic, so it survives navigation/reload. */
export async function getCachedGroundedAnswer(
  level: string,
  topic: string,
): Promise<CachedGroundedAnswer | null> {
  try {
    const row = await db.settings.get(answerCacheKey(level, topic));
    return (row?.value as CachedGroundedAnswer) || null;
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
  await db.settings.put({ key: answerCacheKey(level, topic), value: payload, updatedAt: payload.answeredAt });
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
    const row = await db.settings.get(answerHistoryCacheKey(level, topic));
    const list = row?.value as CachedGroundedAnswer[] | undefined;
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
    await db.settings.put({
      key: answerHistoryCacheKey(level, topic),
      value: next,
      updatedAt: entry.answeredAt,
    });
  } catch {
    // Best-effort history — never block the primary save.
  }
}
