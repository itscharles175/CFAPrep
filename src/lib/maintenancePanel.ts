/**
 * OPS-4 — Maintenance panel logic (host, LOCAL-ONLY).
 *
 * Pure, dependency-free helpers behind the System Health "Maintenance" panel:
 *  - client GUARDRAIL evaluation (cloud-budget pressure, IndexedDB quota
 *    pressure, model outage) → a small list of dismissible banners, and
 *  - DIAGNOSTICS EXPORT bundling — folding the already-loaded trust manifest,
 *    runtime-metric evidence, sidecar status/logs, and cloud metrics into one
 *    timestamped JSON object for a one-click download.
 *
 * Everything here is synchronous and side-effect-free so it can be unit-tested
 * without a DOM, a backend, or Electron. The panel component does the fetching and
 * the actual file download; this module decides *what* to show and *what* to
 * bundle. No data ever leaves the device — the export is a local download the
 * user initiates.
 */

import type { TrustManifest } from '../hooks/useTrustManifest';
import type { AggregatedSystemHealth } from './systemHealth';
import type { LsatCloudBudgetReport, LsatScheduledTask, LsatSchedulerRun } from './lsatBackend';
import type { RuntimeMetricSample } from './runtimeMetricsStore';

/** A client guardrail banner the panel renders above the maintenance controls. */
export interface GuardrailBanner {
  /** Stable id (also the React key + dismissal key). */
  id: 'cloud-budget' | 'indexeddb-quota' | 'model-outage';
  /** Severity tone — maps to the design-system warning/danger surfaces. */
  tone: 'warning' | 'danger';
  /** Short headline. */
  title: string;
  /** One-line human-readable detail. */
  detail: string;
}

/** Default threshold (percent) at which the cloud-budget banner fires. */
export const CLOUD_BUDGET_WARN_PCT = 80;
/** Default threshold (percent) at which the IndexedDB-quota banner fires. */
export const INDEXEDDB_QUOTA_WARN_PCT = 85;

/** Inputs to {@link evaluateGuardrails} — all optional / nullable (degrading). */
export interface GuardrailInputs {
  /** The cloud-budget report from the LSAT sidecar (BB4), or null when offline. */
  cloudBudget?: LsatCloudBudgetReport | null;
  /** `navigator.storage.estimate()` result, or null when unavailable. */
  storageEstimate?: { usage?: number; quota?: number } | null;
  /** The aggregated system-health verdict (OPS-3), or null. */
  aggregatedHealth?: AggregatedSystemHealth | null;
  /** Overrides for the warn thresholds (tests / future settings). */
  cloudBudgetWarnPct?: number;
  indexedDbWarnPct?: number;
}

/** Percent of the configured cloud budget already spent (0–100+), or null. */
export function cloudBudgetUsedPct(report: LsatCloudBudgetReport | null | undefined): number | null {
  const cloud = report?.cloud;
  if (!cloud) return null;
  const budget = cloud.budget_usd;
  // No budget configured (null or 0 => unlimited / opt-in) means no pressure.
  if (budget == null || budget <= 0) return null;
  const spend = typeof cloud.spend_usd === 'number' ? cloud.spend_usd : 0;
  return (spend / budget) * 100;
}

/** Percent of the IndexedDB/storage quota in use (0–100), or null when unknown. */
export function storageUsedPct(estimate: { usage?: number; quota?: number } | null | undefined): number | null {
  const usage = typeof estimate?.usage === 'number' ? estimate.usage : null;
  const quota = typeof estimate?.quota === 'number' ? estimate.quota : null;
  if (usage == null || quota == null || quota <= 0) return null;
  return (usage / quota) * 100;
}

/**
 * Detect a local-model outage from the aggregated health verdict. The LSAT
 * sidecar folds an `ai_not_ready` / `*_unreachable` / `model_missing:*` signal
 * into the backend `reasons` list; a hard `error` verdict (a REQUIRED sidecar
 * down) is also treated as an outage. Returns a human reason string, or null
 * when the model path looks healthy / is simply unknown.
 */
