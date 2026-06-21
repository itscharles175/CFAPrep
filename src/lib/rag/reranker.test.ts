import { describe, expect, it, vi } from 'vitest';

import { rerankCandidates, type RerankCandidate, type RerankGenerate, type RerankCache } from './reranker';

const cand = (id: string, text: string, score: number): RerankCandidate => ({ id, text, score });

function makeCache(): RerankCache {
  const m = new Map<string, number>();
  return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v) };
}

describe('RAG-3 — local-LLM reranker', () => {
  it('re-sorts candidates by the judge score, overriding stage-1 order', async () => {
    // Stage-1 puts the irrelevant chunk first; the judge should flip them.
    const candidates = [cand('bad', 'unrelated text', 0.9), cand('good', 'the answer about duration', 0.4)];
    const generate: RerankGenerate = vi.fn(async ({ prompt }) =>
      ({ text: prompt.includes('the answer about duration') ? '95' : '5' }),
    );
    const out = await rerankCandidates('duration', candidates, { generate, cache: makeCache() });
    expect(out[0].id).toBe('good');
    expect(out[0].judged).toBe(true);
    expect(out[0].rerankScore).toBeCloseTo(0.95, 6);
  });

  it('falls back to the stage-1 score when the judge is offline (judged:false), never throws', async () => {
    const candidates = [cand('a', 'aaa', 0.7), cand('b', 'bbb', 0.3)];
    const generate: RerankGenerate = vi.fn(async () => {
      throw new Error('Could not reach the local model server.');
    });
    const out = await rerankCandidates('q', candidates, { generate, cache: makeCache() });
    // Offline → stage-1 order preserved (0.7 before 0.3).
    expect(out.map((c) => c.id)).toEqual(['a', 'b']);
    expect(out.every((c) => c.judged === false)).toBe(true);
  });

  it('caches judgments — a repeated candidate is not re-judged', async () => {
    const cache = makeCache();
    const generate: RerankGenerate = vi.fn(async () => ({ text: '80' }));
    const candidates = [cand('a', 'same text', 0.5)];
    await rerankCandidates('q', candidates, { generate, cache });
    await rerankCandidates('q', candidates, { generate, cache });
    expect(generate).toHaveBeenCalledTimes(1); // 2nd call served from cache
  });

  it('honours topN over-retrieve and limit', async () => {
    const candidates = [cand('a', 'a', 0.9), cand('b', 'b', 0.8), cand('c', 'c', 0.7), cand('d', 'd', 0.6)];
    const generate: RerankGenerate = vi.fn(async () => ({ text: '50' }));
    const out = await rerankCandidates('q', candidates, { generate, cache: makeCache(), topN: 3, limit: 2 });
    expect(out).toHaveLength(2);
    // only the first 3 were considered (d excluded by topN).
    expect(out.map((c) => c.id)).not.toContain('d');
  });

  it('an unparseable judge reply falls back to stage-1 for that candidate', async () => {
    const candidates = [cand('a', 'aaa', 0.5)];
    const generate: RerankGenerate = vi.fn(async () => ({ text: 'very relevant' }));
    const out = await rerankCandidates('q', candidates, { generate, cache: makeCache() });
    expect(out[0].judged).toBe(false);
    expect(out[0].rerankScore).toBe(0.5);
  });

  it('empty candidate list returns empty', async () => {
    const out = await rerankCandidates('q', [], { generate: vi.fn() as unknown as RerankGenerate });
    expect(out).toEqual([]);
  });
});
