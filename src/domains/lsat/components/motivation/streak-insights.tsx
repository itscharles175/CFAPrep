import { useMemo } from "react";
import { Calendar, Clock, Flame } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { StatNumber } from "@/components/viz";
import { computeStreak } from "./streak";
import type { ActivityDay } from "@/lib/types";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** R4-G6 — streak patterns from activity history.
 *  R10 B1.3/B1.4 — modernized to the shared language: `<Icon>`, depth surfaces,
 *  `.type-overline` labels, and engraved `StatNumber` figures. */
export function StreakInsights({ activity }: { activity: ActivityDay[] }) {
  const insights = useMemo(() => {
    const active = activity.filter((d) => d.questions > 0 || d.minutes > 0);
    if (!active.length) return null;

    const byDow = new Map<number, { days: number; minutes: number }>();
    for (const d of active) {
      const dow = new Date(`${d.date}T12:00:00`).getDay();
      const cur = byDow.get(dow) ?? { days: 0, minutes: 0 };
      cur.days++;
      cur.minutes += d.minutes;
      byDow.set(dow, cur);
    }

    let bestDow = 0;
    let bestDays = 0;
    for (const [dow, v] of byDow) {
      if (v.days > bestDays) {
        bestDays = v.days;
        bestDow = dow;
      }
    }

    const totalMin = active.reduce((s, d) => s + d.minutes, 0);
    const avgMin = Math.round(totalMin / active.length);
    const streak = computeStreak(activity);

    return {
      bestDay: DAY_NAMES[bestDow],
      bestDays,
      avgMin,
      current: streak.current,
      longest: streak.longest,
    };
  }, [activity]);

  if (!insights) return null;

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <Icon as={Calendar} size="md" className="text-primary" />
        <CardTitle className="text-base">Study streak insights</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm sm:grid-cols-3">
        <div className="rounded-card border bg-surface-2 p-3">
          <div className="type-overline flex items-center gap-1 text-muted-foreground">
            <Icon as={Flame} size="xs" />
            Current streak
          </div>
          <StatNumber
            value={insights.current}
            suffix="d"
            size="stat"
            voice="numeric"
            className="mt-1"
          />
          <div className="mt-1 text-xs text-muted-foreground">
            Best run: <span className="type-numeric">{insights.longest}d</span>
          </div>
        </div>
        <div className="rounded-card border bg-surface-2 p-3">
          <div className="type-overline flex items-center gap-1 text-muted-foreground">
            <Icon as={Calendar} size="xs" />
            Strongest day
          </div>
          <div className="mt-1 type-display text-2xl leading-none">
            {insights.bestDay}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {insights.bestDays} active days in your window
          </div>
        </div>
        <div className="rounded-card border bg-surface-2 p-3">
          <div className="type-overline flex items-center gap-1 text-muted-foreground">
            <Icon as={Clock} size="xs" />
            Avg per study day
          </div>
          <StatNumber
            value={insights.avgMin}
            suffix="m"
            size="stat"
            voice="numeric"
            className="mt-1"
          />
        </div>
      </CardContent>
    </Card>
  );
}
