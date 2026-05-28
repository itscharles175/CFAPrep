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
 * Flow:
 *   1. Retrieve top-K chunks for the question (filtered by domain/level/topic).
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

/**
 * Retrieve relevant chunks for a question through the active storage driver.
 * Exposed separately so callers (and tests) can inspect retrieval in isolation.
 */
export async function retrieveChunks(opts: LocalRagOptions): Promise<ChunkSearchResult[]> {
  const storage = getStorage();
  if (!storage.chunks) {
    throw new Error('The active storage driver does not support chunk search.');
  }
  return storage.chunks.search({
    query: opts.question,
    embedding: opts.embedding,
    domain: opts.domain,
    level: opts.level,
    topic: opts.topic,
    limit: opts.limit ?? 12,
  });
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
