/**
 * OPS-1 — System Health sidecar console (host-side Tauri client).
 *
 * A thin, typed wrapper over the native `get_sidecar_status` / `get_sidecar_logs`
 * Tauri commands (defined in `src-tauri/src/lib.rs`, shipped by BA1/BA2/BA8).
 * The desktop shell supervises four sidecars — SurrealDB (:8000), the
 * open-notebook API (:5055), the open-notebook worker (no socket), and the LSAT
 * backend (:8100) — and exposes their live status + a rolling stdout/stderr ring
 * buffer per sidecar. This module surfaces both to the host UI.
 *
 * Everything is guarded for the non-Tauri (browser dev / Vitest) case: the
 * commands only exist inside the desktop runtime, so calls there return a clear
 * "unavailable" state rather than throwing. Same lazy-invoke idiom as
 * `OfflineContext` / `domains/lsat/lib/tauri.ts` — the `@tauri-apps/api/core`
 * module is imported dynamically and only under Tauri, so the web bundle never
 * pulls it in.
 */

/**
 * Per-sidecar status snapshot — mirrors the Rust `SidecarStatus` payload
 * returned by `get_sidecar_status` exactly (serde field names are snake_case on
 * the wire and preserved here). `port` and `ready_port` carry the same value;
 * both are emitted by the backend so existing `port` consumers keep working.
 */
export interface SidecarStatus {
  /** Display name, e.g. "SurrealDB", "open-notebook API", "LSAT backend". */
  name: string;
  /** Readiness port the supervisor probes, or `null` for socket-less sidecars
   *  (the open-notebook worker). */
  port: number | null;
  /** Alias of `port`, named to match the readiness gate (BA2). Same value. */
  ready_port: number | null;
  /** `true` when the readiness port is accepting connections. Socket-less
   *  sidecars report `true` while their process handle is tracked. */
  healthy: boolean;
  /** Whether the readiness gate is satisfied (BA2) — port listening, or process
   *  liveness for the socket-less worker. Mirrors `healthy` today. */
  ready: boolean;
  /** Names of sidecars that had to be ready before this one started (BA2).
   *  Empty for sidecars with no dependencies (SurrealDB, the LSAT backend). */
  depends_on: string[];
  /** OS process id of the live child, if one is currently tracked. */
  pid: number | null;
}

/** Whether the host is running inside the Tauri desktop shell. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Snapshot the status of every supervised sidecar. Returns `null` outside Tauri
 * (browser dev / tests) and on any invoke failure, so the caller can render an
 * honest "desktop-app only" / "unavailable" state instead of throwing. The
 * vector preserves spec order: SurrealDB, open-notebook API, open-notebook
 * worker, LSAT backend.
 */
export async function getSidecarStatus(): Promise<SidecarStatus[] | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<SidecarStatus[]>('get_sidecar_status');
  } catch {
    return null;
  }
}

/**
 * Fetch the most recent captured stdout/stderr lines (oldest → newest, up to the
 * backend's ring-buffer capacity) for one named sidecar. An unknown name — or a
 * sidecar that hasn't emitted anything yet — yields an empty array from the
 * backend, so this only returns `null` outside Tauri or on an invoke failure.
 */
export async function getSidecarLogs(name: string): Promise<string[] | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string[]>('get_sidecar_logs', { name });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// OPS-3 — aggregated System-Health verdict
// ---------------------------------------------------------------------------

/** Single ok/degraded/error vocabulary shared by the badge + both sources. */
export type HealthVerdict = 'ok' | 'degraded' | 'error';

/**
 * OPS-3 — the native sidecar-supervision roll-up (`get_system_health_aggregated`
 * Tauri command). Mirrors the Rust `SystemHealthAggregate` payload exactly
 * (snake_case on the wire). Speaks only to PROCESS supervision — required vs
 * optional sidecar liveness; the LSAT backend's own internal health is layered
 * in separately from its `/observability/health-aggregated` endpoint.
 */
export interface SidecarHealthAggregate {
  /** "ok" (all ready) | "degraded" (only an OPTIONAL sidecar down) | "error"
   *  (a REQUIRED sidecar is down). */
  status: HealthVerdict;
  /** Count of sidecars whose readiness gate is satisfied. */
  ready: number;
  /** Count of not-ready REQUIRED sidecars (drives "error"). */
  required_down: number;
  /** Count of down/absent OPTIONAL sidecars (drives "degraded"). */
  optional_down: number;
  /** Total tracked sidecars (launched + skipped-optional). */
  total: number;
  /** Names of the not-ready REQUIRED sidecars, for a precise message. */
  required_down_names: string[];
}

