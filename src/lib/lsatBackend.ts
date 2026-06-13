/**
 * Host-side client for the LSAT backend sidecar (StudyVault).
 *
 * The LSAT FastAPI sidecar runs on 127.0.0.1:8100 (supervised by the Tauri
 * shell; see build_sidecar_specs in src-tauri/src/lib.rs). The host can't reach
 * the LSAT React app (separate top-level branch) but it CAN reach the sidecar
 * over HTTP — so System Health surfaces its liveness alongside the SurrealDB +
 * open-notebook sidecars.
 *
 * Same fully-degrading timeout/AbortController pattern as lsatReviewBridge.ts:
 * any failure (down, timeout, shape drift) returns `{ ok: false, reachable:
 * false, ... }` so the System Health card shows "offline" rather than hanging
 * the page.
 */

const LSAT_API_BASE = 'http://127.0.0.1:8100';
/** Deep-link into the LSAT app's AI/model settings (host hard-navigates here). */
export const LSAT_SETTINGS_PATH = '/lsat/settings';

export interface LsatBackendHealth {
  /** True when the sidecar answered a 2xx on /api/health. */
  ok: boolean;
  /** Distinguishes "answered but unhealthy" from "unreachable". */
  reachable: boolean;
  /** Latency of the health probe in ms (when reachable). */
  latencyMs?: number;
  /** Provider/AI status when /api/ai/health is available. */
  ai?: { provider?: string; ready?: boolean; detail?: string };
  /** Human-readable status for the UI. */
  detail: string;
}

async function fetchJson(
  path: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; data: unknown } | { ok: false; status: 0; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${LSAT_API_BASE}${path}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON body */
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe the LSAT sidecar's liveness (+ best-effort AI/provider health). Never
 * throws; safe to call from a System Health `useEffect` without blocking render.
 */
export async function checkLsatBackendHealth(timeoutMs = 2500): Promise<LsatBackendHealth> {
  const started = typeof performance !== 'undefined' ? performance.now() : 0;
  const health = await fetchJson('/api/health', timeoutMs);

  if (!('ok' in health) || !health.ok) {
    const reason = 'error' in health ? health.error : `responded ${('status' in health ? health.status : 0)}`;
    return {
      ok: false,
      reachable: false,
      detail: `Sidecar offline — ${reason}. Start StudyVault's LSAT backend on :8100.`,
    };
  }

  const latencyMs = typeof performance !== 'undefined' ? Math.round(performance.now() - started) : undefined;

  // Best-effort AI/provider health (don't fail the card if this endpoint 404s
  // on an older backend build).
  let ai: LsatBackendHealth['ai'];
  const aiRes = await fetchJson('/api/ai/health', timeoutMs);
  if ('ok' in aiRes && aiRes.ok && aiRes.data && typeof aiRes.data === 'object') {
    const d = aiRes.data as Record<string, unknown>;
    ai = {
      provider: typeof d.provider === 'string' ? d.provider : undefined,
      ready: typeof d.ok === 'boolean' ? d.ok : typeof d.ready === 'boolean' ? d.ready : undefined,
      detail: typeof d.detail === 'string' ? d.detail : undefined,
    };
  }

  return {
    ok: true,
    reachable: true,
    latencyMs,
    ai,
    detail: ai?.ready === false ? 'Sidecar up — LLM provider not reachable.' : 'Sidecar healthy.',
  };
}
