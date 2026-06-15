import { dexieDriver } from './dexieDriver';
import { createReadThroughDriver, type ReadThroughDriver } from './fallbackDriver';
import { migrateData, type MigrationReport } from './migrate';
import type { StorageDriver, StorageRegistry } from './types';

export type StorageDriverName = 'dexie' | 'surrealdb';

/**
 * localStorage key holding the user's preferred storage backend.  Kept in
 * localStorage (not the storage abstraction itself) so it can be read at
 * boot before any driver initialises — same bootstrap-critical pattern the
 * theme preference uses.
 */
export const STORAGE_PREF_KEY = 'qv-storage-driver';

/**
 * Singleton registry.  Dexie is always the default active driver.
 * The SurrealDB driver is lazy-loaded (dynamic import) the first time the
 * caller explicitly requests a switch, so the dormant SurrealDB client (and
 * its `isows`/`ws` transitive deps) never load in the default startup path
 * or in tests that don't exercise it.
 */
export const storageRegistry: StorageRegistry = {
  active: dexieDriver,
  drivers: {
    dexie: dexieDriver,
    // surrealdb is lazily populated by switchDriver('surrealdb').
  },

  async switchDriver(name: 'dexie' | 'surrealdb'): Promise<{ ok: boolean; error?: string }> {
    let driver: StorageDriver | undefined = this.drivers[name];

    // Lazy-load the SurrealDB driver on first use so its transitive imports
    // (the `surrealdb` JS client + `isows` + `ws`) stay off the default path.
    if (!driver && name === 'surrealdb') {
      try {
        const mod = await import('./surrealDriver');
        driver = mod.surrealDriver;
        this.drivers[name] = driver;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `Failed to load surrealdb driver: ${msg}` };
      }
    }

    if (!driver) {
      return { ok: false, error: `Unknown storage driver: ${name}` };
    }

    let isReady = false;
    try {
      isReady = await driver.ready();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Driver '${name}' ready() threw: ${msg}` };
    }

    if (!isReady) {
      return { ok: false, error: `Driver '${name}' is not ready (sidecar unreachable or init failed).` };
    }

    // For SurrealDB, install the read-through fallback wrapper so a sidecar
    // crash keeps reads available off the Dexie cache (roadmap BA4).  Dexie's
    // raw driver is the cache — never wrap it.  `getStorage()` callers can't
    // tell the wrapper from the bare driver: it reports name 'surrealdb' and
    // the full StorageDriver shape.
    if (name === 'surrealdb') {
      const surreal = driver;
      this.active = createReadThroughDriver(surreal, dexieDriver, {
        // Recovery is best-effort: re-warm the Dexie cache from the now-healthy
        // SurrealDB so it's primed for the next outage.  Non-blocking — fired
        // from the recovery probe / a successful read, never awaited by a read.
        onRecover: () => {
          void (async () => {
            // The attempt log is append-only, so a naive re-copy would inflate
            // the cache with duplicates each resync.  Clear it first so the
            // re-warm mirrors SurrealDB exactly (settings/reviewItems/mastery
            // are upsert-keyed and already idempotent under migrateData).
            try {
              await dexieDriver.questionResults?.clear();
            } catch {
              /* if the cache clear fails we skip the re-warm entirely below */
            }
            await migrateData(surreal, dexieDriver);
          })().catch(() => {
            /* cache re-warm is best-effort; a failure just leaves a staler
             * cache until the next successful resync. */
          });
        },
      });
    } else {
      this.active = driver;
    }
    return { ok: true };
  },
};

/**
 * Returns the currently active `StorageDriver`.
 *
 * Usage (post-Phase-2 migration):
 *   `await getStorage().settings.put({ key, value, updatedAt })`
 */
export function getStorage(): StorageDriver {
  return storageRegistry.active;
}

/** Name of the currently active storage driver. */
export function getActiveDriverName(): StorageDriverName {
  return storageRegistry.active.name;
}

/**
 * True when the active driver is the SurrealDB read-through wrapper AND it is
 * currently serving reads from the Dexie cache (i.e. the sidecar is unreachable
 * and the fallback is engaged).  Always false for the plain Dexie config and
 * while SurrealDB is healthy.  Read-only inspection helper for the health UI;
 * does not change the active driver.
 */
export function isStorageDegraded(): boolean {
  const active = storageRegistry.active as Partial<ReadThroughDriver>;
  return active.isReadThrough === true && active.degraded === true;
}

/** Attempt to switch to the SurrealDB sidecar driver. */
export async function switchToSurreal(): Promise<{ ok: boolean; error?: string }> {
  return storageRegistry.switchDriver('surrealdb');
}

/** Roll back to the Dexie driver. Always succeeds. */
export async function switchToDexie(): Promise<{ ok: boolean; error?: string }> {
  return storageRegistry.switchDriver('dexie');
}

/** Read the persisted backend preference (defaults to 'dexie'). */
export function getStoredStoragePreference(): StorageDriverName {
  try {
    if (typeof localStorage === 'undefined') return 'dexie';
    return localStorage.getItem(STORAGE_PREF_KEY) === 'surrealdb' ? 'surrealdb' : 'dexie';
  } catch {
    return 'dexie';
  }
}

/** Persist the backend preference so it survives reloads. */
export function setStoredStoragePreference(name: StorageDriverName): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_PREF_KEY, name);
  } catch {
    /* private-mode / quota — preference just won't persist */
  }
}

export interface CutoverResult {
  ok: boolean;
  error?: string;
  /** Present when a data migration ran as part of the cutover. */
  report?: MigrationReport;
  /** True when the target was already active (no-op). */
  alreadyActive?: boolean;
}

/**
 * Switch the active driver AND migrate existing data into it.
 *
 * Order of operations (safe against a half-failed migration):
 *   1. Capture the current (source) driver.
 *   2. `switchDriver(name)` — lazy-loads + validates `ready()` (for SurrealDB
 *      this connects to :8000; if unreachable the switch fails and active is
 *      untouched).
 *   3. Copy data source → target via {@link migrateData}.  If the copy throws,
 *      roll the active driver back to the source and surface the error.
 *   4. Persist the preference so the choice survives a reload.
 *
 * `migrate: false` skips the data copy (used for rollback to Dexie, whose data
 * was never cleared, and to avoid duplicating the append-only attempt log).
 */
export async function cutoverTo(
  name: StorageDriverName,
  { migrate = true }: { migrate?: boolean } = {},
): Promise<CutoverResult> {
  const from = storageRegistry.active;
  if (from.name === name) {
    setStoredStoragePreference(name);
    return { ok: true, alreadyActive: true };
  }

  const switched = await storageRegistry.switchDriver(name);
  if (!switched.ok) return { ok: false, error: switched.error };

  const to = storageRegistry.active;
  let report: MigrationReport | undefined;
  if (migrate) {
    try {
      report = await migrateData(from, to);
    } catch (err) {
      // Roll back so the user is never stranded on an empty backend.
      storageRegistry.active = from;
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Migration failed (rolled back to '${from.name}'): ${msg}` };
    }
  }

  setStoredStoragePreference(name);
  return { ok: true, report };
}
