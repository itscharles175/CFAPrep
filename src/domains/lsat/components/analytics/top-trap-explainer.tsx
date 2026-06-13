import { useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowRight, Target } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useTraps } from "@/lib/hooks";
import { trapLabel, TRAP_DESCRIPTIONS, TRAP_COUNTERS } from "@/lib/labels";
import { pct } from "@/lib/utils";
import { ChartEmpty } from "@/components/viz";
import { SkeletonCard } from "@/components/states";

/**
 * A9 — per-trap explainer. Surfaces the single most frequent trap pattern from
 * the last 30 days with why it catches you and the concrete counter-move. The
 * coaching centerpiece of the Traps view.
 */
export function TopTrapExplainer({ days = 30 }: { days?: number }) {
  const navigate = useNavigate();
  const { data, isLoading } = useTraps(days);
  if (isLoading) {
    return (
      <div role="status" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading trap explainer</span>
        <SkeletonCard />
      </div>
    );
  }

  const rows = (data?.data ?? []).filter((r) => r.trap_type !== "none");
  const top = [...rows].sort((a, b) => b.pct - a.pct)[0];
  if (!top || top.times_fell_for < 2)
    return (
      <ChartEmpty
        title="No dominant trap yet"
        hint="Once you've missed a pattern a couple of times, your top trap and how to beat it appear here."
        height={140}
      />
    );

  return (
    <Card className="border-warning/40 bg-warning-subtle shadow-e1">
      <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-start">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warning-subtle text-warning">
          <AlertTriangle className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm text-muted-foreground">
            Your most common trap this period is
          </p>
          <h3 className="text-xl font-bold">
            {trapLabel(top.trap_type)}
            <span className="ml-2 align-middle text-sm font-normal text-muted-foreground">
              {top.times_fell_for}× · {pct(top.pct)} of wrong answers
            </span>
          </h3>
          <p className="text-sm">
            <span className="font-medium">Why it catches you: </span>
            {TRAP_DESCRIPTIONS[top.trap_type]}
          </p>
          <p className="text-sm">
            <span className="font-medium">How to beat it: </span>
            {TRAP_COUNTERS[top.trap_type]}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              size="sm"
              onClick={() => navigate("/review?tab=errors&reason=trap")}
            >
              Review these misses
              <ArrowRight className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate("/drills")}
            >
              <Target className="h-4 w-4" />
              Targeted drill
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
