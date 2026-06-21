import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localGroundedAnswer, retrieveChunks, verifyAnswerCitations } from './localRag';
import { db } from './progressStore';
import { getStorage } from './storage';
import type { SourceChunkInput, ChunkSearchResult } from './storage/types';

function chunk(id: string, text: string, extra: Partial<SourceChunkInput> = {}): SourceChunkInput {
  return {
    id,
    documentId: 'doc-1',
    domain: 'cfa',
    level: 'level1',
    topic: 'quant',
    text,
    locator: `p. ${id}`,
    ...extra,
  };
}

beforeEach(async () => {
  await db.sourceChunks.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('retrieveChunks', () => {
  it('returns chunks matching the query through the active driver', async () => {
    await getStorage().chunks!.bulkUpsert([
      chunk('1', 'Duration measures a bond price sensitivity to yield changes.'),
      chunk('2', 'The dividend discount model values equity from future dividends.'),
      chunk('3', 'Convexity is the second-order measure of duration.'),
    ]);
    const hits = await retrieveChunks({ question: 'what is duration', domain: 'cfa' });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].text.toLowerCase()).toContain('duration');
  });

  it('returns host-only chunks unchanged when notebook union is disabled', async () => {
    await getStorage().chunks!.bulkUpsert([
      chunk('1', 'Duration measures a bond price sensitivity to yield changes.'),
    ]);
    const searchNotebook = vi.fn();
    const hits = await retrieveChunks({
      question: 'duration',
      domain: 'cfa',
      includeNotebookSources: false,
      searchNotebook,
    });
    expect(hits.map((h) => h.id)).toEqual(['1']);
    expect(searchNotebook).not.toHaveBeenCalled();
  });

  it('unions open-notebook source hits with host chunks via the injected search', async () => {
    await getStorage().chunks!.bulkUpsert([
      chunk('1', 'Duration measures bond price sensitivity to yield.'),
    ]);
    const searchNotebook = vi.fn(async () => [
      { id: 'source:nb', title: 'My duration notes', text: 'notebook duration excerpt', locator: 'My duration notes', score: 0.9 },
    ]);
    const hits = await retrieveChunks({ question: 'duration', domain: 'cfa', searchNotebook });
    expect(searchNotebook).toHaveBeenCalledTimes(1);
    // The higher-scored notebook hit ranks first; both sources are present.
    expect(hits.map((h) => h.id)).toContain('source:nb');
    expect(hits.map((h) => h.id)).toContain('1');
    const nb = hits.find((h) => h.id === 'source:nb');
    expect(nb?.domain).toBe('open-notebook');
  });

  it('degrades to host-only when the notebook search throws', async () => {
    await getStorage().chunks!.bulkUpsert([
      chunk('1', 'Duration measures bond price sensitivity to yield.'),
    ]);
    const searchNotebook = vi.fn(async () => {
      throw new Error('sidecar down');
    });
    const hits = await retrieveChunks({ question: 'duration', domain: 'cfa', searchNotebook });
    expect(hits.map((h) => h.id)).toEqual(['1']);
  });
});

