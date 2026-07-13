/**
 * OPS-3 — Runtime Metrics tab for the System Health page.
 *
 * Renders point-in-time runtime trends from the local `runtimeMetricsStore`
 * ring buffer (cloud month-to-date spend, LLM explain p50, generation queue
 * depth, SQLITE_BUSY contention) plus the live web-vitals snapshot and the
 * backend's SQLite-health PRAGMA/WAL details. Trends are drawn with COMPACT,
 * fully self-contained inline SVG sparklines — no recharts, no shared viz
 * barrel, zero new dependencies (a sibling agent is refactoring the viz barrel
 * this batch, so this stays deliberately standalone).
 *
 * LOCAL-ONLY: every input is read in-process; nothing is fetched here (the
 * parent page polls the backend and feeds samples into the store).
 */

import { useEffect, useMemo, useState } from 'react';
import { StatusBadge, Surface } from '../ui/Primitives';
import {
  latestMetric,
  metricSeries,
  subscribeRuntimeMetrics,
  type RuntimeMetricKey,
  type RuntimeMetricSample,
} from '../../lib/runtimeMetricsStore';
import {
  formatWebVital,
  getWebVitalThresholds,
  type WebVitalsSnapshot,
} from '../../lib/webVitals';
import type { BackendHealthAggregate } from '../../lib/systemHealth';

const VITAL_TONE: Record<string, string> = {
  good: 'qv-text-success',
  'needs-improvement': 'qv-text-warning',
  poor: 'qv-text-danger',
  pending: 'qv-text-muted',
};

const VITAL_LABELS: Record<string, string> = {
  LCP: 'Largest Contentful Paint',
  CLS: 'Cumulative Layout Shift',
  INP: 'Interaction to Next Paint',
};

/**
 * Compact inline SVG sparkline. Self-contained: maps a numeric series to a
 * normalized polyline within a fixed viewBox, with a soft area fill and a dot on
 * the latest point. Renders an em-dash placeholder when there are <2 points
 * (nothing meaningful to trend yet). Colors come from CSS variables so it tracks
 * the theme; no external chart lib.
 */
function Sparkline({
  values,
  width = 160,
  height = 36,
  label,
}: {
  values: number[];
  width?: number;
  height?: number;
  label: string;
}) {
  if (values.length < 2) {
    return (
      <span className="qv-text-muted qv-fs-xs" aria-label={`${label}: not enough data to trend`}>
        — awaiting trend
      </span>
    );
  }
  const pad = 2;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = (width - pad * 2) / (values.length - 1);
  const points = values.map((v, i) => {
    const x = pad + i * stepX;
    // Invert Y so larger values render higher; clamp inside the padded box.
    const y = pad + (height - pad * 2) * (1 - (v - min) / span);
    return [x, y] as const;
  });
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${pad},${height - pad} ${line} ${(width - pad).toFixed(1)},${height - pad}`;
  const [lastX, lastY] = points[points.length - 1];
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${label} trend (${values.length} samples, latest ${values[values.length - 1]})`}
      style={{ display: 'block' }}
    >
      <polygon points={area} fill="var(--color-accent, var(--color-primary))" opacity={0.12} />
      <polyline
        points={line}
        fill="none"
        stroke="var(--color-accent, var(--color-primary))"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lastX} cy={lastY} r={2.4} fill="var(--color-accent, var(--color-primary))" />
    </svg>
  );
}

interface TrendRow {
  key: RuntimeMetricKey;
  title: string;
  hint: string;
  format: (v: number | null) => string;
}

const TREND_ROWS: TrendRow[] = [
  {
    key: 'cloudSpendUsd',
    title: 'Cloud spend (MTD)',
    hint: 'Month-to-date opt-in cloud cost',
    format: (v) => (v == null ? '—' : `$${v.toFixed(4)}`),
  },
  {
    key: 'llmP50Ms',
    title: 'LLM explain p50',
    hint: 'Median local-model explanation latency',
    format: (v) => (v == null ? '—' : `${Math.round(v)} ms`),
  },
  {
    key: 'genQueueDepth',
    title: 'Gen queue depth',
    hint: 'Queued + running generation jobs',
    format: (v) => (v == null ? '—' : String(Math.round(v))),
  },
  {
    key: 'sqliteBusyRetries',
    title: 'SQLite contention',
    hint: 'SQLITE_BUSY/LOCKED retries since backend start',
    format: (v) => (v == null ? '—' : String(Math.round(v))),
  },
];

export interface RuntimeMetricsTabProps {
  /** The latest backend aggregated-health report (for SQLite-health details), or
   *  null when the sidecar is unreachable / an older build. */
  backend: BackendHealthAggregate | null;
  /** Live Core Web Vitals snapshot from the host PerformanceObserver collector. */
  webVitals: WebVitalsSnapshot;
}

/**
 * The Runtime Metrics section. Subscribes to the process-local runtime store so
 * it re-renders as the parent page records new samples, and renders sparkline
 * trends + the live web-vitals readout + the backend SQLite-health snapshot.
 */
