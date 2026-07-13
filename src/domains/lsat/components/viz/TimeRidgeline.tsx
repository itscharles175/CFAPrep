import { memo, useMemo } from "react";
import { useReducedMotion } from "motion/react";
import { Group } from "@visx/group";
import { scaleLinear } from "@visx/scale";
import { ParentSize } from "@visx/responsive";

export interface RidgelineSeries {
  facet: string;
  /** Seconds per question for this facet. */
  values: number[];
  color?: string;
}

export interface TimeRidgelineProps {
  series: RidgelineSeries[];
  /** Target seconds — rendered as a vertical reference line. */
  target?: number;
  /** X-axis max (seconds). Derived from data when omitted. */
  max?: number;
  height?: number;
  className?: string;
}

const MARGIN = { top: 8, right: 12, bottom: 22, left: 92 };
const AXIS = "hsl(var(--muted-foreground))";

function gaussianKde(values: number[], xs: number[], bw: number): number[] {
  if (!values.length || bw <= 0) return xs.map(() => 0);
  const norm = 1 / (values.length * bw * Math.sqrt(2 * Math.PI));
  return xs.map((x) => {
    let s = 0;
    for (const v of values) {
      const z = (x - v) / bw;
      s += Math.exp(-0.5 * z * z);
    }
    return s * norm;
  });
}

function Inner({
  width,
  height,
  series,
  target,
  max,
}: TimeRidgelineProps & { width: number; height: number }) {
  const reduce = useReducedMotion();
  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = Math.max(0, height - MARGIN.top - MARGIN.bottom);

  const xMax = useMemo(() => {
    if (max != null) return max;
    const all = series.flatMap((s) => s.values);
    return all.length ? Math.max(60, Math.ceil(Math.max(...all) / 15) * 15) : 120;
  }, [series, max]);

  const xScale = useMemo(
    () => scaleLinear({ domain: [0, xMax], range: [0, innerW] }),
    [xMax, innerW],
  );

  const samples = useMemo(
    () => Array.from({ length: 60 }, (_, i) => (i / 59) * xMax),
    [xMax],
  );

  const rows = useMemo(() => {
    const bw = Math.max(4, xMax / 18);
    return series.map((s) => {
      const dens = gaussianKde(s.values, samples, bw);
      const peak = Math.max(1e-9, ...dens);
      return { ...s, dens: dens.map((d) => d / peak) };
    });
  }, [series, samples, xMax]);

  if (!series.length || innerW <= 0) return null;

  const rowH = innerH / rows.length;
  const ridgeH = rowH * 1.7; // overlap onto the row above

  return (
    <svg width={width} height={height} role="img" aria-label="Time-on-question by type">
      <Group left={MARGIN.left} top={MARGIN.top}>
        {/* Target line */}
        {target != null && target <= xMax && (
          <>
            <line
              x1={xScale(target)}
              x2={xScale(target)}
              y1={0}
              y2={innerH}
              stroke="hsl(var(--primary))"
              strokeDasharray="3,3"
              strokeOpacity={0.7}
            />
            <text x={xScale(target)} y={-1} fontSize={8} fill="hsl(var(--primary))" textAnchor="middle">
              {target}s
            </text>
          </>
        )}

        {rows.map((r, i) => {
          const baseY = (i + 1) * rowH;
          const color = r.color ?? "hsl(var(--primary))";
          const pts = r.dens.map((d, j) => {
            const x = xScale(samples[j]);
            const y = baseY - d * ridgeH;
            return `${x},${y}`;
          });
          const area = `M 0,${baseY} L ${pts.join(" L ")} L ${innerW},${baseY} Z`;
          return (
            <Group key={r.facet}>
              {/* R9 §6 — each ridge silhouette traces in; reduced-motion safe. */}
              <path
                d={area}
                fill={color}
                fillOpacity={0.28}
                stroke={color}
                strokeWidth={1.25}
                pathLength={reduce ? undefined : 1}
                strokeDasharray={reduce ? undefined : 1}
                className={reduce ? undefined : "animate-draw-on"}
              />
              <text
                x={-MARGIN.left + 4}
                y={baseY - 3}
                fontSize={10}
                fill={AXIS}
                className="tabular-nums"
              >
                {r.facet}
                <tspan dx={4} fillOpacity={0.7}>
                  n={r.values.length}
                </tspan>
              </text>
            </Group>
          );
        })}

        {/* X axis ticks */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <text
            key={f}
            x={xScale(xMax * f)}
            y={innerH + 14}
            fontSize={9}
            fill={AXIS}
            textAnchor="middle"
          >
            {Math.round(xMax * f)}s
          </text>
        ))}
      </Group>
    </svg>
  );
}

/** B3 — visx ridgeline of per-question seconds, faceted (typically by type). */
function TimeRidgelineImpl({ height = 220, className, ...rest }: TimeRidgelineProps) {
  const rowCount = Math.max(1, rest.series.length);
  const h = Math.max(height, 44 + rowCount * 34);
  return (
    <div className={className} style={{ width: "100%", height: h }}>
      <ParentSize>{({ width }) => <Inner width={width} height={h} {...rest} />}</ParentSize>
    </div>
  );
}

// A2.4 — memoized so the KDE + visx draw-on only re-runs when the series/target
// change, not on every Timing-tab re-render (or while the tab is kept mounted).
export const TimeRidgeline = memo(TimeRidgelineImpl);
TimeRidgeline.displayName = "TimeRidgeline";
