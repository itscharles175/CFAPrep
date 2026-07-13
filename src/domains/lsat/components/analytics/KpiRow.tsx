import { Card } from "@lsat/components/ui/card";
import { StatNumber, Sparkline } from "@lsat/components/viz";

export interface KpiRowProps {
  predictedScore: number | null | undefined;
  scoreDelta30d: number | null | undefined;
  accuracy: number; // 0..1
  avgTimeMsPerQ: number;
  brGap: number; // 0..1 (br - timed)
  /** Recent score series for the sparkline beside the predicted KPI. */
  trend: number[];
  /** Optional prior-period deltas when compare mode is on (Wave 3). */
  compare?: {
    scoreDelta?: number;
    accuracyDelta?: number;
    timeDeltaSec?: number;
    brGapDelta?: number;
  };
}

/**
 * R9 §1 — KPI row as an instrument cluster. Adopts the Dashboard's hero
 * treatment instead of four identical flat cards:
 *  - **Predicted score** is the primary instrument — full-width, the mono
 *    `voice="numeric"` figure wrapped in the breathing `.aurora`, with a serif
 *    counsel subline and the real score sparkline beside it.
 *  - Accuracy / pace / blind-review gap are secondary gauges, each with a
 *    one-line derived counsel subline so a number reads as a verdict.
 * All copy is derived from values already on the page (no new data/series).
 */
export function KpiRow({
  predictedScore,
  scoreDelta30d,
  accuracy,
  avgTimeMsPerQ,
  brGap,
  trend,
  compare,
}: KpiRowProps) {
  const avgSec = Math.round(avgTimeMsPerQ / 1000);
  const accPct = Math.round(accuracy * 100);
  const gapPts = Math.round(brGap * 100);
  const hasScoreDelta = compare?.scoreDelta != null || scoreDelta30d != null;
  const scoreDelta = compare?.scoreDelta ?? scoreDelta30d ?? 0;

  // --- Derived one-line counsel per instrument (no new data). ----------------
  const predictedSub =
    !hasScoreDelta
      ? "Set a timed baseline to start the score trend."
      : scoreDelta > 0
      ? `Trending up ${scoreDelta} pts — keep the cadence.`
      : scoreDelta < 0
        ? `Down ${Math.abs(scoreDelta)} pts lately — protect your routine.`
        : "Holding steady — push for the next band.";

  const accuracySub =
    accPct >= 80
      ? "Strong command across types."
      : accPct >= 65
        ? "Solid base; the misses are findable."
        : "Accuracy is the lever right now.";

  const paceSub =
    avgSec === 0
      ? "No timed pace yet."
      : avgSec <= 60
        ? `${avgSec}s/Q — comfortably inside the clock.`
        : avgSec <= 85
          ? `${avgSec}s/Q — near the budget; trim the long ones.`
          : `${avgSec}s/Q — pace is eating your score.`;

  const gapSub =
    gapPts >= 8
      ? "Big timed→BR gap: timing, not understanding."
      : gapPts >= 3
        ? "Small recovery in review — tighten pacing."
        : "Timed and review accuracy agree.";

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {/* Primary instrument — predicted score spans the full row top on lg. */}
      <Card className="col-span-2 flex items-center justify-between gap-4 bg-surface-1 p-5 shadow-e2 lg:col-span-4">
        <StatNumber
          label="Predicted score"
          value={predictedScore}
          size="stat-xl"
          voice="numeric"
          aurora
          delta={scoreDelta}
          deltaSuffix={compare?.scoreDelta != null ? " vs prior" : undefined}
          subline={predictedSub}
        />
        {trend.length > 1 && (
          <Sparkline
            data={trend}
            fill
            width={140}
            height={56}
            className="hidden shrink-0 self-center sm:block"
          />
        )}
      </Card>

      <Card className="p-4 shadow-e1">
        <StatNumber
          label="Accuracy"
          value={accPct}
          suffix="%"
          voice="numeric"
          delta={compare?.accuracyDelta}
          deltaSuffix={compare?.accuracyDelta != null ? "%" : undefined}
          subline={accuracySub}
        />
      </Card>
      <Card className="p-4 shadow-e1">
        <StatNumber
          label="Avg time / question"
          value={avgSec}
          suffix="s"
          voice="numeric"
          delta={compare?.timeDeltaSec}
          deltaSuffix={compare?.timeDeltaSec != null ? "s" : undefined}
          subline={paceSub}
        />
      </Card>
      <Card className="p-4 shadow-e1">
        <StatNumber
          label="Blind-review gap"
          value={gapPts}
          suffix="pts"
          voice="numeric"
          delta={compare?.brGapDelta}
          deltaSuffix={compare?.brGapDelta != null ? "pts" : undefined}
          subline={gapSub}
        />
      </Card>
    </div>
  );
}
