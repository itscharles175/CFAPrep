import { describe, expect, it } from 'vitest';
import { masteryScoreForResults, scheduleReview } from './scheduler';
import type { QuestionResult, ReviewItem } from './learningTypes';

const baseResult: QuestionResult = {
  domain: 'cfa',
  topic: 'economics',
  questionId: 'econ-1',
  learningObjective: 'econ-lo1',
  correct: true,
  confidence: 'medium',
  errorCategory: 'none',
  difficulty: 'foundation',
  createdAt: '2026-05-02T12:00:00.000Z',
};

describe('spaced repetition scheduler', () => {
  it('schedules wrong low-confidence answers for earlier review', () => {
    const review = scheduleReview({
      ...baseResult,
      correct: false,
      confidence: 'low',
      errorCategory: 'concept',
    });

    expect(review.intervalDays).toBe(1);
    expect(review.correctStreak).toBe(0);
    expect(review.ease).toBeLessThan(2.3);
    expect(review.fsrsDifficulty).toBeGreaterThanOrEqual(1);
  });

  it('expands intervals after correct high-confidence answers', () => {
    const first = scheduleReview({ ...baseResult, confidence: 'high' });
    const second = scheduleReview(
      { ...baseResult, confidence: 'high', createdAt: first.dueAt },
      {
        id: 'cfa:economics:econ-lo1',
        domain: 'cfa',
        topic: 'economics',
        learningObjective: 'econ-lo1',
        title: 'Elasticity',
        path: '/cfa/level1/economics/quiz',
        intervalDays: first.intervalDays,
        ease: first.ease,
        fsrsDifficulty: first.fsrsDifficulty,
        dueAt: first.dueAt,
        lastResultAt: baseResult.createdAt || '',
        attempts: first.attempts,
        correctStreak: first.correctStreak,
        lastCorrect: true,
        lastConfidence: 'high',
        lastErrorCategory: 'none',
      },
    );

    expect(first.intervalDays).toBeGreaterThanOrEqual(3);
    expect(second.intervalDays).toBeGreaterThan(first.intervalDays);
    expect(second.correctStreak).toBe(2);
    expect(second.fsrsDifficulty).toBeLessThanOrEqual(first.fsrsDifficulty ?? 10);
  });

  it('ts-fsrs swap: intervals grow monotonically across a streak of correct/high answers', () => {
    // Start a fresh review; run 5 consecutive correct+high results; each
    // resulting intervalDays must be >= the previous one. (The exact numbers
    // changed from the old hand-rolled weights — that's OK — but the ranking
    // behavior the rest of the app relies on must hold.)
    let prev: ReviewItem | undefined;
    let lastInterval = 0;
    for (let i = 0; i < 5; i += 1) {
      const result: QuestionResult = {
        domain: 'cfa', topic: 'fixed-income', questionId: `q-${i}`,
        learningObjective: 'fi-lo1', correct: true, confidence: 'high',
        errorCategory: 'none', difficulty: 'foundation',
        createdAt: new Date(2026, 0, 1 + i * 30).toISOString(),
      };
      const next = scheduleReview(result, prev, new Date(2026, 0, 1 + i * 30));
      expect(next.intervalDays).toBeGreaterThanOrEqual(lastInterval);
      lastInterval = next.intervalDays;
      prev = { id: 't', domain: 'cfa', topic: 'fixed-income', learningObjective: 'fi-lo1', title: 'x', path: '/x', intervalDays: next.intervalDays, ease: next.ease, fsrsDifficulty: next.fsrsDifficulty, dueAt: next.dueAt, lastResultAt: result.createdAt!, attempts: next.attempts, correctStreak: next.correctStreak, lastCorrect: true, lastConfidence: 'high', lastErrorCategory: 'none' };
    }
    expect(lastInterval).toBeGreaterThan(10);  // ts-fsrs default retention 0.9 + 5 successive high-confidence corrects → far past 10 days
  });

  it('computes mastery from correctness, confidence, errors, and recency', () => {
    const strong = masteryScoreForResults([
      { ...baseResult, correct: true, confidence: 'high' },
      { ...baseResult, questionId: 'econ-2', correct: true, confidence: 'high' },
    ]);
    const weak = masteryScoreForResults([
      { ...baseResult, correct: false, confidence: 'low', errorCategory: 'calculation' },
      { ...baseResult, questionId: 'econ-2', correct: false, confidence: 'low', errorCategory: 'concept' },
    ]);

    expect(strong).toBeGreaterThan(85);
    expect(weak).toBeLessThan(30);
  });
});
