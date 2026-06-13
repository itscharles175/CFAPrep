import { memo, useMemo, useState } from "react";
import { scaleLinear } from "d3-scale";
import { qTypeLabel } from "@/lib/labels";
import type { QType } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useChartScales } from "@/lib/chartTheme";
import { ChartTooltip } from "./chart-kit";

export interface GapRow {
  q_type: QType;
  /** 0..1 accuracy under timed conditions. */
  timed: number;
  /** 0..1 accuracy on blind review. */
  blindReview: number;
}

export interface GapDumbbellProps {
  rows: GapRow[];
  /** Prior-period overlay (dashed connectors, muted dots). */
  priorRows?: GapRow[];
  className?: string;
  rowHeight?: number;
}

const PAD_LEFT = 150;
const PAD_RIGHT = 16;

/**
 * Per-category two-dot dumbbell (timed vs blind-review). The connecting line is
 * colored on a diverging PuOr scale by the gap (orange = big timing gap →
 * "you know it but run out of time"; purple ≈ no gap).
 */
function GapDumbbellImpl({
  rows,
  priorRows,
  className,
  rowHeight = 30,
}: GapDumbbellProps) {
  const scales = useChartScales();
  const [hover, setHover] = useState<{
    row: GapRow;
    left: number;
    top: number;
  } | null>(null);
  const x = useMemo(
    () => scaleLinear().domain([0, 1]).range([0, 100]),
    [],
  );
  const priorByType = useMemo(() => {
    const m = new Map<string, GapRow>();
    for (const r of priorRows ?? []) m.set(String(r.q_type), r);
    return m;
  }, [priorRows]);
  // gap of 0 → neutral mid; larger gap → toward the warm (orange) end. Theme-
  // aware diverging ramp so the connector reads on every background.
  const gapColor = useMemo(() => {
    const s = scaleLinear().domain([0, 0.5]).range([0, 1]).clamp(true);
    return (gap: number) => scales.divergingColor(s(Math.abs(gap)));
  }, [scales]);

  return (
    <div className={cn("relative w-full", className)}>
      {rows.map((r) => {
        const gap = r.blindReview - r.timed;
        const stroke = gapColor(gap);
        const timedPct = x(r.timed);
        const brPct = x(r.blindReview);
        const lo = Math.min(timedPct, brPct);
        const hi = Math.max(timedPct, brPct);
        const prior = priorByType.get(String(r.q_type));
        const pTimed = prior ? x(prior.timed) : null;
        const pBr = prior ? x(prior.blindReview) : null;
        const pLo =
          pTimed != null && pBr != null ? Math.min(pTimed, pBr) : null;
        const pHi =
          pTimed != null && pBr != null ? Math.max(pTimed, pBr) : null;
        return (
          <div
            key={String(r.q_type)}
            className="flex items-center gap-2"
            style={{ height: rowHeight }}
            // R9 §8 — keep the native title as the a11y/no-JS fallback; the kit
            // tooltip below adds the micro-narrative on hover.
            title={`${qTypeLabel(r.q_type)} — timed ${Math.round(r.timed * 100)}% · BR ${Math.round(r.blindReview * 100)}% · gap ${Math.round(gap * 100)}pts`}
            onMouseMove={(e) => {
              const host = e.currentTarget.parentElement;
              const rect = host?.getBoundingClientRect();
              setHover({
                row: r,
                left: e.clientX - (rect?.left ?? 0),
                top: e.clientY - (rect?.top ?? 0),
              });
            }}
            onMouseLeave={() => setHover(null)}
          >
            <div
              className="shrink-0 truncate text-right text-xs text-muted-foreground"
              style={{ width: PAD_LEFT }}
            >
              {qTypeLabel(r.q_type)}
            </div>
            <div
              className="relative h-2 flex-1"
              style={{ marginRight: PAD_RIGHT }}
            >
              {/* track */}
              <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
              {prior && pLo != null && pHi != null && (
                <>
                  <div
                    className="absolute top-1/2 h-0.5 -translate-y-1/2 rounded-full border border-dashed border-muted-foreground/60"
                    style={{ left: `${pLo}%`, width: `${pHi - pLo}%` }}
                  />
                  <div
                    className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-muted-foreground/70 bg-background/80"
                    style={{ left: `${pTimed}%` }}
                  />
                  <div
                    className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground/40"
                    style={{ left: `${pBr}%` }}
                  />
                </>
              )}
              {/* gap connector */}
              <div
                className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full"
                style={{ left: `${lo}%`, width: `${hi - lo}%`, backgroundColor: stroke }}
              />
              {/* timed dot (hollow) */}
              <div
                className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-foreground bg-background"
                style={{ left: `${timedPct}%` }}
                aria-label={`timed ${Math.round(r.timed * 100)}%`}
              />
              {/* blind-review dot (filled) */}
              <div
                className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{ left: `${brPct}%`, backgroundColor: stroke }}
                aria-label={`blind review ${Math.round(r.blindReview * 100)}%`}
              />
            </div>
          </div>
        );
      })}
      {hover && (
        <ChartTooltip left={hover.left} top={hover.top}>
          <div className="font-medium">{qTypeLabel(hover.row.q_type)}</div>
          <div className="tabular-nums text-muted-foreground">
            Timed {Math.round(hover.row.timed * 100)}% → BR{" "}
            {Math.round(hover.row.blindReview * 100)}%
          </div>
          <div className="mt-1 max-w-[24ch] text-muted-foreground">
            {(() => {
              const g = hover.row.blindReview - hover.row.timed;
              if (g >= 0.08)
                return "Big recovery on review — you know it, the clock costs you.";
              if (g >= 0.03) return "Mild recovery — tighten pacing on this type.";
              if (g <= -0.03)
                return "Worse on review — likely a real concept gap.";
              return "Timed and review agree — performance is genuine.";
            })()}
          </div>
        </ChartTooltip>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-4 pl-[150px] text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-full border-2 border-foreground bg-background" />
          Timed
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-full bg-foreground" />
          Blind review
        </span>
        {priorRows && priorRows.length > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full border border-dashed border-muted-foreground" />
            Prior period
          </span>
        )}
      </div>
    </div>
  );
}

// A2.4 — memoized so a compare-toggle / stale-dim re-render of the Gap tab
// doesn't re-layout every dumbbell row unless rows/priorRows change identity.
export const GapDumbbell = memo(GapDumbbellImpl);
GapDumbbell.displayName = "GapDumbbell";
