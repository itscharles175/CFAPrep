import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localGroundedAnswer, retrieveChunks } from './localRag';
import { db } from './progressStore';
import { getStorage } from './storage';
import type { SourceChunkInput } from './storage/types';

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
