import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../progressStore';
import type { MasterySnapshot, QuestionResult, ReviewItem } from '../learningTypes';
import type { SourceChunkInput, StorageDriver, StorageSettingRow } from './types';
// DATA-1 Phase 3 — exercise the now-registered Dexie stores through the REAL
// slice persistence paths (no injected table), so the round-trip proves the
// schema bump wired getStorage().table('abilitySnapshots'|'studyTrail') to a live
// store instead of the prior no-op (unknown-store) degrade.
import {
  recordAbilitySnapshot,
  readAbilitySnapshots,
  readLatestAbilitySnapshot,
} from '../psychometrics/abilitySnapshots';
import { recordStudyContext, readStudyTrail } from '../studyTrail';

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
      // (matched specifically by its $d/$t binds so the generic table() SELECT
      // handlers below can serve question_results too).
      if (sql.startsWith('SELECT * FROM question_results WHERE domain = $d AND topic = $t')) {
        const t = surrealStore.table('question_results');
        const d = binds?.d;
        const tp = binds?.t;
        const hits = [...t.values()].filter((r) => r.domain === d && r.topic === tp);
        return [hits];
      }

      // --- DATA-1 generic table() primitive shapes -------------------------
      // These coexist with the namespace-specific handlers above; chunks is
      // still routed to its own (empty-ranking) handler further down.

      // count(): `SELECT count() AS count FROM <table> GROUP ALL`
      {
        const m = sql.match(/^SELECT count\(\) AS count FROM (\w+) GROUP ALL/);
        if (m) {
          const t = surrealStore.table(m[1]);
          return [[{ count: t.size }]];
        }
      }

      // whereEquals(): `SELECT * FROM <table> WHERE <field> = $value`
      {
        const m = sql.match(/^SELECT \* FROM (\w+) WHERE (\w+) = \$value/);
        if (m && m[1] !== 'chunks') {
          const t = surrealStore.table(m[1]);
          const field = m[2];
          const value = binds?.value;
          const hits = [...t.values()].filter((r) => r[field] === value);
          return [hits];
        }
      }

      // whereAnyOf(): `SELECT * FROM <table> WHERE <field> IN $values`
      {
        const m = sql.match(/^SELECT \* FROM (\w+) WHERE (\w+) IN \$values/);
        if (m && m[1] !== 'chunks') {
          const t = surrealStore.table(m[1]);
          const field = m[2];
          const values = (binds?.values as unknown[]) ?? [];
          const set = new Set(values);
          const hits = [...t.values()].filter((r) => set.has(r[field]));
          return [hits];
        }
      }

      // orderedBy(): `SELECT * FROM <table> ORDER BY <field> ASC|DESC [LIMIT n] [START n]`
      {
        const m = sql.match(/^SELECT \* FROM (\w+) ORDER BY (\w+) (ASC|DESC)(?: LIMIT (\d+))?(?: START (\d+))?/);
        if (m && m[1] !== 'chunks') {
          const t = surrealStore.table(m[1]);
          const field = m[2];
          const desc = m[3] === 'DESC';
          const limit = m[4] != null ? Number(m[4]) : undefined;
          const start = m[5] != null ? Number(m[5]) : undefined;
          let rows = [...t.values()].sort((a, b) => {
            const av = a[field] as string | number;
            const bv = b[field] as string | number;
            if (av < bv) return desc ? 1 : -1;
            if (av > bv) return desc ? -1 : 1;
            return 0;
          });
          // SurrealDB applies START (offset) before LIMIT; mirror that order.
          if (start != null) rows = rows.slice(start);
          if (limit != null) rows = rows.slice(0, limit);
          return [rows];
        }
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
    // DATA-1 — the generic table() suite writes to these real stores.
    await db.lessonProgress.clear();
    await db.studySessions.clear();
    // DATA-1 Phase 3 — transaction() + deferred-store suites write here too.
    await db.lessonProgress.clear();
    await db.reviewEvents.clear();
    await db.abilitySnapshots.clear();
    await db.studyTrail.clear();
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

  // -------------------------------------------------------------------------
  // DATA-1 — generic table() keyed-table primitive
  //
  // Proves the SAME contract on both drivers for the primitive that the
  // Phase-2 progressStore reroute will target. We exercise it against REAL
  // Dexie store names so the Dexie side is genuinely behaviourally identical to
  // direct `db.<table>` access: `lessonProgress` (string-keyed) for keyed CRUD,
  // and `studySessions` (`++id` auto-id) for the append-only `add` path.
  //
  // Key-restore caveat mirrors the namespace methods (see DriverCase docs):
  // single-row `get` re-stamps the host id; whole-table reads return rows
  // as-stored. So array assertions match on stable payload fields, and only
  // match on `id` when `driverCase.toArrayRestoresId`.
  // -------------------------------------------------------------------------
  describe('table() generic primitive', () => {
    // Row shape over the REAL `lessonProgress` store. Its indexed fields are
    // `id, domain, moduleId, completed, updatedAt, lastVisitedAt` — the
    // query-surface tests below filter / order on those (Dexie `where`/`orderBy`
    // REQUIRE an index, so using indexed fields is what keeps the Dexie side a
    // faithful 1:1 of direct `db.lessonProgress.<op>` access). `score` is an
    // extra (un-indexed) payload field that must round-trip verbatim.
    interface KeyedRow {
      id: string;
      domain: string;
      moduleId: string;
      lastVisitedAt: string;
      score: number;
      tag?: string;
    }
    const makeRow = (overrides: Partial<KeyedRow> = {}): KeyedRow => ({
      id: 'cfa::fixed-income::los-1',
      domain: 'cfa',
      moduleId: 'fixed-income',
      lastVisitedAt: '2026-06-01T00:00:00.000Z',
      score: 50,
      ...overrides,
    });

    it('exposes table() on both drivers', () => {
      expect(typeof driver.table).toBe('function');
    });

    it('put → get round-trips a keyed row (id restored on single-row get)', async () => {
      const t = driver.table!<KeyedRow>('lessonProgress');
      const row = makeRow({ score: 88, tag: 'x' });
      await t.put(row);
      const fetched = await t.get(row.id);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(row.id);
      // Un-indexed payload fields survive the round-trip verbatim.
      expect(fetched!.score).toBe(88);
      expect(fetched!.tag).toBe('x');
    });

    it('put is an idempotent upsert (same key overwrites, no duplication)', async () => {
      const t = driver.table!<KeyedRow>('lessonProgress');
      await t.put(makeRow({ score: 10 }));
      await t.put(makeRow({ score: 20 }));
      expect(await t.count()).toBe(1);
      expect((await t.get('cfa::fixed-income::los-1'))!.score).toBe(20);
    });

    it('get returns undefined for a missing key', async () => {
      const t = driver.table!<KeyedRow>('lessonProgress');
      expect(await t.get('nope')).toBeUndefined();
    });

    it('delete removes a single row, leaving others intact', async () => {
      const t = driver.table!<KeyedRow>('lessonProgress');
      await t.put(makeRow({ id: 'keep' }));
      await t.put(makeRow({ id: 'drop' }));
      await t.delete('drop');
      expect(await t.get('drop')).toBeUndefined();
      expect(await t.get('keep')).toBeDefined();
    });

    it('bulkPut / count / toArray carry every row', async () => {
      const t = driver.table!<KeyedRow>('lessonProgress');
      await t.bulkPut([
        makeRow({ id: 'a', moduleId: 'a' }),
        makeRow({ id: 'b', moduleId: 'b' }),
        makeRow({ id: 'c', moduleId: 'c' }),
      ]);
      expect(await t.count()).toBe(3);
      const all = await t.toArray();
      expect(all).toHaveLength(3);
      expect(all.map((r) => r.moduleId).sort()).toEqual(['a', 'b', 'c']);
    });

    it('bulkGet returns one slot per key (undefined where absent)', async () => {
      const t = driver.table!<KeyedRow>('lessonProgress');
      await t.bulkPut([makeRow({ id: 'a' }), makeRow({ id: 'c' })]);
      const got = await t.bulkGet(['a', 'b', 'c']);
      expect(got).toHaveLength(3);
      expect(got[0]).toBeDefined();
      expect(got[1]).toBeUndefined();
      expect(got[2]).toBeDefined();
    });

    it('bulkDelete removes every requested key', async () => {
      const t = driver.table!<KeyedRow>('lessonProgress');
      await t.bulkPut([makeRow({ id: 'a' }), makeRow({ id: 'b' }), makeRow({ id: 'c' })]);
      await t.bulkDelete(['a', 'c']);
      expect(await t.count()).toBe(1);
      expect(await t.get('b')).toBeDefined();
    });

    it('clear empties the table', async () => {
      const t = driver.table!<KeyedRow>('lessonProgress');
      await t.bulkPut([makeRow({ id: 'a' }), makeRow({ id: 'b' })]);
      await t.clear();
      expect(await t.count()).toBe(0);
      expect(await t.toArray()).toHaveLength(0);
    });

    it('colon-delimited keys do NOT collide and round-trip distinctly', async () => {
      const t = driver.table!<KeyedRow>('lessonProgress');
      await t.put(makeRow({ id: 'domain::topic::lo', score: 11 }));
      await t.put(makeRow({ id: 'domain:topic:lo', score: 22 }));
      expect((await t.get('domain::topic::lo'))!.score).toBe(11);
      expect((await t.get('domain:topic:lo'))!.score).toBe(22);
      expect(await t.count()).toBe(2);
    });

    it('whereEquals filters to matching rows on an indexed field', async () => {
      const t = driver.table!<KeyedRow>('lessonProgress');
      await t.bulkPut([
        makeRow({ id: 'a', moduleId: 'fixed-income' }),
        makeRow({ id: 'b', moduleId: 'equity' }),
        makeRow({ id: 'c', moduleId: 'fixed-income' }),
      ]);
      const hits = await t.whereEquals('moduleId', 'fixed-income');
      expect(hits).toHaveLength(2);
      for (const h of hits) expect(h.moduleId).toBe('fixed-income');
    });

    it('whereAnyOf filters to rows whose indexed field is in the set', async () => {
      const t = driver.table!<KeyedRow>('lessonProgress');
      await t.bulkPut([
        makeRow({ id: 'a', moduleId: 'alpha' }),
        makeRow({ id: 'b', moduleId: 'beta' }),
        makeRow({ id: 'c', moduleId: 'gamma' }),
      ]);
      const hits = await t.whereAnyOf('moduleId', ['alpha', 'gamma']);
      expect(hits.map((h) => h.moduleId).sort()).toEqual(['alpha', 'gamma']);
    });

    it('orderedBy returns rows sorted, with desc / limit / offset honoured', async () => {
      // Order on the indexed `lastVisitedAt`; ISO strings sort lexically.
      const t = driver.table!<KeyedRow>('lessonProgress');
      await t.bulkPut([
        makeRow({ id: 'a', lastVisitedAt: '2026-06-03T00:00:00.000Z' }),
        makeRow({ id: 'b', lastVisitedAt: '2026-06-01T00:00:00.000Z' }),
        makeRow({ id: 'c', lastVisitedAt: '2026-06-02T00:00:00.000Z' }),
      ]);

      const asc = await t.orderedBy('lastVisitedAt');
      expect(asc.map((r) => r.lastVisitedAt.slice(8, 10))).toEqual(['01', '02', '03']);

      const desc = await t.orderedBy('lastVisitedAt', { desc: true });
      expect(desc.map((r) => r.lastVisitedAt.slice(8, 10))).toEqual(['03', '02', '01']);

      const topTwo = await t.orderedBy('lastVisitedAt', { desc: true, limit: 2 });
      expect(topTwo.map((r) => r.lastVisitedAt.slice(8, 10))).toEqual(['03', '02']);

      const skipOne = await t.orderedBy('lastVisitedAt', { offset: 1 });
      expect(skipOne.map((r) => r.lastVisitedAt.slice(8, 10))).toEqual(['02', '03']);
    });

    it('add appends to an auto-id table (no caller-supplied key)', async () => {
      // `studySessions` is a Dexie `++id` store; SurrealDB CREATE assigns a
      // random record id. Two adds of an unkeyed row accumulate, never collide.
      const t = driver.table!<{ domain: string; topic: string; score: number }>('studySessions');
      await t.add({ domain: 'cfa', topic: 't', score: 1 });
      await t.add({ domain: 'cfa', topic: 't', score: 2 });
      const all = await t.toArray();
      expect(all).toHaveLength(2);
      expect(all.map((r) => r.score).sort()).toEqual([1, 2]);
    });

    it('keeps writes isolated per table name', async () => {
      const lessons = driver.table!<KeyedRow>('lessonProgress');
      const sessions = driver.table!<{ domain: string; topic: string; score: number }>('studySessions');
      await lessons.put(makeRow({ id: 'only-lesson' }));
      await sessions.add({ domain: 'cfa', topic: 't', score: 9 });

      expect(await lessons.count()).toBe(1);
      expect(await sessions.count()).toBe(1);

      await sessions.clear();
      expect(await sessions.count()).toBe(0);
      // Clearing one table never touches another.
      expect(await lessons.count()).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // DATA-1 Phase 3 — transaction() atomic-batch primitive
  //
  // The primitive the Phase-3 progressStore recorder reroute targets. We prove
  // the SAME contract on both drivers: a multi-table batch commits its writes
  // and the callback's return value is surfaced, with `tx.table(name)` ops
  // confined to their own table names. Atomic ROLLBACK on a mid-batch failure is
  // asserted for Dexie only — Dexie gives real transactional rollback via
  // fake-indexeddb, while the SurrealDB driver's transaction() is a
  // runtime-verify-gated sequential best-effort (no client-side cross-table
  // rollback), so a rollback assertion there would assert a guarantee the
  // offline driver does not make. Reuses the real `lessonProgress` (keyed) +
  // `studySessions` (auto-id) stores so the Dexie side is a faithful 1:1 of the
  // direct `db.transaction('rw', [...], fn)` it replaces.
  // -------------------------------------------------------------------------
  describe('transaction() atomic-batch primitive', () => {
    interface KeyedRow {
      id: string;
      domain: string;
      moduleId: string;
      lastVisitedAt: string;
      score: number;
    }
    const makeRow = (overrides: Partial<KeyedRow> = {}): KeyedRow => ({
      id: 'cfa::fixed-income::los-1',
      domain: 'cfa',
      moduleId: 'fixed-income',
      lastVisitedAt: '2026-06-01T00:00:00.000Z',
      score: 50,
      ...overrides,
    });

    it('exposes transaction() on both drivers', () => {
      expect(typeof driver.transaction).toBe('function');
    });

    it('commits writes across several tables in one batch', async () => {
      await driver.transaction!(['lessonProgress', 'studySessions'], 'rw', async (tx) => {
        await tx.table<KeyedRow>('lessonProgress').put(makeRow({ id: 'tx-keyed', score: 7 }));
        await tx.table<{ domain: string; topic: string; score: number }>('studySessions').add({
          domain: 'cfa',
          topic: 't',
          score: 9,
        });
      });

      const lessons = driver.table!<KeyedRow>('lessonProgress');
      const sessions = driver.table!<{ domain: string; topic: string; score: number }>('studySessions');
      expect((await lessons.get('tx-keyed'))!.score).toBe(7);
      expect(await sessions.count()).toBe(1);
    });

    it('surfaces the callback return value', async () => {
      const result = await driver.transaction!(['lessonProgress'], 'rw', async (tx) => {
        await tx.table<KeyedRow>('lessonProgress').put(makeRow({ id: 'ret', score: 3 }));
        const row = await tx.table<KeyedRow>('lessonProgress').get('ret');
        return row?.score ?? -1;
      });
      expect(result).toBe(3);
    });

    it('reads inside the batch see writes made earlier in the same batch', async () => {
      const seen = await driver.transaction!(['lessonProgress'], 'rw', async (tx) => {
        const t = tx.table<KeyedRow>('lessonProgress');
        await t.put(makeRow({ id: 'inner', score: 42 }));
        const back = await t.get('inner');
        return back?.score;
      });
      expect(seen).toBe(42);
    });

    it('keeps tx writes isolated per table name', async () => {
      await driver.transaction!(['lessonProgress', 'studySessions'], 'rw', async (tx) => {
        await tx.table<KeyedRow>('lessonProgress').put(makeRow({ id: 'iso-lesson' }));
        await tx.table<{ domain: string; topic: string; score: number }>('studySessions').add({
          domain: 'cfa',
          topic: 't',
          score: 1,
        });
      });
      expect(await driver.table!<KeyedRow>('lessonProgress').count()).toBe(1);
      expect(await driver.table!<{ domain: string; topic: string; score: number }>('studySessions').count()).toBe(1);
    });

    it.skipIf(driverCase.name === 'surrealdb')(
      'rolls back every write when the batch throws (Dexie only — Surreal tx is sequential best-effort)',
      async () => {
        const lessons = driver.table!<KeyedRow>('lessonProgress');
        await lessons.put(makeRow({ id: 'pre-existing', score: 1 }));

        await expect(
          driver.transaction!(['lessonProgress'], 'rw', async (tx) => {
            await tx.table<KeyedRow>('lessonProgress').put(makeRow({ id: 'doomed', score: 99 }));
            throw new Error('boom');
          }),
        ).rejects.toThrow('boom');

        // The doomed write rolled back; the pre-existing row is untouched.
        expect(await lessons.get('doomed')).toBeUndefined();
        expect((await lessons.get('pre-existing'))!.score).toBe(1);
      },
    );
  });
});

// ===========================================================================
// DATA-1 Phase 3 — the two previously-deferred stores now PERSIST + READ back
//
// Before the schema bump, abilitySnapshots.ts (PSY-11) and studyTrail.ts (NAV-1)
// wrote via getStorage().table('abilitySnapshots'|'studyTrail'), but those stores
// were not in the Dexie schema, so on the active Dexie backend every write hit the
// unknown-store path and silently no-op'd (recordAbilitySnapshot → false, the
// trail → trailed:false). Registering them in db.version(12) wires the SAME slice
// code to a live store. These tests call the REAL slice functions WITHOUT an
// injected table, so they exercise the production getStorage() path against the
// default Dexie driver + fake-indexeddb.
// ===========================================================================
describe('DATA-1 Phase 3 — deferred stores persist on the registered Dexie schema', () => {
  beforeEach(async () => {
    await db.abilitySnapshots.clear();
    await db.studyTrail.clear();
  });
  afterEach(async () => {
    await db.abilitySnapshots.clear();
    await db.studyTrail.clear();
  });

  it('abilitySnapshots: recordAbilitySnapshot now persists and reads back', async () => {
    const ok = await recordAbilitySnapshot({
      domain: 'cfa',
      theta: 0.42,
      uncertainty: 0.31,
      difficultyMapping: [{ id: 'item-1', b: 0.1, empiricalDifficulty: 0.6 }],
      at: '2026-06-10T00:00:00.000Z',
    });
    // The write now LANDS (was `false` on the unknown-store no-op path pre-bump).
    expect(ok).toBe(true);

    // Read back through the real slice path.
    const rows = await readAbilitySnapshots('cfa');
    expect(rows).toHaveLength(1);
    expect(rows[0].theta).toBe(0.42);
    expect(rows[0].uncertainty).toBe(0.31);
    expect(rows[0].difficultyMapping.items[0].id).toBe('item-1');

    // It is also visible on the raw registered Dexie store.
    expect(await db.abilitySnapshots.count()).toBe(1);

    const latest = await readLatestAbilitySnapshot('cfa');
    expect(latest?.at).toBe('2026-06-10T00:00:00.000Z');
  });

  it('abilitySnapshots: keyed by id (same id overwrites, distinct ids accumulate)', async () => {
    await recordAbilitySnapshot({
      domain: 'cfa',
      theta: 0.1,
      uncertainty: 0.5,
      difficultyMapping: [],
      at: '2026-06-10T00:00:00.000Z',
    });
    // Same domain + at → same id → idempotent overwrite.
    await recordAbilitySnapshot({
      domain: 'cfa',
      theta: 0.9,
      uncertainty: 0.2,
      difficultyMapping: [],
      at: '2026-06-10T00:00:00.000Z',
    });
    // Different timestamp → distinct id → accumulates.
    await recordAbilitySnapshot({
      domain: 'cfa',
      theta: 0.7,
      uncertainty: 0.3,
      difficultyMapping: [],
      at: '2026-06-11T00:00:00.000Z',
    });

    const rows = await readAbilitySnapshots('cfa');
    expect(rows).toHaveLength(2);
    // Oldest → newest by `at`; the overwrite kept the second theta.
    expect(rows[0].theta).toBe(0.9);
    expect(rows[1].theta).toBe(0.7);
  });

  it('studyTrail: recordStudyContext now persists and reads back', async () => {
    const { trailed } = await recordStudyContext({
      domain: 'cfa',
      route: '/cfa/lesson/abc',
      label: 'Ethics — Lesson 3',
      recordedAt: '2026-06-10T00:00:00.000Z',
    });
    // The durable trail write now LANDS (was `trailed:false` pre-bump).
    expect(trailed).toBe(true);

    const trail = await readStudyTrail({ domain: 'cfa' });
    expect(trail).toHaveLength(1);
    expect(trail[0].route).toBe('/cfa/lesson/abc');
    expect(trail[0].label).toBe('Ethics — Lesson 3');

    expect(await db.studyTrail.count()).toBe(1);
  });

  it('studyTrail: newest-first ordering across multiple recorded contexts', async () => {
    await recordStudyContext({ domain: 'cfa', route: '/a', label: 'A', recordedAt: '2026-06-10T00:00:00.000Z' });
    await recordStudyContext({ domain: 'cfa', route: '/b', label: 'B', recordedAt: '2026-06-11T00:00:00.000Z' });
    await recordStudyContext({ domain: 'lsat', route: '/c', label: 'C', recordedAt: '2026-06-12T00:00:00.000Z' });

    const all = await readStudyTrail();
    // Newest → oldest by recordedAt.
    expect(all.map((e) => e.route)).toEqual(['/c', '/b', '/a']);

    // Domain filter isolates the plane.
    const cfaOnly = await readStudyTrail({ domain: 'cfa' });
    expect(cfaOnly.map((e) => e.route)).toEqual(['/b', '/a']);
  });
});
