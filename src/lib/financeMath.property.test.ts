/**
 * TEST-3 (Wave 2 measurement substrate) — fast-check PROPERTY suite for the
 * time-value-of-money core of `./financeMath.ts`. Asserts the algebraic laws the
 * functions provably guarantee (PV/FV inverse, rate monotonicity, payment sign,
 * NPV at zero discount), grounded in the real exported signatures.
 *
 * Bounded + SEEDED arbitraries keep this fast and deterministic. We do NOT touch
 * the module under test. Tolerances are relative (these are floating-point
 * compounding formulas), and inputs are kept well away from the degenerate
 * rate <= -1 region where `Math.pow(1 + rate, n)` is undefined.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { futureValue, presentValue, payment, npv } from './financeMath';

const FC = { numRuns: 200, seed: 0x1f1f } as const;

/** Annual rate kept strictly > -1 (compounding base 1+rate stays positive) and finite. */
const rateArb = fc.double({ min: -0.9, max: 0.5, noNaN: true });
/**
 * Non-negative rate for the `payment` laws. Either EXACTLY 0 (the code's
 * `rate === 0` branch) or in [1e-4, 0.5] — kept away from denormal-near-zero
 * doubles where `(pow(1+r,n)-1)/r` loses all precision (a floating-point edge,
 * not a law violation). Exercises both branches of the annuity factor.
 */
const nonNegRateArb = fc.oneof(fc.constant(0), fc.double({ min: 1e-4, max: 0.5, noNaN: true }));
/** Positive, non-degenerate principal / cash amounts. */
const amountArb = fc.double({ min: 1, max: 1_000_000, noNaN: true });
/** Whole-ish horizons; >= 1 so there is at least one compounding period. */
const yearsArb = fc.integer({ min: 1, max: 40 });
const frequencyArb = fc.constantFrom(1, 2, 4, 12);

/** Assert `actual` is within a relative (or absolute, for near-zero) tolerance. */
function closeTo(actual: number, expected: number, rel = 1e-6, abs = 1e-6) {
  const tol = Math.max(abs, rel * Math.abs(expected));
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
}

describe('financeMath property invariants (time value of money)', () => {
  it('PV and FV are inverses for a single lump sum (no payments)', () => {
    fc.assert(
      fc.property(amountArb, rateArb, yearsArb, frequencyArb, (pv, annualRate, years, frequency) => {
        const fv = futureValue({ presentValue: pv, annualRate, years, frequency });
        const back = presentValue({ futureValue: fv, annualRate, years, frequency });
        closeTo(back, pv, 1e-6);
      }),
      FC,
    );
  });

  it('FV of a positive lump sum is non-decreasing in the rate (everything else fixed)', () => {
    fc.assert(
      fc.property(
        amountArb,
        rateArb,
        fc.double({ min: 0, max: 0.4, noNaN: true }),
        yearsArb,
        frequencyArb,
        (pv, baseRate, bump, years, frequency) => {
          const lo = futureValue({ presentValue: pv, annualRate: baseRate, years, frequency });
          const hi = futureValue({ presentValue: pv, annualRate: baseRate + bump, years, frequency });
          // Higher rate compounds a positive principal to at least as much.
          expect(hi).toBeGreaterThanOrEqual(lo - 1e-6);
        },
      ),
      FC,
    );
  });

  it('PV of a positive future value is non-increasing in the discount rate', () => {
    fc.assert(
      fc.property(
        amountArb,
        rateArb,
        fc.double({ min: 0, max: 0.4, noNaN: true }),
        yearsArb,
        frequencyArb,
        (fv, baseRate, bump, years, frequency) => {
          const lo = presentValue({ futureValue: fv, annualRate: baseRate, years, frequency });
          const hi = presentValue({ futureValue: fv, annualRate: baseRate + bump, years, frequency });
          // Discounting harder makes a positive future value worth no more today.
          expect(hi).toBeLessThanOrEqual(lo + 1e-6);
        },
      ),
      FC,
    );
  });

  it('a loan payment (pv > 0, fv = 0) is a non-positive cash flow at a non-negative rate', () => {
    // Sign convention of financeMath.payment: payment = (fv - pv*(1+r)^n) / annuityFactor.
    // With pv > 0, fv = 0 and r >= 0 the numerator is <= 0 and the factor > 0, so the
    // payment is an OUTFLOW (<= 0) — never a positive number.
    fc.assert(
      fc.property(
        amountArb,
        nonNegRateArb,
        yearsArb,
        frequencyArb,
        (pv, annualRate, years, frequency) => {
          const pmt = payment({ presentValue: pv, futureValue: 0, annualRate, years, frequency });
          expect(Number.isFinite(pmt)).toBe(true);
          expect(pmt).toBeLessThanOrEqual(0);
        },
      ),
      FC,
    );
  });

  it('a savings target (fv > 0, pv = 0) requires a positive contribution at a non-negative rate', () => {
    fc.assert(
      fc.property(
        amountArb,
        nonNegRateArb,
        yearsArb,
        frequencyArb,
        (fv, annualRate, years, frequency) => {
          const pmt = payment({ presentValue: 0, futureValue: fv, annualRate, years, frequency });
          expect(pmt).toBeGreaterThan(0);
        },
      ),
      FC,
    );
  });

  it('payment solves the TVM identity: FV(pv, pmt) === target FV', () => {
    fc.assert(
      fc.property(
        amountArb,
        amountArb,
        nonNegRateArb,
        yearsArb,
        frequencyArb,
        (pv, targetFv, annualRate, years, frequency) => {
          const pmt = payment({
            presentValue: pv,
            futureValue: targetFv,
            annualRate,
            years,
            frequency,
          });
          const fv = futureValue({ presentValue: pv, payment: pmt, annualRate, years, frequency });
          expect(Number.isFinite(fv)).toBe(true);
          // The round-trip's absolute drift scales with the COMPOUNDED magnitude
          // (pv·(1+r)^n), not with targetFv — at a small targetFv the relative term
          // vs `expected` collapses, so anchor the tolerance on the computation scale.
          const scale = Math.abs(pv) * Math.pow(1 + annualRate, years * frequency) + Math.abs(targetFv);
          closeTo(fv, targetFv, 1e-6, Math.max(1e-3, 1e-7 * scale));
        },
      ),
      FC,
    );
  });

  it('NPV at a zero discount rate equals the plain sum of the cash flows', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -100_000, max: 100_000, noNaN: true }), { minLength: 0, maxLength: 12 }),
        (cashFlows) => {
          const sum = cashFlows.reduce((acc, c) => acc + c, 0);
          closeTo(npv(0, cashFlows), sum, 1e-9, 1e-6);
        },
      ),
      FC,
    );
  });

  it('NPV of a single period-0 cash flow is rate-independent (no discounting at t=0)', () => {
    fc.assert(
      fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), rateArb, (c0, rate) => {
        closeTo(npv(rate, [c0]), c0, 1e-9, 1e-6);
      }),
      FC,
    );
  });
});
