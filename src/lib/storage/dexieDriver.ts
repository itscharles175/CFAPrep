import { db } from '../progressStore';
import type { StorageDriver, StorageSettingRow } from './types';

/**
 * DexieDriver — wraps the existing `db.settings` Dexie table from progressStore.
 *
 * This is the "leave" side of the strangler pattern: all current behaviour is
 * preserved through this driver.  No caller changes are required until Phase 2.
 */
export const dexieDriver: StorageDriver = {
  name: 'dexie',

  async ready(): Promise<boolean> {
    try {
      if (db.isOpen()) return true;
      await db.open();
      return db.isOpen();
    } catch {
      return false;
    }
  },

  settings: {
    async get(key: string): Promise<StorageSettingRow | undefined> {
      const row = await db.settings.get(key);
      if (!row) return undefined;
      return { key: row.key, value: row.value, updatedAt: row.updatedAt };
    },

    async put(row: StorageSettingRow): Promise<void> {
      await db.settings.put({ key: row.key, value: row.value, updatedAt: row.updatedAt });
    },

    async delete(key: string): Promise<void> {
      await db.settings.delete(key);
    },

    async toArray(): Promise<StorageSettingRow[]> {
      const rows = await db.settings.toArray();
      return rows.map((row) => ({ key: row.key, value: row.value, updatedAt: row.updatedAt }));
    },

    async bulkDelete(keys: string[]): Promise<void> {
      await db.settings.bulkDelete(keys);
    },

    async clear(): Promise<void> {
      await db.settings.clear();
    },
  },
};
