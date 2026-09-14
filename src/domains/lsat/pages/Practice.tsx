import { useNavigate } from "react-router-dom";
import { Clock, Flag, PlayCircle, Target } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageLayout } from "@lsat/components/page-layout";
import { ResumeBanner } from "@lsat/components/practice/resume-banner";
import { ErrorState, SkeletonListPage } from "@lsat/components/states";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  prefetchPrepTest,
  prefetchSection,
  usePrepTest,
  usePrepTests,
  useSrsDue,
} from "@lsat/lib/hooks";
import type { PrepTestDetail, PrepTestSummary } from "@lsat/lib/types";
import { StudyPtWizard } from "@lsat/components/practice/study-pt-wizard";
import { formatClock } from "@lsat/lib/utils";
import { SampleDataRecovery } from "@lsat/components/sample-data-recovery";
import "./selection-pages.css";

/** R4-B1 — unified practice hub. */
export default function Practice() {
  const pts = usePrepTests();
  const srs = useSrsDue();
  const srsIsSample = srs.data?.usingSample ?? false;
  const list = pts.data?.data ?? [];

  if (pts.isLoading) {
    return <SkeletonListPage width="lg" />;
  }
  if (pts.isError) {
    return (
      <PageLayout title="Practice" width="lg">
        <ErrorState error={pts.error} onRetry={pts.refetch} />
      </PageLayout>
    );
  }

  const primaryId = list[0]?.id;
  if (primaryId == null) {
    return (
      <PracticeWorkspace
        list={list}
        srsIsSample={srsIsSample}
      />
    );
  }

  return (
    <PracticeWithPrimary
      list={list}
      primaryId={primaryId}
      listIsSample={pts.data?.usingSample ?? false}
      srsIsSample={srsIsSample}
      onRetry={() => Promise.all([pts.refetch(), srs.refetch()]).then(() => undefined)}
    />
  );
}

/**
 * Keep the detail query mounted only when the list supplied a real server id.
 * An empty personal bank is a normal state; inventing id=1 here used to turn
 * it into a misleading `GET /api/preptests/1` 404.
 */
function PracticeWithPrimary({
  list,
  primaryId,
  listIsSample,
  srsIsSample,
  onRetry,
}: {
  list: PrepTestSummary[];
  primaryId: number;
  listIsSample: boolean;
  srsIsSample: boolean;
  onRetry: () => Promise<void>;
}) {
  const primary = usePrepTest(primaryId);

  if (primary.isLoading) {
    return <SkeletonListPage width="lg" />;
  }
  if (primary.isError) {
    return (
      <PageLayout title="Practice" width="lg">
        <ErrorState error={primary.error} onRetry={primary.refetch} />
      </PageLayout>
    );
  }

  // A fallback PrepTest/SRS envelope is useful to exercise the renderer, not
  // evidence that the learner has a due queue or a diagnostic. Keep the hub
  // recoverable and quiet until the sidecar returns real data.
  const prepTestsAreSample = listIsSample || primary.data?.usingSample;
  if (prepTestsAreSample) {
    return (
      <PageLayout
        title="Practice"
        description="Timed sections, drills, SRS, and blind review — one place to start."
        width="2xl"
        className="lsat-selection-page lsat-practice-page"
      >
        <SampleDataRecovery
          section="Practice"
          affectedSections={["PrepTests and timed sections", "Review queue", "SRS workload"]}
          onRetry={() => {
            return Promise.all([onRetry(), primary.refetch()]).then(() => undefined);
          }}
        />
      </PageLayout>
    );
  }

  const detail = primary.data?.data;

  return <PracticeWorkspace list={list} detail={detail} srsIsSample={srsIsSample} />;
}

