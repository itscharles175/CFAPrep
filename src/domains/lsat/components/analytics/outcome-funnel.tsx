import { OUTCOME_META } from "@/lib/labels";
import type { Outcome, ResultItem } from "@/lib/types";

const OUTCOMES: Outcome[] = [
  "timed_ok",
  "lucky",
  "concept_gap",
  "timing_problem",
];

/** 2×2 outcome counts for a session (R4-D4). */
export function OutcomeFunnel({ items }: { items: ResultItem[] }) {
  const counts = new Map<Outcome, number>();
  for (const o of OUTCOMES) counts.set(o, 0);
  for (const it of items) {
    const o = it.attempt.outcome;
    counts.set(o, (counts.get(o) ?? 0) + 1);
  }
  const max = Math.max(1, ...counts.values());

  return (
    <div className="space-y-2">
      {OUTCOMES.map((o) => {
        const n = counts.get(o) ?? 0;
        const meta = OUTCOME_META[o];
        const w = Math.round((n / max) * 100);
        return (
          <div
            key={o}
            className="flex items-center gap-3 text-sm"
            title={`${meta.label}: ${meta.description} — ${n} question${n === 1 ? "" : "s"}`}
          >
            <span className="w-32 shrink-0 text-muted-foreground">{meta.label}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary/70"
                style={{ width: `${w}%` }}
              />
            </div>
            <span className="w-8 text-right tabular-nums">{n}</span>
          </div>
        );
      })}
    </div>
  );
}
