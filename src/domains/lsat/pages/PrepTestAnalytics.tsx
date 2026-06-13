import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ClipboardList } from "lucide-react";
import { PageLayout } from "@/components/page-layout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { GapDumbbell, type GapRow } from "@/components/viz";
import { EmptyState, ErrorState, SkeletonChart } from "@/components/states";
import { usePrepTest, useSessions } from "@/lib/hooks";
import {
  reviewableSessions,
  useMultiSessionResults,
} from "@/lib/hooks/useReviewSessions";
import { getPtProgress } from "@/lib/ptProgress";
import { computeGapForSessions } from "@/lib/gapFromSessions";
import { qTypeLabel } from "@/lib/labels";
import { pct, formatMs, countLabel } from "@/lib/utils";
import type { ResultItem, SectionSummary } from "@/lib/types";

/** R4-E3 — per-PrepTest analytics from session results (client aggregate). */
export default function PrepTestAnalytics() {
  const { ptId } = useParams();
  const navigate = useNavigate();
  const id = Number(ptId);
  const pt = usePrepTest(id);
  const sessionsQ = useSessions();

  const sectionIds = useMemo(
    () => new Set((pt.data?.data.sections ?? []).map((s) => s.id)),
    [pt.data],
  );

  const ptSessions = useMemo(() => {
    const all = reviewableSessions(sessionsQ.data?.data ?? []);
    return all;
  }, [sessionsQ.data]);

  const multi = useMultiSessionResults(ptSessions.map((s) => s.id));

  const { linkedSessions, items, bySection, byType } = useMemo(() => {
    const linked: typeof ptSessions = [];
    const allItems: ResultItem[] = [];
    const sectionAcc = new Map<number, { correct: number; total: number; time: number }>();
    const typeAcc = new Map<
      string,
      { correct: number; total: number; time: number }
    >();

    for (const s of ptSessions) {
      const rows = multi.resultsBySessionId.get(s.id) ?? [];
      const ptRows = rows.filter(
        (it) =>
          it.question.section_id !== null &&
          sectionIds.has(it.question.section_id),
      );
      if (!ptRows.length) continue;
      linked.push(s);
      allItems.push(...ptRows);
      for (const it of ptRows) {
        const sid = it.question.section_id;
        if (sid === null) continue;
        const sec = sectionAcc.get(sid) ?? { correct: 0, total: 0, time: 0 };
        sec.total++;
        if (it.attempt.is_correct) sec.correct++;
        sec.time += it.attempt.time_ms;
        sectionAcc.set(sid, sec);

        const key = String(it.question.q_type);
        const t = typeAcc.get(key) ?? { correct: 0, total: 0, time: 0 };
        t.total++;
        if (it.attempt.is_correct) t.correct++;
        t.time += it.attempt.time_ms;
        typeAcc.set(key, t);
      }
    }

    return {
      linkedSessions: linked,
      items: allItems,
      bySection: sectionAcc,
      byType: typeAcc,
    };
  }, [ptSessions, multi.resultsBySessionId, sectionIds]);

  const gap = useMemo(
    () => computeGapForSessions(linkedSessions, multi.resultsBySessionId),
    [linkedSessions, multi.resultsBySessionId],
  );

  const gapRows: GapRow[] = gap.by_type.map((r) => ({
    q_type: r.q_type,
    timed: r.timed_accuracy,
    blindReview: r.br_accuracy,
  }));

  const local = getPtProgress(id);

  if (pt.isLoading || sessionsQ.isLoading || multi.isLoading) {
    return (
      <PageLayout title="PrepTest analytics" eyebrow="PREPTEST" icon={ClipboardList} width="lg">
        <SkeletonChart />
      </PageLayout>
    );
  }

  if (pt.isError || !pt.data?.data) {
    return (
      <PageLayout title="PrepTest analytics" eyebrow="PREPTEST" icon={ClipboardList} width="lg">
        <ErrorState
          error={pt.error}
          onRetry={() => void pt.refetch()}
        />
      </PageLayout>
    );
  }

  const detail = pt.data.data;
  const progress =
    detail.section_count > 0
      ? (detail.completed_sections / detail.section_count) * 100
      : 0;

  return (
    <PageLayout
      title={detail.name}
      eyebrow="PREPTEST"
      icon={ClipboardList}
      description="Section breakdowns and accuracy from sessions tied to this PrepTest."
      width="lg"
      actions={
        <Button variant="outline" size="sm" onClick={() => navigate("/preptests")}>
          All PrepTests
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Sections done" value={`${detail.completed_sections}/${detail.section_count}`} />
        <Stat
          label="Best score (local)"
          value={local.bestScore != null ? String(local.bestScore) : "—"}
        />
        <Stat label="Linked sessions" value={String(linkedSessions.length)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Progress</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Progress value={progress} className="h-2" />
          <p className="text-xs text-muted-foreground">
            {Math.round(progress)}% of sections marked complete on this PT.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sections</CardTitle>
          <CardDescription>Accuracy from attempts in each section of this test.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {(detail.sections as SectionSummary[]).map((sec) => {
            const agg = bySection.get(sec.id);
            const acc = agg && agg.total ? agg.correct / agg.total : null;
            const avgMs = agg && agg.total ? agg.time / agg.total : 0;
            return (
              <div
                key={sec.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{sec.type}</Badge>
                  <span>Section {sec.order}</span>
                  <span className="text-xs text-muted-foreground">
                    {sec.question_count} Q
                  </span>
                </div>
                <div className="flex items-center gap-3 tabular-nums">
                  {acc != null ? (
                    <>
                      <span>{pct(acc)}</span>
                      <span className="text-muted-foreground">{formatMs(avgMs)}</span>
                      <span className="text-xs text-muted-foreground">n={agg!.total}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">No attempts</span>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => navigate(`/take/${sec.id}`)}
                  >
                    Start
                  </Button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {items.length > 0 ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">By question type</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {[...byType.entries()]
                .sort((a, b) => b[1].total - a[1].total)
                .map(([key, agg]) => (
                  <div
                    key={key}
                    className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                  >
                    <span>{qTypeLabel(key)}</span>
                    <span className="tabular-nums">
                      {pct(agg.correct / agg.total)} · n={agg.total}
                    </span>
                  </div>
                ))}
            </CardContent>
          </Card>

          {gapRows.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Timed vs blind review</CardTitle>
                <CardDescription>
                  Aggregate gap across {countLabel(linkedSessions.length, "session")} for
                  this PrepTest.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <GapDumbbell rows={gapRows} />
              </CardContent>
            </Card>
          )}
        </>
      ) : (
        <EmptyState
          title="No session data for this PrepTest"
          description="Finish a timed section from this test to see breakdowns here."
          action={
            <Button onClick={() => navigate(`/exam/${id}`)}>Start full exam</Button>
          }
        />
      )}
    </PageLayout>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <p className="type-overline text-muted-foreground">{label}</p>
        <p className="stat text-2xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}
