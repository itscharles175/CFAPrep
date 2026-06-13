import { lazy, Suspense, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { m, useReducedMotion } from "motion/react";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  BrainCircuit,
  LayoutDashboard,
  ShieldCheck,
  Target,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@lsat/components/ui/card";
import { Button } from "@lsat/components/ui/button";
import { Badge } from "@lsat/components/ui/badge";
import { Icon } from "@lsat/components/ui/icon";
import { MotionCard } from "@lsat/components/ui/motion-card";
import { PageLayout } from "@lsat/components/page-layout";
import { ErrorState, Skeleton } from "@lsat/components/states";
import { DashboardSkeleton } from "@lsat/components/dashboard/dashboard-skeleton";
import { FirstLightConsole } from "@lsat/components/dashboard/first-light-console";
// R10 A1.1 — StatNumber/TypeBadge come from their DIRECT paths, not the
// `@/components/viz` barrel: the barrel co-exports the visx-heavy TrendChart,
// so a barrel import would drag that chart vendor back onto first paint even
// though TrendChart itself is lazy()'d below.
import { StatNumber } from "@lsat/components/viz/StatNumber";
import { TypeBadge } from "@lsat/components/viz/TypeBadge";
import type { TrendDatum } from "@lsat/components/viz/TrendChart";
import {
  Countdown,
  ReadinessCard,
  RecommendationInbox,
  SessionRecap,
  StudyNudge,
  TodayPlan,
} from "@lsat/components/motivation";
import { UtilityTradeoffChips } from "@lsat/components/motivation/utility-tradeoff-chips";

const DashboardBelowFold = lazy(
  () => import("@lsat/components/motivation/dashboard-below-fold"),
);

// R10 A1.1 — the ~37KB visx chart vendor is split off the Dashboard's
// first-paint critical path. The chart sits below the instrument cluster, so it
// streams in behind a reserved-height fallback after the focal cards render.
const TrendChart = lazy(() =>
  import("@lsat/components/viz/TrendChart").then((m) => ({ default: m.TrendChart })),
);
import { NarrativeCards } from "@lsat/components/analytics/NarrativeCards";
import { ResumeHero } from "@lsat/components/practice/resume-hero";
import { AnalyticsAlerts } from "@lsat/components/analytics/analytics-alerts";
import { buildWeeklyReportHtml, downloadWeeklyReport } from "@lsat/lib/weeklyReport";
import {
  useActivity,
  useAdaptivityPlan,
  useBlindReviewGap,
  useByType,
  useCoach,
  useContentHealth,
  useDashboard,
  useForecast,
  useReadinessStatus,
  useReleaseTrust,
  useSessionResults,
  useSessions,
  useSrsDue,
} from "@lsat/lib/hooks";
import { forecastConeBands } from "@lsat/lib/forecast";
import type {
  AdaptivityPlan,
  ByTypeRow,
  ReadinessStatus,
  ReleaseTrustManifest,
  SessionSummary,
} from "@lsat/lib/types";
import { getGoal } from "@lsat/lib/prefs";
import { liveReadinessStatus, readinessFromStatus } from "@lsat/lib/readiness";
import { computeMilestoneUnlocks } from "@lsat/lib/milestones";
import { stagger, fadeUp } from "@lsat/lib/motion";
import { formatMs, pct } from "@lsat/lib/utils";
import { formatUtilityPriority, utilityTradeoffs } from "@lsat/lib/utilityTradeoffs";
import type { Trend } from "@lsat/lib/types";

function TrendIcon({ trend }: { trend: Trend }) {
  if (trend === "up")
    return <Icon as={ArrowUpRight} size="sm" className="text-success" />;
  if (trend === "down")
    return <Icon as={ArrowDownRight} size="sm" className="text-destructive" />;
  return <Icon as={ArrowRight} size="sm" className="text-muted-foreground" />;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  const { data, isLoading, isError, error, refetch } = useDashboard();
  // Below-fold queries are gated on the above-fold data having resolved so the
  // initial paint (hero stats) isn't delayed by 8 parallel network requests.
  const aboveFoldReady = !!data;
  const activity = useActivity(180, { enabled: aboveFoldReady });
  const sessions = useSessions({ enabled: aboveFoldReady });
  const byType = useByType("all", undefined, { enabled: aboveFoldReady });
  const gap = useBlindReviewGap(undefined, { enabled: aboveFoldReady });
  const srs = useSrsDue({ enabled: aboveFoldReady });

  const coachSnap = useCoach();
  const vnextPlan = useAdaptivityPlan(60);
  const vnextReadiness = useReadinessStatus();
  const contentHealth = useContentHealth();
  const releaseTrust = useReleaseTrust("dev");

  const goal = useMemo(getGoal, []);
  const forecast = useForecast(goal?.examDate ?? null, goal?.targetScore ?? null);
  const fc = forecast.data?.data;

  if (isLoading) {
    return (
      <PageLayout title="Welcome back" eyebrow="Console" icon={LayoutDashboard} width="2xl">
        <div role="status" aria-busy="true" aria-label="Loading your dashboard">
          <DashboardSkeleton />
        </div>
      </PageLayout>
    );
  }
  if (isError || !data) {
    return (
      <PageLayout title="Dashboard" eyebrow="Console" icon={LayoutDashboard} width="2xl">
        <ErrorState error={error} onRetry={refetch} />
      </PageLayout>
    );
  }

  const d = data.data;
  const delta = d.score_delta_30d;
  const predictedScore = d.predicted_score;
  const safeDelta = delta ?? 0;

  // R9 F3.2 — honest first-run predicate. The fabrication problem only exists
  // when the screen is on SAMPLE data (the `usingSample` envelope): the offline
  // fallback also serves sample *sessions*, so a raw session COUNT is sample
  // noise, not a real signal. So "genuinely new" = the dashboard AND the
  // sessions query are both on sample data AND no real goal was ever set. When
  // a real backend is reachable, its (possibly empty) numbers are honest and we
  // show the normal Console. No backend — derived purely from existing flags.
  const sessionsAreSample = sessions.data?.usingSample ?? false;
  const isBrandNew = data.usingSample && sessionsAreSample && goal == null;

  if (isBrandNew) {
    return (
      <PageLayout
        title="First light"
        eyebrow="Console"
        icon={LayoutDashboard}
        width="2xl"
      >
        <FirstLightConsole />
      </PageLayout>
    );
  }

  // A5 — prefer the cached coach snapshot (scheduled by the worker) over the
  // dashboard's local evidence-backed fallback if no snapshot exists yet.
  const snap = coachSnap.data?.data;
  const coachText = snap?.available && snap.text ? snap.text : d.coach.text;
  const coachRec = (snap?.available && snap.recommendation) || d.coach.recommendation;

  // Readiness signals — already feed <ReadinessCard> below; lifted here so the
  // engraved hero's serif counsel line can speak from the same numbers (no new
  // data / API). All four sources are existing dashboard queries.
  const timedAccuracy = accuracyFromByType(byType.data?.data ?? []);
  const sessions7d = sessionsLast7(sessions.data?.data ?? []);
  const srsDue = srs.data?.data.due_count ?? 0;
  const brGap = gap.data?.data.gap ?? 0;
  const backendReadiness = liveReadinessStatus(vnextReadiness.data);
  const readinessInput = {
    streakDays: d.streak_days,
    srsDue,
    timedAccuracy,
    brGap,
    sessionsLast7d: sessions7d,
    targetScore: goal?.targetScore,
    predictedScore: predictedScore ?? undefined,
  };
  const readiness = readinessFromStatus(backendReadiness, readinessInput);
  // One short serif sentence beneath the figure. Reads the readiness verdict
  // (existing heuristic) and the 30-day trajectory (existing delta) into
  // counsel-voice copy — no new copy source.
  const heroCounsel = readinessCounsel(readiness.label, delta);

  const trendSeries: TrendDatum[] = d.trend.map((p) => ({
    date: p.date,
    score: p.score,
  }));
  const fallbackProjectionScore =
    predictedScore != null
      ? predictedScore + Math.max(0, safeDelta)
      : trendSeries.at(-1)?.score;
  // R9 — earliest practice date (first trend point) feeds Countdown's
  // prep-window elapsed arc. Real data already on the dashboard; no new query.
  const prepStartDate = d.trend[0]?.date;

  // Most-recent finished section for the recap.
  const recentSession = (sessions.data?.data ?? []).find(
    (s) => s.scaled_score != null,
  );

  return (
    <PageLayout
      title="Welcome back"
      eyebrow="Console"
      icon={LayoutDashboard}
      width="2xl"
      actions={
        data.usingSample ? (
          <Badge variant="outline" className="text-muted-foreground">
            Sample data (backend offline)
          </Badge>
        ) : undefined
      }
    >
      <AnalyticsAlerts />
    <m.div
      variants={reduce ? undefined : stagger}
      initial={reduce ? false : "hidden"}
      animate="show"
      className="space-y-6 pb-12"
    >
      {/* R7 6.4 — resume-first hero: lead with action at the very top. */}
      <m.div variants={reduce ? undefined : fadeUp}>
        <ResumeHero />
      </m.div>

      {/* R9 — the focal instrument cluster: predicted score + countdown +
          readiness, promoted above the fold and read as one wall. The trend +
          the rest of the periphery follow below. */}
      <m.div
        variants={reduce ? undefined : fadeUp}
        className="grid gap-6 lg:grid-cols-3"
      >
        {/* Predicted score — the primary engraved figure. */}
        <Card className="flex flex-col justify-center lg:col-span-1">
          <CardContent className="p-[var(--card-pad)]">
            <StatNumber
              label="Predicted score"
              value={predictedScore}
              delta={delta}
              deltaSuffix=" (30d)"
              size="stat-xl"
              voice="numeric"
              aurora
              subline={heroCounsel}
            />
          </CardContent>
        </Card>

        {/* Countdown — co-equal emotional focal instrument. */}
        <div className="lg:col-span-1">
          <Countdown
            goal={goal}
            predictedScore={predictedScore}
            delta30d={delta}
            prepStartDate={prepStartDate}
          />
        </div>

        {/* Readiness — the third instrument in the cluster. */}
        <div className="lg:col-span-1">
          <ReadinessCard
            streakDays={d.streak_days}
            srsDue={srsDue}
            timedAccuracy={timedAccuracy}
            brGap={brGap}
            sessionsLast7d={sessions7d}
            predictedScore={predictedScore ?? undefined}
            readiness={backendReadiness}
          />
        </div>
      </m.div>

      {/* Score trend — the wide chart sits just under the instrument cluster. */}
      <m.div variants={reduce ? undefined : fadeUp}>
        <Card>
          <CardHeader>
            <CardTitle voice="display">Score trend</CardTitle>
          </CardHeader>
          <CardContent>
            {/* R10 A1.1 — Suspense boundary for the lazy()'d chart vendor. The
                fallback reserves the chart's height so deferring it costs no
                layout shift when it streams in. */}
            <Suspense
              fallback={<div className="h-[240px]" aria-hidden />}
            >
              <TrendChart
                series={trendSeries}
                goal={
                  goal?.bandLow != null && goal?.bandHigh != null
                    ? [goal.bandLow, goal.bandHigh]
                    : goal
                      ? [goal.targetScore - 2, goal.targetScore + 2]
                      : undefined
                }
                examDate={goal?.examDate || undefined}
                projection={
                  goal?.examDate && fallbackProjectionScore != null
                    ? {
                        // B1/B2 — server forecast with nested variance cones;
                        // predicted_score + recent delta is the offline fallback.
                        score: fc?.projected_score ?? fallbackProjectionScore,
                        bands: forecastConeBands(fc),
                      }
                    : undefined
                }
                height={240}
              />
            </Suspense>
          </CardContent>
        </Card>
      </m.div>

      <m.div variants={reduce ? undefined : fadeUp}>
        <StudyNudge sessions={sessions.data?.data ?? []} />
      </m.div>

      <m.div variants={reduce ? undefined : fadeUp}>
        <VNextCockpit
          plan={vnextPlan.data?.data}
          readiness={backendReadiness ?? undefined}
          contentScore={contentHealth.data?.data.score}
          contentWarnings={contentHealth.data?.data.warnings ?? []}
          trust={releaseTrust.data?.data}
          onStart={() => navigate("/drills")}
        />
      </m.div>

      <m.div variants={reduce ? undefined : fadeUp}>
        <NarrativeCards
          fallback={{ text: coachText, recommendation: coachRec }}
          trend={trendSeries.map((p) => p.score)}
        />
      </m.div>

      <m.div variants={reduce ? undefined : fadeUp}>
        <RecommendationInbox />
      </m.div>

      {/* Session recap (most recent finished section) */}
      {recentSession && (
        <m.div variants={reduce ? undefined : fadeUp}>
          <RecentRecap
            sessionId={recentSession.id}
            summaryScore={recentSession.scaled_score}
            streakDays={d.streak_days}
          />
        </m.div>
      )}

      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        <DashboardBelowFold
          activity={activity.data?.data ?? []}
          byType={byType.data?.data ?? []}
          sessions={sessions.data?.data ?? []}
          predictedScore={predictedScore}
          milestoneUnlocks={computeMilestoneUnlocks({
            sessions: sessions.data?.data ?? [],
            byType: byType.data?.data ?? [],
            predictedScore,
            streakDays: d.streak_days,
          })}
          reduceMotion={!!reduce}
        />
      </Suspense>

      <m.div variants={reduce ? undefined : fadeUp} className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const html = buildWeeklyReportHtml({
              generatedAt: new Date().toLocaleString(),
              dashboard: d,
              weakTypes: d.weakest_types,
              gap: gap.data?.data ?? null,
              streakDays: d.streak_days,
              trend: d.trend?.map((p) => ({
                date: p.date,
                score: p.score,
              })),
            });
            downloadWeeklyReport(html);
          }}
        >
          Download weekly report
        </Button>
      </m.div>

      <m.div
        variants={reduce ? undefined : fadeUp}
        className="grid gap-6 md:grid-cols-2"
      >
        {/* Weakest types → drills. The card itself isn't a click target; each
            row is (B1.5 — no false `interactive` affordance on the card). */}
        <Card>
          <CardHeader>
            <CardTitle>Weakest types</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {d.weakest_types.map((w) => (
              // R10 B2.1 — each weakest-type row is a real navigation target, so
              // it gets the tactile spring hover-lift/press (reduced-motion-gated
              // inside MotionCard).
              <MotionCard
                key={String(w.q_type)}
                className="group flex w-full items-center gap-3 rounded-md p-2 transition-colors hover:bg-accent"
              >
                <button
                  type="button"
                  onClick={() =>
                    navigate(
                      `/analytics/type/${encodeURIComponent(String(w.q_type))}`,
                    )
                  }
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <span className="w-40 shrink-0">
                    <TypeBadge qType={w.q_type} />
                  </span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: pct(w.accuracy) }}
                    />
                  </div>
                  <span className="w-10 text-right text-sm tabular-nums">
                    {pct(w.accuracy)}
                  </span>
                  <span className="hidden w-16 text-right text-sm tabular-nums text-muted-foreground sm:inline">
                    {formatMs(w.avg_time_ms)}
                  </span>
                  <TrendIcon trend={w.trend} />
                </button>
                <div className="flex shrink-0 gap-1 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() =>
                      navigate(
                        `/drills?q_type=${encodeURIComponent(String(w.q_type))}`,
                      )
                    }
                  >
                    Drill
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={() =>
                      navigate(
                        `/analytics/type/${encodeURIComponent(String(w.q_type))}`,
                      )
                    }
                  >
                    Analytics
                  </Button>
                </div>
              </MotionCard>
            ))}
            <p className="pt-1 text-xs text-muted-foreground">
              Hover a row for quick drill or analytics.
            </p>
          </CardContent>
        </Card>

        {/* Adaptive today's plan */}
        <TodayPlan />
      </m.div>
    </m.div>
    </PageLayout>
  );
}

