import { cn } from "@lsat/lib/utils";
import type { NavItem } from "./navigator-strip";

/** Grid summary before finishing a timed section (v2: jump to flagged / unanswered). */
export function PreSubmitReview({
  items,
  total,
  onJumpTo,
}: {
  items: NavItem[];
  total: number;
  onJumpTo?: (index: number) => void;
}) {
  const unanswered = items.filter((i) => !i.answered).length;
  const flagged = items.filter((i) => i.flagged).length;
  const flaggedIndices = items.map((it, i) => (it.flagged ? i : -1)).filter((i) => i >= 0);
  const unansweredIndices = items.map((it, i) => (!it.answered ? i : -1)).filter((i) => i >= 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2 text-xs">
        <span className="rounded-md border border-primary/20 bg-primary/5 px-2.5 py-2 text-muted-foreground">
          <strong className="type-numeric block text-base text-foreground">
            {total - unanswered}/{total}
          </strong>{" "}
          answered
        </span>
        <span className="rounded-md border border-destructive/20 bg-destructive-subtle px-2.5 py-2 text-muted-foreground">
          <strong className="type-numeric block text-base text-foreground">{unanswered}</strong> unanswered
        </span>
        <span className="rounded-md border border-warning/25 bg-warning/5 px-2.5 py-2 text-muted-foreground">
          <strong className="type-numeric block text-base text-foreground">{flagged}</strong> flagged
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10" aria-hidden>
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${total > 0 ? ((total - unanswered) / total) * 100 : 0}%` }}
        />
      </div>
      <div
        className="grid max-h-52 gap-1.5 overflow-y-auto rounded-md border border-border/80 bg-surface-1 p-2.5"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(2.25rem, 1fr))" }}
        role="group"
        aria-label="Question status grid"
      >
        {items.map((it, i) => (
          <button
            key={i}
            type="button"
            disabled={!onJumpTo}
            onClick={() => onJumpTo?.(i)}
            title={`Q${i + 1}${it.flagged ? " · flagged" : ""}${!it.answered ? " · unanswered" : ""}`}
            className={cn(
              "flex h-9 items-center justify-center rounded-md text-xs font-medium tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              onJumpTo && "cursor-pointer hover:ring-2 hover:ring-primary/50",
              !it.answered && "bg-destructive-subtle text-destructive",
              it.answered && it.flagged && "bg-warning/20 text-warning",
              it.answered && !it.flagged && "bg-muted text-muted-foreground",
            )}
          >
            {i + 1}
          </button>
        ))}
      </div>
      {onJumpTo && (flaggedIndices.length > 0 || unansweredIndices.length > 0) && (
        <div className="flex flex-wrap gap-2">
          {flaggedIndices.length > 0 && (
            <button
              type="button"
              className="text-xs font-medium text-warning underline-offset-2 hover:underline"
              onClick={() => onJumpTo(flaggedIndices[0])}
            >
              Review first flagged (Q{flaggedIndices[0] + 1})
            </button>
          )}
          {unansweredIndices.length > 0 && (
            <button
              type="button"
              className="text-xs font-medium text-destructive underline-offset-2 hover:underline"
              onClick={() => onJumpTo(unansweredIndices[0])}
            >
              Jump to first unanswered (Q{unansweredIndices[0] + 1})
            </button>
          )}
        </div>
      )}
    </div>
  );
}
