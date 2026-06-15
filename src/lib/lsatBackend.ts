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
 *
 * DATA-1 (K1): the wire shapes are sourced from the LSAT domain's generated
 * OpenAPI types (`@/domains/lsat/lib/api.gen` — the same `api.gen.ts` the LSAT
 * app consumes, regenerated from the committed `openapi-baseline.json`). Reusing
 * those types here, rather than re-declaring request/response stubs, means a
 * contract change (e.g. a renamed `SettingsPatch` field) surfaces at `tsc` time
 * across both domains. The host keeps its own degrading-fetch transport; only
 * the typed boundary is shared.
 */
import type { components, operations } from '@/domains/lsat/lib/api.gen';

const LSAT_API_BASE = 'http://127.0.0.1:8100';

/** Request body for `PUT /api/settings` (generated from the backend contract). */
type SettingsPatch = components['schemas']['SettingsPatch'];
/** The `/api/ai/health` 2xx body — an open record in the contract; read defensively. */
type AiHealthBody = NonNullable<
  operations['ai_health_api_ai_health_get']['responses'][200]['content']['application/json']
>;
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
    // The contract types this body as an open record (`{ [key: string]: unknown }`),
    // so read each field defensively rather than trusting a fixed shape.
    const d = aiRes.data as AiHealthBody;
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

/** BB4 — cloud-budget picture + next-call dry-run estimate the sidecar reports. */
export interface LsatCloudBudget {
  /** Month-to-date cloud spend in USD (durable; survives a restart). */
  spend_usd: number;
  /** Configured monthly budget, or null when unset (0 => unlimited / opt-in). */
  budget_usd: number | null;
  /** Whether another cloud call is allowed under the budget. */
  within_budget: boolean;
  /** Remaining headroom in USD, or null when no budget is configured. */
  remaining_usd: number | null;
  /** Whether cloud generation is configured AND has an API key. */
  cloud_enabled: boolean;
  /** Whether the backend's read-only dry-run toggle is on. */
  dry_run: boolean;
  pricing: {
    input_cost_per_mtok_usd: number;
    output_cost_per_mtok_usd: number;
  };
  /** A forecast of the NEXT cloud call — priced like a real call, never invoked. */
  next_call: {
    input_tokens: number;
    output_tokens: number;
    estimated_cost_usd: number;
    /** True only when admitting this call would push spend past the cap. */
    would_exceed_budget: boolean;
  };
}

/** BB4 — local Whisper/voice model cache status the sidecar reports (best-effort). */
export interface LsatVoiceCacheStatus {
  model_id: string;
  cache_dir: string;
  cache_dir_exists: boolean;
  /** Whether matching model files were found in the server-side cache dir. */
  downloaded: boolean;
  file_count: number;
  size_bytes: number;
  /** The in-browser STT path is always available regardless of on-disk cache. */
  browser_cached: boolean;
  note: string;
}

export interface LsatCloudBudgetReport {
  /** True when the sidecar answered a 2xx on /observability/cloud-budget. */
  ok: boolean;
  /** Distinguishes "answered but error" from "unreachable". */
  reachable: boolean;
  cloud?: LsatCloudBudget;
  voice?: LsatVoiceCacheStatus;
  /** Human-readable status for the UI. */
  detail: string;
}

/**
 * BB4: fetch the LSAT sidecar's cloud-budget picture (month-to-date spend vs the
 * configured monthly budget + a NEXT-CALL dry-run cost estimate) and the local
 * Whisper/voice model cache status, in one read-only call. Never throws — any
 * failure degrades to `{ ok: false, reachable: false, ... }` so the System
 * Health card shows "offline" rather than hanging.
 *
 * `inputTokens`/`outputTokens` override the dry-run token counts the estimate is
 * priced against; omit them to use the backend's representative defaults.
 */
export async function getLsatCloudBudget(
  opts: { inputTokens?: number; outputTokens?: number } = {},
  timeoutMs = 3000,
): Promise<LsatCloudBudgetReport> {
  const params = new URLSearchParams();
  if (typeof opts.inputTokens === 'number') params.set('input_tokens', String(opts.inputTokens));
  if (typeof opts.outputTokens === 'number') params.set('output_tokens', String(opts.outputTokens));
  const query = params.toString();
  const res = await fetchJson(
    `/api/observability/cloud-budget${query ? `?${query}` : ''}`,
    timeoutMs,
  );

  if (!('ok' in res) || !res.ok || !res.data || typeof res.data !== 'object') {
    const reason = 'error' in res ? res.error : `responded ${('status' in res ? res.status : 0)}`;
    return {
      ok: false,
      reachable: 'error' in res ? false : true,
      detail: `Cloud-budget unavailable — ${reason}.`,
    };
  }

  const d = res.data as { cloud?: LsatCloudBudget; voice?: LsatVoiceCacheStatus };
  return {
    ok: true,
    reachable: true,
    cloud: d.cloud,
    voice: d.voice,
    detail: 'Cloud-budget report loaded.',
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
  // Build the `PUT /api/settings` body against the generated `SettingsPatch`
  // contract (DATA-1) — narrowed to the two fields this sync owns. `applied`
  // keeps its own concrete shape so the public return type is unchanged.
  const provider: NonNullable<SettingsPatch['local_provider']> = isOllama ? 'ollama' : 'lmstudio';
  const patch: { local_provider: string; lmstudio_url?: string } = { local_provider: provider };
  if (!isOllama) patch.lmstudio_url = base;

  const settingsPatch: Pick<SettingsPatch, 'local_provider' | 'lmstudio_url'> = {
    local_provider: provider,
    ...(isOllama ? {} : { lmstudio_url: base }),
  };

  const res = await fetchJson('/api/settings', timeoutMs, {
    method: 'PUT',
    body: JSON.stringify(settingsPatch),
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
