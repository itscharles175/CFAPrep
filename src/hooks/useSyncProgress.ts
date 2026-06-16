/**
 * DATA-4a — host -> backend cross-domain progress feed (read-only into the backend).
 *
 * The host data plane (CFA/Quant/Excel, Dexie) periodically pushes its
 * review/attempt/mastery snapshots — already projected onto the canonical
 * cross-domain shapes (`src/lib/dataDictionary.ts`, mirrored by the backend
 * `serializers.cross_domain_*`) — to the LSAT sidecar's
 * `POST /api/sync/progress-updates`, which UPSERTS them idempotently into
 * `HostProgressSnapshot`. That feed is what the LSAT ability/plan engine reads
 * later (LEARN-1/LEARN-3) so it can rank/plan across BOTH planes without
 * reaching back into the host's Dexie store.
 *
 * Strictly host -> backend: nothing here ever mutates host data, and the backend
 * never writes back through this snapshot (the bidirectional per-card FSRS sync
 * is the HIGH-risk DATA-4b, deferred to Wave 8).
 *
 * Transport mirrors `lsatBackend.ts` / `lsatReviewBridge.ts`: a fully-degrading
 * fetch (AbortController + timeout). It NEVER throws and is a clean no-op when
 * the sidecar is down — a missing LSAT backend must never block or error the
 * host. The hook fires on two triggers:
 *   - `sessionEnd` — call the returned `sessionEnd()` when a study session ends,
 *   - a ~5-minute interval — a low-frequency catch-up while the host is open.
 *
 * The route is brand-new and has no narrow `response_model` yet (like the other
 * legacy LSAT routes), so it is not in the committed `api.gen.ts` baseline; the
 * request body is built from the canonical `dataDictionary.ts` types and the
 * response is read defensively. When the backend grows a typed `response_model`,
 * regenerate `api.gen.ts` and anchor the path here like `lsatReviewBridge.ts`.
 */
import { useCallback, useEffect, useRef } from 'react';
import type {
  CrossDomainAttempt,
  CrossDomainMastery,
  CrossDomainReviewCard,
} from '../lib/dataDictionary';
import { getStorage } from '../lib/storage';

const LSAT_API_BASE = 'http://127.0.0.1:8100';
const PROGRESS_UPDATES_PATH = '/api/sync/progress-updates';

/** ~5 minutes between background catch-up pushes. */
export const SYNC_PROGRESS_INTERVAL_MS = 5 * 60 * 1000;
/** Default request timeout — generous since this is background, never on a render path. */
const DEFAULT_TIMEOUT_MS = 4000;
/** Defensive cap so an unbounded local bank can't build a multi-MB request. */
const MAX_SNAPSHOTS = 2000;

/** One snapshot in the `POST /api/sync/progress-updates` body (canonical shape). */
interface ProgressSnapshotWire {
  crossId: string;
  domain: string;
  kind: 'review' | 'attempt' | 'mastery';
  observedAt?: string;
  /** The full canonical record carried verbatim (read by the engine, not coerced). */
  payload: CrossDomainReviewCard | CrossDomainAttempt | CrossDomainMastery;
}

/** The `POST /api/sync/progress-updates` request body. */
interface ProgressUpdatesBody {
  snapshots: ProgressSnapshotWire[];
}

/** Documented `POST /api/sync/progress-updates` body (legacy untyped on the wire). */
interface RawProgressUpdatesResponse {
  ok?: boolean;
  received?: number;
  upserted?: number;
  unchanged?: number;
  skipped?: number;
}

/** Outcome of one progress push. Never thrown — always returned. */
export interface SyncProgressResult {
  /** True when the sidecar answered a 2xx. */
  ok: boolean;
  /** Distinguishes "answered but error" from "unreachable" (sidecar down). */
  reachable: boolean;
  /** Snapshots collected from the host and sent. */
  sent: number;
  /** Rows the backend upserted (insert or genuine change), when reported. */
  upserted?: number;
  /** Human-readable status for diagnostics/logging. */
  detail: string;
}

/**
 * Collect the host plane's canonical cross-domain snapshots (review cards,
 * attempts, mastery) from the active driver's `crossDomainBridge`. Returns an
 * empty list when the active driver doesn't expose the bridge (feature-detected)
 * or any store read fails — the caller then simply skips the push.
 */
