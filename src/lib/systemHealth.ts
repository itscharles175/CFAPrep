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
