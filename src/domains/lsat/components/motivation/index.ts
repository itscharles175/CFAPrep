export { StudyCalendar } from "./StudyCalendar";
export type { StudyCalendarProps } from "./StudyCalendar";

export { Countdown } from "./Countdown";
export type { CountdownProps } from "./Countdown";

// R10 B1.4 — milestone cohesion. <ProgressLedger> is the CANONICAL milestone
// language on the Console (R9 folded the trophy grid + the Unlocked/Locked
// gallery into one calm ledger; it is what <DashboardBelowFold> renders). The
// <Milestones> grid + <MilestoneGallery> badges below are the standalone /
// shareable variants — kept, but now spoken in the same token language so they
// no longer diverge. Prefer <ProgressLedger> for any new Console surface.
export { Milestones } from "./Milestones";
export type { MilestonesProps } from "./Milestones";

export { MilestoneGallery } from "./MilestoneGallery";

export { ProgressLedger } from "./progress-ledger";
export type { ProgressLedgerProps } from "./progress-ledger";

export { TodayPlan } from "./TodayPlan";

export { RecommendationInbox } from "./recommendation-inbox";

export { ReadinessCard } from "./readiness-card";

export { SessionRecap } from "./SessionRecap";
export type { SessionRecapProps } from "./SessionRecap";

export { computeStreak, daysStudiedThisWeek } from "./streak";
export type { StreakInfo } from "./streak";

export { celebratePersonalBest } from "./confetti";

export { StreakInsights } from "./streak-insights";

export { StudyNudge } from "./study-nudge";
