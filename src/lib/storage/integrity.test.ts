import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../progressStore';
import type {
  MasterySnapshotStore,
  QuestionResultStore,
  ReviewItemStore,
  StorageDriver,
  StorageSettingRow,
} from './types';
import type { MasterySnapshot, QuestionResult, ReviewItem } from '../learningTypes';
import {
  canonicalJson,
  computeStoreDigest,
  computeVaultDigest,
  verifyMigration,
  VERIFIED_NAMESPACES,
} from './integrity';
import {
  cutoverTo,
  getActiveDriverName,
  getStoredStoragePreference,
  setStoredStoragePreference,
  STORAGE_PREF_KEY,
  storageRegistry,
} from './index';

// ===========================================================================
// DATA-3 — post-migration integrity verification + auto-rollback
// ===========================================================================
//
// Fully OFFLINE: the digest/verify suites use in-memory fake drivers (no
// IndexedDB needed); the cutover-with-verify suite registers a fake 'surrealdb'
// driver directly into the registry so `switchDriver` uses it instead of lazy-
// loading the real SurrealDB client — no :8000 sidecar is ever contacted.

// ---------------------------------------------------------------------------
// In-memory fake stores (mirror migrate.test.ts) — one per namespace.
// ---------------------------------------------------------------------------
function makeSettings(seed: StorageSettingRow[] = []) {
  const map = new Map<string, StorageSettingRow>(seed.map((r) => [r.key, r]));
  const store: StorageDriver['settings'] = {
    async get(key) {
      return map.get(key);
    },
    async put(row) {
      map.set(row.key, row);
    },
    async delete(key) {
      map.delete(key);
    },
    async toArray() {
      return [...map.values()];
    },
    async bulkDelete(keys) {
      keys.forEach((k) => map.delete(k));
    },
    async clear() {
      map.clear();
    },
  };
  return { map, store };
}

function makeReviewItems(seed: ReviewItem[] = []) {
  const map = new Map<string, ReviewItem>(seed.map((r) => [r.id, r]));
  const store: ReviewItemStore = {
    async get(id) {
      return map.get(id);
    },
    async put(item) {
      map.set(item.id, item);
    },
    async bulkPut(items) {
      items.forEach((i) => map.set(i.id, i));
    },
    async toArray() {
      return [...map.values()];
    },
    async delete(id) {
      map.delete(id);
    },
  };
  return { map, store };
}

function makeQuestionResults(seed: QuestionResult[] = []) {
  const rows: QuestionResult[] = [...seed];
  const store: QuestionResultStore = {
    async add(result) {
      rows.push(result);
    },
    async bulkAdd(results) {
      rows.push(...results);
    },
    async toArray() {
      return [...rows];
    },
    async byTopic(domain, topic) {
      return rows.filter((r) => r.domain === domain && r.topic === topic);
    },
    async clear() {
      rows.length = 0;
    },
  };
  return { rows, store };
}

function makeMastery(seed: MasterySnapshot[] = []) {
  const map = new Map<string, MasterySnapshot>(seed.map((s) => [s.id, s]));
  const store: MasterySnapshotStore = {
    async get(id) {
      return map.get(id);
    },
    async put(snap) {
      map.set(snap.id, snap);
    },
    async toArray() {
      return [...map.values()];
    },
  };
  return { map, store };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function review(id: string, overrides: Partial<ReviewItem> = {}): ReviewItem {
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
    lastResultAt: '2026-05-28T00:00:00.000Z',
    attempts: 1,
    correctStreak: 1,
    lastCorrect: true,
    lastConfidence: 'high',
    lastErrorCategory: 'none',
    ...overrides,
  };
}

function qResult(qid: string, overrides: Partial<QuestionResult> = {}): QuestionResult {
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
    ...overrides,
  };
}

function mastery(id: string, overrides: Partial<MasterySnapshot> = {}): MasterySnapshot {
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
    ...overrides,
  };
}

interface BuiltParts {
  settings: ReturnType<typeof makeSettings>;
  reviewItems: ReturnType<typeof makeReviewItems>;
  questionResults: ReturnType<typeof makeQuestionResults>;
  masterySnapshots: ReturnType<typeof makeMastery>;
}

function buildParts(seed: boolean): BuiltParts {
  return {
    settings: makeSettings(
      seed ? [{ key: 'a', value: 1, updatedAt: 't' }, { key: 'b', value: 2, updatedAt: 't' }] : [],
    ),
    reviewItems: makeReviewItems(seed ? [review('r1'), review('r2')] : []),
    questionResults: makeQuestionResults(seed ? [qResult('q1'), qResult('q2'), qResult('q3')] : []),
    masterySnapshots: makeMastery(seed ? [mastery('m1')] : []),
  };
}

