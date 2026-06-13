import { m } from "motion/react";
import { fadeUp } from "@lsat/lib/motion";
import type { ActivityDay, ByTypeRow, SessionSummary } from "@lsat/lib/types";
import { ProgressLedger } from "./progress-ledger";
import { StreakInsights } from "./streak-insights";
import { StudyCalendar } from "./StudyCalendar";

export default function DashboardBelowFold({
  activity,
  byType,
  sessions,
  predictedScore,
  milestoneUnlocks,
  reduceMotion,
}: {
  activity: ActivityDay[];
  byType: ByTypeRow[];
  sessions: SessionSummary[];
  predictedScore: number | null | undefined;
  milestoneUnlocks: string[];
  reduceMotion: boolean;
}) {
  const motionProps = reduceMotion
    ? { variants: undefined as undefined }
    : { variants: fadeUp };

  return (
    <>
      <m.div {...motionProps}>
        <StudyCalendar activity={activity} />
      </m.div>
      <m.div {...motionProps}>
        <StreakInsights activity={activity} />
      </m.div>
      {/* R9 — the two stacked, gamified milestone cards (trophy grid +
          Unlocked/Locked gallery) are folded into one quiet Progress ledger. */}
      <m.div {...motionProps}>
        <ProgressLedger
          byType={byType}
          sessions={sessions}
          predictedScore={predictedScore}
          unlockedIds={milestoneUnlocks}
        />
      </m.div>
    </>
  );
}
