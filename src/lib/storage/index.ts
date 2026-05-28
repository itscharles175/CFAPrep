import { dexieDriver } from './dexieDriver';
import type { StorageDriver, StorageRegistry } from './types';

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

    this.active = driver;
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

/** Attempt to switch to the SurrealDB sidecar driver. */
export async function switchToSurreal(): Promise<{ ok: boolean; error?: string }> {
  return storageRegistry.switchDriver('surrealdb');
}

/** Roll back to the Dexie driver. Always succeeds. */
export async function switchToDexie(): Promise<{ ok: boolean; error?: string }> {
  return storageRegistry.switchDriver('dexie');
}
