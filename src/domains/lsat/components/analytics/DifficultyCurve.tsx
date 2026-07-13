import { useMemo } from "react";
import { useReducedMotion } from "motion/react";
import { Group } from "@visx/group";
import { scaleLinear } from "@visx/scale";
import { LinePath, AreaClosed } from "@visx/shape";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { GridRows } from "@visx/grid";
import { curveMonotoneX } from "@visx/curve";
import { ParentSize } from "@visx/responsive";
import { useTooltip, useTooltipInPortal } from "@visx/tooltip";
import { chartTooltipStyle } from "@lsat/components/viz";
import type { DifficultyRow } from "@lsat/lib/types";

export interface DifficultyCurveProps {
  rows: DifficultyRow[];
  height?: number;
}

const MARGIN = { top: 12, right: 16, bottom: 40, left: 44 };
const AXIS = "hsl(var(--muted-foreground))";

function Inner({
  rows,
  width,
  height,
}: {
  rows: DifficultyRow[];
  width: number;
  height: number;
}) {
  const reduce = useReducedMotion();
  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = Math.max(0, height - MARGIN.top - MARGIN.bottom);

  const data = useMemo(
    () => [...rows].sort((a, b) => a.difficulty - b.difficulty),
    [rows],
  );

  const x = scaleLinear({ domain: [0.5, 5.5], range: [0, innerW] });
  const y = scaleLinear({ domain: [0, 1], range: [innerH, 0] });
  const maxAttempts = Math.max(1, ...data.map((d) => d.attempts));
  const r = scaleLinear({ domain: [0, maxAttempts], range: [3, 11] });

  const {
    tooltipData,
    tooltipLeft,
    tooltipTop,
    tooltipOpen,
    showTooltip,
    hideTooltip,
  } = useTooltip<DifficultyRow>();
  const { containerRef, TooltipInPortal } = useTooltipInPortal({
    detectBounds: true,
    scroll: true,
  });

  if (!data.length || innerW <= 0) return null;

  return (
    <div ref={containerRef} className="relative">
      <svg width={width} height={height} role="img" aria-label="Accuracy by difficulty">
        <Group left={MARGIN.left} top={MARGIN.top}>
          <GridRows scale={y} width={innerW} numTicks={4} stroke="hsl(var(--border))" strokeOpacity={0.6} />
          <AreaClosed
            data={data}
            x={(d) => x(d.difficulty)}
            y={(d) => y(d.accuracy)}
            yScale={y}
            fill="hsl(var(--primary))"
            fillOpacity={0.1}
            curve={curveMonotoneX}
          />
          {/* R9 §6 — trace the curve in on mount; stilled under reduced motion. */}
          <LinePath
            data={data}
            x={(d) => x(d.difficulty)}
            y={(d) => y(d.accuracy)}
            stroke="hsl(var(--primary))"
            strokeWidth={2}
            curve={curveMonotoneX}
            pathLength={reduce ? undefined : 1}
            strokeDasharray={reduce ? undefined : 1}
            className={reduce ? undefined : "animate-draw-on"}
          />
          {data.map((d) => (
            <circle
              key={d.difficulty}
              cx={x(d.difficulty)}
              cy={y(d.accuracy)}
              r={r(d.attempts)}
              fill="hsl(var(--primary))"
              fillOpacity={0.85}
              stroke="hsl(var(--background))"
              strokeWidth={1.5}
              onMouseMove={(e) => {
                const rect = (
                  e.currentTarget.ownerSVGElement?.parentElement as HTMLElement
                ).getBoundingClientRect();
                showTooltip({
                  tooltipData: d,
                  tooltipLeft: e.clientX - rect.left,
                  tooltipTop: e.clientY - rect.top,
                });
              }}
              onMouseLeave={hideTooltip}
            >
              {/* a11y / no-JS fallback mirroring the tooltip copy. */}
              <title>{`Difficulty ${d.difficulty}/5 — ${Math.round(d.accuracy * 100)}% over ${d.attempts} attempts`}</title>
            </circle>
          ))}
          <AxisLeft
            scale={y}
            numTicks={4}
            tickFormat={(v) => `${Math.round(Number(v) * 100)}%`}
            stroke={AXIS}
            tickStroke={AXIS}
            tickLabelProps={() => ({ fill: AXIS, fontSize: 9, dx: -2 })}
          />
          <AxisBottom
            top={innerH}
            scale={x}
            tickValues={[1, 2, 3, 4, 5]}
            tickFormat={(v) => "★".repeat(Number(v))}
            stroke={AXIS}
            tickStroke={AXIS}
            tickLabelProps={() => ({ fill: AXIS, fontSize: 10, textAnchor: "middle" })}
          />
          {/* R9 §8 — axis titles so the dimensions read without the legend. */}
          <text
            x={innerW / 2}
            y={innerH + 34}
            textAnchor="middle"
            fontSize={9}
            fill={AXIS}
          >
            Item difficulty (★) · point size = volume
          </text>
          <text
            transform={`translate(${-34}, ${innerH / 2}) rotate(-90)`}
            textAnchor="middle"
            fontSize={9}
            fill={AXIS}
          >
            Accuracy
          </text>
        </Group>
      </svg>
      {tooltipOpen && tooltipData && (
        <TooltipInPortal left={tooltipLeft} top={tooltipTop} style={chartTooltipStyle}>
          <div className="font-medium">Difficulty {"★".repeat(tooltipData.difficulty)}</div>
          <div className="tabular-nums">{Math.round(tooltipData.accuracy * 100)}% accuracy</div>
          <div className="tabular-nums text-muted-foreground">
            {tooltipData.attempts} attempts · {Math.round(tooltipData.avg_time_ms / 1000)}s avg
          </div>
          {/* Micro-narrative: how this difficulty band reads at a glance. */}
          <div className="mt-1 max-w-[22ch] text-muted-foreground">
            {tooltipData.accuracy >= 0.8
              ? "Comfortable at this level."
              : tooltipData.accuracy >= 0.55
                ? "Holding, but not automatic."
                : "A reliable miss zone — drill here."}
          </div>
        </TooltipInPortal>
      )}
    </div>
  );
}

/** §3.6 — accuracy-vs-difficulty curve; points sized by volume (visx). */
export function DifficultyCurve({ rows, height = 240 }: DifficultyCurveProps) {
  return (
    <div style={{ width: "100%", height }}>
      <ParentSize>
        {({ width }) => <Inner rows={rows} width={width} height={height} />}
      </ParentSize>
    </div>
  );
}
