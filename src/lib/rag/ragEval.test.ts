import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  recallAtK,
  precisionAtK,
  reciprocalRank,
  ndcgAtK,
  searchChunks,
  evaluateFixture,
  checkFloor,
  defaultRetrieval,
  fusionRetrieval,
  rerankRetrieval,
  tokenOverlapJudge,
  metricDelta,
  shouldEnableByDefault,
  type RagFixture,
  type EvalChunk,
  type RelevanceJudgment,
} from './ragEval';

// The CLI gate (scripts/rag-eval.mjs) and this test share ONE floor: the
// numbers below are the same seeded baseline. Keep them in sync — if you change
// the fixtures or improve retrieval, re-seed BOTH.
const FLOOR_K = 5;
// Re-seeded in Wave 5 (RAG-5 + RAG-8 fixtures) — see scripts/rag-eval.mjs for the
// rationale: precision drifts down with corpus size (fixture artifact); nDCG/MRR
// rose with the structure-aware chunks, so those floors were raised.
const FLOOR = { recall: 1.0, precision: 0.223, mrr: 0.96, ndcg: 0.97 };

// Vite/vitest resolves JSON imports natively, so the test consumes the exact
// same golden fixtures the CLI harness reads off disk.
import corpus from '../../../tests/rag-fixtures/corpus.json';
import queries from '../../../tests/rag-fixtures/queries.json';

const fixture: RagFixture = {
  chunks: corpus.chunks as EvalChunk[],
  queries: queries.queries,
};

