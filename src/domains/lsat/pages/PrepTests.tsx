import { useNavigate } from "react-router-dom";
import { CheckCircle2, FileText, PlayCircle } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@lsat/components/ui/icon";
import { Progress } from "@lsat/components/ui/progress";
import { ProgressRing } from "@lsat/components/viz";
import { getPtProgress } from "@lsat/lib/ptProgress";
import { PageLayout } from "@lsat/components/page-layout";
import { IllustrationPrepTests } from "@lsat/components/illustrations";
import { LoadingState, ErrorState, EmptyState } from "@lsat/components/states";
import { useQueryClient } from "@tanstack/react-query";
import {
  prefetchPrepTest,
  prefetchSection,
  usePrepTests,
  usePrepTest,
  usePrepTestProgress,
} from "@lsat/lib/hooks";
import type { PrepTestSummary } from "@lsat/lib/types";

export default function PrepTests() {
  const navigate = useNavigate();
  const { data, isLoading, isError, error, refetch } = usePrepTests();
  if (isLoading) return <LoadingState label="Loading PrepTests…" />;
  if (isError || !data) return <ErrorState error={error} onRetry={refetch} />;
  const tests = data.data;

  return (
    <PageLayout
      title="PrepTests"
      eyebrow="LIBRARY"
      icon={FileText}
      description="Your imported official tests — track section progress and start full timed exams."
      width="xl"
      actions={
        data.usingSample ? (
          <Badge variant="outline" className="text-muted-foreground">
            Sample data
          </Badge>
        ) : undefined
      }
    >
      {tests.length === 0 ? (
        <EmptyState
          illustration={<IllustrationPrepTests />}
          title="No PrepTests yet"
          description="Import a PDF to add your first official test."
          action={
            <Button onClick={() => navigate("/import")}>Go to Import</Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {tests.map((t) => (
            <PrepTestCard key={t.id} test={t} />
          ))}
        </div>
      )}
    </PageLayout>
  );
}

function PrepTestCard({ test }: { test: PrepTestSummary }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data } = usePrepTest(test.id);
  const detail = data?.data;
  // H3 — real per-section progress from the backend, localStorage as fallback.
  const prog = usePrepTestProgress(test.id);
  const p = prog.data?.data;
  const hasServer = !!p && p.sections.length > 0;
  const local = getPtProgress(test.id);
  const sectionCount = test.section_count || p?.section_count || 0;
  const sectionsDone = hasServer ? p!.sections_done : test.completed_sections;
  const done = sectionCount > 0 && sectionsDone >= sectionCount;
  const progress = sectionCount > 0 ? (sectionsDone / sectionCount) * 100 : 0;
  const brPct = progress / 100;
  const bestScore = hasServer
    ? p!.sections.reduce<number | null>(
        (m, s) => (s.best_score != null ? Math.max(m ?? 0, s.best_score) : m),
        null,
      )
    : local.bestScore;
  const doneIds = new Set(
    (p?.sections ?? []).filter((s) => s.done).map((s) => s.section_id),
  );

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="min-w-0 truncate text-base">{test.name}</CardTitle>
          {test.is_official ? (
            <Badge variant="secondary" className="shrink-0">Official</Badge>
          ) : (
            <Badge variant="outline" className="shrink-0 max-w-[8rem] truncate">{test.source}</Badge>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon as={FileText} size="xs" />
          {test.section_count} sections
          {test.date_admin && ` · ${test.date_admin}`}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="flex items-center gap-4">
          <ProgressRing
            value={brPct}
            size={56}
            strokeWidth={5}
            label={
              <span className="text-[10px] tabular-nums">
                {Math.round(brPct * 100)}%
              </span>
            }
            sublabel="sections"
          />
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                {test.completed_sections}/{test.section_count} complete
              </span>
              {done && (
                <span className="flex items-center gap-1 text-success">
                  <Icon as={CheckCircle2} size="xs" /> done
                </span>
              )}
            </div>
            <Progress value={progress} />
            {bestScore != null && (
              <p className="mt-1 text-xs text-muted-foreground">
                Best section score: <strong>{bestScore}</strong>
              </p>
            )}
          </div>
        </div>

        {detail && (
          <div className="flex flex-wrap gap-1.5">
            {detail.sections.map((s) => (
              <Button
                key={s.id}
                variant={doneIds.has(s.id) ? "secondary" : "outline"}
                size="sm"
                onPointerEnter={() => prefetchSection(qc, s.id)}
                onPointerDown={() => prefetchSection(qc, s.id)}
                onClick={() => navigate(`/take/${s.id}`)}
              >
                {doneIds.has(s.id) && <Icon as={CheckCircle2} size="xs" />}
                {s.type} S{s.order}
              </Button>
            ))}
          </div>
        )}

        <div className="mt-auto pt-2">
          <Button
            className="w-full"
            onPointerEnter={() => prefetchPrepTest(qc, test.id)}
            onPointerDown={() => prefetchPrepTest(qc, test.id)}
            // The full timed exam is the multi-section /exam/:preptestId flow
            // (breaks between sections, combined scaled score). Routing to
            // /take/:sectionId would only run section 1 as a standalone section.
            onClick={() => navigate(`/exam/${test.id}`)}
          >
            <Icon as={PlayCircle} size="sm" /> Start full timed exam
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
