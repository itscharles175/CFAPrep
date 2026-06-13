import { cn } from "@lsat/lib/utils";
import type { SectionSummary } from "@lsat/lib/types";

/** R4-C9 — visual PT progress through sections. */
export function ExamProgressMap({
  sections,
  currentIndex,
  completedThrough,
}: {
  sections: SectionSummary[];
  currentIndex: number;
  /** Highest section index fully finished (inclusive), or -1. */
  completedThrough: number;
}) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 py-2">
      {sections.map((s, i) => {
        const done = i <= completedThrough;
        const current = i === currentIndex;
        return (
          <div key={s.id} className="flex items-center gap-2">
            <div
              className={cn(
                "flex h-8 min-w-[2rem] items-center justify-center rounded-full px-2 text-xs font-medium tabular-nums",
                done && "bg-primary text-primary-foreground",
                current && !done && "ring-2 ring-primary bg-card",
                !done && !current && "bg-muted text-muted-foreground",
              )}
              title={`${s.type} section ${s.order}`}
            >
              {s.order}
            </div>
            {i < sections.length - 1 && (
              <div
                className={cn(
                  "h-0.5 w-6",
                  i < completedThrough ? "bg-primary" : "bg-border",
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
