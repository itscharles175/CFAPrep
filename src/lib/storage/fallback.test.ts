import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createReadThroughDriver } from './fallbackDriver';
import type {
  MasterySnapshotStore,
  QuestionResultStore,
  ReviewItemStore,
  StorageDriver,
  StorageSettingRow,
} from './types';
import type { MasterySnapshot, QuestionResult, ReviewItem } from '../learningTypes';

// ---------------------------------------------------------------------------
// In-memory fake drivers — exercise the read-through wrapper without a live
// SurrealDB sidecar or IndexedDB.  Each store records its calls so we can prove
// reads fall back to the cache while writes stay on the primary.
// ---------------------------------------------------------------------------

function review(id: string): ReviewItem {
  return {
    id,
    domain: 'cfa',
    topic: 'quant',
    learningObjective: 'lo',
    title: id,
    path: `/cfa/${id}`,
    intervalDays: 3,
    ease: 2.5,
    fsrsDifficulty: 5,
    dueAt: '2026-06-01T09:00:00.000Z',
    attempts: 1,
    correctStreak: 1,
  } as ReviewItem;
}

function qResult(qid: string): QuestionResult {
  return {
    domain: 'cfa',
    topic: 'quant',
    questionId: qid,
    learningObjective: 'lo',
    correct: true,
    confidence: 'medium',
    errorCategory: 'none',
    difficulty: 'intermediate',
    createdAt: '2026-05-01T00:00:00.000Z',
  } as QuestionResult;
}

function mastery(id: string): MasterySnapshot {
  return {
    id,
    domain: 'cfa',
    topic: 'quant',
    learningObjective: 'lo',
    title: id,
    score: 70,
    attempts: 3,
    correct: 2,
    confidenceScore: 0.6,
    lastAttemptAt: '2026-05-01T00:00:00.000Z',
    trend: 'up',
  };
}

/**
 * A toggleable fake driver.  When `down` is true every READ rejects (simulating
 * a SurrealDB outage); WRITES always reject while down so we can prove the
 * wrapper surfaces them rather than diverting to the cache.  `ready()` reflects
 * `down` so the recovery probe can detect when the sidecar comes back.
 */
function makeFakeDriver(name: 'dexie' | 'surrealdb', seed: {
  settings?: StorageSettingRow[];
  reviewItems?: ReviewItem[];
  questionResults?: QuestionResult[];
  masterySnapshots?: MasterySnapshot[];
} = {}) {
  const state = { down: false };
  const calls = { reads: 0, writes: 0 };

  const settingsMap = new Map<string, StorageSettingRow>((seed.settings ?? []).map((r) => [r.key, r]));
  const reviewMap = new Map<string, ReviewItem>((seed.reviewItems ?? []).map((r) => [r.id, r]));
  const qrRows: QuestionResult[] = [...(seed.questionResults ?? [])];
  const masteryMap = new Map<string, MasterySnapshot>((seed.masterySnapshots ?? []).map((s) => [s.id, s]));

  function read<T>(fn: () => T): Promise<T> {
    calls.reads += 1;
    if (state.down) return Promise.reject(new Error(`${name} read failed: sidecar down`));
    return Promise.resolve(fn());
  }
  function write(fn: () => void): Promise<void> {
    calls.writes += 1;
    if (state.down) return Promise.reject(new Error(`${name} write failed: sidecar down`));
    fn();
    return Promise.resolve();
  }

  const reviewItems: ReviewItemStore = {
    get: (id) => read(() => reviewMap.get(id)),
    toArray: () => read(() => [...reviewMap.values()]),
    put: (item) => write(() => { reviewMap.set(item.id, item); }),
    bulkPut: (items) => write(() => { items.forEach((i) => reviewMap.set(i.id, i)); }),
    delete: (id) => write(() => { reviewMap.delete(id); }),
  };

  const questionResults: QuestionResultStore = {
    add: (r) => write(() => { qrRows.push(r); }),
    bulkAdd: (rs) => write(() => { qrRows.push(...rs); }),
    toArray: () => read(() => [...qrRows]),
    byTopic: (domain, topic) => read(() => qrRows.filter((r) => r.domain === domain && r.topic === topic)),
    clear: () => write(() => { qrRows.length = 0; }),
  };

  const masterySnapshots: MasterySnapshotStore = {
    get: (id) => read(() => masteryMap.get(id)),
    put: (snap) => write(() => { masteryMap.set(snap.id, snap); }),
    toArray: () => read(() => [...masteryMap.values()]),
  };

  const driver: StorageDriver = {
    name,
    ready: () => Promise.resolve(!state.down),
    settings: {
      get: (key) => read(() => settingsMap.get(key)),
      put: (row) => write(() => { settingsMap.set(row.key, row); }),
      delete: (key) => write(() => { settingsMap.delete(key); }),
      toArray: () => read(() => [...settingsMap.values()]),
      bulkDelete: (keys) => write(() => { keys.forEach((k) => settingsMap.delete(k)); }),
      clear: () => write(() => { settingsMap.clear(); }),
    },
    reviewItems,
    questionResults,
    masterySnapshots,
  };

  return { driver, state, calls };
}

