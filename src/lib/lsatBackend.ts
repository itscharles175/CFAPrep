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
  ai?: {
    provider?: string;
    ready?: boolean;
    detail?: string;
    /** S5-A: effective model routing the LSAT backend reports (read-only). */
    models?: { explain?: string; gen?: string; diagnose?: string };
    /** Configured model ids the active provider doesn't currently expose. */
    missingModels?: string[];
  };
  /** Human-readable status for the UI. */
  detail: string;
}

async function fetchJson(
  path: string,
  timeoutMs: number,
  init: { method?: string; body?: string } = {},
): Promise<{ ok: boolean; status: number; data: unknown } | { ok: false; status: 0; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${LSAT_API_BASE}${path}`, {
      signal: controller.signal,
      method: init.method || 'GET',
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body,
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
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    // S5-A: the AI-health payload already carries the effective model routing
    // (explain/gen/diagnose) + any configured ids the provider can't serve, so
    // surface them read-only — no extra request. Only build the `models` object
    // when at least one id is present.
    const models = {
      explain: str(d.explain_model),
      gen: str(d.gen_model),
      diagnose: str(d.diagnose_model),
    };
    const hasModels = models.explain || models.gen || models.diagnose;
    const missingModels = Array.isArray(d.missing_models)
      ? (d.missing_models.filter((m) => typeof m === 'string') as string[])
      : undefined;
    ai = {
      provider: str(d.provider),
      ready: typeof d.ok === 'boolean' ? d.ok : typeof d.ready === 'boolean' ? d.ready : undefined,
      detail: str(d.detail),
      models: hasModels ? models : undefined,
      missingModels: missingModels && missingModels.length ? missingModels : undefined,
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

export interface LsatSyncResult {
  ok: boolean;
  detail: string;
  /** The provider/endpoint patch that was pushed (when ok). */
  applied?: { local_provider: string; lmstudio_url?: string };
}

/**
 * S5-B: push the host's local-model provider + endpoint to the LSAT backend
 * (`PUT /api/settings`) so the two domains use the same provider — the write
 * side of the silent-mismatch fix (S5-A surfaces it read-only). Only the
 * provider + LM Studio URL are synced; the per-role model ids (explain/gen/
 * diagnose) are LSAT-specific and left untouched. Never throws.
 *
 * Provider is inferred from the host base URL (Ollama :11434 vs LM Studio
 * :1234). For Ollama there is no URL field in the backend's settings patch, so
 * only the provider is set.
 */
export async function syncProviderToLsat(
  host: { baseUrl?: string },
  timeoutMs = 4000,
): Promise<LsatSyncResult> {
  const base = (host.baseUrl || '').trim();
  if (!base) return { ok: false, detail: 'No host model server URL is configured to sync.' };

  const isOllama = /11434|ollama/i.test(base);
  const patch: { local_provider: string; lmstudio_url?: string } = {
    local_provider: isOllama ? 'ollama' : 'lmstudio',
  };
  if (!isOllama) patch.lmstudio_url = base;

  const res = await fetchJson('/api/settings', timeoutMs, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });

  if (!('ok' in res) || !res.ok) {
    const reason = 'error' in res ? res.error : `responded ${('status' in res ? res.status : 0)}`;
    return { ok: false, detail: `Could not update LSAT settings — ${reason}.` };
  }
  return {
    ok: true,
    applied: patch,
    detail: `LSAT now set to provider "${patch.local_provider}"${patch.lmstudio_url ? ` (${patch.lmstudio_url})` : ''}.`,
  };
}
