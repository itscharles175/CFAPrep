/**
 * RAG-1 — offline retrieval-eval substrate (Wave 2, Measurement Substrate).
 *
 * Purpose
 * -------
 * Make the RAG roadmap (Wave 5) PROVABLE. This module provides two things, both
 * pure, deterministic, and 100% offline (no sidecar, no LLM, no IndexedDB):
 *
 *   1. A faithful re-implementation of the host's BM25 + cosine + hybrid ranking
 *      (the math that lives in `src/lib/storage/dexieDriver.ts`'s `chunks.search`),
 *      runnable over an in-memory chunk array. The Dexie driver reads from
 *      IndexedDB, which a headless Node harness can't open without a shim; the
 *      ranking math itself is pure, so we mirror it here EXACTLY (same k1=1.5,
 *      b=0.75 BM25, same cosine→[0,1] map, same 0.6·vec + 0.4·bm25 blend) and
 *      keep the two in lock-step via the shared `chunkSearch.test.ts` invariants.
 *
 *   2. The standard IR metrics — recall@k, precision@k, MRR, nDCG@k — computed
 *      over a ranked id list against a set of relevance judgments.
 *
 * Both `scripts/rag-eval.mjs` (the CLI gate) and `ragEval.test.ts` (the CI gate)
 * import from here, so the floor that protects the RAG roadmap is exercised in
 * BOTH the node-script job and the existing vitest job from a single source of
 * truth.
 *
 * Determinism note: ties in `score` are broken by ascending `id` so a fixture's
 * ranking is stable run-to-run regardless of input order — the metrics never
 * flap on a tie.
 */

// ---------------------------------------------------------------------------
// Retrieval — mirrors dexieDriver.ts chunk ranking (BM25 + cosine + hybrid)
// ---------------------------------------------------------------------------
// Kept numerically identical to src/lib/storage/dexieDriver.ts so the eval
// scores the SAME relevance signal the app serves. If that file's constants or
// blend ever change, this must change with it (and chunkSearch.test.ts +
// ragEval.test.ts will catch the drift).

const BM25_K1 = 1.5;
const BM25_B = 0.75;

/** A minimal corpus chunk — the eval-facing subset of `SourceChunkInput`. */
export interface EvalChunk {
  id: string;
  domain?: string;
  level?: string;
  topic?: string;
  text: string;
  /** Optional embedding vector — when present (and a query embedding is given), enables hybrid. */
  embedding?: number[];
}

export interface EvalSearchOptions {
  query: string;
  embedding?: number[];
  domain?: string;
  level?: string;
  topic?: string;
  /** Default 12, matching the app's chunk-search default. */
  limit?: number;
}

/** A ranked hit — the eval-facing subset of `ChunkSearchResult`. */
export interface EvalSearchResult {
  id: string;
  domain?: string;
  level?: string;
  topic?: string;
  text: string;
  score: number;
  vectorScore?: number;
  bm25Score?: number;
}

