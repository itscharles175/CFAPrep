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
  const flaggedIndices = items
    .map((it, i) => (it.flagged ? i : -1))
    .filter((i) => i >= 0);
  const unansweredIndices = items
    .map((it, i) => (!it.answered ? i : -1))
    .filter((i) => i >= 0);

  return (
    <div className="space-y-3">
      <div className="flex gap-4 text-sm">
        <span>
          <strong className="tabular-nums">{total - unanswered}</strong>/{total} answered
        </span>
        <span className="text-muted-foreground">
          <strong className="tabular-nums text-foreground">{unanswered}</strong> unanswered
        </span>
        <span className="text-muted-foreground">
          <strong className="tabular-nums text-foreground">{flagged}</strong> flagged
        </span>
      </div>
      <div
        className="grid max-h-48 gap-1 overflow-y-auto rounded-md border p-2"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(2rem, 1fr))" }}
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
              "flex h-8 items-center justify-center rounded text-xs font-medium tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
