import { Flag } from "lucide-react";
import { useTooltip, useTooltipInPortal } from "@visx/tooltip";
import { cn } from "@/lib/utils";
import { chartTooltipStyle } from "./chart-kit";

export interface FocusEvent {
  order: number;
  seconds: number;
  flagged: boolean;
  correct: boolean;
  /** Timed-wrong but corrected on blind review (a focus/pacing lapse). */
  brCorrected: boolean;
}

export interface FocusTimelineProps {
  events: FocusEvent[];
  /** Target seconds per question — dashed reference line. */
  target?: number;
  height?: number;
  className?: string;
}

const MARGIN = { top: 16, right: 10, bottom: 20, left: 30 };

/**
 * B4 — single-session focus timeline. Each question is a bar (height = seconds
 * spent); color encodes outcome (correct / BR-corrected lapse / missed); a flag
 * marker sits above questions the user flagged. The dashed line is the target
 * pace. (Answer-changes & idle pauses aren't tracked locally, so they're
 * omitted rather than faked.)
 */
export function FocusTimeline({
  events,
  target,
  height = 150,
  className,
}: FocusTimelineProps) {
  const {
    tooltipData,
    tooltipLeft,
    tooltipTop,
    tooltipOpen,
    showTooltip,
    hideTooltip,
  } = useTooltip<FocusEvent>();
  const { containerRef, TooltipInPortal } = useTooltipInPortal({
    detectBounds: true,
    scroll: true,
  });

  if (!events.length) return null;
  const width = Math.max(320, events.length * 16 + MARGIN.left + MARGIN.right);
  const innerH = height - MARGIN.top - MARGIN.bottom;
  const maxSec = Math.max(target ?? 0, ...events.map((e) => e.seconds), 1);
  const slotW = (width - MARGIN.left - MARGIN.right) / events.length;
  const barW = Math.max(3, slotW * 0.66);

  const color = (e: FocusEvent) =>
    e.correct
      ? "hsl(var(--success))"
      : e.brCorrected
        ? "hsl(var(--warning))"
        : "hsl(var(--destructive))";

  const outcome = (e: FocusEvent) =>
    e.correct ? "correct" : e.brCorrected ? "BR-corrected" : "missed";

  return (
    <div ref={containerRef} className={cn("relative w-full overflow-x-auto", className)}>
      <svg width={width} height={height} role="img" aria-label="Focus timeline">
        {/* Target pace line */}
        {target != null && target > 0 && (
          <g>
            <line
              x1={MARGIN.left}
              x2={width - MARGIN.right}
              y1={MARGIN.top + innerH - (target / maxSec) * innerH}
              y2={MARGIN.top + innerH - (target / maxSec) * innerH}
              stroke="hsl(var(--primary))"
              strokeDasharray="3,3"
              strokeOpacity={0.6}
            />
            <text
              x={MARGIN.left}
              y={MARGIN.top + innerH - (target / maxSec) * innerH - 2}
              fontSize={8}
              fill="hsl(var(--primary))"
            >
              {target}s
            </text>
          </g>
        )}
        {events.map((e, i) => {
          const x = MARGIN.left + i * slotW + (slotW - barW) / 2;
          const h = Math.max(1, (e.seconds / maxSec) * innerH);
          const y = MARGIN.top + innerH - h;
          return (
            <g key={e.order}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={h}
                rx={1.5}
                fill={color(e)}
                fillOpacity={tooltipData?.order === e.order ? 1 : 0.85}
                className="transition-[fill-opacity]"
                onMouseMove={(ev) => {
                  const host = ev.currentTarget.ownerSVGElement
                    ?.parentElement as HTMLElement | null;
                  const rect = host?.getBoundingClientRect();
                  showTooltip({
                    tooltipData: e,
                    tooltipLeft: ev.clientX - (rect?.left ?? 0),
                    tooltipTop: ev.clientY - (rect?.top ?? 0),
                  });
                }}
                onMouseLeave={hideTooltip}
              >
                {/* a11y / no-JS fallback mirroring the kit tooltip. */}
                <title>{`Q${e.order}: ${e.seconds}s · ${outcome(e)}${e.flagged ? " · flagged" : ""}`}</title>
              </rect>
              {e.flagged && (
                <g transform={`translate(${x + barW / 2 - 4}, ${y - 11})`}>
                  <Flag width={8} height={8} className="text-warning" fill="currentColor" />
                </g>
              )}
            </g>
          );
        })}
        {/* Baseline */}
        <line
          x1={MARGIN.left}
          x2={width - MARGIN.right}
          y1={MARGIN.top + innerH}
          y2={MARGIN.top + innerH}
          stroke="hsl(var(--border))"
        />
      </svg>
      {tooltipOpen && tooltipData && (
        <TooltipInPortal left={tooltipLeft} top={tooltipTop} style={chartTooltipStyle}>
          <div className="font-medium">
            Q{tooltipData.order}
            {tooltipData.flagged ? " · flagged" : ""}
          </div>
          <div className="tabular-nums text-muted-foreground">
            {tooltipData.seconds}s · {outcome(tooltipData)}
          </div>
          <div className="mt-1 max-w-[22ch] text-muted-foreground">
            {target != null && tooltipData.seconds > target * 1.5
              ? "Well over pace — a focus/triage candidate."
              : tooltipData.brCorrected
                ? "Recovered on review — a pressure lapse, not a gap."
                : tooltipData.correct
                  ? "Clean under the clock."
                  : "Missed — check the trap in review."}
          </div>
        </TooltipInPortal>
      )}
    </div>
  );
}
