/**
 * Local-first semantic RAG over the storage abstraction.
 *
 * This is the SurrealDB-vector path the roadmap calls for under Pillar 3:
 * grounded "ask" answers that DON'T require the open-notebook sidecar at
 * :5055.  Retrieval goes through `getStorage().chunks.search`, which means:
 *
 *   - Today (Dexie active driver): BM25 + optional cosine over local chunks.
 *   - After `switchToSurreal()`: the SurrealDB MTREE vector index + BM25
 *     full-text hybrid — same call site, no code change.
 *
 * INT-3 — shared retrieval:
 *   Retrieval is the UNION of host curriculum chunks AND the user's embedded
 *   open-notebook sources (CFA curriculum + LSAT/notebook material reached via
 *   the same backend). open-notebook is OPTIONAL (OPS-5): when the sidecar is
 *   disabled or unreachable the union degrades transparently to host-only RAG,
 *   so this path never requires the :5055 sidecar.
 *
 * Flow:
 *   1. Retrieve top-K chunks for the question (filtered by domain/level/topic),
 *      unioned with matching open-notebook sources when available.
 *   2. Pack them under the model's context budget with [n] citation markers.
 *   3. Ask the local LLM to answer using ONLY the retrieved context, citing
 *      sources by their bracket number.
 *   4. Return the answer + the ordered citation list so the UI can render
 *      the same numbered chips the open-notebook path uses.
 *
 * If retrieval finds nothing, we fail fast with a clear "no grounding"
 * error rather than letting the model hallucinate.
 */

import { getStorage } from './storage';
import { generateText } from './localLlm';
import { packExcerpts, pickBudget, renderExcerpts } from './contextBudget';
import {
  getOpenNotebookSettings,
  notebookSourcesAvailable,
  searchNotebookSources,
  type NotebookSourceHit,
} from './openNotebook';
import type { ChunkSearchResult } from './storage/types';
import { reciprocalRankFusion } from './rag/fusion';
import { rerankCandidates, type RerankGenerate } from './rag/reranker';
import { embedText, type EmbedOptions } from './rag/embedder';
import { entail, type EntailmentGenerate } from './rag/entailment';
import {
  conceptNeighborhood,
  type ConceptNode,
  type KnowledgeGraphAnalysis,
  type NeighborhoodEntry,
} from './knowledge/graph';

export interface LocalRagCitation {
  /** 1-based index matching the [n] marker in the answer. */
  number: number;
  locator: string;
  documentId: string;
  snippet: string;
  score: number;
}

export interface LocalRagAnswer {
  answer: string;
  citations: LocalRagCitation[];
  /** How many chunks were retrieved before context-budget packing. */
  retrieved: number;
  /** How many survived the context budget and were sent to the model. */
  used: number;
  /**
   * RAG-4 — per-claim citation-faithfulness results (present when
   * `verifyCitations` ran). One row per cited claim.
   */
  verification?: CitationVerification[];
  /**
   * RAG-4 — true when verification found at least one cited claim NOT entailed by
   * its source, i.e. the answer is a structured grounding-REFUSAL. The UI must
   * surface this rather than presenting an unsupported answer as grounded.
   */
  grounded?: boolean;
  /**
   * CONTENT-7 — present ONLY when `conceptNeighborhood` retrieval was used. The
   * same citations as {@link citations}, additionally tagged with the graph
   * concept each came from and HOW it relates to the seed (relation + distance),
   * so the UI can render relation-labelled citation chips ("prerequisite",
   * "same concept (L3)", …). The plain {@link citations} array is always present
   * for backward-compatible consumers.
   */
  conceptCitations?: ConceptCitation[];
}

