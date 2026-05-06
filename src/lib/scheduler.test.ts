import { describe, expect, it } from 'vitest';
import { masteryScoreForResults, scheduleReview } from './scheduler';
import type { QuestionResult } from './learningTypes';

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
