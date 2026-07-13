/**
 * TEST-3 (Wave 2 measurement substrate) — fast-check PROPERTY suite for the FSRS
 * scheduler (`./scheduler.ts`). Example-based `scheduler.test.ts` pins a handful
 * of concrete cases; this file asserts the algebraic INVARIANTS that must hold
 * across arbitrary inputs — the ones the rest of the app (review ranking, mastery,
 * the cross-domain bridge) silently relies on.
 *
 * Grounded strictly in the real exported behaviour of `scheduleReview`:
 *   - intervalDays is an integer clamped to [1, 365] (and to <= 3 for a failed card);
 *   - `dueAt` = `addDays(now, intervalDays)` so it is always after `now`;
 *   - `attempts` = (previous.attempts ?? 0) + 1;
 *   - `correctStreak` increments on a correct answer, resets to 0 on an incorrect one;
 *   - it never throws "Invalid delta_t" even when `previous.lastResultAt` is in the
 *     future (the documented clamp in `cardFromReviewItem`).
 *
 * Runs are bounded + SEEDED so the suite is fast and deterministic (no live
 * sidecar/LLM — `scheduleReview` is pure ts-fsrs math). We never mutate the
 * module under test.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { scheduleReview, addDays } from './scheduler';
import type { Confidence, ErrorCategory, QuestionResult, ReviewItem } from './learningTypes';

const FC = { numRuns: 150, seed: 0xf5a5 } as const;
const DAY_MS = 86_400_000;

const CONFIDENCES: Confidence[] = ['low', 'medium', 'high'];
const ERROR_CATEGORIES: ErrorCategory[] = [
  'concept',
  'calculation',
  'formula',
  'ethics-judgment',
  'misread',
  'time-pressure',
  'none',
];

const confidenceArb = fc.constantFrom(...CONFIDENCES);
const errorCategoryArb = fc.constantFrom(...ERROR_CATEGORIES);

/** A bounded timestamp window (2010-2035) so generated dates stay sane + finite. */
const epochArb = fc.integer({ min: Date.UTC(2010, 0, 1), max: Date.UTC(2035, 11, 31) });

const resultArb: fc.Arbitrary<QuestionResult> = fc.record({
  domain: fc.constantFrom('cfa', 'quant', 'excel') as fc.Arbitrary<QuestionResult['domain']>,
  topic: fc.constantFrom('economics', 'fixed-income', 'ethics', 'derivatives'),
  questionId: fc.string({ minLength: 1, maxLength: 8 }),
  learningObjective: fc.constantFrom('lo1', 'lo2', 'lo3'),
  correct: fc.boolean(),
  confidence: confidenceArb,
  errorCategory: errorCategoryArb,
  difficulty: fc.constantFrom('foundation', 'intermediate', 'advanced') as fc.Arbitrary<
    QuestionResult['difficulty']
  >,
});

/**
 * A plausible previous ReviewItem keyed to a `nowMs`. `ease` (FSRS stability) is 0
 * about half the time so we exercise BOTH branches of `cardFromReviewItem`
 * (fresh empty card vs reconstructed Review-state card). `lastOffsetDays` ranges
 * into the FUTURE relative to `now` to exercise the delta_t clamp guard.
 */
function previousArb(nowMs: number): fc.Arbitrary<ReviewItem> {
  return fc
    .record({
      ease: fc.oneof(fc.constant(0), fc.double({ min: 0.2, max: 400, noNaN: true })),
      fsrsDifficulty: fc.double({ min: 1, max: 10, noNaN: true }),
      intervalDays: fc.integer({ min: 0, max: 365 }),
      attempts: fc.integer({ min: 0, max: 500 }),
      correctStreak: fc.integer({ min: 0, max: 200 }),
      lastOffsetDays: fc.integer({ min: -800, max: 800 }),
    })
    .map(
      (p): ReviewItem => ({
        id: 'cfa:economics:lo1',
        domain: 'cfa',
        topic: 'economics',
        learningObjective: 'lo1',
        title: 'x',
        path: '/cfa/level1/economics/quiz',
        intervalDays: p.intervalDays,
        ease: p.ease,
        fsrsDifficulty: p.fsrsDifficulty,
        dueAt: new Date(nowMs + p.intervalDays * DAY_MS).toISOString(),
        lastResultAt: new Date(nowMs + p.lastOffsetDays * DAY_MS).toISOString(),
        attempts: p.attempts,
        correctStreak: p.correctStreak,
        lastCorrect: true,
        lastConfidence: 'medium',
        lastErrorCategory: 'none',
      }),
    );
}