export interface LocalRagOptions {
  question: string;
  domain?: string;
  level?: string;
  topic?: string;
  /** Optional query embedding — enables vector scoring when the driver supports it. */
  embedding?: number[];
  /** Max chunks to retrieve before budget packing. Default 12. */
  limit?: number;
  /** LLM settings override (baseUrl, model, contextWindow). */
  settings?: { baseUrl?: string; model?: string; contextWindow?: number };
  signal?: AbortSignal;
  /** Override the generator (tests). */
  generate?: (input: { prompt: string; system?: string; maxTokens?: number; signal?: AbortSignal }) => Promise<{ text: string }>;
  /**
   * INT-3 — union the user's embedded open-notebook sources into retrieval when
   * the sidecar is available (OPS-5: a no-op when it is disabled/unreachable).
   * Defaults to `true`; pass `false` to force host-curriculum-only retrieval
   * (the historical behaviour). Backward-compatible: existing callers that omit
   * this opt into the union but see identical results whenever no notebook is
   * configured.
   */
  includeNotebookSources?: boolean;
  /**
   * Override the open-notebook source search (tests). Receives the question +
   * resolved base URL; returns chunk-shaped notebook hits. Implies the union is
   * attempted regardless of `notebookSourcesAvailable`, so tests need no sidecar.
   */
  searchNotebook?: (input: { baseUrl: string; query: string; signal?: AbortSignal }) => Promise<NotebookSourceHit[]>;
  /**
   * RAG-2 — activate host HYBRID retrieval. When `true` (and no explicit
   * `embedding` was passed) the question is embedded via the local `/v1/embeddings`
   * endpoint and the vector is fed into `chunks.search` so the driver's dormant
   * vector+BM25 blend lights up. OFFLINE-GRACEFUL: a failed embed call silently
   * falls back to BM25-only. DEFAULT OFF — the vector blend ships ON only where
   * rag-eval shows an nDCG lift on the golden set (see slice report); elsewhere
   * callers opt in. No-op when an `embedding` is already supplied.
   */
  hybrid?: boolean;
  /** Embedder overrides/seam for {@link hybrid} (tests inject `fetchImpl`). */
  embedOptions?: EmbedOptions;
  /**
   * RAG-3 — local-LLM reranker as a 2nd stage. When `true`, retrieval
   * over-retrieves `rerankTopN` (default 24) candidates, the local model
   * pointwise-judges each, and the list is re-sorted before budget packing.
   * DEFAULT OFF — only enable where rag-eval shows an nDCG lift; OFFLINE-GRACEFUL
   * (a candidate the judge can't score keeps its stage-1 rank).
   */
  rerank?: boolean;
  /** Over-retrieve depth for the reranker stage. Default 24. */
  rerankTopN?: number;
  /** Override the reranker's generator (tests). */
  rerankGenerate?: RerankGenerate;
  /**
   * RAG-4 — citation-faithfulness verification. When `true` (the default for
   * {@link localGroundedAnswer}), each cited claim is checked for entailment
   * against its cited chunk(s); unsupported claims trigger a structured
   * grounding-REFUSAL rather than a silent "cite everything" fallback.
   * OFFLINE-GRACEFUL: entailment degrades to the deterministic lexical check.
   */
  verifyCitations?: boolean;
  /** Entailment threshold for {@link verifyCitations}. Default 0.5. */
  entailmentThreshold?: number;
  /** Override the entailment generator (tests). */
  entailGenerate?: EntailmentGenerate;
  /**
   * Use the local-LLM entailment judge (vs the offline lexical fallback) for
   * citation verification. Default `true`; tests/eval set `false` for
   * determinism. Independent of {@link verifyCitations}.
   */
  entailUseLlm?: boolean;
  /**
   * CONTENT-7 — concept-grounded retrieval over the knowledge-graph
   * NEIGHBORHOOD. When supplied, retrieval is widened beyond the seed
   * concept(s) to their PREREQUISITE + SAME-CONCEPT-ACROSS-LEVEL neighbors
   * (computed from the CONTENT-1 graph), and each hit is tagged with HOW it
   * relates to the seed (`self` / `prerequisite` / `dependent` / `same-concept`)
   * so citations can show the relation. DEFAULT OFF / ADDITIVE: when this is
   * omitted, retrieval is byte-for-byte the historical path — the seam only
   * lights up for callers that pass it. OFFLINE-GRACEFUL: a graph/topic with no
   * neighbors degrades to the seed concept alone (i.e. the existing behaviour).
   */
  conceptNeighborhood?: ConceptNeighborhoodOptions;
}

