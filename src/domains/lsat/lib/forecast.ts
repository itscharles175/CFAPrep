import type { Forecast } from "./types";

/**
 * B1 — derive nested 50 / 80 / 95 % projection cones from the backend's
 * `projected ± 1.5σ` confidence band. The backend reports the band as
 * `confidence.{low,high}` around `projected_score`, so the half-width equals
 * 1.5σ of the regression residuals; we recover σ and scale by the z-values for
 * each level. Returns half-widths (scaled-score points) at the exam date,
 * widest first. Empty when there isn't enough history to project.
 */
export function forecastConeBands(
  fc: Forecast | undefined,
): { level: number; spread: number }[] {
  if (!fc || fc.projected_score == null || !fc.confidence) return [];
  const half = Math.abs(fc.confidence.high - fc.confidence.low) / 2; // = 1.5σ
  if (!(half > 0)) return [];
  const sigma = half / 1.5;
  return [
    { level: 95, spread: 1.96 * sigma },
    { level: 80, spread: 1.282 * sigma },
    { level: 50, spread: 0.674 * sigma },
  ];
}
