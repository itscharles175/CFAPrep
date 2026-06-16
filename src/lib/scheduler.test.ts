import { afterEach, describe, expect, it, vi } from 'vitest';
import { default_w } from 'ts-fsrs';
import {
  applyBackendSrsParams,
  fetchBackendSrsParams,
  getActiveScheduler,
  masteryScoreForResults,
  scheduleReview,
  setSchedulerParameters,
  syncSchedulerFromBackend,
  type BackendSrsParams,
} from './scheduler';
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

describe('LEARN-4 — host-side FSRS parameter parity with the backend', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    // Reset both the stubbed fetch and the (module-global) active scheduler so
    // each parity test starts from ts-fsrs library defaults and tests stay
    // order-independent.
    globalThis.fetch = originalFetch;
    setSchedulerParameters(undefined);
    vi.restoreAllMocks();
  });

  function stubFetch(impl: () => Promise<Response> | Response) {
    globalThis.fetch = vi.fn(impl) as unknown as typeof fetch;
  }

  function jsonResponse(body: unknown, ok = true, status = 200): Response {
    return {
      ok,
      status,
      json: async () => body,
    } as unknown as Response;
  }

  it('fetchBackendSrsParams parses a well-formed body', async () => {
    const weights = Array.from(default_w);
    stubFetch(() => jsonResponse({ weights, desired_retention: 0.88, source: 'backend' }));
    const params = await fetchBackendSrsParams();
    expect(params).not.toBeNull();
    expect(params!.weights).toHaveLength(default_w.length);
    expect(params!.desired_retention).toBe(0.88);
    expect(params!.source).toBe('backend');
  });

  it('fetchBackendSrsParams returns null on a non-2xx (older sidecar 404)', async () => {
    stubFetch(() => jsonResponse({}, false, 404));
    expect(await fetchBackendSrsParams()).toBeNull();
  });

  it('fetchBackendSrsParams returns null when offline (fetch throws)', async () => {
    stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    expect(await fetchBackendSrsParams()).toBeNull();
  });

  it('applies matching-length backend weights + retention to the active scheduler', () => {
    // Use a perturbed copy of default_w so we can prove the weights were adopted.
    const weights = Array.from(default_w).map((w, i) => (i === 0 ? w + 0.05 : w));
    const params: BackendSrsParams = { weights, desired_retention: 0.85, source: 'backend' };

    const applied = applyBackendSrsParams(params);

    expect(applied).toBe(true);
    const active = getActiveScheduler().parameters;
    expect(active.request_retention).toBe(0.85);
    expect(active.w[0]).toBeCloseTo(weights[0], 6);
  });

  it('gracefully no-ops when fetch returns null (keeps local defaults)', () => {
    // Seed a known local fit first; a null sync must leave it untouched.
    const localWeights = Array.from(default_w).map((w, i) => (i === 1 ? w + 0.1 : w));
    setSchedulerParameters({ request_retention: 0.91, w: localWeights });

    const applied = applyBackendSrsParams(null);

    expect(applied).toBe(false);
    const active = getActiveScheduler().parameters;
    expect(active.request_retention).toBe(0.91);
    expect(active.w[1]).toBeCloseTo(localWeights[1], 6);
  });

  it('on a weight-length mismatch applies retention only and keeps local weights', () => {
    // Seed local weights so we can prove they survive the mismatch.
    const localWeights = Array.from(default_w).map((w, i) => (i === 2 ? w + 0.2 : w));
    setSchedulerParameters({ request_retention: 0.9, w: localWeights });

    // A wrong-length (19-weight, FSRS-4.5-shaped) vector from a py-fsrs build.
    const shortWeights = Array.from(default_w).slice(0, 19).map(() => 1.234);
    expect(shortWeights.length).not.toBe(default_w.length);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const applied = applyBackendSrsParams({
      weights: shortWeights,
      desired_retention: 0.82,
      source: 'backend',
    });

    // Weights were NOT adopted (return false), but retention WAS.
    expect(applied).toBe(false);
    expect(info).toHaveBeenCalledTimes(1);
    const active = getActiveScheduler().parameters;
    expect(active.request_retention).toBe(0.82);
    // Mismatched weights ignored → the previously-active LOCAL weights are
    // carried forward unchanged (NOT the 1.234-filled wrong-length array).
    expect(active.w).toHaveLength(default_w.length);
    expect(active.w[2]).toBeCloseTo(localWeights[2], 6);
    expect(active.w[2]).not.toBeCloseTo(1.234, 3);
  });

  it('empty backend weights apply retention only (no per-user fit yet)', () => {
    const applied = applyBackendSrsParams({ weights: [], desired_retention: 0.93, source: 'backend' });
    expect(applied).toBe(false);
    const active = getActiveScheduler().parameters;
    expect(active.request_retention).toBe(0.93);
    expect(active.w).toHaveLength(default_w.length);
  });

  it('syncSchedulerFromBackend wires fetch → apply (backend wins at boot)', async () => {
    const weights = Array.from(default_w).map((w, i) => (i === 3 ? w + 0.5 : w));
    stubFetch(() => jsonResponse({ weights, desired_retention: 0.87, source: 'backend' }));

    const applied = await syncSchedulerFromBackend();

    expect(applied).not.toBeNull();
    const active = getActiveScheduler().parameters;
    expect(active.request_retention).toBe(0.87);
    expect(active.w[3]).toBeCloseTo(weights[3], 6);
  });

  it('syncSchedulerFromBackend is a safe no-op when the sidecar is offline', async () => {
    stubFetch(() => {
      throw new Error('offline');
    });
    const result = await syncSchedulerFromBackend();
    expect(result).toBeNull();
    // Scheduler remains on library defaults — no throw, no mutation.
    expect(getActiveScheduler().parameters.w).toHaveLength(default_w.length);
  });
});
