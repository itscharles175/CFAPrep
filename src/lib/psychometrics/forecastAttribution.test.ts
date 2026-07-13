import { describe, it, expect } from 'vitest';
import { attributeForecast } from './forecastAttribution';
import type { MasterySnapshot, QuestionResult } from '../learningTypes';

const NOW = new Date('2026-06-19T12:00:00.000Z');

function snap(partial: Partial<MasterySnapshot> & { topic: string; score: number }): MasterySnapshot {
  return {
    id: `cfa::${partial.topic}`,
    domain: 'cfa',
    topic: partial.topic,
    learningObjective: partial.learningObjective ?? `${partial.topic}-lo`,
    title: partial.title ?? partial.topic,
    score: partial.score,
    attempts: partial.attempts ?? 10,
    correct: partial.correct ?? 6,
    confidenceScore: partial.confidenceScore ?? 60,
    lastAttemptAt: partial.lastAttemptAt ?? '2026-06-18T12:00:00.000Z',
    trend: partial.trend ?? 'flat',
  };
}

function result(partial: Partial<QuestionResult> & { topic: string }): QuestionResult {
  return {
    domain: 'cfa',
    topic: partial.topic,
    questionId: partial.questionId ?? `${partial.topic}-q`,
    learningObjective: partial.learningObjective ?? `${partial.topic}-lo`,
    correct: partial.correct ?? true,
    confidence: partial.confidence ?? 'medium',
    errorCategory: partial.errorCategory ?? 'none',
    difficulty: partial.difficulty ?? 'intermediate',
    createdAt: partial.createdAt ?? '2026-06-18T12:00:00.000Z',
  };
}

/** Build N recent results for a topic at a given accuracy + confidence. */
function recentResults(topic: string, n: number, accuracy: number, confidence: QuestionResult['confidence'] = 'medium') {
  const out: QuestionResult[] = [];
  for (let i = 0; i < n; i++) {
    const day = String(18 - (i % 10)).padStart(2, '0');
    out.push(
      result({
        topic,
        questionId: `${topic}-q${i}`,
        correct: i / n < accuracy,
        confidence,
        createdAt: `2026-06-${day}T12:00:00.000Z`,
      }),
    );
  }
  return out;
}

describe('attributeForecast — structure', () => {
  it('decomposes a gap into ranked drivers that ≈ sum to the gap', () => {
    const snapshots = [snap({ topic: 'Derivatives', score: 40 }), snap({ topic: 'Equity', score: 55 })];
    const results = [...recentResults('Derivatives', 20, 0.4), ...recentResults('Equity', 12, 0.55)];

    const attribution = attributeForecast({ snapshots, results, examDate: '2026-08-19', now: NOW });

    expect(attribution.gap).toBeGreaterThan(0);
    expect(attribution.drivers.length).toBeGreaterThan(0);

    // The positive (cost) contributions sum to ≈ the gap (waterfall invariant).
    const positiveSum = attribution.drivers
      .filter((d) => d.contribution > 0)
      .reduce((s, d) => s + d.contribution, 0);
    expect(positiveSum).toBeCloseTo(attribution.gap, 0);
  });

  it('ranks the lowest-mastery topic as the top driver', () => {
    const snapshots = [snap({ topic: 'Derivatives', score: 30 }), snap({ topic: 'Equity', score: 80 })];
    const results = [...recentResults('Derivatives', 20, 0.3), ...recentResults('Equity', 20, 0.8)];

    const attribution = attributeForecast({ snapshots, results, examDate: '2026-08-19', now: NOW });
    const top = attribution.drivers[0];
    expect(top.kind).toBe('topic-mastery');
    expect(top.detail.topic).toBe('Derivatives');
  });

  it('drivers are sorted by contribution descending (cost first)', () => {
    const snapshots = [snap({ topic: 'A', score: 30 }), snap({ topic: 'B', score: 50 }), snap({ topic: 'C', score: 70 })];
    const results = [
      ...recentResults('A', 15, 0.3),
      ...recentResults('B', 10, 0.5),
      ...recentResults('C', 8, 0.7),
    ];
    const attribution = attributeForecast({ snapshots, results, examDate: '2026-08-19', now: NOW });
    const contribs = attribution.drivers.map((d) => d.contribution);
    const sorted = [...contribs].sort((a, b) => b - a);
    expect(contribs).toEqual(sorted);
  });
});

describe('attributeForecast — individual drivers', () => {
  it('emits a coverage driver when nothing has been practised', () => {
    const attribution = attributeForecast({ snapshots: [], results: [], examDate: '2026-08-19', now: NOW });
    expect(attribution.drivers.some((d) => d.kind === 'coverage')).toBe(true);
  });

  it('emits a recency driver for a stale topic', () => {
    const snapshots = [
      snap({ topic: 'Stale', score: 50, lastAttemptAt: '2026-04-01T12:00:00.000Z' }), // ~79 days stale
    ];
    const results = recentResults('Stale', 5, 0.5).map((r) => ({ ...r, createdAt: '2026-04-01T12:00:00.000Z' }));
    const attribution = attributeForecast({ snapshots, results, examDate: '2026-08-19', now: NOW });
    const recency = attribution.drivers.find((d) => d.kind === 'recency');
    expect(recency).toBeDefined();
    expect(recency!.detail.signal).toBe('stale-topic');
    expect(recency!.detail.metric).toBeGreaterThan(14);
  });

  it('emits an overconfidence calibration driver when confidence outruns accuracy', () => {
    const snapshots = [snap({ topic: 'Over', score: 50 })];
    // High confidence but low accuracy.
    const results = recentResults('Over', 20, 0.4, 'high');
    const attribution = attributeForecast({ snapshots, results, examDate: '2026-08-19', now: NOW });
    const calib = attribution.drivers.find((d) => d.kind === 'calibration');
    expect(calib).toBeDefined();
    expect(calib!.detail.signal).toBe('overconfident');
    expect(calib!.contribution).toBeGreaterThan(0); // a cost
  });

  it('is deterministic for identical inputs', () => {
    const snapshots = [snap({ topic: 'A', score: 45 }), snap({ topic: 'B', score: 65 })];
    const results = [...recentResults('A', 12, 0.45), ...recentResults('B', 9, 0.65)];
    const a = attributeForecast({ snapshots, results, examDate: '2026-08-19', now: NOW });
    const b = attributeForecast({ snapshots, results, examDate: '2026-08-19', now: NOW });
    expect(a).toEqual(b);
  });

  it('produces no drivers/gap when already at goal', () => {
    const snapshots = [snap({ topic: 'A', score: 100 })];
    const results = recentResults('A', 20, 1.0, 'high');
    const attribution = attributeForecast({ snapshots, results, examDate: '2026-06-20', now: NOW, goal: 100 });
    expect(attribution.gap).toBe(0);
    // With zero gap nothing scales up, so there are no positive cost drivers.
    expect(attribution.drivers.every((d) => d.contribution <= 0)).toBe(true);
  });
});
