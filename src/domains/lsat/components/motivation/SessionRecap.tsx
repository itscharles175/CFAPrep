import { useEffect, useMemo, useRef, useState } from "react";
import { m, useReducedMotion } from "motion/react";
import { Download, Flame, Trophy } from "lucide-react";
import { Button } from "@lsat/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@lsat/components/ui/card";
import { Icon } from "@lsat/components/ui/icon";
import { StatNumber, TypeBadge } from "@lsat/components/viz";
import { AccentPanel } from "@lsat/components/accent-panel";
import { formatDate, formatMs, pct, pluralize } from "@lsat/lib/utils";
import { getBestScore, recordScore } from "@lsat/lib/prefs";
import { stagger, fadeUp } from "@lsat/lib/motion";
import { celebratePersonalBest } from "./confetti";
import {
  RecapShareCard,
  recapSharePropsFromStats,
} from "./recap-share-card";
import { exportNodeAsPng, exportNodeAsSvg } from "@lsat/lib/recapExport";
import type { SessionResults, SessionSummary, QType } from "@lsat/lib/types";

export interface SessionRecapProps {
  results: SessionResults;
  /** Matching session summary (for the scaled score), if available. */
  summary?: SessionSummary;
  /**
   * R10 B3.1 — current streak length (the dashboard already computes this via
   * `d.streak_days`). Lets the ceremonial beat fold in a 7/30/100-day streak
   * note. Optional: when absent the moment speaks from the personal best alone.
   */
  streakDays?: number;
}

interface TypeAgg {
  qType: QType;
  correct: number;
  total: number;
}

/** R10 B3.1 — streak ceremony tiers. The highest crossed threshold speaks. */
const STREAK_TIERS = [100, 30, 7] as const;
function streakTier(days: number): number | null {
  return STREAK_TIERS.find((t) => days >= t) ?? null;
}

