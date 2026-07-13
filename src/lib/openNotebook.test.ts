import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OPEN_NOTEBOOK_SETTINGS,
  addTextSource,
  askGrounded,
  chatWithSource,
  checkOpenNotebookConnection,
  deleteNotebook,
  ensureSourceInsights,
  ensureTopicNotebook,
  decryptEncryptedOpenNotebookAnswerCacheForSecureVault,
  encryptExistingOpenNotebookAnswerCacheForSecureVault,
  getCachedGroundedAnswer,
  getOpenNotebookSettings,
  listSourceInsights,
  listTransformations,
  notebookSourcesAvailable,
  parseSourceChatStream,
  getCachedGroundedAnswerHistory,
  saveCachedGroundedAnswer,
  saveOpenNotebookSettings,
  searchNotebookSources,
  setOpenNotebookSecureVaultForTesting,
  triggerSourceInsight,
} from './openNotebook';
import { db } from './progressStore';
import { createMemoryKeyStore, SecureVault, type SecureVaultFlagStore } from './secureVault';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function secureVaultFlag(initial = false): SecureVaultFlagStore {
  let enabled = initial;
  return {
    get: () => enabled,
    set: (value) => {
      enabled = value;
    },
  };
}

async function enableTestSecureVault() {
  const vault = new SecureVault(createMemoryKeyStore(), secureVaultFlag());
  const result = await vault.enable();
  expect(result.ok).toBe(true);
  setOpenNotebookSecureVaultForTesting(vault);
  return vault;
}

