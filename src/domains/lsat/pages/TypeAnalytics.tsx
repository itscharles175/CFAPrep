import { useNavigate, useParams } from "react-router-dom";
import { Crosshair } from "lucide-react";
import { PageLayout } from "@lsat/components/page-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@lsat/components/ui/card";
import { Button } from "@lsat/components/ui/button";
import { Badge } from "@lsat/components/ui/badge";
import { GapDumbbell, type GapRow } from "@lsat/components/viz";
import { EmptyState, SkeletonChart } from "@lsat/components/states";
import { useTypeAnalytics } from "@lsat/lib/hooks";
import { qTypeLabel } from "@lsat/lib/labels";
import { pct, formatMs } from "@lsat/lib/utils";
import type { QType } from "@lsat/lib/types";

const TREND_GLYPH: Record<string, string> = { up: "↑", down: "↓", flat: "→" };

function trapLabel(t: string): string {
  return t.replace(/_/g, " ");
}

/** R4-A2 / R5-B15 — per-type diagnostic drill-down from a single backend payload. */
export default function TypeAnalytics() {
  const { qType } = useParams();
  const navigate = useNavigate();
  const typeKey = decodeURIComponent(qType ?? "") as QType;
  const ta = useTypeAnalytics(typeKey);
  const data = ta.data?.data;

  if (ta.isLoading) {
    return (
      <PageLayout title="Type analysis" eyebrow="QUESTION TYPE" icon={Crosshair} width="lg">
        <SkeletonChart />
      </PageLayout>
    );
  }

  if (!data || data.overall.attempts === 0) {
    return (
      <PageLayout title={qTypeLabel(typeKey)} eyebrow="QUESTION TYPE" icon={Crosshair} width="lg">
        <EmptyState
          title="No attempts on this type yet"
          description="Drill it or take a section, then come back for a diagnosis."
          action={
            <Button onClick={() => navigate(`/drills?q_type=${encodeURIComponent(typeKey)}`)}>
              Drill this type
            </Button>
          }
        />
      </PageLayout>
    );
  }

  const { overall, gap, traps, recent_misses } = data;
  // Real timed-vs-BR gap from the backend (no more accuracy + 0.05 stub).
  const gapRow: GapRow | undefined =
    gap.n > 0
      ? { q_type: overall.q_type, timed: gap.timed_accuracy, blindReview: gap.br_accuracy }
      : undefined;

  return (
    <PageLayout
      title={qTypeLabel(typeKey)}
      eyebrow="QUESTION TYPE"
      icon={Crosshair}
      description="Why you're missing this type — timing, traps, and recent errors."
      width="lg"
      actions={
        <Button
          size="sm"
          onClick={() => navigate(`/drills?q_type=${encodeURIComponent(typeKey)}`)}
        >
          Drill this type
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="Accuracy"
          value={pct(overall.accuracy)}
          hint={`${TREND_GLYPH[overall.trend] ?? ""} trend`}
        />
        <Stat label="Avg time" value={formatMs(overall.avg_time_ms)} />
        <Stat label="Attempts" value={String(overall.attempts)} />
      </div>

      {gapRow ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Timed vs blind review</CardTitle>
          </CardHeader>
          <CardContent>
            <GapDumbbell rows={[gapRow]} />
            <p className="mt-2 text-xs text-muted-foreground">
              {gap.gap > 0.05
                ? "You recover this type in blind review — a timing/pressure problem."
                : gap.gap < -0.02
                  ? "Blind review doesn't recover it — a concept gap."
                  : "Timed and blind-review accuracy are close."}{" "}
              ({gap.n} reviewed)
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Timed vs blind review</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              No blind-review data for this type yet.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Traps you fall for here</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {traps.length ? (
            traps.map((t) => (
              <div
                key={t.trap_type}
                className="flex items-center justify-between text-sm"
              >
                <span className="capitalize">{trapLabel(t.trap_type)}</span>
                <span className="text-muted-foreground tabular-nums">
                  {t.times_fell_for}× · {pct(t.pct)}
                </span>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              No trap pattern yet — you haven't missed enough of this type.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent misses</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {recent_misses.length ? (
            recent_misses.map((m) => (
              <div
                key={m.question_id}
                className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
              >
                <span className="text-muted-foreground">
                  chose <Badge variant="outline">{m.chosen_answer ?? "—"}</Badge>
                  {" · correct "}
                  <Badge variant="outline">{m.correct_answer ?? "—"}</Badge>
                  {" · "}
                  {formatMs(m.time_ms)}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigate(`/explanation/${m.question_id}`)}
                >
                  Open
                </Button>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No recent misses for this type.</p>
          )}
        </CardContent>
      </Card>
    </PageLayout>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <p className="type-overline text-muted-foreground">{label}</p>
        <p className="stat text-2xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}