async function collectHostSnapshots(): Promise<ProgressSnapshotWire[]> {
  const bridge = getStorage().crossDomainBridge;
  if (!bridge) return [];
  try {
    const [reviews, attempts, mastery] = await Promise.all([
      bridge.reviewCards(),
      bridge.attempts(),
      bridge.mastery(),
    ]);
    const snapshots: ProgressSnapshotWire[] = [];
    for (const card of reviews) {
      snapshots.push({
        crossId: card.crossId,
        domain: card.domain,
        kind: 'review',
        observedAt: card.dueAt,
        payload: card,
      });
    }
    for (const attempt of attempts) {
      snapshots.push({
        crossId: attempt.crossId,
        domain: attempt.domain,
        kind: 'attempt',
        observedAt: attempt.createdAt,
        payload: attempt,
      });
    }
    for (const m of mastery) {
      snapshots.push({
        crossId: m.crossId,
        domain: m.domain,
        kind: 'mastery',
        payload: m,
      });
    }
    return snapshots.slice(0, MAX_SNAPSHOTS);
  } catch {
    // A store read failed — treat as "nothing to sync" rather than throwing.
    return [];
  }
}

/**
 * Push the host plane's current cross-domain progress snapshots to the LSAT
 * sidecar. Fully degrading: any failure (sidecar down, timeout, shape drift)
 * resolves to `{ ok: false, reachable: false, ... }` — it NEVER throws, so a
 * missing sidecar is a silent no-op. A no-snapshots collection short-circuits
 * without a request.
 */
export async function pushHostProgress(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SyncProgressResult> {
  const snapshots = await collectHostSnapshots();
  if (snapshots.length === 0) {
    return { ok: true, reachable: true, sent: 0, upserted: 0, detail: 'No host progress to sync.' };
  }
  const body: ProgressUpdatesBody = { snapshots };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${LSAT_API_BASE}${PROGRESS_UPDATES_PATH}`, {
      signal: controller.signal,
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return {
        ok: false,
        reachable: true,
        sent: snapshots.length,
        detail: `LSAT backend responded ${res.status}.`,
      };
    }
    let data: RawProgressUpdatesResponse = {};
    try {
      data = (await res.json()) as RawProgressUpdatesResponse;
    } catch {
      /* non-JSON body — still a 2xx, treat as accepted */
    }
    return {
      ok: true,
      reachable: true,
      sent: snapshots.length,
      upserted: typeof data.upserted === 'number' ? data.upserted : undefined,
      detail: 'Host progress synced.',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reachable: false, sent: snapshots.length, detail: `Sidecar offline — ${msg}.` };
  } finally {
    clearTimeout(timer);
  }
}

/** Options for {@link useSyncProgress}. */
export interface UseSyncProgressOptions {
  /** Disable the hook entirely (e.g. behind a setting). Defaults to enabled. */
  enabled?: boolean;
  /** Override the background interval (ms). Defaults to {@link SYNC_PROGRESS_INTERVAL_MS}. */
  intervalMs?: number;
  /** Override the per-request timeout (ms). */
  timeoutMs?: number;
}

/** What {@link useSyncProgress} returns. */
export interface UseSyncProgress {
  /**
   * Push host progress NOW. Call this when a study session ends. Safe to call
   * repeatedly; it is debounced against concurrent pushes (a push already in
   * flight is reused rather than firing a second request). Never throws.
   */
  sessionEnd: () => Promise<SyncProgressResult>;
}

/**
 * DATA-4a host hook: keep the LSAT sidecar's read-only mirror of host
 * cross-domain progress fresh. Fires on `sessionEnd()` (call it from the
 * study-session UI when a session ends) and on a ~5-minute background interval
 * while mounted. Fully degrading — a down sidecar is a silent no-op and never
 * surfaces an error to the host.
 *
 * Mount once near the app root. It owns no React state (no re-renders); the push
 * is fire-and-forget and de-duped so an interval tick that overlaps a
 * `sessionEnd()` push doesn't double-send.
 */
export function useSyncProgress(opts: UseSyncProgressOptions = {}): UseSyncProgress {
  const { enabled = true, intervalMs = SYNC_PROGRESS_INTERVAL_MS, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  // A single in-flight push is reused so an interval tick overlapping a
  // sessionEnd() (or two rapid sessionEnd() calls) never double-sends.
  const inFlight = useRef<Promise<SyncProgressResult> | null>(null);

  const push = useCallback((): Promise<SyncProgressResult> => {
    if (inFlight.current) return inFlight.current;
    const p = pushHostProgress(timeoutMs).finally(() => {
      inFlight.current = null;
    });
    inFlight.current = p;
    return p;
  }, [timeoutMs]);

  const sessionEnd = useCallback((): Promise<SyncProgressResult> => {
    if (!enabled) {
      return Promise.resolve({ ok: true, reachable: true, sent: 0, detail: 'Sync disabled.' });
    }
    return push();
  }, [enabled, push]);

  useEffect(() => {
    if (!enabled) return;
    // Fire once on mount (catch-up), then on the background interval. The push
    // never throws, so an unhandled rejection can't escape the timer callback.
    void push();
    const id = setInterval(() => {
      void push();
    }, intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs, push]);

  return { sessionEnd };
}
