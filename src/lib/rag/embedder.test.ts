import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '../progressStore';
import { embedText, embedTexts, backfillChunkEmbeddings } from './embedder';
import type { SourceChunkInput } from '../storage/types';

/** A fake `/v1/embeddings` fetch that returns one deterministic vector per input. */
function fakeEmbedFetch(vectorFor: (text: string) => number[]) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const inputs: string[] = body.input;
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: inputs.map((t, index) => ({ index, embedding: vectorFor(t) })) }),
    };
  });
}

describe('RAG-2 — embedder (offline-graceful)', () => {
  it('embedTexts returns one vector per input in order', async () => {
    const fetchImpl = fakeEmbedFetch((t) => [t.length, 1, 0]);
    const out = await embedTexts(['aa', 'bbb'], { settings: { baseUrl: 'http://localhost:1234/v1' }, fetchImpl });
    expect(out).toEqual([[2, 1, 0], [3, 1, 0]]);
  });

  it('embedText returns a single vector', async () => {
    const fetchImpl = fakeEmbedFetch(() => [0.1, 0.2, 0.3]);
    const vec = await embedText('hello', { settings: { baseUrl: 'http://localhost:1234/v1' }, fetchImpl });
    expect(vec).toEqual([0.1, 0.2, 0.3]);
  });

  it('returns null (never throws) when the server is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const vec = await embedText('q', { settings: { baseUrl: 'http://localhost:1234/v1' }, fetchImpl });
    expect(vec).toBeNull();
  });

  it('returns null on a non-OK response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const out = await embedTexts(['x'], { settings: { baseUrl: 'http://localhost:1234/v1' }, fetchImpl });
    expect(out).toBeNull();
  });

  it('returns null on a partial/garbled response (missing slots)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ index: 0, embedding: [1] }] }) }));
    const out = await embedTexts(['a', 'b'], { settings: { baseUrl: 'http://localhost:1234/v1' }, fetchImpl });
    expect(out).toBeNull();
  });

  it('empty input is a trivial empty result (no fetch)', async () => {
    const fetchImpl = vi.fn();
    expect(await embedTexts([], { fetchImpl })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('RAG-2 — backfill (idempotent, resumable, offline-graceful)', () => {
  beforeEach(async () => {
    await db.sourceChunks.clear();
  });

  function seed(): SourceChunkInput[] {
    return [
      { id: 'b1', documentId: 'd', domain: 'cfa', text: 'duration measures sensitivity', locator: 'r1' },
      { id: 'b2', documentId: 'd', domain: 'cfa', text: 'convexity captures curvature', locator: 'r2' },
      { id: 'b3', documentId: 'd', domain: 'cfa', text: 'already embedded', locator: 'r3', embedding: [9, 9] },
    ];
  }

  it('embeds only the not-yet-embedded chunks and writes them back', async () => {
    const rows = seed();
    await db.sourceChunks.bulkPut(rows as never);
    const fetchImpl = fakeEmbedFetch((t) => [t.length]);

    const report = await backfillChunkEmbeddings({
      loadChunks: async () => rows,
      settings: { baseUrl: 'http://localhost:1234/v1' },
      fetchImpl,
    });

    expect(report.offline).toBe(false);
    expect(report.pending).toBe(2); // b1, b2 (b3 already embedded)
    expect(report.embedded).toBe(2);
    const b1 = (await db.sourceChunks.get('b1')) as unknown as SourceChunkInput;
    expect(Array.isArray(b1.embedding)).toBe(true);
    // b3's pre-existing embedding is untouched.
    const b3 = (await db.sourceChunks.get('b3')) as unknown as SourceChunkInput;
    expect(b3.embedding).toEqual([9, 9]);
  });

  it('is idempotent — a 2nd pass embeds nothing once all rows have vectors', async () => {
    const rows = seed();
    await db.sourceChunks.bulkPut(rows as never);
    const fetchImpl = fakeEmbedFetch((t) => [t.length]);
    await backfillChunkEmbeddings({ loadChunks: async () => rows, settings: { baseUrl: 'http://localhost:1234/v1' }, fetchImpl });
    // Re-load from the driver (now embedded) for the 2nd pass.
    const reloaded = (await db.sourceChunks.toArray()) as unknown as SourceChunkInput[];
    const second = await backfillChunkEmbeddings({ loadChunks: async () => reloaded, settings: { baseUrl: 'http://localhost:1234/v1' }, fetchImpl });
    expect(second.pending).toBe(0);
    expect(second.embedded).toBe(0);
  });

  it('degrades gracefully when the embedder is offline (no writes, offline:true)', async () => {
    const rows = seed();
    await db.sourceChunks.bulkPut(rows as never);
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const report = await backfillChunkEmbeddings({ loadChunks: async () => rows, settings: { baseUrl: 'http://localhost:1234/v1' }, fetchImpl });
    expect(report.offline).toBe(true);
    expect(report.embedded).toBe(0);
    const b1 = (await db.sourceChunks.get('b1')) as unknown as SourceChunkInput;
    expect(b1.embedding).toBeUndefined();
  });

  it('respects the domain filter', async () => {
    const rows: SourceChunkInput[] = [
      { id: 'x1', documentId: 'd', domain: 'cfa', text: 'cfa text', locator: 'r1' },
      { id: 'x2', documentId: 'd', domain: 'excel', text: 'excel text', locator: 'r2' },
    ];
    await db.sourceChunks.bulkPut(rows as never);
    const fetchImpl = fakeEmbedFetch(() => [1]);
    const report = await backfillChunkEmbeddings({ loadChunks: async () => rows, domain: 'cfa', settings: { baseUrl: 'http://localhost:1234/v1' }, fetchImpl });
    expect(report.pending).toBe(1);
    expect(report.embedded).toBe(1);
  });
});
