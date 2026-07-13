import type { ByTypeRow, SessionSummary } from "./types";

export interface MilestoneUnlock {
  id: string;
  title: string;
  description: string;
}

export function computeMilestoneUnlocks(opts: {
  sessions: SessionSummary[];
  byType: ByTypeRow[];
  predictedScore: number | null | undefined;
  streakDays: number;
}): string[] {
  const ids: string[] = [];
  const { sessions, byType, predictedScore, streakDays } = opts;
  const scoreSignal = predictedScore ?? 0;

  if (sessions.some((s) => s.type === "section" || s.type === "drill")) {
    ids.push("first-section");
  }
  if (sessions.some((s) => s.scaled_score != null)) {
    ids.push("first-score");
  }
  if (scoreSignal >= 160) ids.push("pb");
  if (streakDays >= 7) ids.push("streak-7");
  const totalAttempts = byType.reduce((s, r) => s + r.attempts, 0);
  if (totalAttempts >= 100) ids.push("century");
  if (byType.some((r) => r.attempts >= 10 && r.accuracy >= 0.85)) {
    ids.push("type-master");
  }

  return ids;
}
