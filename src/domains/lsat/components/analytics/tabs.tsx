/** Analytics tab panels (split from Analytics.tsx — Wave 6). */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { IllustrationAnalytics } from "@/components/illustrations";
import { EmptyState, SkeletonChart } from "@/components/states";
import {
  GapDumbbell,
  GapSankey,
  HeatStrip,
  MasteryMatrix,
  TimeRidgeline,
  TrapSpiral,
  type GapRow,
  type HeatCell,
  type MasteryRow,
  type RidgelineSeries,
} from "@/components/viz";
import { qTypeLabel, trapLabel, typeColor } from "@/lib/labels";
import { DifficultyCurve, TrapBars } from "@/components/analytics";
import {
  useBlindReviewGap,
  useByDifficulty,
  useByType,
  useMastery,
  useSessionResults,
  useSessions,
  useTiming,
  useTraps,
} from "@/lib/hooks";
import { filterSessionsForAnalytics } from "@/lib/analyticsParams";
import {
  computeGapForSessions,
  gapRowsFromComputed,
  outcomeCountsForSessions,
  splitSessionsByRange,
} from "@/lib/gapFromSessions";
import {
  reviewableSessions,
  useMultiSessionResults,
} from "@/lib/hooks/useReviewSessions";
import { pct, formatDate } from "@/lib/utils";
import { useAnalyticsContext } from "./analytics-context";
import { CrossFilterChip } from "./cross-filter";
import { SessionCompare } from "./SessionCompare";
import { TimingBudgetTable } from "./timing-budget-table";
import { TrapTrends } from "./trap-trends";
import { DifficultyTypeGrid } from "./difficulty-type-grid";
import { FocusQualityCard } from "./focus-quality-card";
import { TopTrapExplainer } from "./top-trap-explainer";
import { SectionTypeTrends } from "./section-type-trends";
import { HeatmapCompare } from "./heatmap-compare";
import type { QType } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { ChartDataTable } from "./chart-data-table";
import { downloadCsv } from "./exportCsv";

export type Source = "official" | "all";

// R8 — visual weighting for tab content. Each tab leads with ONE hero card
// (elevated, faint verdict-tinted edge, raised surface) and demotes its
// supporting charts to a quieter, flatter, transparent-backed treatment so a
// tab reads as a hierarchy instead of a stack of identical shadow-e1 walls.
// Pure styling — no chart moves between tabs. NB: `.bg-surface-*` are static
// utility classes (index.css), not registered Tailwind colours, so no opacity
// modifier is applied to them; demotion uses bg-transparent + a faint border.
const HERO_CARD = "shadow-e2 border-primary/15 bg-surface-1";
const SUPPORT_CARD = "shadow-none border-border/60 bg-transparent";

