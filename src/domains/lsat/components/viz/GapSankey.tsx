import { memo } from "react";
import { useTooltip, useTooltipInPortal } from "@visx/tooltip";
import { cn } from "@lsat/lib/utils";
import { chartTooltipStyle } from "./chart-kit";

export interface GapSankeyCounts {
  /** timed correct → BR correct (mastered). */
  timed_ok: number;
  /** timed correct → BR wrong (lucky guess). */
  lucky: number;
  /** timed wrong → BR wrong (understanding gap). */
  concept_gap: number;
  /** timed wrong → BR correct (timing/pressure problem). */
  timing_problem: number;
}

export interface GapSankeyProps {
  counts: GapSankeyCounts;
  height?: number;
  className?: string;
}

const FLOW_COLOR: Record<keyof GapSankeyCounts, string> = {
  timed_ok: "hsl(var(--success))",
  timing_problem: "hsl(var(--warning))",
  concept_gap: "hsl(var(--destructive))",
  lucky: "hsl(var(--info))",
};
const FLOW_LABEL: Record<keyof GapSankeyCounts, string> = {
  timed_ok: "Mastered",
  timing_problem: "Timing problem",
  concept_gap: "Understanding gap",
  lucky: "Lucky guess",
};
// R9 §8 — one-line micro-narrative per flow, surfaced in the tooltip.
const FLOW_NARRATIVE: Record<keyof GapSankeyCounts, string> = {
  timed_ok: "Right under the clock and again on review — solid.",
  timing_problem: "Missed timed, fixed on review — pacing, not understanding.",
  concept_gap: "Wrong both times — a real concept gap to drill.",
  lucky: "Right under pressure but wrong on review — a lucky guess.",
};

/**
 * B5 — blind-review gap Sankey. Flows timed outcome (left) → blind-review
 * outcome (right), splitting every attempt into mastered / timing problem /
 * understanding gap / lucky. Width ∝ count.
 */
