/**
 * E7: FSRS (Free Spaced Repetition Scheduler) — Empirically superior to SM-2.
 *
 * Implements the FSRS-4.5 algorithm with four parameters:
 * - Stability (S): Estimated time for retention to drop to 90%
 * - Difficulty (D): Intrinsic difficulty of the card (1–10 scale)
 * - Retrievability (R): Probability of recall at time t
 *
 * Reference: https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm
 */

import type { Confidence, ErrorCategory, QuestionResult, ReviewItem } from './learningTypes';

const DAY_MS = 24 * 60 * 60 * 1000;

/** FSRS-4.5 default weights (w0–w12) */
const W = [
  0.4,    // w0: initial stability for "again"
  0.6,    // w1: initial stability for "hard"
  2.4,    // w2: initial stability for "good"
  5.8,    // w3: initial stability for "easy"
  4.93,   // w4: difficulty mean reversion
  0.94,   // w5: difficulty mean reversion weight
  0.86,   // w6: stability increase base
  0.01,   // w7: stability penalty for fail
  1.49,   // w8: stability modifier for difficulty
  0.14,   // w9: stability modifier for stability
  0.94,   // w10: stability modifier for retrievability
  2.18,   // w11: stability modifier for success
  0.05,   // w12: stability decrease factor
];

/** Map QuantVault confidence + correctness to FSRS rating (1–4) */
function toRating(correct: boolean, confidence: Confidence): number {
  if (!correct) return 1; // again
  if (confidence === 'low') return 2; // hard
  if (confidence === 'medium') return 3; // good
  return 4; // easy
}

/** Calculate retrievability at elapsed days since last review */
function retrievability(stability: number, elapsedDays: number): number {
  return Math.pow(1 + elapsedDays / (9 * stability), -1);
}

/** Initial stability based on first rating */
function initialStability(rating: number): number {
  return Math.max(0.1, W[rating - 1]);
}

/** Initial difficulty based on first rating */
function initialDifficulty(rating: number): number {
  return Math.min(10, Math.max(1, W[4] - (rating - 3) * W[5]));
}

/** Update difficulty after a review */
function nextDifficulty(d: number, rating: number): number {
  const newD = d - W[5] * (rating - 3);
  // Mean reversion toward initial difficulty
  const meanReverted = W[4] * (1 - W[5]) + newD * W[5];
  return Math.min(10, Math.max(1, meanReverted));
}

/** Calculate next stability after a successful recall */
function nextStabilitySuccess(d: number, s: number, r: number, rating: number): number {
  const hardPenalty = rating === 2 ? W[11] : 1;
  const easyBonus = rating === 4 ? W[12] : 1;
  return s * (
    1 +
    Math.exp(W[6]) *
    (11 - d) *
    Math.pow(s, -W[7]) *
    (Math.exp((1 - r) * W[8]) - 1) *
    hardPenalty *
    easyBonus
  );
}

/** Calculate next stability after a failed recall */
function nextStabilityFail(d: number, s: number, r: number): number {
  return Math.max(
    0.1,
    W[9] * Math.pow(d, -W[10]) * (Math.pow(s + 1, W[11]) - 1) * Math.exp((1 - r) * W[12]),
  );
}

/** Apply an error-category penalty to the calculated interval */
function errorPenalty(errorCategory: ErrorCategory): number {
  if (errorCategory === 'none') return 1;
  if (errorCategory === 'misread') return 0.92;
  if (errorCategory === 'time-pressure') return 0.88;
  if (errorCategory === 'calculation') return 0.82;
  return 0.76; // concept, formula, ethics-judgment
}

export function addDays(date: Date, days: number): string {
  const next = new Date(date.getTime() + days * DAY_MS);
  next.setHours(9, 0, 0, 0);
  return next.toISOString();
}

/**
 * E7: FSRS-based review scheduling.
 * Replaces the previous SM-2 variant with an empirically superior algorithm.
 * The `ease` field now stores FSRS stability, and we track difficulty internally.
 */