describe('createReadThroughDriver', () => {
  let primary: ReturnType<typeof makeFakeDriver>;
  let fallback: ReturnType<typeof makeFakeDriver>;

  beforeEach(() => {
    primary = makeFakeDriver('surrealdb', {
      settings: [{ key: 'live', value: 'from-surreal', updatedAt: 't' }],
      reviewItems: [review('p1')],
      masterySnapshots: [mastery('pm1')],
      questionResults: [qResult('pq1')],
    });
    fallback = makeFakeDriver('dexie', {
      settings: [{ key: 'live', value: 'from-dexie-cache', updatedAt: 't' }],
      reviewItems: [review('c1')],
      masterySnapshots: [mastery('cm1')],
      questionResults: [qResult('cq1')],
    });
  });

  it('reports the primary driver name (transparent to callers)', () => {
    const wrapped = createReadThroughDriver(primary.driver, fallback.driver);
    expect(wrapped.name).toBe('surrealdb');
    expect(wrapped.isReadThrough).toBe(true);
    expect(wrapped.degraded).toBe(false);
  });

  it('serves reads from the primary while it is healthy', async () => {
    const wrapped = createReadThroughDriver(primary.driver, fallback.driver);
    const row = await wrapped.settings.get('live');
    expect(row?.value).toBe('from-surreal');
    expect(wrapped.degraded).toBe(false);
    // Cache untouched on the happy path.
    expect(fallback.calls.reads).toBe(0);
  });

  it('falls back to the Dexie cache when a primary read throws', async () => {
    const wrapped = createReadThroughDriver(primary.driver, fallback.driver);
    primary.state.down = true;

    const row = await wrapped.settings.get('live');
    expect(row?.value).toBe('from-dexie-cache');
    expect(wrapped.degraded).toBe(true);
    expect(fallback.calls.reads).toBe(1);
  });

  it('falls back for every read namespace (settings/reviewItems/questionResults/mastery)', async () => {
    const wrapped = createReadThroughDriver(primary.driver, fallback.driver);
    primary.state.down = true;

    expect((await wrapped.reviewItems!.toArray()).map((r) => r.id)).toEqual(['c1']);
    expect(await wrapped.reviewItems!.get('c1')).toBeDefined();
    expect((await wrapped.questionResults!.toArray()).map((q) => q.questionId)).toEqual(['cq1']);
    expect((await wrapped.questionResults!.byTopic('cfa', 'quant')).length).toBe(1);
    expect((await wrapped.masterySnapshots!.toArray()).map((m) => m.id)).toEqual(['cm1']);
    expect(await wrapped.masterySnapshots!.get('cm1')).toBeDefined();
    expect(wrapped.degraded).toBe(true);
  });

  it('routes writes to the primary and surfaces primary errors (no silent cache divert)', async () => {
    const wrapped = createReadThroughDriver(primary.driver, fallback.driver);
    primary.state.down = true;

    // The write must reject (primary down) — it must NOT silently land in cache.
    await expect(wrapped.settings.put({ key: 'x', value: 1, updatedAt: 't' })).rejects.toThrow(/surrealdb write failed/);
    await expect(wrapped.reviewItems!.put(review('x'))).rejects.toThrow();
    await expect(wrapped.questionResults!.add(qResult('x'))).rejects.toThrow();
    await expect(wrapped.masterySnapshots!.put(mastery('x'))).rejects.toThrow();

    // No write reached the Dexie cache.
    expect(fallback.calls.writes).toBe(0);
  });

  it('routes writes to the primary only while healthy', async () => {
    const wrapped = createReadThroughDriver(primary.driver, fallback.driver);
    await wrapped.settings.put({ key: 'new', value: 2, updatedAt: 't' });
    expect(primary.calls.writes).toBe(1);
    expect(fallback.calls.writes).toBe(0);
    // The new value reads back from the primary.
    expect((await wrapped.settings.get('new'))?.value).toBe(2);
  });

  it('clears the degraded flag when a subsequent primary read succeeds', async () => {
    const wrapped = createReadThroughDriver(primary.driver, fallback.driver);
    primary.state.down = true;
    await wrapped.settings.get('live'); // degrades
    expect(wrapped.degraded).toBe(true);

    primary.state.down = false; // sidecar recovers
    const row = await wrapped.settings.get('live'); // succeeds against primary
    expect(row?.value).toBe('from-surreal');
    expect(wrapped.degraded).toBe(false);
  });

  it('runs a background recovery probe and fires onRecover when the primary returns', async () => {
    // Manual scheduler — capture the probe fn instead of using real timers.
    let probeFn: (() => void) | null = null;
    const onRecover = vi.fn();
    const wrapped = createReadThroughDriver(primary.driver, fallback.driver, {
      onRecover,
      scheduleProbe: (fn) => { probeFn = fn; },
    });

    primary.state.down = true;
    await wrapped.settings.get('live'); // degrades + arms the probe
    expect(wrapped.degraded).toBe(true);
    expect(probeFn).toBeTypeOf('function');

    // Probe while still down → re-arms, stays degraded, onRecover not called.
    const first = probeFn!;
    probeFn = null;
    first();
    await Promise.resolve();
    await Promise.resolve();
    expect(wrapped.degraded).toBe(true);
    expect(onRecover).not.toHaveBeenCalled();
    expect(probeFn).toBeTypeOf('function'); // re-armed

    // Sidecar recovers; next probe clears degraded + fires onRecover.
    primary.state.down = false;
    const second = probeFn!;
    second();
    await Promise.resolve();
    await Promise.resolve();
    expect(wrapped.degraded).toBe(false);
    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  it('calls onDegrade exactly once per outage (not on every failed read)', async () => {
    const onDegrade = vi.fn();
    const wrapped = createReadThroughDriver(primary.driver, fallback.driver, {
      onDegrade,
      scheduleProbe: () => { /* never fire — stay degraded */ },
    });
    primary.state.down = true;
    await wrapped.settings.get('live');
    await wrapped.settings.get('live');
    await wrapped.reviewItems!.toArray();
    expect(onDegrade).toHaveBeenCalledTimes(1);
  });

  it('ready() reflects the primary and clears a stale degraded flag on success', async () => {
    const wrapped = createReadThroughDriver(primary.driver, fallback.driver, {
      scheduleProbe: () => { /* no auto-probe */ },
    });
    primary.state.down = true;
    await wrapped.settings.get('live'); // degrades
    expect(await wrapped.ready()).toBe(false);
    expect(wrapped.degraded).toBe(true);

    primary.state.down = false;
    expect(await wrapped.ready()).toBe(true);
    expect(wrapped.degraded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Registry wiring: switching to SurrealDB installs the read-through wrapper.
// ---------------------------------------------------------------------------
// Mock surrealdb so the sidecar appears reachable (ping resolves), letting the
// registry actually switch and wrap.  Mirrors the chunkSearch.test.ts pattern.

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
    async query() { return [[]]; }
    async select() { return []; }
    async upsert() {}
    async create() {}
    async delete() {}
  }
  return { Surreal, StringRecordId };
});

describe('storageRegistry wiring (read-through on surrealdb)', () => {
  beforeEach(async () => {
    const { resetSurrealClient } = await import('./surrealDriver');
    resetSurrealClient();
    const { storageRegistry } = await import('./index');
    storageRegistry.active = storageRegistry.drivers['dexie'];
  });

  it('wraps the surreal driver in the read-through fallback after a successful switch', async () => {
    const { storageRegistry, getStorage, getActiveDriverName, isStorageDegraded } = await import('./index');
    const result = await storageRegistry.switchDriver('surrealdb');
    expect(result.ok).toBe(true);

    const active = getStorage() as { isReadThrough?: boolean; fallback?: { name: string } };
    // Transparent name + driver shape — callers see 'surrealdb'.
    expect(getActiveDriverName()).toBe('surrealdb');
    expect(active.isReadThrough).toBe(true);
    expect(active.fallback?.name).toBe('dexie');
    // Healthy primary → not degraded.
    expect(isStorageDegraded()).toBe(false);
  });

  it('switching back to dexie discards the wrapper (raw dexie driver active)', async () => {
    const { storageRegistry, getStorage, isStorageDegraded } = await import('./index');
    await storageRegistry.switchDriver('surrealdb');
    await storageRegistry.switchDriver('dexie');

    const active = getStorage() as { isReadThrough?: boolean; name: string };
    expect(active.name).toBe('dexie');
    expect(active.isReadThrough).toBeUndefined();
    expect(isStorageDegraded()).toBe(false);
  });
});
