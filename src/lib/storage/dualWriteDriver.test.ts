import { describe, expect, it } from 'vitest';
import { createDualWriteDriver } from './dualWriteDriver';
import type {
  CrossDomainBridge,
  KeyedTable,
  StorageDriver,
  StorageSettingRow,
  StorageTransactionScope,
} from './types';

// ---------------------------------------------------------------------------
// Minimal in-memory driver — settings + generic table() + transaction(), with a
// toggle to make writes throw (to exercise the best-effort shadow path and the
// must-succeed primary path).
// ---------------------------------------------------------------------------

interface Row {
  id: string | number;
  [k: string]: unknown;
}

function makeMemDriver(name: 'dexie' | 'surrealdb') {
  const settingsMap = new Map<string, StorageSettingRow>();
  const tables = new Map<string, Map<string | number, Row>>();
  let failWrites = false;

  function tbl(n: string): Map<string | number, Row> {
    let m = tables.get(n);
    if (!m) {
      m = new Map();
      tables.set(n, m);
    }
    return m;
  }

  const driver: StorageDriver = {
    name,
    async ready() {
      return true;
    },
    settings: {
      async get(key) {
        return settingsMap.get(key);
      },
      async put(row) {
        if (failWrites) throw new Error(`${name} settings.put down`);
        settingsMap.set(row.key, row);
      },
      async delete(key) {
        if (failWrites) throw new Error(`${name} settings.delete down`);
        settingsMap.delete(key);
      },
      async toArray() {
        return [...settingsMap.values()];
      },
      async bulkDelete(keys) {
        keys.forEach((k) => settingsMap.delete(k));
      },
      async clear() {
        settingsMap.clear();
      },
    },
    table<T>(n: string): KeyedTable<T> {
      const m = tbl(n);
      return {
        async get(key) {
          return m.get(key) as T | undefined;
        },
        async bulkGet(keys) {
          return keys.map((k) => m.get(k) as T | undefined);
        },
        async put(row) {
          if (failWrites) throw new Error(`${name} table.put down`);
          m.set((row as unknown as Row).id, row as unknown as Row);
        },
        async bulkPut(rows) {
          rows.forEach((r) => m.set((r as unknown as Row).id, r as unknown as Row));
        },
        async add(row) {
          if (failWrites) throw new Error(`${name} table.add down`);
          const id = m.size + 1;
          m.set(id, { ...(row as unknown as Row), id });
          return id;
        },
        async delete(key) {
          m.delete(key);
        },
        async bulkDelete(keys) {
          keys.forEach((k) => m.delete(k));
        },
        async toArray() {
          return [...m.values()] as unknown as T[];
        },
        async count() {
          return m.size;
        },
        async clear() {
          m.clear();
        },
        async whereEquals(field, value) {
          return [...m.values()].filter((r) => r[field as string] === value) as unknown as T[];
        },
        async whereAnyOf(field, values) {
          return [...m.values()].filter((r) => values.includes(r[field as string])) as unknown as T[];
        },
        async orderedBy(field) {
          const rows = [...m.values()];
          rows.sort((x, y) => (x[field as string]! < y[field as string]! ? -1 : 1));
          return rows as unknown as T[];
        },
      };
    },
    async transaction<T>(
      _tables: string[],
      _mode: 'rw',
      fn: (tx: StorageTransactionScope) => Promise<T>,
    ): Promise<T> {
      const scope: StorageTransactionScope = {
        table<R>(n: string): KeyedTable<R> {
          return driver.table!<R>(n);
        },
      };
      return fn(scope);
    },
  };

  return {
    driver,
    settingsMap,
    tables,
    setFailWrites: (v: boolean) => {
      failWrites = v;
    },
  };
}

function setting(key: string, value: unknown): StorageSettingRow {
  return { key, value, updatedAt: 't' };
}