/**
 * CONTENT-7 — configuration for concept-neighborhood retrieval. The graph +
 * seed are supplied by the caller (the page builds the graph from level
 * summaries; tests pass a tiny one), keeping `localRag` free of any host data
 * dependency.
 */
export interface ConceptNeighborhoodOptions {
  /** The CONTENT-1 graph analysis (or the parts the neighborhood walk needs). */
  graph: Pick<KnowledgeGraphAnalysis, 'forward' | 'reverse' | 'edges' | 'nodesById'>;
  /** The seed concept node id to expand around (e.g. `level2:fixed-income`). */
  seedId: string;
  /** How many hops of neighbors to include. Default 1. */
  maxHops?: number;
  /**
   * Per-concept chunk budget — how many top chunks to keep from EACH concept in
   * the neighborhood before the lists are fused. Default 4. Keeps any single
   * concept (especially the seed) from crowding the others out.
   */
  perConceptLimit?: number;
  /**
   * Map a concept node id to the retrieval filter for ITS chunks. The host
   * stores chunks keyed by `topic` (bare id) + `level`; the default reads
   * `node.topicId` / `node.level` off the graph node. Override for custom
   * chunk-tagging schemes.
   */
  conceptFilter?: (node: ConceptNode) => { topic?: string; level?: string; domain?: string };
}

/** A relation-tagged citation for CONTENT-7 concept-grounded answers. */
export interface ConceptCitation extends LocalRagCitation {
  /** Which graph concept this chunk was retrieved under. */
  conceptId: string;
  /** How that concept relates to the seed concept. */
  relation: NeighborhoodEntry['relation'];
  /** Hops from the seed concept (0 = the seed itself). */
  distance: number;
}

const SYSTEM_PROMPT = [
  'You are a CFA tutor answering from the candidate\'s own curriculum.',
  'Use ONLY the provided numbered context excerpts. Do not use outside knowledge.',
  'Cite every claim with the bracket number of the excerpt it came from, like [1] or [2].',
  'If the excerpts do not contain the answer, say so plainly — do not guess.',
  'Keep the answer focused and exam-relevant.',
].join(' ');

function snippetOf(text: string, max = 240): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/** The synthetic domain/documentId tag for notebook-sourced retrieval hits, so
 * the host's citation packing can tell them apart from curriculum chunks. */
export const NOTEBOOK_SOURCE_DOMAIN = 'open-notebook';

/** Map an open-notebook source hit onto the canonical {@link ChunkSearchResult}
 * shape so it can be packed + cited alongside host curriculum chunks. */
function notebookHitToChunk(hit: NotebookSourceHit): ChunkSearchResult {
  return {
    id: hit.id,
    documentId: hit.id,
    domain: NOTEBOOK_SOURCE_DOMAIN,
    text: hit.text,
    locator: hit.locator,
    // The lexical-overlap score is already in [0,1]; expose it on both the
    // unified score and the bm25 channel so mixed sorting stays meaningful.
    score: hit.score,
    bm25Score: hit.score,
  };
}

/**
 * INT-3 — fetch the open-notebook source hits to union into retrieval, guarded
 * for the sidecar being optional (OPS-5). Returns `[]` (never throws) when the
 * union is disabled, no notebook is configured/reachable, or nothing matches —
 * so the caller degrades transparently to host-only retrieval.
 */
async function retrieveNotebookHits(opts: LocalRagOptions): Promise<ChunkSearchResult[]> {
  if (opts.includeNotebookSources === false) return [];
  try {
    const settings = await getOpenNotebookSettings();
    const baseUrl = settings.baseUrl;
    const search =
      opts.searchNotebook ??
      (async (input) => {
        // Only hit the sidecar when it is actually enabled + reachable.
        if (!(await notebookSourcesAvailable(settings))) return [];
        return searchNotebookSources(input);
      });
    const hits = await search({ baseUrl, query: opts.question, signal: opts.signal });
    return hits.map(notebookHitToChunk);
  } catch {
    // Any failure in the optional notebook path must not break host retrieval.
    return [];
  }
}

