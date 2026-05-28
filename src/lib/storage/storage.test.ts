import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../progressStore';
import { getStorage, storageRegistry, switchToDexie, switchToSurreal } from './index';

// Mock surrealdb so test 5 works without a running sidecar.
vi.mock('surrealdb', () => ({
  Surreal: class {
    async connect() {
      throw new Error('not reachable');
    }
    async use() {}
    async ping() {}
    async close() {}
  },
}));

// Also reset the cached SurrealDB client before each test so the mock is fresh.
beforeEach(async () => {
  const { resetSurrealClient } = await import('./surrealDriver');
  resetSurrealClient();

  // Reset the active driver to Dexie for a clean slate.
  storageRegistry.active = storageRegistry.drivers['dexie'];

  // Clear Dexie settings table.
  await db.settings.clear();
});

// ---------------------------------------------------------------------------
// Test 1: default active driver is 'dexie' and ready() resolves true
// ---------------------------------------------------------------------------
describe('default driver', () => {
  it('is dexie by default', () => {
    expect(getStorage().name).toBe('dexie');
  });

  it('ready() resolves true for dexie driver', async () => {
    const result = await getStorage().ready();
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 2: put then get round-trips through Dexie backend
// ---------------------------------------------------------------------------
describe('settings.put and settings.get', () => {
  it('round-trips a value through the Dexie backend', async () => {
    const row = { key: 'test-key', value: { hello: 'world' }, updatedAt: '2026-01-01T00:00:00.000Z' };
    await getStorage().settings.put(row);

    // Verify via the abstraction
    const fetched = await getStorage().settings.get('test-key');
    expect(fetched).toEqual(row);

    // Also verify directly against the underlying Dexie table
    const direct = await db.settings.get('test-key');
    expect(direct?.value).toEqual({ hello: 'world' });
  });
});

// ---------------------------------------------------------------------------
// Test 3: toArray returns the same rows as the underlying Dexie table
// ---------------------------------------------------------------------------
describe('settings.toArray', () => {
  it('returns the same rows as the underlying Dexie table', async () => {
    await db.settings.put({ key: 'a', value: 1, updatedAt: '2026-01-01T00:00:00.000Z' });
    await db.settings.put({ key: 'b', value: 2, updatedAt: '2026-01-02T00:00:00.000Z' });

    const driverRows = await getStorage().settings.toArray();
    const rawRows = await db.settings.toArray();

    expect(driverRows).toHaveLength(rawRows.length);
    expect(driverRows.map((r) => r.key).sort()).toEqual(rawRows.map((r) => r.key).sort());
  });
});

// ---------------------------------------------------------------------------
// Test 4: delete removes the row
// ---------------------------------------------------------------------------
describe('settings.delete', () => {
  it('removes the row from Dexie', async () => {
    await db.settings.put({ key: 'to-delete', value: 'bye', updatedAt: '2026-01-01T00:00:00.000Z' });
    await getStorage().settings.delete('to-delete');

    const fetched = await getStorage().settings.get('to-delete');
    expect(fetched).toBeUndefined();

    const direct = await db.settings.get('to-delete');
    expect(direct).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 5: switchToSurreal returns { ok: false } when sidecar is not reachable
// ---------------------------------------------------------------------------
describe('switchToSurreal', () => {
  it('returns { ok: false } with a descriptive error when the sidecar is unreachable', async () => {
    const result = await switchToSurreal();
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test 6: after a failed switch, getStorage().name is still 'dexie'
// ---------------------------------------------------------------------------
describe('driver state after failed switch', () => {
  it('stays on dexie after a failed switchToSurreal', async () => {
    await switchToSurreal(); // will fail (mock throws)
    expect(getStorage().name).toBe('dexie');
  });

  it('switchToDexie always succeeds', async () => {
    const result = await switchToDexie();
    expect(result.ok).toBe(true);
    expect(getStorage().name).toBe('dexie');
  });
});
