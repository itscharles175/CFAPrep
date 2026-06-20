/*
 * AUDIT-1 — host transport tests for the DATA-4b FSRS write-back (task #90, the
 * HIGH-risk item). The backend merge engine is covered by
 * services/lsat-backend/tests/test_fsrs_write_back.py; this guards the HOST half:
 * the deterministic idempotency key, the fully-degrading transport, the MAX cap,
 * and that the informational `reconciled` result is parsed without loss.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const bridge = { reviewCards: vi.fn<() => Promise<unknown[]>>() };
let bridgePresent = true;
vi.mock('../lib/storage', () => ({
  getStorage: () => ({ crossDomainBridge: bridgePresent ? bridge : undefined }),
}));

import { pushFsrsWriteBack, useSyncFsrsWriteBack } from './useSyncFsrsWriteBack';

function review(crossId: string, dueAt: string) {
  return { crossId, domain: 'cfa', dueAt, difficulty: 1, lapses: 0, leech: false, itemType: 'mcq', origin: 'host', empiricalDifficulty: 0.5 };
}

beforeEach(() => {
  bridgePresent = true;
  bridge.reviewCards.mockResolvedValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('pushFsrsWriteBack (DATA-4b)', () => {
  it('short-circuits with no request when there are no write-backs', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await pushFsrsWriteBack();
    expect(r).toMatchObject({ ok: true, reachable: true, sent: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('derives a deterministic writeId (crossId@dueAt) that is stable and changes on reschedule', async () => {
    bridge.reviewCards.mockResolvedValue([review('cfa:1', '2026-01-01')]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, applied: 1 }) });
    vi.stubGlobal('fetch', fetchMock);

    await pushFsrsWriteBack();
    let body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.writes[0].writeId).toBe('cfa:1@2026-01-01');
    expect(body.writes[0]).toMatchObject({ crossId: 'cfa:1', observedAt: '2026-01-01' });

    // A reschedule changes dueAt -> new writeId -> the backend will apply it.
    bridge.reviewCards.mockResolvedValue([review('cfa:1', '2026-02-15')]);
    await pushFsrsWriteBack();
    body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body.writes[0].writeId).toBe('cfa:1@2026-02-15');
  });

  it('no-ops without throwing when the sidecar is unreachable', async () => {
    bridge.reviewCards.mockResolvedValue([review('cfa:1', '2026-01-01')]);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const r = await pushFsrsWriteBack();
    expect(r.ok).toBe(false);
    expect(r.reachable).toBe(false);
    expect(r.sent).toBe(1);
  });

  it('reports reachable-but-error on a non-2xx response', async () => {
    bridge.reviewCards.mockResolvedValue([review('cfa:1', '2026-01-01')]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const r = await pushFsrsWriteBack();
    expect(r.ok).toBe(false);
    expect(r.reachable).toBe(true);
  });

  it('parses the informational reconciled array (kept_existing) without loss', async () => {
    bridge.reviewCards.mockResolvedValue([review('cfa:1', '2026-01-01')]);
    const reconciled = [
      { crossId: 'cfa:1', fsrsState: { difficulty: 2 }, syncRevision: 3, resolution: 'kept_existing' as const },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, applied: 0, kept_existing: 1, reconciled }),
    }));
    const r = await pushFsrsWriteBack();
    expect(r.applied).toBe(0);
    expect(r.reconciled).toEqual(reconciled);
  });

  it('caps the batch at MAX_WRITES (2000)', async () => {
    const cards = Array.from({ length: 2500 }, (_, i) => review(`cfa:${i}`, '2026-01-01'));
    bridge.reviewCards.mockResolvedValue(cards);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, applied: 2000 }) });
    vi.stubGlobal('fetch', fetchMock);
    const r = await pushFsrsWriteBack();
    expect(r.sent).toBe(2000);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.writes).toHaveLength(2000);
  });
});

describe('useSyncFsrsWriteBack (mount + de-dupe)', () => {
  it('de-dupes overlapping pushes into a single in-flight request', () => {
    bridge.reviewCards.mockResolvedValue([review('cfa:1', '2026-01-01')]);
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { result, unmount } = renderHook(() => useSyncFsrsWriteBack({ intervalMs: 10_000_000 }));
    const p1 = result.current.sessionEnd();
    const p2 = result.current.sessionEnd();
    expect(p1).toBe(p2);
    unmount();
  });
});
