import { useCallback, useId, useMemo, useState } from "react";
import { useReducedMotion } from "motion/react";
import { Group } from "@visx/group";
import { scaleLinear, scaleTime } from "@visx/scale";
import { LinePath, Line, Bar, AreaClosed } from "@visx/shape";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { GridRows } from "@visx/grid";
import { curveMonotoneX } from "@visx/curve";
import { ParentSize } from "@visx/responsive";
import { LinearGradient } from "@visx/gradient";
import { ReferenceLine, ChartAnnotation } from "./chart-kit";
import { deriveTrendAnnotations } from "./trendAnnotations";

export interface TrendDatum {
  /** ISO date string. */
  date: string;
  score: number;
}

export interface TrendChartProps {
  series: TrendDatum[];
  /** Prior-period overlay (dashed, muted). */
  priorSeries?: TrendDatum[];
  /** Goal band [low, high] scaled scores (e.g. [165, 170]). */
  goal?: [number, number];
  /** ISO date of the exam (renders a vertical marker). */
  examDate?: string;
  /** Optional projected end value for the dashed projection cone.
   * `bands` (B1) renders nested variance cones — widest first — for e.g.
   * 50/80/95% confidence. `spread` is the half-width (scaled-score points)
   * at the exam date. Falls back to the single low/high spread if omitted. */
  projection?: {
    score: number;
    lowSpread?: number;
    highSpread?: number;
    bands?: { level: number; spread: number }[];
  };
  /** Notify parent when user brushes a sub-range (ISO dates). */
  onBrushRange?: (range: { start: string; end: string } | null) => void;
  /**
   * R9 §2 — overlay milestone pins (personal-best / improving run / biggest
   * jump), all derived client-side from `series`. Capped to the top 1–2 and
   * de-overlapped. Off by default so existing small-multiple call sites stay
   * uncluttered.
   */
  annotate?: boolean;
  height?: number;
  className?: string;
}

const MARGIN = { top: 12, right: 16, bottom: 28, left: 34 };
const AXIS_COLOR = "hsl(var(--muted-foreground))";

