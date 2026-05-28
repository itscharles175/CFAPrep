import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../progressStore';
import { dexieDriver } from './dexieDriver';
import type { SourceChunkInput } from './types';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
// A grab-bag of curriculum-shaped chunks covering "duration", "convexity",
// and unrelated topics so we can assert lexical and filter behaviour.
function makeChunks(): SourceChunkInput[] {
  return [
    {
      id: 'c1',
      documentId: 'doc-a',
      domain: 'cfa',
      level: 'level2',
      topic: 'fixed-income',
      text: 'Modified duration measures price sensitivity to small parallel yield changes.',
      locator: 'reading-12 §1.2',
      page: 4,
    },
    {
      id: 'c2',
      documentId: 'doc-a',
      domain: 'cfa',
      level: 'level2',
      topic: 'fixed-income',
      text: 'Effective duration accounts for embedded options in bond pricing.',
      locator: 'reading-12 §1.3',
      page: 5,
    },
    {
      id: 'c3',
      documentId: 'doc-a',
      domain: 'cfa',
      level: 'level2',
      topic: 'fixed-income',
      text: 'Convexity captures the curvature of the price-yield relationship.',
      locator: 'reading-12 §1.4',
      page: 6,
    },
    {
      id: 'c4',
      documentId: 'doc-b',
      domain: 'cfa',
      level: 'level1',
      topic: 'equity',
      text: 'Dividend discount models value equities by present value of future dividends.',
      locator: 'reading-30 §2.1',
      page: 18,
    },
    {
      id: 'c5',
      documentId: 'doc-b',
      domain: 'cfa',
      level: 'level1',
      topic: 'equity',
      text: 'Free cash flow to equity uses unlevered cash flows in valuation.',
      locator: 'reading-30 §2.2',
      page: 19,
    },
    {
      id: 'c6',
      documentId: 'doc-c',
      domain: 'excel',
      topic: 'lookup',
      text: 'XLOOKUP supersedes VLOOKUP with bidirectional matching and array returns.',
      locator: 'mod-3 §3.1',
      page: 7,
    },
    {
      id: 'c7',
      documentId: 'doc-c',
      domain: 'excel',
      topic: 'lookup',
      text: 'INDEX MATCH remains useful when XLOOKUP is unavailable in older Excel builds.',
      locator: 'mod-3 §3.2',
      page: 8,
    },
    {
      id: 'c8',
      documentId: 'doc-d',
      domain: 'quant',
      topic: 'stats',
      text: 'A confidence interval expresses uncertainty in a point estimate.',
      locator: 'qm §4.1',
      page: 3,
    },
    {
      id: 'c9',
      documentId: 'doc-d',
      domain: 'quant',
      topic: 'stats',
      text: 'Bayesian inference updates priors with observed likelihoods.',
      locator: 'qm §4.2',
      page: 4,
    },
    {
      id: 'c10',
      documentId: 'doc-d',
      domain: 'quant',
      topic: 'stats',
      text: 'Standard error scales with the square root of the sample size.',
      locator: 'qm §4.3',
      page: 5,
    },
  ];
}

