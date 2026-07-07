import { useMemo } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@lsat/components/ui/card";
import { ContributionHeatmap, ChartEmpty, type ContributionDay } from "@lsat/components/viz";
import type { SessionSummary } from "@lsat/lib/types";

/**
 * R9 §9 — study-consistency diagnostic. Reuses the (previously unused in
 * Analytics) GitHub-style {@link ContributionHeatmap}, aggregating the dates of
 * finished sessions client-side into per-day counts. Surfaces cadence — the
 * single strongest predictor of score growth — without any new endpoint.
 */
export function StudyConsistency({ sessions }: { sessions: SessionSummary[] }) {
  const { days, activeDays, currentStreak } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sessions) {
      const key = s.started.slice(0, 10);
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const data: ContributionDay[] = [...counts.entries()].map(([date, value]) => ({
      date,
      value,
    }));

    // Current streak of consecutive days ending today/yesterday.
    let streak = 0;
    const cur = new Date();
    cur.setHours(0, 0, 0, 0);
    // Allow the streak to "hold" if today has no session yet but yesterday did.
    const todayKey = cur.toISOString().slice(0, 10);
    if (!counts.has(todayKey)) cur.setDate(cur.getDate() - 1);
    for (;;) {
      const key = cur.toISOString().slice(0, 10);
      if (counts.has(key)) {
        streak++;
        cur.setDate(cur.getDate() - 1);
      } else break;
    }

    return { days: data, activeDays: counts.size, currentStreak: streak };
  }, [sessions]);

  return (
    <Card className="shadow-e1">
      <CardHeader>
        <CardTitle className="text-base">Study consistency</CardTitle>
        <CardDescription>
          {days.length
            ? `Sessions per day over the last ~6 months. ${activeDays} active ${activeDays === 1 ? "day" : "days"}${currentStreak >= 2 ? ` · ${currentStreak}-day streak` : ""}.`
            : "Your day-by-day practice cadence will appear here."}
        </CardDescription>
      </CardHeader>
      <CardContent
        className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        tabIndex={0}
        aria-label="Study consistency heatmap scroll area"
      >
        {days.length ? (
          <ContributionHeatmap data={days} />
        ) : (
          <ChartEmpty
            title="No sessions logged yet"
            hint="Finish a timed section and your daily cadence starts filling in."
            height={140}
          />
        )}
      </CardContent>
    </Card>
  );
}
