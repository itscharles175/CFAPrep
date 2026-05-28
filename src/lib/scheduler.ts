/**
 * E7: FSRS (Free Spaced Repetition Scheduler) — Empirically superior to SM-2.
 *
 * Implements the FSRS-4.5 algorithm via the `ts-fsrs` reference library.
 *
 * Key field mappings (unchanged from the hand-rolled version):
 * - ReviewItem.ease          → FSRS stability
 * - ReviewItem.fsrsDifficulty → FSRS difficulty
 *
 * QuantVault Confidence → ts-fsrs Rating mapping:
 * - not-correct             → Again (1)
 * - correct + low           → Hard  (2)
 * - correct + medium        → Good  (3)
 * - correct + high          → Easy  (4)
 *
 * Reference: https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm
 */

import { createEmptyCard, default_w, default_request_retention, fsrs, Rating, State } from 'ts-fsrs';
import type { Card, FSRS, Grade } from 'ts-fsrs';
import type { Confidence, ErrorCategory, QuestionResult, ReviewItem } from './learningTypes';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Cached FSRS instance.  Defaults to FSRS-4.5 library weights.  When the
 * user runs the optimizer (see `fsrsOptimizer.ts`), `setSchedulerParameters`
 * swaps this in-place with a fitted instance so all subsequent reviews use
 * the personalised weights without forcing every caller to rewire.
 */
let f: FSRS = fsrs();

/**
 * Replace the active FSRS instance with one parameterised by `{request_retention, w}`.
 * Called by the optimizer after a successful fit AND by the bootstrap path
 * when persisted custom weights are detected on startup.  Pass `undefined`
 * to revert to FSRS-4.5 library defaults.
 */
export function setSchedulerParameters(
  params: { request_retention?: number; w?: number[] } | undefined,
): void {
  if (!params) {
    f = fsrs();
    return;
  }
  const w = params.w ?? Array.from(default_w);
  // ts-fsrs typings narrow `w` to a fixed-length tuple; the runtime accepts a
  // plain number[] of the appropriate length, so we widen at this boundary.
  const partial = {
    request_retention: params.request_retention ?? default_request_retention,
    w,
  } as Parameters<typeof fsrs>[0];
  f = fsrs(partial);
}

/** Read the active FSRS instance — testing/debugging helper. */
export function getActiveScheduler(): FSRS {
  return f;
}

/** Map QuantVault confidence + correctness to ts-fsrs Grade (1–4, excludes Manual=0) */
function toRating(correct: boolean, confidence: Confidence): Grade {
  if (!correct) return Rating.Again as Grade; // 1
  if (confidence === 'low') return Rating.Hard as Grade;   // 2
  if (confidence === 'medium') return Rating.Good as Grade; // 3
  return Rating.Easy as Grade;                              // 4
}

/** Apply an error-category penalty to the calculated interval */
function errorPenalty(errorCategory: ErrorCategory): number {
  if (errorCategory === 'none') return 1;
  if (errorCategory === 'misread') return 0.92;
  if (errorCategory === 'time-pressure') return 0.88;
  if (errorCategory === 'calculation') return 0.82;
  return 0.76; // concept, formula, ethics-judgment
}

/**
 * Build a ts-fsrs Card from a previous ReviewItem.
 * When the ReviewItem exists and has a non-trivial stability (ease > 0.1),
 * we reconstruct it as a Review-state card so ts-fsrs runs its repeat formulas.
 * Otherwise we return a fresh empty card (first review).
 */
function cardFromReviewItem(previous: ReviewItem | undefined, now: Date): Card {
  if (!previous || previous.ease < 0.1) {
    return createEmptyCard(now);
  }

  const dueDate = new Date(previous.dueAt);
  // Estimate last_review as the day the previous interval started
  const lastReview = new Date(dueDate.getTime() - previous.intervalDays * DAY_MS);

  return {
    due: dueDate,
    stability: previous.ease,
    difficulty: previous.fsrsDifficulty ?? 5,
    elapsed_days: previous.intervalDays,
    scheduled_days: previous.intervalDays,
    reps: previous.attempts,
    lapses: previous.correctStreak === 0 && previous.attempts > 0 ? 1 : 0,
    learning_steps: 0,
    state: State.Review,
    last_review: lastReview,
  };
}

export function addDays(date: Date, days: number): string {
  const next = new Date(date.getTime() + days * DAY_MS);
  next.setHours(9, 0, 0, 0);
  return next.toISOString();
}

/**
 * E7: FSRS-based review scheduling, powered by ts-fsrs.
 * The `ease` field stores FSRS stability; `fsrsDifficulty` stores FSRS difficulty.
 */
export function scheduleReview(
  result: QuestionResult,
  previous?: ReviewItem,
  now = new Date(result.createdAt || Date.now()),
): Pick<ReviewItem, 'intervalDays' | 'ease' | 'fsrsDifficulty' | 'dueAt' | 'attempts' | 'correctStreak'> {
  const rating = toRating(result.correct, result.confidence);
  const attempts = (previous?.attempts ?? 0) + 1;
  const correctStreak = result.correct ? (previous?.correctStreak ?? 0) + 1 : 0;

  const card = cardFromReviewItem(previous, now);
  const { card: next } = f.next(card, now, rating);

  const stability = next.stability;
  const difficulty = next.difficulty;

  // Derive intervalDays from scheduled_days when in Review state (reliable interval),
  // falling back to the FSRS formula: interval = stability at 90% retention target
  // (derivation: R = (1 + t/(9*S))^-1; solve R=0.9 → t = S).
  let intervalDays: number;
  if (next.state === State.Review && next.scheduled_days > 0) {
    intervalDays = next.scheduled_days;
  } else {
    // Learning / Relearning — ts-fsrs schedules in minutes; derive from stability
    intervalDays = Math.max(1, Math.round(stability));
  }

  // Apply exam-tuning error-category penalty (preserved from hand-rolled version)
  intervalDays = Math.round(intervalDays * errorPenalty(result.errorCategory));

  // Clamp: 1 day min, 365 days max
  intervalDays = Math.min(365, Math.max(1, intervalDays));

  // For failed cards, cap at 3 days regardless
  if (!result.correct) {
    intervalDays = Math.min(3, intervalDays);
  }

  return {
    intervalDays,
    ease: stability,           // Store FSRS stability in the existing ease field
    fsrsDifficulty: difficulty,
    dueAt: addDays(now, intervalDays),
    attempts,
    correctStreak,
  };
}

/** FSRS retrievability formula used for mastery weighting (not ts-fsrs state-dependent) */
function retrievability(stability: number, elapsedDays: number): number {
  return Math.pow(1 + elapsedDays / (9 * stability), -1);
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

/** Calculate current retrievability for a review item using ts-fsrs */
export function currentRetrievability(item: ReviewItem, at = new Date()): number {
  if (item.ease < 0.1) return 0;
  const card = cardFromReviewItem(item, new Date(item.dueAt));
  // format=false returns a raw number in [0,1]
  const raw = f.get_retrievability(card, at, false);
  return typeof raw === 'number' ? raw : parseFloat(raw as string) / 100;
}

/** Predict retention at a future date using ts-fsrs */
export function predictRetention(item: ReviewItem, targetDate: Date): number {
  if (item.ease < 0.1) return 0;
  const card = cardFromReviewItem(item, new Date(item.dueAt));
  const raw = f.get_retrievability(card, targetDate, false);
  return typeof raw === 'number' ? raw : parseFloat(raw as string) / 100;
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