// ---------------------------------------------------------------------------
// Dexie driver — chunk search
// ---------------------------------------------------------------------------
describe('dexieDriver.chunks', () => {
  beforeEach(async () => {
    await db.sourceChunks.clear();
  });

  it('bulkUpsert inserts every chunk and search returns the duration hit', async () => {
    const chunks = makeChunks();
    await dexieDriver.chunks!.bulkUpsert(chunks);

    expect(await db.sourceChunks.count()).toBe(chunks.length);

    const hits = await dexieDriver.chunks!.search({ query: 'duration' });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    // The top hit must contain "duration".
    expect(hits[0].text.toLowerCase()).toContain('duration');
    expect(hits[0].score).toBeGreaterThan(0);
    expect(typeof hits[0].bm25Score).toBe('number');
    // No embedding query → vectorScore stays undefined.
    expect(hits[0].vectorScore).toBeUndefined();
  });

  it('domain filter narrows results to a single domain', async () => {
    await dexieDriver.chunks!.bulkUpsert(makeChunks());
    const hits = await dexieDriver.chunks!.search({ query: 'lookup', domain: 'excel' });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(hit.domain).toBe('excel');
  });

  it('vector-only fallback ranks by embedding cosine when no query text is provided', async () => {
    // 3 chunks, each with a tiny embedding vector aligned with one axis.
    const e1 = [1, 0, 0];
    const e2 = [0, 1, 0];
    const e3 = [0, 0, 1];
    await dexieDriver.chunks!.bulkUpsert([
      { id: 've1', documentId: 'd1', domain: 'cfa', text: 'first', locator: 'x', embedding: e1 },
      { id: 've2', documentId: 'd1', domain: 'cfa', text: 'second', locator: 'y', embedding: e2 },
      { id: 've3', documentId: 'd1', domain: 'cfa', text: 'third', locator: 'z', embedding: e3 },
    ]);

    const hits = await dexieDriver.chunks!.search({ query: '', embedding: e2 });
    expect(hits.length).toBeGreaterThan(0);
    // The chunk whose embedding aligns with $e2 must rank first.
    expect(hits[0].id).toBe('ve2');
    expect(hits[0].vectorScore).toBeDefined();
    expect(hits[0].bm25Score).toBeUndefined();
  });

  it('hybrid scoring blends bm25 and cosine when both signals are available', async () => {
    // Two chunks: one matches lexically but is orthogonal in vector space;
    // the other matches the embedding well but lexically is weaker.
    await dexieDriver.chunks!.bulkUpsert([
      {
        id: 'hy1',
        documentId: 'd1',
        domain: 'cfa',
        text: 'Duration duration duration duration duration of bonds.',
        locator: 'x',
        embedding: [0, 1, 0],
      },
      {
        id: 'hy2',
        documentId: 'd1',
        domain: 'cfa',
        text: 'Duration of yields.',
        locator: 'y',
        embedding: [1, 0, 0],
      },
    ]);

    const hits = await dexieDriver.chunks!.search({ query: 'duration', embedding: [1, 0, 0] });
    expect(hits.length).toBe(2);
    for (const h of hits) {
      expect(h.score).toBeGreaterThan(0);
      expect(typeof h.bm25Score).toBe('number');
      expect(typeof h.vectorScore).toBe('number');
      // Score is the 60/40 blend — strictly between the two component scores
      // (or equal to them when they coincide).
      const blend = 0.6 * h.vectorScore! + 0.4 * h.bm25Score!;
      expect(Math.abs(h.score - blend)).toBeLessThan(1e-9);
    }
  });

  it('deleteByDocument removes every chunk tied to that documentId', async () => {
    await dexieDriver.chunks!.bulkUpsert(makeChunks());
    expect(await db.sourceChunks.where('documentId').equals('doc-a').count()).toBe(3);

    await dexieDriver.chunks!.deleteByDocument('doc-a');
    expect(await db.sourceChunks.where('documentId').equals('doc-a').count()).toBe(0);
    // Other docs untouched.
    expect(await db.sourceChunks.where('documentId').equals('doc-b').count()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// SurrealDB driver — chunk search (mocked client)
// ---------------------------------------------------------------------------
//
// We mock the surrealdb client so the suite never needs a live :8000 sidecar.
// Hoisted into the module factory because vi.mock runs before the imports.

const surrealState = vi.hoisted(() => {
  return {
    schemaCalls: 0,
    queryCalls: [] as Array<{ sql: string; binds: Record<string, unknown> | undefined }>,
    upsertCalls: [] as Array<{ id: string; payload: unknown }>,
    nextQueryResult: null as unknown,
  };
});

vi.mock('surrealdb', () => {
  class StringRecordId {
    rid: string;
    constructor(rid: string) {
      this.rid = rid;
    }
  }
  class Surreal {
    async connect() {}
    async use() {}
    async ping() {}
    async close() {}
    async query(sql: string, binds?: Record<string, unknown>): Promise<unknown> {
      surrealState.queryCalls.push({ sql, binds });
      // Schema-define statements come through `query` too — track them.
      if (sql.includes('DEFINE TABLE') || sql.includes('DEFINE INDEX')) {
        surrealState.schemaCalls += 1;
        return [];
      }
      if (surrealState.nextQueryResult != null) {
        const out = surrealState.nextQueryResult;
        surrealState.nextQueryResult = null;
        return out;
      }
      return [[]];
    }
    async upsert(rid: unknown, payload: unknown): Promise<void> {
      surrealState.upsertCalls.push({
        id: rid instanceof StringRecordId ? rid.rid : String(rid),
        payload,
      });
    }
    async select(): Promise<unknown> {
      return [];
    }
    async delete(): Promise<void> {}
  }
  return { Surreal, StringRecordId };
});

describe('surrealDriver.chunks (mocked client)', () => {
  beforeEach(async () => {
    surrealState.schemaCalls = 0;
    surrealState.queryCalls = [];
    surrealState.upsertCalls = [];
    surrealState.nextQueryResult = null;
    const mod = await import('./surrealDriver');
    mod.resetSurrealClient();
  });

  it('bulkUpsert issues a single batched UPSERT query carrying every chunk', async () => {
    const { surrealDriver } = await import('./surrealDriver');
    const input: SourceChunkInput[] = [
      { id: 'a', documentId: 'd', domain: 'cfa', text: 'one', locator: 'x' },
      { id: 'b', documentId: 'd', domain: 'cfa', text: 'two', locator: 'y' },
      { id: 'c', documentId: 'd', domain: 'cfa', text: 'three', locator: 'z' },
    ];
    await surrealDriver.chunks!.bulkUpsert(input);

    const upsertQueries = surrealState.queryCalls.filter((q) => q.sql.includes('UPSERT'));
    expect(upsertQueries).toHaveLength(1);
    expect(upsertQueries[0].sql).toMatch(/FOR \$c IN \$chunks/);
    const binds = upsertQueries[0].binds as { chunks: Array<{ _id: string }> };
    expect(binds.chunks).toHaveLength(3);
    expect(binds.chunks.map((c) => c._id)).toEqual(['a', 'b', 'c']);
  });

  it('search emits SurrealQL with hybrid filters, KNN, and bm25 binds', async () => {
    const { surrealDriver } = await import('./surrealDriver');
    surrealState.nextQueryResult = [
      [
        {
          id: 'chunks:foo',
          documentId: 'doc-1',
          domain: 'cfa',
          level: 'level2',
          topic: 'fi',
          text: 'duration is sensitivity',
          locator: 'r §1',
          page: 12,
          bm25: 4.2,
          vector_score: 0.9,
        },
      ],
    ];

    const hits = await surrealDriver.chunks!.search({
      query: 'duration',
      embedding: [0.1, 0.2, 0.3],
      domain: 'cfa',
      level: 'level2',
      limit: 5,
    });

    const searchQuery = surrealState.queryCalls.find((q) => q.sql.startsWith('SELECT'));
    expect(searchQuery).toBeDefined();
    expect(searchQuery!.sql).toMatch(/search::score\(0\) AS bm25/);
    expect(searchQuery!.sql).toMatch(/vector::similarity::cosine\(embedding, \$embedding\)/);
    expect(searchQuery!.sql).toMatch(/embedding <\|12\|> \$embedding/);
    expect(searchQuery!.sql).toMatch(/text @@ \$query/);
    expect(searchQuery!.sql).toMatch(/domain = \$domain/);
    expect(searchQuery!.sql).toMatch(/level = \$level/);
    expect(searchQuery!.sql).toMatch(/LIMIT \$limit/);

    expect(searchQuery!.binds).toMatchObject({
      query: 'duration',
      embedding: [0.1, 0.2, 0.3],
      domain: 'cfa',
      level: 'level2',
      limit: 5,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      id: 'chunks:foo',
      documentId: 'doc-1',
      domain: 'cfa',
      level: 'level2',
      topic: 'fi',
      text: 'duration is sensitivity',
      locator: 'r §1',
      page: 12,
    });
    expect(hits[0].score).toBeGreaterThan(0);
    expect(typeof hits[0].vectorScore).toBe('number');
    expect(typeof hits[0].bm25Score).toBe('number');
  });

  it('schema-creation runs exactly once across multiple driver calls', async () => {
    const { surrealDriver } = await import('./surrealDriver');
    surrealState.nextQueryResult = [[]];
    await surrealDriver.chunks!.search({ query: 'one' });
    surrealState.nextQueryResult = [[]];
    await surrealDriver.chunks!.search({ query: 'two' });
    surrealState.nextQueryResult = [[]];
    await surrealDriver.chunks!.search({ query: 'three' });

    expect(surrealState.schemaCalls).toBe(1);
  });

  it('upsert routes through StringRecordId-keyed upsert call', async () => {
    const { surrealDriver } = await import('./surrealDriver');
    await surrealDriver.chunks!.upsert({
      id: 'weird id*with*chars',
      documentId: 'doc-x',
      domain: 'cfa',
      text: 'hello',
      locator: 'loc',
    });
    expect(surrealState.upsertCalls).toHaveLength(1);
    // Sanitised id keeps only [a-zA-Z0-9_-].
    expect(surrealState.upsertCalls[0].id).toBe('chunks:weird_id_with_chars');
  });

  it('deleteByDocument issues a DELETE query with the document bind', async () => {
    const { surrealDriver } = await import('./surrealDriver');
    await surrealDriver.chunks!.deleteByDocument('doc-zap');
    const deleteQ = surrealState.queryCalls.find((q) => q.sql.startsWith('DELETE'));
    expect(deleteQ).toBeDefined();
    expect(deleteQ!.sql).toMatch(/DELETE chunks WHERE documentId = \$doc/);
    expect(deleteQ!.binds).toEqual({ doc: 'doc-zap' });
  });
});
