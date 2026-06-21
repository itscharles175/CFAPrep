import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  recordStudyContext,
  readStudyTrail,
  getResumeTarget,
  buildStudyTrailEntry,
  entryToResumeHandle,
  writeResumeHandle,
  readResumeHandle,
  clearResumeHandle,
  STUDY_TRAIL_LIMIT,
  RESUME_HANDLE_KEY,
  type StudyTrailEntry,
} from './studyTrail';
import type { KeyedTable } from './storage/types';

/** Minimal in-memory KeyedTable — only put/toArray/bulkDelete need real behaviour. */
function makeFakeTable(): KeyedTable<StudyTrailEntry> & { rows: Map<string, StudyTrailEntry> } {
  const rows = new Map<string, StudyTrailEntry>();
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
function makeThrowingTable(): KeyedTable<StudyTrailEntry> {
  const reject = () => Promise.reject(new Error('NoSuchTable: studyTrail'));
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
  } as unknown as KeyedTable<StudyTrailEntry>;
}

/** A stub localStorage backed by a Map, installed on globalThis. */
function installFakeLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const fake: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => store.delete(k),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
  };
  vi.stubGlobal('localStorage', fake);
  return store;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('buildStudyTrailEntry + entryToResumeHandle', () => {
  it('builds an entry keyed on the recordedAt timestamp', () => {
    const entry = buildStudyTrailEntry({
      domain: 'cfa',
      route: '/cfa/lesson/abc',
      label: 'Ethics — Lesson 3',
      queryState: { tab: 'practice' },
      resumeHandle: 'mock:42',
      recordedAt: '2026-06-19T10:00:00.000Z',
    });
    expect(entry.id).toBe('2026-06-19T10:00:00.000Z');
    expect(entry.route).toBe('/cfa/lesson/abc');
    const handle = entryToResumeHandle(entry);
    expect(handle).toMatchObject({
      domain: 'cfa',
      route: '/cfa/lesson/abc',
      label: 'Ethics — Lesson 3',
      resumeHandle: 'mock:42',
    });
  });
});