export function ByTypeTab({ source: sourceProp }: { source?: Source }) {
  const navigate = useNavigate();
  const { source: ctxSource, days, typeFocus, setTypeFocus } =
    useAnalyticsContext();
  const source = sourceProp ?? ctxSource;
  const { data, isLoading, isError, error, refetch } = useByType(source, days);
  const masteryQ = useMastery(source, days); // B9 — adjusted mastery from backend
  if (isLoading) return <SkeletonChart />;
  if (isError) return <EmptyState title="Could not load type stats" description={String(error)} action={<button type="button" className="text-sm underline" onClick={() => refetch()}>Retry</button>} />;
  const rows = data!.data;
  if (!rows.length)
    return (
      <EmptyState
        illustration={<IllustrationAnalytics />}
        title="No attempts yet"
        description="Practice a section or drill to populate your type mastery."
      />
    );

  // B9 — prefer the recency/difficulty-adjusted mastery from the backend; fall
  // back to raw accuracy from by-type if the mastery endpoint is unavailable.
  const masteryData = masteryQ.data?.data ?? [];
  const usingAdjusted = masteryData.length > 0;
  const avgByType = new Map(
    rows.map((r) => [`${r.q_type}|${r.section_type}`, r.avg_time_ms]),
  );
  const mastery: MasteryRow[] = usingAdjusted
    ? masteryData.map((m) => ({
        q_type: m.q_type,
        accuracy: m.mastery,
        avgTimeMs: avgByType.get(`${m.q_type}|${m.section_type}`) ?? 0,
        volume: m.attempts,
      }))
    : rows.map((r) => ({
        q_type: r.q_type,
        accuracy: r.accuracy,
        avgTimeMs: r.avg_time_ms,
        volume: r.attempts,
      }));

  return (
    <Card className={HERO_CARD}>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Question-type mastery</CardTitle>
          <CardDescription>
            Sort by any column. Click a row to focus every chart on that type;
            use the ↗ to drill it in the error log.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <CrossFilterChip className="print:hidden" />
          <Button
            variant="outline"
            size="sm"
            className="print:hidden"
            onClick={() =>
              downloadCsv(
                "type-mastery.csv",
                ["Type", "Accuracy", "Avg time (s)", "Attempts"],
                mastery.map((r) => [
                  String(r.q_type),
                  pct(r.accuracy),
                  String(Math.round(r.avgTimeMs / 1000)),
                  String(r.volume),
                ]),
              )
            }
          >
            <Download className="h-4 w-4" />
            CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <MasteryMatrix
          rows={mastery}
          accuracyLabel={usingAdjusted ? "Mastery" : "Accuracy"}
          focusedType={typeFocus}
          // Primary: focus the cross-filter (toggles off if the same row is
          // re-clicked). Secondary: ↗ drills the type in the error log.
          onSelect={
            setTypeFocus
              ? (r) => setTypeFocus(typeFocus === r.q_type ? null : r.q_type)
              : undefined
          }
          onDrill={(r) =>
            navigate(
              `/review?tab=errors&q_type=${encodeURIComponent(String(r.q_type))}`,
            )
          }
        />
        <ChartDataTable
          caption="Type mastery data"
          headers={["Type", "Accuracy", "Avg time (s)", "Attempts"]}
          rows={mastery.map((r) => [
            String(r.q_type),
            pct(r.accuracy),
            String(Math.round(r.avgTimeMs / 1000)),
            String(r.volume),
          ])}
        />
      </CardContent>
    </Card>
  );
}

