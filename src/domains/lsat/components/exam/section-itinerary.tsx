import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn, formatClock } from "@/lib/utils";
import type { SectionSummary } from "@/lib/types";

/**
 * R9 (docs/19 "the section lineup as a designed itinerary, not list rows").
 *
 * The exam's sections rendered as a vertical itinerary with a connecting rail:
 * each stop carries an ordinal node, the section identity, and its scope
 * (question count + time limit). When `currentIndex`/`completedThrough` are
 * supplied (mid-exam) the rail fills and the current stop is haloed — a calm
 * "where am I in the journey" cue. Pre/post-clock only; shows no score or
 * correctness, so it is Test-Mode-safe everywhere it appears (intro + done).
 */
export function SectionItinerary({
  sections,
  currentIndex,
  completedThrough = -1,
  className,
}: {
  sections: SectionSummary[];
  /** The in-progress section index, or undefined on the intro/done stages. */
  currentIndex?: number;
  /** Highest fully-finished section index (inclusive), or -1. */
  completedThrough?: number;
  className?: string;
}) {
  return (
    <ol className={cn("mx-auto max-w-md space-y-1 text-left", className)}>
      {sections.map((s, i) => {
        const done = i <= completedThrough;
        const current = i === currentIndex && !done;
        const upcoming = !done && !current;
        const isLast = i === sections.length - 1;

        return (
          <li key={s.id} className="relative flex gap-3">
            {/* Rail node + connector. */}
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  "z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold tabular-nums transition-colors",
                  done && "border-primary bg-primary text-primary-foreground",
                  current && "border-primary bg-surface-1 text-primary glow-verdict",
                  upcoming && "border-border bg-surface-1 text-muted-foreground",
                )}
              >
                {done ? <Check className="h-4 w-4" /> : s.order}
              </span>
              {!isLast && (
                <span
                  aria-hidden
                  className={cn(
                    "w-px flex-1",
                    i < completedThrough ? "bg-primary" : "bg-border",
                  )}
                />
              )}
            </div>

            {/* Stop content. */}
            <div
              className={cn(
                "mb-1 flex flex-1 items-center justify-between gap-3 rounded-card border px-3 py-2.5 transition-colors",
                current ? "border-primary/40 bg-surface-2" : "border-transparent bg-surface-1",
              )}
            >
              <span className="flex items-center gap-2 text-sm">
                <Badge variant={current ? "default" : "secondary"}>{s.type}</Badge>
                <span className={cn("font-medium", upcoming && "text-muted-foreground")}>
                  Section {s.order}
                </span>
                {current && (
                  <span className="type-overline text-primary">In progress</span>
                )}
              </span>
              <span className="type-numeric shrink-0 text-xs text-muted-foreground">
                {s.question_count} Q · {formatClock(s.time_limit_sec)}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
