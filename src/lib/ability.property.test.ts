/**
 * TEST-3 (Wave 2 measurement substrate) — fast-check PROPERTY suite for the HOST
 * ability / mastery-estimate math.
 *
 * SCOPE NOTE — the IRT/theta ability ESTIMATOR is backend-only.
 * ------------------------------------------------------------------
 * The actual ability/theta estimation lives in the LSAT FastAPI sidecar
 * (`services/lsat-backend/app/.../adaptivity.ability_estimate`) and is exercised
 * by the backend's own pytest suite. The host never computes theta/elo/IRT
 * itself — it only (a) carries the backend's reading as the pure DTO
 * `UnifiedAbilityEstimate` (learningTypes.ts) and (b) NORMALISES + PROJECTS that
 * reading for display. So, per the slice rules, we do NOT fabricate an estimator
 * test; instead we property-test the real host-side estimate transforms that DO
 * have provable bounds/monotonicity laws:
 *
 *   - `toMasteryFraction` / `fromMasteryFraction` (dataDictionary.ts) — the
 *     percent⇄fraction normalisation the cross-domain ability/mastery bridge uses.
 *   - `masterySeriesFromEstimate` (dashboardMetrics.ts) — projects a backend
 *     ability estimate onto the dashboard mastery sparkline.
 *
 * Bounded + SEEDED arbitraries keep this fast and deterministic; no sidecar/LLM
 * is contacted (these transforms are pure). We never mutate the modules under test.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { toMasteryFraction, fromMasteryFraction } from './dataDictionary';
import { masterySeriesFromEstimate } from './dashboardMetrics';
import type { UnifiedAbilityEstimate } from './learningTypes';

const FC = { numRuns: 200, seed: 0xab17 } as const;

describe('host mastery-fraction normalisation (dataDictionary)', () => {
  it('toMasteryFraction always returns a value in [0, 1] for any input', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ noNaN: false }), // includes NaN/±Infinity
          fc.constant(Number.NaN),
          fc.constant(Number.POSITIVE_INFINITY),
          fc.constant(Number.NEGATIVE_INFINITY),
          fc.constant(null),
          fc.constant(undefined),
        ),
        fc.constantFrom('fraction', 'percent') as fc.Arbitrary<'fraction' | 'percent'>,
        (value, scale) => {
          const out = toMasteryFraction(value as number | null | undefined, scale);
          expect(Number.isFinite(out)).toBe(true);
          expect(out).toBeGreaterThanOrEqual(0);
          expect(out).toBeLessThanOrEqual(1);
        },
      ),
      FC,
    );
  });

  it('toMasteryFraction is monotonic non-decreasing in the input (same scale)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.constantFrom('fraction', 'percent') as fc.Arbitrary<'fraction' | 'percent'>,
        (a, b, scale) => {
          // On 'fraction' scale only values in [0,1] are meaningful, but the clamp
          // makes the law total regardless; restrict the comparison domain so the
          // ordering is not flattened entirely by the clamp at the top end.
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const fLo = toMasteryFraction(lo, scale);
          const fHi = toMasteryFraction(hi, scale);
          expect(fHi).toBeGreaterThanOrEqual(fLo);
        },
      ),
      FC,
    );
  });

  it('fromMasteryFraction(percent) lands in [0, 100]; (fraction) lands in [0, 1]', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true }), (fraction) => {
        const pct = fromMasteryFraction(fraction, 'percent');
        expect(pct).toBeGreaterThanOrEqual(0);
        expect(pct).toBeLessThanOrEqual(100);
        const frac = fromMasteryFraction(fraction, 'fraction');
        expect(frac).toBeGreaterThanOrEqual(0);
        expect(frac).toBeLessThanOrEqual(1);
      }),
      FC,
    );
  });

  it('round-trips a clean in-range fraction within rounding tolerance', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (fraction) => {
        // toMasteryFraction rounds to 2 dp; the round-trip is exact to that grid.
        const viaPercent = toMasteryFraction(fromMasteryFraction(fraction, 'percent'), 'percent');
        expect(Math.abs(viaPercent - fraction)).toBeLessThanOrEqual(0.01 + 1e-9);
      }),
      FC,
    );
  });
});

/** A bounded UnifiedAbilityEstimate generator — only the fields the projection reads. */
const estimateArb: fc.Arbitrary<UnifiedAbilityEstimate> = fc
  .record({
    mastery: fc.double({ min: 0, max: 1, noNaN: true }),
    evidence_n: fc.integer({ min: 0, max: 200 }),
    early: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
    recent: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
    slope: fc.double({ min: -1, max: 1, noNaN: true }),
  })
  .map((p): UnifiedAbilityEstimate => ({
    domain: 'cfa',
    q_type: null,
    section_type: null,
    ability: 0,
    mastery: p.mastery,
    uncertainty: 0,
    evidence_n: p.evidence_n,
    accuracy: null,
    avg_time_ms: null,
    model: 'test',
    learning_velocity: {
      slope_per_week: p.slope,
      window: '7d',
      early_signal: p.early,
      recent_signal: p.recent,
    },
    plateau: false,
    mastery_eta_days: null,
    components: {
      blind_review_outcomes: {},
      days: null,
      model: 'test',
      uses_official_score_anchor_only: false,
    },
  }));

describe('masterySeriesFromEstimate projection (dashboardMetrics)', () => {
  it('every projected point is a finite value within [0, 1]', () => {
    fc.assert(
      fc.property(estimateArb, (estimate) => {
        const series = masterySeriesFromEstimate(estimate);
        for (const point of series) {
          expect(Number.isFinite(point)).toBe(true);
          expect(point).toBeGreaterThanOrEqual(0);
          expect(point).toBeLessThanOrEqual(1);
        }
      }),
      FC,
    );
  });

  it('with a measured window the series ends exactly at the reported mastery', () => {
    fc.assert(
      fc.property(estimateArb, (estimate) => {
        const series = masterySeriesFromEstimate(estimate);
        const hasWindow =
          estimate.learning_velocity.early_signal !== null &&
          estimate.learning_velocity.recent_signal !== null;
        if (hasWindow) {
          // Documented: a 3-point [start, mid, mastery] series anchored on mastery.
          expect(series).toHaveLength(3);
          expect(series[series.length - 1]).toBeCloseTo(Math.min(1, Math.max(0, estimate.mastery)), 10);
        }
      }),
      FC,
    );
  });

  it('no measured window yields a flat-or-empty series gated on evidence', () => {
    fc.assert(
      fc.property(estimateArb, (estimate) => {
        const noWindow =
          estimate.learning_velocity.early_signal === null ||
          estimate.learning_velocity.recent_signal === null;
        if (noWindow) {
          const series = masterySeriesFromEstimate(estimate);
          // evidence>0 → flat 2-point segment at mastery; no evidence → empty.
          expect(series.length).toBe(estimate.evidence_n > 0 ? 2 : 0);
        }
      }),
      FC,
    );
  });
});
