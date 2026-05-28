import { describe, expect, it } from 'vitest';
import { rankStudyActions } from './studyDirector';
import type { StudyAction } from './studyDirector';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-05-27T09:00:00.000Z');

const DUE_HIGH_RETENTION = { title: 'Fixed Income', path: '/cfa/level1/fixed-income/quiz', retrievability: 0.85 };
const DUE_LOW_RETENTION  = { title: 'Derivatives',  path: '/cfa/level1/derivatives/quiz',  retrievability: 0.32 };
const DUE_MID_RETENTION  = { title: 'Economics',    path: '/cfa/level1/economics/quiz',     retrievability: 0.61 };

const WEAK_SCORE_40 = { title: 'Ethics',       path: '/cfa/level1/ethics',       score: 40 };
const WEAK_SCORE_55 = { title: 'Quant',        path: '/cfa/level1/quant',        score: 55 };
const WEAK_SCORE_65 = { title: 'Alternatives', path: '/cfa/level1/alternatives', score: 65 };
const WEAK_SCORE_80 = { title: 'Equity',       path: '/cfa/level1/equity',       score: 80 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function kinds(actions: StudyAction[]): StudyAction['kind'][] {
  return actions.map((a) => a.kind);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rankStudyActions — pure function', () => {
  it('due reviews outrank weak topics (priority ordering)', () => {
    const plan = rankStudyActions({
      dueReviews: [DUE_HIGH_RETENTION],
      readiness: [WEAK_SCORE_40],
      forecast: [],
      now: NOW,
    });

    const reviewAction   = plan.actions.find((a) => a.kind === 'review');
    const weakTopicAction = plan.actions.find((a) => a.kind === 'weak-topic');

    expect(reviewAction).toBeDefined();
    expect(weakTopicAction).toBeDefined();
    expect(reviewAction!.priority).toBeGreaterThan(weakTopicAction!.priority);
  });

  it('due reviews are ordered by ascending retrievability (most-forgotten first)', () => {
    const plan = rankStudyActions({
      dueReviews: [DUE_HIGH_RETENTION, DUE_LOW_RETENTION, DUE_MID_RETENTION],
      readiness: [],
      forecast: [],
      now: NOW,
    });

    const reviewActions = plan.actions.filter((a) => a.kind === 'review');
    expect(reviewActions[0].title).toBe('Derivatives');   // 0.32 — lowest
    expect(reviewActions[1].title).toBe('Economics');     // 0.61
    expect(reviewActions[2].title).toBe('Fixed Income');  // 0.85 — highest
  });

  it('weak topics are ordered ascending by score and capped to 3', () => {
    const plan = rankStudyActions({
      dueReviews: [],
      readiness: [WEAK_SCORE_65, WEAK_SCORE_55, WEAK_SCORE_40],
      forecast: [],
      now: NOW,
    });

    const weakActions = plan.actions.filter((a) => a.kind === 'weak-topic');
    expect(weakActions).toHaveLength(3);
    expect(weakActions[0].title).toBe('Ethics');       // 40
    expect(weakActions[1].title).toBe('Quant');        // 55
    expect(weakActions[2].title).toBe('Alternatives'); // 65
  });

  it('excludes weak topics with score >= 70', () => {
    const plan = rankStudyActions({
      dueReviews: [],
      // WEAK_SCORE_80 has score 80 — should be excluded
      readiness: [WEAK_SCORE_40, WEAK_SCORE_80],
      forecast: [],
      now: NOW,
    });

    const weakActions = plan.actions.filter((a) => a.kind === 'weak-topic');
    expect(weakActions).toHaveLength(1);
    expect(weakActions[0].title).toBe('Ethics');
    expect(plan.actions.some((a) => a.title === 'Equity')).toBe(false);
  });

  it('a large forecast spike produces a forecast-spike action', () => {
    const flatForecast = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-05-${String(28 + i).padStart(2, '0')}`,
      count: 3,
    }));
    // Replace one day with a spike: mean=3, spike=12 — >= 1.5×mean and >= 8
    flatForecast[5] = { date: '2026-06-02', count: 12 };

    const plan = rankStudyActions({
      dueReviews: [],
      readiness: [],
      forecast: flatForecast,
      now: NOW,
    });

    const spikeAction = plan.actions.find((a) => a.kind === 'forecast-spike');
    expect(spikeAction).toBeDefined();
    expect(spikeAction!.reason).toContain('2026-06-02');
    expect(plan.peakReviewDay?.date).toBe('2026-06-02');
    expect(plan.peakReviewDay?.count).toBe(12);
  });

  it('empty inputs yield exactly one continue action', () => {
    const plan = rankStudyActions({
      dueReviews: [],
      readiness: [],
      forecast: [],
      now: NOW,
    });

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].kind).toBe('continue');
    expect(plan.dueCount).toBe(0);
    expect(plan.weakCount).toBe(0);
  });

  it('generatedAt is a valid ISO string', () => {
    const plan = rankStudyActions({
      dueReviews: [],
      readiness: [],
      forecast: [],
      now: NOW,
    });

    expect(() => new Date(plan.generatedAt)).not.toThrow();
    expect(Number.isNaN(new Date(plan.generatedAt).getTime())).toBe(false);
  });

  it('passing a fixed now is reflected in generatedAt', () => {
    const fixedNow = new Date('2026-01-15T12:34:56.000Z');
    const plan = rankStudyActions({
      dueReviews: [],
      readiness: [],
      forecast: [],
      now: fixedNow,
    });

    expect(plan.generatedAt).toBe('2026-01-15T12:34:56.000Z');
  });

  it('due reviews are capped to 5 even when more are supplied', () => {
    const manyDue = Array.from({ length: 8 }, (_, i) => ({
      title: `Topic ${i}`,
      path: `/cfa/level1/topic-${i}/quiz`,
      retrievability: i * 0.1,
    }));

    const plan = rankStudyActions({
      dueReviews: manyDue,
      readiness: [],
      forecast: [],
      now: NOW,
    });

    const reviewActions = plan.actions.filter((a) => a.kind === 'review');
    expect(reviewActions).toHaveLength(5);
    expect(plan.dueCount).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// buildStudyPlan — async orchestrator that fetches from progressStore /
// scheduler. We mock those modules so the test is hermetic.
// ---------------------------------------------------------------------------

vi.mock('./progressStore', async () => {
  const fakeDb = {
    lessonProgress: {
      orderBy: () => ({
        reverse: () => ({
          first: async () => ({ path: '/cfa/level1/fixed-income' }),
        }),
      }),
    },
    // Stubs for any other tables imported by progressStore; never called in
    // these tests so the shape doesn't matter.
    settings: { get: async () => null, put: async () => undefined, clear: async () => undefined },
  };
  return {
    db: fakeDb,
    getDueReviews: vi.fn().mockResolvedValue([
      {
        title: 'Modified duration',
        path: '/cfa/level1/fixed-income/quiz',
        ease: 2.3,
        intervalDays: 5,
        dueAt: '2026-05-27T00:00:00Z',
        stability: 8,
        elapsedDays: 4,
      },
    ]),
    getReadinessByTopic: vi.fn().mockResolvedValue([
      { id: 'r1', domain: 'cfa', topic: 'level1:equity', title: 'Equity', readinessScore: 55 },
    ]),
    forecastReviewLoad: vi.fn().mockResolvedValue([
      { date: '2026-05-28', count: 3, averageRetention: 0.7, atRiskCount: 1 },
      { date: '2026-05-29', count: 12, averageRetention: 0.6, atRiskCount: 4 }, // spike
      { date: '2026-05-30', count: 2, averageRetention: 0.8, atRiskCount: 0 },
    ]),
    getMasterySummary: vi.fn().mockResolvedValue({
      snapshots: [],
      weakObjectives: [
        { id: 'w1', domain: 'cfa', topic: 'level1:fsa', title: 'FSA — Income Stmt', score: 48 },
      ],
      averageScore: 60,
    }),
  };
});

vi.mock('./scheduler', () => ({
  currentRetrievability: vi.fn().mockReturnValue(0.42),
}));

import { buildStudyPlan } from './studyDirector';

describe('buildStudyPlan (async orchestrator)', () => {
  it('composes due reviews, weak topics, and a forecast spike into one plan', async () => {
    const plan = await buildStudyPlan();
    expect(plan.dueCount).toBe(1);
    expect(plan.weakCount).toBeGreaterThan(0);
    const kinds = plan.actions.map((a) => a.kind);
    expect(kinds).toContain('review');
    expect(kinds).toContain('weak-topic');
    expect(kinds).toContain('forecast-spike');
    // Peak day from the mocked forecast
    expect(plan.peakReviewDay?.date).toBe('2026-05-29');
  });

  it('returns a minimal continue plan when fetchData throws', async () => {
    const progress = await import('./progressStore');
    (progress.getDueReviews as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    (progress.getReadinessByTopic as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    (progress.forecastReviewLoad as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    (progress.getMasterySummary as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const plan = await buildStudyPlan();
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].kind).toBe('continue');
  });
});
