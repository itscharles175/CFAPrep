/**
 * DATA-4b — host -> backend cross-domain FSRS write-back (the WRITE complement of
 * the DATA-4a read-only feed in {@link useSyncProgress}).
 *
 * DATA-4a mirrors the host plane's review cards into the LSAT sidecar read-only.
 * DATA-4b lets the host push each card's *updated scheduling state* (FSRS
 * stability/difficulty/due) to `POST /api/sync/fsrs-write-back`, where the backend
 * merges it into that mirror under **last-write-wins** and records the write in an
 * idempotent ledger. The response carries the reconciled authoritative state per
 * card so the host can detect when last-write-wins kept a value other than the one
 * it sent — the bidirectional reconcile — without the backend ever reaching into
 * the host's Dexie store.
 *
 * Strictly host -> backend and confined to the host's own mirror: nothing here
 * mutates host data, and the backend never touches LSAT-native `SRSCard`
 * scheduling. The reverse direction (backend -> host *write*) stays deferred.
 *
 * Transport mirrors {@link useSyncProgress}: a fully-degrading fetch
 * (AbortController + timeout) that NEVER throws and is a clean no-op when the
 * sidecar is down. The `writeId` is a deterministic idempotency key
 * (`<crossId>@<observedAt>`) so an unchanged card re-sends the same id and the
 * backend dedupes it; a reschedule yields a new id and is applied.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { CrossDomainReviewCard } from '../lib/dataDictionary';
import { getStorage } from '../lib/storage';

const LSAT_API_BASE = 'http://127.0.0.1:8100';
const FSRS_WRITE_BACK_PATH = '/api/sync/fsrs-write-back';

/** ~5 minutes between background write-back pushes (matches the DATA-4a feed). */
export const SYNC_FSRS_INTERVAL_MS = 5 * 60 * 1000;
/** Default request timeout — generous since this is background, never on a render path. */
const DEFAULT_TIMEOUT_MS = 4000;
/** Defensive cap so an unbounded local bank can't build a multi-MB request. */
const MAX_WRITES = 2000;

/** One per-card FSRS write-back in the `POST /api/sync/fsrs-write-back` body. */
interface FsrsWriteWire {
  writeId: string;
  crossId: string;
  /** The card's scheduling state, carried verbatim (opaque to the backend). */
  fsrsState: Record<string, unknown>;
  observedAt?: string;
}

/** The `POST /api/sync/fsrs-write-back` request body. */
interface FsrsWriteBackBody {
  writes: FsrsWriteWire[];
}

/** One reconciled card in the response (authoritative state after last-write-wins). */
export interface FsrsReconciledCard {
  crossId: string;
  fsrsState: Record<string, unknown>;
  syncRevision: number;
  resolution: 'applied' | 'kept_existing' | 'noop_dedupe' | 'no_target';
  observedAt?: string | null;
}

/** Documented `POST /api/sync/fsrs-write-back` response (legacy untyped on the wire). */
interface RawFsrsWriteBackResponse {
  ok?: boolean;
  received?: number;
  applied?: number;
  kept_existing?: number;
  deduped?: number;
  no_target?: number;
  reconciled?: FsrsReconciledCard[];
}

/** Outcome of one write-back push. Never thrown — always returned. */
export interface SyncFsrsResult {
  /** True when the sidecar answered a 2xx. */
  ok: boolean;
  /** Distinguishes "answered but error" from "unreachable" (sidecar down). */
  reachable: boolean;
  /** Write-backs collected from the host and sent. */
  sent: number;
  /** Cards the backend applied the incoming state to, when reported. */
  applied?: number;
  /** Reconciled authoritative state per card (for the host to reconcile its store). */
  reconciled?: FsrsReconciledCard[];
  /** Human-readable status for diagnostics/logging. */
  detail: string;
}

/** The scheduling-relevant subset of a canonical review card sent as `fsrsState`. */
function toFsrsState(card: CrossDomainReviewCard): Record<string, unknown> {
  return {
    difficulty: card.difficulty,
    dueAt: card.dueAt,
    lapses: card.lapses,
    leech: card.leech,
    itemType: card.itemType,
    origin: card.origin,
    empiricalDifficulty: card.empiricalDifficulty,
  };
}

/**
 * Collect the host plane's per-card FSRS write-backs from the active driver's
 * `crossDomainBridge`. Returns an empty list when the bridge isn't exposed
 * (feature-detected) or a store read fails — the caller then skips the push.
 */
