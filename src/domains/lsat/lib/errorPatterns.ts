import type { ErrorLogEntry } from "./types";

export interface ErrorPattern {
  reason: string;
  count: number;
  label: string;
}

const REASON_LABELS: Record<string, string> = {
  trap: "trap",
  reversal: "reversal",
  scope: "scope",
  degree: "degree",
  causal: "causal",
  diagram: "diagram",
  vocabulary: "vocabulary",
  pacing: "pacing",
  misread: "misread",
  other: "other",
};

/** Top error-log patterns in the last N days (R4-A9). */
export function detectErrorPatterns(
  entries: ErrorLogEntry[],
  days = 7,
): ErrorPattern[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const iso = cutoff.toISOString().slice(0, 10);

  const counts = new Map<string, number>();
  for (const e of entries) {
    const d = e.created_at?.slice(0, 10) ?? "";
    if (d && d < iso) continue;
    const r = e.reason ?? "other";
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([reason, count]) => ({
      reason,
      count,
      label: REASON_LABELS[reason] ?? reason,
    }))
    .filter((p) => p.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
}
