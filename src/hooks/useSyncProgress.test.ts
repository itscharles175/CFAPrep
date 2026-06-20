/*
 * AUDIT-1 — host transport tests for the DATA-4a cross-domain progress feed.
 * The backend receiver is covered by services/lsat-backend/tests/test_sync_progress.py;
 * this guards the HOST half (snapshot shaping + the fully-degrading transport),
 * which was previously untested and is now mounted at the app root.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const bridge = {
  reviewCards: vi.fn<() => Promise<unknown[]>>(),
  attempts: vi.fn<() => Promise<unknown[]>>(),
  mastery: vi.fn<() => Promise<unknown[]>>(),
};
let bridgePresent = true;
vi.mock('../lib/storage', () => ({
  getStorage: () => ({ crossDomainBridge: bridgePresent ? bridge : undefined }),
}));

import { pushHostProgress, useSyncProgress } from './useSyncProgress';

function review(crossId: string, dueAt: string) {
  return { crossId, domain: 'cfa', dueAt, difficulty: 1, lapses: 0, leech: false, itemType: 'mcq', origin: 'host', empiricalDifficulty: 0.5 };
}

beforeEach(() => {
  bridgePresent = true;
  bridge.reviewCards.mockResolvedValue([]);
  bridge.attempts.mockResolvedValue([]);
  bridge.mastery.mockResolvedValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('pushHostProgress (DATA-4a)', () => {
  it('short-circuits with no HTTP request when there is nothing to sync', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await pushHostProgress();
    expect(r).toMatchObject({ ok: true, reachable: true, sent: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no-ops without throwing when the sidecar is unreachable', async () => {
    bridge.reviewCards.mockResolvedValue([review('cfa:1', '2026-01-01')]);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const r = await pushHostProgress();
    expect(r.ok).toBe(false);
    expect(r.reachable).toBe(false);
    expect(r.sent).toBe(1);
  });

  it('reports reachable-but-error on a non-2xx response', async () => {
    bridge.reviewCards.mockResolvedValue([review('cfa:1', '2026-01-01')]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const r = await pushHostProgress();
    expect(r.ok).toBe(false);
    expect(r.reachable).toBe(true);
  });

  it('collects review/attempt/mastery snapshots, POSTs them, and parses upserted', async () => {
    bridge.reviewCards.mockResolvedValue([review('cfa:1', '2026-01-01')]);
    bridge.attempts.mockResolvedValue([{ crossId: 'cfa:1', domain: 'cfa', createdAt: '2026-01-02' }]);
    bridge.mastery.mockResolvedValue([{ crossId: 'cfa:equity', domain: 'cfa' }]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, upserted: 3 }) });
    vi.stubGlobal('fetch', fetchMock);

    const r = await pushHostProgress();
    expect(r).toMatchObject({ ok: true, reachable: true, sent: 3, upserted: 3 });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.snapshots).toHaveLength(3);
    // mastery snapshots deliberately omit observedAt; review carries dueAt.
    expect(body.snapshots[0]).toMatchObject({ crossId: 'cfa:1', kind: 'review', observedAt: '2026-01-01' });
    expect(body.snapshots[2]).toMatchObject({ crossId: 'cfa:equity', kind: 'mastery' });
    expect(body.snapshots[2].observedAt).toBeUndefined();
  });

  it('treats a missing crossDomainBridge as nothing-to-sync (feature-detected)', async () => {
    bridgePresent = false;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await pushHostProgress();
    expect(r.sent).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('useSyncProgress (mount + de-dupe)', () => {
  it('de-dupes overlapping pushes into a single in-flight request', () => {
    bridge.reviewCards.mockResolvedValue([review('cfa:1', '2026-01-01')]);
    // A never-settling fetch keeps the in-flight promise pinned for the assertion.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { result, unmount } = renderHook(() => useSyncProgress({ intervalMs: 10_000_000 }));
    const p1 = result.current.sessionEnd();
    const p2 = result.current.sessionEnd();
    expect(p1).toBe(p2); // same in-flight promise reused, no double-send
    unmount();
  });

  it('is a disabled no-op when enabled:false', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result, unmount } = renderHook(() => useSyncProgress({ enabled: false }));
    const r = await result.current.sessionEnd();
    expect(r).toMatchObject({ ok: true, sent: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    unmount();
  });
});