describe('localGroundedAnswer', () => {
  it('grounds the answer in retrieved chunks and returns citations', async () => {
    await getStorage().chunks!.bulkUpsert([
      chunk('1', 'Duration measures a bond price sensitivity to yield changes.'),
      chunk('2', 'Convexity is the second-order measure of duration that corrects the linear estimate.'),
    ]);

    const generate = vi.fn(async () => ({
      text: 'Duration measures price sensitivity to yield [1], and convexity corrects it [2].',
    }));

    const result = await localGroundedAnswer({
      question: 'Explain duration and convexity',
      domain: 'cfa',
      generate,
    });

    expect(result.answer).toContain('Duration');
    expect(result.citations).toHaveLength(2);
    // Citations are in retrieval-score order; numbers are 1..N.
    expect(result.citations.map((c) => c.number)).toEqual([1, 2]);
    // Both source locators are present (order depends on BM25 ranking).
    expect(result.citations.map((c) => c.locator).sort()).toEqual(['p. 1', 'p. 2']);
    expect(result.retrieved).toBeGreaterThanOrEqual(2);
    expect(result.used).toBeGreaterThanOrEqual(2);

    // The prompt should carry the numbered context.
    const calls = generate.mock.calls as unknown as Array<[{ prompt: string; system?: string }]>;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const call = calls[0][0];
    expect(call.prompt).toContain('[1]');
    expect(call.system).toContain('ONLY');
  });

  it('only surfaces citations actually referenced in the answer', async () => {
    await getStorage().chunks!.bulkUpsert([
      chunk('1', 'Duration measures bond price sensitivity to yield.'),
      chunk('2', 'Convexity corrects the duration estimate for large moves.'),
      chunk('3', 'Spread duration measures sensitivity to credit spread changes.'),
    ]);

    const generate = vi.fn(async () => ({
      text: 'Duration is about yield sensitivity [1].',
    }));

    const result = await localGroundedAnswer({
      question: 'what is duration',
      domain: 'cfa',
      generate,
    });

    // Only [1] is referenced — citations should narrow to it.
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].number).toBe(1);
  });

  it('falls back to all used chunks when the answer has no [n] markers', async () => {
    await getStorage().chunks!.bulkUpsert([
      chunk('1', 'Duration measures bond price sensitivity.'),
      chunk('2', 'Convexity corrects the estimate.'),
    ]);
    const generate = vi.fn(async () => ({ text: 'A plain answer with no citation markers.' }));
    const result = await localGroundedAnswer({ question: 'duration', domain: 'cfa', generate });
    expect(result.citations.length).toBeGreaterThanOrEqual(1);
  });

  it('throws a clear error when nothing matches', async () => {
    // Empty store → no chunks.
    const generate = vi.fn();
    await expect(
      localGroundedAnswer({ question: 'anything', domain: 'cfa', generate }),
    ).rejects.toThrow(/No curriculum chunks/i);
    expect(generate).not.toHaveBeenCalled();
  });

  it('respects domain/topic filters in retrieval', async () => {
    await getStorage().chunks!.bulkUpsert([
      chunk('1', 'Quant content about duration.', { topic: 'quant' }),
      chunk('2', 'Ethics content about standards.', { topic: 'ethics' }),
    ]);
    const generate = vi.fn(async () => ({ text: 'Answer [1].' }));
    const result = await localGroundedAnswer({
      question: 'duration',
      domain: 'cfa',
      topic: 'quant',
      generate,
    });
    // Only the quant chunk should be a candidate.
    expect(result.citations.every((c) => c.locator === 'p. 1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Wave 5 — RAG-2 (hybrid), RAG-3 (rerank), RAG-4 (citation verifier)
// ---------------------------------------------------------------------------
describe('Wave 5 retrieval flags + grounding (RAG-2/3/4)', () => {
  beforeEach(async () => {
    await db.sourceChunks.clear();
    await getStorage().chunks!.bulkUpsert([
      chunk('c1', 'Modified duration measures bond price sensitivity to small parallel yield changes.'),
      chunk('c2', 'Convexity captures the curvature of the price-yield relationship.'),
      chunk('c3', 'Effective duration is used for bonds with embedded options.'),
    ]);
  });

  it('RAG-2 hybrid: degrades to BM25 when the embedder is offline (never throws)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const hits = await retrieveChunks({
      question: 'modified duration',
      domain: 'cfa',
      includeNotebookSources: false,
      hybrid: true,
      embedOptions: { fetchImpl, settings: { baseUrl: 'http://localhost:1234/v1' } },
    });
    expect(hits[0].id).toBe('c1');
  });

  it('RAG-3 rerank: re-orders the pool via the local judge', async () => {
    const rerankGenerate = vi.fn(async ({ prompt }: { prompt: string }) =>
      ({ text: prompt.includes('Convexity') ? '99' : '1' }),
    );
    const hits = await retrieveChunks({
      question: 'duration',
      domain: 'cfa',
      includeNotebookSources: false,
      rerank: true,
      rerankGenerate,
      limit: 3,
    });
    expect(hits[0].id).toBe('c2');
  });

  it('RAG-4: grounded:true when the cited claim is entailed (lexical, offline)', async () => {
    const generate = vi.fn(async () => ({
      text: 'Modified duration measures bond price sensitivity to yield changes [1].',
    }));
    const res = await localGroundedAnswer({
      question: 'What does modified duration measure?',
      domain: 'cfa',
      includeNotebookSources: false,
      generate,
      entailUseLlm: false,
    });
    expect(res.verification).toBeDefined();
    expect(res.grounded).toBe(true);
  });

  it('RAG-4: grounded:false (structured refusal) when a cited claim is unsupported', async () => {
    const generate = vi.fn(async () => ({
      text: 'XLOOKUP returns a matching value from a result array in Excel spreadsheets [1].',
    }));
    const res = await localGroundedAnswer({
      question: 'Tell me about duration',
      domain: 'cfa',
      includeNotebookSources: false,
      generate,
      entailUseLlm: false,
    });
    expect(res.grounded).toBe(false);
    expect(res.verification!.some((v) => !v.entailed)).toBe(true);
  });

  it('RAG-4: verifyCitations:false skips verification', async () => {
    const generate = vi.fn(async () => ({ text: 'Answer [1].' }));
    const res = await localGroundedAnswer({
      question: 'q',
      domain: 'cfa',
      includeNotebookSources: false,
      generate,
      verifyCitations: false,
    });
    expect(res.verification).toBeUndefined();
    expect(res.grounded).toBeUndefined();
  });
});

describe('verifyAnswerCitations (RAG-4 unit)', () => {
  const numbered: Array<{ chunk: ChunkSearchResult; number: number }> = [
    {
      number: 1,
      chunk: {
        id: 'c1',
        documentId: 'd',
        domain: 'cfa',
        text: 'Convexity captures the curvature of the price-yield relationship.',
        locator: 'r1',
        score: 1,
      },
    },
  ];

  it('only verifies CITED claims', async () => {
    const results = await verifyAnswerCitations(
      'Convexity captures curvature [1]. This sentence has no citation.',
      numbered,
      { useLlm: false },
    );
    expect(results).toHaveLength(1);
    expect(results[0].entailed).toBe(true);
  });

  it('marks an unsupported cited claim as not entailed', async () => {
    const results = await verifyAnswerCitations(
      'XLOOKUP returns a matching value from a result array [1].',
      numbered,
      { useLlm: false },
    );
    expect(results[0].entailed).toBe(false);
  });
});