async function collectFsrsWriteBacks(): Promise<FsrsWriteWire[]> {
  const bridge = getStorage().crossDomainBridge;
  if (!bridge) return [];
  try {
    const reviews = await bridge.reviewCards();
    const writes: FsrsWriteWire[] = [];
    for (const card of reviews) {
      const observedAt = card.dueAt;
      writes.push({
        // Deterministic idempotency key: an unchanged schedule re-sends the same
        // id (backend dedupes); a reschedule changes dueAt -> new id -> applied.
        writeId: `${card.crossId}@${observedAt ?? 'na'}`,
        crossId: card.crossId,
        fsrsState: toFsrsState(card),
        observedAt,
      });
    }
    return writes.slice(0, MAX_WRITES);
  } catch {
    return [];
  }
}

/**
 * Push the host plane's per-card FSRS write-backs to the LSAT sidecar. Fully
 * degrading: any failure (sidecar down, timeout, shape drift) resolves to
 * `{ ok: false, reachable: false, ... }` — it NEVER throws. A no-writes collection
 * short-circuits without a request.
 */
export async function pushFsrsWriteBack(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SyncFsrsResult> {
  const writes = await collectFsrsWriteBacks();
  if (writes.length === 0) {
    return { ok: true, reachable: true, sent: 0, applied: 0, detail: 'No FSRS write-backs to sync.' };
  }
  const body: FsrsWriteBackBody = { writes };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${LSAT_API_BASE}${FSRS_WRITE_BACK_PATH}`, {
      signal: controller.signal,
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return {
        ok: false,
        reachable: true,
        sent: writes.length,
        detail: `LSAT backend responded ${res.status}.`,
      };
    }
    let data: RawFsrsWriteBackResponse = {};
    try {
      data = (await res.json()) as RawFsrsWriteBackResponse;
    } catch {
      /* non-JSON body — still a 2xx, treat as accepted */
    }
    return {
      ok: true,
      reachable: true,
      sent: writes.length,
      applied: typeof data.applied === 'number' ? data.applied : undefined,
      reconciled: Array.isArray(data.reconciled) ? data.reconciled : undefined,
      detail: 'FSRS write-backs synced.',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reachable: false, sent: writes.length, detail: `Sidecar offline — ${msg}.` };
  } finally {
    clearTimeout(timer);
  }
}

/** Options for {@link useSyncFsrsWriteBack}. */
export interface UseSyncFsrsWriteBackOptions {
  /** Disable the hook entirely (e.g. behind a setting). Defaults to enabled. */
  enabled?: boolean;
  /** Override the background interval (ms). Defaults to {@link SYNC_FSRS_INTERVAL_MS}. */
  intervalMs?: number;
  /** Override the per-request timeout (ms). */
  timeoutMs?: number;
}

/** What {@link useSyncFsrsWriteBack} returns. */
export interface UseSyncFsrsWriteBack {
  /**
   * Push FSRS write-backs NOW. Call when a review session ends. Safe to call
   * repeatedly; de-duped against a concurrent push. Never throws.
   */
  sessionEnd: () => Promise<SyncFsrsResult>;
}

/**
 * DATA-4b host hook: write the host plane's per-card FSRS scheduling state back to
 * the LSAT sidecar's mirror (idempotent, last-write-wins). Fires on `sessionEnd()`
 * and on a ~5-minute background interval while mounted. Fully degrading — a down
 * sidecar is a silent no-op and never surfaces an error to the host.
 *
 * Mount once near the app root, alongside {@link useSyncProgress}. It owns no React
 * state (no re-renders); the push is fire-and-forget and de-duped so an interval
 * tick overlapping a `sessionEnd()` doesn't double-send.
 */
export function useSyncFsrsWriteBack(opts: UseSyncFsrsWriteBackOptions = {}): UseSyncFsrsWriteBack {
  const { enabled = true, intervalMs = SYNC_FSRS_INTERVAL_MS, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const inFlight = useRef<Promise<SyncFsrsResult> | null>(null);

  const push = useCallback((): Promise<SyncFsrsResult> => {
    if (inFlight.current) return inFlight.current;
    const p = pushFsrsWriteBack(timeoutMs).finally(() => {
      inFlight.current = null;
    });
    inFlight.current = p;
    return p;
  }, [timeoutMs]);

  const sessionEnd = useCallback((): Promise<SyncFsrsResult> => {
    if (!enabled) {
      return Promise.resolve({ ok: true, reachable: true, sent: 0, detail: 'Sync disabled.' });
    }
    return push();
  }, [enabled, push]);

  useEffect(() => {
    if (!enabled) return;
    void push();
    const id = setInterval(() => {
      void push();
    }, intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs, push]);

  return { sessionEnd };
}
