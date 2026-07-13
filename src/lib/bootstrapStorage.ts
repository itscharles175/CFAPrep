/**
 * Apply the user's persisted storage-backend preference at app startup.
 *
 * If the user previously cut over to SurrealDB, try to re-activate it (which
 * probes the :8000 sidecar via `ready()`).  If the sidecar is unreachable the
 * switch silently fails and we stay on Dexie — the app keeps working with the
 * local IndexedDB data rather than stranding the user on an empty backend.
 *
 * No data migration runs here — that already happened during the original
 * cutover.  We only re-point the active driver.
 */

import { getStoredStoragePreference, switchToSurreal } from './storage';

export interface StorageBootstrapResult {
  preference: 'dexie' | 'surrealdb';
  activated: 'dexie' | 'surrealdb';
  reason?: string;
}

export async function bootstrapStorage(): Promise<StorageBootstrapResult> {
  const preference = getStoredStoragePreference();
  if (preference !== 'surrealdb') {
    return { preference, activated: 'dexie' };
  }
  try {
    const result = await switchToSurreal();
    if (result.ok) {
      return { preference, activated: 'surrealdb' };
    }
    return { preference, activated: 'dexie', reason: result.error || 'SurrealDB sidecar unreachable.' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { preference, activated: 'dexie', reason };
  }
}
