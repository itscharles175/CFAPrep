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
import type { components, operations, paths } from '@/domains/lsat/lib/api.gen';
import { fetchLsatSidecarJson } from './lsatSidecarClient';
import { normalizeLoopbackHttpBaseUrl } from './localUrlPolicy';

const HEALTH_PATH = '/api/health' satisfies keyof paths;
const AI_HEALTH_PATH = '/api/ai/health' satisfies keyof paths;
const CLOUD_BUDGET_PATH = '/api/observability/cloud-budget' satisfies keyof paths;
const SETTINGS_PATH = '/api/settings' satisfies keyof paths;
const SCHEDULED_TASKS_PATH = '/api/observability/scheduled-tasks' satisfies keyof paths;
const SCHEDULER_RUNS_PATH = '/api/observability/scheduler-runs' satisfies keyof paths;
const SCHEDULED_TASK_RUN_PATH = '/api/observability/scheduled-tasks/{key}/run' satisfies keyof paths;
const SCHEDULED_TASKS_RUN_DUE_PATH = '/api/observability/scheduled-tasks/run-due' satisfies keyof paths;
const SCHEDULED_TASK_DEFAULTS_PATH = '/api/observability/scheduled-tasks/defaults' satisfies keyof paths;

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
  const res = await fetchLsatSidecarJson(path, {
    timeoutMs,
    method: init.method || 'GET',
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body,
  });
  if (res.reachable) return { ok: res.ok, status: res.status, data: res.data };
  return { ok: false, status: 0, error: res.error ?? 'LSAT backend unreachable' };
}

/**
 * Probe the LSAT sidecar's liveness (+ best-effort AI/provider health). Never
 * throws; safe to call from a System Health `useEffect` without blocking render.
 */
