/**
 * OPS-3 — Runtime-metric trend store, LOCAL-ONLY.
 *
 * StudyVault is an offline desktop app with no remote time-series database, so
 * the System Health "Runtime Metrics" tab keeps a small in-process ring buffer
 * of point-in-time samples and draws trend sparklines from it. Each sample is a
 * snapshot of the cheap-to-read runtime gauges the LSAT backend already exposes:
 *  - cloud month-to-date spend (USD), from `/observability/health-aggregated`,
 *  - LLM explain p50 latency (ms), from the same payload (MetricSample-backed),
 *  - generation queue depth (queued + running),
 *  - the SQLITE_BUSY/LOCKED contention count.
 *
 * Nothing is persisted or sent anywhere: the series lives in module state, is
 * read by the Runtime Metrics tab, and vanishes on reload. Same process-local /
 * subscribe idiom as `webVitals.ts`.
 */

import type { BackendHealthAggregate } from './systemHealth';

/** One point-in-time runtime snapshot. All metric fields are nullable because a
 *  given poll may have only partial data (e.g. backend unreachable). */
export interface RuntimeMetricSample {
  /** Epoch ms when this sample was recorded. */
  t: number;
  /** Cloud month-to-date spend in USD, or null when unknown. */
  cloudSpendUsd: number | null;
  /** LLM explain p50 latency in ms, or null until the backend has a sample. */
  llmP50Ms: number | null;
  /** Generation queue depth (queued + running), or null when unknown. */
  genQueueDepth: number | null;
  /** SQLITE_BUSY/LOCKED retry count since the backend started, or null. */
  sqliteBusyRetries: number | null;
}

/** Keys of the numeric metric series the sparklines can plot. */
export type RuntimeMetricKey =
  | 'cloudSpendUsd'
  | 'llmP50Ms'
  | 'genQueueDepth'
  | 'sqliteBusyRetries';

/**
 * Max samples retained. At a ~10s poll cadence this is ~17min of history —
 * plenty for an at-a-glance sparkline without unbounded growth. The oldest
 * sample is evicted once the buffer is full.
 */
export const RUNTIME_HISTORY_CAPACITY = 100;

type Listener = (samples: RuntimeMetricSample[]) => void;

const samples: RuntimeMetricSample[] = [];
const listeners = new Set<Listener>();

function emit(): void {
  const snapshot = getRuntimeMetrics();
  for (const listener of listeners) listener(snapshot);
}

/** Read the current series (a copy — callers must not mutate the store). */
export function getRuntimeMetrics(): RuntimeMetricSample[] {
  return samples.slice();
}

/**
 * Append a snapshot derived from a backend aggregated-health report. A `null`
 * report (backend unreachable / older build) still records a sample with all
 * metric fields null, so a gap in the series is visible rather than silently
 * collapsed. Returns the recorded sample.
 */
export function recordRuntimeSample(
  report: BackendHealthAggregate | null,
  now: number = Date.now(),
): RuntimeMetricSample {
  const sample: RuntimeMetricSample = {
    t: now,
    cloudSpendUsd: numOrNull(report?.cloud_spend_mtd_usd),
    llmP50Ms: numOrNull(report?.explain_p50_ms),
    genQueueDepth:
      report == null
        ? null
        : numOrNull(report.gen_queued) != null || numOrNull(report.gen_running) != null
          ? (report.gen_queued ?? 0) + (report.gen_running ?? 0)
          : null,
    sqliteBusyRetries: numOrNull(report?.sqlite_health?.busy_retries),
  };
  samples.push(sample);
  while (samples.length > RUNTIME_HISTORY_CAPACITY) samples.shift();
  emit();
  return sample;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Reset the series (used by tests and on an explicit clear). */
export function clearRuntimeMetrics(): void {
  samples.length = 0;
  emit();
}

/**
 * Subscribe to series changes. Returns an unsubscribe function and pushes the
 * current snapshot immediately so a late subscriber isn't blank.
 */
export function subscribeRuntimeMetrics(listener: Listener): () => void {
  listeners.add(listener);
  listener(getRuntimeMetrics());
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Extract one metric's non-null numeric series in chronological order — the
 * exact input a sparkline wants. Null samples (gaps) are dropped so the trend
 * line connects the points it actually has.
 */
export function metricSeries(key: RuntimeMetricKey): number[] {
  const out: number[] = [];
  for (const sample of samples) {
    const value = sample[key];
    if (typeof value === 'number' && Number.isFinite(value)) out.push(value);
  }
  return out;
}

/** Latest non-null value for a metric, or null when the series has no data. */
export function latestMetric(key: RuntimeMetricKey): number | null {
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const value = samples[i][key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}
