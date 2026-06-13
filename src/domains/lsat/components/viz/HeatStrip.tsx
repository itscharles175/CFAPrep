import { memo, useMemo } from "react";
import { scaleLinear } from "d3-scale";
import { Check, X } from "lucide-react";
import { useTooltip, useTooltipInPortal } from "@visx/tooltip";
import { cn } from "@lsat/lib/utils";
import { useChartScales } from "@lsat/lib/chartTheme";
import { chartTooltipStyle, ColorScaleKey } from "./chart-kit";

export interface HeatCell {
  /** Numeric value driving the color (e.g. time spent in ms or seconds). */
  value: number;
  /** Whether the item was answered correctly (renders a mark). */
  correct?: boolean;
  /** Optional label for the tooltip (e.g. "Q3"). */
  label?: string;
}

export interface HeatStripProps {
  cells: HeatCell[];
  /** "viridis" (accuracy/time) or "inferno" (pressure heat). */
  ramp?: "viridis" | "inferno";
  /** Override domain; otherwise computed from data. */
  domain?: [number, number];
  cellSize?: number;
  gap?: number;
  /** Show the continuous colour-scale legend (default true). */
  showScaleKey?: boolean;
  /** Labels for the low/high ends of the scale key. */
  scaleLabels?: { low: string; high: string };
  className?: string;
}

/** A row of per-question cells colored by value, with correct/incorrect marks. */
function HeatStripImpl({
  cells,
  ramp = "viridis",
  domain,
  cellSize = 26,
  gap = 3,
  showScaleKey = true,
  scaleLabels,
  className,
}: HeatStripProps) {
  const scales = useChartScales();
  // Theme-aware ramp: never collides with the active background, and the t∈[0,1]
  // colour fn is reused for the scale-key legend below.
  const rampColor = useMemo(
    () => scales.rampColor(ramp),
    [scales, ramp],
  );
  const color = useMemo(() => {
    const vals = cells.map((c) => c.value);
    const dom = domain ?? [Math.min(...vals), Math.max(...vals)];
    const t = scaleLinear().domain(dom).range([0, 1]).clamp(true);
    return (v: number) => rampColor(t(v));
  }, [cells, domain, rampColor]);

  const {
    tooltipData,
    tooltipLeft,
    tooltipTop,
    tooltipOpen,
    showTooltip,
    hideTooltip,
  } = useTooltip<HeatCell & { index: number }>();
  const { containerRef, TooltipInPortal } = useTooltipInPortal({
    detectBounds: true,
    scroll: true,
  });

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <div className="flex flex-wrap" style={{ gap }}>
        {cells.map((c, i) => {
          const bg = color(c.value);
          // Pick the mark ink from the cell's own luminance so ✓/✕ stay legible
          // on any swatch in any theme (replaces the old #fff/#111 guess).
          const ink = scales.inkFor(bg);
          return (
            <div
              key={i}
              role="img"
              aria-label={`${c.label ?? `#${i + 1}`}: ${c.value}${c.correct === undefined ? "" : c.correct ? ", correct" : ", incorrect"}`}
              className="flex items-center justify-center rounded-sm"
              style={{ width: cellSize, height: cellSize, backgroundColor: bg }}
              onMouseMove={(e) => {
                const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                showTooltip({
                  tooltipData: { ...c, index: i },
                  tooltipLeft: e.clientX - rect.left,
                  tooltipTop: e.clientY - rect.top,
                });
              }}
              onMouseLeave={hideTooltip}
            >
              {c.correct === true && (
                <Check className="h-3 w-3" style={{ color: ink }} />
              )}
              {c.correct === false && (
                <X className="h-3 w-3" style={{ color: ink }} />
              )}
            </div>
          );
        })}
      </div>
      {showScaleKey && cells.length > 0 && (
        <ColorScaleKey
          className="mt-2"
          colorAt={(t) => rampColor(t)}
          lowLabel={scaleLabels?.low ?? "low"}
          highLabel={scaleLabels?.high ?? "high"}
        />
      )}
      {tooltipOpen && tooltipData && (
        <TooltipInPortal
          left={tooltipLeft}
          top={tooltipTop}
          style={chartTooltipStyle}
        >
          <div className="font-medium">{tooltipData.label ?? `#${tooltipData.index + 1}`}</div>
          <div className="text-muted-foreground">value: {tooltipData.value}</div>
          {tooltipData.correct !== undefined && (
            <div>{tooltipData.correct ? "Correct" : "Incorrect"}</div>
          )}
        </TooltipInPortal>
      )}
    </div>
  );
}

// A2.4 — memoized: the per-cell color scale only needs to recompute when the
// cells/ramp/domain change, not on every re-render of the Timing tab.
export const HeatStrip = memo(HeatStripImpl);
HeatStrip.displayName = "HeatStrip";
