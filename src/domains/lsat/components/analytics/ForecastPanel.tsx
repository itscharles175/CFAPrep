import { useMemo } from "react";
import { CalendarClock, Target, TrendingUp } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ReadinessGauge, StatNumber } from "@/components/viz";
import { readinessFromStatus, type ReadinessInput } from "@/lib/readiness";
import type { Forecast, ReadinessStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface ForecastPanelProps {
  /** Server forecast (may be partial / empty offline). */
  forecast?: Forecast;
  /** Goal band + exam date read from prefs. */
  goalBand?: [number, number];
  examDate?: string;
  targetScore?: number;
  /** Latest predicted score (dashboard) — the projection's launch value. */
  predictedScore: number | null | undefined;
  /** Inputs for the composite readiness gauge (existing dashboard signals). */
  readiness: ReadinessInput;
  /** Ability Engine V2 readiness from /api/readiness; optional for offline fallback. */
  backendReadiness?: ReadinessStatus | null;
  /** Navigate to settings to set a goal (empty-state CTA). */
  onSetGoal?: () => void;
}

function daysUntil(iso: string): number | null {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.round((t - Date.now()) / 86_400_000);
}

/**
 * R9 §4 — "Are you on track?" forecast hero. Lifts the glide-path projection
 * out of the trend chart's cramped right edge into a dedicated panel that pairs
 * the multi-ring {@link ReadinessGauge} (previously unused in Analytics) with
 * the projection numbers (projected score, gap to target, days to exam). When
 * no exam date is set it shows a strong, single-CTA empty state instead of a
 * half-drawn cone.
 */
export function ForecastPanel({
  forecast,
  goalBand,
  examDate,
  targetScore,
  predictedScore,
  readiness,
  backendReadiness,
  onSetGoal,
}: ForecastPanelProps) {
  const result = useMemo(
    () => readinessFromStatus(backendReadiness, readiness),
    [backendReadiness, readiness],
  );

  // No exam date → can't project. A focused empty state, not a broken cone.
  if (!examDate) {
    return (
      <Card className="border-primary/15 bg-surface-1 shadow-e2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Target className="h-5 w-5 text-primary" />
            Are you on track?
          </CardTitle>
          <CardDescription>
            Set a target score and exam date to project your glide path and see
            whether your current pace lands you in your goal band.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-4">
          <ReadinessGauge
            rings={result.rings}
            animate
            centerTop={
              <span className="type-numeric text-2xl font-bold tabular-nums">
                {result.score}
              </span>
            }
            centerBottom={<span className="text-2xs text-muted-foreground">/ 100</span>}
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-muted-foreground">
              Your readiness is <strong className="text-foreground">{result.label}</strong>{" "}
              today. A goal turns that into a dated forecast.
            </p>
            {onSetGoal && (
              <Button size="sm" className="mt-3" onClick={onSetGoal}>
                Set a goal
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  const hasPrediction =
    typeof predictedScore === "number" && Number.isFinite(predictedScore);
  const projected = forecast?.projected_score ?? (hasPrediction ? predictedScore : null);
  const target = forecast?.target_score ?? targetScore ?? goalBand?.[1] ?? null;
  const days = forecast?.days_to_exam ?? daysUntil(examDate);
  const gapToTarget =
    forecast?.gap_to_target ??
    (target != null && projected != null ? Math.round(projected - target) : null);
  // `on_track` from the server when present; else infer from the goal band.
  const onTrack =
    forecast?.on_track ??
    (projected == null
      ? null
      : goalBand
        ? projected >= goalBand[0]
        : target != null
          ? projected >= target
          : null);
  const slopePerWeek = forecast?.slope_per_week ?? 0;

  const verdict =
    onTrack === true
      ? "On track for your goal band."
      : onTrack === false
        ? "Off pace — close the gap below."
        : "Tracking your projection.";

  return (
    <Card
      className={cn(
        "border-primary/15 bg-surface-1 shadow-e2",
        onTrack === true && "glow-verdict",
      )}
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Target className="h-5 w-5 text-primary" />
          Are you on track?
        </CardTitle>
        <CardDescription>{verdict}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-6">
          <ReadinessGauge
            rings={result.rings}
            animate
            centerTop={
              <span className="type-numeric text-2xl font-bold tabular-nums">
                {result.score}
              </span>
            }
            centerBottom={<span className="text-2xs text-muted-foreground">/ 100</span>}
          />
          <div className="grid flex-1 grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
            <StatNumber
              label="Projected"
              value={projected == null ? null : Math.round(projected)}
              voice="numeric"
              size="stat"
              aurora
              subline={
                slopePerWeek
                  ? `${slopePerWeek > 0 ? "+" : ""}${slopePerWeek.toFixed(1)} pts/week`
                  : "exam-day estimate"
              }
            />
            {target != null && (
              <div className="flex flex-col gap-1">
                <span className="type-overline text-muted-foreground">Gap to target</span>
                <span
                  className={cn(
                    "type-numeric text-2xl font-semibold tabular-nums",
                    gapToTarget != null && gapToTarget >= 0
                      ? "text-success"
                      : "text-warning",
                  )}
                >
                  {gapToTarget != null
                    ? `${gapToTarget >= 0 ? "+" : ""}${gapToTarget}`
                    : "—"}
                </span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Target className="h-3 w-3" /> target {target}
                </span>
              </div>
            )}
            {days != null && (
              <div className="flex flex-col gap-1">
                <span className="type-overline text-muted-foreground">Days to exam</span>
                <span className="type-numeric text-2xl font-semibold tabular-nums">
                  {Math.max(0, days)}
                </span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <CalendarClock className="h-3 w-3" /> {examDate}
                </span>
              </div>
            )}
          </div>
        </div>
        {onTrack === false && gapToTarget != null && (
          <p className="mt-4 flex items-start gap-2 rounded-card bg-warning-subtle p-3 text-sm">
            <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <span>
              You're <strong>{Math.abs(gapToTarget)} pts</strong> short of target on
              your current trajectory. The biggest levers are below — accuracy on
              your weakest types and closing any timed→review gap.
            </span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
