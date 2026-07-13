import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  blindReviewOutcome,
  computeHostBlindReviewBlock,
  getCrossDomainBlindReviewGap,
} from './blindReviewBridge';
import type { QuestionResult } from './learningTypes';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubFetch(routes: Record<string, () => Response | Promise<Response>>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      for (const [frag, fn] of Object.entries(routes)) {
        if (url.includes(frag)) return Promise.resolve(fn());
      }
      return Promise.reject(new Error(`unrouted ${url}`));
    }) as unknown as typeof fetch,
  );
}

function res(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('blindReviewOutcome (2x2 parity with backend)', () => {
  it('routes the four graded cells', () => {
    expect(blindReviewOutcome(true, true)).toBe('timed_ok');
    expect(blindReviewOutcome(false, true)).toBe('timing_problem');
    expect(blindReviewOutcome(false, false)).toBe('concept_gap');
    expect(blindReviewOutcome(true, false)).toBe('lucky');
  });

  it('falls back to timed-only labels when there is no BR grade', () => {
    expect(blindReviewOutcome(true, null)).toBe('timed_ok');
    expect(blindReviewOutcome(false, undefined)).toBe('concept_gap');
  });
});

describe('computeHostBlindReviewBlock (local 2x2 from Dexie)', () => {
  const base: Omit<QuestionResult, 'correct' | 'brAnswer' | 'brCorrect'> = {
    domain: 'cfa',
    topic: 't',
    questionId: 'q',
    learningObjective: 'lo',
    confidence: 'medium',
    errorCategory: 'none',
    difficulty: 'intermediate',
  };

  it('counts only attempts that captured a BR answer', () => {
    const block = computeHostBlindReviewBlock([
      { ...base, correct: false, brAnswer: 1, brCorrect: true }, // timing_problem
      { ...base, correct: false, brAnswer: 2, brCorrect: false }, // concept_gap
      { ...base, correct: true, brAnswer: 3, brCorrect: false }, // lucky
      { ...base, correct: true }, // no BR pass — excluded
    ]);
    expect(block.attempts).toBe(3);
    expect(block.outcomes).toEqual({
      timed_ok: 0,
      timing_problem: 1,
      concept_gap: 1,
      lucky: 1,
    });
    expect(block.careless_rate).toBeCloseTo(1 / 3, 4);
    expect(block.concept_gap_rate).toBeCloseTo(1 / 3, 4);
    expect(block.lucky_rate).toBeCloseTo(1 / 3, 4);
  });

  it('returns a zeroed block when there is no BR data', () => {
    const block = computeHostBlindReviewBlock([{ ...base, correct: true }]);
    expect(block.attempts).toBe(0);
    expect(block.gap).toBe(0);
    expect(block.outcomes).toEqual({ timed_ok: 0, timing_problem: 0, concept_gap: 0, lucky: 0 });
  });
});

describe('getCrossDomainBlindReviewGap', () => {
  it('sends ?domain= and normalizes the cross-domain payload', async () => {
    let capturedUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        capturedUrl = url;
        return Promise.resolve(
          res({
            meta: { model: 'cross_domain_blind_review_v1', lsat_attempts: 4, host_attempts: 2 },
            timed_accuracy: 0.5,
            br_accuracy: 0.75,
            gap: 0.25,
            outcomes: { timed_ok: 2, timing_problem: 2, concept_gap: 1, lucky: 1 },
            careless_rate: 0.33,
            concept_gap_rate: 0.17,
            lucky_rate: 0.17,
            by_type: [{ q_type: 'Flaw', timed_accuracy: 0.5, br_accuracy: 0.8, gap: 0.3, attempts: 4 }],
            lucky_rate_by_type: { Flaw: 0.25 },
            by_domain: {
              lsat: { attempts: 4, timed_accuracy: 0.5, br_accuracy: 0.75, gap: 0.25, outcomes: { timed_ok: 2, timing_problem: 1, concept_gap: 1, lucky: 0 }, careless_rate: 0.25, concept_gap_rate: 0.25, lucky_rate: 0 },
              host: { attempts: 2, timed_accuracy: 0, br_accuracy: 1, gap: 1, outcomes: { timed_ok: 0, timing_problem: 2, concept_gap: 0, lucky: 0 }, careless_rate: 1, concept_gap_rate: 0, lucky_rate: 0 },
            },
          }),
        );
      }) as unknown as typeof fetch,
    );
    const r = await getCrossDomainBlindReviewGap({ domain: 'all', days: 30 });
    expect(r.reachable).toBe(true);
    expect(capturedUrl).toContain('domain=all');
    expect(capturedUrl).toContain('days=30');
    expect(r.gap).toBe(0.25);
    expect(r.outcomes).toEqual({ timed_ok: 2, timing_problem: 2, concept_gap: 1, lucky: 1 });
    expect(r.by_type[0].q_type).toBe('Flaw');
    expect(r.lucky_rate_by_type.Flaw).toBe(0.25);
    expect(r.by_domain.host.careless_rate).toBe(1);
    expect(r.lsat_attempts).toBe(4);
    expect(r.host_attempts).toBe(2);
  });

  it('degrades to reachable:false with empty blocks when the sidecar is down', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch);
    const r = await getCrossDomainBlindReviewGap({ domain: 'host' });
    expect(r.reachable).toBe(false);
    expect(r.domain).toBe('host');
    expect(r.by_type).toEqual([]);
    expect(r.by_domain.lsat.attempts).toBe(0);
    expect(r.by_domain.host.attempts).toBe(0);
  });

  it('degrades on a non-2xx response (no throw)', async () => {
    stubFetch({ '/api/analytics/blind-review-gap': () => new Response('boom', { status: 503 }) });
    const r = await getCrossDomainBlindReviewGap();
    expect(r.reachable).toBe(false);
  });

  it('degrades when the body is an array (shape drift)', async () => {
    stubFetch({ '/api/analytics/blind-review-gap': () => res([1, 2, 3]) });
    const r = await getCrossDomainBlindReviewGap();
    expect(r.reachable).toBe(false);
  });
});
