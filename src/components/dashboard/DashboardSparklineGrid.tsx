/**
 * ANL-4 — per-domain learning-curve sparkline grid (presentational).
 *
 * One small inline-SVG sparkline per host domain (CFA / Quant / Excel) plotting
 * the mastery curve shaped from the SHIPPED `/api/adaptivity/ability?domain=`
 * estimate (slope / plateau / mastery-ETA). Deliberately NO chart library — the
 * line is a hand-rolled `<polyline>` over the curve's `series` so this component
 * stays self-contained and cheap (the host already lazy-loads heavyweight charts
 * elsewhere; a dashboard sparkline shouldn't pull that in).
 *
 * Pure presentation: it takes the shaped {@link DomainLearningCurve}s from
 * `dashboardMetrics.ts` and renders them. A degraded (unreachable / no-evidence)
 * domain renders an honest empty cell rather than a fake flat line.
 *
 * Rides the unified design tokens (--surface-*, --text-*, --space-*, --fs-*,
 * --radius-*, semantic success/warning/danger hues) via inline styles so it
 * needs no new global CSS file. A11y: each sparkline is an `img` role with a
 * descriptive label summarizing the trend + mastery for screen readers.
 */
import type { CSSProperties } from 'react';
import { TrendingUp, TrendingDown, Minus, Sparkles } from 'lucide-react';
import type { DomainLearningCurve } from '../../lib/dashboardMetrics';
import { MASTERY_TARGET } from '../../lib/dashboardMetrics';

export interface DashboardSparklineGridProps {
  /** Per-domain shaped learning curves (typically all three host planes). */
  curves: DomainLearningCurve[];
  /** Inline width of each sparkline's plot area, in px. */
  sparkWidth?: number;
  /** Inline height of each sparkline's plot area, in px. */
  sparkHeight?: number;
  className?: string;
}

const TREND_META: Record<
  DomainLearningCurve['trend'],
  { color: string; Icon: typeof TrendingUp; word: string }
> = {
  up: { color: 'var(--success, #16a34a)', Icon: TrendingUp, word: 'improving' },
  down: { color: 'var(--danger, #dc2626)', Icon: TrendingDown, word: 'declining' },
  flat: { color: 'var(--warning, #d97706)', Icon: Minus, word: 'flat' },
  new: { color: 'var(--text-muted, #94a3b8)', Icon: Sparkles, word: 'new' },
};

/** Build the SVG polyline points for a mastery series scaled into the plot box. */
function polylinePoints(series: number[], width: number, height: number): string {
  if (series.length === 0) return '';
  if (series.length === 1) {
    const y = height - series[0] * height;
    return `0,${y.toFixed(1)} ${width},${y.toFixed(1)}`;
  }
  const step = width / (series.length - 1);
  return series
    .map((v, i) => {
      const x = i * step;
      // mastery 0..1 → y inverted (0 mastery at the bottom).
      const y = height - Math.max(0, Math.min(1, v)) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

function formatEta(days: number | null): string {
  if (days === null) return 'ETA —';
  if (days <= 0) return 'At target';
  if (days >= 365) return 'ETA 12+ mo';
  if (days >= 60) return `ETA ~${Math.round(days / 30)} mo`;
  return `ETA ~${days}d`;
}

function Sparkline({
  curve,
  width,
  height,
}: {
  curve: DomainLearningCurve;
  width: number;
  height: number;
}) {
  const { color } = TREND_META[curve.trend];
  const targetY = height - MASTERY_TARGET * height;
  const points = polylinePoints(curve.series, width, height);
  const hasCurve = curve.series.length > 0;
  const label = hasCurve
    ? `${curve.label} mastery ${Math.round(curve.mastery * 100)}%, ${TREND_META[curve.trend].word}${
        curve.plateau ? ', plateaued' : ''
      }`
    : `${curve.label} has no learning curve yet`;

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      style={{ display: 'block', overflow: 'visible' }}
    >
      {/* target band gridline */}
      <line
        x1={0}
        x2={width}
        y1={targetY}
        y2={targetY}
        stroke="var(--border, #334155)"
        strokeWidth={1}
        strokeDasharray="3 3"
        opacity={0.6}
      />
      {hasCurve ? (
        <>
          {/* soft fill under the curve for body */}
          <polyline
            points={`0,${height} ${points} ${width},${height}`}
            fill={color}
            fillOpacity={0.12}
            stroke="none"
          />
          <polyline
            points={points}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {/* endpoint marker at current mastery */}
          <circle
            cx={width}
            cy={height - Math.max(0, Math.min(1, curve.mastery)) * height}
            r={2.6}
            fill={color}
          />
        </>
      ) : (
        <text
          x={width / 2}
          y={height / 2}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={10}
          fill="var(--text-muted, #94a3b8)"
        >
          no signal yet
        </text>
      )}
    </svg>
  );
}

function DomainCell({
  curve,
  width,
  height,
}: {
  curve: DomainLearningCurve;
  width: number;
  height: number;
}) {
  const meta = TREND_META[curve.trend];
  const Icon = meta.Icon;
  const cellStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-2, 8px)',
    padding: 'var(--space-3, 12px)',
    borderRadius: 'var(--radius-md, 10px)',
    background: 'var(--surface-raised, rgba(148,163,184,0.06))',
    border: '1px solid var(--border, rgba(148,163,184,0.18))',
    minWidth: 0,
  };
  const headStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2, 8px)',
  };
  return (
    <div style={cellStyle}>
      <div style={headStyle}>
        <span
          style={{
            fontSize: 'var(--fs-sm, 13px)',
            fontWeight: 700,
            color: 'var(--text-primary, #e2e8f0)',
          }}
        >
          {curve.label}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            color: meta.color,
            fontSize: 'var(--fs-xs, 11px)',
            fontWeight: 600,
          }}
        >
          <Icon size={13} aria-hidden />
          {curve.reachable && curve.evidenceN > 0
            ? `${curve.slopePerWeek > 0 ? '+' : ''}${curve.slopePerWeek.toFixed(3)}/wk`
            : '—'}
        </span>
      </div>

      <Sparkline curve={curve} width={width} height={height} />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: 'var(--fs-xs, 11px)',
          color: 'var(--text-secondary, #94a3b8)',
        }}
      >
        <span>
          {curve.reachable && curve.evidenceN > 0
            ? `${Math.round(curve.mastery * 100)}% mastery`
            : 'no evidence'}
        </span>
        <span>{formatEta(curve.masteryEtaDays)}</span>
      </div>

      {curve.plateau && (
        <span
          style={{
            fontSize: 'var(--fs-xs, 11px)',
            color: 'var(--warning, #d97706)',
            fontWeight: 600,
          }}
        >
          Plateau detected
        </span>
      )}
    </div>
  );
}

/**
 * The grid of per-domain learning-curve sparklines. Renders nothing when there
 * are no curves to show (the parent decides whether to show an empty state).
 */
export function DashboardSparklineGrid({
  curves,
  sparkWidth = 120,
  sparkHeight = 44,
  className,
}: DashboardSparklineGridProps) {
  if (!curves || curves.length === 0) return null;
  return (
    <div
      className={className}
      role="group"
      aria-label="Per-domain learning curves"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${Math.min(3, curves.length)}, minmax(0, 1fr))`,
        gap: 'var(--space-3, 12px)',
      }}
    >
      {curves.map((curve) => (
        <DomainCell key={curve.domain} curve={curve} width={sparkWidth} height={sparkHeight} />
      ))}
    </div>
  );
}

export default DashboardSparklineGrid;
