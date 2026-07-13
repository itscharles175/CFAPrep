import { describe, it, expect } from "vitest";
import { forecastConeBands } from "./forecast";
import type { Forecast } from "./types";

function fc(partial: Partial<Forecast>): Forecast {
  return {
    current_score: 160,
    projected_score: 165,
    slope_per_week: 1,
    confidence: { low: 160, high: 170 },
    target_score: 170,
    gap_to_target: 5,
    on_track: false,
    days_to_exam: 30,
    n_points: 5,
    ...partial,
  };
}

describe("forecastConeBands", () => {
  it("returns [] when there is no forecast", () => {
    expect(forecastConeBands(undefined)).toEqual([]);
  });

  it("returns [] without a projected score or confidence band", () => {
    expect(forecastConeBands(fc({ projected_score: null }))).toEqual([]);
    expect(forecastConeBands(fc({ confidence: null }))).toEqual([]);
  });

  it("derives nested 95/80/50 bands, widest first", () => {
    const bands = forecastConeBands(fc({ confidence: { low: 160, high: 170 } }));
    expect(bands.map((b) => b.level)).toEqual([95, 80, 50]);
    // Widest first → strictly decreasing spreads.
    expect(bands[0].spread).toBeGreaterThan(bands[1].spread);
    expect(bands[1].spread).toBeGreaterThan(bands[2].spread);
    // half-width = (170-160)/2 = 5 = 1.5σ → σ ≈ 3.333; 95% ≈ 1.96σ ≈ 6.53
    expect(bands[0].spread).toBeCloseTo(1.96 * (5 / 1.5), 2);
  });

  it("returns [] for a zero-width band", () => {
    expect(forecastConeBands(fc({ confidence: { low: 165, high: 165 } }))).toEqual([]);
  });
});
