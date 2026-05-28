import { describe, expect, it } from 'vitest';
import { projectExamReadiness, topicWeightedMastery } from './examReadiness';
import type { MasterySnapshot, QuestionResult } from './learningTypes';

const NOW = new Date('2026-06-01T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function snap(domain: string, topic: string, score: number): MasterySnapshot {
  return {
    id: `${domain}::${topic}`,
    domain: domain as MasterySnapshot['domain'],
    topic,
    learningObjective: `${topic}:lo`,
    title: topic,
    score,
    attempts: 1,
    correct: 1,
    confidenceScore: 0.5,
    lastAttemptAt: NOW.toISOString(),
    nextReviewAt: NOW.toISOString(),
    trend: 'flat',
  };
}

function result(topic: string, daysAgo: number, correct: boolean): QuestionResult {
  return {
    domain: 'cfa',
    topic,
    questionId: `${topic}-${daysAgo}-${correct}`,
    learningObjective: `${topic}:lo`,
    correct,
    confidence: 'medium',
    errorCategory: 'none',
    difficulty: 'intermediate',
    createdAt: new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString(),
  };
}

describe('topicWeightedMastery', () => {
  it('returns 0 for empty snapshots', () => {
    expect(topicWeightedMastery([], new Map())).toBe(0);
  });

  it('weights topics by attempt count', () => {
    const snapshots = [snap('cfa', 'quant', 80), snap('cfa', 'fixed-income', 40)];
    const attempts = new Map<string, number>([
      ['cfa::quant', 10],
      ['cfa::fixed-income', 90],
    ]);
    // 80*10 + 40*90 = 800 + 3600 = 4400 / 100 = 44
    expect(topicWeightedMastery(snapshots, attempts)).toBeCloseTo(44, 5);
  });

  it('falls back to unit weight when topic has no attempt count', () => {
    const snapshots = [snap('cfa', 'quant', 80), snap('cfa', 'fixed-income', 40)];
    // (80 + 40) / 2 = 60
    expect(topicWeightedMastery(snapshots, new Map())).toBe(60);
  });
});

describe('projectExamReadiness', () => {
  it('returns a flat projection when no recent attempts', () => {
    const projection = projectExamReadiness({
      snapshots: [snap('cfa', 'quant', 50)],
      results: [],
      examDate: '2026-09-01',
      now: NOW,
    });
    expect(projection.currentMastery).toBe(50);
    expect(projection.averageDailyAttempts).toBe(0);
    expect(projection.projectedOnExamDate).toBe(50);
    expect(projection.points.length).toBeGreaterThan(0);
  });

  it('projects upward with active recent attempts', () => {
    const results: QuestionResult[] = [];
    for (let d = 0; d < 14; d++) {
      for (let i = 0; i < 4; i++) {
        results.push(result('quant', d, i < 3)); // 75% accuracy, ~4/day
      }
    }
    const projection = projectExamReadiness({
      snapshots: [snap('cfa', 'quant', 50)],
      results,
      examDate: '2026-09-01',
      now: NOW,
    });
    expect(projection.averageDailyAttempts).toBeCloseTo(4, 1);
    expect(projection.averageAccuracy).toBeCloseTo(0.75, 2);
    expect(projection.projectedOnExamDate).toBeGreaterThan(50);
    expect(projection.projectedBand).not.toBeNull();
    expect(projection.projectedBand!.upper).toBeGreaterThan(projection.projectedBand!.lower);
  });

  it('falls back to 90-day projection when no exam date', () => {
    const projection = projectExamReadiness({
      snapshots: [snap('cfa', 'quant', 30)],
      results: [result('quant', 1, true), result('quant', 2, true)],
      examDate: null,
      now: NOW,
    });
    expect(projection.examDate).toBeNull();
    expect(projection.projectedOnExamDate).not.toBeNull();
    expect(projection.points.length).toBe(91); // day 0 + 90 days
  });

  it('respects diminishing returns near 100', () => {
    const results: QuestionResult[] = [];
    for (let d = 0; d < 14; d++) {
      for (let i = 0; i < 10; i++) {
        results.push(result('quant', d, true)); // 100% accuracy → perAttemptLift = 0
      }
    }
    const projection = projectExamReadiness({
      snapshots: [snap('cfa', 'quant', 95)],
      results,
      examDate: '2026-09-01',
      now: NOW,
    });
    expect(projection.perAttemptLift).toBe(0);
    expect(projection.projectedOnExamDate).toBeCloseTo(projection.currentMastery, 1);
  });

  it('clamps projected mastery at 100', () => {
    const results: QuestionResult[] = [];
    for (let d = 0; d < 14; d++) {
      for (let i = 0; i < 20; i++) {
        results.push(result('quant', d, i % 2 === 0));
      }
    }
    const projection = projectExamReadiness({
      snapshots: [snap('cfa', 'quant', 98)],
      results,
      examDate: '2026-12-01',
      now: NOW,
    });
    for (const pt of projection.points) {
      expect(pt.projected).toBeLessThanOrEqual(100);
      expect(pt.upper).toBeLessThanOrEqual(100);
      expect(pt.lower).toBeGreaterThanOrEqual(0);
    }
  });

  it('flags the exam date in the projection', () => {
    const projection = projectExamReadiness({
      snapshots: [snap('cfa', 'quant', 60)],
      results: [],
      examDate: '2026-06-15',
      now: NOW,
    });
    const flagged = projection.points.filter((p) => p.isExamDate);
    expect(flagged.length).toBe(1);
    expect(flagged[0].date).toBe('2026-06-15');
  });

  it('caps projection at 180 days even with a distant exam date', () => {
    const projection = projectExamReadiness({
      snapshots: [snap('cfa', 'quant', 50)],
      results: [],
      examDate: '2030-01-01',
      now: NOW,
    });
    expect(projection.points.length).toBeLessThanOrEqual(181);
  });
});
