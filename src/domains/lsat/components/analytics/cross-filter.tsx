import { Filter, X } from "lucide-react";
import { qTypeLabel } from "@lsat/lib/labels";
import { cn } from "@lsat/lib/utils";
import { useAnalyticsContext } from "./analytics-context";

/**
 * R9 §5 — the cross-filter affordance. When a question type is focused (by
 * clicking a row in the MasteryMatrix), this dismissable chip shows what the
 * charts are narrowed to and clears the focus on demand. Reads/writes the same
 * AnalyticsContext that the URL syncs, so a focused view is shareable.
 */
export function CrossFilterChip({ className }: { className?: string }) {
  const { typeFocus, setTypeFocus } = useAnalyticsContext();
  if (!typeFocus || !setTypeFocus) return null;
  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-chip border border-primary/30 bg-primary-subtle px-2.5 py-1 text-xs text-foreground",
        className,
      )}
      role="status"
    >
      <Filter className="h-3.5 w-3.5 text-primary" aria-hidden />
      <span>
        Focused on <strong className="font-semibold">{qTypeLabel(typeFocus)}</strong>
      </span>
      <button
        type="button"
        className="ml-0.5 inline-flex items-center rounded-full p-0.5 text-muted-foreground hover:bg-primary/15 hover:text-foreground"
        onClick={() => setTypeFocus(null)}
        aria-label="Clear type filter"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