function GapSankeyImpl({ counts, height = 220, className }: GapSankeyProps) {
  const total =
    counts.timed_ok + counts.lucky + counts.concept_gap + counts.timing_problem;
  const width = 520;
  const padY = 18;
  const usableH = height - padY * 2;
  const nodeW = 12;
  const leftX = 96;
  const rightX = width - 96 - nodeW;
  const midX = (leftX + nodeW + rightX) / 2;

  const {
    tooltipData,
    tooltipLeft,
    tooltipTop,
    tooltipOpen,
    showTooltip,
    hideTooltip,
  } = useTooltip<keyof GapSankeyCounts>();
  const { containerRef, TooltipInPortal } = useTooltipInPortal({
    detectBounds: true,
    scroll: true,
  });

  if (total === 0) return null;
  const h = (n: number) => (n / total) * usableH;
  const pctOf = (n: number) => Math.round((n / total) * 100);

  // Left node spans (timed correct on top, timed wrong below).
  const lCorrectH = h(counts.timed_ok + counts.lucky);
  const lWrongH = h(counts.timing_problem + counts.concept_gap);
  const gapBetween = 14;
  const lCorrectY = padY;
  const lWrongY = padY + lCorrectH + gapBetween;

  // Right node spans (BR correct on top, BR wrong below).
  const rCorrectH = h(counts.timed_ok + counts.timing_problem);
  const rWrongH = h(counts.lucky + counts.concept_gap);
  const rCorrectY = padY;
  const rWrongY = padY + rCorrectH + gapBetween;

  // Running offsets so ribbons stack inside each node without crossing.
  let lCorrectOff = lCorrectY;
  let lWrongOff = lWrongY;
  let rCorrectOff = rCorrectY;
  let rWrongOff = rWrongY;

  type FlowKey = keyof GapSankeyCounts;
  // Draw order keeps source/target stacking consistent (top→bottom).
  const flows: { key: FlowKey; from: "correct" | "wrong"; to: "correct" | "wrong" }[] = [
    { key: "timed_ok", from: "correct", to: "correct" },
    { key: "lucky", from: "correct", to: "wrong" },
    { key: "timing_problem", from: "wrong", to: "correct" },
    { key: "concept_gap", from: "wrong", to: "wrong" },
  ];

  const ribbons = flows.map(({ key, from, to }) => {
    const band = h(counts[key]);
    const sy0 = from === "correct" ? lCorrectOff : lWrongOff;
    const ty0 = to === "correct" ? rCorrectOff : rWrongOff;
    const sy1 = sy0 + band;
    const ty1 = ty0 + band;
    if (from === "correct") lCorrectOff = sy1;
    else lWrongOff = sy1;
    if (to === "correct") rCorrectOff = ty1;
    else rWrongOff = ty1;
    const sx = leftX + nodeW;
    const tx = rightX;
    const d = [
      `M ${sx},${sy0}`,
      `C ${midX},${sy0} ${midX},${ty0} ${tx},${ty0}`,
      `L ${tx},${ty1}`,
      `C ${midX},${ty1} ${midX},${sy1} ${sx},${sy1}`,
      "Z",
    ].join(" ");
    return { key, d, band, count: counts[key] };
  });

  const NODE = "hsl(var(--foreground))";

  return (
    <div ref={containerRef} className={cn("relative w-full overflow-x-auto", className)}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Timed to blind-review outcome flow"
      >
        {/* Ribbons — R9 §8: kit tooltip on hover, <title> kept as a11y fallback. */}
        {ribbons.map((r) => (
          <path
            key={r.key}
            d={r.d}
            fill={FLOW_COLOR[r.key]}
            fillOpacity={tooltipData === r.key ? 0.7 : 0.45}
            className="cursor-default transition-[fill-opacity]"
            onMouseMove={(e) => {
              const host = (e.currentTarget.closest("[class*='relative']") ??
                e.currentTarget.ownerSVGElement?.parentElement) as HTMLElement | null;
              const rect = host?.getBoundingClientRect();
              showTooltip({
                tooltipData: r.key,
                tooltipLeft: e.clientX - (rect?.left ?? 0),
                tooltipTop: e.clientY - (rect?.top ?? 0),
              });
            }}
            onMouseLeave={hideTooltip}
          >
            <title>{`${FLOW_LABEL[r.key]}: ${r.count}`}</title>
          </path>
        ))}

        {/* Left nodes */}
        <rect x={leftX} y={lCorrectY} width={nodeW} height={lCorrectH} fill={NODE} rx={2} />
        <rect x={leftX} y={lWrongY} width={nodeW} height={lWrongH} fill={NODE} rx={2} />
        {/* Right nodes */}
        <rect x={rightX} y={rCorrectY} width={nodeW} height={rCorrectH} fill={NODE} rx={2} />
        <rect x={rightX} y={rWrongY} width={nodeW} height={rWrongH} fill={NODE} rx={2} />

        {/* Node labels */}
        <text x={leftX - 6} y={lCorrectY + lCorrectH / 2} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="hsl(var(--muted-foreground))">Timed ✓</text>
        <text x={leftX - 6} y={lWrongY + lWrongH / 2} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="hsl(var(--muted-foreground))">Timed ✕</text>
        <text x={rightX + nodeW + 6} y={rCorrectY + rCorrectH / 2} textAnchor="start" dominantBaseline="middle" fontSize={11} fill="hsl(var(--muted-foreground))">BR ✓</text>
        <text x={rightX + nodeW + 6} y={rWrongY + rWrongH / 2} textAnchor="start" dominantBaseline="middle" fontSize={11} fill="hsl(var(--muted-foreground))">BR ✕</text>
      </svg>
      {tooltipOpen && tooltipData && (
        <TooltipInPortal left={tooltipLeft} top={tooltipTop} style={chartTooltipStyle}>
          <div className="font-medium">{FLOW_LABEL[tooltipData]}</div>
          <div className="tabular-nums text-muted-foreground">
            {counts[tooltipData]} attempts · {pctOf(counts[tooltipData])}%
          </div>
          <div className="mt-1 max-w-[24ch] text-muted-foreground">
            {FLOW_NARRATIVE[tooltipData]}
          </div>
        </TooltipInPortal>
      )}
      {/* Legend */}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-2xs">
        {(Object.keys(FLOW_LABEL) as (keyof GapSankeyCounts)[]).map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-sm"
              style={{ background: FLOW_COLOR[k] }}
              aria-hidden
            />
            <span className="text-muted-foreground">
              {FLOW_LABEL[k]} · {counts[k]}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

// A2.4 — memoized: the ribbon geometry only depends on `counts`/`height`, so a
// Gap-tab re-render shouldn't recompute it unless those change.
export const GapSankey = memo(GapSankeyImpl);
GapSankey.displayName = "GapSankey";
