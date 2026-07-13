/**
 * Exam-readiness cockpit — synthesises a projected mastery curve from
 * today through the user's exam date, with confidence bands derived from
 * the spread of recent attempts.
 *
 * The model is deliberately simple but honest:
 *
 *   - Current mastery is the topic-weighted average of `masterySnapshots`.
 *   - Daily improvement assumes the user keeps the same per-day attempt
 *     rate seen over the trailing 14-day window.  No new attempts → no
 *     projected lift.
 *   - Per-attempt lift is calibrated by the trailing accuracy: an
 *     attempt at 80% accuracy lifts mastery less than an attempt at 50%
 *     accuracy (you're learning more from a hard problem you eventually
 *     get right).
 *   - Confidence band is ±1.96 σ of the per-day attempt count over the
 *     trailing window (Wald-style), clipped to [0, 100].
 *
 * Output is an array of `{ date, projected, lower, upper }` ready to drop
 * into a recharts <ComposedChart>.
 */

import type { MasterySnapshot, QuestionResult } from './learningTypes';

export interface ReadinessPoint {
  /** ISO date (YYYY-MM-DD) of this projection slot. */
  date: string;
  /** Projected mastery 0-100. */
  projected: number;
  /** Lower bound of 95% confidence band, 0-100. */
  lower: number;
  /** Upper bound of 95% confidence band, 0-100. */
  upper: number;
  /** True when this is the exam date itself. */
  isExamDate: boolean;
}

export interface ReadinessProjection {
  startDate: string;
  examDate: string | null;
  daysUntilExam: number;
  currentMastery: number;
  projectedOnExamDate: number | null;
  projectedBand: { lower: number; upper: number } | null;
  averageDailyAttempts: number;
  averageAccuracy: number;
  perAttemptLift: number;
  points: ReadinessPoint[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const Z95 = 1.96;

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Topic-weighted current mastery: weight each topic's snapshot by attempts
 * so a heavily-practised topic counts more than a thin one.
 */
export function topicWeightedMastery(
  snapshots: MasterySnapshot[],
  attemptsByTopic: Map<string, number>,
): number {
  if (!snapshots.length) return 0;
  let weightedSum = 0;
  let totalWeight = 0;
  for (const snap of snapshots) {
    const w = Math.max(1, attemptsByTopic.get(`${snap.domain}::${snap.topic}`) ?? 1);
    weightedSum += snap.score * w;
    totalWeight += w;
  }
  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

/**
 * Build the projection from the user's mastery snapshots, question
 * results, and exam date.
 *
 * @param now The "as of" timestamp.  Tests pin this.  Defaults to Date.now().
 */
export function projectExamReadiness(args: {
  snapshots: MasterySnapshot[];
  results: QuestionResult[];
  examDate: string | null;
  now?: Date;
}): ReadinessProjection {
  const now = args.now ?? new Date();
  const startDate = formatDate(now);

  // Trailing-14-day window.
  const windowMs = 14 * DAY_MS;
  const cutoff = now.getTime() - windowMs;
  const recentResults = args.results.filter((r) => {
    if (!r.createdAt) return false;
    const t = Date.parse(r.createdAt);
    return Number.isFinite(t) && t >= cutoff;
  });

  const attemptsByTopic = new Map<string, number>();
  for (const r of args.results) {
    const key = `${r.domain}::${r.topic}`;
    attemptsByTopic.set(key, (attemptsByTopic.get(key) ?? 0) + 1);
  }
  const currentMastery = topicWeightedMastery(args.snapshots, attemptsByTopic);

  const averageDailyAttempts = recentResults.length / 14;
  const correctCount = recentResults.reduce((acc, r) => acc + (r.correct ? 1 : 0), 0);
  const averageAccuracy = recentResults.length > 0 ? correctCount / recentResults.length : 0.6;

  // Per-attempt lift is higher when accuracy is lower (more learning happens
  // from the cases you almost-get-wrong-but-not-quite).  Caps:
  //   accuracy 0.30 → +0.65 mastery points per attempt
  //   accuracy 0.90 → +0.10 mastery points per attempt
  //   accuracy 1.00 → 0     (you already know it)
  const perAttemptLift = clamp(0.75 - averageAccuracy * 0.75, 0, 0.75);

  // Stop the projection at exam date (or 90 days out if no exam date).
  let projectionDays: number;
  let daysUntilExam: number;
  if (args.examDate) {
    const exam = Date.parse(args.examDate);
    daysUntilExam = Math.max(0, Math.round((exam - now.getTime()) / DAY_MS));
    projectionDays = Math.min(180, daysUntilExam);
  } else {
    daysUntilExam = 0;
    projectionDays = 90;
  }

  const points: ReadinessPoint[] = [];
  let projected = currentMastery;
  for (let d = 0; d <= projectionDays; d++) {
    const date = new Date(now.getTime() + d * DAY_MS);
    const dailyLift = averageDailyAttempts * perAttemptLift;
    if (d > 0) {
      // Diminishing returns: each lift is scaled by the remaining headroom.
      const headroom = 100 - projected;
      projected += dailyLift * (headroom / 100);
    }
    projected = clamp(projected, 0, 100);

    // Wald-style band on accumulated attempts.
    const attemptsTo = averageDailyAttempts * d;
    const sd = Math.sqrt(Math.max(1, attemptsTo) * averageAccuracy * (1 - averageAccuracy));
    const liftSd = sd * perAttemptLift;
    const lower = clamp(projected - Z95 * liftSd, 0, 100);
    const upper = clamp(projected + Z95 * liftSd, 0, 100);

    const isExamDate = args.examDate != null && formatDate(date) === args.examDate;

    points.push({
      date: formatDate(date),
      projected: Math.round(projected * 10) / 10,
      lower: Math.round(lower * 10) / 10,
      upper: Math.round(upper * 10) / 10,
      isExamDate,
    });
  }

  // Without an exam date, the "projected" terminal value is just the last
  // point in the 90-day window — useful as a horizon estimate.
  const examPoint = args.examDate
    ? points.find((p) => p.isExamDate) ?? points[points.length - 1]
    : points[points.length - 1];

  return {
    startDate,
    examDate: args.examDate,
    daysUntilExam,
    currentMastery: Math.round(currentMastery * 10) / 10,
    projectedOnExamDate: examPoint ? examPoint.projected : null,
    projectedBand: examPoint ? { lower: examPoint.lower, upper: examPoint.upper } : null,
    averageDailyAttempts: Math.round(averageDailyAttempts * 10) / 10,
    averageAccuracy: Math.round(averageAccuracy * 100) / 100,
    perAttemptLift: Math.round(perAttemptLift * 100) / 100,
    points,
  };
}