/**
 * Retrieve relevant chunks for a question through the active storage driver,
 * unioned with the user's embedded open-notebook sources when available (INT-3).
 * Exposed separately so callers (and tests) can inspect retrieval in isolation.
 *
 * The union is deduped by chunk id and re-sorted by score, then truncated to the
 * caller's `limit`, so notebook sources and curriculum chunks compete fairly for
 * the same context budget. When no notebook is configured the result is exactly
 * the historical host-only retrieval.
 */
export async function retrieveChunks(opts: LocalRagOptions): Promise<ChunkSearchResult[]> {
  const storage = getStorage();
  if (!storage.chunks) {
    throw new Error('The active storage driver does not support chunk search.');
  }
  const limit = opts.limit ?? 12;

  // RAG-2 — host HYBRID: when asked AND no explicit embedding was passed, embed
  // the question via the local /v1/embeddings endpoint so the driver's vector +
  // BM25 blend lights up. OFFLINE-GRACEFUL: a null embedding ⇒ BM25-only.
  let queryEmbedding = opts.embedding;
  if (opts.hybrid && (!queryEmbedding || queryEmbedding.length === 0)) {
    const embedded = await embedText(opts.question, { ...opts.embedOptions, signal: opts.signal });
    if (embedded) queryEmbedding = embedded;
  }

  // RAG-3 — when reranking, over-retrieve a wider candidate pool first.
  const candidateLimit = opts.rerank ? Math.max(opts.rerankTopN ?? 24, limit) : limit;

  const [hostChunks, notebookHits] = await Promise.all([
    storage.chunks.search({
      query: opts.question,
      embedding: queryEmbedding,
      domain: opts.domain,
      level: opts.level,
      topic: opts.topic,
      limit: candidateLimit,
    }),
    retrieveNotebookHits(opts),
  ]);

  // RAG-6 — combine host + notebook signals with reciprocal-rank fusion (rank,
  // not raw score, so the two incomparable score scales can't skew the union) +
  // calibrated text-dedup. When there are no notebook hits this is a single-list
  // fusion that preserves the host order exactly, so the historical
  // host-only path is byte-for-byte unchanged.
  let merged: ChunkSearchResult[];
  if (notebookHits.length === 0) {
    merged = hostChunks;
  } else {
    const byId = new Map<string, ChunkSearchResult>();
    for (const hit of notebookHits) byId.set(hit.id, hit);
    for (const chunk of hostChunks) byId.set(chunk.id, chunk);
    const fused = reciprocalRankFusion(
      [
        { items: hostChunks },
        { items: notebookHits },
      ],
      { dedupeByText: true },
    );
    merged = fused.map((row) => byId.get(row.item.id)!).filter(Boolean);
  }

  // RAG-3 — pointwise local-LLM rerank of the candidate pool, then truncate.
  if (opts.rerank && merged.length > 0) {
    const reranked = await rerankCandidates(
      opts.question,
      merged.map((c) => ({ id: c.id, text: c.text || '', score: c.score })),
      { generate: opts.rerankGenerate, limit, settings: opts.settings, signal: opts.signal },
    );
    const byId = new Map(merged.map((c) => [c.id, c]));
    return reranked.map((r) => byId.get(r.id)!).filter(Boolean);
  }

  return merged.slice(0, limit);
}

/** A retrieved chunk tagged with the concept it came from + its relation (CONTENT-7). */
export interface ConceptTaggedChunk extends ChunkSearchResult {
  conceptId: string;
  relation: NeighborhoodEntry['relation'];
  distance: number;
}

/** Default concept→retrieval-filter: read the graph node's topic/level. */
function defaultConceptFilter(node: ConceptNode): { topic?: string; level?: string } {
  return {
    ...(node.topicId ? { topic: node.topicId } : {}),
    ...(node.level ? { level: node.level } : {}),
  };
}

