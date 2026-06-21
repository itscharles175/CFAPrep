import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { db, resetVaultData } from '../progressStore';

// ---------------------------------------------------------------------------
// DATA-1 Phase 3 — prove the additive Dexie v11 -> v12 upgrade preserves data.
//
// The finale (progressStore.ts) froze `db.version(11)` and added an INCREMENTAL
// `db.version(12).stores({ abilitySnapshots, studyTrail })`. Dexie carries
// forward every store from the prior version, so v12 only DECLARES the two new
// stores; all v11 data must survive the upgrade untouched.
//
// The production `db` singleton is already at v12 and cannot be re-versioned, so
// we cannot replay the upgrade on it directly. Instead we prove the MECHANISM on
// a fresh, uniquely-named Dexie DB that mirrors progressStore's additive bump on
// a small representative slice of the real schema:
//   - open at v11 with a couple of the real keyed stores, write rows, close;
//   - reopen on the SAME name declaring BOTH version(11) (identical stores) AND
//     version(12).stores({ abilitySnapshots, studyTrail }) — exactly the shape
//     progressStore uses (additive, only the new stores listed at v12).
// fake-indexeddb (src/setupTests.js -> 'fake-indexeddb/auto') backs Dexie
// headlessly, so this runs without a browser.
// ---------------------------------------------------------------------------

// Mirror progressStore's REAL v11 index strings for the two representative
// stores so the upgrade we replay is faithful to the production schema.
const V11_SETTINGS_SCHEMA = 'key';
const V11_REVIEW_ITEMS_SCHEMA = 'id, domain, topic, learningObjective, dueAt, ease, fsrsDifficulty, attempts';

// progressStore.ts v12 additive bump — the EXACT new-store index strings.
const V12_ADDED_STORES = {
  abilitySnapshots: 'id, domain, at, modelVersion',
  studyTrail: 'id, domain, recordedAt',
} as const;