describe('createDualWriteDriver (DATA-5b)', () => {
  it('reports the primary name and the dual-write marker', () => {
    const p = makeMemDriver('surrealdb');
    const s = makeMemDriver('dexie');
    const dual = createDualWriteDriver(p.driver, s.driver);
    expect(dual.name).toBe('surrealdb');
    expect(dual.isDualWrite).toBe(true);
    expect(dual.shadowHealthy).toBe(true);
    expect(dual.shadowErrorCount).toBe(0);
  });

  it('mirrors settings writes to BOTH primary and shadow', async () => {
    const p = makeMemDriver('surrealdb');
    const s = makeMemDriver('dexie');
    const dual = createDualWriteDriver(p.driver, s.driver);

    await dual.settings.put(setting('theme', 'dark'));
    expect(p.settingsMap.get('theme')?.value).toBe('dark');
    expect(s.settingsMap.get('theme')?.value).toBe('dark');
  });

  it('reads from the primary only', async () => {
    const p = makeMemDriver('surrealdb');
    const s = makeMemDriver('dexie');
    // Seed divergent values directly (bypassing the dual write).
    p.settingsMap.set('x', setting('x', 'primary'));
    s.settingsMap.set('x', setting('x', 'shadow'));
    const dual = createDualWriteDriver(p.driver, s.driver);

    const row = await dual.settings.get('x');
    expect(row?.value).toBe('primary');
  });

  it('mirrors table() writes to both backends', async () => {
    const p = makeMemDriver('surrealdb');
    const s = makeMemDriver('dexie');
    const dual = createDualWriteDriver(p.driver, s.driver);

    await dual.table!('progress').put({ id: 'p1', score: 10 });
    expect(p.tables.get('progress')?.get('p1')).toEqual({ id: 'p1', score: 10 });
    expect(s.tables.get('progress')?.get('p1')).toEqual({ id: 'p1', score: 10 });
  });

  it('mirrors a transaction to both backends', async () => {
    const p = makeMemDriver('surrealdb');
    const s = makeMemDriver('dexie');
    const dual = createDualWriteDriver(p.driver, s.driver);

    const result = await dual.transaction!(['progress'], 'rw', async (tx) => {
      await tx.table<Row>('progress').put({ id: 't1', v: 1 });
      return 'done';
    });

    expect(result).toBe('done');
    expect(p.tables.get('progress')?.get('t1')).toEqual({ id: 't1', v: 1 });
    expect(s.tables.get('progress')?.get('t1')).toEqual({ id: 't1', v: 1 });
  });

  it('mirrors auto-id add() to both (each backend assigns its own id)', async () => {
    const p = makeMemDriver('surrealdb');
    const s = makeMemDriver('dexie');
    const dual = createDualWriteDriver(p.driver, s.driver);

    await dual.table!('log').add({ event: 'x' });
    expect(p.tables.get('log')?.size).toBe(1);
    expect(s.tables.get('log')?.size).toBe(1);
  });

  it('survives a shadow write failure: primary still commits, soak marked unhealthy', async () => {
    const p = makeMemDriver('surrealdb');
    const s = makeMemDriver('dexie');
    s.setFailWrites(true);
    const errors: unknown[] = [];
    const dual = createDualWriteDriver(p.driver, s.driver, { onShadowError: (e) => errors.push(e) });

    await expect(dual.settings.put(setting('k', 'v'))).resolves.toBeUndefined();
    expect(p.settingsMap.get('k')?.value).toBe('v'); // primary committed
    expect(s.settingsMap.has('k')).toBe(false); // shadow did not
    expect(dual.shadowHealthy).toBe(false);
    expect(dual.shadowErrorCount).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it('propagates a primary write failure and does NOT touch the shadow', async () => {
    const p = makeMemDriver('surrealdb');
    const s = makeMemDriver('dexie');
    p.setFailWrites(true);
    const dual = createDualWriteDriver(p.driver, s.driver);

    await expect(dual.settings.put(setting('k', 'v'))).rejects.toThrow(/down/);
    expect(s.settingsMap.has('k')).toBe(false); // shadow untouched on primary failure
    expect(dual.shadowHealthy).toBe(true); // shadow never attempted
  });

  it('verify() passes when primary and shadow hold the same data', async () => {
    const p = makeMemDriver('surrealdb');
    const s = makeMemDriver('dexie');
    const dual = createDualWriteDriver(p.driver, s.driver);

    await dual.settings.put(setting('a', 1));
    await dual.settings.put(setting('b', 2));

    const report = await dual.verify();
    expect(report.ok).toBe(true);
    expect(report.mismatches).toEqual([]);
  });

  it('verify() flags a divergence introduced behind the bridge', async () => {
    const p = makeMemDriver('surrealdb');
    const s = makeMemDriver('dexie');
    const dual = createDualWriteDriver(p.driver, s.driver);

    await dual.settings.put(setting('a', 1));
    // Sneak a write into the primary only (simulating a missed shadow write).
    p.settingsMap.set('rogue', setting('rogue', 9));

    const report = await dual.verify();
    expect(report.ok).toBe(false);
    expect(report.mismatches.some((m) => m.namespace === 'settings')).toBe(true);
  });

  it('exposes crossDomainBridge, falling back to the shadow when the primary lacks it', () => {
    const p = makeMemDriver('surrealdb'); // SurrealDB driver has no bridge today
    const s = makeMemDriver('dexie');
    const bridge: CrossDomainBridge = {
      async reviewCards() {
        return [];
      },
      async attempts() {
        return [];
      },
      async mastery() {
        return [];
      },
    };
    (s.driver as StorageDriver).crossDomainBridge = bridge;

    const dual = createDualWriteDriver(p.driver, s.driver);
    // Primary lacks it → routes through the in-sync Dexie shadow's bridge.
    expect(dual.crossDomainBridge).toBe(bridge);
  });
});