describe('open-notebook client', () => {
  beforeEach(async () => {
    await db.settings.clear();
    setOpenNotebookSecureVaultForTesting(null);
  });

  afterEach(() => {
    setOpenNotebookSecureVaultForTesting(null);
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

  it('rejects remote open-notebook bases before saving settings', async () => {
    await expect(
      saveOpenNotebookSettings({ enabled: true, baseUrl: 'http://192.168.1.5:5055' }),
    ).rejects.toThrow(/loopback/i);
    expect(await getOpenNotebookSettings()).toEqual(DEFAULT_OPEN_NOTEBOOK_SETTINGS);
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

  it('rejects remote open-notebook bases before fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const conn = await checkOpenNotebookConnection({ baseUrl: 'http://192.168.1.5:5055' });

    expect(conn.ok).toBe(false);
    expect(conn.error).toMatch(/loopback/i);
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('lists transformations and existing source insights', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/api/transformations')) {
        return Promise.resolve(jsonResponse([
          { id: 'transformation:1', name: 'Key Insights', description: 'x' },
          { id: 'transformation:2', name: 'Dense Summary' },
        ]));
      }
      if (url.includes('/insights')) {
        return Promise.resolve(jsonResponse([{ id: 'insight:1', content: 'a key point' }]));
      }
      return Promise.resolve(jsonResponse([]));
    });
    vi.stubGlobal('fetch', fetchMock);

    const transformations = await listTransformations({ baseUrl: 'http://localhost:5055' });
    expect(transformations.map((t) => t.name)).toEqual(['Key Insights', 'Dense Summary']);
    const insights = await listSourceInsights('http://localhost:5055', 'source:abc');
    expect(insights[0].content).toContain('key point');
  });

  it('triggerSourceInsight posts transformation + model id and returns command status', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      expect(url).toContain('/api/sources/source%3Aabc/insights');
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body).toEqual({ transformation_id: 'transformation:1', model_id: 'model:gemma' });
      return Promise.resolve(jsonResponse({ status: 'pending', command_id: 'command:42' }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await triggerSourceInsight({
      baseUrl: 'http://localhost:5055',
      sourceId: 'source:abc',
      transformationId: 'transformation:1',
      model: 'model:gemma',
    });
    expect(result.status).toBe('pending');
    expect(result.command_id).toBe('command:42');
  });

  it('ensureSourceInsights is a no-op when insights already exist', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ id: 'insight:existing', content: 'already there' }]));
    vi.stubGlobal('fetch', fetchMock);
    const ok = await ensureSourceInsights({
      baseUrl: 'http://localhost:5055',
      sourceId: 'source:abc',
      maxWaitMs: 100,
    });
    expect(ok).toBe(true);
    // exactly one call (the initial listSourceInsights) — no trigger, no poll
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ensureSourceInsights looks up "Key Insights", triggers it, and polls until insights appear', async () => {
    let pollsBeforeInsightAppears = 1;
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/api/transformations')) {
        return Promise.resolve(jsonResponse([
          { id: 'transformation:other', name: 'Other' },
          { id: 'transformation:key', name: 'Key Insights' },
        ]));
      }
      if (url.includes('/insights') && init?.method === 'POST') {
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body.transformation_id).toBe('transformation:key');
        return Promise.resolve(jsonResponse({ status: 'pending' }));
      }
      // GET insights — empty initially, then non-empty after a couple polls
      if (url.includes('/insights')) {
        if (pollsBeforeInsightAppears-- > 0) return Promise.resolve(jsonResponse([]));
        return Promise.resolve(jsonResponse([{ id: 'insight:new', content: 'a new insight' }]));
      }
      return Promise.resolve(jsonResponse([]));
    });
    vi.stubGlobal('fetch', fetchMock);

    const ok = await ensureSourceInsights({
      baseUrl: 'http://localhost:5055',
      sourceId: 'source:abc',
      maxWaitMs: 30_000,
    });
    expect(ok).toBe(true);
    const posts = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'POST');
    expect(posts).toHaveLength(1);
  }, 30_000);

  it('ensureSourceInsights returns false when no transformations are available', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/insights')) return Promise.resolve(jsonResponse([]));
      if (url.endsWith('/api/transformations')) return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse([]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const ok = await ensureSourceInsights({
      baseUrl: 'http://localhost:5055',
      sourceId: 'source:abc',
      maxWaitMs: 100,
    });
    expect(ok).toBe(false);
    // never POSTed (no transformation to apply)
    expect(fetchMock.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'POST')).toHaveLength(0);
  });

  it('deleteNotebook DELETEs the notebook by id', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      expect(init?.method).toBe('DELETE');
      expect(url).toBe('http://localhost:5055/api/notebooks/notebook%3Aabc');
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal('fetch', fetchMock);
    await deleteNotebook('http://localhost:5055', 'notebook:abc');
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('searchNotebookSources ranks sources by query overlap and shapes them as chunk hits', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        { id: 'source:1', title: 'Duration and convexity' },
        { id: 'source:2', title: 'Ethics standards' },
        { id: 'source:3', title: 'Modified duration recap' },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const hits = await searchNotebookSources({ baseUrl: 'http://localhost:5055', query: 'duration' });
    // Only the two duration sources match; the ethics one is filtered out.
    expect(hits.map((h) => h.id).sort()).toEqual(['source:1', 'source:3']);
    expect(hits.every((h) => h.score > 0)).toBe(true);
    expect(hits[0].locator).toBeTruthy();
  });

  it('searchNotebookSources degrades to [] when the sidecar is unreachable (OPS-5)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const hits = await searchNotebookSources({ baseUrl: 'http://localhost:5055', query: 'duration' });
    expect(hits).toEqual([]);
  });

  it('notebookSourcesAvailable is false when the notebook is disabled (no fetch)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const available = await notebookSourcesAvailable({ enabled: false, baseUrl: 'http://localhost:5055' });
    expect(available).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('notebookSourcesAvailable is true when enabled and the backend responds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([{ id: 'm', type: 'language' }])));
    const available = await notebookSourcesAvailable({ enabled: true, baseUrl: 'http://localhost:5055' });
    expect(available).toBe(true);
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

  it('encrypts grounded answer cache rows when Secure Vault is enabled', async () => {
    await enableTestSecureVault();

    await saveCachedGroundedAnswer('level1', 'fixed-income', {
      question: 'private grounded question sentinel',
      answer: 'private grounded answer sentinel',
    });

    const rawAnswer = await db.settings.get('open-notebook:answer:level1:fixed-income');
    const rawHistory = await db.settings.get('open-notebook:answer-history:level1:fixed-income');
    expect(rawAnswer?.value).toMatchObject({ scheme: 'secure-vault-open-notebook-cache.v1' });
    expect(rawHistory?.value).toMatchObject({ scheme: 'secure-vault-open-notebook-cache.v1' });
    expect(JSON.stringify(rawAnswer)).not.toContain('private grounded question sentinel');
    expect(JSON.stringify(rawAnswer)).not.toContain('private grounded answer sentinel');
    expect(JSON.stringify(rawHistory)).not.toContain('private grounded answer sentinel');

    const loaded = await getCachedGroundedAnswer('level1', 'fixed-income');
    const history = await getCachedGroundedAnswerHistory('level1', 'fixed-income');
    expect(loaded?.question).toBe('private grounded question sentinel');
    expect(loaded?.answer).toBe('private grounded answer sentinel');
    expect(history[0]?.answer).toBe('private grounded answer sentinel');
  });

  it('does not write plaintext grounded answer cache rows while Secure Vault is locked', async () => {
    const vault = await enableTestSecureVault();
    vault.lock();

    await expect(
      saveCachedGroundedAnswer('level1', 'fixed-income', {
        question: 'locked grounded question sentinel',
        answer: 'locked grounded answer sentinel',
      }),
    ).rejects.toThrow(/locked/i);

    const rawRows = await db.settings.toArray();
    expect(JSON.stringify(rawRows)).not.toContain('locked grounded question sentinel');
    expect(JSON.stringify(rawRows)).not.toContain('locked grounded answer sentinel');
  });

  it('migrates existing grounded answer cache rows when Secure Vault is enabled and disabled', async () => {
    await db.settings.put({
      key: 'open-notebook:answer:level1:ethics',
      value: {
        question: 'legacy grounded question sentinel',
        answer: 'legacy grounded answer sentinel',
        answeredAt: '2026-01-01T00:00:00.000Z',
      },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await db.settings.put({
      key: 'open-notebook:answer-history:level1:ethics',
      value: [
        {
          question: 'legacy grounded question sentinel',
          answer: 'legacy grounded answer sentinel',
          answeredAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const vault = await enableTestSecureVault();
    expect(await encryptExistingOpenNotebookAnswerCacheForSecureVault(vault)).toEqual({
      encrypted: 2,
      alreadyEncrypted: 0,
    });

    const encryptedRows = await db.settings.toArray();
    expect(encryptedRows.map((row) => row.value)).toEqual([
      expect.objectContaining({ scheme: 'secure-vault-open-notebook-cache.v1' }),
      expect.objectContaining({ scheme: 'secure-vault-open-notebook-cache.v1' }),
    ]);
    expect(JSON.stringify(encryptedRows)).not.toContain('legacy grounded answer sentinel');
    expect((await getCachedGroundedAnswer('level1', 'ethics'))?.answer).toBe('legacy grounded answer sentinel');

    expect(await decryptEncryptedOpenNotebookAnswerCacheForSecureVault(vault)).toEqual({ decrypted: 2 });
    const plainRows = await db.settings.toArray();
    expect(JSON.stringify(plainRows)).toContain('legacy grounded answer sentinel');
    expect(plainRows.some((row) => JSON.stringify(row.value).includes('secure-vault-open-notebook-cache.v1'))).toBe(
      false,
    );
  });

  it('encrypts topic-notebook maps and reuses the decrypted map while unlocked', async () => {
    await db.settings.put({
      key: 'open-notebook:topic-notebooks',
      value: {
        'l1:private-topic': {
          notebookId: 'notebook:private',
          sourceId: 'source:private',
        },
      },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const vault = await enableTestSecureVault();
    expect(await encryptExistingOpenNotebookAnswerCacheForSecureVault(vault)).toEqual({
      encrypted: 1,
      alreadyEncrypted: 0,
    });

    const encryptedRow = await db.settings.get('open-notebook:topic-notebooks');
    expect(encryptedRow?.value).toMatchObject({ scheme: 'secure-vault-open-notebook-cache.v1' });
    expect(JSON.stringify(encryptedRow)).not.toContain('notebook:private');
    expect(JSON.stringify(encryptedRow)).not.toContain('source:private');

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/notebooks')) return jsonResponse([{ id: 'notebook:private', name: 'Private' }]);
      throw new Error(`Unexpected request ${url} ${init?.method || 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      ensureTopicNotebook({
        baseUrl: 'http://localhost:5055',
        topicKey: 'l1:private-topic',
        topicTitle: 'Private Topic',
        seedChunks: [{ text: 'should not be seeded' }],
      }),
    ).resolves.toEqual({ notebookId: 'notebook:private', sourceId: 'source:private' });
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/api/notebooks') && (call[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(0);

    expect(await decryptEncryptedOpenNotebookAnswerCacheForSecureVault(vault)).toEqual({ decrypted: 1 });
    const plainRow = await db.settings.get('open-notebook:topic-notebooks');
    expect(JSON.stringify(plainRow)).toContain('notebook:private');
    expect(JSON.stringify(plainRow)).not.toContain('secure-vault-open-notebook-cache.v1');
  });
});
