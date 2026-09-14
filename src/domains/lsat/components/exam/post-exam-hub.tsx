import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { OutcomeFunnel } from "@lsat/components/analytics/outcome-funnel";
import { Ceremony } from "@lsat/components/exam/ceremony";
import { useSessionResults } from "@lsat/lib/hooks";
import { api } from "@lsat/lib/api";
import { BarChart3, Flag, PlayCircle, Target } from "lucide-react";
import { Button } from "@lsat/components/ui/button";
import { Badge } from "@lsat/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@lsat/components/ui/card";
import { SampleDataRecovery } from "@lsat/components/sample-data-recovery";
import { pct } from "@lsat/lib/utils";
import type { SectionSummary } from "@lsat/lib/types";

export function PostExamHub({
  examName,
  sections,
  sessionIds,
  examSessionId,
  onBlindReview,
}: {
  examName: string;
  sections: SectionSummary[];
  sessionIds: Record<number, number | null>;
  examSessionId: number | null;
  onBlindReview: () => void;
}) {
  const navigate = useNavigate();
  const lastIdx = sections.length - 1;
  const lastSid = examSessionId ?? sessionIds[lastIdx];
  const results = useSessionResults(lastSid ?? 0);
  const resultsAreSample = results.data?.usingSample ?? false;
  const outcomeItems = (resultsAreSample ? [] : results.data?.data.items ?? []).filter(
    (it) => it.attempt.outcome != null,
  );
  // C10 — combined PrepTest score across all sections (official questions only).
  const examResults = useQuery({
    queryKey: ["exam-results", examSessionId],
    queryFn: () => api.examResults(examSessionId as number),
    enabled: examSessionId != null,
    staleTime: 30_000,
  });
  const score = examResults.data;

  return (
    <Ceremony
      eyebrow="Exam complete"
      title={examName}
      counsel="All sections finished. Review pacing below, then blind-review your flagged and unsure questions."
      actions={
        <div className="grid w-full max-w-lg gap-2 sm:grid-cols-2">
          <Button size="lg" className="sm:col-span-2" onClick={onBlindReview}>
            <PlayCircle className="h-4 w-4" />
            Start blind review
          </Button>
          <Button variant="outline" onClick={() => navigate("/review?tab=errors")}>
            <Flag className="h-4 w-4" />
            Error log
          </Button>
          <Button variant="outline" onClick={() => navigate("/analytics")}>
            <BarChart3 className="h-4 w-4" />
            Analytics
          </Button>
          <Button variant="outline" onClick={() => navigate("/practice")}>
            <Target className="h-4 w-4" />
            Practice hub
          </Button>
          <Button variant="ghost" onClick={() => navigate("/")}>
            Dashboard
          </Button>
        </div>
      }
    >
      <div className="mx-auto w-full max-w-lg space-y-4">
        {score && score.scaled_score != null && (
          <Card className="aurora border-primary/30">
            <CardHeader>
              <CardTitle className="text-base">Estimated PrepTest score</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-end justify-center gap-x-8 gap-y-2 text-center">
                <div>
                  <div className="type-numeric text-stat font-bold text-primary">
                    {score.scaled_score}
                  </div>
                  <div className="type-overline text-muted-foreground">
                    scaled (120–180)
                  </div>
                </div>
                <div>
                  <div className="type-numeric text-2xl font-semibold">
                    {score.official_correct}/{score.official_total}
                  </div>
                  <div className="type-overline text-muted-foreground">
                    official correct
                  </div>
                </div>
              </div>
              <p className="mt-3 text-center text-2xs text-muted-foreground">
                Scored from official questions only — AI/research items never affect
                your score.
              </p>
            </CardContent>
          </Card>
        )}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Sections</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {sections.map((s) => {
              const secScore = score?.sections.find((x) => x.section_id === s.id);
              return (
                <div
                  key={s.id}
                  className="flex items-center justify-between rounded-card border p-3 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <Badge variant="secondary">{s.type}</Badge>
                    Section {s.order}
                  </span>
                  <span className="type-numeric text-muted-foreground">
                    {secScore ? (
                      <span className="font-medium text-foreground">
                        {secScore.correct}/{secScore.total} ({pct(secScore.accuracy)})
                      </span>
                    ) : (
                      `${s.question_count} Q`
                    )}
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>
        {resultsAreSample ? (
          <SampleDataRecovery
            section="Outcome breakdown"
            onRetry={() => void results.refetch()}
          />
        ) : results.isError ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Outcome breakdown unavailable</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                Your completed exam is saved, but its outcome breakdown could not load.
              </p>
              <Button variant="outline" size="sm" onClick={() => void results.refetch()}>
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : outcomeItems.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Outcome breakdown</CardTitle>
            </CardHeader>
            <CardContent>
              <OutcomeFunnel items={outcomeItems} />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </Ceremony>
  );
}