export function scheduleReview(
  result: QuestionResult,
  previous?: ReviewItem,
  now = new Date(result.createdAt || Date.now()),
): Pick<ReviewItem, 'intervalDays' | 'ease' | 'fsrsDifficulty' | 'dueAt' | 'attempts' | 'correctStreak'> {
  const rating = toRating(result.correct, result.confidence);
  const attempts = (previous?.attempts ?? 0) + 1;
  const correctStreak = result.correct ? (previous?.correctStreak ?? 0) + 1 : 0;

  let stability: number;
  let difficulty: number;

  if (!previous || previous.ease < 0.1) {
    // First review — use initial parameters
    stability = initialStability(rating);
    difficulty = initialDifficulty(rating);
  } else {
    // Subsequent reviews
    const priorStability = previous.ease; // We store stability in the ease field
    const priorDifficulty = previous.fsrsDifficulty ?? 5;
    const elapsedDays = Math.max(0.01, (now.getTime() - new Date(previous.dueAt).getTime()) / DAY_MS + previous.intervalDays);
    const r = retrievability(priorStability, elapsedDays);

    difficulty = nextDifficulty(priorDifficulty, rating);

    if (result.correct) {
      stability = nextStabilitySuccess(difficulty, priorStability, r, rating);
    } else {
      stability = nextStabilityFail(difficulty, priorStability, r);
    }
  }

  // Calculate interval from stability (target 90% retention)
  const desiredRetention = 0.9;
  let intervalDays = Math.round(
    9 * stability * (1 / Math.pow(desiredRetention, 1) - 1) * errorPenalty(result.errorCategory),
  );

  // Clamp: 1 day min, 365 days max (FSRS allows much longer intervals than SM-2's 60-day cap)
  intervalDays = Math.min(365, Math.max(1, intervalDays));

  // For failed cards, cap at 3 days regardless
  if (!result.correct) {
    intervalDays = Math.min(3, intervalDays);
  }

  return {
    intervalDays,
    ease: stability, // Store FSRS stability in the existing ease field
    fsrsDifficulty: difficulty,
    dueAt: addDays(now, intervalDays),
    attempts,
    correctStreak,
  };
}

export function masteryScoreForResults(results: QuestionResult[], now = new Date()): number {
  if (!results.length) return 0;
  const latest = [...results].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')).slice(-12);
  const weighted = latest.map((result, index) => {
    const ageDays = result.createdAt ? Math.max(0, (now.getTime() - new Date(result.createdAt).getTime()) / DAY_MS) : 0;
    // Use FSRS-style retrievability decay instead of linear decay
    const recency = retrievability(14, ageDays); // Assume ~14 day baseline stability for weighting
    const confidence = result.confidence === 'high' ? 1 : result.confidence === 'medium' ? 0.68 : 0.34;
    const correctness = result.correct ? 1 : 0;
    const position = 0.65 + ((index + 1) / latest.length) * 0.35;
    const penalty = result.errorCategory === 'none' ? 0 : result.errorCategory === 'misread' ? 0.08 : result.errorCategory === 'time-pressure' ? 0.12 : result.errorCategory === 'calculation' ? 0.18 : 0.24;
    return {
      value: (correctness * 0.72 + confidence * 0.28 - penalty) * recency * position,
      weight: recency * position,
    };
  });
  const score = weighted.reduce((sum, row) => sum + row.value, 0) / weighted.reduce((sum, row) => sum + row.weight, 0);
  return Math.round(Math.min(100, Math.max(0, score * 100)));
}

export function isDue(item: ReviewItem, at = new Date()): boolean {
  return new Date(item.dueAt).getTime() <= at.getTime();
}

export function rankReviewItems(items: ReviewItem[], at = new Date()): ReviewItem[] {
  return [...items].sort((a, b) => {
    const aDue = isDue(a, at) ? 0 : 1;
    const bDue = isDue(b, at) ? 0 : 1;
    if (aDue !== bDue) return aDue - bDue;
    if (a.dueAt !== b.dueAt) return a.dueAt.localeCompare(b.dueAt);
    return a.ease - b.ease;
  });
}

/** Calculate current retrievability for a review item */
export function currentRetrievability(item: ReviewItem, at = new Date()): number {
  const elapsedDays = Math.max(0, (at.getTime() - new Date(item.dueAt).getTime()) / DAY_MS + item.intervalDays);
  return retrievability(item.ease, elapsedDays);
}

/** Predict retention at a future date */
export function predictRetention(item: ReviewItem, targetDate: Date): number {
  const elapsedDays = Math.max(0, (targetDate.getTime() - new Date(item.dueAt).getTime()) / DAY_MS + item.intervalDays);
  return retrievability(item.ease, elapsedDays);
}

export interface LearningRecommendation {
  label: string;
  title: string;
  path: string;
  reason: string;
}

export function nextRecommendation({
  dueReviews,
  weakObjectives,
  continuePath,
}: {
  dueReviews: ReviewItem[];
  weakObjectives: Array<{ title: string; path: string; score: number }>;
  continuePath?: string | null;
}): LearningRecommendation {
  if (dueReviews.length) {
    const first = dueReviews[0];
    return {
      label: 'Review Due',
      title: first.title,
      path: first.path,
      reason: 'Scheduled by your local FSRS spaced-repetition queue.',
    };
  }

  if (weakObjectives.length) {
    const first = weakObjectives[0];
    return {
      label: 'Weak Area',
      title: first.title,
      path: first.path,
      reason: `Current mastery estimate is ${first.score}%.`,
    };
  }

  return {
    label: 'Continue',
    title: 'Resume your latest module',
    path: continuePath || '/cfa',
    reason: 'No urgent review items are due.',
  };
}
