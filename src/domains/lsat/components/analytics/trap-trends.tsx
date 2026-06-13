import { useMemo } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { trapLabel } from "@/lib/labels";
import { trapsByWeek } from "@/lib/trapTrends";
import { pct } from "@/lib/utils";
import type { TrapRow } from "@/lib/types";
import { ChartDataTable } from "./chart-data-table";
import { ChartEmpty } from "@/components/viz";

/** R4-E7 — weekly trap small multiples from aggregate trap stats. */
export function TrapTrends({ traps }: { traps: TrapRow[] }) {
  const weeks = useMemo(() => trapsByWeek(traps), [traps]);
  if (!weeks.length)
    return (
      <Card className="shadow-e1">
        <CardHeader>
          <CardTitle className="text-base">Trap trends by week</CardTitle>
          <CardDescription>
            Small multiples for your top trap patterns over recent weeks.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChartEmpty
            title="No trap history yet"
            hint="As you log wrong answers, recurring traps build a weekly trend here."
          />
        </CardContent>
      </Card>
    );

  const tableRows = weeks.flatMap((w) =>
    w.rows.map((r) => [w.label, trapLabel(r.trap_type), String(r.times_fell_for), pct(r.pct)]),
  );

  return (
    <Card className="shadow-e1">
      <CardHeader>
        <CardTitle className="text-base">Trap trends by week</CardTitle>
        <CardDescription>
          Small multiples for your top trap patterns — recent weeks weighted from your totals.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {weeks.map((w) => (
            <WeekPanel key={w.weekStart} label={w.label} rows={w.rows} />
          ))}
        </div>
        <ChartDataTable
          caption="Trap trends by week"
          headers={["Week", "Trap", "Count", "Share"]}
          rows={tableRows}
        />
      </CardContent>
    </Card>
  );
}

function WeekPanel({ label, rows }: { label: string; rows: TrapRow[] }) {
  const max = Math.max(0.0001, ...rows.map((r) => r.pct));
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="mb-2 text-xs font-medium text-muted-foreground">{label}</p>
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.trap_type} className="space-y-0.5">
            <div className="flex justify-between text-[10px]">
              <span className="truncate pr-1">{trapLabel(r.trap_type)}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {r.times_fell_for}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-warning"
                style={{ width: `${(r.pct / max) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
