import { useNavigate } from "react-router-dom";
import { CalendarClock, Target } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@lsat/components/ui/card";
import { Button } from "@lsat/components/ui/button";
import { Icon } from "@lsat/components/ui/icon";
import { ProgressRing } from "@lsat/components/viz";
import { cn } from "@lsat/lib/utils";
import { useForecast } from "@lsat/lib/hooks";
import { daysUntil, type Goal } from "@lsat/lib/prefs";

export interface CountdownProps {
  goal: Goal | null;
  predictedScore: number | null | undefined;
  /** Recent trajectory (per-30d delta) — feeds the on-track judgement. */
  delta30d: number | null | undefined;
  /**
   * R9 — earliest date the user has practice data for (the first trend point).
   * Real data lifted from the dashboard; used only to draw the prep-window
   * elapsed arc. Omitted/absent ⇒ the arc degrades to the bare day count.
   */
  prepStartDate?: string;
}

type Status = "ahead" | "on_track" | "behind" | "unknown";

function judge(predicted: number, target: number, delta: number): Status {
  // On track if already within ~1 pt of target, or trending up toward it.
  if (predicted >= target) return "ahead";
  const gap = target - predicted;
  if (gap <= 1) return "on_track";
  // delta is per-30-days improvement; positive trend closing the gap = on track.
  if (delta > 0 && gap <= delta * 1.5) return "on_track";
  return "behind";
}

const STATUS_META: Record<Status, { label: string; className: string }> = {
  ahead: { label: "Ahead of goal", className: "bg-success-subtle text-success" },
  on_track: { label: "On track", className: "bg-success-subtle text-success" },
  behind: { label: "Behind pace", className: "bg-warning-subtle text-warning" },
  unknown: { label: "Need baseline", className: "bg-muted text-muted-foreground" },
};

/**
 * One short serif counsel line — the most charged sentence in LSAT prep. Speaks
 * from the day count + on-track verdict; no new data.
 */
function counselLine(days: number, status: Status): string {
  if (days <= 0) return "Today is the day — trust the work you've put in.";
  if (status === "unknown")
    return "Set a timed baseline so the countdown can judge the pace honestly.";
  const noun = days === 1 ? "morning" : "mornings";
  if (days <= 7) {
    return status === "behind"
      ? `${days} ${noun} left — taper hard drills, rehearse your pacing.`
      : `${days} ${noun} left — protect the routine and rest into it.`;
  }
  if (status === "behind")
    return `${days} ${noun} left — raise timed volume to close the gap.`;
  if (status === "ahead")
    return `${days} ${noun} left — maintain and stress-test under time.`;
  return `${days} ${noun} left — keep the current pace and the trend holds.`;
}

/**
 * §5.2 / R9 — the exam countdown as the Console's emotional focal instrument:
 * an engraved `type-numeric` day count co-equal with predicted score, a serif
 * counsel line, and an arc of prep-window elapsed. Degrades gracefully when no
 * exam date is set.
 */
export function Countdown({
  goal,
  predictedScore,
  delta30d,
  prepStartDate,
}: CountdownProps) {
  const navigate = useNavigate();
  // B2 — server forecast drives the projection + on-track call when available.
  const fc = useForecast(goal?.examDate ?? null, goal?.targetScore ?? null);

  if (!goal || !goal.examDate) {
    return (
      <Card className="aurora flex flex-col justify-center border-dashed">
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <Icon as={CalendarClock} size="md" className="text-primary" />
          <CardTitle>Test day</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="type-counsel text-sm text-muted-foreground">
            Set a target score and test date — the most charged number in your
            prep — and the countdown lights up here.
          </p>
          <Button size="sm" className="min-h-10" onClick={() => navigate("/settings")}>
            Set a date
          </Button>
        </CardContent>
      </Card>
    );
  }

  const days = daysUntil(goal.examDate) ?? 0;
  const safeDays = Math.max(0, days);
  const f = fc.data?.data;
  const hasPrediction =
    typeof predictedScore === "number" && Number.isFinite(predictedScore);
  const safePredictedScore = hasPrediction ? predictedScore : null;
  const safeDelta30d =
    typeof delta30d === "number" && Number.isFinite(delta30d) ? delta30d : 0;
  const projected = f?.projected_score ?? safePredictedScore;
  const status: Status =
    f && f.projected_score != null && f.on_track != null
      ? f.projected_score >= goal.targetScore
        ? "ahead"
        : f.on_track
          ? "on_track"
          : "behind"
      : safePredictedScore == null
        ? "unknown"
        : judge(safePredictedScore, goal.targetScore, safeDelta30d);
  const meta = STATUS_META[status];

  // Prep-window elapsed (0..1): real start (first trend point) → exam date.
  const prepStart = prepStartDate ? daysUntil(prepStartDate) : null; // negative = days ago
  const elapsedDays = prepStart != null ? -prepStart : null;
  const elapsedFrac =
    elapsedDays != null && elapsedDays >= 0
      ? elapsedDays / Math.max(1, elapsedDays + safeDays)
      : null;

  const dayWord =
    days < 0 ? "test date passed" : days === 0 ? "test is today" : days === 1 ? "day to test" : "days to test";

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <Icon as={CalendarClock} size="md" className="text-primary" />
        <CardTitle>Test day</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <div className="flex items-center gap-4">
          {/* Engraved focal numeral — co-equal with predicted score. */}
          <div className="aurora min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="type-numeric text-stat font-semibold leading-none">
                {safeDays}
              </span>
              <span className="text-sm text-muted-foreground">{dayWord}</span>
            </div>
            <p className="type-counsel mt-2 max-w-prose text-sm text-muted-foreground [text-wrap:pretty]">
              {counselLine(safeDays, status)}
            </p>
          </div>

          {/* Prep-window elapsed arc (only when we have a real start point). */}
          {elapsedFrac != null && (
            <ProgressRing
              value={elapsedFrac}
              size={72}
              strokeWidth={6}
              label={
                <span className="type-numeric text-sm">
                  {Math.round(elapsedFrac * 100)}%
                </span>
              }
              sublabel="elapsed"
            />
          )}
        </div>

        <div className="mt-auto space-y-2 border-t pt-3">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Icon as={Target} size="sm" />
              Target {goal.targetScore}
            </span>
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-chip px-2 py-0.5 text-xs font-semibold",
                meta.className,
              )}
            >
              {meta.label}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Projected {projected ?? "n/a"} vs target {goal.targetScore}
            {f?.confidence ? ` (${f.confidence.low}–${f.confidence.high} band)` : ""}
            {status === "behind"
              ? " — increase timed volume to close the gap."
              : status === "on_track"
                ? " — keep the current pace."
                : " — maintain and stress-test under time."}
          </p>
          {f && f.slope_per_week !== 0 && (
            <p className="text-xs text-muted-foreground tabular-nums">
              Trend {f.slope_per_week > 0 ? "+" : ""}
              {f.slope_per_week}/wk
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
