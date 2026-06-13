import { useMemo } from "react";
import { scaleLinear } from "d3-scale";
import { useTooltip, useTooltipInPortal } from "@visx/tooltip";
import { cn } from "@lsat/lib/utils";
import { useChartScales } from "@lsat/lib/chartTheme";
import { chartTooltipStyle, ColorScaleKey } from "./chart-kit";

export interface ContributionDay {
  /** ISO date (YYYY-MM-DD). */
  date: string;
  value: number;
}

export interface ContributionHeatmapProps {
  data: ContributionDay[];
  /** Number of trailing weeks to render (default 26 ≈ half a year). */
  weeks?: number;
  cellSize?: number;
  gap?: number;
  /** Show the continuous colour-scale legend (default true). */
  showScaleKey?: boolean;
  className?: string;
}

const DAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** GitHub-style calendar grid (weeks × days) colored by activity. */
export function ContributionHeatmap({
  data,
  weeks = 26,
  cellSize = 13,
  gap = 3,
  showScaleKey = true,
  className,
}: ContributionHeatmapProps) {
  const scales = useChartScales();
  // Theme-aware viridis; the same normalised colour fn feeds the scale key.
  const rampColor = useMemo(() => scales.rampColor("viridis"), [scales]);
  const emptyColor = scales.emptyCellColor;
  const { grid, maxV, color, isTop } = useMemo(() => {
    const map = new Map(data.map((d) => [d.date, d.value]));
    const today = startOfDay(new Date());
    // Find the Sunday that begins the leftmost column.
    const totalDays = weeks * 7;
    const start = new Date(today);
    start.setDate(start.getDate() - (totalDays - 1));
    // back up to Sunday
    start.setDate(start.getDate() - start.getDay());

    const cols: { date: Date; key: string; value: number }[][] = [];
    const cur = new Date(start);
    while (cur <= today) {
      const col: { date: Date; key: string; value: number }[] = [];
      for (let d = 0; d < 7; d++) {
        const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
        col.push({ date: new Date(cur), key, value: map.get(key) ?? 0 });
        cur.setDate(cur.getDate() + 1);
      }
      cols.push(col);
    }
    const mx = Math.max(1, ...data.map((d) => d.value));
    // Keep a small floor (0.15) so the lightest active day still separates from
    // the empty-cell token; the ramp itself is already theme-safe.
    const t = scaleLinear().domain([0, mx]).range([0.15, 1]).clamp(true);
    const col = (v: number) => (v === 0 ? emptyColor : rampColor(t(v)));
    // "Top tier" = at least 75% of the busiest day.
    const topTier = (v: number) => v > 0 && v >= mx * 0.75;
    return { grid: cols, maxV: mx, color: col, isTop: topTier };
  }, [data, weeks, rampColor, emptyColor]);

  const {
    tooltipData,
    tooltipLeft,
    tooltipTop,
    tooltipOpen,
    showTooltip,
    hideTooltip,
  } = useTooltip<{ key: string; value: number }>();
  const { containerRef, TooltipInPortal } = useTooltipInPortal({
    detectBounds: true,
    scroll: true,
  });

  const step = cellSize + gap;
  // CSS hatch for the busiest tier — a colourblind-redundant cue so the heaviest
  // days read without relying on hue. The grid is divs (not SVG), so we hatch
  // with a repeating gradient rather than an SVG <pattern>.
  // R11 1.5 — a DARK hatch (was fixed white, invisible on light themes). The
  // busiest tier is always a bright viridis high-end cell in every theme, so a
  // dark hatch reads as the colourblind-redundant cue across all 4 themes.
  const hatch =
    "repeating-linear-gradient(45deg, rgba(0,0,0,0.4) 0 1px, transparent 1px 3px)";

  return (
    <div className={cn("inline-flex flex-col gap-2", className)}>
      <div ref={containerRef} data-heatmap-root className="relative inline-flex gap-1">
        {/* day-of-week labels */}
        <div className="flex flex-col" style={{ gap, paddingTop: 0 }}>
          {DAY_LABELS.map((l, i) => (
            <div
              key={i}
              className="text-[9px] leading-none text-muted-foreground"
              style={{ height: cellSize, lineHeight: `${cellSize}px` }}
            >
              {l}
            </div>
          ))}
        </div>
        <div className="flex" style={{ gap }}>
          {grid.map((col, ci) => (
            <div key={ci} className="flex flex-col" style={{ gap }}>
              {col.map((cell) => (
                <div
                  key={cell.key}
                  className="rounded-[2px]"
                  style={{
                    width: cellSize,
                    height: cellSize,
                    backgroundColor: color(cell.value),
                    backgroundImage: isTop(cell.value) ? hatch : undefined,
                  }}
                  onMouseMove={(e) => {
                    const host = e.currentTarget.closest("[data-heatmap-root]") as HTMLElement | null;
                    const rect = host?.getBoundingClientRect();
                    showTooltip({
                      tooltipData: { key: cell.key, value: cell.value },
                      tooltipLeft: e.clientX - (rect?.left ?? 0),
                      tooltipTop: e.clientY - (rect?.top ?? 0),
                    });
                  }}
                  onMouseLeave={hideTooltip}
                  aria-label={`${cell.key}: ${cell.value}`}
                />
              ))}
            </div>
          ))}
        </div>
        {tooltipOpen && tooltipData && (
          <TooltipInPortal
            left={tooltipLeft}
            top={tooltipTop}
            style={chartTooltipStyle}
          >
            <div className="font-medium">{tooltipData.value} activity</div>
            <div className="text-muted-foreground">{tooltipData.key}</div>
          </TooltipInPortal>
        )}
        {/* keep maxV referenced for legend-less builds */}
        <span className="sr-only">max {maxV} per day, {step}px step</span>
      </div>
      {showScaleKey && (
        <ColorScaleKey
          colorAt={(t) => rampColor(t)}
          lowLabel="quiet"
          highLabel="busy"
          zeroLabel="none"
          zeroColor={emptyColor}
        />
      )}
    </div>
  );
}