/**
 * CONTENT-7 — retrieve chunks across the knowledge-graph NEIGHBORHOOD of a seed
 * concept (prerequisite + same-concept-across-level), tagging each hit with the
 * concept it came from and HOW that concept relates to the seed.
 *
 * Per-concept retrieval reuses the EXISTING {@link retrieveChunks} path (so the
 * notebook union / hybrid / rerank knobs all carry through), then the per-concept
 * lists are fused with reciprocal-rank fusion. The SEED concept's list is
 * weighted highest and prerequisites above dependents, so the most relevant
 * grounding still leads while conceptually-adjacent context fills in behind it.
 *
 * ADDITIVE + OFFLINE-GRACEFUL: this is a NEW function — it never changes
 * `retrieveChunks`. A seed with no neighbors degrades to retrieving the seed
 * concept alone, i.e. the historical single-concept result.
 */
export async function retrieveConceptNeighborhood(
  opts: LocalRagOptions & { conceptNeighborhood: ConceptNeighborhoodOptions },
): Promise<ConceptTaggedChunk[]> {
  const cfg = opts.conceptNeighborhood;
  const limit = opts.limit ?? 12;
  const perConceptLimit = cfg.perConceptLimit ?? 4;
  const filterFor = cfg.conceptFilter ?? defaultConceptFilter;
  const neighborhood = conceptNeighborhood(cfg.graph, cfg.seedId, cfg.maxHops ?? 1);
  // If the seed isn't in the graph, fall back to the seed concept alone using
  // the caller-supplied domain/level/topic so we never return empty here.
  const entries: NeighborhoodEntry[] = neighborhood.length
    ? neighborhood
    : [{ id: cfg.seedId, relation: 'self', distance: 0 }];

  // Relation → fusion weight: seed leads, prerequisites (foundations) next, then
  // dependents, then same-concept siblings.
  const relationWeight = (relation: NeighborhoodEntry['relation']): number => {
    switch (relation) {
      case 'self':
        return 4;
      case 'prerequisite':
        return 3;
      case 'dependent':
        return 2;
      case 'same-concept':
      default:
        return 1.5;
    }
  };

  const perConceptResults = await Promise.all(
    entries.map(async (entry) => {
      const node = cfg.graph.nodesById.get(entry.id);
      const filter: { topic?: string; level?: string; domain?: string } = node ? filterFor(node) : {};
      // Reuse the EXISTING retrieval path per concept; pass-through the caller's
      // retrieval knobs (hybrid/rerank/notebook) but scope topic/level/domain to
      // this concept. The seed concept keeps the caller's explicit topic/level if
      // it had none on the node.
      const conceptOpts: LocalRagOptions = {
        ...opts,
        // Don't recurse into the neighborhood inside the per-concept retrieve.
        conceptNeighborhood: undefined,
        limit: perConceptLimit,
        domain: filter.domain ?? opts.domain,
        topic: filter.topic ?? (entry.relation === 'self' ? opts.topic : undefined),
        level: filter.level ?? (entry.relation === 'self' ? opts.level : undefined),
      };
      const chunks = await retrieveChunks(conceptOpts);
      return { entry, chunks };
    }),
  );

  // Tag each chunk with its concept + relation, keeping the BEST (nearest /
  // strongest-relation) tag when the same chunk surfaces under multiple concepts.
  const tagged = new Map<string, ConceptTaggedChunk>();
  for (const { entry, chunks } of perConceptResults) {
    for (const chunk of chunks) {
      const existing = tagged.get(chunk.id);
      if (
        !existing ||
        entry.distance < existing.distance ||
        (entry.distance === existing.distance && relationWeight(entry.relation) > relationWeight(existing.relation))
      ) {
        tagged.set(chunk.id, {
          ...chunk,
          conceptId: entry.id,
          relation: entry.relation,
          distance: entry.distance,
        });
      }
    }
  }

  // Fuse the per-concept ranked lists (rank-based, so incomparable per-concept
  // score scales can't skew it), weighting by relation. Then map back to the
  // tagged chunks and truncate to the overall limit.
  const fused = reciprocalRankFusion(
    perConceptResults.map(({ entry, chunks }) => ({
      items: chunks.map((c) => ({ id: c.id, text: c.text })),
      weight: relationWeight(entry.relation),
    })),
    { dedupeByText: true, limit },
  );
  return fused.map((row) => tagged.get(row.item.id)!).filter(Boolean);
}

