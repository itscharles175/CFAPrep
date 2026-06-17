import { Timer } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@lsat/components/ui/card";
import { Badge } from "@lsat/components/ui/badge";
import { qTypeLabel } from "@lsat/lib/labels";
import type { PacingBudgetRow } from "@lsat/lib/types";

/**
 * LSAT-7 — per-type pacing-budget display. Shows the section benchmark (or saved
 * override) against the student's observed average so a drill/playlist makes its
 * time budget explicit. Inline (no editing) — overrides are set from Content Ops.
 */
function fmtSeconds(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return `${Math.round(ms / 1000)}s`;
}

export function PacingBudgetCard({
  budgets,
  overBudgetCount,
  title = "Pacing budgets",
  max = 8,
}: {
  budgets: PacingBudgetRow[];
  overBudgetCount?: number;
  title?: string;
  max?: number;
}) {
  const rows = budgets.slice(0, max);
  const over = overBudgetCount ?? budgets.filter((b) => b.over_budget).length;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <Timer className="h-4 w-4" aria-hidden />
            {title}
          </span>
          <Badge variant={over ? "warning" : "success"}>
            {over} over budget
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map((row) => (
          <div key={row.q_type} className="rounded-md border p-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate font-medium">{qTypeLabel(row.q_type)}</p>
              <Badge variant="outline">{row.section_type}</Badge>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>
                budget {fmtSeconds(row.budget_ms)}
                {row.override_ms != null && (
                  <span className="ml-1 text-foreground">(override)</span>
                )}
              </span>
              <span aria-hidden>·</span>
              <span>avg {fmtSeconds(row.avg_time_ms)}</span>
              {row.over_budget && (
                <Badge variant="warning" className="ml-auto">
                  over budget
                </Badge>
              )}
            </div>
          </div>
        ))}
        {!rows.length && (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            No pacing data yet — complete a few timed drills.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