export async function checkLsatBackendHealth(timeoutMs = 2500): Promise<LsatBackendHealth> {
  const started = typeof performance !== 'undefined' ? performance.now() : 0;
  const health = await fetchJson(HEALTH_PATH, timeoutMs);

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
  const aiRes = await fetchJson(AI_HEALTH_PATH, timeoutMs);
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
    `${CLOUD_BUDGET_PATH}${query ? `?${query}` : ''}`,
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
  const rawBase = (host.baseUrl || '').trim();
  if (!rawBase) return { ok: false, detail: 'No host model server URL is configured to sync.' };

  let base: string;
  try {
    base = normalizeLoopbackHttpBaseUrl(rawBase, 'Host model server URL');
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : 'Host model server URL must be local.',
    };
  }

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

  const res = await fetchJson(SETTINGS_PATH, timeoutMs, {
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

/**
 * INT-2: the editable subset of the backend `SettingsPatch` the System Health
 * model-routing modal owns. A superset of what {@link syncProviderToLsat} writes
 * (which only owns provider + URL): the modal also lets the user retarget the
 * per-role model ids (explain/gen/diagnose) and the generation provider
 * (ollama|cloud). Every field is optional — only the keys actually present in a
 * given patch are sent, so an unset field is never zeroed out on the backend.
 */
export interface LsatModelRoutingPatch {
  explain_model?: string;
  gen_model?: string;
  diagnose_model?: string;
  gen_provider?: 'ollama' | 'cloud';
  local_provider?: 'ollama' | 'lmstudio';
  lmstudio_url?: string;
}

/** Result of {@link pushModelRoutingToLsat} — the applied patch echoed back. */
export interface LsatModelRoutingResult {
  ok: boolean;
  detail: string;
  /** The patch that was pushed (when ok) — only the keys actually sent. */
  applied?: LsatModelRoutingPatch;
}

/**
 * INT-2: push an explicit model-routing patch to the LSAT backend
 * (`PUT /api/settings`). This is the write side of the model-routing edit modal
 * — broader than {@link syncProviderToLsat} (which only matches the host's
 * provider/endpoint): here the user edits the per-role model ids and providers
 * directly. Backward-compatible and additive — `syncProviderToLsat` keeps its
 * exact signature/behaviour for the "Match host provider" quick action.
 *
 * Only the keys present on `patch` are sent (a missing key leaves that backend
 * setting untouched); empty-string model ids are dropped so the modal can clear
 * a field locally without nulling the backend. Never throws — any failure
 * degrades to `{ ok: false, ... }` so the modal can surface a message instead of
 * crashing the page.
 */
export async function pushModelRoutingToLsat(
  patch: LsatModelRoutingPatch,
  timeoutMs = 4000,
): Promise<LsatModelRoutingResult> {
  // Build the request body against the generated `SettingsPatch` contract
  // (DATA-1) — narrowed to the fields this modal owns. Drop empty-string model
  // ids and undefined keys so an unedited/cleared field is never sent.
  const trimmed = (v: string | undefined) => (typeof v === 'string' ? v.trim() : undefined);
  const candidate: LsatModelRoutingPatch = {
    explain_model: trimmed(patch.explain_model) || undefined,
    gen_model: trimmed(patch.gen_model) || undefined,
    diagnose_model: trimmed(patch.diagnose_model) || undefined,
    gen_provider: patch.gen_provider,
    local_provider: patch.local_provider,
    lmstudio_url: trimmed(patch.lmstudio_url) || undefined,
  };
  if (candidate.lmstudio_url) {
    try {
      candidate.lmstudio_url = normalizeLoopbackHttpBaseUrl(
        candidate.lmstudio_url,
        'LM Studio URL',
      );
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : 'LM Studio URL must be local.',
      };
    }
  }
  const applied: LsatModelRoutingPatch = {};
  const settingsPatch: Pick<
    SettingsPatch,
    'explain_model' | 'gen_model' | 'diagnose_model' | 'gen_provider' | 'local_provider' | 'lmstudio_url'
  > = {};
  (Object.keys(candidate) as Array<keyof LsatModelRoutingPatch>).forEach((key) => {
    const value = candidate[key];
    if (value === undefined) return;
    // `applied` and `settingsPatch` share the same narrowed keys; the cast keeps
    // the contract type for the wire body while echoing the concrete patch back.
    (applied as Record<string, unknown>)[key] = value;
    (settingsPatch as Record<string, unknown>)[key] = value;
  });

  if (Object.keys(settingsPatch).length === 0) {
    return { ok: false, detail: 'No model-routing fields to update.' };
  }

  const res = await fetchJson(SETTINGS_PATH, timeoutMs, {
    method: 'PUT',
    body: JSON.stringify(settingsPatch),
  });

  if (!('ok' in res) || !res.ok) {
    const reason = 'error' in res ? res.error : `responded ${('status' in res ? res.status : 0)}`;
    return { ok: false, detail: `Could not update LSAT model routing — ${reason}.` };
  }
  return { ok: true, applied, detail: 'LSAT model routing updated.' };
}

// ---------------------------------------------------------------------------
// OPS-4 — local maintenance scheduler bridge
//
// Thin, fully-degrading wrappers over the EXISTING (read-only — unchanged)
// scheduler surfaces the LSAT sidecar already exposes under `/api`:
//   GET  /api/observability/scheduled-tasks            → { count, tasks: [...] }
//   POST /api/observability/scheduled-tasks            (upsert one task)
//   POST /api/observability/scheduled-tasks/defaults   (seed the default registry)
//   POST /api/observability/scheduled-tasks/run-due    (run all due tasks)
//   POST /api/observability/scheduled-tasks/{key}/run  (run one task now)
//   GET  /api/observability/scheduler-runs             → { count, runs: [...] }
//
// These routes are legacy untyped LSAT surfaces (no narrow `response_model` in
// the committed `api.gen.ts` baseline), so the bodies are read defensively
// against the shapes documented here — same idiom as `useTrustManifest`. Every
// helper degrades to `{ ok: false, reachable: false, ... }` on any failure
// (sidecar down, timeout, shape drift) so the Maintenance panel can show
// "offline" rather than hanging the page.
// ---------------------------------------------------------------------------

/** One registered local maintenance task (mirrors `jobs.scheduled_task_payload`). */
export interface LsatScheduledTask {
  id: number | null;
  key: string;
  label: string;
  task_type: string;
  /** Cadence in seconds (the backend clamps to a 60s floor). */
  cadence_s: number;
  /** Last reported run status, e.g. "idle" | "failed". */
  status: string;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  payload: Record<string, unknown>;
  updated_at: string | null;
}

/** One recorded scheduler run (mirrors `jobs.scheduler_run_payload`). */
export interface LsatSchedulerRun {
  id: number | null;
  task_key: string;
  task_type: string;
  /** "ok" | "failed". */
  status: string;
  duration_ms: number | null;
  result: Record<string, unknown>;
  error: string | null;
  created_at: string | null;
}

/** Report for {@link getLsatScheduledTasks}. */
export interface LsatScheduledTasksReport {
  ok: boolean;
  reachable: boolean;
  tasks: LsatScheduledTask[];
  detail: string;
}

/** Report for {@link getLsatSchedulerRuns}. */
export interface LsatSchedulerRunsReport {
  ok: boolean;
  reachable: boolean;
  runs: LsatSchedulerRun[];
  detail: string;
}

/** Result of a mutating maintenance action (run/toggle/cadence/run-due/defaults). */
export interface LsatMaintenanceActionResult {
  ok: boolean;
  reachable: boolean;
  detail: string;
  /** The raw 2xx body, for callers that want the run id / nested result. */
  data?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Coerce one raw scheduled-task row into {@link LsatScheduledTask}, defensively. */
function readScheduledTask(raw: unknown): LsatScheduledTask {
  const r = isRecord(raw) ? raw : {};
  return {
    id: num(r.id),
    key: str(r.key) ?? '',
    label: str(r.label) ?? str(r.key) ?? 'Untitled task',
    task_type: str(r.task_type) ?? 'unknown',
    cadence_s: num(r.cadence_s) ?? 86400,
    status: str(r.status) ?? 'idle',
    enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
    last_run_at: str(r.last_run_at),
    next_run_at: str(r.next_run_at),
    payload: isRecord(r.payload) ? r.payload : {},
    updated_at: str(r.updated_at),
  };
}

/** Coerce one raw scheduler-run row into {@link LsatSchedulerRun}, defensively. */
function readSchedulerRun(raw: unknown): LsatSchedulerRun {
  const r = isRecord(raw) ? raw : {};
  return {
    id: num(r.id),
    task_key: str(r.task_key) ?? '',
    task_type: str(r.task_type) ?? 'unknown',
    status: str(r.status) ?? 'ok',
    duration_ms: num(r.duration_ms),
    result: isRecord(r.result) ? r.result : {},
    error: str(r.error),
    created_at: str(r.created_at),
  };
}

/** OPS-4: list the local maintenance task registry. Never throws. */
export async function getLsatScheduledTasks(timeoutMs = 3000): Promise<LsatScheduledTasksReport> {
  const res = await fetchJson(SCHEDULED_TASKS_PATH, timeoutMs);
  if (!('ok' in res) || !res.ok || !isRecord(res.data)) {
    const reason = 'error' in res ? res.error : `responded ${('status' in res ? res.status : 0)}`;
    return {
      ok: false,
      reachable: 'error' in res ? false : true,
      tasks: [],
      detail: `Scheduled tasks unavailable — ${reason}.`,
    };
  }
  const rows = Array.isArray(res.data.tasks) ? res.data.tasks : [];
  return { ok: true, reachable: true, tasks: rows.map(readScheduledTask), detail: 'Scheduled tasks loaded.' };
}

/** OPS-4: recent maintenance run history (newest first). Never throws. */
export async function getLsatSchedulerRuns(timeoutMs = 3000): Promise<LsatSchedulerRunsReport> {
  const res = await fetchJson(SCHEDULER_RUNS_PATH, timeoutMs);
  if (!('ok' in res) || !res.ok || !isRecord(res.data)) {
    const reason = 'error' in res ? res.error : `responded ${('status' in res ? res.status : 0)}`;
    return {
      ok: false,
      reachable: 'error' in res ? false : true,
      runs: [],
      detail: `Run history unavailable — ${reason}.`,
    };
  }
  const rows = Array.isArray(res.data.runs) ? res.data.runs : [];
  return { ok: true, reachable: true, runs: rows.map(readSchedulerRun), detail: 'Run history loaded.' };
}

/** OPS-4: run one registered maintenance task now (`POST .../{key}/run`). Never throws. */
export async function runLsatScheduledTask(
  key: string,
  timeoutMs = 30000,
): Promise<LsatMaintenanceActionResult> {
  const safeKey = encodeURIComponent(key);
  const res = await fetchJson(SCHEDULED_TASK_RUN_PATH.replace('{key}', safeKey), timeoutMs, {
    method: 'POST',
  });
  if (!('ok' in res) || !res.ok) {
    const reason = 'error' in res ? res.error : `responded ${('status' in res ? res.status : 0)}`;
    return { ok: false, reachable: 'error' in res ? false : true, detail: `Could not run "${key}" — ${reason}.` };
  }
  // The backend returns { ok, run_id, ... } even for a task that failed to
  // execute; surface that inner verdict so the panel can warn precisely.
  const inner = isRecord(res.data) && typeof res.data.ok === 'boolean' ? res.data.ok : true;
  return {
    ok: inner,
    reachable: true,
    detail: inner ? `Ran "${key}".` : `"${key}" ran but reported a failure.`,
    data: res.data,
  };
}

/** OPS-4: run every due maintenance task now (`POST .../run-due`). Never throws. */
export async function runDueLsatScheduledTasks(
  timeoutMs = 60000,
): Promise<LsatMaintenanceActionResult> {
  const res = await fetchJson(SCHEDULED_TASKS_RUN_DUE_PATH, timeoutMs, {
    method: 'POST',
  });
  if (!('ok' in res) || !res.ok) {
    const reason = 'error' in res ? res.error : `responded ${('status' in res ? res.status : 0)}`;
    return { ok: false, reachable: 'error' in res ? false : true, detail: `Could not run due tasks — ${reason}.` };
  }
  const ran = isRecord(res.data) ? (num(res.data.ran) ?? 0) : 0;
  return {
    ok: true,
    reachable: true,
    detail: ran > 0 ? `Ran ${ran} due task${ran === 1 ? '' : 's'}.` : 'No tasks were due.',
    data: res.data,
  };
}

/** OPS-4: seed the default maintenance registry (`POST .../defaults`). Never throws. */
export async function ensureLsatScheduledDefaults(
  timeoutMs = 10000,
): Promise<LsatMaintenanceActionResult> {
  const res = await fetchJson(SCHEDULED_TASK_DEFAULTS_PATH, timeoutMs, {
    method: 'POST',
  });
  if (!('ok' in res) || !res.ok) {
    const reason = 'error' in res ? res.error : `responded ${('status' in res ? res.status : 0)}`;
    return { ok: false, reachable: 'error' in res ? false : true, detail: `Could not seed defaults — ${reason}.` };
  }
  const count = isRecord(res.data) ? (num(res.data.scheduled_tasks) ?? 0) : 0;
  return {
    ok: true,
    reachable: true,
    detail: count > 0 ? `Seeded ${count} default task${count === 1 ? '' : 's'}.` : 'Defaults already present.',
    data: res.data,
  };
}

/**
 * OPS-4: upsert one maintenance task — used to TOGGLE `enabled` or change the
 * `cadence_s`. This is the existing `POST /api/observability/scheduled-tasks`
 * route (idempotent upsert keyed on `key`); the panel re-sends the task's
 * current `label`/`task_type`/`payload` with the one edited field so an unset
 * field is never zeroed. Never throws.
 */
export async function upsertLsatScheduledTask(
  task: { key: string; label: string; task_type: string; cadence_s: number; enabled: boolean; payload?: Record<string, unknown> },
  timeoutMs = 6000,
): Promise<LsatMaintenanceActionResult> {
  const body = JSON.stringify({
    key: task.key,
    label: task.label,
    task_type: task.task_type,
    cadence_s: Math.max(60, Math.round(task.cadence_s)),
    enabled: task.enabled,
    payload: task.payload ?? {},
  });
  const res = await fetchJson(SCHEDULED_TASKS_PATH, timeoutMs, { method: 'POST', body });
  if (!('ok' in res) || !res.ok) {
    const reason = 'error' in res ? res.error : `responded ${('status' in res ? res.status : 0)}`;
    return { ok: false, reachable: 'error' in res ? false : true, detail: `Could not update "${task.key}" — ${reason}.` };
  }
  return { ok: true, reachable: true, detail: `Updated "${task.key}".`, data: res.data };
}
