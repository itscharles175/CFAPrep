export interface StorageSettingRow {
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface StorageDriver {
  name: 'dexie' | 'surrealdb';
  ready(): Promise<boolean>;
  settings: {
    get(key: string): Promise<StorageSettingRow | undefined>;
    put(row: StorageSettingRow): Promise<void>;
    delete(key: string): Promise<void>;
    toArray(): Promise<StorageSettingRow[]>;
    bulkDelete(keys: string[]): Promise<void>;
    clear(): Promise<void>;
  };
}

export interface StorageRegistry {
  /** The active driver — Dexie by default; can be swapped via switchDriver. */
  active: StorageDriver;
  /** Available drivers, keyed by name. */
  drivers: Record<string, StorageDriver>;
  /** Switch the active driver. Validates ready() before switching. */
  switchDriver(name: 'dexie' | 'surrealdb'): Promise<{ ok: boolean; error?: string }>;
}
