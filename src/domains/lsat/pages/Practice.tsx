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
import { PageLayout } from "@/components/page-layout";
import { ResumeBanner } from "@/components/practice/resume-banner";
import { ErrorState, SkeletonListPage } from "@/components/states";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  prefetchPrepTest,
  prefetchSection,
  usePrepTest,
  usePrepTests,
  useSrsDue,
} from "@/lib/hooks";
import { StudyPtWizard } from "@/components/practice/study-pt-wizard";
import { formatClock } from "@/lib/utils";

/** R4-B1 — unified practice hub. */
export default function Practice() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const pts = usePrepTests();
  const srs = useSrsDue();
  const due = srs.data?.data.due_count ?? 0;
  const list = pts.data?.data ?? [];
  const primaryId = list[0]?.id ?? 1;
  const primary = usePrepTest(primaryId);
  const [wizardOpen, setWizardOpen] = useState(false);

  if (pts.isLoading || primary.isLoading) {
    return <SkeletonListPage width="lg" />;
  }
  if (pts.isError) {
    return (
      <PageLayout title="Practice" width="lg">
        <ErrorState error={pts.error} onRetry={pts.refetch} />
      </PageLayout>
    );
  }

  const detail = primary.data?.data;

  return (
    <PageLayout
      title="Practice"
      description="Timed sections, drills, SRS, and blind review — one place to start."
      width="lg"
    >
      <ResumeBanner />

      <div className="grid gap-4 sm:grid-cols-3">
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
          description="Buckets, error log, SRS."
          action={due > 0 ? `${due} SRS due · Review` : "Open review"}
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

      <Card id="pt-sections">
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
        <CardContent className="space-y-2">
          {detail?.sections.length ? (
            detail.sections.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between rounded-md border p-3"
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
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              No sections available.{" "}
              <Button variant="link" className="h-auto p-0" onClick={() => navigate("/import")}>
                Import a PrepTest
              </Button>
            </p>
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
    <Card className="flex flex-col">
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
