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
  const [hostChunks, notebookHits] = await Promise.all([
    storage.chunks.search({
      query: opts.question,
      embedding: opts.embedding,
      domain: opts.domain,
      level: opts.level,
      topic: opts.topic,
      limit,
    }),
    retrieveNotebookHits(opts),
  ]);

  if (notebookHits.length === 0) return hostChunks;

  // Union + dedupe by id (host chunks win on collision), then re-rank by score.
  const byId = new Map<string, ChunkSearchResult>();
  for (const hit of notebookHits) byId.set(hit.id, hit);
  for (const chunk of hostChunks) byId.set(chunk.id, chunk);
  return Array.from(byId.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Produce a local, grounded answer to `question` using retrieved curriculum
 * chunks + the local LLM.  No open-notebook sidecar required.
 */
export async function localGroundedAnswer(opts: LocalRagOptions): Promise<LocalRagAnswer> {
  const retrievedChunks = await retrieveChunks(opts);
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

  return {
    answer,
    citations,
    retrieved: retrievedChunks.length,
    used: packed.kept.length,
  };
}