function PracticeWorkspace({
  list,
  detail,
  srsIsSample,
}: {
  list: PrepTestSummary[];
  detail?: PrepTestDetail;
  srsIsSample: boolean;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [wizardOpen, setWizardOpen] = useState(false);

  return (
    <PageLayout
      title="Practice"
      description="Timed sections, drills, SRS, and blind review — one place to start."
      width="2xl"
      className="lsat-selection-page lsat-practice-page"
    >
      <ResumeBanner />

      <div className="lsat-practice-actions">
        <ActionCard
          icon={<Clock className="h-5 w-5" />}
          title="Timed section"
          description="Full section under real timing, then blind review."
          action="Sections below"
          onClick={() =>
            document.getElementById("pt-sections")?.scrollIntoView({ behavior: "smooth" })
          }
        />
        <ActionCard
          icon={<Target className="h-5 w-5" />}
          title="Targeted drill"
          description="Type, difficulty, and count."
          action="Open drills"
          onClick={() => navigate("/drills")}
        />
        <ActionCard
          icon={<Flag className="h-5 w-5" />}
          title="Review queue"
          description={
            srsIsSample
              ? "SRS workload is unavailable until the LSAT backend reconnects."
              : "Buckets, error log, SRS."
          }
          action="Open review"
          onClick={() => navigate("/review")}
        />
      </div>

      {list.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent PrepTests</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {list.slice(0, 5).map((pt) => (
              <Button
                key={pt.id}
                variant="outline"
                size="sm"
                onPointerEnter={() => prefetchPrepTest(qc, pt.id)}
                onPointerDown={() => prefetchPrepTest(qc, pt.id)}
                onClick={() => navigate(`/exam/${pt.id}`)}
              >
                {pt.name}
              </Button>
            ))}
            <Button variant="ghost" size="sm" onClick={() => navigate("/preptests")}>
              View all
            </Button>
          </CardContent>
        </Card>
      )}

      <Card id="pt-sections" className="lsat-selection-card lsat-practice-sections">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            {detail?.name ?? "PrepTest"} · sections
          </CardTitle>
          {detail && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setWizardOpen(true)}>
                Study plan
              </Button>
              <Button
                size="sm"
                onPointerEnter={() => prefetchPrepTest(qc, detail.id)}
                onPointerDown={() => prefetchPrepTest(qc, detail.id)}
                onClick={() => navigate(`/exam/${detail.id}`)}
              >
                <PlayCircle className="h-4 w-4" /> Full exam
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent className="lsat-section-list">
          {detail?.sections?.length ? (
            <div className="lsat-section-list">
            {detail.sections.map((s) => (
              <div
                key={s.id}
                className="lsat-section-row"
              >
                <div className="flex items-center gap-3">
                  <Badge variant="secondary">{s.type}</Badge>
                  <span className="text-sm font-medium">Section {s.order}</span>
                  <span className="text-xs text-muted-foreground">
                    {s.question_count} Q · {formatClock(s.time_limit_sec)}
                  </span>
                </div>
                <Button
                  size="sm"
                  onPointerEnter={() => prefetchSection(qc, s.id)}
                  onPointerDown={() => prefetchSection(qc, s.id)}
                  onClick={() => navigate(`/take/${s.id}`)}
                >
                  Start timed
                </Button>
              </div>
            ))}
            </div>
          ) : (
            <div className="lsat-inline-empty">
              <span>No sections available yet.</span>
              <Button variant="link" className="h-auto p-0" onClick={() => navigate("/import")}>
                Import a PrepTest
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {detail && (
        <StudyPtWizard
          detail={detail}
          open={wizardOpen}
          onOpenChange={setWizardOpen}
        />
      )}
    </PageLayout>
  );
}

function ActionCard({
  icon,
  title,
  description,
  action,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action: string;
  onClick?: () => void;
}) {
  return (
    <Card className="lsat-selection-card lsat-action-card flex flex-col" interactive>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        <p className="flex-1 text-sm text-muted-foreground">{description}</p>
        <Button size="sm" className="mt-3" onClick={onClick}>
          {action}
        </Button>
      </CardContent>
    </Card>
  );
}
