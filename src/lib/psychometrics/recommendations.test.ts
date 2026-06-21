import { describe, it, expect } from 'vitest';
import { recommendFromAttribution } from './recommendations';
import { attributeForecast, type ForecastAttribution } from './forecastAttribution';
import type { MasterySnapshot, QuestionResult } from '../learningTypes';

const NOW = new Date('2026-06-19T12:00:00.000Z');

function snap(topic: string, score: number, lastAttemptAt = '2026-06-18T12:00:00.000Z'): MasterySnapshot {
  return {
    id: `cfa::${topic}`,
    domain: 'cfa',
    topic,
    learningObjective: `${topic}-lo`,
    title: topic,
    score,
    attempts: 12,
    correct: 7,
    confidenceScore: 60,
    lastAttemptAt,
    trend: 'flat',
  };
}

function results(topic: string, n: number, accuracy: number, confidence: QuestionResult['confidence'] = 'medium') {
  const out: QuestionResult[] = [];
  for (let i = 0; i < n; i++) {
    const day = String(18 - (i % 10)).padStart(2, '0');
    out.push({
      domain: 'cfa',
      topic,
      questionId: `${topic}-q${i}`,
      learningObjective: `${topic}-lo`,
      correct: i / n < accuracy,
      confidence,
      errorCategory: 'none',
      difficulty: 'intermediate',
      createdAt: `2026-06-${day}T12:00:00.000Z`,
    });
  }
  return out;
}

/** Hand-built attribution so recommendation mapping is tested in isolation. */
function fakeAttribution(): ForecastAttribution {
  return {
    projection: {} as ForecastAttribution['projection'],
    goal: 100,
    projected: 55,
    gap: 45,
    drivers: [
      {
        kind: 'topic-mastery',
        label: 'Topic mastery: Derivatives',
        contribution: 20,
        share: 0.44,
        detail: { topic: 'Derivatives', metric: 35, signal: 'low-topic-mastery' },
      },
      {
        kind: 'recency',
        label: 'Recency decay: Equity',
        contribution: 12,
        share: 0.27,
        detail: { topic: 'Equity', metric: 30, signal: 'stale-topic' },
      },
      {
        kind: 'calibration',
        label: 'Calibration: overconfidence',
        contribution: 8,
        share: 0.18,
        detail: { metric: 22, signal: 'overconfident' },
      },
      {
        kind: 'momentum',
        label: 'Momentum: on pace',
        contribution: -5, // tailwind — must NOT produce a recommendation
        share: 0.11,
        detail: { metric: 3.2, signal: 'on-pace' },
      },
    ],
  };
}

describe('recommendFromAttribution', () => {
  it('maps each cost driver to its action with expected impact + explanation', () => {
    const recs = recommendFromAttribution(fakeAttribution());

    const drill = recs.find((r) => r.action === 'drill-topic');
    expect(drill).toBeDefined();
    expect(drill!.topic).toBe('Derivatives');
    expect(drill!.triggeringSignal).toBe('low-topic-mastery');
    expect(drill!.expectedImpact).toBe(20);
    expect(drill!.whyThis).toMatch(/mastery/i);

    expect(recs.some((r) => r.action === 'refresh-stale' && r.topic === 'Equity')).toBe(true);
    expect(recs.some((r) => r.action === 'recalibrate-confidence')).toBe(true);
  });

  it('does NOT recommend actions for tailwind (non-cost) drivers', () => {
    const recs = recommendFromAttribution(fakeAttribution());
    expect(recs.some((r) => r.action === 'increase-pace')).toBe(false);
  });

  it('ranks recommendations by expected impact descending', () => {
    const recs = recommendFromAttribution(fakeAttribution());
    const impacts = recs.map((r) => r.expectedImpact);
    expect(impacts).toEqual([...impacts].sort((a, b) => b - a));
    expect(recs[0].action).toBe('drill-topic');
  });

  it('respects the limit and minImpact options', () => {
    const recs = recommendFromAttribution(fakeAttribution(), { limit: 2 });
    expect(recs).toHaveLength(2);

    const filtered = recommendFromAttribution(fakeAttribution(), { minImpact: 10 });
    expect(filtered.every((r) => r.expectedImpact >= 10)).toBe(true);
  });

  it('is deterministic', () => {
    const a = recommendFromAttribution(fakeAttribution());
    const b = recommendFromAttribution(fakeAttribution());
    expect(a).toEqual(b);
  });
});

describe('end-to-end: attribution → recommendations', () => {
  it('produces explainable, impact-ranked actions from raw telemetry', () => {
    const snapshots = [snap('Derivatives', 30), snap('Equity', 55, '2026-04-01T12:00:00.000Z')];
    const resultRows = [...results('Derivatives', 20, 0.3, 'high'), ...results('Equity', 8, 0.55)];

    const attribution = attributeForecast({ snapshots, results: resultRows, examDate: '2026-08-19', now: NOW });
    const recs = recommendFromAttribution(attribution);

    expect(recs.length).toBeGreaterThan(0);
    // Every recommendation must carry all four explainability fields.
    for (const rec of recs) {
      expect(rec.title).toBeTruthy();
      expect(rec.triggeringSignal).toBeTruthy();
      expect(rec.expectedImpact).toBeGreaterThan(0);
      expect(rec.whyThis).toBeTruthy();
    }
    // The top recommendation should target the weakest topic.
    expect(recs[0].action).toBe('drill-topic');
    expect(recs[0].topic).toBe('Derivatives');
  });
});