export function detectModelOutage(health: AggregatedSystemHealth | null | undefined): string | null {
  if (!health) return null;
  const reasons = health.backend?.reasons ?? [];
  const outage = reasons.find((r) => r === 'ai_not_ready' || /unreachable$/.test(r) || r.startsWith('model_missing'));
  if (outage) return outage;
  // A hard error verdict means a required local service is down — surface it
  // even when we couldn't pin a specific AI reason.
  if (health.verdict === 'error') return 'service_down';
  return null;
}

/**
 * Evaluate the three client guardrails into an ordered banner list. Pure and
 * fully degrading: a missing/partial input simply omits that banner rather than
 * raising. Order is danger-first (outage), then the two quota/budget pressures.
 */
export function evaluateGuardrails(inputs: GuardrailInputs): GuardrailBanner[] {
  const banners: GuardrailBanner[] = [];
  const cloudWarn = inputs.cloudBudgetWarnPct ?? CLOUD_BUDGET_WARN_PCT;
  const storeWarn = inputs.indexedDbWarnPct ?? INDEXEDDB_QUOTA_WARN_PCT;

  // Model outage — the most actionable signal (study still works on local
  // content, but generation/explanations degrade), so list it first.
  const outage = detectModelOutage(inputs.aggregatedHealth);
  if (outage) {
    banners.push({
      id: 'model-outage',
      tone: 'danger',
      title: 'Local model unavailable',
      detail:
        outage === 'service_down'
          ? 'A required local service is down — explanations and generation are degraded until it recovers.'
          : `The local model path reported "${outage}". Explanations and generation fall back or pause until it recovers.`,
    });
  }

  // Cloud-budget pressure (>= warn threshold of the configured monthly budget).
  const budgetPct = cloudBudgetUsedPct(inputs.cloudBudget);
  if (budgetPct != null && budgetPct >= cloudWarn) {
    const over = budgetPct >= 100;
    banners.push({
      id: 'cloud-budget',
      tone: over ? 'danger' : 'warning',
      title: over ? 'Cloud budget reached' : 'Cloud budget nearly used',
      detail: over
        ? 'The monthly cloud budget is spent — opt-in cloud generation falls back to the local model until next month.'
        : `${Math.round(budgetPct)}% of the monthly cloud budget is used. Cloud generation will fall back locally once the cap is hit.`,
    });
  }

  // IndexedDB / storage-quota pressure (>= warn threshold of the estimate).
  const quotaPct = storageUsedPct(inputs.storageEstimate);
  if (quotaPct != null && quotaPct >= storeWarn) {
    banners.push({
      id: 'indexeddb-quota',
      tone: quotaPct >= 95 ? 'danger' : 'warning',
      title: 'Local storage almost full',
      detail: `${Math.round(quotaPct)}% of the browser storage quota is in use. Export a backup and clear caches to free space before the vault stops accepting writes.`,
    });
  }

  return banners;
}

/** The bundled diagnostics export shape (`studyvault.diagnostics.v2`). */
export interface DiagnosticsBundle {
  schema: 'studyvault.diagnostics.v2';
  generated_at: string;
  app: {
    user_agent: string | null;
    is_electron: boolean;
    href: string | null;
  };
  /** The release-trust manifest (OPS-2 / useTrustManifest), or null when offline. */
  trust_manifest: TrustManifest | null;
  /** Aggregated readiness verdict + the two sources behind it (OPS-3). */
  aggregated_health: AggregatedSystemHealth | null;
  /** The in-process runtime-metric ring buffer (OPS-3). */
  runtime_evidence: RuntimeMetricSample[];
  /** Backend runtime-evidence summary (log dir / recent errors), or null. */
  backend_runtime_evidence: unknown;
  /** Cloud-budget + voice-cache report from the sidecar (BB4), or null. */
  cloud_metrics: LsatCloudBudgetReport | null;
  /** Per-sidecar status snapshot + the captured log tails (OPS-1). */
  sidecars: {
    status: unknown;
    logs: Record<string, string[]>;
  };
  /** The local maintenance scheduler registry + recent run history (OPS-4). */
  maintenance: {
    scheduled_tasks: LsatScheduledTask[];
    recent_runs: LsatSchedulerRun[];
  };
  /** The client guardrail banners that were active at export time. */
  guardrails: GuardrailBanner[];
}

