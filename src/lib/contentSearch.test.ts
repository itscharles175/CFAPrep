import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeContentDomain,
  searchAllContent,
  searchLsatQuestions,
  LSAT_QUESTION_BROWSER_PATH,
  type ContentHit,
} from './contentSearch';
import type { ChunkSearchResult } from './storage/types';
import type { NotebookSourceHit } from './openNotebook';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function hostChunk(over: Partial<ChunkSearchResult> = {}): ChunkSearchResult {
  return {
    id: 'c1',
    documentId: 'doc1',
    domain: 'cfa',
    text: 'Duration measures the price sensitivity of a bond to yield changes.',
    locator: 'FI · R44',
    score: 0.8,
    ...over,
  };
}

function notebookHit(over: Partial<NotebookSourceHit> = {}): NotebookSourceHit {
  return { id: 'source:n1', title: 'Bond Math notes', text: 'Bond Math notes', locator: 'Bond Math notes', score: 0.6, ...over };
}

describe('activeContentDomain', () => {
  it('derives the study domain from the URL path', () => {
    expect(activeContentDomain('/lsat/srs')).toBe('lsat');
    expect(activeContentDomain('/cfa/level1/fixed-income')).toBe('cfa');
    expect(activeContentDomain('/quant/risk')).toBe('quant');
    expect(activeContentDomain('/excel')).toBe('excel');
    expect(activeContentDomain('/vault')).toBe('vault');
    expect(activeContentDomain('/')).toBe('general');
    expect(activeContentDomain(undefined)).toBe('general');
  });
});

describe('searchAllContent', () => {
  const stubs = (over: Partial<Parameters<typeof searchAllContent>[0]> = {}) => ({
    query: 'duration',
    searchHost: async () => [hostChunk()],
    searchLsat: async () => [{ questionId: 42, qType: 'Weaken', source: 'official', stem: 'Which one of the following most weakens...', score: 0.9 }],
    searchNotebook: async () => [notebookHit()],
    ...over,
  });

  it('unions host curriculum, LSAT questions, and notebook sources into one list', async () => {
    const hits = await searchAllContent(stubs());
    const sources = hits.map((h) => h.source).sort();
    expect(sources).toEqual(['host', 'lsat-question', 'notebook']);
  });

  it('returns [] for an empty/whitespace query without calling any source', async () => {
    const searchHost = vi.fn();
    const hits = await searchAllContent(stubs({ query: '   ', searchHost }));
    expect(hits).toEqual([]);
    expect(searchHost).not.toHaveBeenCalled();
  });

  it('LSAT question hits are external + deep-link to the question browser', async () => {
    const hits = await searchAllContent(stubs());
    const lsat = hits.find((h) => h.source === 'lsat-question') as ContentHit;
    expect(lsat.external).toBe(true);
    expect(lsat.domain).toBe('lsat');
    expect(lsat.deepLink.startsWith(LSAT_QUESTION_BROWSER_PATH)).toBe(true);
    expect(lsat.deepLink).toContain('question=42');
  });

  it('host + notebook hits are internal (host router) deep-links into the vault', async () => {
    const hits = await searchAllContent(stubs());
    const host = hits.find((h) => h.source === 'host') as ContentHit;
    const nb = hits.find((h) => h.source === 'notebook') as ContentHit;
    expect(host.external).toBe(false);
    expect(host.deepLink).toContain('/vault?');
    expect(host.deepLink).toContain('chunk=c1');
    expect(nb.external).toBe(false);
    expect(nb.deepLink).toContain('/vault?');
  });

  it('degrades: a source that throws contributes no rows (union still resolves)', async () => {
    const hits = await searchAllContent(
      stubs({
        searchLsat: async () => {
          throw new Error('sidecar down');
        },
      }),
    );
    expect(hits.some((h) => h.source === 'lsat-question')).toBe(false);
    // The other two sources still contribute.
    expect(hits.some((h) => h.source === 'host')).toBe(true);
    expect(hits.some((h) => h.source === 'notebook')).toBe(true);
  });

  it('weights the active domain so a same-domain hit floats above a higher-raw-score other-domain hit', async () => {
    // LSAT raw score 0.55 vs host(cfa) raw score 0.65 → without the bump, host leads.
    const base = {
      query: 'duration',
      searchHost: async () => [hostChunk({ score: 0.65 })],
      searchLsat: async () => [{ questionId: 7, stem: 'LSAT stem', score: 0.55 }],
      searchNotebook: async () => [] as NotebookSourceHit[],
    };
    // Active domain = lsat → +0.15 bump puts LSAT (0.70) above host (0.65).
    const lsatActive = await searchAllContent({ ...base, pathname: '/lsat/srs' });
    expect(lsatActive[0].source).toBe('lsat-question');
    // Active domain = cfa → host stays on top.
    const cfaActive = await searchAllContent({ ...base, pathname: '/cfa' });
    expect(cfaActive[0].source).toBe('host');
  });

  it('respects the overall limit', async () => {
    const manyChunks = Array.from({ length: 10 }, (_, i) => hostChunk({ id: `c${i}`, score: 0.9 - i * 0.01 }));
    const hits = await searchAllContent({
      query: 'duration',
      limit: 4,
      searchHost: async () => manyChunks,
      searchLsat: async () => [],
      searchNotebook: async () => [],
    });
    expect(hits).toHaveLength(4);
  });
});

describe('searchLsatQuestions', () => {
  function mockFetch(impl: () => Promise<Response> | Response) {
    vi.stubGlobal('fetch', vi.fn(impl as unknown as typeof fetch));
  }

  it('maps the FTS response into descending-scored hits', async () => {
    mockFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            query: 'assumption',
            results: [
              { question_id: 1, q_type: 'NecessaryAssumption', source: 'official', stem: 'The argument assumes...' },
              { question_id: 2, q_type: 'Weaken', source: 'sample', stem: 'Which weakens...' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const hits = await searchLsatQuestions({ query: 'assumption', limit: 10 });
    expect(hits).toHaveLength(2);
    expect(hits[0].questionId).toBe(1);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[0].score).toBeLessThanOrEqual(1);
  });

  it('returns [] on a non-2xx response (no throw)', async () => {
    mockFetch(() => Promise.resolve(new Response('nope', { status: 503 })));
    await expect(searchLsatQuestions({ query: 'x', limit: 5 })).resolves.toEqual([]);
  });

  it('returns [] when fetch rejects (sidecar unreachable)', async () => {
    mockFetch(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(searchLsatQuestions({ query: 'x', limit: 5 })).resolves.toEqual([]);
  });

  it('returns [] for an empty query without hitting the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(searchLsatQuestions({ query: '  ', limit: 5 })).resolves.toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
