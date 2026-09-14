import { DatabaseZap, RefreshCw } from "lucide-react";
import { Badge } from "@lsat/components/ui/badge";
import { Button } from "@lsat/components/ui/button";
import { Icon } from "@lsat/components/ui/icon";

/**
 * Makes an offline fallback explicit at the exact place it would otherwise be
 * mistaken for earned study evidence. The caller intentionally withholds the
 * sample rows: this is a recovery state, never an empty-progress claim.
 */
export function SampleDataRecovery({
  section,
  onRetry,
  compact = false,
  affectedSections,
}: {
  section: string;
  onRetry: () => void;
  compact?: boolean;
  affectedSections?: string[];
}) {
  return (
    <section
      className={
        compact
          ? "flex flex-wrap items-center justify-between gap-3 rounded-card border border-warning/35 bg-warning/5 px-4 py-3"
          : "rounded-card border border-warning/35 bg-warning/5 p-[var(--card-pad)]"
      }
      aria-label={`${section}: sample data excluded`}
      role="status"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 rounded-md bg-warning/15 p-1.5 text-warning">
          <Icon as={DatabaseZap} size="sm" />
        </span>
        <div className="min-w-0 space-y-1">
          <Badge variant="outline" className="border-warning/50 bg-warning/10 text-warning">
            Sample data excluded
          </Badge>
          <p className="font-medium">{section} is unavailable while the LSAT backend is offline.</p>
          <p className="text-sm text-muted-foreground">
            StudyVault will not use built-in sample values as your progress, score, review load, or history.
          </p>
          {affectedSections && affectedSections.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Affected: {affectedSections.join(" · ")}
            </p>
          )}
        </div>
      </div>
      <Button variant="outline" size="sm" className="shrink-0" onClick={onRetry}>
        <Icon as={RefreshCw} size="xs" /> Retry
      </Button>
    </section>
  );
}
