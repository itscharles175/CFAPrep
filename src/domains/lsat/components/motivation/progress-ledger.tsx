import { useMemo, useRef, useState } from "react";
import { Check, Download } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@lsat/components/ui/card";
import { Button } from "@lsat/components/ui/button";
import { Icon } from "@lsat/components/ui/icon";
import { MilestoneShareCard } from "@lsat/components/motivation/milestone-share-card";
import { exportNodeAsPng } from "@lsat/lib/recapExport";
import type { ByTypeRow, SessionSummary } from "@lsat/lib/types";
import { qTypeLabel } from "@lsat/lib/labels";
import { cn } from "@lsat/lib/utils";

export interface ProgressLedgerProps {
  byType: ByTypeRow[];
  sessions: SessionSummary[];
  predictedScore: number | null | undefined;
  /** Named achievement ids unlocked (computeMilestoneUnlocks output). */
  unlockedIds?: string[];
}

interface LedgerRow {
  id: string;
  label: string;
  done: boolean;
  /** 0..1 progress for in-progress rows; absent for binary achievements. */
  progress?: number;
}

const VOLUME_TARGETS = [100, 250, 500, 1000];

// The four named, binary achievements that the old "Milestones gallery" tracked
// — folded in here as plain ledger rows (no Unlocked/Locked badges).
const NAMED: { id: string; label: string }[] = [
  { id: "first-section", label: "First timed section" },
  { id: "br-pass", label: "Blind review graduate" },
  { id: "streak-7", label: "Seven-day streak" },
  { id: "pb", label: "Personal best score" },
];

/**
 * R9 (docs/19, "One voice + de-gamify") — the single quiet "Progress" ledger
 * that replaces the two stacked, gamified milestone cards (the trophy/share
 * grid + the Unlocked/Locked badge gallery). Computes the same data-derived
 * milestones (volume / score / per-type mastery) and folds in the named
 * achievements as calm ledger rows: title · thin meter · a done check. Share
 * export is preserved as a quiet per-row affordance.
 */
export function ProgressLedger({
  byType,
  sessions,
  predictedScore,
  unlockedIds = [],
}: ProgressLedgerProps) {
  const rows = useMemo<LedgerRow[]>(() => {
    const lrDone = byType
      .filter((r) => r.section_type === "LR")
      .reduce((s, r) => s + r.attempts, 0);
    const rcDone = byType
      .filter((r) => r.section_type === "RC")
      .reduce((s, r) => s + r.attempts, 0);

    const nextLr =
      VOLUME_TARGETS.find((t) => lrDone < t) ??
      VOLUME_TARGETS[VOLUME_TARGETS.length - 1];
    const prevLr = [0, ...VOLUME_TARGETS].filter((t) => t < nextLr).pop() ?? 0;

    const bestSection = sessions.reduce(
      (m, s) => Math.max(m, s.scaled_score ?? 0),
      0,
    );
    const SCORE_TARGET = 165;
    const scoreSignal = Math.max(bestSection, predictedScore ?? 0);

    const masteredType = [...byType]
      .filter((r) => r.attempts >= 10)
      .sort((a, b) => b.accuracy - a.accuracy)[0];

    const derived: LedgerRow[] = [
      {
        id: "lr-volume",
        label: `${nextLr} LR questions`,
        done: lrDone >= nextLr,
        progress: Math.min(1, (lrDone - prevLr) / Math.max(1, nextLr - prevLr)),
      },
      {
        id: "rc-volume",
        label: "100 RC questions",
        done: rcDone >= 100,
        progress: Math.min(1, rcDone / 100),
      },
      {
        id: "first-165",
        label: `First ${SCORE_TARGET} section`,
        done: scoreSignal >= SCORE_TARGET,
        progress: Math.min(1, scoreSignal / SCORE_TARGET),
      },
    ];

    if (masteredType) {
      derived.push({
        id: `mastery-${String(masteredType.q_type)}`,
        label: `${qTypeLabel(masteredType.q_type)} mastery`,
        done: masteredType.accuracy >= 0.8,
        progress: Math.min(1, masteredType.accuracy / 0.8),
      });
    }

    const named: LedgerRow[] = NAMED.map((m) => ({
      id: m.id,
      label: m.label,
      done: unlockedIds.includes(m.id),
    }));

    return [...derived, ...named];
  }, [byType, sessions, predictedScore, unlockedIds]);

  const shareRef = useRef<HTMLDivElement>(null);
  const [shareTarget, setShareTarget] = useState<LedgerRow | null>(null);
  const [exporting, setExporting] = useState(false);

  async function shareRow(row: LedgerRow) {
    setShareTarget(row);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (!shareRef.current) return;
    setExporting(true);
    try {
      await exportNodeAsPng(shareRef.current, `lsatlab-progress-${row.id}.png`);
    } finally {
      setExporting(false);
      setShareTarget(null);
    }
  }

  const doneCount = rows.filter((r) => r.done).length;

  return (
    <Card>
      <CardHeader className="flex-row items-baseline justify-between space-y-0">
        <CardTitle className="text-base">Progress</CardTitle>
        <span className="type-numeric text-xs text-muted-foreground">
          {doneCount} / {rows.length}
        </span>
      </CardHeader>
      {shareTarget && (
        <div className="pointer-events-none fixed -left-[9999px] top-0">
          <MilestoneShareCard
            ref={shareRef}
            label={shareTarget.label}
            progressPct={shareTarget.done ? 100 : Math.round((shareTarget.progress ?? 0) * 100)}
            predictedScore={predictedScore ?? 0}
          />
        </div>
      )}
      <CardContent className="divide-y">
        {rows.map((row) => {
          const frac = row.done ? 1 : (row.progress ?? 0);
          const showMeter = !row.done && row.progress != null;
          return (
            <div key={row.id} className="flex items-center gap-3 py-2.5">
              {/* Quiet state mark — a filled check when done, a hollow ring otherwise. */}
              <span
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
                  row.done
                    ? "border-success/40 bg-success-subtle text-success"
                    : "border-border text-transparent",
                )}
                aria-hidden
              >
                <Icon as={Check} size="xs" />
              </span>

              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className={cn(
                      "truncate text-sm",
                      !row.done && "text-muted-foreground",
                    )}
                  >
                    {row.label}
                  </span>
                  {showMeter && (
                    <span className="type-numeric shrink-0 text-2xs text-muted-foreground">
                      {Math.round(frac * 100)}%
                    </span>
                  )}
                </div>
                {showMeter && (
                  <div className="h-1 overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-primary/70"
                      style={{ width: `${Math.round(frac * 100)}%` }}
                    />
                  </div>
                )}
              </div>

              {row.done && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground"
                  disabled={exporting}
                  onClick={() => void shareRow(row)}
                  aria-label={`Share ${row.label}`}
                >
                  <Icon as={Download} size="xs" />
                  Share
                </Button>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
