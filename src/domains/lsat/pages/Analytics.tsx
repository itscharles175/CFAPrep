import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { m, useReducedMotion } from "motion/react";
import { BarChart3, Download, Printer } from "lucide-react";
import { PageLayout } from "@/components/page-layout";
import { AnalyticsFilters, type AnalyticsRange } from "@/components/analytics/AnalyticsFilters";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TrendChart } from "@/components/viz";
import { avg, inRange, splitTrendPeriods } from "@/lib/dateRange";
import {
  EmptyState,
  ErrorState,
  SkeletonCard,
  SkeletonChart,
} from "@/components/states";
import {
  KpiRow,
  NarrativeCards,
  ForecastPanel,
  FeedbackCohortSummaryCard,
  StudyConsistency,
  PrintReport,
  downloadReport,
  printReport,
} from "@/components/analytics";
import { AnalyticsProvider } from "@/components/analytics/analytics-context";
import {
  ByTypeTab,
  DifficultyTab,
  GapTab,
  TimingTab,
  TrapsTab,
  type Source,
} from "@/components/analytics/tabs";
import {
  useBlindReviewGap,
  useByDifficulty,
  useByType,
  useDashboard,
  useFeedbackCohorts,
  useFeedbackOutcomes,
  useForecast,
  useReadinessStatus,
  useSessions,
  useSrsDue,
  useTraps,
} from "@/lib/hooks";
import { forecastConeBands } from "@/lib/forecast";
import { liveReadinessStatus } from "@/lib/readiness";
import { daysFromRange } from "@/lib/analyticsParams";
import { inBrushRange } from "@/lib/brushFilter";
import { fadeUp, stagger } from "@/lib/motion";
import { SavedAnalyticsViews } from "@/components/analytics/saved-views";
import { AnalyticsAlerts } from "@/components/analytics/analytics-alerts";
import { WidgetBoundary } from "@/components/error-boundary";
import { toast } from "@/lib/toast";
import { getGoal, type SavedAnalyticsView } from "@/lib/prefs";
import type { QType } from "@/lib/types";


/**
 * A3.7 — a Radix <TabsContent> that keeps its subtree mounted (and CSS-hidden)
 * once the tab has been visited, so switching back is instant instead of
 * replaying every chart's draw-on + visx layout. Before the first visit it
 * mounts lazily (Radix's default), so we never pay for tabs the user never
 * opens. `forceMount` requires the consumer to own the hide, hence
 * `data-[state=inactive]:hidden`.
 */
function KeepAliveTabContent({
  value,
  visited,
  children,
}: {
  value: string;
  visited: boolean;
  children: React.ReactNode;
}) {
  return (
    <TabsContent
      value={value}
      forceMount={visited ? true : undefined}
      className="data-[state=inactive]:hidden"
    >
      {children}
    </TabsContent>
  );
}

