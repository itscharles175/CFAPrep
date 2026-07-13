import {
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Group } from '@visx/group';
import { scaleBand, scaleLinear, scalePoint } from '@visx/scale';
import { LinePath, Bar, AreaClosed, Line as VisxLine } from '@visx/shape';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { GridRows } from '@visx/grid';
import { curveMonotoneX } from '@visx/curve';
import { ParentSize } from '@visx/responsive';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * ANL-5 — shared, host-styled chart kit.
 *
 * Promotes the LSAT domain's @visx viz primitives (TrendChart / HeatStrip /
 * StatNumber / ReadinessGauge) into a host barrel restyled onto the host design
 * tokens (`var(--accent)`, `var(--text-muted)`, `var(--surface)`, …) instead of
 * the LSAT subtree's `hsl(var(--primary))` palette. This is also the small
 * compat layer the host's `Analytics.jsx` migrates onto, off bare `recharts`
 * (ResponsiveContainer / LineChart / ComposedChart / BarChart / ScatterChart /
 * Line / Area / Bar / Scatter / Tooltip / …) and onto these visx wrappers.
 *
 * Self-contained: imports only host dependencies (`@visx/*`, `clsx`,
 * `tailwind-merge`, `react`) so the host's strict tsc type-checks it without
 * the `@lsat/*` aliases (which the host tsconfig does not resolve for types).
 */

/** Local class-name combiner (clsx + tailwind-merge) — mirrors the LSAT `cn`
 *  without importing across the domain boundary. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// Host design tokens, referenced as the chart palette. These resolve at runtime
// from the host's CSS variables (src/styles/tokens.css + index.css), so the
// charts re-theme with the rest of the app (dark / light / per-domain accent).
export const VIZ_TOKENS = {
  accent: 'var(--accent, #60a5fa)',
  accentSoft: 'var(--surface-soft, rgba(96,165,250,0.18))',
  surface: 'var(--surface, var(--bg-card, #141d2b))',
  border: 'var(--border, rgba(148,163,184,0.18))',
  text: 'var(--text-primary, #e2e8f0)',
  textSecondary: 'var(--text-secondary, #cbd5e1)',
  textMuted: 'var(--text-muted, #94a3b8)',
  success: 'var(--success, #34d399)',
  warning: 'var(--warning, #f59e0b)',
  danger: 'var(--danger, #f87171)',
  quant: 'var(--quant, #c084fc)',
} as const;

// ---------------------------------------------------------------------------
// ChartTooltip — ONE popover identity on host tokens, matching the inline
// tooltip styling the host's recharts charts used (surface bg + border + 8px
// radius). Both the inline style (for our hover overlay) and the component are
// exported so call sites can pick whichever fits.
// ---------------------------------------------------------------------------

export const chartTooltipStyle: CSSProperties = {
  position: 'absolute',
  background: VIZ_TOKENS.surface,
  color: VIZ_TOKENS.textSecondary,
  border: `1px solid ${VIZ_TOKENS.border}`,
  borderRadius: 8,
  boxShadow: 'var(--elevation-2, 0 4px 12px rgba(0,0,0,0.28))',
  fontSize: 12,
  lineHeight: 1.35,
  padding: '6px 8px',
  pointerEvents: 'none',
  zIndex: 10,
};

export interface ChartTooltipProps {
  left?: number;
  top?: number;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** Standalone HTML tooltip with the host popover identity. */
