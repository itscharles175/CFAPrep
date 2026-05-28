import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OPEN_NOTEBOOK_SETTINGS,
  addTextSource,
  askGrounded,
  chatWithSource,
  checkOpenNotebookConnection,
  ensureTopicNotebook,
  getCachedGroundedAnswer,
  getOpenNotebookSettings,
  parseSourceChatStream,
  saveCachedGroundedAnswer,
  saveOpenNotebookSettings,
} from './openNotebook';
import { db } from './progressStore';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('open-notebook client', () => {
  beforeEach(async () => {
    await db.settings.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to disabled, local-only, on the proven sidecar port', async () => {
    expect(DEFAULT_OPEN_NOTEBOOK_SETTINGS.enabled).toBe(false);
    expect(DEFAULT_OPEN_NOTEBOOK_SETTINGS.baseUrl).toBe('http://localhost:5055');
    const loaded = await getOpenNotebookSettings();
    expect(loaded).toEqual(DEFAULT_OPEN_NOTEBOOK_SETTINGS);
  });

  it('persists and merges settings', async () => {
    const saved = await saveOpenNotebookSettings({ enabled: true });
    expect(saved.enabled).toBe(true);
    expect(saved.baseUrl).toBe(DEFAULT_OPEN_NOTEBOOK_SETTINGS.baseUrl);
    expect((await getOpenNotebookSettings()).enabled).toBe(true);
  });

  it('parses /api/models into language and embedding defaults', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        { id: 'gemma-4-e4b-it', type: 'language' },
        { id: 'text-embedding-nomic', type: 'embedding' },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const conn = await checkOpenNotebookConnection();
    expect(conn.ok).toBe(true);
    expect(conn.languageModel).toBe('gemma-4-e4b-it');
    expect(conn.embeddingModel).toBe('text-embedding-nomic');
    // strips trailing slash and hits the models endpoint
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:5055/api/models');
  });

  it('reports a friendly error when the backend is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const conn = await checkOpenNotebookConnection({ baseUrl: 'http://localhost:5055/' });
    expect(conn.ok).toBe(false);
    expect(conn.error).toContain('ECONNREFUSED');
  });

  it('sends the proven ask/simple payload with one model for all three stages', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ answer: 'Modified duration is ...' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await askGrounded({
      baseUrl: 'http://localhost:5055',
      question: 'Define modified duration.',
      model: 'gemma-4-e4b-it',
    });
    expect(result.answer).toContain('Modified duration');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:5055/api/search/ask/simple');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      question: 'Define modified duration.',
      strategy_model: 'gemma-4-e4b-it',
      answer_model: 'gemma-4-e4b-it',
      final_answer_model: 'gemma-4-e4b-it',
    });
  });

  it('resolves the default model from /api/models when none is supplied', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'gemma-4-e4b-it', type: 'language' }]))
      .mockResolvedValueOnce(jsonResponse({ answer: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);

    await askGrounded({ baseUrl: 'http://localhost:5055', question: 'Q?' });
    const askBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(askBody.answer_model).toBe('gemma-4-e4b-it');
  });

  it('posts a text source with embed enabled by default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'source:abc' }));
    vi.stubGlobal('fetch', fetchMock);

    const src = await addTextSource('http://localhost:5055', {
      notebookId: 'notebook:1',
      title: 'Duration',
      content: 'text',
    });
    expect(src.id).toBe('source:abc');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ notebook_id: 'notebook:1', type: 'text', embed: true });
  });

  it('maps a topic to one stable notebook+source and seeds only on first use', async () => {
    const created: string[] = [];
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/api/notebooks') && init?.method === 'POST') {
        const id = `notebook:${created.length + 1}`;
        created.push(id);
        return Promise.resolve(jsonResponse({ id, name: 'CFA' }));
      }
      if (url.endsWith('/api/notebooks')) {
        return Promise.resolve(jsonResponse(created.map((id) => ({ id, name: 'CFA' }))));
      }
      if (url.endsWith('/api/sources/json')) {
        return Promise.resolve(jsonResponse({ id: 'source:abc' }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = await ensureTopicNotebook({
      baseUrl: 'http://localhost:5055',
      topicKey: 'l1:fixed-income',
      topicTitle: 'Fixed Income',
      seedChunks: [{ locator: 'p.263', text: 'duration' }],
    });
    const second = await ensureTopicNotebook({
      baseUrl: 'http://localhost:5055',
      topicKey: 'l1:fixed-income',
      topicTitle: 'Fixed Income',
      seedChunks: [{ locator: 'p.263', text: 'duration' }],
    });

    expect(first.notebookId).toBe(second.notebookId);
    expect(first.sourceId).toBe('source:abc');
    expect(second.sourceId).toBe('source:abc'); // reused, no new seed
    expect(created).toHaveLength(1);
    const sourcePosts = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/api/sources/json'));
    expect(sourcePosts).toHaveLength(1);
  });

  it('adopts an existing source when migrating a legacy notebook that already has one', async () => {
    await db.settings.put({
      key: 'open-notebook:topic-notebooks',
      value: { 'l1:fixed-income': 'notebook:legacy' },
      updatedAt: new Date().toISOString(),
    });
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/api/notebooks')) return Promise.resolve(jsonResponse([{ id: 'notebook:legacy', name: 'CFA' }]));
      if (url.includes('/api/sources?notebook_id=')) return Promise.resolve(jsonResponse([{ id: 'source:existing', title: 'Fixed Income' }]));
      if (url.endsWith('/api/sources/json')) return Promise.resolve(jsonResponse({ id: 'source:should_not_be_created' }));
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal('fetch', fetchMock);

    const entry = await ensureTopicNotebook({
      baseUrl: 'http://localhost:5055',
      topicKey: 'l1:fixed-income',
      topicTitle: 'Fixed Income',
      seedChunks: [{ text: 'duration' }],
    });
    expect(entry).toEqual({ notebookId: 'notebook:legacy', sourceId: 'source:existing' });
    const seeded = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/api/sources/json'));
    expect(seeded).toHaveLength(0); // adopted, did NOT seed a duplicate
  });

  it('migrates legacy string-valued topic map entries to {notebookId} and re-seeds the source', async () => {
    // Pre-seed the map in legacy shape (notebookId only, no sourceId).
    await db.settings.put({
      key: 'open-notebook:topic-notebooks',
      value: { 'l1:equity': 'notebook:legacy' },
      updatedAt: new Date().toISOString(),
    });
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/api/notebooks')) return Promise.resolve(jsonResponse([{ id: 'notebook:legacy', name: 'CFA' }]));
      if (url.endsWith('/api/sources/json')) return Promise.resolve(jsonResponse({ id: 'source:new' }));
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal('fetch', fetchMock);

    const entry = await ensureTopicNotebook({
      baseUrl: 'http://localhost:5055',
      topicKey: 'l1:equity',
      topicTitle: 'Equity',
      seedChunks: [{ text: 'equity text' }],
    });
    expect(entry.notebookId).toBe('notebook:legacy');
    expect(entry.sourceId).toBe('source:new');
    // No new POST /api/notebooks happened — we reused the legacy id.
    const created = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/api/notebooks') && (c[1] as RequestInit)?.method === 'POST');
    expect(created).toHaveLength(0);
  });

  it('parses the per-source chat SSE-style stream into answer + citation sources', () => {
    const stream = [
      'data: {"type": "user_message", "content": "What is duration?"}',
      '',
      'data: {"type": "ai_message", "content": "Duration measures price sensitivity to yield."}',
      '',
      'data: {"type": "context_indicators", "data": {"sources": ["source:ur6v8hj8biai1tw8fmwg"], "insights": [], "notes": []}}',
      '',
      'data: {"type": "complete"}',
    ].join('\n');
    const parsed = parseSourceChatStream(stream);
    expect(parsed.answer).toBe('Duration measures price sensitivity to yield.');
    expect(parsed.citationSources).toEqual(['source:ur6v8hj8biai1tw8fmwg']);
  });

  it('chatWithSource creates a session for the source, posts the message, returns the parsed answer', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/chat/sessions') && !url.includes('/messages')) {
        // session create
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body.source_id).toBe('source:abc');
        return Promise.resolve(jsonResponse({ id: 'chat_session:1', title: 'QuantVault ask', source_id: 'source:abc' }));
      }
      if (url.endsWith('/messages')) {
        const stream =
          'data: {"type":"ai_message","content":"Scoped answer."}\n\n' +
          'data: {"type":"context_indicators","data":{"sources":["source:abc"]}}\n\n' +
          'data: {"type":"complete"}\n';
        return Promise.resolve(new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await chatWithSource({
      baseUrl: 'http://localhost:5055',
      sourceId: 'source:abc',
      message: 'Define duration.',
    });
    expect(result.answer).toBe('Scoped answer.');
    expect(result.citationSources).toEqual(['source:abc']);
    // exactly two calls: session create + message post
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches the last grounded answer per topic so it survives navigation', async () => {
    expect(await getCachedGroundedAnswer('level1', 'fixed-income')).toBeNull();
    const saved = await saveCachedGroundedAnswer('level1', 'fixed-income', {
      question: 'What is duration?',
      answer: 'Duration measures price sensitivity to yield.',
    });
    expect(saved.answeredAt).toBeTruthy();

    const loaded = await getCachedGroundedAnswer('level1', 'fixed-income');
    expect(loaded).toMatchObject({
      question: 'What is duration?',
      answer: 'Duration measures price sensitivity to yield.',
    });
    // keyed per topic — a different topic is unaffected
    expect(await getCachedGroundedAnswer('level1', 'equity')).toBeNull();
  });
});
