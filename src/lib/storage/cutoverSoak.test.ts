import { afterEach, describe, expect, it } from 'vitest';
import { createDualWriteDriver } from './dualWriteDriver';
import {
  abortDualWriteSoak,
  commitDualWriteSoak,
  getDualWriteSoakStatus,
  getStoredStoragePreference,
  isDualWriteSoak,
  STORAGE_PREF_KEY,
  storageRegistry,
} from './index';
import type { StorageDriver, StorageSettingRow } from './types';

// ===========================================================================
// DATA-5b — dual-write soak lifecycle (abort resync / commit / status).
//
// Injects a dual-write driver directly as the active registry driver (bypassing
// beginDualWriteSoak, which needs a live :8000 sidecar) so the abort/commit/
// status logic is exercised fully offline.
// ===========================================================================

function memDriver(name: 'dexie' | 'surrealdb', seed: StorageSettingRow[] = []) {
  const map = new Map<string, StorageSettingRow>(seed.map((r) => [r.key, r]));
  // `failWrites` mirrors dualWriteDriver.test.ts's makeMemDriver toggle: when on,
  // settings put/delete throw so the dual-write shadow path can be made to fail
  // mid-soak (best-effort shadow → primary-only writes + shadowHealthy=false).
  let failWrites = false;
  const driver: StorageDriver = {
    name,
    async ready() {
      return true;
    },
    settings: {
      async get(key) {
        return map.get(key);
      },
      async put(row) {
        if (failWrites) throw new Error(`${name} settings.put down`);
        map.set(row.key, row);
      },
      async delete(key) {
        if (failWrites) throw new Error(`${name} settings.delete down`);
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
    },
  };
  return {
    driver,
    map,
    setFailWrites: (v: boolean) => {
      failWrites = v;
    },
  };
}

function setting(key: string, value: unknown): StorageSettingRow {
  return { key, value, updatedAt: 't' };
}

describe('dual-write soak lifecycle (DATA-5b)', () => {
  afterEach(() => {
    storageRegistry.active = storageRegistry.drivers['dexie'];
    try {
      localStorage.removeItem(STORAGE_PREF_KEY);
    } catch {
      /* ignore */
    }
  });

  it('isDualWriteSoak / getDualWriteSoakStatus reflect the engaged bridge', () => {
    const p = memDriver('surrealdb');
    const s = memDriver('dexie');
    storageRegistry.active = createDualWriteDriver(p.driver, s.driver);

    expect(isDualWriteSoak()).toBe(true);
    const status = getDualWriteSoakStatus();
    expect(status.active).toBe(true);
    expect(status.shadowHealthy).toBe(true);
    expect(status.shadowErrorCount).toBe(0);
  });

  it('abort resyncs the shadow from the primary (loss-safe) then switches to the shadow', async () => {
    // Primary has writes the shadow is MISSING (simulating a mid-soak shadow
    // failure that left primary-only writes).
    const p = memDriver('surrealdb', [setting('a', 1), setting('b', 2)]);
    const s = memDriver('dexie'); // empty
    storageRegistry.active = createDualWriteDriver(p.driver, s.driver);

    const result = await abortDualWriteSoak();

    expect(result.ok).toBe(true);
    // Shadow now holds the primary's data — nothing lost.
    expect(s.map.get('a')?.value).toBe(1);
    expect(s.map.get('b')?.value).toBe(2);
    // Active rolled back to the (now-complete) shadow; preference is the safe default.
    expect(storageRegistry.active).toBe(s.driver);
    expect(getStoredStoragePreference()).toBe('dexie');
    expect(isDualWriteSoak()).toBe(false);
  });

  it('abort after a genuine mid-soak shadow FAILURE resyncs the shadow to match the primary', async () => {
    // Build a primary + a shadow whose writes can be forced to fail, engage the
    // bridge as the active driver, then write through it with the shadow DOWN.
    // The primary (must-succeed) commits; the shadow (best-effort) throws, so the
    // primary ends up with rows the shadow is MISSING and shadowHealthy goes false.
    const p = memDriver('surrealdb');
    const s = memDriver('dexie');
    const bridge = createDualWriteDriver(p.driver, s.driver);
    storageRegistry.active = bridge;

    s.setFailWrites(true);
    await bridge.settings.put(setting('a', 1));
    await bridge.settings.put(setting('b', 2));

    // Primary captured both; shadow captured neither; the soak is now unhealthy.
    expect(p.map.get('a')?.value).toBe(1);
    expect(p.map.get('b')?.value).toBe(2);
    expect(s.map.has('a')).toBe(false);
    expect(s.map.has('b')).toBe(false);
    expect(getDualWriteSoakStatus().shadowHealthy).toBe(false);
    expect(getDualWriteSoakStatus().shadowErrorCount).toBe(2);

    // Heal the shadow so the abort-time resync (migrateData overwrite) can write.
    s.setFailWrites(false);
    const result = await abortDualWriteSoak();

    expect(result.ok).toBe(true);
    // The resync re-mirrored the primary's data into the shadow — the
    // primary-only writes that the failed shadow missed are now recovered.
    expect(s.map.get('a')?.value).toBe(1);
    expect(s.map.get('b')?.value).toBe(2);
    // Active rolled back to the (now-complete) shadow; soak disengaged.
    expect(storageRegistry.active).toBe(s.driver);
    expect(isDualWriteSoak()).toBe(false);
    expect(getStoredStoragePreference()).toBe('dexie');

    // KNOWN LIMITATION: the abort resync is `migrateData(primary, shadow,
    // { overwrite: true })`, and overwrite only CLEARS the append-only
    // questionResults log — it does NOT clear the keyed settings namespace
    // (settings/reviewItems/masterySnapshots/chunks copy via idempotent upsert,
    // never a clear). So a key that was DELETED on the primary but left stale on
    // the shadow during the soak is NOT removed by the resync; the upsert-only
    // copy can add/overwrite the shadow's rows but can never delete an orphan.
    // We therefore assert recovery of upserted rows (above) and do NOT assert
    // deletion-orphan removal here — that would fail by design.
  });

  it('abort outside a soak just switches to Dexie', async () => {
    storageRegistry.active = storageRegistry.drivers['dexie'];
    const result = await abortDualWriteSoak();
    expect(result.ok).toBe(true);
    expect(getStoredStoragePreference()).toBe('dexie');
  });

  it('commit drops the bridge and persists when primary and shadow agree', async () => {
    const p = memDriver('surrealdb', [setting('a', 1)]);
    const s = memDriver('dexie', [setting('a', 1)]);
    storageRegistry.active = createDualWriteDriver(p.driver, s.driver);

    const result = await commitDualWriteSoak();

    expect(result.ok).toBe(true);
    expect(result.verification?.ok).toBe(true);
    // No longer a dual-write soak; preference is now SurrealDB.
    expect(isDualWriteSoak()).toBe(false);
    expect(getStoredStoragePreference()).toBe('surrealdb');
  });

  it('commit refuses (stays in dual-write) when primary and shadow diverge', async () => {
    const p = memDriver('surrealdb', [setting('a', 1)]);
    const s = memDriver('dexie', [setting('a', 2)]); // divergent value
    storageRegistry.active = createDualWriteDriver(p.driver, s.driver);

    const result = await commitDualWriteSoak();

    expect(result.ok).toBe(false);
    expect(result.verification?.ok).toBe(false);
    // Still in dual-write — the escape hatch is preserved.
    expect(isDualWriteSoak()).toBe(true);
  });

  it('commit reports "not in a soak" when no bridge is engaged', async () => {
    storageRegistry.active = storageRegistry.drivers['dexie'];
    const result = await commitDualWriteSoak();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not in a dual-write soak/i);
  });
});