export function RuntimeMetricsTab({ backend, webVitals }: RuntimeMetricsTabProps) {
  const [, setTick] = useState<RuntimeMetricSample[]>([]);
  // Re-render on every store change; the values are read fresh below via the
  // store selectors so we don't need to thread the array through.
  useEffect(() => subscribeRuntimeMetrics(setTick), []);

  const trends = useMemo(
    () =>
      TREND_ROWS.map((row) => ({
        ...row,
        series: metricSeries(row.key),
        latest: latestMetric(row.key),
      })),
    // Recompute on each store change; `setTick` re-renders, and the store is the
    // single source of truth, so a render-time read is correct here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [webVitals, backend],
  );

  const sqlite = backend?.sqlite_health;
  const walMb =
    sqlite?.wal_estimate_if_cheap != null
      ? (sqlite.wal_estimate_if_cheap / 1024 / 1024).toFixed(2)
      : null;

  return (
    <Surface tone="ops" className="ops-report-panel">
      <div className="flex-between" style={{ gap: 'var(--space-4)', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <StatusBadge tone="ops">Runtime Metrics</StatusBadge>
          <h3 className="qv-m-0 qv-mt-2">
            Runtime trends{' '}
            <span className="qv-mono qv-text-muted qv-fs-sm">
              {trends.some((t) => t.series.length >= 2) ? 'live' : 'collecting…'}
            </span>
          </h3>
          <p className="qv-text-secondary qv-m-0">
            Point-in-time runtime gauges sampled locally as you use the app — cloud spend, local-model
            latency, generation queue depth, and SQLite contention. Fully local; trends are kept in memory
            and reset on reload. Sparklines need a couple of samples before they appear.
          </p>
        </div>
      </div>

      {/* Trend sparklines */}
      <div className="qv-stack-3" style={{ marginTop: 'var(--space-4)' }}>
        {trends.map((trend) => (
          <div
            key={trend.key}
            className="surface surface-default surface-compact"
            style={{ padding: 'var(--space-3)' }}
          >
            <div
              className="flex-between"
              style={{ gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}
            >
              <div style={{ minWidth: 0 }}>
                <strong className="qv-fs-sm">{trend.title}</strong>
                <small className="qv-text-muted" style={{ display: 'block' }}>
                  {trend.hint}
                </small>
              </div>
              <div className="qv-row-2" style={{ alignItems: 'center' }}>
                <span className="qv-mono qv-fs-sm">{trend.format(trend.latest)}</span>
                <Sparkline values={trend.series} label={trend.title} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Core Web Vitals readout */}
      <h4 className="qv-mt-4 qv-mb-2">
        Core Web Vitals{' '}
        <span className="qv-mono qv-text-muted qv-fs-sm">
          {webVitals.supported ? 'observing' : 'unavailable'}
        </span>
      </h4>
      <div className="coverage-grid">
        {[webVitals.LCP, webVitals.CLS, webVitals.INP].map((metric) => {
          const thresholds = getWebVitalThresholds(metric.name);
          return (
            <div key={metric.name}>
              <strong className={VITAL_TONE[metric.rating]}>
                {formatWebVital(metric.name, metric.value)}
              </strong>
              <small>
                {metric.name} · {VITAL_LABELS[metric.name]}
              </small>
              <small className="qv-text-muted">
                {metric.rating === 'pending' ? 'awaiting data' : metric.rating} · good ≤{' '}
                {thresholds.unit === 'ms' ? `${thresholds.good} ms` : thresholds.good}
              </small>
            </div>
          );
        })}
      </div>

      {/* Backend SQLite health (PRAGMA / WAL / BUSY) */}
      <h4 className="qv-mt-4 qv-mb-2">
        SQLite health{' '}
        <span className="qv-mono qv-text-muted qv-fs-sm">
          {sqlite ? 'from LSAT backend' : 'backend offline'}
        </span>
      </h4>
      {sqlite ? (
        <div className="coverage-grid">
          <div>
            <strong className={sqlite.busy_retries > 0 ? 'qv-text-warning' : 'qv-text-success'}>
              {sqlite.busy_retries}
            </strong>
            <small>SQLITE_BUSY/LOCKED retries</small>
          </div>
          <div>
            <strong>{walMb == null ? '—' : `${walMb} MB`}</strong>
            <small>WAL sidecar size (if cheap)</small>
          </div>
          <div>
            <strong className="qv-mono qv-fs-sm">
              {String(sqlite.pragmas?.journal_mode ?? '—')}
            </strong>
            <small>journal_mode</small>
          </div>
          <div>
            <strong className="qv-mono qv-fs-sm">
              {String(sqlite.pragmas?.synchronous ?? '—')}
            </strong>
            <small>synchronous</small>
          </div>
          <div>
            <strong className="qv-mono qv-fs-sm">
              {String(sqlite.pragmas?.busy_timeout ?? '—')}
            </strong>
            <small>busy_timeout</small>
          </div>
          <div>
            <strong className="qv-mono qv-fs-sm">
              {String(sqlite.pragmas?.foreign_keys ?? '—')}
            </strong>
            <small>foreign_keys</small>
          </div>
        </div>
      ) : (
        <p className="qv-text-secondary qv-m-0 qv-fs-sm">
          SQLite-health details come from the LSAT backend sidecar (:8100). Start it to see PRAGMA / WAL /
          contention metrics.
        </p>
      )}
    </Surface>
  );
}

export default RuntimeMetricsTab;