describe('resume handle (localStorage tier)', () => {
  it('writes + reads back a handle', () => {
    installFakeLocalStorage();
    const ok = writeResumeHandle({
      domain: 'lsat',
      route: '/lsat/srs',
      label: 'LSAT SRS',
      recordedAt: '2026-06-19T10:00:00.000Z',
    });
    expect(ok).toBe(true);
    const read = readResumeHandle();
    expect(read?.route).toBe('/lsat/srs');
    expect(read?.domain).toBe('lsat');
  });

  it('returns null when nothing is stored', () => {
    installFakeLocalStorage();
    expect(readResumeHandle()).toBeNull();
  });

  it('returns null for malformed JSON / missing required fields', () => {
    const store = installFakeLocalStorage();
    store.set(RESUME_HANDLE_KEY, '{ not json');
    expect(readResumeHandle()).toBeNull();
    store.set(RESUME_HANDLE_KEY, JSON.stringify({ label: 'no route or domain' }));
    expect(readResumeHandle()).toBeNull();
  });

  it('clears the handle', () => {
    installFakeLocalStorage();
    writeResumeHandle({ domain: 'cfa', route: '/cfa', label: 'CFA', recordedAt: '2026-06-19T10:00:00.000Z' });
    clearResumeHandle();
    expect(readResumeHandle()).toBeNull();
  });

  it('degrades silently when localStorage throws (private-mode / quota)', () => {
    // The test env provides a real localStorage, so simulate an unavailable one
    // by stubbing it as a thrower — the module must swallow and degrade.
    const throwing: Storage = {
      get length() {
        return 0;
      },
      clear: () => {
        throw new Error('SecurityError');
      },
      getItem: () => {
        throw new Error('SecurityError');
      },
      key: () => null,
      removeItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    vi.stubGlobal('localStorage', throwing);
    expect(writeResumeHandle({ domain: 'cfa', route: '/cfa', label: 'x', recordedAt: 'now' })).toBe(false);
    expect(readResumeHandle()).toBeNull();
    expect(() => clearResumeHandle()).not.toThrow();
  });
});

describe('recordStudyContext + readStudyTrail (injected table)', () => {
  let table: ReturnType<typeof makeFakeTable>;
  beforeEach(() => {
    installFakeLocalStorage();
    table = makeFakeTable();
  });

  it('persists a durable entry AND updates the resume handle', async () => {
    const res = await recordStudyContext(
      { domain: 'cfa', route: '/cfa/lesson/abc', label: 'Ethics', recordedAt: '2026-06-19T10:00:00.000Z' },
      table,
    );
    expect(res).toEqual({ trailed: true, resumed: true });
    expect(table.rows.size).toBe(1);
    expect(readResumeHandle()?.route).toBe('/cfa/lesson/abc');
  });

  it('reads the trail newest → oldest and filters by domain', async () => {
    await recordStudyContext({ domain: 'cfa', route: '/cfa/1', label: 'a', recordedAt: '2026-06-18T10:00:00.000Z' }, table);
    await recordStudyContext({ domain: 'lsat', route: '/lsat/srs', label: 'b', recordedAt: '2026-06-19T09:00:00.000Z' }, table);
    await recordStudyContext({ domain: 'cfa', route: '/cfa/2', label: 'c', recordedAt: '2026-06-19T11:00:00.000Z' }, table);

    const all = await readStudyTrail({}, table);
    expect(all.map((e) => e.route)).toEqual(['/cfa/2', '/lsat/srs', '/cfa/1']);

    const cfa = await readStudyTrail({ domain: 'cfa' }, table);
    expect(cfa.map((e) => e.route)).toEqual(['/cfa/2', '/cfa/1']);

    const top = await readStudyTrail({ limit: 1 }, table);
    expect(top).toHaveLength(1);
    expect(top[0].route).toBe('/cfa/2');
  });

  it('prunes the oldest entries past the retention cap', async () => {
    for (let i = 0; i < STUDY_TRAIL_LIMIT + 5; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      await recordStudyContext({ domain: 'cfa', route: `/cfa/${i}`, label: `c${i}`, recordedAt: ts }, table);
    }
    expect(table.rows.size).toBe(STUDY_TRAIL_LIMIT);
    // The 5 oldest must have been pruned; the newest must remain.
    const routes = (await readStudyTrail({}, table)).map((e) => e.route);
    expect(routes).toContain(`/cfa/${STUDY_TRAIL_LIMIT + 4}`);
    expect(routes).not.toContain('/cfa/0');
  });
});

describe('getResumeTarget', () => {
  beforeEach(() => {
    installFakeLocalStorage();
  });

  it('prefers the durable trail when present', async () => {
    const table = makeFakeTable();
    await recordStudyContext({ domain: 'cfa', route: '/cfa/from-trail', label: 'trail', recordedAt: '2026-06-19T11:00:00.000Z' }, table);
    // Stale resume handle pointing elsewhere — the trail should win.
    writeResumeHandle({ domain: 'lsat', route: '/lsat/stale', label: 'stale', recordedAt: '2026-06-18T00:00:00.000Z' });
    const target = await getResumeTarget(table);
    expect(target?.route).toBe('/cfa/from-trail');
  });

  it('falls back to the localStorage handle when the trail store is unavailable', async () => {
    writeResumeHandle({ domain: 'lsat', route: '/lsat/srs', label: 'LSAT', recordedAt: '2026-06-19T10:00:00.000Z' });
    const target = await getResumeTarget(makeThrowingTable());
    expect(target?.route).toBe('/lsat/srs');
  });

  it('returns null when there is nothing to resume', async () => {
    expect(await getResumeTarget(makeFakeTable())).toBeNull();
  });
});

describe('graceful degradation (no store / unreachable backend)', () => {
  beforeEach(() => {
    installFakeLocalStorage();
  });

  it('recordStudyContext still writes the resume handle when the trail store throws', async () => {
    const res = await recordStudyContext(
      { domain: 'cfa', route: '/cfa/x', label: 'x', recordedAt: '2026-06-19T10:00:00.000Z' },
      makeThrowingTable(),
    );
    expect(res.trailed).toBe(false);
    expect(res.resumed).toBe(true);
    expect(readResumeHandle()?.route).toBe('/cfa/x');
  });

  it('readStudyTrail resolves to [] when the table op throws — never throws', async () => {
    await expect(readStudyTrail({}, makeThrowingTable())).resolves.toEqual([]);
  });

  it('default (un-injected) path degrades to a boolean/array on the real Dexie driver', async () => {
    // The 'studyTrail' store is NOT in the host Dexie schema, so the real
    // getStorage().table('studyTrail') write rejects internally. The module must
    // swallow that and return trailed:false rather than throw.
    const res = await recordStudyContext({ domain: 'cfa', route: '/cfa/y', label: 'y' });
    expect(typeof res.trailed).toBe('boolean');
    await expect(readStudyTrail()).resolves.toBeInstanceOf(Array);
  });
});
