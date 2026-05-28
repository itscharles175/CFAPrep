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

type TopicNotebookMap = Record<string, string>;

async function loadTopicNotebookMap(): Promise<TopicNotebookMap> {
  try {
    const row = await db.settings.get(NOTEBOOK_MAP_KEY);
    return (row?.value as TopicNotebookMap) || {};
  } catch {
    return {};
  }
}

async function saveTopicNotebookMap(map: TopicNotebookMap): Promise<void> {
  await db.settings.put({ key: NOTEBOOK_MAP_KEY, value: map, updatedAt: new Date().toISOString() });
}

/**
 * Ensure a per-topic notebook exists (reusing one across sessions via a local
 * id map), seed it with the supplied curriculum text the first time, and return
 * the notebook id. Idempotent: a topic maps to a single stable notebook.
 */
export async function ensureTopicNotebook(params: {
  baseUrl: string;
  topicKey: string;
  topicTitle: string;
  seedChunks?: { locator?: string; text: string }[];
  signal?: AbortSignal;
}): Promise<string> {
  const base = normalizeBaseUrl(params.baseUrl);
  const map = await loadTopicNotebookMap();
  const existingId = map[params.topicKey];

  if (existingId) {
    // Verify it still exists on the backend (e.g. DB reset would orphan the id).
    const notebooks = await listNotebooks({ baseUrl: base });
    if (notebooks.some((n) => n.id === existingId)) return existingId;
  }

  const notebook = await createNotebook(base, `CFA: ${params.topicTitle}`, `QuantVault topic ${params.topicKey}`);
  map[params.topicKey] = notebook.id;
  await saveTopicNotebookMap(map);

  if (params.seedChunks && params.seedChunks.length > 0) {
    const content = params.seedChunks
      .map((c) => (c.locator ? `[${c.locator}] ${c.text}` : c.text))
      .join('\n\n')
      .slice(0, 20_000);
    if (content.trim()) {
      await addTextSource(base, {
        notebookId: notebook.id,
        title: params.topicTitle,
        content,
        embed: true,
        signal: params.signal,
      });
    }
  }

  return notebook.id;
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
  return payload;
}
