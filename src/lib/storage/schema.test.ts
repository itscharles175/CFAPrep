import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../progressStore';
import { dexieDriver } from './dexieDriver';
import type { MasterySnapshot, QuestionResult, ReviewItem } from '../learningTypes';

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

// ===========================================================================
// Dexie driver — unified-schema namespaces
// ===========================================================================
describe('dexieDriver.reviewItems', () => {
  beforeEach(async () => {
    await db.reviewItems.clear();
  });

  it('put then get round-trips a review item', async () => {
    const item = makeReviewItem();
    await dexieDriver.reviewItems!.put(item);

    const fetched = await dexieDriver.reviewItems!.get(item.id);
    expect(fetched).toEqual(item);

    // Direct against the underlying Dexie table.
    const direct = await db.reviewItems.get(item.id);
    expect(direct?.dueAt).toBe(item.dueAt);
  });

  it('bulkPut + toArray returns every item', async () => {
    const items = [
      makeReviewItem({ id: 'a', topic: 'equity' }),
      makeReviewItem({ id: 'b', topic: 'derivatives' }),
      makeReviewItem({ id: 'c', topic: 'fixed-income' }),
    ];
    await dexieDriver.reviewItems!.bulkPut(items);

    const all = await dexieDriver.reviewItems!.toArray();
    expect(all).toHaveLength(3);
    expect(all.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('delete removes a single item', async () => {
    await dexieDriver.reviewItems!.put(makeReviewItem({ id: 'keep' }));
    await dexieDriver.reviewItems!.put(makeReviewItem({ id: 'drop' }));
    await dexieDriver.reviewItems!.delete('drop');

    expect(await dexieDriver.reviewItems!.get('drop')).toBeUndefined();
    expect(await dexieDriver.reviewItems!.get('keep')).toBeDefined();
  });
});

describe('dexieDriver.questionResults', () => {
  beforeEach(async () => {
    await db.questionResults.clear();
  });

  it('add + toArray records the attempt (Dexie assigns the id)', async () => {
    const result = makeResult();
    await dexieDriver.questionResults!.add(result);

    const all = await dexieDriver.questionResults!.toArray();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject(result);
    // Dexie auto-incremented an id even though QuestionResult carries none.
    expect((all[0] as QuestionResult & { id?: number }).id).toBeDefined();
  });

  it('bulkAdd inserts every attempt', async () => {
    await dexieDriver.questionResults!.bulkAdd([
      makeResult({ questionId: 'q-1' }),
      makeResult({ questionId: 'q-2' }),
      makeResult({ questionId: 'q-3' }),
    ]);
    const all = await dexieDriver.questionResults!.toArray();
    expect(all).toHaveLength(3);
  });

  it('byTopic filters by domain + topic', async () => {
    await dexieDriver.questionResults!.bulkAdd([
      makeResult({ questionId: 'a', domain: 'cfa', topic: 'fixed-income' }),
      makeResult({ questionId: 'b', domain: 'cfa', topic: 'equity' }),
      makeResult({ questionId: 'c', domain: 'quant', topic: 'fixed-income' }),
      makeResult({ questionId: 'd', domain: 'cfa', topic: 'fixed-income' }),
    ]);

    const hits = await dexieDriver.questionResults!.byTopic('cfa', 'fixed-income');
    expect(hits).toHaveLength(2);
    for (const h of hits) {
      expect(h.domain).toBe('cfa');
      expect(h.topic).toBe('fixed-income');
    }
    expect(hits.map((h) => h.questionId).sort()).toEqual(['a', 'd']);
  });

  it('clear empties the log', async () => {
    await dexieDriver.questionResults!.add(makeResult());
    await dexieDriver.questionResults!.clear();
    expect(await dexieDriver.questionResults!.toArray()).toHaveLength(0);
  });
});

describe('dexieDriver.masterySnapshots', () => {
  beforeEach(async () => {
    await db.masterySnapshots.clear();
  });

  it('put + get + toArray round-trips a snapshot', async () => {
    const snap = makeSnapshot();
    await dexieDriver.masterySnapshots!.put(snap);

    const fetched = await dexieDriver.masterySnapshots!.get(snap.id);
    expect(fetched).toEqual(snap);

    const all = await dexieDriver.masterySnapshots!.toArray();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(snap.id);
  });

  it('put upserts (same id overwrites)', async () => {
    await dexieDriver.masterySnapshots!.put(makeSnapshot({ score: 50 }));
    await dexieDriver.masterySnapshots!.put(makeSnapshot({ score: 90 }));
    const all = await dexieDriver.masterySnapshots!.toArray();
    expect(all).toHaveLength(1);
    expect(all[0].score).toBe(90);
  });
});

// ===========================================================================
// SurrealDB driver — unified-schema namespaces (mocked client)
// ===========================================================================
//
// Mirrors the chunkSearch.test.ts mocking pattern: a hoisted state object
// captures schema/query/upsert/create/delete traffic so the suite never needs
// a live :8000 sidecar.

const surrealState = vi.hoisted(() => {
  return {
    schemaCalls: 0,
    queryCalls: [] as Array<{ sql: string; binds: Record<string, unknown> | undefined }>,
    selectCalls: [] as Array<{ target: string }>,
    upsertCalls: [] as Array<{ id: string; payload: unknown }>,
    createCalls: [] as Array<{ table: unknown; payload: unknown }>,
    deleteCalls: [] as Array<{ target: string }>,
    nextQueryResult: null as unknown,
    nextSelectResult: null as unknown,
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
    async create(table: unknown, payload: unknown): Promise<void> {
      surrealState.createCalls.push({ table, payload });
    }
    async select(target?: unknown): Promise<unknown> {
      surrealState.selectCalls.push({
        target: target instanceof StringRecordId ? target.rid : String(target),
      });
      if (surrealState.nextSelectResult != null) {
        const out = surrealState.nextSelectResult;
        surrealState.nextSelectResult = null;
        return out;
      }
      return [];
    }
    async delete(target: unknown): Promise<void> {
      surrealState.deleteCalls.push({
        target: target instanceof StringRecordId ? target.rid : String(target),
      });
    }
  }
  return { Surreal, StringRecordId };
});

describe('surrealDriver unified-schema namespaces (mocked client)', () => {
  beforeEach(async () => {
    surrealState.schemaCalls = 0;
    surrealState.queryCalls = [];
    surrealState.selectCalls = [];
    surrealState.upsertCalls = [];
    surrealState.createCalls = [];
    surrealState.deleteCalls = [];
    surrealState.nextQueryResult = null;
    surrealState.nextSelectResult = null;
    const mod = await import('./surrealDriver');
    mod.resetSurrealClient();
  });

  it('reviewItems.put issues a StringRecordId-keyed upsert into review_items', async () => {
    const { surrealDriver } = await import('./surrealDriver');
    await surrealDriver.reviewItems!.put(makeReviewItem({ id: 'weird id*x' }));

    expect(surrealState.upsertCalls).toHaveLength(1);
    expect(surrealState.upsertCalls[0].id).toBe('review_items:weird_id_x');
    expect(surrealState.upsertCalls[0].payload).toMatchObject({ domain: 'cfa', topic: 'fixed-income' });
  });

  it('reviewItems.bulkPut issues a batched FOR/UPSERT query carrying every item', async () => {
    const { surrealDriver } = await import('./surrealDriver');
    await surrealDriver.reviewItems!.bulkPut([
      makeReviewItem({ id: 'a' }),
      makeReviewItem({ id: 'b' }),
    ]);

    const upsertQueries = surrealState.queryCalls.filter((q) => q.sql.includes('UPSERT'));
    expect(upsertQueries).toHaveLength(1);
    expect(upsertQueries[0].sql).toMatch(/FOR \$r IN \$rows/);
    expect(upsertQueries[0].sql).toMatch(/type::thing\('review_items', \$r\._id\)/);
    const binds = upsertQueries[0].binds as { rows: Array<{ _id: string }> };
    expect(binds.rows.map((r) => r._id)).toEqual(['a', 'b']);
  });

  it('reviewItems.delete targets the StringRecordId', async () => {
    const { surrealDriver } = await import('./surrealDriver');
    await surrealDriver.reviewItems!.delete('a');
    expect(surrealState.deleteCalls).toEqual([{ target: 'review_items:a' }]);
  });

  it('questionResults.add issues a CREATE into question_results', async () => {
    const { surrealDriver } = await import('./surrealDriver');
    await surrealDriver.questionResults!.add(makeResult());
    expect(surrealState.createCalls).toHaveLength(1);
    expect(surrealState.createCalls[0].table).toBe('question_results');
    expect(surrealState.createCalls[0].payload).toMatchObject({ questionId: 'q-1', correct: true });
  });

  it('questionResults.bulkAdd issues a batched FOR/CREATE query', async () => {
    const { surrealDriver } = await import('./surrealDriver');
    await surrealDriver.questionResults!.bulkAdd([makeResult({ questionId: 'q-1' }), makeResult({ questionId: 'q-2' })]);
    const createQueries = surrealState.queryCalls.filter((q) => q.sql.includes('CREATE question_results'));
    expect(createQueries).toHaveLength(1);
    expect(createQueries[0].sql).toMatch(/FOR \$q IN \$rows/);
    const binds = createQueries[0].binds as { rows: QuestionResult[] };
    expect(binds.rows.map((r) => r.questionId)).toEqual(['q-1', 'q-2']);
  });

  it('questionResults.byTopic binds domain + topic into the SELECT', async () => {
    const { surrealDriver } = await import('./surrealDriver');
    surrealState.nextQueryResult = [[{ domain: 'cfa', topic: 'fixed-income', questionId: 'q-1' }]];
    const rows = await surrealDriver.questionResults!.byTopic('cfa', 'fixed-income');

    const selectQuery = surrealState.queryCalls.find((q) => q.sql.startsWith('SELECT * FROM question_results'));
    expect(selectQuery).toBeDefined();
    expect(selectQuery!.sql).toMatch(/WHERE domain = \$d AND topic = \$t/);
    expect(selectQuery!.binds).toEqual({ d: 'cfa', t: 'fixed-income' });
    expect(rows).toHaveLength(1);
    expect(rows[0].questionId).toBe('q-1');
  });

  it('masterySnapshots.put issues a StringRecordId-keyed upsert into mastery_snapshots', async () => {
    const { surrealDriver } = await import('./surrealDriver');
    await surrealDriver.masterySnapshots!.put(makeSnapshot({ id: 'cfa::fi::los-1' }));
    expect(surrealState.upsertCalls).toHaveLength(1);
    expect(surrealState.upsertCalls[0].id).toBe('mastery_snapshots:cfa__fi__los-1');
    expect(surrealState.upsertCalls[0].payload).toMatchObject({ score: 72 });
  });

  it('masterySnapshots.get returns the row with its string id restored', async () => {
    const { surrealDriver } = await import('./surrealDriver');
    surrealState.nextSelectResult = { domain: 'cfa', topic: 'fixed-income', score: 88 };
    const snap = await surrealDriver.masterySnapshots!.get('cfa::fi::los-1');
    expect(snap).toBeDefined();
    expect(snap!.id).toBe('cfa::fi::los-1');
    expect(snap!.score).toBe(88);
  });

  it('settings use encoded record ids while preserving the original key payload', async () => {
    const { surrealDriver } = await import('./surrealDriver');
    const row = {
      key: 'open-notebook:settings',
      value: { enabled: true },
      updatedAt: '2026-06-10T00:00:00.000Z',
    };

    await surrealDriver.settings.put(row);
    surrealState.nextSelectResult = row;
    const fetched = await surrealDriver.settings.get(row.key);
    await surrealDriver.settings.delete(row.key);

    const encodedId = 'setting:k_6f70656e2d6e6f7465626f6f6b3a73657474696e6773';
    expect(surrealState.upsertCalls[0].id).toBe(encodedId);
    expect(surrealState.upsertCalls[0].payload).toEqual(row);
    expect(surrealState.selectCalls[0].target).toBe(encodedId);
    expect(surrealState.deleteCalls[0].target).toBe(encodedId);
    expect(fetched).toEqual(row);
  });

  it('settings.bulkDelete encodes every requested key', async () => {
    const { surrealDriver } = await import('./surrealDriver');
    await surrealDriver.settings.bulkDelete(['a:b', 'a*b']);

    expect(surrealState.deleteCalls.map((call) => call.target)).toEqual([
      'setting:k_613a62',
      'setting:k_612a62',
    ]);
  });

  it('schema-creation runs exactly once across reviewItems + questionResults + masterySnapshots calls', async () => {
    const { surrealDriver } = await import('./surrealDriver');
    await surrealDriver.reviewItems!.put(makeReviewItem());
    await surrealDriver.questionResults!.add(makeResult());
    surrealState.nextQueryResult = [[]];
    await surrealDriver.questionResults!.byTopic('cfa', 'fixed-income');
    await surrealDriver.masterySnapshots!.put(makeSnapshot());
    await surrealDriver.reviewItems!.toArray();

    expect(surrealState.schemaCalls).toBe(1);
  });
});
