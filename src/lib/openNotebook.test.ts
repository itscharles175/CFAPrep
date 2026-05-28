import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OPEN_NOTEBOOK_SETTINGS,
  addTextSource,
  askGrounded,
  checkOpenNotebookConnection,
  ensureTopicNotebook,
  getCachedGroundedAnswer,
  getOpenNotebookSettings,
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

  it('maps a topic to one stable notebook and seeds it only on first use', async () => {
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
        return Promise.resolve(jsonResponse({ id: 'source:1' }));
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

    expect(first).toBe(second);
    expect(created).toHaveLength(1);
    // exactly one source POST (seeded on first creation, not on reuse)
    const sourcePosts = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/api/sources/json'));
    expect(sourcePosts).toHaveLength(1);
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