function Inner({
  width,
  height,
  series,
  priorSeries,
  goal,
  examDate,
  projection,
  onBrushRange,
  annotate,
}: TrendChartProps & { width: number; height: number }) {
  const reduce = useReducedMotion();
  const [brush, setBrush] = useState<{ x0: number; x1: number } | null>(null);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);
  // Hover crosshair index into `parsed` (independent of the drag-brush).
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const gradId = useId();
  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = Math.max(0, height - MARGIN.top - MARGIN.bottom);

  // R9 §2 — milestone pins, derived from the series the chart already holds.
  const annotations = useMemo(
    () => (annotate ? deriveTrendAnnotations(series) : []),
    [annotate, series],
  );

  const parsed = useMemo(
    () => series.map((d) => ({ ...d, t: new Date(d.date) })),
    [series],
  );
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
    const hi = Math.max(
      ...scores,
      goal?.[1] ?? -Infinity,
      projection?.score ?? -Infinity,
    ) + 2;
    return {
      xScale: scaleTime({ domain: [minT, maxT], range: [0, innerW] }),
      yScale: scaleLinear({ domain: [lo, hi], range: [innerH, 0] }),
    };
    // `parsed` is already subsumed by `allForScale` ([...parsed, ...priorParsed]).
  }, [allForScale, innerW, innerH, goal, examDate, projection]);

  const finishBrush = useCallback(
    (x0: number, x1: number) => {
      const left = Math.min(x0, x1);
      const right = Math.max(x0, x1);
      if (right - left < 8) {
        setBrush(null);
        onBrushRange?.(null);
        return;
      }
      setBrush({ x0: left, x1: right });
      const t0 = xScale.invert(left).getTime();
      const t1 = xScale.invert(right).getTime();
      const inBrush = parsed.filter((d) => {
        const t = d.t.getTime();
        return t >= t0 && t <= t1;
      });
      if (inBrush.length) {
        onBrushRange?.({
          start: inBrush[0].date,
          end: inBrush[inBrush.length - 1].date,
        });
      }
    },
    [onBrushRange, parsed, xScale],
  );

  if (!parsed.length || innerW <= 0) return null;

  const last = parsed[parsed.length - 1];
  const examT = examDate ? new Date(examDate).getTime() : undefined;
  const brushRect = brush ?? drag;
  // Don't show the readout dot while actively dragging a brush selection.
  const hoverPoint =
    hoverIdx != null && !drag ? parsed[hoverIdx] : undefined;

  /** Nearest datum index to a chart-local x (px). */
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
      aria-label="Score trend"
      className="select-none"
      onMouseLeave={() => drag && finishBrush(drag.x0, drag.x1)}
    >
      <Group left={MARGIN.left} top={MARGIN.top}>
        <GridRows
          scale={yScale}
          width={innerW}
          stroke="hsl(var(--border))"
          strokeOpacity={0.6}
          numTicks={4}
        />

        {/* Goal band — now with numeric edge labels so the target reads as a
            value, not just a tint. */}
        {goal && (
          <>
            <rect
              x={0}
              y={yScale(goal[1])}
              width={innerW}
              height={Math.max(0, yScale(goal[0]) - yScale(goal[1]))}
              fill="hsl(var(--primary))"
              opacity={0.1}
            />
            <Line
              from={{ x: 0, y: yScale(goal[1]) }}
              to={{ x: innerW, y: yScale(goal[1]) }}
              stroke="hsl(var(--primary))"
              strokeDasharray="2,3"
              strokeOpacity={0.5}
            />
            <Line
              from={{ x: 0, y: yScale(goal[0]) }}
              to={{ x: innerW, y: yScale(goal[0]) }}
              stroke="hsl(var(--primary))"
              strokeDasharray="2,3"
              strokeOpacity={0.35}
            />
            <text
              x={2}
              y={yScale(goal[1]) + 9}
              fontSize={9}
              fontWeight={600}
              fill="hsl(var(--primary))"
            >
              goal {goal[0]}–{goal[1]}
            </text>
          </>
        )}

        {/* Projection cone(s) from last point to exam date / projection.
            B1 — nested variance bands when provided (widest drawn first so
            tighter bands layer on top); single cone otherwise. */}
        {projection && examT && (
          <>
            {(projection.bands && projection.bands.length > 0
              ? [...projection.bands].sort((a, b) => b.spread - a.spread)
              : [
                  {
                    level: 0,
                    spread: Math.max(
                      projection.lowSpread ?? 3,
                      projection.highSpread ?? 3,
                    ),
                  },
                ]
            ).map((band, i) => {
              const x0 = xScale(last.t.getTime());
              const x1 = xScale(examT);
              const y0 = yScale(last.score);
              const yHi = yScale(projection.score + band.spread);
              const yLo = yScale(projection.score - band.spread);
              return (
                <path
                  key={band.level || i}
                  d={`M ${x0},${y0} L ${x1},${yHi} L ${x1},${yLo} Z`}
                  fill="hsl(var(--primary))"
                  opacity={0.08 + 0.06 * i}
                >
                  {band.level > 0 && (
                    <title>{`${band.level}% range: ${Math.round(projection.score - band.spread)}–${Math.round(projection.score + band.spread)}`}</title>
                  )}
                </path>
              );
            })}
            <Line
              from={{ x: xScale(last.t.getTime()), y: yScale(last.score) }}
              to={{ x: xScale(examT), y: yScale(projection.score) }}
              stroke="hsl(var(--primary))"
              strokeDasharray="4,4"
              strokeWidth={1.5}
            />
            {/* Band level labels at the exam end (B1) */}
            {projection.bands?.map((band) => (
              <text
                key={`lbl-${band.level}`}
                x={xScale(examT) - 3}
                y={yScale(projection.score + band.spread) - 1}
                textAnchor="end"
                fontSize={8}
                fill="hsl(var(--muted-foreground))"
              >
                {band.level}%
              </text>
            ))}
            {/* Projected exam-day value — the glide path's destination, clearly
                labeled so the forecast lands on a number. */}
            <circle
              cx={xScale(examT)}
              cy={yScale(projection.score)}
              r={4}
              fill="hsl(var(--primary))"
              stroke="hsl(var(--card))"
              strokeWidth={1.5}
            />
            <text
              x={xScale(examT) - 6}
              y={yScale(projection.score) - 6}
              textAnchor="end"
              fontSize={11}
              fontWeight={700}
              fill="hsl(var(--primary))"
              className="tabular-nums"
            >
              ~{Math.round(projection.score)}
            </text>
          </>
        )}

        {/* Exam-date marker */}
        {examT && (
          <>
            <Bar
              x={xScale(examT) - 0.5}
              y={0}
              width={1}
              height={innerH}
              fill="hsl(var(--destructive))"
              opacity={0.7}
            />
            <text
              x={xScale(examT)}
              y={-2}
              textAnchor="end"
              fontSize={9}
              fill="hsl(var(--destructive))"
            >
              exam
            </text>
          </>
        )}

        {priorParsed.length > 0 && (
          <LinePath
            data={priorParsed}
            x={(d) => xScale(d.t.getTime()) ?? 0}
            y={(d) => yScale(d.score) ?? 0}
            stroke="hsl(var(--muted-foreground))"
            strokeWidth={1.5}
            strokeDasharray="4,4"
            curve={curveMonotoneX}
          />
        )}

        {brushRect && (
          <rect
            x={Math.min(brushRect.x0, brushRect.x1)}
            y={0}
            width={Math.abs(brushRect.x1 - brushRect.x0)}
            height={innerH}
            fill="hsl(var(--primary))"
            opacity={0.12}
          />
        )}

        {/* Glide-path gradient fill under the actual trend (hero treatment). */}
        <LinearGradient
          id={gradId}
          from="hsl(var(--primary))"
          to="hsl(var(--primary))"
          fromOpacity={0.28}
          toOpacity={0.02}
          vertical
        />
        <AreaClosed
          data={parsed}
          x={(d) => xScale(d.t.getTime()) ?? 0}
          y={(d) => yScale(d.score) ?? 0}
          yScale={yScale}
          fill={`url(#${gradId})`}
          curve={curveMonotoneX}
        />

        {/* Actual series — R9 §6: traces in on mount via pathLength + the
            `draw-on` keyframe, stilled under prefers-reduced-motion. */}
        <LinePath
          data={parsed}
          x={(d) => xScale(d.t.getTime()) ?? 0}
          y={(d) => yScale(d.score) ?? 0}
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          curve={curveMonotoneX}
          pathLength={reduce ? undefined : 1}
          strokeDasharray={reduce ? undefined : 1}
          className={reduce ? undefined : "animate-draw-on"}
        />
        {parsed.map((d, i) => (
          <circle
            key={i}
            cx={xScale(d.t.getTime())}
            cy={yScale(d.score)}
            r={2.5}
            fill="hsl(var(--primary))"
          />
        ))}

        {/* Last actual point — the glide path's launch, labeled so "where you
            are now" is unmistakable next to the projected destination. */}
        <circle
          cx={xScale(last.t.getTime())}
          cy={yScale(last.score)}
          r={4.5}
          fill="hsl(var(--primary))"
          stroke="hsl(var(--card))"
          strokeWidth={2}
        />
        <text
          x={xScale(last.t.getTime())}
          y={yScale(last.score) - 8}
          textAnchor={examT ? "middle" : "end"}
          fontSize={11}
          fontWeight={700}
          fill="hsl(var(--foreground))"
          className="tabular-nums"
        >
          {last.score}
        </text>

        {/* R9 §2 — milestone pins (personal-best / improving / biggest jump).
            Suppressed while brushing so they don't fight the selection rect. */}
        {!brushRect &&
          annotations.map((a) => {
            const p = parsed[a.index];
            if (!p) return null;
            return (
              <ChartAnnotation
                key={`${a.label}-${a.index}`}
                x={xScale(p.t.getTime())}
                y={yScale(p.score)}
                label={a.label}
                tone={a.tone}
                innerW={innerW}
              />
            );
          })}

        {/* Hover crosshair + value readout (independent of the drag-brush). */}
        {hoverPoint && (
          <Group>
            <ReferenceLine
              orientation="vertical"
              at={xScale(hoverPoint.t.getTime())}
              length={innerH}
              stroke="hsl(var(--foreground))"
              dash="2,3"
              opacity={0.35}
              strokeWidth={1}
            />
            <circle
              cx={xScale(hoverPoint.t.getTime())}
              cy={yScale(hoverPoint.score)}
              r={4}
              fill="hsl(var(--card))"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
            />
            <g
              transform={`translate(${Math.min(
                Math.max(xScale(hoverPoint.t.getTime()) - 30, 0),
                Math.max(0, innerW - 60),
              )}, 2)`}
            >
              <rect
                width={60}
                height={28}
                rx={6}
                fill="hsl(var(--popover))"
                stroke="hsl(var(--border))"
              />
              <text x={6} y={12} fontSize={9} fill="hsl(var(--muted-foreground))">
                {hoverPoint.date.slice(5, 10)}
              </text>
              <text
                x={6}
                y={23}
                fontSize={11}
                fontWeight={700}
                fill="hsl(var(--popover-foreground))"
                className="tabular-nums"
              >
                {hoverPoint.score}
              </text>
            </g>
          </Group>
        )}

        <AxisLeft
          scale={yScale}
          numTicks={4}
          stroke={AXIS_COLOR}
          tickStroke={AXIS_COLOR}
          tickLabelProps={() => ({ fill: AXIS_COLOR, fontSize: 9, dx: -2 })}
        />
        <AxisBottom
          top={innerH}
          scale={xScale}
          numTicks={4}
          stroke={AXIS_COLOR}
          tickStroke={AXIS_COLOR}
          tickLabelProps={() => ({ fill: AXIS_COLOR, fontSize: 9, textAnchor: "middle" })}
        />

        <rect
          x={0}
          y={0}
          width={innerW}
          height={innerH}
          fill="transparent"
          onMouseDown={(e) => {
            const x = e.nativeEvent.offsetX - MARGIN.left;
            setDrag({ x0: x, x1: x });
          }}
          onMouseMove={(e) => {
            const x = e.nativeEvent.offsetX - MARGIN.left;
            // Crosshair tracks hover even when not dragging; drag-brush still
            // owns the selection rect while the button is down.
            setHoverIdx(nearestIdx(x));
            if (!drag) return;
            setDrag({ x0: drag.x0, x1: x });
          }}
          onMouseUp={(e) => {
            if (!drag) return;
            const x = e.nativeEvent.offsetX - MARGIN.left;
            finishBrush(drag.x0, x);
            setDrag(null);
          }}
          onMouseLeave={() => setHoverIdx(null)}
        />
      </Group>
    </svg>
  );
}

/** visx line chart with goal band, projection cone, and exam-date marker. */
export function TrendChart({ height = 220, className, ...rest }: TrendChartProps) {
  return (
    <div className={className} style={{ width: "100%", height }}>
      <ParentSize>
        {({ width }) => <Inner width={width} height={height} {...rest} />}
      </ParentSize>
    </div>
  );
}