function assemble(parts: BuiltParts, name: 'dexie' | 'surrealdb'): StorageDriver {
  return {
    name,
    async ready() {
      return true;
    },
    settings: parts.settings.store,
    reviewItems: parts.reviewItems.store,
    questionResults: parts.questionResults.store,
    masterySnapshots: parts.masterySnapshots.store,
  };
}

// ===========================================================================
// canonicalJson — key-order independence (the property the digest relies on)
// ===========================================================================
describe('canonicalJson', () => {
  it('serializes objects with sorted keys (insertion order independent)', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it('sorts keys recursively in nested objects', () => {
    expect(canonicalJson({ x: { d: 1, c: 2 } })).toBe(canonicalJson({ x: { c: 2, d: 1 } }));
  });

  it('preserves array element order (arrays are not reordered)', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('treats a present-but-undefined field as absent (matches JSON.stringify)', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});

// ===========================================================================
// computeStoreDigest / computeVaultDigest
// ===========================================================================
describe('computeStoreDigest / computeVaultDigest', () => {
  it('produces a 64-char hex hash + an accurate count per namespace', async () => {
    const driver = assemble(buildParts(true), 'dexie');
    const digest = await computeStoreDigest(driver, 'reviewItems');
    expect(digest.count).toBe(2);
    expect(digest.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('two drivers with the SAME logical data produce identical digests', async () => {
    const a = assemble(buildParts(true), 'dexie');
    const b = assemble(buildParts(true), 'surrealdb');
    expect(await computeVaultDigest(a)).toEqual(await computeVaultDigest(b));
  });

  it('is row-order independent (append-only log digest is set-based)', async () => {
    const forward = assemble(
      {
        ...buildParts(false),
        questionResults: makeQuestionResults([qResult('q1'), qResult('q2'), qResult('q3')]),
      },
      'dexie',
    );
    const reversed = assemble(
      {
        ...buildParts(false),
        questionResults: makeQuestionResults([qResult('q3'), qResult('q2'), qResult('q1')]),
      },
      'surrealdb',
    );
    const f = await computeStoreDigest(forward, 'questionResults');
    const r = await computeStoreDigest(reversed, 'questionResults');
    expect(f).toEqual(r);
  });

  it('an omitted optional namespace digests as the empty set (count 0)', async () => {
    const partial: StorageDriver = {
      name: 'surrealdb',
      async ready() {
        return true;
      },
      settings: makeSettings().store,
      // no reviewItems / questionResults / masterySnapshots
    };
    const empty = assemble(buildParts(false), 'dexie');
    expect(await computeStoreDigest(partial, 'reviewItems')).toEqual(
      await computeStoreDigest(empty, 'reviewItems'),
    );
  });

  it('covers exactly the migrate-able namespaces (chunks excluded)', () => {
    expect([...VERIFIED_NAMESPACES]).toEqual([
      'settings',
      'reviewItems',
      'questionResults',
      'masterySnapshots',
    ]);
  });

  it('questionResults digest ignores the backend-assigned auto-id (same content, different ids → match)', async () => {
    const withId = (qid: string, id: number) => ({ ...qResult(qid), id }) as unknown as QuestionResult;
    const a = assemble(
      { ...buildParts(false), questionResults: makeQuestionResults([withId('q1', 1), withId('q2', 2)]) },
      'dexie',
    );
    const b = assemble(
      { ...buildParts(false), questionResults: makeQuestionResults([withId('q1', 901), withId('q2', 902)]) },
      'surrealdb',
    );
    // Dexie ++id vs SurrealDB record id differ, but the rows are the same log.
    expect(await computeStoreDigest(a, 'questionResults')).toEqual(
      await computeStoreDigest(b, 'questionResults'),
    );
  });

  it('questionResults digest still catches a CONTENT difference (not just id)', async () => {
    const a = assemble(
      { ...buildParts(false), questionResults: makeQuestionResults([{ ...qResult('q1'), id: 1 } as unknown as QuestionResult]) },
      'dexie',
    );
    const b = assemble(
      {
        ...buildParts(false),
        questionResults: makeQuestionResults([
          { ...qResult('q1', { correct: false }), id: 1 } as unknown as QuestionResult,
        ]),
      },
      'surrealdb',
    );
    const da = await computeStoreDigest(a, 'questionResults');
    const db2 = await computeStoreDigest(b, 'questionResults');
    expect(da.hash).not.toBe(db2.hash);
  });
});

// ===========================================================================
// verifyMigration — identical → ok; injected drift → mismatch
// ===========================================================================
describe('verifyMigration', () => {
  it('reports ok when source and target hold identical data', async () => {
    const source = assemble(buildParts(true), 'dexie');
    const target = assemble(buildParts(true), 'surrealdb');
    const report = await verifyMigration(source, target);
    expect(report.ok).toBe(true);
    expect(report.mismatches).toHaveLength(0);
    expect(report.perNamespace).toHaveLength(VERIFIED_NAMESPACES.length);
    expect(report.perNamespace.every((n) => n.match)).toBe(true);
  });

  it('flags a MISSING row (count + hash diverge)', async () => {
    const source = assemble(buildParts(true), 'dexie');
    // Target dropped one reviewItem.
    const targetParts = buildParts(true);
    targetParts.reviewItems.map.delete('r2');
    const target = assemble(targetParts, 'surrealdb');

    const report = await verifyMigration(source, target);
    expect(report.ok).toBe(false);
    const ri = report.perNamespace.find((n) => n.namespace === 'reviewItems')!;
    expect(ri.match).toBe(false);
    expect(ri.sourceCount).toBe(2);
    expect(ri.targetCount).toBe(1);
    expect(report.mismatches.map((m) => m.namespace)).toContain('reviewItems');
  });

  it('flags a CHANGED field even when the count matches (hash diverges)', async () => {
    const source = assemble(buildParts(true), 'dexie');
    const targetParts = buildParts(true);
    // Same count, but one row's score was corrupted in transit.
    targetParts.masterySnapshots.map.set('m1', mastery('m1', { score: 99 }));
    const target = assemble(targetParts, 'surrealdb');

    const report = await verifyMigration(source, target);
    expect(report.ok).toBe(false);
    const ms = report.perNamespace.find((n) => n.namespace === 'masterySnapshots')!;
    expect(ms.match).toBe(false);
    // Count is equal — the HASH is what caught the corruption.
    expect(ms.sourceCount).toBe(ms.targetCount);
    expect(ms.sourceHash).not.toBe(ms.targetHash);
  });

  it('flags an EXTRA row (duplicated append-only attempt)', async () => {
    const source = assemble(buildParts(true), 'dexie');
    const targetParts = buildParts(true);
    // An extra question result slipped into the target (double-run duplication).
    targetParts.questionResults.rows.push(qResult('q4'));
    const target = assemble(targetParts, 'surrealdb');

    const report = await verifyMigration(source, target);
    expect(report.ok).toBe(false);
    const qr = report.perNamespace.find((n) => n.namespace === 'questionResults')!;
    expect(qr.match).toBe(false);
    expect(qr.sourceCount).toBe(3);
    expect(qr.targetCount).toBe(4);
  });
});

// ===========================================================================
// cutoverTo — auto-rollback when post-migration verification fails
// ===========================================================================
describe('cutoverTo integrity rollback', () => {
  beforeEach(() => {
    storageRegistry.active = storageRegistry.drivers['dexie'];
    try {
      localStorage.removeItem(STORAGE_PREF_KEY);
    } catch {
      /* ignore */
    }
  });

  afterEach(async () => {
    // Restore the registry to a clean Dexie-only state for other suites.
    storageRegistry.active = storageRegistry.drivers['dexie'];
    delete storageRegistry.drivers['surrealdb'];
    await db.settings.clear();
    await db.reviewItems.clear();
    await db.questionResults.clear();
    await db.masterySnapshots.clear();
    try {
      localStorage.removeItem(STORAGE_PREF_KEY);
    } catch {
      /* ignore */
    }
  });

  /**
   * Build a fake 'surrealdb' target whose `reviewItems.bulkPut` silently drops
   * a row, so `migrateData` returns successfully but the copy is INCOMPLETE —
   * exactly the silent-loss scenario DATA-3 must catch. Registering it into
   * `storageRegistry.drivers['surrealdb']` makes `switchDriver('surrealdb')`
   * use it instead of lazy-loading the real SurrealDB client (offline).
   */
  function registerLossyTarget(): void {
    const target = assemble(buildParts(false), 'surrealdb');
    const realBulkPut = target.reviewItems!.bulkPut.bind(target.reviewItems);
    target.reviewItems!.bulkPut = async (items) => {
      // Drop the last row — count + hash will diverge from the source.
      await realBulkPut(items.slice(0, -1));
    };
    storageRegistry.drivers['surrealdb'] = target;
  }

  it('rolls back and refuses to persist the preference when verification fails', async () => {
    // Seed the active Dexie source with data to migrate.
    await db.settings.put({ key: 'a', value: 1, updatedAt: 't' });
    await db.reviewItems.bulkPut([review('r1'), review('r2'), review('r3')]);

    registerLossyTarget();

    const result = await cutoverTo('surrealdb');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/integrity check failed/i);
    expect(result.error).toMatch(/rolled back to 'dexie'/);
    expect(result.verification).toBeDefined();
    expect(result.verification!.ok).toBe(false);
    expect(result.verification!.mismatches.map((m) => m.namespace)).toContain('reviewItems');

    // Active driver rolled back to Dexie; preference NOT persisted.
    expect(getActiveDriverName()).toBe('dexie');
    expect(getStoredStoragePreference()).toBe('dexie');
  });

  it('commits and persists the preference when verification passes', async () => {
    await db.settings.put({ key: 'a', value: 1, updatedAt: 't' });
    await db.reviewItems.bulkPut([review('r1'), review('r2')]);
    await db.masterySnapshots.put(mastery('m1'));

    // A faithful (non-lossy) fake target.
    storageRegistry.drivers['surrealdb'] = assemble(buildParts(false), 'surrealdb');

    const result = await cutoverTo('surrealdb');

    expect(result.ok).toBe(true);
    expect(result.verification?.ok).toBe(true);
    expect(getActiveDriverName()).toBe('surrealdb');
    expect(getStoredStoragePreference()).toBe('surrealdb');

    // Clean up: roll the active driver back for the afterEach reset.
    setStoredStoragePreference('dexie');
  });

  it('force overwrites a NON-EMPTY target: append-only log ends at the source count (not doubled)', async () => {
    // Seed the Dexie source with settings + a 3-row append-only attempt log.
    await db.settings.put({ key: 'a', value: 1, updatedAt: 't' });
    await db.questionResults.bulkAdd(
      [qResult('q1'), qResult('q2'), qResult('q3')] as Parameters<typeof db.questionResults.bulkAdd>[0],
    );

    // Seed the FAKE surrealdb target so it ALREADY holds rows — this makes the
    // dry-run manifest UNSAFE (a normal cutover would refuse). The target's
    // pre-existing questionResults differ from the source so a duplicating
    // (non-clearing) copy would leave 3 + 3 = 6 rows.
    const target = assemble(
      {
        ...buildParts(false),
        questionResults: makeQuestionResults([qResult('old1'), qResult('old2'), qResult('old3')]),
      },
      'surrealdb',
    );
    storageRegistry.drivers['surrealdb'] = target;

    const result = await cutoverTo('surrealdb', { force: true });

    expect(result.ok).toBe(true);
    expect(result.verification?.ok).toBe(true);

    // overwrite cleared the target log FIRST, so the count equals the source (3),
    // proving it was NOT appended on top of the pre-existing 3 rows.
    const targetCount = (await target.questionResults!.toArray()).length;
    const sourceCount = (await db.questionResults.toArray()).length;
    expect(targetCount).toBe(sourceCount);
    expect(targetCount).toBe(3);

    expect(getActiveDriverName()).toBe('surrealdb');
    expect(getStoredStoragePreference()).toBe('surrealdb');

    // Clean up: roll the active driver back for the afterEach reset.
    setStoredStoragePreference('dexie');
  });

  it('WITHOUT force, refuses a non-empty target and surfaces the unsafe manifest blocker', async () => {
    await db.settings.put({ key: 'a', value: 1, updatedAt: 't' });
    await db.questionResults.bulkAdd(
      [qResult('q1'), qResult('q2'), qResult('q3')] as Parameters<typeof db.questionResults.bulkAdd>[0],
    );

    // Same pre-seeded (non-empty) target as the force case, but no force flag.
    const target = assemble(
      {
        ...buildParts(false),
        questionResults: makeQuestionResults([qResult('old1'), qResult('old2'), qResult('old3')]),
      },
      'surrealdb',
    );
    storageRegistry.drivers['surrealdb'] = target;

    const result = await cutoverTo('surrealdb');

    expect(result.ok).toBe(false);
    expect(result.manifest).toBeDefined();
    expect(result.manifest!.safe).toBe(false);
    expect(result.manifest!.blockers.length).toBeGreaterThan(0);
    expect(result.manifest!.blockers.some((b) => b.includes('questionResults'))).toBe(true);
    expect(result.error).toMatch(/Refusing cutover/i);

    // The target log was NOT touched (no migration ran) and the active driver
    // rolled back to Dexie; the preference is never persisted on a refusal.
    expect((await target.questionResults!.toArray()).length).toBe(3);
    expect(getActiveDriverName()).toBe('dexie');
    expect(getStoredStoragePreference()).toBe('dexie');
  });
});