export function tokenise(text: string): string[] {
  if (!text) return [];
  return text.toLowerCase().split(/\W+/).filter(Boolean);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface Candidate {
  chunk: EvalChunk;
  tokens: string[];
}

function computeBm25(candidates: Candidate[], queryTerms: string[]): number[] {
  if (candidates.length === 0 || queryTerms.length === 0) {
    return candidates.map(() => 0);
  }

  const totalDocs = candidates.length;
  const docLens = candidates.map((c) => c.tokens.length);
  const avgDl = docLens.reduce((sum, l) => sum + l, 0) / Math.max(1, totalDocs);

  const df = new Map<string, number>();
  for (const term of new Set(queryTerms)) {
    let n = 0;
    for (const c of candidates) {
      if (c.tokens.includes(term)) n += 1;
    }
    df.set(term, n);
  }

  return candidates.map((c, i) => {
    const tf = new Map<string, number>();
    for (const t of c.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    let score = 0;
    for (const term of queryTerms) {
      const f = tf.get(term);
      if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (totalDocs - n + 0.5) / (n + 0.5));
      const dl = docLens[i];
      const numerator = f * (BM25_K1 + 1);
      const denominator = f + BM25_K1 * (1 - BM25_B + BM25_B * (dl / Math.max(1, avgDl)));
      score += idf * (numerator / denominator);
    }
    return score;
  });
}

function normaliseScores(raw: number[]): number[] {
  const max = raw.reduce((m, v) => (v > m ? v : m), 0);
  if (max <= 0) return raw.map(() => 0);
  return raw.map((v) => (v > 0 ? v / max : 0));
}

/**
 * Rank `corpus` for a query using the exact host hybrid logic. Pure + offline:
 * no IndexedDB, no network. Tie-break is ascending `id` so results are stable.
 */
export function searchChunks(corpus: EvalChunk[], options: EvalSearchOptions): EvalSearchResult[] {
  const limit = options.limit ?? 12;
  const queryTerms = tokenise(options.query ?? '');

  const candidates: Candidate[] = [];
  for (const chunk of corpus) {
    if (options.domain && chunk.domain !== options.domain) continue;
    if (options.level && chunk.level !== options.level) continue;
    if (options.topic && chunk.topic !== options.topic) continue;
    candidates.push({ chunk, tokens: tokenise(chunk.text ?? '') });
  }
  if (candidates.length === 0) return [];

  const bm25Norm = normaliseScores(computeBm25(candidates, queryTerms));

  const hasQueryEmbedding = Array.isArray(options.embedding) && options.embedding.length > 0;
  const anyChunkEmbedding = candidates.some(
    (c) => Array.isArray(c.chunk.embedding) && c.chunk.embedding!.length > 0,
  );
  const useVector = hasQueryEmbedding && anyChunkEmbedding;
  const cosNorm = useVector
    ? candidates.map((c) => {
        const emb = c.chunk.embedding;
        if (!emb || emb.length === 0) return 0;
        const cos = cosineSimilarity(options.embedding!, emb);
        return Math.max(0, Math.min(1, (cos + 1) / 2));
      })
    : candidates.map(() => 0);

  const results: EvalSearchResult[] = candidates.map((c, i) => {
    const bm = bm25Norm[i] ?? 0;
    const vec = cosNorm[i] ?? 0;
    let score: number;
    if (useVector && queryTerms.length > 0) {
      score = 0.6 * vec + 0.4 * bm;
    } else if (useVector) {
      score = vec;
    } else if (queryTerms.length > 0) {
      score = bm;
    } else {
      score = 0;
    }
    return {
      id: c.chunk.id,
      domain: c.chunk.domain,
      level: c.chunk.level,
      topic: c.chunk.topic,
      text: c.chunk.text,
      score,
      vectorScore: useVector ? vec : undefined,
      bm25Score: queryTerms.length > 0 ? bm : undefined,
    };
  });

  results.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return results.slice(0, limit);
}

// ---------------------------------------------------------------------------
// IR metrics — recall@k, precision@k, MRR, nDCG@k
// ---------------------------------------------------------------------------
// All operate on an ORDERED list of retrieved ids vs. a set of relevant ids.
// Relevance is binary (a chunk is relevant or not), which matches our judgment
// format. Empty relevant-set → recall/precision/mrr/ndcg are all 0 (a query
// with no answer is a vacuous case the floor never relies on).

function topK(retrieved: string[], k: number): string[] {
  return retrieved.slice(0, Math.max(0, k));
}

/** Fraction of relevant ids that appear in the top-k. */
export function recallAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  const inTop = topK(retrieved, k);
  let hits = 0;
  for (const id of inTop) if (relevant.has(id)) hits += 1;
  return hits / relevant.size;
}

/** Fraction of the top-k that are relevant. Denominator is min(k, |retrieved|). */
export function precisionAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  const inTop = topK(retrieved, k);
  if (inTop.length === 0) return 0;
  let hits = 0;
  for (const id of inTop) if (relevant.has(id)) hits += 1;
  return hits / inTop.length;
}

/** Reciprocal rank of the FIRST relevant hit (1-based); 0 if none retrieved. */
export function reciprocalRank(retrieved: string[], relevant: Set<string>): number {
  for (let i = 0; i < retrieved.length; i += 1) {
    if (relevant.has(retrieved[i])) return 1 / (i + 1);
  }
  return 0;
}

/**
 * nDCG@k with binary gains. DCG uses the standard log2(rank+1) discount; the
 * ideal DCG places every relevant doc at the front. 0 when no relevant docs.
 */
