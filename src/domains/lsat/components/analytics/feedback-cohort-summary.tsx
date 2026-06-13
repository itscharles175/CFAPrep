import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/states";
import type {
  FeedbackCohortSummary,
  FeedbackOutcomeSummary,
  FeedbackQTypeCohort,
} from "@/lib/types";

function pct(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${Math.round(value * 100)}%`;
}

function statusLabel(status: string | null | undefined): string {
  return String(status || "no_feedback").replace(/_/g, " ");
}

function hintLabel(hint: string | null | undefined): string {
  return String(hint || "thin_signal").replace(/_/g, " ");
}

function sequenceLabel(row: FeedbackQTypeCohort | null | undefined): string {
  if (!row) return "n/a";
  const pctDelta = Math.round((row.drill_sequence_multiplier - 1) * 100);
  if (pctDelta === 0) return "hold";
  return pctDelta > 0 ? `+${pctDelta}%` : `${pctDelta}%`;
}

function actionLabel(action: string | null | undefined): string {
  if (action === "complete") return "accepted";
  if (action === "skip") return "skipped";
  return statusLabel(action);
}

function sourceLabel(source: string | null | undefined): string {
  return source === "official" ? "Official" : "All content";
}

function signedPct(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  const rounded = Math.round(value * 100);
  if (rounded === 0) return "0%";
  return rounded > 0 ? `+${rounded}%` : `${rounded}%`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="type-numeric text-lg font-semibold">{value}</dd>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="type-numeric text-sm font-semibold leading-5">{value}</dd>
    </div>
  );
}

export function FeedbackCohortSummaryCard({
  summary,
  outcomeSummary,
  isLoading = false,
}: {
  summary?: FeedbackCohortSummary | null;
  outcomeSummary?: FeedbackOutcomeSummary | null;
  isLoading?: boolean;
}) {
  const top = summary?.top_q_type ?? summary?.q_type_cohorts?.[0] ?? null;
  const policy = top?.selector_policy ?? null;
  const outcome = top?.outcome_evidence ?? null;
  const readiness = outcomeSummary?.summary ?? null;
  const bestLiftLabel = readiness?.best_lift_q_type
    ? `${readiness.best_lift_q_type} ${actionLabel(readiness.best_lift_action)}`
    : "n/a";
  return (
    <Card
      className="shadow-e1"
      role="region"
      aria-labelledby="feedback-cohorts-title"
    >
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle id="feedback-cohorts-title" className="text-base">
              Plan feedback cohorts
            </CardTitle>
            <CardDescription>
              Accepted, skipped, and reopened plan work by question type.
            </CardDescription>
          </div>
          <Badge variant="secondary">
            {summary?.window_days ? `${summary.window_days}d` : "all time"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div
            aria-label="Plan feedback cohorts loading"
            className="grid gap-3 sm:grid-cols-4"
          >
            {["Accepted", "Skipped", "Minutes", "Top type"].map((label) => (
              <div key={label} className="space-y-2">
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className="h-6 w-20 rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : !summary?.total ? (
          <EmptyState
            title="No plan feedback yet"
            description="Complete, skip, or reopen a ranked plan task to start the cohort signal."
          />
        ) : (
          <div className="space-y-4">
            <dl className="grid gap-3 sm:grid-cols-4">
              <Metric label="Accepted" value={pct(summary.completion_rate)} />
              <Metric label="Skipped" value={pct(summary.skip_rate)} />
              <Metric
                label="Minutes"
                value={String(Math.round(summary.minutes_completed ?? 0))}
              />
              <Metric label="Top type" value={top?.q_type ?? "n/a"} />
            </dl>
            {top ? (
              <div className="rounded-md border bg-muted/25 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">{top.q_type}</p>
                  <Badge
                    variant={
                      top.sequencing_hint === "cool_down" ? "warning" : "outline"
                    }
                  >
                    {hintLabel(top.sequencing_hint)}
                  </Badge>
                </div>
                <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-4">
                  <Metric label="Events" value={String(top.total)} />
                  <Metric label="Accepted" value={pct(top.completion_rate)} />
                  <Metric label="Sequence" value={sequenceLabel(top)} />
                  <Metric label="Status" value={statusLabel(top.status)} />
                </dl>
              </div>
            ) : null}
            {top ? (
              <details className="rounded-md border bg-background p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  Why selected
                </summary>
                <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-4">
                  <MiniMetric
                    label="Policy"
                    value={hintLabel(policy?.sequencing_hint ?? top.sequencing_hint)}
                  />
                  <MiniMetric
                    label="Evidence"
                    value={`${policy?.evidence_events ?? top.total} events`}
                  />
                  <MiniMetric
                    label="Adjustment"
                    value={signedPct(policy?.selector_adjustment)}
                  />
                  <MiniMetric
                    label="Multiplier"
                    value={sequenceLabel(top)}
                  />
                </dl>
                <p className="mt-2 text-xs text-muted-foreground">
                  {policy?.model ?? "ability_feedback_policy_v1"} weighs accepted,
                  skipped, and reopened plan work in the selected window.
                </p>
              </details>
            ) : null}
            {outcome ? (
              <div className="rounded-md border bg-background p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">Later outcomes</p>
                  <Badge variant="outline">{statusLabel(outcome.status)}</Badge>
                </div>
                <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-4">
                  <MiniMetric
                    label="Later attempts"
                    value={String(outcome.attempts_after_acceptance ?? 0)}
                  />
                  <MiniMetric
                    label="Later accuracy"
                    value={pct(outcome.accuracy_after_acceptance)}
                  />
                  <MiniMetric
                    label="Baseline"
                    value={pct(outcome.baseline_accuracy)}
                  />
                  <MiniMetric
                    label="Delta"
                    value={signedPct(outcome.delta_accuracy)}
                  />
                </dl>
              </div>
            ) : null}
            {outcomeSummary ? (
              <div className="rounded-md border bg-background p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">Planner lift readiness</p>
                  <Badge variant="outline">{statusLabel(readiness?.status)}</Badge>
                </div>
                <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-4">
                  <MiniMetric
                    label="Planner-ready"
                    value={String(readiness?.planner_ready_cohorts ?? 0)}
                  />
                  <MiniMetric
                    label="Best lift"
                    value={
                      readiness?.best_lift_delta != null
                        ? signedPct(readiness.best_lift_delta)
                        : "n/a"
                    }
                  />
                  <MiniMetric label="Source" value={sourceLabel(outcomeSummary.source)} />
                  <MiniMetric
                    label="Min sample"
                    value={`${outcomeSummary.min_attempts} + ${outcomeSummary.min_attempts}`}
                  />
                </dl>
                <p className="mt-2 text-xs text-muted-foreground">
                  {bestLiftLabel} can inform future planner weights only when both
                  baseline and later attempts meet the sample floor.
                </p>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
