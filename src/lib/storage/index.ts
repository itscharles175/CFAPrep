import { dexieDriver } from './dexieDriver';
import { surrealDriver } from './surrealDriver';
import type { StorageDriver, StorageRegistry } from './types';

/**
 * Singleton registry.  Dexie is always the default active driver.
 * The SurrealDB driver is registered but never activated unless the caller
 * explicitly calls `switchToSurreal()` AND the sidecar is reachable.
 */
export const storageRegistry: StorageRegistry = {
  active: dexieDriver,
  drivers: {
    dexie: dexieDriver,
    surrealdb: surrealDriver,
  },

  async switchDriver(name: 'dexie' | 'surrealdb'): Promise<{ ok: boolean; error?: string }> {
    const driver: StorageDriver | undefined = this.drivers[name];
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