describe('Dexie v11 -> v12 additive upgrade (representative mechanism)', () => {
  // Unique per-run DB name so this suite never collides with the production
  // 'quantvault' DB or any other parallel suite's fake-indexeddb namespace.
  let dbName: string;

  beforeEach(() => {
    dbName = `qv-schema-migration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(async () => {
    // Tear down the representative DB so fake-indexeddb state never leaks.
    await Dexie.delete(dbName);
  });

  it('preserves every v11 row and accepts round-trips in the two new v12 stores', async () => {
    // --- Phase 1: create a v11 DB, seed representative rows, close it. --------
    const v11 = new Dexie(dbName);
    v11.version(11).stores({
      settings: V11_SETTINGS_SCHEMA,
      reviewItems: V11_REVIEW_ITEMS_SCHEMA,
    });

    const settingRow = { key: 'storage-driver', value: 'dexie', updatedAt: '2026-06-01T00:00:00.000Z' };
    const reviewRow = {
      id: 'cfa::fixed-income::los-1',
      domain: 'cfa',
      topic: 'fixed-income',
      learningObjective: 'los-1',
      title: 'Modified duration',
      path: '/cfa/fixed-income/duration',
      intervalDays: 3,
      ease: 2.5,
      fsrsDifficulty: 5.1,
      dueAt: '2026-06-10T00:00:00.000Z',
      lastResultAt: '2026-06-01T00:00:00.000Z',
      attempts: 4,
      correctStreak: 2,
      lastCorrect: true,
      lastConfidence: 'high',
      lastErrorCategory: 'none',
    };

    await v11.table('settings').put(settingRow);
    await v11.table('reviewItems').put(reviewRow);
    v11.close();

    // --- Phase 2: reopen on the SAME name with BOTH v11 and the additive v12. -
    // This is the production shape: the prior version is re-declared unchanged,
    // and v12 lists ONLY the new stores. Opening triggers the upgrade.
    const v12 = new Dexie(dbName);
    v12.version(11).stores({
      settings: V11_SETTINGS_SCHEMA,
      reviewItems: V11_REVIEW_ITEMS_SCHEMA,
    });
    v12.version(12).stores(V12_ADDED_STORES);

    // (c) The upgrade itself must not throw — open() resolves cleanly.
    await expect(v12.open()).resolves.toBeDefined();
    expect(v12.verno).toBe(12);

    // (a) Every v11 row survived the upgrade intact.
    const survivedSetting = await v12.table('settings').get('storage-driver');
    expect(survivedSetting).toEqual(settingRow);

    const survivedReview = await v12.table('reviewItems').get('cfa::fixed-income::los-1');
    expect(survivedReview).toEqual(reviewRow);

    // The carried-forward stores still contain exactly the seeded rows.
    expect(await v12.table('settings').toArray()).toHaveLength(1);
    expect(await v12.table('reviewItems').toArray()).toHaveLength(1);

    // (b) The two NEW v12 stores exist and accept a put() + toArray() round-trip.
    const abilityRow = {
      id: 'snap-1',
      domain: 'cfa',
      at: '2026-06-11T00:00:00.000Z',
      modelVersion: 'host-cat-eap-1',
      theta: 0.42,
      uncertainty: 0.3,
    };
    const trailRow = {
      id: 'trail-1',
      domain: 'cfa',
      recordedAt: '2026-06-11T00:00:00.000Z',
      route: '/cfa/fixed-income/duration',
    };

    await v12.table('abilitySnapshots').put(abilityRow);
    await v12.table('studyTrail').put(trailRow);

    const abilityAll = await v12.table('abilitySnapshots').toArray();
    expect(abilityAll).toEqual([abilityRow]);

    const trailAll = await v12.table('studyTrail').toArray();
    expect(trailAll).toEqual([trailRow]);

    v12.close();
  });
});

// ---------------------------------------------------------------------------
// resetVaultData clears the derived (NOT-exported) stores on a 'full' reset, but
// the 'attempts' reset leaves them untouched. abilitySnapshots + studyTrail are
// in DERIVED_STORE_NAMES, which is only included in the 'full' table set — see
// progressStore.ts resetVaultData(): 'full' clears [...STORE_NAMES,
// ...SOURCE_STORE_NAMES, ...DERIVED_STORE_NAMES] while 'attempts' clears only
// ATTEMPT_TABLES (which excludes both derived stores).
// ---------------------------------------------------------------------------
describe('resetVaultData and the derived (full-reset-only) stores', () => {
  function seedAbility() {
    return db.abilitySnapshots.put({
      id: 'snap-reset',
      domain: 'cfa',
      at: '2026-06-11T00:00:00.000Z',
      modelVersion: 'host-cat-eap-1',
      theta: 0.1,
      uncertainty: 0.2,
      // difficultyMapping/calibrationResiduals are nested payload, not indexed.
      difficultyMapping: { slope: 1, intercept: 0 },
      calibrationResiduals: [],
    } as never);
  }

  function seedTrail() {
    return db.studyTrail.put({
      id: 'trail-reset',
      domain: 'cfa',
      recordedAt: '2026-06-11T00:00:00.000Z',
      route: '/cfa',
    } as never);
  }

  beforeEach(async () => {
    await db.abilitySnapshots.clear();
    await db.studyTrail.clear();
  });

  afterEach(async () => {
    await db.abilitySnapshots.clear();
    await db.studyTrail.clear();
  });

  it("resetVaultData('full') clears BOTH derived stores", async () => {
    await seedAbility();
    await seedTrail();
    expect(await db.abilitySnapshots.count()).toBe(1);
    expect(await db.studyTrail.count()).toBe(1);

    await resetVaultData('full');

    expect(await db.abilitySnapshots.toArray()).toHaveLength(0);
    expect(await db.studyTrail.toArray()).toHaveLength(0);
  });

  it("resetVaultData('attempts') does NOT clear the derived stores", async () => {
    await seedAbility();
    await seedTrail();

    await resetVaultData('attempts');

    // Derived telemetry is full-reset-only; an attempts wipe leaves it intact.
    expect(await db.abilitySnapshots.count()).toBe(1);
    expect(await db.studyTrail.count()).toBe(1);
  });
});