/** §5.3 — animated recap of the most recent session + a calm PB/streak beat. */
export function SessionRecap({ results, summary, streakDays }: SessionRecapProps) {
  const reduce = useReducedMotion();
  const fired = useRef(false);
  const shareRef = useRef<HTMLDivElement>(null);
  const [isPB, setIsPB] = useState(false);
  // Prior best, captured before recordScore mutates it — drives the "+N over
  // your last best" counsel line. Null until the PB effect runs.
  const [priorBest, setPriorBest] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);

  const stats = useMemo(() => {
    const items = results.items;
    const total = items.length;
    const correct = items.filter((i) => i.attempt.is_correct).length;
    const brCorrect = items.filter((i) => i.attempt.br_correct).length;
    const timeMs = items.reduce((s, i) => s + i.attempt.time_ms, 0);

    const byType = new Map<string, TypeAgg>();
    for (const it of items) {
      const key = String(it.question.q_type);
      const agg =
        byType.get(key) ??
        { qType: it.question.q_type, correct: 0, total: 0 };
      agg.total++;
      if (it.attempt.is_correct) agg.correct++;
      byType.set(key, agg);
    }
    const ranked = [...byType.values()]
      .filter((a) => a.total > 0)
      .sort((a, b) => b.correct / b.total - a.correct / a.total);
    const best = ranked[0];
    const worst = ranked.length > 1 ? ranked[ranked.length - 1] : undefined;

    const timedAcc = total ? correct / total : 0;
    const brAcc = total ? brCorrect / total : 0;

    return {
      total,
      correct,
      accuracy: timedAcc,
      timeMs,
      best,
      worst,
      brGap: brAcc - timedAcc,
      score: summary?.scaled_score ?? null,
    };
  }, [results, summary]);

  // Fire confetti once, only on a genuine personal best (and never under
  // reduced motion). `recordScore` returns true only when it beats a prior best.
  useEffect(() => {
    if (fired.current) return;
    if (stats.score == null) return;
    fired.current = true;
    // Capture the prior best BEFORE recordScore overwrites it.
    setPriorBest(getBestScore());
    const pb = recordScore(stats.score);
    setIsPB(pb);
    // R10 B3.1 — confetti is now a rare *accent* on top of the calm ceremonial
    // panel (not the whole celebration). Still PB-only, still reduced-motion-off.
    if (pb && !reduce) celebratePersonalBest();
  }, [stats.score, reduce]);

  const tier = streakDays != null ? streakTier(streakDays) : null;
  // The ceremonial beat shows for a genuine PB and/or a streak milestone.
  const showCeremony = (isPB && stats.score != null) || tier != null;
  const pbGain =
    isPB && stats.score != null && priorBest != null
      ? stats.score - priorBest
      : null;

  const shareProps = recapSharePropsFromStats({
    score: stats.score,
    accuracy: stats.accuracy,
    timeMs: stats.timeMs,
    brGap: stats.brGap,
    best: stats.best,
    worst: stats.worst,
    sessionLabel: summary?.started ? formatDate(summary.started) : undefined,
  });

  const [showCard, setShowCard] = useState(false);

  async function exportShare(kind: "png" | "svg") {
    const node = shareRef.current;
    if (!node || exporting) return;
    setExporting(true);
    try {
      const date = new Date().toISOString().slice(0, 10);
      if (kind === "png") {
        await exportNodeAsPng(node, `lsatlab-recap-${date}.png`);
      } else {
        await exportNodeAsSvg(node, `lsatlab-recap-${date}.svg`);
      }
    } finally {
      setExporting(false);
    }
  }

  return (
    <m.div
      variants={reduce ? undefined : stagger}
      initial={reduce ? false : "hidden"}
      animate="show"
    >
      <Card>
        <CardHeader className="flex flex-col items-stretch gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle voice="display">Last session recap</CardTitle>
          <div data-testid="session-recap-actions" className="flex flex-wrap items-center gap-2 sm:justify-end">
          <Button
            variant="outline"
            size="sm"
            className="min-h-10"
            disabled={exporting}
            onClick={() => void exportShare("png")}
          >
            <Download className="h-3.5 w-3.5" />
            PNG
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="min-h-10"
            disabled={exporting}
            onClick={() => void exportShare("svg")}
          >
            SVG
          </Button>
          <Button
            variant={showCard ? "secondary" : "outline"}
            size="sm"
            className="min-h-10"
            aria-pressed={showCard}
            onClick={() => setShowCard((v) => !v)}
          >
            {showCard ? "Hide card" : "Preview card"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="min-h-10"
            onClick={() => {
              const el = document.getElementById("session-recap-print");
              if (!el) return;
              const html = el.innerHTML;
              const w = window.open("", "_blank");
              if (!w) return;
              w.document.write(`<html><head><title>Session recap</title></head><body>${html}</body></html>`);
              w.document.close();
              w.print();
            }}
          >
            Print
          </Button>
          </div>
        </CardHeader>
        <CardContent id="session-recap-print">
          {/* R10 B3.1 — the calm ceremonial beat. A restrained aurora bloom +
              an engraved score + a serif counsel line (the "Reckoning" idiom),
              shown only for a genuine personal best and/or a streak milestone.
              Confetti is now the rare accent on top, not the whole event. */}
          {showCeremony && (
            <m.div variants={reduce ? undefined : fadeUp} className="mb-5">
              <AccentPanel breathe>
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0">
                    <span className="type-overline flex items-center gap-1.5 text-primary">
                      {isPB ? (
                        <>
                          <Icon as={Trophy} size="xs" /> Personal best
                        </>
                      ) : (
                        <>
                          <Icon as={Flame} size="xs" /> Streak milestone
                        </>
                      )}
                    </span>
                    {isPB && stats.score != null ? (
                      <StatNumber
                        value={stats.score}
                        size="stat"
                        voice="numeric"
                        className="mt-1"
                      />
                    ) : (
                      tier != null && (
                        // Engraved day count + a muted unit (Countdown's idiom),
                        // so "days" doesn't render in the mono numeral face.
                        <div className="mt-1 flex items-baseline gap-2">
                          <StatNumber value={tier} size="stat" voice="numeric" />
                          <span className="text-sm text-muted-foreground">
                            day streak
                          </span>
                        </div>
                      )
                    )}
                    <p className="type-counsel mt-2 max-w-prose text-sm text-muted-foreground [text-wrap:pretty]">
                      {ceremonyCounsel(isPB, pbGain, tier)}
                    </p>
                  </div>
                  {/* When both land at once, the streak rides as a quiet chip. */}
                  {isPB && tier != null && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-chip bg-warning-subtle px-2 py-0.5 text-xs font-semibold text-warning">
                      <Icon as={Flame} size="xs" /> {tier}-day streak
                    </span>
                  )}
                </div>
              </AccentPanel>
            </m.div>
          )}

          <m.div
            variants={reduce ? undefined : stagger}
            className="grid grid-cols-2 gap-4 sm:grid-cols-4"
          >
            <Stat reduce={reduce} label="Score">
              {stats.score != null ? (
                <StatNumber value={stats.score} size="stat" voice="numeric" />
              ) : (
                <span className="type-numeric text-2xl font-semibold leading-none">
                  —
                </span>
              )}
            </Stat>
            <Stat reduce={reduce} label="Accuracy">
              <StatNumber
                value={Math.round(stats.accuracy * 100)}
                suffix="%"
                size="stat"
                voice="numeric"
              />
            </Stat>
            <Stat reduce={reduce} label="Time">
              <span className="type-numeric text-2xl font-semibold leading-none">
                {formatMs(stats.timeMs)}
              </span>
            </Stat>
            <Stat reduce={reduce} label="Timed vs BR">
              <StatNumber
                value={Math.round(stats.brGap * 100)}
                prefix={stats.brGap > 0 ? "+" : ""}
                suffix="%"
                size="stat"
                voice="numeric"
              />
            </Stat>
          </m.div>

          <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            {stats.best && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Best:</span>
                <TypeBadge qType={stats.best.qType} />
                <span className="tabular-nums text-muted-foreground">
                  {pct(stats.best.correct / stats.best.total)}
                </span>
              </div>
            )}
            {stats.worst && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Weakest:</span>
                <TypeBadge qType={stats.worst.qType} />
                <span className="tabular-nums text-muted-foreground">
                  {pct(stats.worst.correct / stats.worst.total)}
                </span>
              </div>
            )}
          </div>
          {stats.brGap > 0.05 && (
            <p className="mt-3 text-xs text-muted-foreground">
              Your blind-review accuracy was {pct(stats.brGap)} higher than timed —
              the understanding is there; this is a pacing problem to drill.
            </p>
          )}
        </CardContent>
      </Card>
      {/* R8 W5.2 — the premium gradient share card used to live only off-screen
          as an export target. It's now viewable on demand (the export path still
          reads the same node). Off-screen when hidden so PNG/SVG export works. */}
      {showCard ? (
        <div className="mt-4 flex justify-center overflow-x-auto">
          <RecapShareCard ref={shareRef} {...shareProps} />
        </div>
      ) : (
        <div className="pointer-events-none fixed -left-[9999px] top-0" aria-hidden>
          <RecapShareCard ref={shareRef} {...shareProps} />
        </div>
      )}
    </m.div>
  );
}

