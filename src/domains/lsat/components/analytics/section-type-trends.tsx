import { useMemo } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { TrendChart, ChartEmpty, type TrendDatum } from "@/components/viz";
import {
  reviewableSessions,
  useMultiSessionResults,
} from "@/lib/hooks/useReviewSessions";
import { typeFamily } from "@/lib/labels";
import { SkeletonChart } from "@/components/states";
import { ChartDataTable } from "./chart-data-table";
import type { SessionSummary } from "@/lib/types";

/**
 * B8 — session-compare small multiples. Facets the accuracy trend by section
 * type (LR vs RC) into side-by-side mini charts, computed from finished-session
 * results. Real per-type accuracy over time (no fabricated per-type scaled
 * score).
 */
export function SectionTypeTrends({ sessions }: { sessions: SessionSummary[] }) {
  const list = reviewableSessions(sessions);
  const multi = useMultiSessionResults(list.map((s) => s.id));

  const { lr, rc } = useMemo(() => {
    const lrSeries: TrendDatum[] = [];
    const rcSeries: TrendDatum[] = [];
    // Oldest → newest so the line reads left to right.
    const ordered = [...list].sort((a, b) => a.started.localeCompare(b.started));
    for (const s of ordered) {
      const items = multi.resultsBySessionId.get(s.id) ?? [];
      if (!items.length) continue;
      let lrC = 0;
      let lrN = 0;
      let rcC = 0;
      let rcN = 0;
      for (const it of items) {
        if (typeFamily(it.question.q_type) === "RC") {
          rcN++;
          if (it.attempt.is_correct) rcC++;
        } else {
          lrN++;
          if (it.attempt.is_correct) lrC++;
        }
      }
      if (lrN > 0) lrSeries.push({ date: s.started, score: Math.round((lrC / lrN) * 100) });
      if (rcN > 0) rcSeries.push({ date: s.started, score: Math.round((rcC / rcN) * 100) });
    }
    return { lr: lrSeries, rc: rcSeries };
  }, [list, multi.resultsBySessionId]);

  if (multi.isLoading) return <SkeletonChart />;
  if (lr.length < 2 && rc.length < 2)
    return (
      <Card className="shadow-e1">
        <CardHeader>
          <CardTitle className="text-base">Accuracy by section type</CardTitle>
          <CardDescription>
            Your Logical Reasoning vs Reading Comprehension accuracy across
            sessions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChartEmpty
            title="Not enough sessions to split LR vs RC"
            hint="Finish a couple more timed sections to see each section type trend."
          />
        </CardContent>
      </Card>
    );

  return (
    <Card className="shadow-e1">
      <CardHeader>
        <CardTitle className="text-base">Accuracy by section type</CardTitle>
        <CardDescription>
          Small multiples — your Logical Reasoning vs Reading Comprehension
          accuracy across sessions.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-2">
          <Facet label="Logical Reasoning" series={lr} />
          <Facet label="Reading Comprehension" series={rc} />
        </div>
      </CardContent>
    </Card>
  );
}

function Facet({ label, series }: { label: string; series: TrendDatum[] }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted-foreground">{label}</div>
      {series.length >= 2 ? (
        <>
          <TrendChart series={series} height={140} />
          <ChartDataTable
            caption={`${label} accuracy by session`}
            headers={["Date", "Accuracy %"]}
            rows={series.map((d) => [d.date.slice(0, 10), String(d.score)])}
          />
        </>
      ) : (
        <ChartEmpty
          title={`Not enough ${label} sessions`}
          hint="Two or more sessions reveal the trend."
          height={140}
        />
      )}
    </div>
  );
}