// ---------------------------------------------------------------------------
// Metric primitives — hand-computed cases
// ---------------------------------------------------------------------------
describe('IR metric primitives', () => {
  const relevant = new Set(['a', 'c']);

  it('recallAtK is the fraction of relevant ids found within top-k', () => {
    // ranking: a(rel) b d(.) c(rel)
    const ranked = ['a', 'b', 'd', 'c'];
    expect(recallAtK(ranked, relevant, 1)).toBeCloseTo(0.5, 12); // only 'a'
    expect(recallAtK(ranked, relevant, 4)).toBeCloseTo(1.0, 12); // a + c
    expect(recallAtK(ranked, new Set(), 4)).toBe(0); // vacuous
  });

  it('precisionAtK is the fraction of top-k that is relevant', () => {
    const ranked = ['a', 'b', 'd', 'c'];
    expect(precisionAtK(ranked, relevant, 1)).toBeCloseTo(1.0, 12); // a
    expect(precisionAtK(ranked, relevant, 2)).toBeCloseTo(0.5, 12); // a,b
    expect(precisionAtK(ranked, relevant, 4)).toBeCloseTo(0.5, 12); // 2 of 4
    expect(precisionAtK([], relevant, 4)).toBe(0);
  });

  it('reciprocalRank is 1/(rank of first relevant hit)', () => {
    expect(reciprocalRank(['x', 'a', 'c'], relevant)).toBeCloseTo(1 / 2, 12);
    expect(reciprocalRank(['a'], relevant)).toBeCloseTo(1, 12);
    expect(reciprocalRank(['x', 'y'], relevant)).toBe(0);
  });

  it('ndcgAtK is 1 when all relevant docs are ranked first, decays otherwise', () => {
    // perfect: both relevant at the front
    expect(ndcgAtK(['a', 'c', 'x'], relevant, 3)).toBeCloseTo(1.0, 12);
    // single relevant doc at rank 1 → perfect
    expect(ndcgAtK(['a', 'x', 'y'], new Set(['a']), 3)).toBeCloseTo(1.0, 12);
    // single relevant doc at rank 2 → 1/log2(3) discounted vs ideal 1/log2(2)
    const expected = (1 / Math.log2(3)) / (1 / Math.log2(2));
    expect(ndcgAtK(['x', 'a', 'y'], new Set(['a']), 3)).toBeCloseTo(expected, 12);
    expect(ndcgAtK(['x'], new Set(), 3)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Retrieval — mirrors the host hybrid ranking, deterministic + offline
// ---------------------------------------------------------------------------
describe('searchChunks (host-mirrored ranking)', () => {
  const corpusChunks: EvalChunk[] = [
    { id: 'c1', domain: 'cfa', text: 'Modified duration measures bond price sensitivity to yield.' },
    { id: 'c2', domain: 'cfa', text: 'Convexity captures curvature of the price-yield relationship.' },
    { id: 'c3', domain: 'excel', text: 'XLOOKUP returns a matching value from a result array.' },
  ];

  it('ranks the lexically-best chunk first (BM25-only path)', () => {
    const hits = searchChunks(corpusChunks, { query: 'modified duration bond' });
    expect(hits[0].id).toBe('c1');
    expect(hits[0].score).toBeGreaterThan(0);
    expect(typeof hits[0].bm25Score).toBe('number');
    expect(hits[0].vectorScore).toBeUndefined();
  });

  it('applies the domain filter', () => {
    const hits = searchChunks(corpusChunks, { query: 'lookup', domain: 'excel' });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.domain).toBe('excel');
  });

  it('blends 0.6*vector + 0.4*bm25 when both signals are present (host invariant)', () => {
    const withVecs: EvalChunk[] = [
      { id: 'h1', domain: 'cfa', text: 'duration duration duration of bonds', embedding: [0, 1, 0] },
      { id: 'h2', domain: 'cfa', text: 'duration of yields', embedding: [1, 0, 0] },
    ];
    const hits = searchChunks(withVecs, { query: 'duration', embedding: [1, 0, 0] });
    expect(hits).toHaveLength(2);
    for (const h of hits) {
      const blend = 0.6 * h.vectorScore! + 0.4 * h.bm25Score!;
      expect(Math.abs(h.score - blend)).toBeLessThan(1e-9);
    }
  });

  it('is deterministic — ties break by ascending id', () => {
    // two chunks with identical text → identical score → stable id order
    const tied: EvalChunk[] = [
      { id: 'z', domain: 'cfa', text: 'alpha beta gamma' },
      { id: 'a', domain: 'cfa', text: 'alpha beta gamma' },
    ];
    const hits = searchChunks(tied, { query: 'alpha beta' });
    expect(hits.map((h) => h.id)).toEqual(['a', 'z']);
  });
});

// ---------------------------------------------------------------------------
// The non-regression GATE — same floor the CLI harness enforces
// ---------------------------------------------------------------------------
describe('RAG eval floor (non-regression gate)', () => {
  it('the golden fixture meets the seeded floor at k=5', () => {
    const report = evaluateFixture(fixture, FLOOR_K);
    const violations = checkFloor(report.aggregate, FLOOR);
    // Surface a readable message if it ever regresses.
    expect(violations, JSON.stringify({ aggregate: report.aggregate, violations })).toEqual([]);
  });

  it('every query retrieves its full relevant set within k=5 (recall@5 == 1)', () => {
    const report = evaluateFixture(fixture, FLOOR_K);
    expect(report.aggregate.recall).toBeCloseTo(1.0, 12);
  });

  it('reports one row per fixture query', () => {
    const report = evaluateFixture(fixture, FLOOR_K);
    expect(report.perQuery).toHaveLength(fixture.queries.length);
  });
});

// ---------------------------------------------------------------------------
// Property-based invariants (fast-check) — the metrics can never lie
// ---------------------------------------------------------------------------
describe('metric invariants (property-based)', () => {
  // Arbitrary ranking of unique ids + an arbitrary relevant subset of the pool.
  const scenario = fc
    .uniqueArray(fc.string({ minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 12 })
    .chain((pool) =>
      fc.record({
        ranked: fc.constant(pool),
        relevant: fc.subarray(pool).map((arr) => new Set(arr)),
        k: fc.integer({ min: 1, max: pool.length }),
      }),
    );

  it('recall and precision always lie in [0,1]', () => {
    fc.assert(
      fc.property(scenario, ({ ranked, relevant, k }) => {
        const r = recallAtK(ranked, relevant, k);
        const p = precisionAtK(ranked, relevant, k);
        return r >= 0 && r <= 1 && p >= 0 && p <= 1;
      }),
    );
  });

  it('recall@k is monotonically non-decreasing in k', () => {
    fc.assert(
      fc.property(scenario, ({ ranked, relevant, k }) => {
        const here = recallAtK(ranked, relevant, k);
        const more = recallAtK(ranked, relevant, k + 1);
        return more + 1e-9 >= here;
      }),
    );
  });

  it('reciprocal rank and nDCG always lie in [0,1]', () => {
    fc.assert(
      fc.property(scenario, ({ ranked, relevant, k }) => {
        const rr = reciprocalRank(ranked, relevant);
        const n = ndcgAtK(ranked, relevant, k);
        return rr >= 0 && rr <= 1 && n >= 0 && n <= 1 + 1e-9;
      }),
    );
  });

  it('a perfect ranking (all relevant first) scores recall=precision=ndcg=1 at k=|rel|', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 4 }), { minLength: 2, maxLength: 10 }),
        fc.integer({ min: 1, max: 5 }),
        (pool, relCount) => {
          const rel = Math.min(relCount, pool.length);
          const relevant = new Set(pool.slice(0, rel));
          const k = rel;
          return (
            Math.abs(recallAtK(pool, relevant, k) - 1) < 1e-9 &&
            Math.abs(precisionAtK(pool, relevant, k) - 1) < 1e-9 &&
            Math.abs(ndcgAtK(pool, relevant, k) - 1) < 1e-9
          );
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Wave-5 measurement harnesses — fusion / rerank / decision primitive
// ---------------------------------------------------------------------------
describe('Wave-5 retrieval-variant harnesses', () => {
  const chunks: EvalChunk[] = [
    { id: 'a', domain: 'cfa', text: 'modified duration of a bond', embedding: [1, 0, 0] },
    { id: 'b', domain: 'cfa', text: 'convexity curvature price yield', embedding: [0, 1, 0] },
    { id: 'c', domain: 'cfa', text: 'unrelated excel pivot table', embedding: [0, 0, 1] },
  ];

  it('fusionRetrieval falls back to BM25-only when no query embedding is present', () => {
    const j: RelevanceJudgment = { id: 'q', query: 'modified duration', relevant: ['a'] };
    const fused = fusionRetrieval()(chunks, j, 5);
    const bm25 = defaultRetrieval(chunks, j, 5);
    expect(fused[0]).toBe('a');
    expect(fused).toEqual(bm25);
  });

  it('fusionRetrieval fuses BM25 + vector channels when a query embedding is present', () => {
    const j: RelevanceJudgment = { id: 'q', query: 'duration', relevant: ['a'], embedding: [1, 0, 0] };
    const fused = fusionRetrieval()(chunks, j, 5);
    // 'a' is top of both the lexical (duration) and vector ([1,0,0]) channels.
    expect(fused[0]).toBe('a');
  });

  it('rerankRetrieval re-sorts by the synthetic judge', () => {
    const j: RelevanceJudgment = { id: 'q', query: 'convexity curvature', relevant: ['b'] };
    const ranked = rerankRetrieval(tokenOverlapJudge, 24)(chunks, j, 5);
    expect(ranked[0]).toBe('b');
  });

  it('metricDelta computes signed per-metric differences', () => {
    const base = { k: 5, queryCount: 1, recall: 1, precision: 0.2, mrr: 0.5, ndcg: 0.6 };
    const variant = { k: 5, queryCount: 1, recall: 1, precision: 0.2, mrr: 0.8, ndcg: 0.75 };
    const d = metricDelta(base, variant);
    expect(d.ndcg).toBeCloseTo(0.15, 9);
    expect(d.mrr).toBeCloseTo(0.3, 9);
    expect(d.recall).toBe(0);
  });

  it('shouldEnableByDefault requires an nDCG gain AND no recall regression', () => {
    expect(shouldEnableByDefault({ recall: 0, precision: 0, mrr: 0, ndcg: 0.01 })).toBe(true);
    expect(shouldEnableByDefault({ recall: 0, precision: 0, mrr: 0, ndcg: 0 })).toBe(false);
    expect(shouldEnableByDefault({ recall: -0.1, precision: 0, mrr: 0, ndcg: 0.5 })).toBe(false);
  });

  it('on the golden set, fusion + rerank do NOT beat BM25 (data-driven default-OFF)', () => {
    const fixture: RagFixture = { chunks: corpus.chunks as EvalChunk[], queries: queries.queries };
    const base = evaluateFixture(fixture, 5, defaultRetrieval).aggregate;
    const reranked = evaluateFixture(fixture, 5, rerankRetrieval(tokenOverlapJudge, 24)).aggregate;
    const d = metricDelta(base, reranked);
    // Documents the measured result: no nDCG lift → ship the heavier stage OFF.
    expect(shouldEnableByDefault(d)).toBe(false);
  });
});
