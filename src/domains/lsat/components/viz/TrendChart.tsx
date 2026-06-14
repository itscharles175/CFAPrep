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
import {
  LiveRegion,
  useThrottledAnnouncement,
} from "@lsat/components/question/live-region";

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

/**
 * UC5 — spoken date for the live region. Reuses the chart's ISO `date` strings
 * but reads them as a friendly "Jan 5" rather than "2024-01-05" so the
 * announcement isn't a string of digits. Falls back to the raw string if the
 * date can't be parsed.
 */
function spokenDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** UC5 — "point 3 of 8, Jan 5, score 165" for a focused/hovered datum. */
function pointAnnouncement(
  datum: TrendDatum,
  index: number,
  total: number,
): string {
  return `Point ${index + 1} of ${total}, ${spokenDate(datum.date)}, score ${datum.score}`;
}

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
  // UC5 — keyboard data-point cursor into `parsed`. Driven by arrow/home/end
  // keys while the chart is focused; null until the user steps in. Separate from
  // the mouse hover so the two input modes never fight each other.
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  // UC5 — the message most recently set for the live region. Re-set (even to the
  // same text) re-announces via useThrottledAnnouncement's nonce trick.
  const [announce, setAnnounce] = useState<string | null>(null);
  const liveMessage = useThrottledAnnouncement(announce);
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
        // UC5 — speak the cleared selection so a SR user knows the brush reset.
        setAnnounce("Selection cleared");
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
        // UC5 — summarise the brushed range (point count + score span) for the
        // live region so the selection isn't a purely visual affordance.
        const scores = inBrush.map((d) => d.score);
        const lo = Math.min(...scores);
        const hi = Math.max(...scores);
        const span = lo === hi ? `score ${lo}` : `scores ${lo} to ${hi}`;
        setAnnounce(
          `Selected ${inBrush.length} ${inBrush.length === 1 ? "point" : "points"}, ` +
            `${spokenDate(inBrush[0].date)} to ${spokenDate(inBrush[inBrush.length - 1].date)}, ${span}`,
        );
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

  // UC5 — the datum a keyboard user has stepped onto. Drawn with a visible focus
  // ring and announced via the live region. Independent of the mouse `hoverIdx`.
  const focusPoint =
    focusIdx != null ? parsed[Math.min(focusIdx, parsed.length - 1)] : undefined;

  /** UC5 — move the keyboard cursor to `next`, clamp, and announce the datum. */
  const moveFocus = (next: number) => {
    const clamped = Math.max(0, Math.min(parsed.length - 1, next));
    setFocusIdx(clamped);
    setAnnounce(pointAnnouncement(parsed[clamped], clamped, parsed.length));
  };

  /** UC5 — arrow / home / end navigation across the series' data points. */
  const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
    // Start from the current keyboard cursor, falling back to the hovered
    // point, then the last point so the first keypress lands somewhere sensible.
    const from = focusIdx ?? hoverIdx ?? parsed.length - 1;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowUp":
        e.preventDefault();
        moveFocus(from + 1);
        break;
      case "ArrowLeft":
      case "ArrowDown":
        e.preventDefault();
        moveFocus(from - 1);
        break;
      case "Home":
        e.preventDefault();
        moveFocus(0);
        break;
      case "End":
        e.preventDefault();
        moveFocus(parsed.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <>
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={`Score trend, ${parsed.length} data points. Use arrow keys to step through points; home and end jump to the first and last.`}
      tabIndex={0}
      className="select-none focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      onMouseLeave={() => drag && finishBrush(drag.x0, drag.x1)}
      onKeyDown={onKeyDown}
      onFocus={() => {
        // Surface the current point the moment the chart receives focus so a SR
        // user hears where they are before pressing a key. Default to the last
        // (most recent) point when stepping in fresh.
        const idx = focusIdx ?? parsed.length - 1;
        setFocusIdx(idx);
        setAnnounce(pointAnnouncement(parsed[idx], idx, parsed.length));
      }}
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

        {/* UC5 — visible keyboard focus marker: a token-colored ring on the
            datum the arrow keys have landed on. The ring eases between points
            (transition on cx/cy) unless the user prefers reduced motion, in
            which case it snaps. aria-hidden — the spoken value comes from the
            live region, not this SVG node. */}
        {focusPoint && (
          <circle
            cx={xScale(focusPoint.t.getTime())}
            cy={yScale(focusPoint.score)}
            r={6}
            fill="none"
            stroke="hsl(var(--ring))"
            strokeWidth={2}
            aria-hidden
            className={reduce ? undefined : "transition-[cx,cy] duration-150 ease-out"}
          />
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
            const idx = nearestIdx(x);
            // UC5 — announce the point under the cursor, but only when the
            // hovered datum actually changes (not every pixel of movement) and
            // not mid-drag (the brush summary speaks instead).
            if (!drag && idx !== hoverIdx) {
              setAnnounce(pointAnnouncement(parsed[idx], idx, parsed.length));
            }
            setHoverIdx(idx);
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
    {/* UC5 — polite live region: speaks the focused/hovered point and brush
        range summaries to screen-reader users. Visually hidden (.sr-only). */}
    <LiveRegion message={liveMessage} />
    </>
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