/** One verified claim from the citation-faithfulness pass (RAG-4). */
export interface CitationVerification {
  /** The citation [n] number the claim referenced. */
  number: number;
  /** The sentence/claim text checked. */
  claim: string;
  /** Whether the cited chunk(s) entail the claim. */
  entailed: boolean;
  /** Entailment support score in [0,1]. */
  score: number;
}

/** Split an answer into claim-sized sentences carrying their [n] markers. */
function splitClaims(answer: string): Array<{ text: string; citations: number[] }> {
  const sentences = (answer || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return sentences.map((text) => {
    const citations: number[] = [];
    for (const m of text.matchAll(/\[(\d+)\]/g)) {
      const n = Number(m[1]);
      if (n >= 1) citations.push(n);
    }
    return { text, citations };
  });
}

/**
 * RAG-4 — verify that each CITED claim in `answer` is actually entailed by the
 * chunk(s) it cites, using the SHARED GAP-ENTAIL-1 entailment primitive. Returns
 * one row per claim that carried a citation. OFFLINE-GRACEFUL via `entail`.
 *
 * Only claims that carry a `[n]` marker are checked — an uncited sentence makes
 * no grounding promise, so verifying it would be checking nothing in particular.
 */
export async function verifyAnswerCitations(
  answer: string,
  numbered: Array<{ chunk: ChunkSearchResult; number: number }>,
  opts: { threshold?: number; useLlm?: boolean; generate?: EntailmentGenerate; settings?: LocalRagOptions['settings']; signal?: AbortSignal } = {},
): Promise<CitationVerification[]> {
  const byNumber = new Map(numbered.map((e) => [e.number, e.chunk]));
  const claims = splitClaims(answer).filter((c) => c.citations.length > 0);
  const results: CitationVerification[] = [];
  for (const claim of claims) {
    const evidence = claim.citations
      .map((n) => byNumber.get(n)?.text || '')
      .filter(Boolean)
      .join('\n\n');
    const { entailed, score } = await entail(claim.text, evidence, {
      threshold: opts.threshold,
      useLlm: opts.useLlm,
      generate: opts.generate,
      settings: opts.settings,
      signal: opts.signal,
    });
    results.push({ number: claim.citations[0], claim: claim.text, entailed, score });
  }
  return results;
}

/**
 * Produce a local, grounded answer to `question` using retrieved curriculum
 * chunks + the local LLM.  No open-notebook sidecar required.
 */
export async function localGroundedAnswer(opts: LocalRagOptions): Promise<LocalRagAnswer> {
  // CONTENT-7 — when a concept neighborhood is configured, retrieve across the
  // knowledge-graph neighborhood (relation-tagged); otherwise use the historical
  // single-concept path UNCHANGED. The tagged chunks are a superset of
  // ChunkSearchResult, so all downstream packing/citation logic is identical.
  const usingConceptGraph = Boolean(opts.conceptNeighborhood);
  const retrievedChunks = usingConceptGraph
    ? await retrieveConceptNeighborhood(
        opts as LocalRagOptions & { conceptNeighborhood: ConceptNeighborhoodOptions },
      )
    : await retrieveChunks(opts);
  if (retrievedChunks.length === 0) {
    throw new Error(
      'No curriculum chunks matched this question. Ingest the relevant volume (System Health → Desktop Shell) or broaden the question.',
    );
  }

  // Budget the context: reserve ~70% of the grounding budget for chunk text.
  const budget = pickBudget({ modelName: opts.settings?.model, contextWindow: opts.settings?.contextWindow });
  const groundingTokens = Math.max(512, Math.floor(budget.forUserAndGrounding * 0.7));
  const packed = packExcerpts(retrievedChunks, groundingTokens, (c) => c.text || '');

  // Build numbered context. The packed order IS the citation order.
  const numbered = packed.kept.map((chunk, i) => ({ chunk, number: i + 1 }));
  const contextBlock = renderExcerpts(
    numbered,
    (entry) => `${entry.number}`,
    (entry) => entry.chunk.text,
  );

  const userPrompt = [
    `Question: ${opts.question}`,
    '',
    'Numbered context excerpts:',
    contextBlock,
    '',
    'Answer the question using only these excerpts, citing each claim with its bracket number.',
  ].join('\n');

  const generate = opts.generate ?? generateText;
  const { text } = await generate({
    prompt: userPrompt,
    system: SYSTEM_PROMPT,
    maxTokens: 800,
    signal: opts.signal,
  });

  const answer = (text || '').trim();

  // Only surface citations actually referenced in the answer ([n] markers),
  // falling back to all-used if the model emitted no markers at all.
  const referenced = new Set<number>();
  for (const match of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(match[1]);
    if (n >= 1 && n <= numbered.length) referenced.add(n);
  }
  const citationSource = referenced.size > 0 ? numbered.filter((e) => referenced.has(e.number)) : numbered;

  const citations: LocalRagCitation[] = citationSource.map((entry) => ({
    number: entry.number,
    locator: entry.chunk.locator,
    documentId: entry.chunk.documentId,
    snippet: snippetOf(entry.chunk.text),
    score: entry.chunk.score,
  }));

  // CONTENT-7 — when concept-graph retrieval was used, the kept chunks carry
  // their concept + relation tags; surface them as relation-tagged citations
  // alongside the plain list. (Plain `citations` stays for old consumers.)
  const conceptCitations: ConceptCitation[] | undefined = usingConceptGraph
    ? citationSource.map((entry) => {
        const tagged = entry.chunk as Partial<ConceptTaggedChunk>;
        return {
          number: entry.number,
          locator: entry.chunk.locator,
          documentId: entry.chunk.documentId,
          snippet: snippetOf(entry.chunk.text),
          score: entry.chunk.score,
          conceptId: tagged.conceptId ?? opts.conceptNeighborhood!.seedId,
          relation: tagged.relation ?? 'self',
          distance: tagged.distance ?? 0,
        };
      })
    : undefined;

  // RAG-4 — citation-faithfulness verification (ON by default here). Each cited
  // claim must be entailed by the chunk(s) it cites; if any cited claim is NOT
  // supported we flag the answer as a grounding-REFUSAL (`grounded:false`) so the
  // UI can refuse to present it as grounded — no silent "cite everything"
  // fallback. OFFLINE-GRACEFUL: `entail` degrades to the lexical check, and the
  // whole pass is best-effort (a verifier failure never breaks the answer).
  let verification: CitationVerification[] | undefined;
  let grounded: boolean | undefined;
  if (opts.verifyCitations !== false) {
    try {
      verification = await verifyAnswerCitations(answer, numbered, {
        threshold: opts.entailmentThreshold,
        useLlm: opts.entailUseLlm,
        // Default the entailment generator to the SAME generator the answer used,
        // so an injected (test/real) generator is reused for verification and we
        // never silently reach for the global `generateText` (network) behind the
        // caller's back. An explicit `entailGenerate` still wins.
        generate: opts.entailGenerate ?? (opts.generate as EntailmentGenerate | undefined),
        settings: opts.settings,
        signal: opts.signal,
      });
      // Only assert (un)groundedness when there was something cited to check.
      grounded = verification.length === 0 ? true : verification.every((v) => v.entailed);
    } catch {
      // Verification is additive — a failure leaves the answer unverified rather
      // than blocking it. `grounded` stays undefined ("not checked").
      verification = undefined;
      grounded = undefined;
    }
  }

  return {
    answer,
    citations,
    retrieved: retrievedChunks.length,
    used: packed.kept.length,
    ...(verification !== undefined ? { verification } : {}),
    ...(grounded !== undefined ? { grounded } : {}),
    ...(conceptCitations !== undefined ? { conceptCitations } : {}),
  };
}
