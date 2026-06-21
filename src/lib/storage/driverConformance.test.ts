import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../progressStore';
import type { MasterySnapshot, QuestionResult, ReviewItem } from '../learningTypes';
import type { SourceChunkInput, StorageDriver, StorageSettingRow } from './types';

// ===========================================================================
// DATA-8 — shared storage-driver conformance harness
// ===========================================================================
//
// The StorageDriver contract (./types.ts) has two implementations:
//   - dexieDriver  (./dexieDriver.ts)  — the active backend, on IndexedDB
//   - surrealDriver (./surrealDriver.ts) — wire-ready for the DATA-1 cutover
//
// This file runs the SAME cross-cutting behavioural assertions against BOTH via
// `describe.each`, so a future SurrealDB cutover is provably contract-safe. It
// is fully OFFLINE: the Dexie side uses `fake-indexeddb` (auto-installed in
// src/setupTests.js); the SurrealDB side runs against a STATEFUL in-memory mock
// of the `surrealdb` client (below) — no live :8000 sidecar is ever contacted.
//
// Where a driver genuinely cannot satisfy an op offline, the relevant case is
// skipped with a clear reason rather than asserting falsely.

// ---------------------------------------------------------------------------
// Stateful surrealdb client mock
// ---------------------------------------------------------------------------
//
// Unlike the call-capturing mocks in chunkSearch.test.ts / schema.test.ts, this
// mock is a real in-memory key/value store keyed by `table:id` so behavioural
// assertions (round-trip, idempotent upsert, namespace isolation, colon-id
// collisions) actually exercise persistence. It implements the exact subset of
// the surrealdb client surface the driver calls:
//   - upsert(StringRecordId, payload)        → keyed write (idempotent)
//   - create(table, payload)                  → append with a synthetic record id
//   - select(StringRecordId | table)          → single row | whole-table array
//   - delete(StringRecordId | table)          → keyed delete | whole-table clear
//   - query(sql, binds)                       → the handful of SurrealQL shapes
//                                               the driver emits (FOR/UPSERT,
//                                               FOR/CREATE, byTopic SELECT,
//                                               deleteByDocument DELETE, schema)
//   - connect/use/ping/close                  → no-ops
//
// Record ids: SurrealDB stores a record reference, not the host string id; the
// driver re-stamps the host `id` from the lookup key on single-row `get`. So we
// store the payload AS-IS under the encoded key and return it on select; the
// driver's `get` adds back `{ id }`. `toArray()` returns payloads verbatim
// (no host `id` re-stamp), matching real Surreal behaviour — assertions account
// for that by matching on stable payload fields, not the host id.
const surrealStore = vi.hoisted(() => {
  // Map<tableName, Map<recordKey, payload>>
  const tables = new Map<string, Map<string, Record<string, unknown>>>();
  let autoId = 0;
  function table(name: string): Map<string, Record<string, unknown>> {
    let t = tables.get(name);
    if (!t) {
      t = new Map();
      tables.set(name, t);
    }
    return t;
  }
  return {
    tables,
    table,
    nextAutoId() {
      autoId += 1;
      return `auto_${autoId}`;
    },
    reset() {
      tables.clear();
      autoId = 0;
    },
  };
});

