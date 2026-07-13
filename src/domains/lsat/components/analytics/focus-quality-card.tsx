import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@lsat/components/ui/card";
import { FocusTimeline, type FocusEvent } from "@lsat/components/viz";
import { useFocusQuality } from "@lsat/lib/hooks";
import type { ResultItem } from "@lsat/lib/types";

const COMPONENT_META: Record<
  string,
  { label: string; goodHigh: boolean; fmt: (v: number) => string }
> = {
  pacing_consistency: {
    label: "Pacing consistency",
    goodHigh: true,
    fmt: (v) => `${Math.round(v * 100)}%`,
  },
  flag_rate: {
    label: "Flag rate",
    goodHigh: false,
    fmt: (v) => `${Math.round(v * 100)}%`,
  },
  timing_problem_rate: {
    label: "Timing problems",
    goodHigh: false,
    fmt: (v) => `${Math.round(v * 100)}%`,
  },
};

/**
 * C11 + B4 — backend focus score for a session plus a per-question timeline of
 * time spent / flags / BR-corrected lapses.
 */
export function FocusQualityCard({
  sessionId,
  items,
  target,
}: {
  sessionId: number;
  items: ResultItem[];
  target?: number;
}) {
  const fq = useFocusQuality(sessionId);
  const data = fq.data?.data;

  const events: FocusEvent[] = items.map((it, i) => ({
    order: i + 1,
    seconds: Math.round(it.attempt.time_ms / 1000),
    flagged: !!it.attempt.flagged,
    correct: it.attempt.is_correct,
    brCorrected: !it.attempt.is_correct && it.attempt.br_correct === true,
  }));

  if ((!data || data.score == null) && events.length === 0) return null;

  const score = data?.score ?? null;
  const band =
    score == null
      ? "text-muted-foreground"
      : score >= 75
        ? "text-success"
        : score >= 50
          ? "text-warning"
          : "text-destructive";

  return (
    <Card className="shadow-e1">
      <CardHeader>
        <CardTitle className="text-base">Focus quality</CardTitle>
        <CardDescription>
          Pacing steadiness, flag discipline, and pressure lapses for this
          session — flags sit above each question’s time bar.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <div className="flex items-end gap-1.5">
            <span className={`stat text-3xl font-bold tabular-nums ${band}`}>
              {score != null ? Math.round(score) : "—"}
            </span>
            <span className="pb-1 text-xs text-muted-foreground">/ 100</span>
          </div>
          {data &&
            Object.entries(data.components).map(([k, v]) => {
              const meta = COMPONENT_META[k];
              if (!meta) return null;
              return (
                <div key={k} className="space-y-0.5">
                  <div className="type-overline text-muted-foreground">
                    {meta.label}
                  </div>
                  <div className="text-sm font-medium tabular-nums">
                    {meta.fmt(v)}
                  </div>
                </div>
              );
            })}
        </div>
        {events.length > 0 && <FocusTimeline events={events} target={target} />}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted-foreground">
          <Legend color="hsl(var(--success))" label="Correct" />
          <Legend color="hsl(var(--warning))" label="BR-corrected lapse" />
          <Legend color="hsl(var(--destructive))" label="Missed" />
        </div>
      </CardContent>
    </Card>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="h-2.5 w-2.5 rounded-sm"
        style={{ background: color }}
        aria-hidden
      />
      {label}
    </span>
  );
}