/**
 * One short serif counsel line for the ceremonial beat — calm but celebratory.
 * Speaks from the existing PB gain and/or the crossed streak tier; no new data.
 */
function ceremonyCounsel(
  isPB: boolean,
  pbGain: number | null,
  tier: number | null,
): string {
  if (isPB) {
    const gain =
      pbGain != null && pbGain > 0
        ? ` — ${pbGain} ${pluralize(pbGain, "point")} over your last best`
        : "";
    if (tier != null) {
      return `A new personal best${gain}, on a ${tier}-day streak. The routine is paying off — hold the line.`;
    }
    return `A new personal best${gain}. Quiet proof the work is compounding — keep the routine steady.`;
  }
  // Streak-only ceremony.
  if (tier === 100)
    return "One hundred days of showing up. This is what mastery is made of — protect it.";
  if (tier === 30)
    return "Thirty days unbroken. The habit is yours now — let the scores follow it.";
  return "Seven days running. The streak is real — keep the momentum honest under time.";
}

function Stat({
  label,
  children,
  reduce,
}: {
  label: string;
  children: React.ReactNode;
  reduce: boolean | null;
}) {
  return (
    <m.div
      variants={reduce ? undefined : fadeUp}
      className="rounded-card border bg-surface-2 p-3"
    >
      <div className="type-overline text-muted-foreground">{label}</div>
      <div className="mt-1">{children}</div>
    </m.div>
  );
}
