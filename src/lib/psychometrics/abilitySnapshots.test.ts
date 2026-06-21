import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordAbilitySnapshot,
  readAbilitySnapshots,
  readLatestAbilitySnapshot,
  buildAbilitySnapshot,
  computeCalibrationResiduals,
  abilitySnapshotId,
  ABILITY_MODEL_VERSION,
  type AbilitySnapshot,
} from './abilitySnapshots';
import type { KeyedTable } from '../storage/types';

/**
 * Minimal in-memory KeyedTable so the persistence path is exercised offline with
 * no Dexie store registration and no live backend. Only the methods this module
 * uses (put/toArray) need real behaviour; the rest are inert.
 */
function makeFakeTable(): KeyedTable<AbilitySnapshot> & { rows: Map<string, AbilitySnapshot> } {
  const rows = new Map<string, AbilitySnapshot>();
  return {
    rows,
    async get(key) {
      return rows.get(String(key));
    },
    async bulkGet(keys) {
      return keys.map((k) => rows.get(String(k)));
    },
    async put(row) {
      rows.set(row.id, row);
    },
    async bulkPut(list) {
      for (const r of list) rows.set(r.id, r);
    },
    async add(row) {
      rows.set(row.id, row);
      return row.id;
    },
    async delete(key) {
      rows.delete(String(key));
    },
    async bulkDelete(keys) {
      for (const k of keys) rows.delete(String(k));
    },
    async toArray() {
      return [...rows.values()];
    },
    async count() {
      return rows.size;
    },
    async clear() {
      rows.clear();
    },
    async whereEquals(field, value) {
      return [...rows.values()].filter((r) => r[field] === value);
    },
    async whereAnyOf(field, values) {
      return [...rows.values()].filter((r) => values.includes(r[field] as unknown));
    },
    async orderedBy() {
      return [...rows.values()];
    },
  };
}

/** A KeyedTable whose ops reject — mimics an unregistered Dexie store. */
function makeThrowingTable(): KeyedTable<AbilitySnapshot> {
  const reject = () => Promise.reject(new Error('NoSuchTable: abilitySnapshots'));
  return {
    get: reject,
    bulkGet: reject,
    put: reject,
    bulkPut: reject,
    add: reject,
    delete: reject,
    bulkDelete: reject,
    toArray: reject,
    count: reject,
    clear: reject,
    whereEquals: reject,
    whereAnyOf: reject,
    orderedBy: reject,
  } as unknown as KeyedTable<AbilitySnapshot>;
}

describe('buildAbilitySnapshot', () => {
  it('builds a fully-formed snapshot from an estimate + mapping', () => {
    const snap = buildAbilitySnapshot({
      domain: 'cfa',
      theta: 0.8,
      uncertainty: 0.29,
      difficultyMapping: [{ id: 'q1', b: 0.5, empiricalDifficulty: 0.6 }],
      at: '2026-06-19T12:00:00.000Z',
    });
    expect(snap.id).toBe(abilitySnapshotId('cfa', '2026-06-19T12:00:00.000Z'));
    expect(snap.theta).toBe(0.8);
    expect(snap.uncertainty).toBe(0.29);
    expect(snap.modelVersion).toBe(ABILITY_MODEL_VERSION);
    expect(snap.difficultyMapping.items).toHaveLength(1);
  });
});

describe('computeCalibrationResiduals', () => {
  it('reports observed − expected per item', () => {
    const residuals = computeCalibrationResiduals([
      { id: 'q1', correct: true, expected: 0.7 },
      { id: 'q2', correct: false, expected: 0.4 },
    ]);
    expect(residuals[0]).toMatchObject({ id: 'q1', observed: 1, expected: 0.7, residual: 0.3 });
    expect(residuals[1]).toMatchObject({ id: 'q2', observed: 0, expected: 0.4, residual: -0.4 });
  });
});

