/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getDesktopBridge, isElectronRuntime } from '../lib/desktopBridge';

/**
 * BA3 — RAG/sidecar-aware offline status (StudyVault host).
 *
 * The TopBar already tracks `navigator.onLine` for a simple browser-online pill
 * (handleOnline/handleOffline). This context is the *richer* layer: it answers
 * "can the RAG stack actually serve a request right now?" by probing the
 * supervised sidecars via the Electron preload bridge, on top of
 * the browser-online signal.
 *
 * Because the existing Dexie fallback silently hides a sidecar outage, this is
 * the surface that makes the degradation *visible* (see OfflineBanner) so a
 * user knows RAG answers are unavailable rather than silently empty.
 *
 * Fully degrading: when the Electron preload bridge is absent we
 * fall back to `navigator.onLine` only — there are no managed sidecars to probe,
 * so we never claim "sidecars down" in the browser.
 */

/** Short, stable reason code for the current degradation (or 'ok'). */
export type OfflineReason = 'ok' | 'browser-offline' | 'sidecars-down';

export interface OfflineStatus {
  /** True when RAG features can't be served (browser offline OR sidecars down). */
  isOffline: boolean;
  /** Why we're degraded — drives the banner copy. */
  reason: OfflineReason;
  /** Whether the last sidecar probe found the RAG sidecars reachable. */
  sidecarsReachable: boolean;
  /** Re-probe immediately (backs the banner's Retry button). */
  retry: () => void;
}

// Mirror of the BA2 `SidecarStatus` rows returned by `get_sidecar_status`. Only
// the fields the offline derivation reads are typed; the rest (pid, etc.) are
// ignored. `ready` is the readiness-gate signal; `healthy` is the health-poll
// signal — for socketed sidecars they mirror each other (see lib.rs).
interface SidecarStatusRow {
  name: string;
  ready?: boolean;
  healthy?: boolean;
  ready_port?: number | null;
}

const OfflineContext = createContext<OfflineStatus | null>(null);

/** Re-probe cadence while mounted. ~10s keeps the banner fresh without churn. */
const PROBE_INTERVAL_MS = 10_000;

/**
 * Sidecars whose reachability gates RAG. SurrealDB (vector store) and
 * open-notebook (RAG service) are the load-bearing pair; the LSAT backend and
 * the port-less worker are not required for the host's RAG path, so a blip in
 * those alone should not raise the banner. Matched case-insensitively against
 * the sidecar `name` so naming tweaks in lib.rs don't silently break the gate.
 */
const RAG_SIDECAR_HINTS = ['surreal', 'notebook', 'open-notebook'];

function browserOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

function isRagSidecar(name: string): boolean {
  const lower = name.toLowerCase();
  return RAG_SIDECAR_HINTS.some((hint) => lower.includes(hint));
}

/**
 * Probe the supervised sidecars and decide whether the RAG pair is reachable.
 * Never throws: any failure (method missing on an older preload, IPC rejection,
 * shape drift) resolves to `false` so the caller can fall back to last-known-good
 * rather than crash the provider.
 */
async function probeSidecarsReachable(): Promise<boolean> {
  try {
    const bridge = getDesktopBridge();
    if (!bridge) return false;
    const rows: SidecarStatusRow[] = await bridge.sidecar.status();
    if (!Array.isArray(rows) || rows.length === 0) return false;
    const ragRows = rows.filter((row) => row && typeof row.name === 'string' && isRagSidecar(row.name));
    // If the shell reports no RAG sidecars at all, treat RAG as unavailable
    // rather than silently "ok" — the stack the host depends on isn't there.
    if (ragRows.length === 0) return false;
    // Every RAG sidecar must clear its readiness gate. Fall back to `healthy`
    // when `ready` is absent (older shell that predates the BA2 `ready` field).
    return ragRows.every((row) => (typeof row.ready === 'boolean' ? row.ready : row.healthy === true));
  } catch {
    return false;
  }
}

interface OfflineProviderProps {
  children: ReactNode;
}

export function OfflineProvider({ children }: OfflineProviderProps) {
  const electron = isElectronRuntime();
  const [online, setOnline] = useState<boolean>(() => browserOnline());
  // Default to reachable so a fresh mount doesn't flash the banner before the
  // first probe resolves; browser builds keep this `true` permanently.
  const [sidecarsReachable, setSidecarsReachable] = useState<boolean>(true);
  // Last-known-good cache: a single failed probe shouldn't alarm the user (a
  // transient blip during a sidecar respawn is common), so we only flip to
  // "down" after two consecutive failures. A success resets the streak.
  const failureStreak = useRef(0);

  // Track browser online/offline directly — this layer owns its own listeners
  // (it does not reuse the TopBar's local state) so it works wherever mounted.
  useEffect(() => {
    function handleOnline() {
      setOnline(true);
    }
    function handleOffline() {
      setOnline(false);
    }
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const runProbe = useCallback(async () => {
    // Browser dev: no sidecars to probe, so reachability tracks nothing extra.
    if (!electron) {
      setSidecarsReachable(true);
      return;
    }
    // Browser offline → don't bother probing localhost sockets; report
    // unreachable and let `reason` resolve to 'browser-offline'.
    if (!browserOnline()) {
      setSidecarsReachable(false);
      return;
    }
    const reachable = await probeSidecarsReachable();
    if (reachable) {
      failureStreak.current = 0;
      setSidecarsReachable(true);
    } else {
      failureStreak.current += 1;
      // Last-known-good: only surface "down" once a second probe also fails.
      if (failureStreak.current >= 2) setSidecarsReachable(false);
    }
  }, [electron]);

  // Periodic probe + an immediate one on mount, plus a re-probe whenever the
  // window regains focus or comes back online (the moments most likely to have
  // changed the sidecar picture).
  useEffect(() => {
    if (!electron) {
      setSidecarsReachable(true);
      return undefined;
    }
    let alive = true;
    const tick = () => {
      if (alive) void runProbe();
    };
    tick();
    const interval = window.setInterval(tick, PROBE_INTERVAL_MS);
    const handleFocus = () => tick();
    window.addEventListener('focus', handleFocus);
    window.addEventListener('online', handleFocus);
    return () => {
      alive = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('online', handleFocus);
    };
  }, [electron, runProbe]);

  const retry = useCallback(() => {
    // Retry is an explicit user action: clear the streak so a single fresh
    // success immediately clears the banner without waiting out the dampener.
    failureStreak.current = 0;
    setOnline(browserOnline());
    void runProbe();
  }, [runProbe]);

  const value = useMemo<OfflineStatus>(() => {
    let reason: OfflineReason = 'ok';
    if (!online) reason = 'browser-offline';
    else if (electron && !sidecarsReachable) reason = 'sidecars-down';
    return {
      isOffline: reason !== 'ok',
      reason,
      sidecarsReachable,
      retry,
    };
  }, [online, sidecarsReachable, electron, retry]);

  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

export function useOfflineStatus(): OfflineStatus {
  const context = useContext(OfflineContext);
  if (!context) {
    throw new Error('useOfflineStatus must be used inside OfflineProvider');
  }
  return context;
}