/** All the pieces the panel has already loaded, threaded into the bundle. */
export interface DiagnosticsBundleInputs {
  trustManifest?: TrustManifest | null;
  aggregatedHealth?: AggregatedSystemHealth | null;
  runtimeEvidence?: RuntimeMetricSample[] | null;
  backendRuntimeEvidence?: unknown;
  cloudMetrics?: LsatCloudBudgetReport | null;
  sidecarStatus?: unknown;
  sidecarLogs?: Record<string, string[]> | null;
  scheduledTasks?: LsatScheduledTask[] | null;
  recentRuns?: LsatSchedulerRun[] | null;
  guardrails?: GuardrailBanner[] | null;
  /** Injected clock for deterministic tests. */
  now?: Date;
  /** Injected env for tests (defaults to the real `navigator` / `window`). */
  env?: { userAgent?: string | null; isElectron?: boolean; href?: string | null };
}

function readEnv(env: DiagnosticsBundleInputs['env']): DiagnosticsBundle['app'] {
  if (env) {
    return {
      user_agent: env.userAgent ?? null,
      is_electron: Boolean(env.isElectron),
      href: env.href ?? null,
    };
  }
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const win = typeof window !== 'undefined' ? window : null;
  return {
    user_agent: nav?.userAgent ?? null,
    is_electron: Boolean(win?.studyvault),
    href: win?.location?.href ?? null,
  };
}

/**
 * Bundle everything the panel has loaded into one timestamped diagnostics
 * object. Pure: it copies the inputs (never mutates them) and never fetches —
 * the caller passes already-loaded state. Missing inputs degrade to null /
 * empty so a partial export (e.g. sidecar offline) is still well-formed.
 */
export function buildDiagnosticsBundle(inputs: DiagnosticsBundleInputs = {}): DiagnosticsBundle {
  const now = inputs.now ?? new Date();
  return {
    schema: 'studyvault.diagnostics.v2',
    generated_at: now.toISOString(),
    app: readEnv(inputs.env),
    trust_manifest: inputs.trustManifest ?? null,
    aggregated_health: inputs.aggregatedHealth ?? null,
    runtime_evidence: Array.isArray(inputs.runtimeEvidence) ? inputs.runtimeEvidence.slice() : [],
    backend_runtime_evidence: inputs.backendRuntimeEvidence ?? null,
    cloud_metrics: inputs.cloudMetrics ?? null,
    sidecars: {
      status: inputs.sidecarStatus ?? null,
      logs: inputs.sidecarLogs ?? {},
    },
    maintenance: {
      scheduled_tasks: Array.isArray(inputs.scheduledTasks) ? inputs.scheduledTasks.slice() : [],
      recent_runs: Array.isArray(inputs.recentRuns) ? inputs.recentRuns.slice() : [],
    },
    guardrails: Array.isArray(inputs.guardrails) ? inputs.guardrails.slice() : [],
  };
}

/** A filesystem-safe, timestamped filename for the diagnostics download. */
export function diagnosticsFilename(now: Date = new Date()): string {
  // e.g. studyvault-diagnostics-2026-06-16T14-30-05.json — colons are illegal
  // on Windows filenames, so flatten the time portion.
  const stamp = now
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\.\d+Z$/, 'Z');
  return `studyvault-diagnostics-${stamp}.json`;
}

/** Format a cadence in seconds as a compact human label (e.g. "6h", "1d"). */
export function formatCadence(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const units: Array<[number, string]> = [
    [86400, 'd'],
    [3600, 'h'],
    [60, 'm'],
    [1, 's'],
  ];
  for (const [size, label] of units) {
    if (seconds >= size && seconds % size === 0) return `${seconds / size}${label}`;
  }
  // Fall back to the largest whole unit that fits.
  for (const [size, label] of units) {
    if (seconds >= size) return `${Math.round(seconds / size)}${label}`;
  }
  return `${seconds}s`;
}

/** Catalogue of cadence presets the panel offers in its cadence selector. */
export const CADENCE_PRESETS: Array<{ label: string; seconds: number }> = [
  { label: 'Hourly', seconds: 3600 },
  { label: 'Every 6h', seconds: 6 * 3600 },
  { label: 'Every 12h', seconds: 12 * 3600 },
  { label: 'Daily', seconds: 86400 },
  { label: 'Weekly', seconds: 7 * 86400 },
];
