import { useId, useMemo, useState } from 'react';
import { Group } from '@visx/group';
import { scaleLinear, scaleTime } from '@visx/scale';
import { LinePath, Line, Bar, AreaClosed } from '@visx/shape';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { GridRows } from '@visx/grid';
import { curveMonotoneX } from '@visx/curve';
import { ParentSize } from '@visx/responsive';
import { ReferenceLine, VIZ_TOKENS } from './chart-kit';

/**
 * ANL-5 — host-styled TrendChart, promoted from the LSAT viz barrel.
 *
 * A time-series score line with an optional goal band, projection cone, and
 * exam-date marker, restyled onto host tokens. The LSAT original carried a
 * keyboard data-point cursor + ARIA live region (UC5) wired to `@lsat`
 * components; this host promotion keeps the visual feature set and a
 * mouse-hover readout, dropping the cross-domain live-region dependency. The
 * SVG carries an `aria-label` summarising the series for screen readers.
 */

export interface TrendDatum {
  /** ISO date string. */
  date: string;
  score: number;
}

export interface TrendChartProps {
  series: TrendDatum[];
  /** Prior-period overlay (dashed, muted). */
  priorSeries?: TrendDatum[];
  /** Goal band [low, high] (e.g. [165, 170]). */
  goal?: [number, number];
  /** ISO date of the exam (renders a vertical marker). */
  examDate?: string;
  /** Optional projected end value + spread for a dashed projection cone. */
  projection?: { score: number; spread?: number };
  /** Accent color for the line/area (defaults to the host accent token). */
  color?: string;
  height?: number;
  className?: string;
}

const MARGIN = { top: 12, right: 16, bottom: 26, left: 36 };
const AXIS_COLOR = VIZ_TOKENS.textMuted;