export default function Analytics() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab") ?? "type";
  // B12 — a view is fully encoded in the URL (?tab&source&range&compare&brush)
  // so a saved view can be shared as a deep link (local-first, no accounts).
  const [source, setSource] = useState<Source>(
    searchParams.get("source") === "official" ? "official" : "all",
  );
  // B11 — brush selection persists in the URL (?brush=START..END) so it
  // survives tab changes and reloads.
  const brushParam = searchParams.get("brush");
  const [pInitStart, pInitEnd] =
    brushParam && brushParam.includes("..")
      ? brushParam.split("..")
      : [undefined, undefined];
  const rangeParam = searchParams.get("range") as AnalyticsRange | null;
  const [range, setRange] = useState<AnalyticsRange>(
    brushParam ? "all" : (rangeParam ?? "all"),
  );
  const [comparePrior, setComparePrior] = useState(
    searchParams.get("compare") === "1",
  );
  const [brushStart, setBrushStart] = useState<string | undefined>(pInitStart);
  const [brushEnd, setBrushEnd] = useState<string | undefined>(pInitEnd);
  // B11/R9 §5 — the cross-filter type focus also lives in the URL (?type=) so a
  // focused analytics view is a shareable deep link, just like the brush.
  const [typeFocus, setTypeFocusState] = useState<QType | undefined>(
    (searchParams.get("type") as QType | null) ?? undefined,
  );
  const reduce = useReducedMotion();
  const days = daysFromRange(range);

  // A3.7 — lazy-keep-alive for the tabbed deep-dives. Radix unmounts inactive
  // <TabsContent> by default, so every switch replayed each chart's draw-on +
  // visx layout (tabs felt like page loads). We force-mount a tab ONCE it has
  // been visited and CSS-hide it when inactive, so re-selecting it is instant
  // (charts persist) — while still NOT mounting tabs the user never opens, to
  // bound DOM/work. `draw-on` therefore plays only on a tab's first reveal.
  const [visitedTabs, setVisitedTabs] = useState<Set<string>>(
    () => new Set([tabParam]),
  );
  // Track tab changes that arrive via the URL (saved views, narrative-card
  // deep links) as well as direct trigger clicks.
  useEffect(() => {
    setVisitedTabs((prev) =>
      prev.has(tabParam) ? prev : new Set(prev).add(tabParam),
    );
  }, [tabParam]);

  // Persist the brush range to the URL alongside in-component state.
  // A2.4 — stable identity across renders so the memoized provider value (and
  // the memoized chart wrappers below it) don't churn on every filter/brush
  // change. Only re-created when the URL setters themselves change.
  const applyBrush = useCallback(
    (start?: string, end?: string) => {
      setBrushStart(start);
      setBrushEnd(end);
      const next = new URLSearchParams(searchParams);
      if (start && end) next.set("brush", `${start}..${end}`);
      else next.delete("brush");
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // Persist the cross-filter type focus to the URL (?type=…).
  const setTypeFocus = useCallback(
    (q: QType | null) => {
      setTypeFocusState(q ?? undefined);
      const next = new URLSearchParams(searchParams);
      if (q) next.set("type", String(q));
      else next.delete("type");
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const navigate = useNavigate();
  const dashboard = useDashboard(days);
  const byType = useByType(source, days);
  const gap = useBlindReviewGap(days);
  const difficulty = useByDifficulty(source, days);
  const traps = useTraps(days);
  const sessions = useSessions();
  const srs = useSrsDue();
  const readinessStatus = useReadinessStatus(null, days);
  const feedbackCohorts = useFeedbackCohorts(days);
  const feedbackOutcomes = useFeedbackOutcomes(days, 30, source, 3);

  const goal = useMemo(getGoal, []);
  const forecast = useForecast(goal?.examDate ?? null, goal?.targetScore ?? null, days);
  const fc = forecast.data?.data;
  const d = dashboard.data?.data;
  const backendReadiness = liveReadinessStatus(readinessStatus.data);

  // KPIs derived from the available series.
  const accuracy = useMemo(() => {
    const rows = byType.data?.data ?? [];
    const total = rows.reduce((s, r) => s + r.attempts, 0);
    if (!total) return 0;
    return rows.reduce((s, r) => s + r.accuracy * r.attempts, 0) / total;
  }, [byType.data]);

  const avgTimeMsPerQ = useMemo(() => {
    const rows = byType.data?.data ?? [];
    const total = rows.reduce((s, r) => s + r.attempts, 0);
    if (!total) return 0;
    return rows.reduce((s, r) => s + r.avg_time_ms * r.attempts, 0) / total;
  }, [byType.data]);

  // R9 §4 — readiness inputs for the forecast hero's composite gauge, all from
  // existing dashboard/session/SRS queries (no new metrics).
  const sessionsLast7d = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const iso = cutoff.toISOString().slice(0, 10);
    return (sessions.data?.data ?? []).filter(
      (s) => s.started.slice(0, 10) >= iso,
    ).length;
  }, [sessions.data]);
  const readinessInput = useMemo(
    () => ({
      streakDays: d?.streak_days ?? 0,
      srsDue: srs.data?.data.due_count ?? 0,
      timedAccuracy: accuracy,
      brGap: gap.data?.data.gap ?? 0,
      sessionsLast7d,
      targetScore: goal?.targetScore,
      predictedScore: d?.predicted_score ?? undefined,
    }),
    [d, srs.data, accuracy, gap.data, sessionsLast7d, goal?.targetScore],
  );

  const filteredTrend = useMemo(() => {
    const raw = d?.trend ?? [];
    const ranged =
      range === "all" ? raw : raw.filter((p) => inRange(p.date, range));
    if (!brushStart && !brushEnd) return ranged;
    return ranged.filter((p) => inBrushRange(p.date, brushStart, brushEnd));
  }, [d, range, brushStart, brushEnd]);

  const { current: trendCurrent, prior: trendPrior } = useMemo(
    () => splitTrendPeriods(filteredTrend, range),
    [filteredTrend, range],
  );

  const trendScores = useMemo(
    () => trendCurrent.map((p) => p.score),
    [trendCurrent],
  );

  const priorOverlay = useMemo(
    () => (comparePrior && trendPrior.length ? trendPrior : undefined),
    [comparePrior, trendPrior],
  );

  // R9 §7 — gap rows for the print composition (mirrors GapTab's API mapping).
  const printGapRows = useMemo(
    () =>
      (gap.data?.data.by_type ?? []).map((r) => ({
        q_type: r.q_type as QType,
        timed: r.timed_accuracy,
        blindReview: r.br_accuracy,
      })),
    [gap.data],
  );

  const compareDeltas = useMemo(() => {
    if (!comparePrior || trendCurrent.length < 1 || trendPrior.length < 1)
      return undefined;
    const accRows = byType.data?.data ?? [];
    const vol = accRows.reduce((s, r) => s + r.attempts, 0);
    const acc = vol
      ? accRows.reduce((s, r) => s + r.accuracy * r.attempts, 0) / vol
      : 0;
    return {
      scoreDelta: Math.round(
        avg(trendCurrent.map((p) => p.score)) - avg(trendPrior.map((p) => p.score)),
      ),
      accuracyDelta: comparePrior ? Math.round(acc * 100) : undefined,
    };
  }, [comparePrior, trendCurrent, trendPrior, byType.data]);

  const pageError =
    dashboard.isError && byType.isError
      ? dashboard.error ?? byType.error
      : null;

  function handleExport() {
    if (!byType.data || !gap.data || !difficulty.data || !traps.data || !d) {
      toast.error("Analytics still loading — try again in a moment.");
      return;
    }
    downloadReport({
      generatedAt: new Date().toISOString(),
      source,
      range: range === "all" ? "all-time" : `last-${range}-days`,
      kpis: {
        predictedScore: d.predicted_score,
        scoreDelta30d: d.score_delta_30d,
        accuracy,
        avgTimeMsPerQ,
        brGap: gap.data.data.gap,
      },
      byType: byType.data.data,
      blindReviewGap: gap.data.data,
      difficulty: difficulty.data.data,
      traps: traps.data.data,
    });
    toast.success("Report downloaded");
  }

  const usingSample = dashboard.data?.usingSample || byType.data?.usingSample;

  // A2.4 — memoize the tabbed deep-dives' context value. Built inline it was a
  // fresh object every render, so any filter/brush/cross-filter change (or even
  // an unrelated re-render) re-ran the active tab's visx layout. Now it only
  // changes when one of its inputs actually does.
  const analyticsCtx = useMemo(
    () => ({
      source,
      range,
      comparePrior,
      days,
      brushStart,
      brushEnd,
      typeFocus,
      setTypeFocus,
    }),
    [
      source,
      range,
      comparePrior,
      days,
      brushStart,
      brushEnd,
      typeFocus,
      setTypeFocus,
    ],
  );

  // 7.6 — when the range/source switches, `keepPreviousData` keeps the prior
  // window's charts on screen (no skeleton flash). Dim them slightly while the
  // new window resolves so the staleness is legible without a hard reload.
  const isStale =
    dashboard.isPlaceholderData ||
    byType.isPlaceholderData ||
    gap.isPlaceholderData ||
    difficulty.isPlaceholderData ||
    traps.isPlaceholderData ||
    feedbackOutcomes.isPlaceholderData;

  if (pageError && !dashboard.data && !byType.data) {
    return (
      <PageLayout title="Analytics" eyebrow="DIAGNOSTICS" icon={BarChart3} width="2xl">
        <ErrorState
          error={pageError}
          onRetry={() => {
            void dashboard.refetch();
            void byType.refetch();
          }}
        />
      </PageLayout>
    );
  }

  return (
    <PageLayout
      title="Analytics"
      eyebrow="DIAGNOSTICS"
      icon={BarChart3}
      description="Your diagnostic picture — where the clock dies and where understanding holds."
      width="2xl"
      className="print:max-w-none"
    >
      {/* R9 §7 — composed print-only report; the live page is hidden on print. */}
      <PrintReport
        generatedAt={new Date().toISOString()}
        rangeLabel={range === "all" ? "All time" : `Last ${range} days`}
        sourceLabel={source === "official" ? "Official only" : "All content"}
        goalBand={goal?.band}
        examDate={goal?.examDate}
        kpis={{
          predictedScore: d?.predicted_score ?? null,
          scoreDelta30d: d?.score_delta_30d ?? null,
          accuracy,
          avgTimeSec: Math.round(avgTimeMsPerQ / 1000),
          brGap: gap.data?.data.gap ?? 0,
        }}
        trend={trendCurrent}
        projection={
          goal?.examDate && trendScores.length
            ? {
                score:
                  fc?.projected_score ??
                  goal.targetScore ??
                  trendScores[trendScores.length - 1] + 3,
                lowSpread: 3,
                highSpread: 3,
                bands: forecastConeBands(fc),
              }
            : undefined
        }
        gapRows={printGapRows}
        difficulty={difficulty.data?.data ?? []}
      />
      <AnalyticsAlerts />
    <m.div
      variants={stagger}
      initial={reduce ? false : "hidden"}
      animate="show"
      // R9 §7 — the live, interactive page is suppressed on print; the composed
      // <PrintReport> above owns the printed page instead.
      className="space-y-6 pb-12 print:hidden"
      aria-busy={isStale}
    >
      <m.div
        variants={fadeUp}
        className="flex flex-wrap items-center justify-end gap-2 print:hidden"
      >
          <AnalyticsFilters
            source={source}
            range={range}
            comparePrior={comparePrior}
            usingSample={!!usingSample}
            onSourceChange={setSource}
            onRangeChange={setRange}
            onCompareChange={setComparePrior}
            footer={
              <SavedAnalyticsViews
                tab={tabParam}
                range={range}
                source={source}
                comparePrior={comparePrior}
                onApply={(v: SavedAnalyticsView) => {
                  setSource(v.source as Source);
                  setRange(v.range as AnalyticsRange);
                  setComparePrior(v.comparePrior);
                  setSearchParams({ tab: v.tab });
                }}
              />
            }
          />
          <Button variant="outline" size="sm" onClick={handleExport}>
            <Download className="h-4 w-4" /> Export
          </Button>
          <Button variant="outline" size="sm" onClick={printReport}>
            <Printer className="h-4 w-4" /> Print
          </Button>
      </m.div>

      {/* 7.6 — dim (but keep visible) the prior window's data while a range/
          source switch resolves. The filter toolbar above stays interactive. */}
      <div
        className={
          "space-y-6 transition-opacity duration-200" +
          (isStale ? " opacity-60" : "")
        }
      >
      {/* §3.9 KPI row */}
      <m.div variants={fadeUp}>
        {dashboard.isLoading || byType.isLoading || gap.isLoading ? (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : (
          <KpiRow
            predictedScore={d?.predicted_score ?? null}
            scoreDelta30d={d?.score_delta_30d ?? null}
            accuracy={accuracy}
            avgTimeMsPerQ={avgTimeMsPerQ}
            brGap={gap.data?.data.gap ?? 0}
            trend={trendScores}
            compare={compareDeltas}
          />
        )}
      </m.div>

      {/* R9 §4 — Forecast hero: "Are you on track?". The glide-path projection
          lives here now (gauge + projection numbers) instead of being crammed
          into the trend chart's right edge. */}
      <m.div variants={fadeUp}>
        <WidgetBoundary label="Forecast panel">
          <ForecastPanel
            forecast={fc}
            goalBand={goal?.band}
            examDate={goal?.examDate}
            targetScore={goal?.targetScore}
            predictedScore={d?.predicted_score ?? null}
            readiness={readinessInput}
            backendReadiness={backendReadiness}
            onSetGoal={() => navigate("/settings")}
          />
        </WidgetBoundary>
      </m.div>

      {/* §3.1 Score trend — the page hero. Elevated + verdict-edged so the
          glide-path forecast reads as the headline, with the tabbed deep-dives
          demoted beneath it. */}
      <m.div variants={fadeUp}>
        <Card className="border-primary/15 bg-surface-1 shadow-e2">
          <CardHeader>
            <CardTitle className="text-lg">Score trend</CardTitle>
            <CardDescription>
              {goal?.band
                ? "Your goal band and exam date are overlaid; milestone pins mark your best, biggest jump, and where momentum began. Drag to brush a window."
                : "Milestone pins mark your best and biggest jump. Set a goal in Settings to overlay your target band. Drag to brush a window."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {dashboard.isLoading ? (
              <SkeletonChart className="border-0 p-0 shadow-none" />
            ) : trendScores.length > 1 ? (
              <WidgetBoundary label="Score trend chart">
              {/* R9 §4 — the projection cone now lives in the ForecastPanel
                  above; the trend stays focused on history + milestone pins. */}
              <TrendChart
                series={trendCurrent}
                priorSeries={priorOverlay}
                goal={goal?.band}
                examDate={goal?.examDate}
                annotate
                onBrushRange={(r) => {
                  if (r) {
                    applyBrush(r.start.slice(0, 10), r.end.slice(0, 10));
                    setRange("all");
                    toast.info(`Filtered trend: ${r.start.slice(0, 10)} → ${r.end.slice(0, 10)}`);
                  } else {
                    applyBrush(undefined, undefined);
                  }
                }}
              />
              {brushStart && brushEnd && (
                <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    Brush selection: {brushStart} → {brushEnd} (filters session-based tabs)
                  </span>
                  <button
                    type="button"
                    className="underline underline-offset-2 hover:text-foreground"
                    onClick={() => applyBrush(undefined, undefined)}
                  >
                    Clear
                  </button>
                </p>
              )}
              </WidgetBoundary>
            ) : (
              <EmptyState
                title="Not enough score history"
                description="Finish a few timed sections to see your trend take shape."
              />
            )}
          </CardContent>
        </Card>
      </m.div>

      {/* §3.7 Diagnostic narrative cards */}
      <m.div variants={fadeUp}>
        <NarrativeCards
          fallback={d?.coach}
          trend={trendScores}
          onOpenAnalyticsTab={(tab, qType) => {
            const next = new URLSearchParams(searchParams);
            next.set("tab", tab);
            if (qType) next.set("q_type", qType);
            setSearchParams(next);
          }}
        />
      </m.div>

      <m.div variants={fadeUp}>
        <WidgetBoundary label="Plan feedback cohorts">
          <FeedbackCohortSummaryCard
            summary={feedbackCohorts.data?.data}
            outcomeSummary={feedbackOutcomes.data?.data}
            isLoading={feedbackCohorts.isLoading}
          />
        </WidgetBoundary>
      </m.div>

      {/* §3.9b — study-consistency heatmap (cadence is the strongest growth
          predictor). Reuses the GitHub-style ContributionHeatmap. */}
      <m.div variants={fadeUp}>
        <WidgetBoundary label="Study consistency">
          <StudyConsistency sessions={sessions.data?.data ?? []} />
        </WidgetBoundary>
      </m.div>

      {/* Tabbed deep-dives */}
      <m.div variants={fadeUp}>
        <AnalyticsProvider value={analyticsCtx}>
        <Tabs
          value={tabParam}
          onValueChange={(v) => {
            const next = new URLSearchParams(searchParams);
            next.set("tab", v);
            setSearchParams(next);
          }}
        >
          <TabsList className="flex-wrap">
            <TabsTrigger value="type">By Type</TabsTrigger>
            <TabsTrigger value="timing">Timing</TabsTrigger>
            <TabsTrigger value="gap">Timed vs BR</TabsTrigger>
            <TabsTrigger value="difficulty">Difficulty</TabsTrigger>
            <TabsTrigger value="traps">Traps</TabsTrigger>
          </TabsList>

          <KeepAliveTabContent value="type" visited={visitedTabs.has("type")}>
            <WidgetBoundary label="By-type analytics">
              <ByTypeTab source={source} />
            </WidgetBoundary>
          </KeepAliveTabContent>
          <KeepAliveTabContent
            value="timing"
            visited={visitedTabs.has("timing")}
          >
            <WidgetBoundary label="Timing analytics">
              <TimingTab />
            </WidgetBoundary>
          </KeepAliveTabContent>
          <KeepAliveTabContent value="gap" visited={visitedTabs.has("gap")}>
            <WidgetBoundary label="Timed vs blind-review analytics">
              <GapTab comparePrior={comparePrior} />
            </WidgetBoundary>
          </KeepAliveTabContent>
          <KeepAliveTabContent
            value="difficulty"
            visited={visitedTabs.has("difficulty")}
          >
            <WidgetBoundary label="Difficulty analytics">
              <DifficultyTab source={source} />
            </WidgetBoundary>
          </KeepAliveTabContent>
          <KeepAliveTabContent value="traps" visited={visitedTabs.has("traps")}>
            <WidgetBoundary label="Traps analytics">
              <TrapsTab />
            </WidgetBoundary>
          </KeepAliveTabContent>
        </Tabs>
        </AnalyticsProvider>
      </m.div>
      </div>
    </m.div>
    </PageLayout>
  );
}