function VNextCockpit({
  plan,
  readiness,
  contentScore,
  contentWarnings,
  trust,
  onStart,
}: {
  plan?: AdaptivityPlan;
  readiness?: ReadinessStatus;
  contentScore?: number;
  contentWarnings: string[];
  trust?: ReleaseTrustManifest;
  onStart: () => void;
}) {
  const primaryTask = plan?.tasks[0];
  const weak = plan?.weakest[0];
  const primaryPriority = formatUtilityPriority(primaryTask);
  const primaryTradeoffs = utilityTradeoffs(primaryTask, plan?.utility);
  const readinessLabel = readiness
    ? `${Math.round(readiness.readiness_score)} readiness`
    : "warming up";
  const releaseContract = dashboardReleaseContract(trust);
  const releaseReasons = releaseContract?.reasons ?? [];
  const trustNeedsEvidence = Boolean(
    trust && (trust.status !== "ok" || (releaseContract && !releaseContract.ready)),
  );
  const trustVariant =
    trust?.status === "blocked"
      ? "destructive"
      : trust?.status === "ok"
        ? "success"
        : "warning";
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <BrainCircuit className="h-4 w-4 text-primary" aria-hidden />
          Adaptive cockpit
        </CardTitle>
        <Badge variant={readiness?.status === "ready" ? "success" : "outline"}>
          {readinessLabel}
        </Badge>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium">
              {primaryTask?.label ?? "Build an adaptive plan"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {primaryTask?.why ??
                "The local ability model needs a few more attempts before it can rank the next best work."}
            </p>
            {(primaryPriority || primaryTradeoffs.length > 0) && (
              <div className="mt-2 flex flex-wrap gap-1">
                <UtilityTradeoffChips
                  priority={primaryPriority}
                  tradeoffs={primaryTradeoffs}
                  title={plan?.utility?.model}
                />
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Target className="h-3.5 w-3.5" aria-hidden />
              {weak?.q_type
                ? `${weak.q_type} · ${Math.round(weak.mastery * 100)}% mastery`
                : "No weak type yet"}
            </span>
            <span className="inline-flex items-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
              Content health {contentScore != null ? `${contentScore}/100` : "pending"}
            </span>
            <span className="inline-flex items-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
              Trust {trust ? `${trust.score}/100` : "pending"}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-md bg-muted/45 px-3 py-2">
          <div className="min-w-0 text-sm">
            <div className="flex items-center gap-2">
              <p className="font-medium">
                {trust?.blockers.length
                  ? `${trust.blockers.length} trust blocker${trust.blockers.length === 1 ? "" : "s"}`
                  : releaseContract && !releaseContract.ready
                    ? "Release gate needs evidence"
                  : trustNeedsEvidence
                    ? "Trust gate needs evidence"
                  : contentWarnings.length
                    ? `${contentWarnings.length} content warning${contentWarnings.length === 1 ? "" : "s"}`
                    : "Trust gate clear"}
              </p>
              {trust ? <Badge variant={trustVariant}>{trust.status}</Badge> : null}
            </div>
            <p className="truncate text-muted-foreground">
              {trust?.next_actions[0] ??
                releaseReasons[0]?.replace(/_/g, " ") ??
                contentWarnings[0]?.replace(/_/g, " ") ??
                "Official content remains local-only."}
            </p>
          </div>
          <Button size="sm" onClick={onStart}>
            <Target className="h-3.5 w-3.5" aria-hidden />
            Start
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function dashboardReleaseContract(
  trust: ReleaseTrustManifest | undefined,
): { ready: boolean; reasons: string[] } | null {
  const raw = trust?.checks.release_local?.detail?.freshness_contract;
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  return {
    ready: record.ready === true,
    reasons: Array.isArray(record.reasons)
      ? record.reasons.filter((item): item is string => typeof item === "string")
      : [],
  };
}

function accuracyFromByType(rows: ByTypeRow[]): number {
  const total = rows.reduce((s, r) => s + r.attempts, 0);
  if (!total) return 0;
  return rows.reduce((s, r) => s + r.accuracy * r.attempts, 0) / total;
}

function sessionsLast7(sessions: SessionSummary[]): number {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const iso = cutoff.toISOString().slice(0, 10);
  return sessions.filter((s) => s.started.slice(0, 10) >= iso).length;
}

/**
 * One short serif counsel sentence for the engraved predicted-score hero.
 * Speaks from the existing readiness verdict + 30-day trajectory — no new
 * data, no API. Keeps the observatory's calm, second-person counsel voice.
 */
function readinessCounsel(
  label: "On track" | "Building" | "Needs focus",
  delta30d: number | null | undefined,
): string {
  if (delta30d == null) {
    if (label === "On track") return "Set one more timed baseline to keep this signal honest.";
    if (label === "Building") return "You're building a base — the next timed section will sharpen the trend.";
    return "Start with one weak type and a timed baseline so the model can lock on.";
  }
  const climbing = delta30d > 0;
  if (label === "On track") {
    return climbing
      ? "You're on track and still climbing — hold this pace and stress-test under time."
      : "You're on track — protect the routine and keep the signal steady.";
  }
  if (label === "Building") {
    return climbing
      ? "Momentum is building — keep showing up and the trend will follow."
      : "You're building a base — a little more timed volume turns it into a trend.";
  }
  return climbing
    ? "Early signs are turning your way — channel the next sessions into your weakest types."
    : "This needs focus — start with one weak type and clear your review backlog.";
}

// Loads results for a specific session and renders the recap.
function RecentRecap({
  sessionId,
  summaryScore,
  streakDays,
}: {
  sessionId: number;
  summaryScore: number | null;
  streakDays: number;
}) {
  const { data } = useSessionResults(sessionId);
  if (!data) return null;
  return (
    <SessionRecap
      results={data.data}
      streakDays={streakDays}
      summary={{
        id: sessionId,
        type: "section",
        started: data.data.session.started,
        ended: null,
        scaled_score: summaryScore,
        question_count: data.data.items.length,
      }}
    />
  );
}
