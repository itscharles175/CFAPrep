import { useMemo, useRef, useState } from "react";
import { Award, CheckCircle2, Download } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@lsat/components/ui/card";
import { Button } from "@lsat/components/ui/button";
import { Icon } from "@lsat/components/ui/icon";
import { ProgressRing } from "@lsat/components/viz";
import { MilestoneShareCard } from "@lsat/components/motivation/milestone-share-card";
import { exportNodeAsPng } from "@lsat/lib/recapExport";
import type { ByTypeRow, SessionSummary } from "@lsat/lib/types";
import { qTypeLabel } from "@lsat/lib/labels";

export interface MilestonesProps {
  byType: ByTypeRow[];
  sessions: SessionSummary[];
  predictedScore: number;
}

interface Milestone {
  id: string;
  label: string;
  done: boolean;
  /** 0..1 progress for in-progress rings. */
  progress: number;
}

const VOLUME_TARGETS = [100, 250, 500, 1000];

/**
 * §5.5 — milestone chips + progress rings, computed from available data.
 *
 * R10 B1.4 cohesion note: the Console's milestone language is the single
 * {@link import("./progress-ledger").ProgressLedger} (R9 folded the trophy grid
 * + the Unlocked/Locked gallery into one quiet ledger). This grid + the badge
 * {@link import("./MilestoneGallery").MilestoneGallery} are kept as the
 * standalone/shareable variant; both are now spoken in the same token language
 * (`<Icon>`, depth surfaces, `bg-success-subtle`, `.type-overline` labels) so
 * there is no longer a divergent third idiom.
 */
export function Milestones({
  byType,
  sessions,
  predictedScore,
}: MilestonesProps) {
  const milestones = useMemo<Milestone[]>(() => {
    const lrDone = byType
      .filter((r) => r.section_type === "LR")
      .reduce((s, r) => s + r.attempts, 0);
    const rcDone = byType
      .filter((r) => r.section_type === "RC")
      .reduce((s, r) => s + r.attempts, 0);

    // Next LR volume milestone.
    const nextLr =
      VOLUME_TARGETS.find((t) => lrDone < t) ?? VOLUME_TARGETS[VOLUME_TARGETS.length - 1];
    const prevLr = [0, ...VOLUME_TARGETS].filter((t) => t < nextLr).pop() ?? 0;

    // Best scored section so far.
    const bestSection = sessions.reduce(
      (m, s) => Math.max(m, s.scaled_score ?? 0),
      0,
    );
    const SCORE_TARGET = 165;

    // Per-type mastery: highest-accuracy type that's hit 80%.
    const masteredType = [...byType]
      .filter((r) => r.attempts >= 10)
      .sort((a, b) => b.accuracy - a.accuracy)[0];

    const out: Milestone[] = [
      {
        id: "lr-volume",
        label: `${nextLr} LR done`,
        done: lrDone >= nextLr,
        progress: Math.min(1, (lrDone - prevLr) / Math.max(1, nextLr - prevLr)),
      },
      {
        id: "rc-volume",
        label: "100 RC done",
        done: rcDone >= 100,
        progress: Math.min(1, rcDone / 100),
      },
      {
        id: "first-165",
        label: `First ${SCORE_TARGET} section`,
        done: bestSection >= SCORE_TARGET || predictedScore >= SCORE_TARGET,
        progress: Math.min(1, Math.max(bestSection, predictedScore) / SCORE_TARGET),
      },
    ];

    if (masteredType) {
      out.push({
        id: `mastery-${String(masteredType.q_type)}`,
        label: `${qTypeLabel(masteredType.q_type)} mastery`,
        done: masteredType.accuracy >= 0.8,
        progress: Math.min(1, masteredType.accuracy / 0.8),
      });
    }

    return out;
  }, [byType, sessions, predictedScore]);

  const shareRef = useRef<HTMLDivElement>(null);
  const [shareTarget, setShareTarget] = useState<Milestone | null>(null);
  const [exporting, setExporting] = useState(false);

  async function shareMilestone(m: Milestone) {
    setShareTarget(m);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (!shareRef.current) return;
    setExporting(true);
    try {
      await exportNodeAsPng(
        shareRef.current,
        `lsatlab-milestone-${m.id}.png`,
      );
    } finally {
      setExporting(false);
      setShareTarget(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <Icon as={Award} size="md" className="text-primary" />
        <CardTitle>Milestones</CardTitle>
      </CardHeader>
      {shareTarget && (
        <div className="pointer-events-none fixed -left-[9999px] top-0">
          <MilestoneShareCard
            ref={shareRef}
            label={shareTarget.label}
            progressPct={Math.round(shareTarget.progress * 100)}
            predictedScore={predictedScore}
          />
        </div>
      )}
      <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {milestones.map((m) =>
          m.done ? (
            <div
              key={m.id}
              className="flex flex-col items-center gap-2 rounded-card border border-success/30 bg-success-subtle p-3 text-center"
            >
              <Icon as={CheckCircle2} size="lg" className="h-9 w-9 text-success" />
              <span className="text-xs font-medium leading-tight">{m.label}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs"
                disabled={exporting}
                onClick={() => void shareMilestone(m)}
              >
                <Icon as={Download} size="xs" />
                Share
              </Button>
            </div>
          ) : (
            <div
              key={m.id}
              className="flex flex-col items-center gap-2 rounded-card border bg-surface-2 p-3 text-center"
            >
              <ProgressRing
                value={m.progress}
                size={56}
                strokeWidth={6}
                label={
                  <span className="type-numeric text-xs">
                    {Math.round(m.progress * 100)}
                  </span>
                }
              />
              <span className="text-xs font-medium leading-tight text-muted-foreground">
                {m.label}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 text-xs"
                disabled={exporting}
                onClick={() => void shareMilestone(m)}
              >
                <Icon as={Download} size="xs" />
                Share
              </Button>
            </div>
          ),
        )}
      </CardContent>
    </Card>
  );
}