export function TimingTab() {
  const { range, source, days, brushStart, brushEnd, typeFocus } =
    useAnalyticsContext();
  const byType = useByType(source, days);
  const sessions = useSessions();
  const list = filterSessionsForAnalytics(
    sessions.data?.data ?? [],
    range,
    brushStart,
    brushEnd,
  );
  const [sessionId, setSessionId] = useState<number | null>(null);
  const active = sessionId ?? list[0]?.id ?? 999;
  const { data, isLoading } = useTiming(active);
  const resultsQ = useSessionResults(active); // B3 — per-type time distribution

  if (sessions.isLoading || isLoading) return <SkeletonChart />;

  const rows = data!.data;
  const cells: HeatCell[] = rows.map((r) => ({
    value: Math.round(r.time_ms / 1000),
    correct: r.is_correct,
    label: `Q${r.question_order} · ${"★".repeat(r.difficulty)} · ${r.is_correct ? "correct" : "missed"}`,
  }));

  const slowest = [...rows].sort((a, b) => b.time_ms - a.time_ms).slice(0, 3);
  const narrative =
    slowest.length > 0
      ? `Slowest: Q${slowest.map((r) => r.question_order).join(", Q")} — consider triage drills on those positions.`
      : null;

  const typeRows = byType.data?.data ?? [];

  // B3 — per-question seconds grouped by type for the ridgeline; only types
  // with enough samples to show a distribution. Median is the reference line.
  const results = resultsQ.data?.data?.items ?? [];
  const byTypeSecs = new Map<string, number[]>();
  for (const it of results) {
    const k = String(it.question.q_type);
    const arr = byTypeSecs.get(k) ?? [];
    arr.push(it.attempt.time_ms / 1000);
    byTypeSecs.set(k, arr);
  }
  const ridgeSeries: RidgelineSeries[] = [...byTypeSecs.entries()]
    .filter(([, v]) => v.length >= 2)
    // R9 §5 — honor the cross-filter, but only when that type is actually
    // present here, so focusing never empties the distribution panel.
    .filter(([k]) =>
      typeFocus && [...byTypeSecs.keys()].includes(String(typeFocus))
        ? k === String(typeFocus)
        : true,
    )
    .sort((a, b) => b[1].length - a[1].length)
    .map(([k, v]) => ({
      facet: qTypeLabel(k as QType),
      values: v,
      color: typeColor(k as QType),
    }));
  const allSecs = results.map((it) => it.attempt.time_ms / 1000).sort((a, b) => a - b);
  const medianSec = allSecs.length
    ? Math.round(allSecs[Math.floor(allSecs.length / 2)])
    : undefined;

  return (
    <div className="space-y-4">
      <Card className={HERO_CARD}>
        <CardHeader>
          <CardTitle className="text-base">Timing budget by type</CardTitle>
          <CardDescription>Target seconds per question vs your average.</CardDescription>
        </CardHeader>
        <CardContent>
          <TimingBudgetTable rows={typeRows} />
        </CardContent>
      </Card>
      {ridgeSeries.length > 0 && (
        <Card className={SUPPORT_CARD}>
          <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
            <div className="min-w-0">
            <CardTitle className="text-base">Time-on-question by type</CardTitle>
            <CardDescription>
              Distribution of seconds per question, faceted by type. Dashed line
              = your median ({medianSec}s). Long right tails flag where you stall.
            </CardDescription>
            </div>
            <CrossFilterChip className="shrink-0 print:hidden" />
          </CardHeader>
          <CardContent>
            <TimeRidgeline series={ridgeSeries} target={medianSec} />
            <ChartDataTable
              caption="Median seconds per type"
              headers={["Type", "Questions", "Median seconds"]}
              rows={ridgeSeries.map((s) => {
                const sorted = [...s.values].sort((a, b) => a - b);
                const med = Math.round(sorted[Math.floor(sorted.length / 2)]);
                return [s.facet, String(s.values.length), String(med)];
              })}
            />
          </CardContent>
        </Card>
      )}
      {results.length > 0 && (
        <FocusQualityCard sessionId={active} items={results} target={medianSec} />
      )}
      <HeatmapCompare sessions={sessions.data?.data ?? []} />
      <SectionTypeTrends sessions={list} />
      <SessionCompare sessions={sessions.data?.data ?? []} />
    <Card className={SUPPORT_CARD}>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">Per-question timing</CardTitle>
          <CardDescription>
            Brighter cells burned more clock. ✓ correct · ✕ missed.
          </CardDescription>
        </div>
        {list.length > 0 && (
          <Select
            value={String(active)}
            onValueChange={(v) => setSessionId(Number(v))}
          >
            <SelectTrigger className="w-56" aria-label="Session">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {list.map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>
                  {s.type} · {formatDate(s.started)}
                  {s.scaled_score != null ? ` · ${s.scaled_score}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {cells.length ? (
          <>
            {narrative && (
              <p className="text-sm text-muted-foreground" role="status">
                {narrative}
              </p>
            )}
            <HeatStrip
              cells={cells}
              ramp="inferno"
              scaleLabels={{ low: "fast", high: "slow" }}
            />
            <ChartDataTable
              caption="Timing per question"
              headers={["Q", "Seconds", "Result"]}
              rows={rows.map((r) => [
                String(r.question_order),
                String(Math.round(r.time_ms / 1000)),
                r.is_correct ? "Correct" : "Missed",
              ])}
            />
          </>
        ) : (
          <EmptyState
            illustration={<IllustrationAnalytics />}
            title="No timing data for this session"
            description="Pick another session or run a timed section."
          />
        )}
      </CardContent>
    </Card>
    </div>
  );
}

export function GapTab({ comparePrior: compareProp }: { comparePrior?: boolean }) {
  const { comparePrior: ctxCompare, days, range, brushStart, brushEnd, typeFocus } =
    useAnalyticsContext();
  const comparePrior = compareProp ?? ctxCompare;
  const apiGap = useBlindReviewGap(days);
  const sessionsQ = useSessions();
  const allSessions = reviewableSessions(sessionsQ.data?.data ?? []);
  const brushed = filterSessionsForAnalytics(
    allSessions,
    range,
    brushStart,
    brushEnd,
  );
  const { current: currentSessions, prior: priorSessions } =
    brushStart && brushEnd
      ? { current: brushed, prior: [] as typeof brushed }
      : splitSessionsByRange(allSessions, range);
  const currentIds = currentSessions.map((s) => s.id);
  const compareIds = [...currentIds, ...priorSessions.map((s) => s.id)];
  // Always load the current window's per-question results so the Sankey (B5)
  // can render; add the prior window only when comparing.
  const multi = useMultiSessionResults(comparePrior ? compareIds : currentIds);

  const sessionGap = useMemo(() => {
    if (!comparePrior) return null;
    const current = computeGapForSessions(currentSessions, multi.resultsBySessionId);
    const prior = computeGapForSessions(priorSessions, multi.resultsBySessionId);
    return { current, prior };
  }, [comparePrior, currentSessions, priorSessions, multi.resultsBySessionId]);

  // B5 — timed→BR outcome flow for the current window.
  const outcomeCounts = useMemo(
    () => outcomeCountsForSessions(currentSessions, multi.resultsBySessionId),
    [currentSessions, multi.resultsBySessionId],
  );
  const outcomeTotal =
    outcomeCounts.timed_ok +
    outcomeCounts.lucky +
    outcomeCounts.concept_gap +
    outcomeCounts.timing_problem;

  if (apiGap.isLoading || (comparePrior && multi.isLoading)) return <SkeletonChart />;

  const g = apiGap.data!.data;
  const allRows: GapRow[] =
    comparePrior && sessionGap && sessionGap.current.by_type.length > 0
      ? gapRowsFromComputed(sessionGap.current)
      : g.by_type.map((r) => ({
          q_type: r.q_type as QType,
          timed: r.timed_accuracy,
          blindReview: r.br_accuracy,
        }));

  const allPriorRows: GapRow[] | undefined =
    comparePrior && sessionGap && sessionGap.prior.by_type.length > 0
      ? gapRowsFromComputed(sessionGap.prior)
      : undefined;

  // R9 §5 — when a type is focused, narrow the dumbbell to it (fall back to all
  // rows if that type isn't present in this window so the chart never blanks).
  const focusFilter = (rs: GapRow[]) =>
    typeFocus ? rs.filter((r) => r.q_type === typeFocus) : rs;
  const focusedRows = focusFilter(allRows);
  const rows = typeFocus && focusedRows.length ? focusedRows : allRows;
  const priorRows = allPriorRows
    ? (() => {
        const f = focusFilter(allPriorRows);
        return typeFocus && f.length ? f : allPriorRows;
      })()
    : undefined;

  const displayGap = comparePrior && sessionGap ? sessionGap.current : null;
  const gapVal = displayGap?.gap ?? g.gap;
  const timedAcc = displayGap?.timed_accuracy ?? g.timed_accuracy;
  const brAcc = displayGap?.br_accuracy ?? g.br_accuracy;
  const big = gapVal > 0.08;

  return (
    <div className="space-y-4">
    <HeatmapCompare sessions={sessionsQ.data?.data ?? []} />
    <Card className={HERO_CARD}>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
        <CardTitle className="text-base">Timed vs Blind Review</CardTitle>
        <CardDescription>
          {comparePrior && (
            <span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-xs">
              Compare: current {range === "7" ? "7d" : range === "30" ? "30d" : "period"} vs prior
            </span>
          )}
          {big ? (
            <>
              <strong className="text-foreground">Timing, not understanding.</strong>{" "}
              Gap {pct(gapVal)} ({pct(timedAcc)} timed → {pct(brAcc)} BR).
            </>
          ) : (
            <>
              <strong className="text-foreground">Understanding, not timing.</strong>{" "}
              Timed {pct(timedAcc)} vs BR {pct(brAcc)}.
            </>
          )}
          {comparePrior && priorRows && (
            <span className="mt-2 block text-xs text-muted-foreground">
              Solid lines = current window · dashed = prior (from session results).
            </span>
          )}
        </CardDescription>
        </div>
        <CrossFilterChip className="shrink-0 print:hidden" />
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.length ? (
          <GapDumbbell rows={rows} priorRows={priorRows} />
        ) : (
          <EmptyState
            title="No blind-review data yet"
            description="Complete a blind-review pass to see the gap by type."
          />
        )}
      </CardContent>
    </Card>
    {outcomeTotal > 0 && (
      <Card className={SUPPORT_CARD}>
        <CardHeader>
          <CardTitle className="text-base">Where points go: timed → blind review</CardTitle>
          <CardDescription>
            Every attempt flows from its timed result to its blind-review result.
            Wide “timing problem” / “lucky” bands mean pacing, not understanding.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <GapSankey counts={outcomeCounts} />
        </CardContent>
      </Card>
    )}
    </div>
  );
}

export function DifficultyTab({ source: sourceProp }: { source?: Source }) {
  const { source: ctxSource, days } = useAnalyticsContext();
  const source = sourceProp ?? ctxSource;
  const { data, isLoading } = useByDifficulty(source, days);
  if (isLoading) return <SkeletonChart />;
  const rows = data!.data;

  return (
    <div className="space-y-4">
      <DifficultyTypeGrid source={source} />
      <Card className={HERO_CARD}>
        <CardHeader>
          <CardTitle className="text-base">Difficulty curve</CardTitle>
          <CardDescription>
            Accuracy vs item difficulty; point size = volume.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length ? (
            <DifficultyCurve rows={rows} />
          ) : (
            <EmptyState title="No difficulty data yet" />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function TrapsTab() {
  const navigate = useNavigate();
  const { days } = useAnalyticsContext();
  const { data, isLoading } = useTraps(days);
  if (isLoading) return <SkeletonChart />;
  const rows = data!.data.filter((r) => r.trap_type !== "none");
  return (
    <div className="space-y-4">
    <TopTrapExplainer days={days} />
    <TrapTrends traps={data!.data} />
    <Card className={HERO_CARD}>
      <CardHeader>
        <CardTitle className="text-base">Traps you fall for</CardTitle>
        <CardDescription>
          Ranked by how often a wrong pick matched each trap pattern.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length ? (
          <>
          <div className="grid items-center gap-4 sm:grid-cols-[auto_1fr]">
            <TrapSpiral
              data={rows.map((r) => ({
                key: r.trap_type,
                label: trapLabel(r.trap_type),
                value: r.times_fell_for,
              }))}
              onSelect={() => navigate("/review?tab=errors&reason=trap")}
            />
            <div className="min-w-0">
              <TrapBars rows={rows} />
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="mt-3 print:hidden"
            onClick={() =>
              downloadCsv(
                "traps.csv",
                ["Trap", "Times", "Percent"],
                rows.map((r) => [r.trap_type, String(r.times_fell_for), String(Math.round(r.pct * 100))]),
              )
            }
          >
            <Download className="h-4 w-4" />
            CSV
          </Button>
          </>
        ) : (
          <EmptyState
            title="No trap patterns yet"
            description="As you log wrong answers, recurring traps surface here."
            action={
              <Button size="sm" variant="outline" onClick={() => navigate("/review")}>
                Open error log
              </Button>
            }
          />
        )}
      </CardContent>
    </Card>
    </div>
  );
}
