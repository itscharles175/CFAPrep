import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CUSTOM_PARAMETERS_KEY,
  MIN_TOTAL_REVIEWS,
  clearPersistedParameters,
  evaluateLoss,
  fitFSRSParameters,
  groupIntoSequences,
  persistOptimizedParameters,
  readPersistedParameters,
} from './fsrsOptimizer';
import { db } from './progressStore';
import type { Confidence, QuestionResult } from './learningTypes';
import { default_request_retention, default_w } from 'ts-fsrs';
import type { FSRSParameters } from 'ts-fsrs';

const DAY_MS = 24 * 60 * 60 * 1000;

function review(
  questionId: string,
  daysAgo: number,
  correct: boolean,
  confidence: Confidence = 'medium',
): QuestionResult {
  const at = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
  return {
    domain: 'cfa',
    topic: 'quantitative-methods',
    questionId,
    learningObjective: 'lo-1',
    correct,
    confidence,
    errorCategory: 'none',
    difficulty: 'intermediate',
    createdAt: at,
  };
}

const baseParams: FSRSParameters = {
  request_retention: default_request_retention,
  maximum_interval: 36500,
  w: [...default_w] as FSRSParameters['w'],
  enable_fuzz: false,
  enable_short_term: true,
  learning_steps: [],
  relearning_steps: [],
};

beforeEach(async () => {
  await db.settings.clear();
});

afterEach(async () => {
  await clearPersistedParameters();
});

describe('groupIntoSequences', () => {
  it('groups results by questionId and sorts chronologically', () => {
    const results: QuestionResult[] = [
      review('q1', 10, true),
      review('q2', 5, true),
      review('q1', 5, false),
      review('q1', 1, true),
    ];

    const seqs = groupIntoSequences(results);
    expect(seqs).toHaveLength(1); // q2 has only 1 review → filtered out
    expect(seqs[0].cardKey).toBe('cfa::q1');
    expect(seqs[0].reviews).toHaveLength(3);
    // Should be sorted ascending by time (so daysAgo descending here).
    expect(seqs[0].reviews[0].at.getTime()).toBeLessThan(seqs[0].reviews[1].at.getTime());
    expect(seqs[0].reviews[1].at.getTime()).toBeLessThan(seqs[0].reviews[2].at.getTime());
  });

  it('drops results with no createdAt', () => {
    const partial = { ...review('q1', 1, true) };
    delete partial.createdAt;
    const seqs = groupIntoSequences([partial, review('q1', 5, true)]);
    expect(seqs).toHaveLength(0); // only 1 usable review → below MIN_REVIEWS_PER_CARD
  });
});

describe('evaluateLoss', () => {
  it('returns positive loss for a non-trivial sequence', () => {
    const results: QuestionResult[] = [
      review('q1', 30, true),
      review('q1', 20, true),
      review('q1', 10, false),
      review('q1', 1, true),
    ];
    const seqs = groupIntoSequences(results);
    const { loss, reviewCount } = evaluateLoss(seqs, baseParams);
    expect(reviewCount).toBe(3); // 4 reviews, first one isn't predicted
    expect(loss).toBeGreaterThan(0);
    expect(Number.isFinite(loss)).toBe(true);
  });

  it('returns zero loss when no card has enough reviews', () => {
    const seqs = groupIntoSequences([review('q1', 1, true)]);
    const { loss, reviewCount } = evaluateLoss(seqs, baseParams);
    expect(loss).toBe(0);
    expect(reviewCount).toBe(0);
  });
});

describe('fitFSRSParameters', () => {
  it('refuses to fit when sample size is below the floor', async () => {
    const results: QuestionResult[] = [
      review('q1', 5, true),
      review('q1', 1, true),
    ];
    const report = await fitFSRSParameters(results);
    expect(report.ok).toBe(false);
    expect(report.reason).toMatch(/at least/i);
    expect(report.reviewCount).toBe(1);
    expect(report.improvement).toBe(0);
  });

  it('fits successfully when enough history exists and never worsens loss', async () => {
    // Generate a synthetic history: 30 cards × 4 reviews = 120 review records,
    // 90 predicted reviews — well over MIN_TOTAL_REVIEWS.
    const results: QuestionResult[] = [];
    const intervals = [40, 25, 12, 4];
    for (let card = 0; card < 30; card++) {
      // Mostly-correct cards with an occasional miss.
      const correctness = [true, true, card % 5 !== 0, true];
      for (let i = 0; i < intervals.length; i++) {
        results.push(review(`card-${card}`, intervals[i], correctness[i]));
      }
    }

    const report = await fitFSRSParameters(results);
    expect(report.ok).toBe(true);
    expect(report.reviewCount).toBeGreaterThanOrEqual(MIN_TOTAL_REVIEWS);
    expect(report.cardCount).toBe(30);
    // Optimizer is a search — must never INCREASE loss vs the starting point.
    expect(report.optimizedLoss).toBeLessThanOrEqual(report.originalLoss + 1e-9);
    expect(report.improvement).toBeGreaterThanOrEqual(0);
    // Iterations should be bounded — coordinate descent over a small subset.
    expect(report.iterations).toBeLessThan(300);
  }, 30_000);
});

describe('persistOptimizedParameters / readPersistedParameters', () => {
  it('round-trips through storage', async () => {
    const results: QuestionResult[] = [];
    for (let card = 0; card < 30; card++) {
      for (const days of [30, 18, 7, 1]) {
        results.push(review(`c-${card}`, days, true));
      }
    }
    const report = await fitFSRSParameters(results);
    expect(report.ok).toBe(true);

    await persistOptimizedParameters(report);
    const read = await readPersistedParameters();
    expect(read).not.toBeNull();
    expect(read!.request_retention).toBe(report.optimizedParameters.request_retention);
    expect(read!.w).toHaveLength(report.optimizedParameters.w.length);
    expect(read!.reviewCount).toBe(report.reviewCount);

    await clearPersistedParameters();
    const cleared = await readPersistedParameters();
    expect(cleared).toBeNull();
  }, 30_000);

  it('refuses to persist a failed fit', async () => {
    const failed = await fitFSRSParameters([review('q1', 1, true)]);
    expect(failed.ok).toBe(false);
    await expect(persistOptimizedParameters(failed)).rejects.toThrow(/cannot persist/i);
  });

  it('storage key is exposed for callers that need to look it up', () => {
    expect(CUSTOM_PARAMETERS_KEY).toBe('fsrs-custom-parameters');
  });
});