export function ChartTooltip({ left, top, children, className, style }: ChartTooltipProps) {
  return (
    <div
      role="tooltip"
      className={className}
      style={{
        ...chartTooltipStyle,
        left,
        top,
        transform: left != null || top != null ? 'translate(-50%, -120%)' : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChartLegend — categorical key (swatch + label), supports a dashed variant for
// the reference/diagonal lines and a hollow swatch for outlined series.
// ---------------------------------------------------------------------------

export interface LegendItem {
  label: string;
  color: string;
  dashed?: boolean;
  hollow?: boolean;
}

export interface ChartLegendProps {
  items: LegendItem[];
  className?: string;
}

/** Horizontal categorical legend rendered beneath/alongside a chart. */
export function ChartLegend({ items, className }: ChartLegendProps) {
  return (
    <ul
      className={cn('qv-row-3', className)}
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        flexWrap: 'wrap',
        fontSize: 12,
        color: VIZ_TOKENS.textMuted,
      }}
    >
      {items.map((it, i) => (
        <li key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {it.dashed ? (
            <span
              style={{
                display: 'inline-block',
                width: 16,
                height: 0,
                borderTop: `2px dashed ${it.color}`,
              }}
            />
          ) : (
            <span
              style={{
                display: 'inline-block',
                width: 12,
                height: 12,
                borderRadius: 3,
                background: it.hollow ? 'transparent' : it.color,
                border: it.hollow ? `2px solid ${it.color}` : undefined,
              }}
            />
          )}
          <span>{it.label}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// ReferenceLine — SVG marker line (goal / median / exam date) with an optional
// label. Drawn inside an SVG <Group>. Token-driven.
// ---------------------------------------------------------------------------

export interface ReferenceLineProps {
  orientation?: 'vertical' | 'horizontal';
  at: number;
  length: number;
  start?: number;
  stroke?: string;
  strokeWidth?: number;
  dash?: string;
  opacity?: number;
  label?: string;
  labelAnchor?: 'start' | 'middle' | 'end';
  labelColor?: string;
  fontSize?: number;
}

/** A reference line (goal / median / exam) drawn inside an SVG <Group>. */
export function ReferenceLine({
  orientation = 'vertical',
  at,
  length,
  start = 0,
  stroke = VIZ_TOKENS.accent,
  strokeWidth = 1,
  dash = '4,4',
  opacity = 0.8,
  label,
  labelAnchor = 'middle',
  labelColor = VIZ_TOKENS.textMuted,
  fontSize = 10,
}: ReferenceLineProps) {
  const isV = orientation === 'vertical';
  const x1 = isV ? at : start;
  const x2 = isV ? at : start + length;
  const y1 = isV ? start : at;
  const y2 = isV ? start + length : at;
  return (
    <>
      <line
        x1={x1}
        x2={x2}
        y1={y1}
        y2={y2}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={dash}
        strokeOpacity={opacity}
      />
      {label && (
        <text
          x={isV ? at : x2}
          y={isV ? start - 2 : at - 2}
          textAnchor={labelAnchor}
          fontSize={fontSize}
          fill={labelColor}
        >
          {label}
        </text>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared geometry. The compat wrappers below all share one margin + axis look
// so they read as a single family on the Analytics page.
// ---------------------------------------------------------------------------

const MARGIN = { top: 12, right: 20, bottom: 26, left: 36 };
const AXIS_COLOR = VIZ_TOKENS.textMuted;

function axisLabelProps() {
  return { fill: AXIS_COLOR, fontSize: 10 } as const;
}

interface CategoryDatum {
  /** Category label on the x (vertical bars / lines) or y (horizontal bars). */
  name: string;
}

/** Shared responsive shell: measures width, fixes height, renders children. */
function ChartFrame({
  height,
  className,
  ariaLabel,
  children,
}: {
  height: number;
  className?: string;
  ariaLabel?: string;
  children: (width: number) => ReactNode;
}) {
  return (
    <div
      className={className}
      style={{ width: '100%', height }}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
    >
      <ParentSize>{({ width }) => (width > 0 ? children(width) : null)}</ParentSize>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LineTrend — replaces recharts <LineChart>/<ComposedChart> with one or more
// <Line> series over a categorical x axis (e.g. mastery-over-time, retention
// decay, cross-domain trend). `area` fills under the first series.
// ---------------------------------------------------------------------------

export interface LineSeries {
  /** Key into each datum for the y value. */
  dataKey: string;
  name: string;
  color: string;
  /** Render a soft gradient fill under this series. */
  area?: boolean;
  strokeWidth?: number;
  /** Draw point dots (default false for dense series). */
  dots?: boolean;
}

export interface LineTrendProps {
  data: Array<Record<string, unknown>>;
  /** Key into each datum for the x category label. */
  xKey: string;
  series: LineSeries[];
  /** Fixed y domain (e.g. [0,100] for percentages); auto otherwise. */
  yDomain?: [number, number];
  /** Tick formatter for the y axis. */
  yTickFormat?: (v: number) => string;
  /** Max x tick labels before thinning. */
  maxXTicks?: number;
  height?: number;
  className?: string;
}

/** visx multi-line trend (categorical x). recharts LineChart/ComposedChart compat. */
export function LineTrend({
  data,
  xKey,
  series,
  yDomain,
  yTickFormat,
  maxXTicks = 8,
  height = 240,
  className,
}: LineTrendProps) {
  const gradId = useId();
  return (
    <ChartFrame height={height} className={className}>
      {(width) => {
        const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
        const innerH = Math.max(0, height - MARGIN.top - MARGIN.bottom);
        const labels = data.map((d) => String(d[xKey]));
        const xScale = scalePoint<string>({ domain: labels, range: [0, innerW], padding: 0 });
        const numbers: number[] = [];
        for (const d of data) for (const s of series) {
          const v = Number(d[s.dataKey]);
          if (Number.isFinite(v)) numbers.push(v);
        }
        const lo = yDomain ? yDomain[0] : Math.min(0, ...numbers);
        const hi = yDomain ? yDomain[1] : Math.max(1, ...numbers);
        const yScale = scaleLinear({ domain: [lo, hi], range: [innerH, 0] });
        const step = Math.max(1, Math.floor(labels.length / maxXTicks));
        return (
          <svg width={width} height={height}>
            <Group left={MARGIN.left} top={MARGIN.top}>
              <GridRows scale={yScale} width={innerW} stroke={VIZ_TOKENS.border} strokeOpacity={0.6} numTicks={4} />
              {series.map((s, si) => {
                const points = data
                  .map((d) => ({ x: xScale(String(d[xKey])) ?? 0, y: Number(d[s.dataKey]) }))
                  .filter((p) => Number.isFinite(p.y));
                return (
                  <Group key={s.dataKey}>
                    {s.area && (
                      <>
                        <linearGradient id={`${gradId}-${si}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={s.color} stopOpacity={0.28} />
                          <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
                        </linearGradient>
                        <AreaClosed
                          data={points}
                          x={(p) => p.x}
                          y={(p) => yScale(p.y)}
                          yScale={yScale}
                          fill={`url(#${gradId}-${si})`}
                          curve={curveMonotoneX}
                        />
                      </>
                    )}
                    <LinePath
                      data={points}
                      x={(p) => p.x}
                      y={(p) => yScale(p.y)}
                      stroke={s.color}
                      strokeWidth={s.strokeWidth ?? 2}
                      curve={curveMonotoneX}
                    />
                    {s.dots &&
                      points.map((p, i) => (
                        <circle key={i} cx={p.x} cy={yScale(p.y)} r={2.5} fill={s.color} />
                      ))}
                  </Group>
                );
              })}
              <AxisLeft
                scale={yScale}
                numTicks={4}
                stroke={AXIS_COLOR}
                tickStroke={AXIS_COLOR}
                tickFormat={yTickFormat ? (v) => yTickFormat(Number(v)) : undefined}
                tickLabelProps={axisLabelProps}
              />
              <AxisBottom
                top={innerH}
                scale={xScale}
                stroke={AXIS_COLOR}
                tickStroke={AXIS_COLOR}
                tickValues={labels.filter((_, i) => i % step === 0)}
                tickLabelProps={() => ({ fill: AXIS_COLOR, fontSize: 10, textAnchor: 'middle' as const })}
              />
            </Group>
          </svg>
        );
      }}
    </ChartFrame>
  );
}

// ---------------------------------------------------------------------------
// BandTrend — replaces the exam-readiness ComposedChart (confidence band area
// + projected line + exam reference line). The band is the area between
// `lowerKey` and `upperKey`; `lineKey` is the central projection.
// ---------------------------------------------------------------------------

export interface BandTrendProps {
  data: Array<Record<string, unknown>>;
  xKey: string;
  lineKey: string;
  upperKey: string;
  lowerKey: string;
  lineColor?: string;
  bandColor?: string;
  yDomain?: [number, number];
  /** Category value on the x axis to drop a reference line at (e.g. exam date). */
  referenceX?: string | null;
  referenceLabel?: string;
  maxXTicks?: number;
  height?: number;
  className?: string;
}

/** visx projection band + central line (recharts ComposedChart Area/Line compat). */
export function BandTrend({
  data,
  xKey,
  lineKey,
  upperKey,
  lowerKey,
  lineColor = VIZ_TOKENS.accent,
  bandColor = VIZ_TOKENS.accentSoft,
  yDomain = [0, 100],
  referenceX = null,
  referenceLabel = 'Exam',
  maxXTicks = 8,
  height = 280,
  className,
}: BandTrendProps) {
  return (
    <ChartFrame height={height} className={className}>
      {(width) => {
        const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
        const innerH = Math.max(0, height - MARGIN.top - MARGIN.bottom);
        const labels = data.map((d) => String(d[xKey]));
        const xScale = scalePoint<string>({ domain: labels, range: [0, innerW], padding: 0 });
        const yScale = scaleLinear({ domain: yDomain, range: [innerH, 0] });
        const step = Math.max(1, Math.floor(labels.length / maxXTicks));
        const upper = data.map((d) => ({ x: xScale(String(d[xKey])) ?? 0, y0: Number(d[lowerKey]), y1: Number(d[upperKey]) }));
        const line = data.map((d) => ({ x: xScale(String(d[xKey])) ?? 0, y: Number(d[lineKey]) }));
        // Band as a filled polygon: upper edge L→R, then lower edge R→L.
        const bandPath = upper.length
          ? `M ${upper.map((p) => `${p.x},${yScale(p.y1)}`).join(' L ')} L ${[...upper]
              .reverse()
              .map((p) => `${p.x},${yScale(p.y0)}`)
              .join(' L ')} Z`
          : '';
        const refX = referenceX != null ? xScale(referenceX) : undefined;
        return (
          <svg width={width} height={height}>
            <Group left={MARGIN.left} top={MARGIN.top}>
              <GridRows scale={yScale} width={innerW} stroke={VIZ_TOKENS.border} strokeOpacity={0.6} numTicks={4} />
              {bandPath && <path d={bandPath} fill={bandColor} fillOpacity={0.6} />}
              <LinePath
                data={line}
                x={(p) => p.x}
                y={(p) => yScale(p.y)}
                stroke={lineColor}
                strokeWidth={2.5}
                curve={curveMonotoneX}
              />
              {refX != null && (
                <ReferenceLine
                  orientation="vertical"
                  at={refX}
                  length={innerH}
                  stroke={VIZ_TOKENS.danger}
                  dash="4,4"
                  opacity={0.8}
                  label={referenceLabel}
                  labelColor={VIZ_TOKENS.danger}
                />
              )}
              <AxisLeft
                scale={yScale}
                numTicks={4}
                stroke={AXIS_COLOR}
                tickStroke={AXIS_COLOR}
                tickLabelProps={axisLabelProps}
              />
              <AxisBottom
                top={innerH}
                scale={xScale}
                stroke={AXIS_COLOR}
                tickStroke={AXIS_COLOR}
                tickValues={labels.filter((_, i) => i % step === 0)}
                tickLabelProps={() => ({ fill: AXIS_COLOR, fontSize: 10, textAnchor: 'middle' as const })}
              />
            </Group>
          </svg>
        );
      }}
    </ChartFrame>
  );
}

// ---------------------------------------------------------------------------
// BarSeriesChart — replaces recharts <BarChart>. Vertical (grouped bars over a
// categorical x) or horizontal (single series, category on y). Used for the
// review-load forecast (due / at-risk) and accuracy-by-item-type.
// ---------------------------------------------------------------------------

export interface BarSeries {
  dataKey: string;
  name: string;
  color: string;
}

export interface BarSeriesChartProps {
  data: Array<Record<string, unknown> & CategoryDatum>;
  series: BarSeries[];
  layout?: 'vertical' | 'horizontal';
  yDomain?: [number, number];
  valueTickFormat?: (v: number) => string;
  /** Width reserved for category labels in horizontal layout. */
  categoryWidth?: number;
  height?: number;
  className?: string;
}

/** visx grouped/horizontal bars (recharts BarChart compat). */
export function BarSeriesChart({
  data,
  series,
  layout = 'vertical',
  yDomain,
  valueTickFormat,
  categoryWidth = 90,
  height = 240,
  className,
}: BarSeriesChartProps) {
  return (
    <ChartFrame height={height} className={className}>
      {(width) => {
        const horizontal = layout === 'horizontal';
        const margin = horizontal ? { ...MARGIN, left: categoryWidth, right: 24 } : MARGIN;
        const innerW = Math.max(0, width - margin.left - margin.right);
        const innerH = Math.max(0, height - margin.top - margin.bottom);
        const cats = data.map((d) => d.name);
        const values: number[] = [];
        for (const d of data) for (const s of series) {
          const v = Number(d[s.dataKey]);
          if (Number.isFinite(v)) values.push(v);
        }
        const vLo = yDomain ? yDomain[0] : 0;
        const vHi = yDomain ? yDomain[1] : Math.max(1, ...values);

        if (horizontal) {
          // Category on y, value on x; single series only.
          const s = series[0];
          const yScale = scaleBand<string>({ domain: cats, range: [0, innerH], padding: 0.25 });
          const xScale = scaleLinear({ domain: [vLo, vHi], range: [0, innerW] });
          return (
            <svg width={width} height={height}>
              <Group left={margin.left} top={margin.top}>
                {data.map((d) => {
                  const v = Number(d[s.dataKey]);
                  const y = yScale(d.name) ?? 0;
                  return (
                    <Bar
                      key={d.name}
                      x={0}
                      y={y}
                      width={Number.isFinite(v) ? xScale(v) : 0}
                      height={yScale.bandwidth()}
                      fill={s.color}
                      rx={4}
                    />
                  );
                })}
                <AxisLeft
                  scale={yScale}
                  stroke={AXIS_COLOR}
                  tickStroke={AXIS_COLOR}
                  tickLabelProps={() => ({ fill: AXIS_COLOR, fontSize: 10, textAnchor: 'end' as const, dx: -2, dy: 3 })}
                />
                <AxisBottom
                  top={innerH}
                  scale={xScale}
                  numTicks={5}
                  stroke={AXIS_COLOR}
                  tickStroke={AXIS_COLOR}
                  tickFormat={valueTickFormat ? (v) => valueTickFormat(Number(v)) : undefined}
                  tickLabelProps={() => ({ fill: AXIS_COLOR, fontSize: 10, textAnchor: 'middle' as const })}
                />
              </Group>
            </svg>
          );
        }

        // Vertical grouped bars.
        const xScale = scaleBand<string>({ domain: cats, range: [0, innerW], padding: 0.3 });
        const groupScale = scaleBand<string>({
          domain: series.map((s) => s.dataKey),
          range: [0, xScale.bandwidth()],
          padding: 0.1,
        });
        const yScale = scaleLinear({ domain: [vLo, vHi], range: [innerH, 0] });
        return (
          <svg width={width} height={height}>
            <Group left={margin.left} top={margin.top}>
              <GridRows scale={yScale} width={innerW} stroke={VIZ_TOKENS.border} strokeOpacity={0.6} numTicks={4} />
              {data.map((d) => {
                const gx = xScale(d.name) ?? 0;
                return (
                  <Group key={d.name} left={gx}>
                    {series.map((s) => {
                      const v = Number(d[s.dataKey]);
                      if (!Number.isFinite(v)) return null;
                      const barH = innerH - yScale(v);
                      return (
                        <Bar
                          key={s.dataKey}
                          x={groupScale(s.dataKey) ?? 0}
                          y={yScale(v)}
                          width={groupScale.bandwidth()}
                          height={Math.max(0, barH)}
                          fill={s.color}
                          rx={4}
                        />
                      );
                    })}
                  </Group>
                );
              })}
              <AxisLeft
                scale={yScale}
                numTicks={4}
                stroke={AXIS_COLOR}
                tickStroke={AXIS_COLOR}
                tickFormat={valueTickFormat ? (v) => valueTickFormat(Number(v)) : undefined}
                tickLabelProps={axisLabelProps}
              />
              <AxisBottom
                top={innerH}
                scale={xScale}
                stroke={AXIS_COLOR}
                tickStroke={AXIS_COLOR}
                tickLabelProps={() => ({ fill: AXIS_COLOR, fontSize: 10, textAnchor: 'middle' as const })}
              />
            </Group>
          </svg>
        );
      }}
    </ChartFrame>
  );
}

// ---------------------------------------------------------------------------
// CalibrationScatter — replaces the recharts ScatterChart used for confidence-
// vs-accuracy calibration: a 1:1 diagonal reference + one or more point series.
// ---------------------------------------------------------------------------

export interface ScatterPoint {
  x: number;
  y: number;
  label: string;
  attempts: number;
}

export interface ScatterSeries {
  name: string;
  color: string;
  points: ScatterPoint[];
}

export interface CalibrationScatterProps {
  series: ScatterSeries[];
  /** Axis labels. */
  xLabel?: string;
  yLabel?: string;
  /** Draw the perfect-calibration 1:1 diagonal (default true). */
  diagonal?: boolean;
  height?: number;
  className?: string;
  /** Accessible name for the chart (sets role="img" + aria-label on the frame). */
  ariaLabel?: string;
}

/** visx calibration scatter with a 1:1 diagonal (recharts ScatterChart compat). */
export function CalibrationScatter({
  series,
  xLabel = 'Confidence %',
  yLabel = 'Accuracy %',
  diagonal = true,
  height = 240,
  className,
  ariaLabel,
}: CalibrationScatterProps) {
  const [hover, setHover] = useState<{ left: number; top: number; pt: ScatterPoint; series: string } | null>(null);
  const margin = { ...MARGIN, right: 24, left: 40 };
  return (
    <ChartFrame height={height} className={className} ariaLabel={ariaLabel}>
      {(width) => {
        const innerW = Math.max(0, width - margin.left - margin.right);
        const innerH = Math.max(0, height - margin.top - margin.bottom);
        const xScale = scaleLinear({ domain: [0, 100], range: [0, innerW] });
        const yScale = scaleLinear({ domain: [0, 100], range: [innerH, 0] });
        return (
          <div style={{ position: 'relative', width, height }}>
            <svg width={width} height={height}>
              <Group left={margin.left} top={margin.top}>
                <GridRows scale={yScale} width={innerW} stroke={VIZ_TOKENS.border} strokeOpacity={0.6} numTicks={4} />
                {diagonal && (
                  <VisxLine
                    from={{ x: xScale(0), y: yScale(0) }}
                    to={{ x: xScale(100), y: yScale(100) }}
                    stroke={VIZ_TOKENS.textMuted}
                    strokeDasharray="6,3"
                    strokeWidth={1}
                  />
                )}
                {series.map((s) =>
                  s.points.map((p, i) => (
                    <circle
                      key={`${s.name}-${i}`}
                      cx={xScale(p.x)}
                      cy={yScale(p.y)}
                      r={6}
                      fill={s.color}
                      fillOpacity={0.85}
                      stroke={VIZ_TOKENS.surface}
                      strokeWidth={1.5}
                      onMouseEnter={() =>
                        setHover({ left: margin.left + xScale(p.x), top: margin.top + yScale(p.y), pt: p, series: s.name })
                      }
                      onMouseLeave={() => setHover(null)}
                    />
                  )),
                )}
                <AxisLeft
                  scale={yScale}
                  numTicks={4}
                  stroke={AXIS_COLOR}
                  tickStroke={AXIS_COLOR}
                  tickLabelProps={axisLabelProps}
                  label={yLabel}
                  labelProps={{ fill: AXIS_COLOR, fontSize: 11, textAnchor: 'middle' as const }}
                />
                <AxisBottom
                  top={innerH}
                  scale={xScale}
                  numTicks={5}
                  stroke={AXIS_COLOR}
                  tickStroke={AXIS_COLOR}
                  tickLabelProps={() => ({ fill: AXIS_COLOR, fontSize: 10, textAnchor: 'middle' as const })}
                  label={xLabel}
                  labelProps={{ fill: AXIS_COLOR, fontSize: 11, textAnchor: 'middle' as const }}
                />
              </Group>
            </svg>
            {hover && (
              <ChartTooltip left={hover.left} top={hover.top}>
                <div style={{ fontWeight: 600 }}>{hover.pt.label}</div>
                <div style={{ color: VIZ_TOKENS.textMuted }}>
                  {hover.pt.y}% ({hover.pt.attempts} attempts)
                </div>
              </ChartTooltip>
            )}
          </div>
        );
      }}
    </ChartFrame>
  );
}