vi.mock('surrealdb', () => {
  class StringRecordId {
    rid: string;
    constructor(rid: string) {
      this.rid = rid;
    }
  }

  /** Split `table:id` into its parts (id may itself contain no colon — driver
   *  encodes colons as %3A so the FIRST colon is always the table separator). */
  function splitRid(rid: string): { table: string; key: string } {
    const idx = rid.indexOf(':');
    if (idx < 0) return { table: rid, key: '' };
    return { table: rid.slice(0, idx), key: rid.slice(idx + 1) };
  }

  class Surreal {
    async connect() {}
    async use() {}
    async ping() {}
    async close() {}

    async query(sql: string, binds?: Record<string, unknown>): Promise<unknown> {
      // Schema DEFINE statements — no-op (return shape unused by the driver).
      if (sql.includes('DEFINE TABLE') || sql.includes('DEFINE INDEX') || sql.includes('DEFINE FIELD')) {
        return [];
      }

      // bulkUpsert / bulkPut: `FOR $x IN $rows|$chunks { UPSERT type::thing('<table>', $x._id) MERGE $x; }`
      if (sql.includes('UPSERT type::thing')) {
        const m = sql.match(/type::thing\('([^']+)'/);
        const tableName = m ? m[1] : 'unknown';
        const rowsKey = sql.includes('$chunks') ? 'chunks' : 'rows';
        const rows = (binds?.[rowsKey] as Array<Record<string, unknown>>) ?? [];
        const t = surrealStore.table(tableName);
        for (const row of rows) {
          const key = String(row._id);
          const { _id, ...rest } = row;
          void _id;
          t.set(key, { ...rest });
        }
        return [];
      }

      // bulkAdd: `FOR $q IN $rows { CREATE question_results CONTENT $q; }`
      if (sql.includes('CREATE question_results CONTENT')) {
        const rows = (binds?.rows as Array<Record<string, unknown>>) ?? [];
        const t = surrealStore.table('question_results');
        for (const row of rows) t.set(surrealStore.nextAutoId(), { ...row });
        return [];
      }

      // byTopic: `SELECT * FROM question_results WHERE domain = $d AND topic = $t`
      if (sql.startsWith('SELECT * FROM question_results')) {
        const t = surrealStore.table('question_results');
        const d = binds?.d;
        const tp = binds?.t;
        const hits = [...t.values()].filter((r) => r.domain === d && r.topic === tp);
        return [hits];
      }

      // chunks.search: `SELECT ... FROM chunks ...` — offline BM25/vector scoring
      // lives server-side, so the in-memory mock can't reproduce ranking. Return
      // empty; the chunk-search behaviour is covered by chunkSearch.test.ts. The
      // harness skips ranking assertions for Surreal (see the chunks describe).
      if (sql.startsWith('SELECT') && sql.includes('FROM chunks')) {
        return [[]];
      }

      // deleteByDocument: `DELETE chunks WHERE documentId = $doc`
      if (sql.startsWith('DELETE chunks WHERE documentId')) {
        const t = surrealStore.table('chunks');
        const doc = binds?.doc;
        for (const [k, v] of [...t.entries()]) if (v.documentId === doc) t.delete(k);
        return [];
      }

      return [[]];
    }

    async upsert(rid: unknown, payload: unknown): Promise<void> {
      const ridStr = rid instanceof StringRecordId ? rid.rid : String(rid);
      const { table: tableName, key } = splitRid(ridStr);
      surrealStore.table(tableName).set(key, { ...(payload as Record<string, unknown>) });
    }

    async create(table: unknown, payload: unknown): Promise<void> {
      const tableName = String(table);
      surrealStore.table(tableName).set(surrealStore.nextAutoId(), { ...(payload as Record<string, unknown>) });
    }

    async select(target?: unknown): Promise<unknown> {
      if (target instanceof StringRecordId) {
        const { table: tableName, key } = splitRid(target.rid);
        const row = surrealStore.table(tableName).get(key);
        return row ? { ...row } : undefined;
      }
      // Whole-table select.
      const tableName = String(target);
      return [...surrealStore.table(tableName).values()].map((r) => ({ ...r }));
    }

    async delete(target: unknown): Promise<void> {
      if (target instanceof StringRecordId) {
        const { table: tableName, key } = splitRid(target.rid);
        surrealStore.table(tableName).delete(key);
        return;
      }
      // Whole-table delete (clear).
      surrealStore.table(String(target)).clear();
    }
  }

  return { Surreal, StringRecordId };
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
function makeReviewItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: 'cfa::fixed-income::los-1',
    domain: 'cfa',
    topic: 'fixed-income',
    learningObjective: 'los-1',
    title: 'Modified duration',
    path: '/cfa/fixed-income/duration',
    intervalDays: 3,
    ease: 2.5,
    fsrsDifficulty: 5.1,
    dueAt: '2026-06-01T00:00:00.000Z',
    lastResultAt: '2026-05-28T00:00:00.000Z',
    attempts: 4,
    correctStreak: 2,
    lastCorrect: true,
    lastConfidence: 'high',
    lastErrorCategory: 'none',
    ...overrides,
  };
}

