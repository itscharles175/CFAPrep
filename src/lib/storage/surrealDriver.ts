import { Surreal, StringRecordId } from 'surrealdb';
import type { StorageDriver, StorageSettingRow } from './types';

/** Loose record shape accepted by the SurrealDB client generics. */
type SurrealRecord = { [x: string]: unknown };

const SIDECAR_URL = 'http://localhost:8000/rpc';
const SIDECAR_NAMESPACE = 'quantvault';
const SIDECAR_DATABASE = 'app';
const CONNECT_TIMEOUT_MS = 3000;

/**
 * SurrealDriver — connects to the open-notebook SurrealDB sidecar (supervised
 * by the Tauri shell at localhost:8000).
 *
 * DISABLED BY DEFAULT: `ready()` returns false when the sidecar is unreachable,
 * and the registry will not switch to this driver in that case.
 */

let _client: Surreal | null = null;

async function getClient(): Promise<Surreal> {
  if (_client) return _client;
  const client = new Surreal();

  await Promise.race([
    (async () => {
      await client.connect(SIDECAR_URL);
      await client.use({ namespace: SIDECAR_NAMESPACE, database: SIDECAR_DATABASE });
    })(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`SurrealDB connect timed out after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS),
    ),
  ]);

  _client = client;
  return _client;
}

/** Reset the cached client (used in tests or after an error). */
export function resetSurrealClient() {
  _client = null;
}

export const surrealDriver: StorageDriver = {
  name: 'surrealdb',

  async ready(): Promise<boolean> {
    try {
      const client = await getClient();
      await client.ping();
      return true;
    } catch {
      resetSurrealClient();
      return false;
    }
  },

  settings: {
    async get(key: string): Promise<StorageSettingRow | undefined> {
      const client = await getClient();
      const result = await client.select<SurrealRecord>(new StringRecordId(`setting:${key}`));
      const row = Array.isArray(result) ? result[0] : (result as SurrealRecord | undefined);
      if (!row || typeof row['key'] !== 'string') return undefined;
      return { key: row['key'] as string, value: row['value'], updatedAt: row['updatedAt'] as string };
    },

    async put(row: StorageSettingRow): Promise<void> {
      const client = await getClient();
      await client.upsert(new StringRecordId(`setting:${row.key}`), { key: row.key, value: row.value, updatedAt: row.updatedAt });
    },

    async delete(key: string): Promise<void> {
      const client = await getClient();
      await client.delete(new StringRecordId(`setting:${key}`));
    },

    async toArray(): Promise<StorageSettingRow[]> {
      const client = await getClient();
      const rows = await client.select<SurrealRecord>('setting');
      const arr = Array.isArray(rows) ? rows : [];
      return arr
        .filter((row) => row && typeof row['key'] === 'string')
        .map((row) => ({ key: row['key'] as string, value: row['value'], updatedAt: row['updatedAt'] as string }));
    },

    async bulkDelete(keys: string[]): Promise<void> {
      const client = await getClient();
      await Promise.all(keys.map((key) => client.delete(new StringRecordId(`setting:${key}`))));
    },

    async clear(): Promise<void> {
      const client = await getClient();
      await client.delete('setting');
    },
  },
};
