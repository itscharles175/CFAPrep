import { m, useReducedMotion } from "motion/react";
import { trapLabel, TRAP_DESCRIPTIONS } from "@lsat/lib/labels";
import { duration, easing } from "@lsat/lib/motion";
import { cn, pct } from "@lsat/lib/utils";
import type { TrapRow } from "@lsat/lib/types";

export interface TrapBarsProps {
  rows: TrapRow[];
}

/** §3.5 — ranked bars of the trap types the user falls for, each described. */
export function TrapBars({ rows }: TrapBarsProps) {
  const reduce = useReducedMotion();
  const max = Math.max(0.0001, ...rows.map((r) => r.pct));
  const sorted = [...rows].sort((a, b) => b.pct - a.pct);

  return (
    <div className="space-y-3">
      {sorted.map((r, i) => (
        <div key={r.trap_type} className="space-y-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="font-medium">{trapLabel(r.trap_type)}</span>
            <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
              {pct(r.pct)} · {r.times_fell_for}×
            </span>
          </div>
          <div
            className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
            title={`${trapLabel(r.trap_type)} — fell for it ${r.times_fell_for}× (${pct(r.pct)} of wrong answers)`}
          >
            <m.div
              className={cn(
                "h-full rounded-full",
                i === 0 ? "bg-destructive" : "bg-warning",
              )}
              initial={reduce ? false : { width: 0 }}
              animate={{ width: `${(r.pct / max) * 100}%` }}
              transition={{
                duration: duration.slow,
                ease: easing.emphasized,
                delay: reduce ? 0 : i * 0.04,
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {TRAP_DESCRIPTIONS[r.trap_type] ?? TRAP_DESCRIPTIONS.none}
          </p>
        </div>
      ))}
    </div>
  );
}
