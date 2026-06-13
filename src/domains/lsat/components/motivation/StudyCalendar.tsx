import { useMemo, useState } from "react";
import { Flame, Snowflake } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/lib/toast";
import { pluralize } from "@/lib/utils";
import { getWeeklyGoals, applyStreakFreeze } from "@/lib/prefs";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ContributionHeatmap, ProgressRing } from "@/components/viz";
import type { ContributionDay } from "@/components/viz";
import type { ActivityDay } from "@/lib/types";
import { computeStreak, daysStudiedThisWeek } from "./streak";

type Metric = "questions" | "minutes";
const WEEKLY_TARGET = 5; // days/week (§5.4)

export interface StudyCalendarProps {
  activity: ActivityDay[];
}

/** §5.1 contribution heatmap + §5.4 streak readout & weekly-goal ring. */
export function StudyCalendar({ activity }: StudyCalendarProps) {
  const [metric, setMetric] = useState<Metric>("questions");

  const heatmap: ContributionDay[] = useMemo(
    () => activity.map((d) => ({ date: d.date, value: d[metric] })),
    [activity, metric],
  );

  const streak = useMemo(() => computeStreak(activity), [activity]);
  const weekDays = useMemo(() => daysStudiedThisWeek(activity), [activity]);
  const goals = getWeeklyGoals();
  const [freezeOpen, setFreezeOpen] = useState(false);
  const weekTotals = useMemo(() => {
    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    start.setHours(0, 0, 0, 0);
    let questions = 0;
    let minutes = 0;
    for (const d of activity) {
      const day = new Date(d.date + "T12:00:00");
      if (day >= start) {
        questions += d.questions;
        minutes += d.minutes;
      }
    }
    return { questions, minutes };
  }, [activity]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>Study calendar</CardTitle>
        <div className="flex rounded-md border p-0.5 text-xs">
          {(["questions", "minutes"] as Metric[]).map((m) => (
            <button
              key={m}
              onClick={() => setMetric(m)}
              className={
                metric === m
                  ? "rounded-[4px] bg-primary px-2 py-1 font-medium capitalize text-primary-foreground"
                  : "rounded-[4px] px-2 py-1 capitalize text-muted-foreground hover:text-foreground"
              }
            >
              {m}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-6 lg:flex-row lg:items-center">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <ContributionHeatmap data={heatmap} weeks={26} />
        </div>

        <div className="flex shrink-0 items-center gap-6">
          <div>
            <div className="flex items-center gap-1.5">
              <Flame
                className={
                  streak.current > 0
                    ? "h-5 w-5 text-warning"
                    : "h-5 w-5 text-muted-foreground"
                }
              />
              <span className="stat text-3xl font-semibold tabular-nums leading-none">
                {streak.current}
              </span>
              <span className="text-sm text-muted-foreground">
                {pluralize(streak.current, "day")}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Current streak · longest {streak.longest}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => setFreezeOpen(true)}
            >
              <Snowflake className="h-3.5 w-3.5" />
              Freeze streak
            </Button>
            <Dialog open={freezeOpen} onOpenChange={setFreezeOpen}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Use streak freeze?</DialogTitle>
                  <DialogDescription>
                    One freeze per week protects your streak if you miss a day.
                    This cannot be undone for the current week.
                  </DialogDescription>
                </DialogHeader>
                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="outline" onClick={() => setFreezeOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    onClick={() => {
                      setFreezeOpen(false);
                      if (applyStreakFreeze()) {
                        toast.success("Streak freeze applied for this week");
                      } else {
                        toast.message("Streak freeze already used this week");
                      }
                    }}
                  >
                    Confirm freeze
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>

          <ProgressRing
            value={Math.min(1, weekDays / WEEKLY_TARGET)}
            size={84}
            strokeWidth={7}
            color="hsl(var(--primary))"
            label={
              <span className="tabular-nums">
                {weekDays}/{WEEKLY_TARGET}
              </span>
            }
            sublabel="this week"
          />
        </div>
        <p className="text-xs text-muted-foreground lg:w-full">
          Weekly goals: {weekTotals.questions}/{goals.questionsTarget} questions ·{" "}
          {weekTotals.minutes}/{goals.minutesTarget} min
        </p>
      </CardContent>
    </Card>
  );
}
