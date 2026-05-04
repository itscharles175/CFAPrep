import type { Confidence, ErrorCategory, QuestionResult, ReviewItem } from './learningTypes';

const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(date: Date, days: number): string {
  const next = new Date(date.getTime() + days * DAY_MS);
  next.setHours(9, 0, 0, 0);
  return next.toISOString();
}

function confidenceWeight(confidence: Confidence): number {
  if (confidence === 'high') return 1;
  if (confidence === 'medium') return 0.68;
  return 0.34;
}

function errorPenalty(errorCategory: ErrorCategory): number {
  if (errorCategory === 'none') return 0;
  if (errorCategory === 'misread') return 0.08;
  if (errorCategory === 'time-pressure') return 0.12;
  if (errorCategory === 'calculation') return 0.18;
  return 0.24;
}

export function scheduleReview(
  result: QuestionResult,
  previous?: ReviewItem,
  now = new Date(result.createdAt || Date.now()),
): Pick<ReviewItem, 'intervalDays' | 'ease' | 'dueAt' | 'attempts' | 'correctStreak'> {
  const priorEase = previous?.ease ?? 2.3;
  const attempts = (previous?.attempts ?? 0) + 1;
  const confidence = confidenceWeight(result.confidence);
  const penalty = errorPenalty(result.errorCategory);

  let ease = priorEase + (result.correct ? 0.12 : -0.28) + (confidence - 0.68) * 0.28 - penalty;
  ease = Math.min(3.1, Math.max(1.3, ease));

  const correctStreak = result.correct ? (previous?.correctStreak ?? 0) + 1 : 0;
  let intervalDays: number;

  if (!result.correct) intervalDays = result.confidence === 'low' ? 1 : 2;
  else if (result.confidence === 'low') intervalDays = 2;
  else if (!previous || previous.intervalDays < 1) intervalDays = 3;
  else intervalDays = Math.round(previous.intervalDays * ease);

  intervalDays = Math.min(60, Math.max(1, intervalDays));

  return {
    intervalDays,
    ease,
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
    const recency = Math.max(0.45, 1 - ageDays * 0.015);
    const confidence = confidenceWeight(result.confidence);
    const correctness = result.correct ? 1 : 0;
    const position = 0.65 + ((index + 1) / latest.length) * 0.35;
    return {
      value: (correctness * 0.72 + confidence * 0.28 - errorPenalty(result.errorCategory)) * recency * position,
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
      reason: 'Scheduled by your local spaced-repetition queue.',
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