export function ndcgAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  const inTop = topK(retrieved, k);
  let dcg = 0;
  for (let i = 0; i < inTop.length; i += 1) {
    if (relevant.has(inTop[i])) dcg += 1 / Math.log2(i + 2);
  }
  const idealCount = Math.min(relevant.size, k);
  let idcg = 0;
  for (let i = 0; i < idealCount; i += 1) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

// ---------------------------------------------------------------------------
// Aggregate harness — fixtures → metrics
// ---------------------------------------------------------------------------

/** One annotated query: a question + the ids of the chunks that answer it. */
export interface RelevanceJudgment {
  id: string;
  query: string;
  relevant: string[];
  /** Optional retrieval filters (mirrors the app's domain/level/topic narrowing). */
  domain?: string;
  level?: string;
  topic?: string;
  /** Optional query embedding for hybrid scoring (rare in fixtures; usually lexical). */
  embedding?: number[];
}

export interface RagFixture {
  chunks: EvalChunk[];
  queries: RelevanceJudgment[];
}

/** Per-query metric row at a fixed k. */
export interface PerQueryMetrics {
  queryId: string;
  query: string;
  relevantCount: number;
  retrievedIds: string[];
  recall: number;
  precision: number;
  mrr: number;
  ndcg: number;
}

/** Mean metrics across all queries at the evaluated k. */
export interface AggregateMetrics {
  k: number;
  queryCount: number;
  recall: number;
  precision: number;
  mrr: number;
  ndcg: number;
}

export interface EvalReport {
  perQuery: PerQueryMetrics[];
  aggregate: AggregateMetrics;
}

/** A documented non-regression floor: each metric must be >= its threshold. */
export interface MetricFloor {
  recall: number;
  precision: number;
  mrr: number;
  ndcg: number;
}

/**
 * Run retrieval + metrics for every query in a fixture at a fixed k.
 * Retrieval pulls `Math.max(k, limit)` candidates (so precision@k is meaningful
 * even when k < limit) and the metrics slice to k internally.
 */
export function evaluateFixture(fixture: RagFixture, k = 5): EvalReport {
  const perQuery: PerQueryMetrics[] = fixture.queries.map((judgment) => {
    const relevant = new Set(judgment.relevant);
    const hits = searchChunks(fixture.chunks, {
      query: judgment.query,
      embedding: judgment.embedding,
      domain: judgment.domain,
      level: judgment.level,
      topic: judgment.topic,
      limit: Math.max(k, 12),
    });
    const retrievedIds = hits.map((h) => h.id);
    return {
      queryId: judgment.id,
      query: judgment.query,
      relevantCount: relevant.size,
      retrievedIds,
      recall: recallAtK(retrievedIds, relevant, k),
      precision: precisionAtK(retrievedIds, relevant, k),
      mrr: reciprocalRank(retrievedIds, relevant),
      ndcg: ndcgAtK(retrievedIds, relevant, k),
    };
  });

  const n = Math.max(1, perQuery.length);
  const mean = (sel: (r: PerQueryMetrics) => number): number =>
    perQuery.reduce((sum, r) => sum + sel(r), 0) / n;

  return {
    perQuery,
    aggregate: {
      k,
      queryCount: perQuery.length,
      recall: mean((r) => r.recall),
      precision: mean((r) => r.precision),
      mrr: mean((r) => r.mrr),
      ndcg: mean((r) => r.ndcg),
    },
  };
}

/** A failed-floor entry. */
export interface FloorViolation {
  metric: keyof MetricFloor;
  actual: number;
  floor: number;
}

/**
 * Compare aggregate metrics to a floor. Uses a tiny epsilon so a metric that
 * equals its floor exactly (the seeded baseline case) passes. Returns the list
 * of violations — empty means the gate is green.
 */
export function checkFloor(agg: AggregateMetrics, floor: MetricFloor, epsilon = 1e-9): FloorViolation[] {
  const violations: FloorViolation[] = [];
  (['recall', 'precision', 'mrr', 'ndcg'] as const).forEach((metric) => {
    const actual = agg[metric];
    const threshold = floor[metric];
    if (actual + epsilon < threshold) {
      violations.push({ metric, actual, floor: threshold });
    }
  });
  return violations;
}
