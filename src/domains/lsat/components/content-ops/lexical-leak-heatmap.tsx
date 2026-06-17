import { Flame } from "lucide-react";
import { Card, CardContent } from "@lsat/components/ui/card";
import { Badge } from "@lsat/components/ui/badge";
import type { LexicalLeakCell } from "@lsat/lib/types";

/**
 * LSAT-7 — lexical-leak heatmap. A length tell (the credited choice being the
 * uniquely longest/shortest option) is the classic verbatim/format leak the
 * generation validators screen for; this shows where it concentrates per source.
 * Each row is shaded by leak rate so the worst offenders read at a glance.
 */
function leakTone(rate: number): "destructive" | "warning" | "success" {
  if (rate >= 0.25) return "destructive";
  if (rate > 0) return "warning";
  return "success";
}

export function LexicalLeakHeatmap({
  cells,
  max = 10,
}: {
  cells: LexicalLeakCell[];
  max?: number;
}) {
  const rows = cells.slice(0, max);
  const withLeaks = cells.filter((c) => c.length_tell > 0).length;
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-medium">
            <Flame className="h-4 w-4" aria-hidden />
            Lexical-leak heatmap
          </div>
          <Badge variant={withLeaks ? "warning" : "success"}>
            {withLeaks} source{withLeaks === 1 ? "" : "s"} leaking
          </Badge>
        </div>
        <div className="space-y-2" role="table" aria-label="Lexical leak by source">
          {rows.map((cell) => {
            const tone = leakTone(cell.rate);
            const pct = Math.round(cell.rate * 100);
            return (
              <div
                key={cell.source}
                role="row"
                className="flex items-center gap-3 rounded-md border p-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate font-medium" role="cell">
                  {cell.source}
                </span>
                <div
                  className="h-2 w-24 overflow-hidden rounded-full bg-surface-2"
                  role="cell"
                  aria-label={`${pct}% length-tell rate`}
                >
                  <div
                    className={
                      tone === "destructive"
                        ? "h-full rounded-full bg-destructive"
                        : tone === "warning"
                          ? "h-full rounded-full bg-warning"
                          : "h-full rounded-full bg-success"
                    }
                    style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
                  />
                </div>
                <Badge variant={tone} className="shrink-0 tabular-nums" role="cell">
                  {cell.length_tell}/{cell.total} · {pct}%
                </Badge>
              </div>
            );
          })}
        </div>
        {!rows.length && (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            No answer-length tells detected across sources.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