/**
 * Snapshot the native sidecar-supervision verdict. Returns `null` outside Tauri
 * (browser dev / tests) and on any invoke failure, so callers can fall back to
 * the backend-only signal rather than throwing.
 */
export async function getSidecarHealthAggregated(): Promise<SidecarHealthAggregate | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<SidecarHealthAggregate>('get_system_health_aggregated');
  } catch {
    return null;
  }
}

/**
 * The LSAT backend's own consolidated health (GET
 * `/observability/health-aggregated`). A narrow, defensively-read view of the
 * fields the System Health badge + Runtime Metrics tab consume. Everything is
 * optional because the backend may be an older build (the endpoint 404s) or
 * unreachable — callers handle a `null` report.
 */
export interface BackendHealthAggregate {
  status: HealthVerdict;
  ok: boolean;
  reasons: string[];
  db_ready: boolean;
  worker_ready: boolean;
  backup_status: string | null;
  gen_queued: number;
  gen_running: number;
  explain_p50_ms: number | null;
  cloud_tokens: { input_tokens: number; output_tokens: number; total_tokens: number };
  cloud_monthly_budget_usd: number | null;
  cloud_spend_mtd_usd: number;
  cloud_budget_within: boolean;
  sqlite_health: {
    pragmas: Record<string, unknown>;
    busy_retries: number;
    wal_estimate_if_cheap: number | null;
  };
}

/**
 * Fetch the LSAT backend's aggregated health over HTTP (127.0.0.1:8100). Fully
 * degrading — any failure (down, timeout, 404 on an older build, shape drift)
 * returns `null` so the badge falls back to the sidecar-only verdict instead of
 * hanging the page. Mirrors the degrading-fetch idiom in `lsatBackend.ts`.
 */
export async function getBackendHealthAggregated(
  timeoutMs = 2500,
): Promise<BackendHealthAggregate | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('http://127.0.0.1:8100/api/observability/health-aggregated', {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<BackendHealthAggregate> | null;
    if (!data || typeof data !== 'object') return null;
    return data as BackendHealthAggregate;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The combined ok/degraded/error verdict + the two sources behind it. */
export interface AggregatedSystemHealth {
  /** The worst of the two available sources (error > degraded > ok). */
  verdict: HealthVerdict;
  /** Native sidecar-supervision roll-up, or `null` outside Tauri / on failure. */
  sidecars: SidecarHealthAggregate | null;
  /** LSAT backend internal health, or `null` when unreachable / older build. */
  backend: BackendHealthAggregate | null;
}

const VERDICT_RANK: Record<HealthVerdict, number> = { ok: 0, degraded: 1, error: 2 };

/**
 * Fold an arbitrary set of verdicts into the worst one (error beats degraded
 * beats ok). Ignores `null`/unknown inputs; defaults to "ok" when none are
 * present so an all-unavailable environment reads neutral rather than alarming.
 */
export function worstVerdict(...verdicts: Array<HealthVerdict | null | undefined>): HealthVerdict {
  let rank = 0;
  for (const v of verdicts) {
    if (v && v in VERDICT_RANK && VERDICT_RANK[v] > rank) rank = VERDICT_RANK[v];
  }
  return (Object.keys(VERDICT_RANK) as HealthVerdict[]).find((k) => VERDICT_RANK[k] === rank) ?? 'ok';
}

/**
 * OPS-3 — single entry point for the System Health header badge. Pulls the
 * native sidecar verdict and the backend's internal-health verdict in parallel
 * and folds them into one. Either source may be `null` (browser dev, sidecar
 * down, older backend); the combined verdict is the worst of whatever is
 * available, defaulting to "ok" when nothing is reachable so a pure-browser
 * session isn't falsely alarmed.
 */
export async function getAggregatedSystemHealth(
  timeoutMs = 2500,
): Promise<AggregatedSystemHealth> {
  const [sidecars, backend] = await Promise.all([
    getSidecarHealthAggregated(),
    getBackendHealthAggregated(timeoutMs),
  ]);
  return {
    verdict: worstVerdict(sidecars?.status, backend?.status),
    sidecars,
    backend,
  };
}
