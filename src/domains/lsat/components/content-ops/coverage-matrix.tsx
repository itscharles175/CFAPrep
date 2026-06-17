import { Grid3x3 } from "lucide-react";
import { Card, CardContent } from "@lsat/components/ui/card";
import { Badge } from "@lsat/components/ui/badge";
import type { CoverageByTypeRow } from "@lsat/lib/types";

/**
 * LSAT-7 — coverage matrix: per q_type, how many items exist and how many sit
 * inside a near-duplicate cluster (cluster pressure concentrates on a few types).
 * A high clustered-% means generation is recycling that type and needs fresh
 * prompts, so the cockpit surfaces it as the coverage signal.
 */
function pressureTone(pct: number): "destructive" | "warning" | "success" {
  if (pct >= 0.3) return "destructive";
  if (pct > 0) return "warning";
  return "success";
}

export function CoverageMatrix({
  rows,
  max = 12,
}: {
  rows: CoverageByTypeRow[];
  max?: number;
}) {
  const visible = rows.slice(0, max);
  const pressured = rows.filter((r) => r.clustered > 0).length;
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-medium">
            <Grid3x3 className="h-4 w-4" aria-hidden />
            Coverage matrix
          </div>
          <Badge variant={pressured ? "warning" : "success"}>
            {pressured} type{pressured === 1 ? "" : "s"} clustered
          </Badge>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {visible.map((row) => {
            const tone = pressureTone(row.clustered_pct);
            const pct = Math.round(row.clustered_pct * 100);
            return (
              <div key={row.q_type} className="rounded-md border p-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate font-medium">{row.q_type}</p>
                  <Badge variant="outline">{row.total} total</Badge>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {row.clustered} in clusters
                  </span>
                  <Badge variant={tone} className="tabular-nums">
                    {pct}%
                  </Badge>
                </div>
              </div>
            );
          })}
        </div>
        {!visible.length && (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            No per-type coverage yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