function Inner({
  width,
  height,
  series,
  priorSeries,
  goal,
  examDate,
  projection,
  color = VIZ_TOKENS.accent,
}: TrendChartProps & { width: number; height: number }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const gradId = useId();
  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = Math.max(0, height - MARGIN.top - MARGIN.bottom);

  const parsed = useMemo(() => series.map((d) => ({ ...d, t: new Date(d.date) })), [series]);
  const priorParsed = useMemo(
    () => (priorSeries ?? []).map((d) => ({ ...d, t: new Date(d.date) })),
    [priorSeries],
  );
  const allForScale = useMemo(() => [...parsed, ...priorParsed], [parsed, priorParsed]);

  const { xScale, yScale } = useMemo(() => {
    const dates = allForScale.map((d) => d.t.getTime());
    const examT = examDate ? new Date(examDate).getTime() : undefined;
    const maxT = examT ? Math.max(examT, ...dates) : Math.max(...dates);
    const minT = Math.min(...dates);
    const scores = allForScale.map((d) => d.score);
    const lo = Math.min(...scores, goal?.[0] ?? Infinity) - 2;
    const hi = Math.max(...scores, goal?.[1] ?? -Infinity, projection?.score ?? -Infinity) + 2;
    return {
      xScale: scaleTime({ domain: [minT, maxT], range: [0, innerW] }),
      yScale: scaleLinear({ domain: [lo, hi], range: [innerH, 0] }),
    };
  }, [allForScale, innerW, innerH, goal, examDate, projection]);

  if (!parsed.length || innerW <= 0) return null;

  const last = parsed[parsed.length - 1];
  const examT = examDate ? new Date(examDate).getTime() : undefined;
  const hoverPoint = hoverIdx != null ? parsed[hoverIdx] : undefined;

  const nearestIdx = (xPx: number): number => {
    const t = xScale.invert(xPx).getTime();
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < parsed.length; i++) {
      const d = Math.abs(parsed[i].t.getTime() - t);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={`Score trend, ${parsed.length} data points, latest ${last.score}.`}
      style={{ userSelect: 'none' }}
    >
      <Group left={MARGIN.left} top={MARGIN.top}>
        <GridRows scale={yScale} width={innerW} stroke={VIZ_TOKENS.border} strokeOpacity={0.6} numTicks={4} />

        {goal && (
          <>
            <rect
              x={0}
              y={yScale(goal[1])}
              width={innerW}
              height={Math.max(0, yScale(goal[0]) - yScale(goal[1]))}
              fill={color}
              opacity={0.1}
            />
            <Line from={{ x: 0, y: yScale(goal[1]) }} to={{ x: innerW, y: yScale(goal[1]) }} stroke={color} strokeDasharray="2,3" strokeOpacity={0.5} />
            <Line from={{ x: 0, y: yScale(goal[0]) }} to={{ x: innerW, y: yScale(goal[0]) }} stroke={color} strokeDasharray="2,3" strokeOpacity={0.35} />
            <text x={2} y={yScale(goal[1]) + 9} fontSize={9} fontWeight={600} fill={color}>
              goal {goal[0]}–{goal[1]}
            </text>
          </>
        )}

        {projection && examT && (
          <>
            <path
              d={`M ${xScale(last.t.getTime())},${yScale(last.score)} L ${xScale(examT)},${yScale(
                projection.score + (projection.spread ?? 3),
              )} L ${xScale(examT)},${yScale(projection.score - (projection.spread ?? 3))} Z`}
              fill={color}
              opacity={0.1}
            />
            <Line
              from={{ x: xScale(last.t.getTime()), y: yScale(last.score) }}
              to={{ x: xScale(examT), y: yScale(projection.score) }}
              stroke={color}
              strokeDasharray="4,4"
              strokeWidth={1.5}
            />
            <circle cx={xScale(examT)} cy={yScale(projection.score)} r={4} fill={color} stroke={VIZ_TOKENS.surface} strokeWidth={1.5} />
            <text x={xScale(examT) - 6} y={yScale(projection.score) - 6} textAnchor="end" fontSize={11} fontWeight={700} fill={color} className="tabular-nums">
              ~{Math.round(projection.score)}
            </text>
          </>
        )}

        {examT && (
          <>
            <Bar x={xScale(examT) - 0.5} y={0} width={1} height={innerH} fill={VIZ_TOKENS.danger} opacity={0.7} />
            <text x={xScale(examT)} y={-2} textAnchor="end" fontSize={9} fill={VIZ_TOKENS.danger}>
              exam
            </text>
          </>
        )}

        {priorParsed.length > 0 && (
          <LinePath
            data={priorParsed}
            x={(d) => xScale(d.t.getTime()) ?? 0}
            y={(d) => yScale(d.score) ?? 0}
            stroke={VIZ_TOKENS.textMuted}
            strokeWidth={1.5}
            strokeDasharray="4,4"
            curve={curveMonotoneX}
          />
        )}

        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0.02} />
        </linearGradient>
        <AreaClosed
          data={parsed}
          x={(d) => xScale(d.t.getTime()) ?? 0}
          y={(d) => yScale(d.score) ?? 0}
          yScale={yScale}
          fill={`url(#${gradId})`}
          curve={curveMonotoneX}
        />
        <LinePath
          data={parsed}
          x={(d) => xScale(d.t.getTime()) ?? 0}
          y={(d) => yScale(d.score) ?? 0}
          stroke={color}
          strokeWidth={2}
          curve={curveMonotoneX}
        />
        {parsed.map((d, i) => (
          <circle key={i} cx={xScale(d.t.getTime())} cy={yScale(d.score)} r={2.5} fill={color} />
        ))}

        <circle cx={xScale(last.t.getTime())} cy={yScale(last.score)} r={4.5} fill={color} stroke={VIZ_TOKENS.surface} strokeWidth={2} />
        <text x={xScale(last.t.getTime())} y={yScale(last.score) - 8} textAnchor={examT ? 'middle' : 'end'} fontSize={11} fontWeight={700} fill={VIZ_TOKENS.text} className="tabular-nums">
          {last.score}
        </text>

        {hoverPoint && (
          <Group>
            <ReferenceLine orientation="vertical" at={xScale(hoverPoint.t.getTime())} length={innerH} stroke={VIZ_TOKENS.text} dash="2,3" opacity={0.35} strokeWidth={1} />
            <circle cx={xScale(hoverPoint.t.getTime())} cy={yScale(hoverPoint.score)} r={4} fill={VIZ_TOKENS.surface} stroke={color} strokeWidth={2} />
            <g transform={`translate(${Math.min(Math.max(xScale(hoverPoint.t.getTime()) - 30, 0), Math.max(0, innerW - 60))}, 2)`}>
              <rect width={60} height={28} rx={6} fill={VIZ_TOKENS.surface} stroke={VIZ_TOKENS.border} />
              <text x={6} y={12} fontSize={9} fill={VIZ_TOKENS.textMuted}>
                {hoverPoint.date.slice(5, 10)}
              </text>
              <text x={6} y={23} fontSize={11} fontWeight={700} fill={VIZ_TOKENS.text} className="tabular-nums">
                {hoverPoint.score}
              </text>
            </g>
          </Group>
        )}

        <AxisLeft scale={yScale} numTicks={4} stroke={AXIS_COLOR} tickStroke={AXIS_COLOR} tickLabelProps={() => ({ fill: AXIS_COLOR, fontSize: 9, dx: -2 })} />
        <AxisBottom top={innerH} scale={xScale} numTicks={4} stroke={AXIS_COLOR} tickStroke={AXIS_COLOR} tickLabelProps={() => ({ fill: AXIS_COLOR, fontSize: 9, textAnchor: 'middle' as const })} />

        <rect
          x={0}
          y={0}
          width={innerW}
          height={innerH}
          fill="transparent"
          onMouseMove={(e) => setHoverIdx(nearestIdx(e.nativeEvent.offsetX - MARGIN.left))}
          onMouseLeave={() => setHoverIdx(null)}
        />
      </Group>
    </svg>
  );
}

/** visx line chart with goal band, projection cone, and exam-date marker. */
export function TrendChart({ height = 220, className, ...rest }: TrendChartProps) {
  return (
    <div className={className} style={{ width: '100%', height }}>
      <ParentSize>{({ width }) => <Inner width={width} height={height} {...rest} />}</ParentSize>
    </div>
  );
}