function makeResult(overrides: Partial<QuestionResult> = {}): QuestionResult {
  return {
    domain: 'cfa',
    topic: 'fixed-income',
    questionId: 'q-1',
    learningObjective: 'los-1',
    correct: true,
    confidence: 'high',
    errorCategory: 'none',
    difficulty: 'intermediate',
    elapsedSeconds: 42,
    createdAt: '2026-05-28T00:00:00.000Z',
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<MasterySnapshot> = {}): MasterySnapshot {
  return {
    id: 'cfa::fixed-income::los-1',
    domain: 'cfa',
    topic: 'fixed-income',
    learningObjective: 'los-1',
    title: 'Modified duration',
    score: 72,
    attempts: 4,
    correct: 3,
    confidenceScore: 0.8,
    lastAttemptAt: '2026-05-28T00:00:00.000Z',
    nextReviewAt: '2026-06-01T00:00:00.000Z',
    trend: 'up',
    ...overrides,
  };
}

function makeChunk(overrides: Partial<SourceChunkInput> = {}): SourceChunkInput {
  return {
    id: 'chunk-1',
    documentId: 'doc-a',
    domain: 'cfa',
    level: 'level2',
    topic: 'fixed-income',
    text: 'Modified duration measures price sensitivity to small parallel yield changes.',
    locator: 'reading-12 §1.2',
    page: 4,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Driver loader — Dexie is imported directly; the Surreal driver is dynamically
// imported AFTER the surrealdb mock is in place and its cached client reset, so
// each iteration starts clean.
// ---------------------------------------------------------------------------
interface DriverCase {
  name: 'dexie' | 'surrealdb';
  /** Load (or return) the driver under test. */
  load(): Promise<StorageDriver>;
  /** Wipe ALL namespaces this driver owns to isolate each test. */
  reset(): Promise<void>;
  /**
   * True when this driver re-stamps the original string `id` on whole-table
   * reads (`reviewItems.toArray()` / `masterySnapshots.toArray()`). Dexie does
   * (the id IS the primary key); SurrealDB stores a record reference and only
   * restores the host id on single-row `get`, so `toArray()` rows carry no host
   * `id`. Drives whether array assertions can match on `id`.
   */
  toArrayRestoresId: boolean;
}

const dexieCase: DriverCase = {
  name: 'dexie',
  async load() {
    const { dexieDriver } = await import('./dexieDriver');
    return dexieDriver;
  },
  async reset() {
    await db.settings.clear();
    await db.sourceChunks.clear();
    await db.reviewItems.clear();
    await db.questionResults.clear();
    await db.masterySnapshots.clear();
  },
  toArrayRestoresId: true,
};

const surrealCase: DriverCase = {
  name: 'surrealdb',
  async load() {
    const mod = await import('./surrealDriver');
    mod.resetSurrealClient();
    return mod.surrealDriver;
  },
  async reset() {
    surrealStore.reset();
    const mod = await import('./surrealDriver');
    mod.resetSurrealClient();
  },
  toArrayRestoresId: false,
};

const DRIVER_CASES: DriverCase[] = [dexieCase, surrealCase];

// ===========================================================================
// Parameterized contract — runs identically against every driver
// ===========================================================================
describe.each(DRIVER_CASES)('StorageDriver conformance: $name', (driverCase) => {
  let driver: StorageDriver;

  beforeEach(async () => {
    driver = await driverCase.load();
    await driverCase.reset();
  });

  afterEach(async () => {
    await driverCase.reset();
  });

  // -------------------------------------------------------------------------
  // ready()
  // -------------------------------------------------------------------------
  it('reports the expected driver name', () => {
    expect(driver.name).toBe(driverCase.name);
  });

  it('ready() resolves to a boolean (true under the offline harness)', async () => {
    // Dexie opens fake-indexeddb; the Surreal mock's ping() is a no-op, so both
    // report ready offline. A live cutover would gate on the real sidecar.
    const ok = await driver.ready();
    expect(typeof ok).toBe('boolean');
    expect(ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // settings — round-trip put/get/delete + namespace + bulkDelete + clear
  // -------------------------------------------------------------------------
  describe('settings', () => {
    it('put → get round-trips a row verbatim', async () => {
      const row: StorageSettingRow = {
        key: 'open-notebook:settings',
        value: { enabled: true, nested: { n: 1 } },
        updatedAt: '2026-06-10T00:00:00.000Z',
      };
      await driver.settings.put(row);
      const fetched = await driver.settings.get(row.key);
      expect(fetched).toEqual(row);
    });

    it('put is an idempotent upsert (same key overwrites, no duplication)', async () => {
      await driver.settings.put({ key: 'k', value: 'first', updatedAt: 't1' });
      await driver.settings.put({ key: 'k', value: 'second', updatedAt: 't2' });

      const all = await driver.settings.toArray();
      const forKey = all.filter((r) => r.key === 'k');
      expect(forKey).toHaveLength(1);
      expect(forKey[0].value).toBe('second');
      expect(forKey[0].updatedAt).toBe('t2');
    });

    it('get returns undefined for a missing key', async () => {
      expect(await driver.settings.get('nope')).toBeUndefined();
    });

    it('delete removes a single key, leaving others intact', async () => {
      await driver.settings.put({ key: 'keep', value: 1, updatedAt: 't' });
      await driver.settings.put({ key: 'drop', value: 2, updatedAt: 't' });
      await driver.settings.delete('drop');

      expect(await driver.settings.get('drop')).toBeUndefined();
      expect(await driver.settings.get('keep')).toBeDefined();
    });

    it('toArray returns every stored row', async () => {
      await driver.settings.put({ key: 'a', value: 1, updatedAt: 't' });
      await driver.settings.put({ key: 'b', value: 2, updatedAt: 't' });
      await driver.settings.put({ key: 'c', value: 3, updatedAt: 't' });

      const all = await driver.settings.toArray();
      expect(all.map((r) => r.key).sort()).toEqual(['a', 'b', 'c']);
    });

    it('bulkDelete removes every requested key', async () => {
      await driver.settings.put({ key: 'a', value: 1, updatedAt: 't' });
      await driver.settings.put({ key: 'b', value: 2, updatedAt: 't' });
      await driver.settings.put({ key: 'c', value: 3, updatedAt: 't' });
      await driver.settings.bulkDelete(['a', 'c']);

      const all = await driver.settings.toArray();
      expect(all.map((r) => r.key)).toEqual(['b']);
    });

    it('clear empties the namespace', async () => {
      await driver.settings.put({ key: 'a', value: 1, updatedAt: 't' });
      await driver.settings.put({ key: 'b', value: 2, updatedAt: 't' });
      await driver.settings.clear();
      expect(await driver.settings.toArray()).toHaveLength(0);
    });

    it('preserves keys containing colons / special chars without collision', async () => {
      // Exercises the Wave-1 sanitiseId fix on the Surreal side (settings use a
      // hex-encoded key id); Dexie keys verbatim. Both must round-trip distinctly.
      await driver.settings.put({ key: 'a:b', value: 'colon', updatedAt: 't' });
      await driver.settings.put({ key: 'a::b', value: 'double', updatedAt: 't' });
      await driver.settings.put({ key: 'a*b', value: 'star', updatedAt: 't' });

      expect((await driver.settings.get('a:b'))?.value).toBe('colon');
      expect((await driver.settings.get('a::b'))?.value).toBe('double');
      expect((await driver.settings.get('a*b'))?.value).toBe('star');
      expect(await driver.settings.toArray()).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // reviewItems — round-trip, idempotent put, bulkPut carries every row,
  // delete, colon-id non-collision, numeric (score/range) field preservation
  // -------------------------------------------------------------------------
  describe('reviewItems', () => {
    it('provides the reviewItems namespace', () => {
      expect(driver.reviewItems).toBeDefined();
    });

    it('put → get round-trips the item (id restored on single-row get)', async () => {
      const item = makeReviewItem();
      await driver.reviewItems!.put(item);
      const fetched = await driver.reviewItems!.get(item.id);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(item.id);
      // Numeric / range fields preserved exactly.
      expect(fetched!.ease).toBe(item.ease);
      expect(fetched!.intervalDays).toBe(item.intervalDays);
      expect(fetched!.fsrsDifficulty).toBe(item.fsrsDifficulty);
      expect(fetched!.attempts).toBe(item.attempts);
      expect(fetched!.correctStreak).toBe(item.correctStreak);
      expect(fetched!.dueAt).toBe(item.dueAt);
    });

    it('put is idempotent (same id overwrites, never duplicates)', async () => {
      await driver.reviewItems!.put(makeReviewItem({ ease: 2.0 }));
      await driver.reviewItems!.put(makeReviewItem({ ease: 2.9 }));
      const all = await driver.reviewItems!.toArray();
      expect(all).toHaveLength(1);
      expect(all[0].ease).toBe(2.9);
    });

    it('bulkPut carries every row', async () => {
      const items = [
        makeReviewItem({ id: 'cfa::a::lo', topic: 'a' }),
        makeReviewItem({ id: 'cfa::b::lo', topic: 'b' }),
        makeReviewItem({ id: 'cfa::c::lo', topic: 'c' }),
      ];
      await driver.reviewItems!.bulkPut(items);
      const all = await driver.reviewItems!.toArray();
      expect(all).toHaveLength(3);
      // Every topic survived the round-trip.
      expect(all.map((r) => r.topic).sort()).toEqual(['a', 'b', 'c']);
      if (driverCase.toArrayRestoresId) {
        expect(all.map((r) => r.id).sort()).toEqual(['cfa::a::lo', 'cfa::b::lo', 'cfa::c::lo']);
      }
    });

    it('delete removes a single item', async () => {
      await driver.reviewItems!.put(makeReviewItem({ id: 'cfa::keep::lo' }));
      await driver.reviewItems!.put(makeReviewItem({ id: 'cfa::drop::lo' }));
      await driver.reviewItems!.delete('cfa::drop::lo');

      expect(await driver.reviewItems!.get('cfa::drop::lo')).toBeUndefined();
      expect(await driver.reviewItems!.get('cfa::keep::lo')).toBeDefined();
    });

    it('colon-delimited ids do NOT collide and round-trip distinctly (Wave-1 sanitiseId)', async () => {
      // The motivating collision: under the old `_`-replacement scheme,
      // `domain::topic::lo` and `domain:topic:lo` flattened to the same slug,
      // silently overwriting each other. The reversible encoding keeps them apart.
      await driver.reviewItems!.put(makeReviewItem({ id: 'domain::topic::lo', ease: 1.1 }));
      await driver.reviewItems!.put(makeReviewItem({ id: 'domain:topic:lo', ease: 2.2 }));

      const a = await driver.reviewItems!.get('domain::topic::lo');
      const b = await driver.reviewItems!.get('domain:topic:lo');
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a!.ease).toBe(1.1);
      expect(b!.ease).toBe(2.2);
      // Two distinct rows persisted — no overwrite.
      expect(await driver.reviewItems!.toArray()).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // questionResults — append-only log: add, bulkAdd carries every row,
  // byTopic isolation, clear, score/field preservation
  // -------------------------------------------------------------------------
  describe('questionResults', () => {
    it('provides the questionResults namespace', () => {
      expect(driver.questionResults).toBeDefined();
    });

    it('add → toArray records the attempt with its fields preserved', async () => {
      const result = makeResult({ elapsedSeconds: 99, correct: false });
      await driver.questionResults!.add(result);
      const all = await driver.questionResults!.toArray();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        domain: 'cfa',
        topic: 'fixed-income',
        questionId: 'q-1',
        correct: false,
        elapsedSeconds: 99,
        confidence: 'high',
        errorCategory: 'none',
        difficulty: 'intermediate',
      });
    });

    it('bulkAdd carries every row', async () => {
      await driver.questionResults!.bulkAdd([
        makeResult({ questionId: 'q-1' }),
        makeResult({ questionId: 'q-2' }),
        makeResult({ questionId: 'q-3' }),
      ]);
      const all = await driver.questionResults!.toArray();
      expect(all).toHaveLength(3);
      expect(all.map((r) => r.questionId).sort()).toEqual(['q-1', 'q-2', 'q-3']);
    });

    it('is append-only (repeat adds accumulate, never overwrite)', async () => {
      await driver.questionResults!.add(makeResult({ questionId: 'q-dup' }));
      await driver.questionResults!.add(makeResult({ questionId: 'q-dup' }));
      const all = await driver.questionResults!.toArray();
      expect(all.filter((r) => r.questionId === 'q-dup')).toHaveLength(2);
    });

    it('byTopic isolates rows to a single domain + topic', async () => {
      await driver.questionResults!.bulkAdd([
        makeResult({ questionId: 'a', domain: 'cfa', topic: 'fixed-income' }),
        makeResult({ questionId: 'b', domain: 'cfa', topic: 'equity' }),
        makeResult({ questionId: 'c', domain: 'quant', topic: 'fixed-income' }),
        makeResult({ questionId: 'd', domain: 'cfa', topic: 'fixed-income' }),
      ]);

      const hits = await driver.questionResults!.byTopic('cfa', 'fixed-income');
      expect(hits).toHaveLength(2);
      for (const h of hits) {
        expect(h.domain).toBe('cfa');
        expect(h.topic).toBe('fixed-income');
      }
      expect(hits.map((h) => h.questionId).sort()).toEqual(['a', 'd']);
    });

    it('clear empties the log', async () => {
      await driver.questionResults!.add(makeResult());
      await driver.questionResults!.clear();
      expect(await driver.questionResults!.toArray()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // masterySnapshots — round-trip, idempotent put, score field preservation,
  // colon-id non-collision
  // -------------------------------------------------------------------------
  describe('masterySnapshots', () => {
    it('provides the masterySnapshots namespace', () => {
      expect(driver.masterySnapshots).toBeDefined();
    });

    it('put → get round-trips with score / numeric fields preserved', async () => {
      const snap = makeSnapshot({ score: 88, confidenceScore: 0.42, attempts: 7, correct: 5 });
      await driver.masterySnapshots!.put(snap);
      const fetched = await driver.masterySnapshots!.get(snap.id);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(snap.id);
      expect(fetched!.score).toBe(88);
      expect(fetched!.confidenceScore).toBe(0.42);
      expect(fetched!.attempts).toBe(7);
      expect(fetched!.correct).toBe(5);
      expect(fetched!.trend).toBe('up');
    });

    it('put is idempotent (same id overwrites)', async () => {
      await driver.masterySnapshots!.put(makeSnapshot({ score: 50 }));
      await driver.masterySnapshots!.put(makeSnapshot({ score: 90 }));
      const all = await driver.masterySnapshots!.toArray();
      expect(all).toHaveLength(1);
      expect(all[0].score).toBe(90);
    });

    it('toArray returns every stored snapshot', async () => {
      await driver.masterySnapshots!.put(makeSnapshot({ id: 'cfa::a::lo', score: 10 }));
      await driver.masterySnapshots!.put(makeSnapshot({ id: 'cfa::b::lo', score: 20 }));
      const all = await driver.masterySnapshots!.toArray();
      expect(all).toHaveLength(2);
      expect(all.map((s) => s.score).sort((x, y) => x - y)).toEqual([10, 20]);
    });

    it('colon-delimited ids do NOT collide (Wave-1 sanitiseId)', async () => {
      await driver.masterySnapshots!.put(makeSnapshot({ id: 'domain::topic::lo', score: 11 }));
      await driver.masterySnapshots!.put(makeSnapshot({ id: 'domain:topic:lo', score: 22 }));

      const a = await driver.masterySnapshots!.get('domain::topic::lo');
      const b = await driver.masterySnapshots!.get('domain:topic:lo');
      expect(a!.score).toBe(11);
      expect(b!.score).toBe(22);
      expect(await driver.masterySnapshots!.toArray()).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // chunks — CRUD that both drivers can satisfy offline.
  //
  // Ranking (BM25 + vector cosine) is asserted per-driver elsewhere
  // (chunkSearch.test.ts): the Dexie side computes it in JS; the Surreal side
  // delegates to the sidecar's SEARCH/MTREE indexes, which the offline in-memory
  // mock cannot reproduce. So this harness only asserts the storage contract
  // (upsert / bulkUpsert carries every row / deleteByDocument), and SKIPS the
  // search-ranking assertion for the Surreal driver with a clear reason.
  // -------------------------------------------------------------------------
  describe('chunks', () => {
    it('provides the chunks namespace', () => {
      expect(driver.chunks).toBeDefined();
    });

    it('upsert is idempotent (same id overwrites, no duplication)', async () => {
      await driver.chunks!.upsert(makeChunk({ id: 'c1', text: 'first' }));
      await driver.chunks!.upsert(makeChunk({ id: 'c1', text: 'second' }));
      // Verify via search on the Dexie side; the Surreal mock can't search, so
      // assert through deleteByDocument leaving the table consistent instead.
      if (driverCase.name === 'dexie') {
        const hits = await driver.chunks!.search({ query: 'second' });
        expect(hits.filter((h) => h.id === 'c1')).toHaveLength(1);
        expect(hits[0].text).toBe('second');
      } else {
        // Surreal: confirm idempotent keyed write persisted exactly one row.
        expect(surrealStore.table('chunks').size).toBe(1);
      }
    });

    it('bulkUpsert carries every chunk', async () => {
      const chunks = [
        makeChunk({ id: 'a', documentId: 'doc-a' }),
        makeChunk({ id: 'b', documentId: 'doc-a' }),
        makeChunk({ id: 'c', documentId: 'doc-b' }),
      ];
      await driver.chunks!.bulkUpsert(chunks);

      if (driverCase.name === 'dexie') {
        expect(await db.sourceChunks.count()).toBe(3);
      } else {
        expect(surrealStore.table('chunks').size).toBe(3);
      }
    });

    it('deleteByDocument removes every chunk tied to that documentId', async () => {
      await driver.chunks!.bulkUpsert([
        makeChunk({ id: 'a', documentId: 'doc-a' }),
        makeChunk({ id: 'b', documentId: 'doc-a' }),
        makeChunk({ id: 'c', documentId: 'doc-b' }),
      ]);
      await driver.chunks!.deleteByDocument('doc-a');

      if (driverCase.name === 'dexie') {
        expect(await db.sourceChunks.where('documentId').equals('doc-a').count()).toBe(0);
        expect(await db.sourceChunks.where('documentId').equals('doc-b').count()).toBe(1);
      } else {
        const remaining = [...surrealStore.table('chunks').values()];
        expect(remaining).toHaveLength(1);
        expect(remaining[0].documentId).toBe('doc-b');
      }
    });

    it.skipIf(driverCase.name === 'surrealdb')(
      'search ranks the lexical hit first (BM25 computed in-driver) — Dexie only; Surreal ranking is sidecar-side and covered by chunkSearch.test.ts',
      async () => {
        await driver.chunks!.bulkUpsert([
          makeChunk({ id: 'd1', text: 'Modified duration measures price sensitivity.' }),
          makeChunk({ id: 'd2', text: 'Convexity captures curvature of the price-yield curve.' }),
        ]);
        const hits = await driver.chunks!.search({ query: 'duration' });
        expect(hits.length).toBeGreaterThanOrEqual(1);
        expect(hits[0].text.toLowerCase()).toContain('duration');
        expect(hits[0].score).toBeGreaterThan(0);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Namespace isolation — writes to one namespace never leak into another.
  // -------------------------------------------------------------------------
  describe('namespace isolation', () => {
    it('writes stay confined to their own namespace', async () => {
      await driver.settings.put({ key: 's1', value: 1, updatedAt: 't' });
      await driver.reviewItems!.put(makeReviewItem({ id: 'cfa::iso::lo' }));
      await driver.questionResults!.add(makeResult({ questionId: 'iso-q' }));
      await driver.masterySnapshots!.put(makeSnapshot({ id: 'cfa::iso::lo' }));
      await driver.chunks!.upsert(makeChunk({ id: 'iso-c', documentId: 'iso-doc' }));

      // Each namespace sees exactly its own single row.
      expect(await driver.settings.toArray()).toHaveLength(1);
      expect(await driver.reviewItems!.toArray()).toHaveLength(1);
      expect(await driver.questionResults!.toArray()).toHaveLength(1);
      expect(await driver.masterySnapshots!.toArray()).toHaveLength(1);

      // Clearing the append-only log leaves the keyed namespaces untouched.
      await driver.questionResults!.clear();
      expect(await driver.questionResults!.toArray()).toHaveLength(0);
      expect(await driver.settings.toArray()).toHaveLength(1);
      expect(await driver.reviewItems!.toArray()).toHaveLength(1);
      expect(await driver.masterySnapshots!.toArray()).toHaveLength(1);

      // Deleting a reviewItem does not touch the mastery snapshot sharing its id.
      await driver.reviewItems!.delete('cfa::iso::lo');
      expect(await driver.reviewItems!.toArray()).toHaveLength(0);
      expect(await driver.masterySnapshots!.get('cfa::iso::lo')).toBeDefined();
    });
  });
});