describe('recordAbilitySnapshot + read (injected table)', () => {
  let table: ReturnType<typeof makeFakeTable>;
  beforeEach(() => {
    table = makeFakeTable();
  });

  it('persists and reads back a snapshot', async () => {
    const ok = await recordAbilitySnapshot(
      {
        domain: 'cfa',
        theta: 1.1,
        uncertainty: 0.25,
        difficultyMapping: [{ id: 'q1', b: 1, empiricalDifficulty: 0.7 }],
        at: '2026-06-19T10:00:00.000Z',
      },
      table,
    );
    expect(ok).toBe(true);
    const rows = await readAbilitySnapshots('cfa', table);
    expect(rows).toHaveLength(1);
    expect(rows[0].theta).toBe(1.1);
  });

  it('returns snapshots oldest → newest and filters by domain', async () => {
    await recordAbilitySnapshot(
      { domain: 'cfa', theta: 0.1, uncertainty: 0.5, difficultyMapping: [], at: '2026-06-18T10:00:00.000Z' },
      table,
    );
    await recordAbilitySnapshot(
      { domain: 'cfa', theta: 0.9, uncertainty: 0.3, difficultyMapping: [], at: '2026-06-19T10:00:00.000Z' },
      table,
    );
    await recordAbilitySnapshot(
      { domain: 'lsat', theta: 0.5, uncertainty: 0.4, difficultyMapping: [], at: '2026-06-19T11:00:00.000Z' },
      table,
    );

    const cfa = await readAbilitySnapshots('cfa', table);
    expect(cfa.map((r) => r.theta)).toEqual([0.1, 0.9]);

    const latest = await readLatestAbilitySnapshot('cfa', table);
    expect(latest?.theta).toBe(0.9);

    const all = await readAbilitySnapshots(undefined, table);
    expect(all).toHaveLength(3);
  });
});

describe('graceful degradation (no store / unreachable backend)', () => {
  it('recordAbilitySnapshot resolves false when the table op throws — never throws', async () => {
    const ok = await recordAbilitySnapshot(
      { domain: 'cfa', theta: 1, uncertainty: 0.3, difficultyMapping: [] },
      makeThrowingTable(),
    );
    expect(ok).toBe(false);
  });

  it('reads resolve to empty/null when the table op throws', async () => {
    const rows = await readAbilitySnapshots('cfa', makeThrowingTable());
    expect(rows).toEqual([]);
    const latest = await readLatestAbilitySnapshot('cfa', makeThrowingTable());
    expect(latest).toBeNull();
  });

  it('default (un-injected) path persists on the real Dexie driver (store now registered at v12)', async () => {
    // DATA-1 Phase 3 registered the 'abilitySnapshots' store in the host Dexie
    // schema at db.version(12) ('id, domain, at, modelVersion' — see
    // progressStore.ts), so the real getStorage().table('abilitySnapshots') write
    // now SUCCEEDS instead of rejecting. With fake-indexeddb wired up in
    // setupTests.js, the un-injected path persists for real and reads back.
    const at = `2026-06-19T13:00:00.000Z::${Math.random()}`; // unique id; shared default DB
    const ok = await recordAbilitySnapshot({
      domain: 'cfa',
      theta: 0.4,
      uncertainty: 0.5,
      difficultyMapping: [],
      at,
    });
    expect(typeof ok).toBe('boolean');
    expect(ok).toBe(true);

    // The read path must never throw, and the just-written snapshot is readable.
    const rows = await readAbilitySnapshots('cfa');
    expect(rows).toBeInstanceOf(Array);
    expect(rows.some((r) => r.id === abilitySnapshotId('cfa', at))).toBe(true);
  });

  it('degrade contract holds when the table op throws: reads→[]/null, writes→false, never throws', async () => {
    // With the store now registered at v12 the un-injected path persists, so the
    // degrade contract is exercised via an explicitly throwing/rejecting injected
    // table (the same shape an unreachable sidecar or a future unregistered store
    // would present). recordAbilitySnapshot must resolve false, reads must resolve
    // to [] / null, and nothing may throw.
    await expect(
      recordAbilitySnapshot(
        { domain: 'cfa', theta: 0.4, uncertainty: 0.5, difficultyMapping: [] },
        makeThrowingTable(),
      ),
    ).resolves.toBe(false);
    await expect(readAbilitySnapshots('cfa', makeThrowingTable())).resolves.toEqual([]);
    await expect(readLatestAbilitySnapshot('cfa', makeThrowingTable())).resolves.toBeNull();
  });
});