/** (result, nowMs, previous?) tuple so each property runs over one combined arbitrary. */
const caseArb = epochArb.chain((nowMs) =>
  fc.tuple(resultArb, fc.constant(nowMs), fc.option(previousArb(nowMs), { nil: undefined })),
);

describe('scheduler property invariants (FSRS)', () => {
  it('intervalDays is an integer in [1, 365]; failed cards cap at 3', () => {
    fc.assert(
      fc.property(caseArb, ([result, nowMs, previous]) => {
        const now = new Date(nowMs);
        const out = scheduleReview({ ...result, createdAt: now.toISOString() }, previous, now);
        expect(Number.isInteger(out.intervalDays)).toBe(true);
        expect(out.intervalDays).toBeGreaterThanOrEqual(1);
        expect(out.intervalDays).toBeLessThanOrEqual(365);
        if (!result.correct) expect(out.intervalDays).toBeLessThanOrEqual(3);
      }),
      FC,
    );
  });

  it('dueAt is finite and after now, even with a future-anchored previous (delta_t guard)', () => {
    fc.assert(
      fc.property(caseArb, ([result, nowMs, previous]) => {
        const now = new Date(nowMs);
        // Must never throw "Invalid delta_t" even when previous.lastResultAt > now.
        const out = scheduleReview({ ...result, createdAt: now.toISOString() }, previous, now);
        const dueMs = new Date(out.dueAt).getTime();
        expect(Number.isFinite(dueMs)).toBe(true);
        // dueAt = addDays(now, intervalDays>=1) snapped to 09:00 local. Always later
        // than the start of `now`'s day, so strictly in the future of the day boundary.
        const dayStart = new Date(now);
        dayStart.setHours(0, 0, 0, 0);
        expect(dueMs).toBeGreaterThanOrEqual(dayStart.getTime());
        expect(dueMs).toBe(new Date(addDays(now, out.intervalDays)).getTime());
      }),
      FC,
    );
  });

  it('attempts increments by exactly 1; correctStreak increments iff correct, else resets to 0', () => {
    fc.assert(
      fc.property(caseArb, ([result, nowMs, previous]) => {
        const now = new Date(nowMs);
        const out = scheduleReview({ ...result, createdAt: now.toISOString() }, previous, now);
        expect(out.attempts).toBe((previous?.attempts ?? 0) + 1);
        if (result.correct) {
          expect(out.correctStreak).toBe((previous?.correctStreak ?? 0) + 1);
        } else {
          expect(out.correctStreak).toBe(0);
        }
      }),
      FC,
    );
  });

  it('a correct review never schedules sooner than an incorrect one (same card/now)', () => {
    fc.assert(
      fc.property(caseArb, confidenceArb, ([result, nowMs, previous], confidence) => {
        const now = new Date(nowMs);
        const createdAt = now.toISOString();
        // Hold confidence + error category fixed; vary ONLY correctness so the
        // comparison is apples-to-apples. A wrong answer is capped at <=3 days and
        // penalised, so it can never out-interval the correct counterpart.
        const correct = scheduleReview(
          { ...result, correct: true, confidence, errorCategory: 'none', createdAt },
          previous,
          now,
        );
        const wrong = scheduleReview(
          { ...result, correct: false, confidence, errorCategory: 'none', createdAt },
          previous,
          now,
        );
        expect(correct.intervalDays).toBeGreaterThanOrEqual(wrong.intervalDays);
      }),
      FC,
    );
  });

  it('is deterministic — same inputs yield identical output (no hidden clock/RNG)', () => {
    fc.assert(
      fc.property(caseArb, ([result, nowMs, previous]) => {
        const createdAt = new Date(nowMs).toISOString();
        const a = scheduleReview({ ...result, createdAt }, previous, new Date(nowMs));
        const b = scheduleReview({ ...result, createdAt }, previous, new Date(nowMs));
        expect(a).toEqual(b);
      }),
      FC,
    );
  });
});
