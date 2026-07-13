/** Client-side date range helpers (Round 2). Backend may add `days` later — filter locally for now. */

export type AnalyticsRange = "7" | "30" | "all";

export function rangeCutoffIso(range: AnalyticsRange): string | null {
  if (range === "all") return null;
  const days = range === "7" ? 7 : 30;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export function inRange(dateIso: string, range: AnalyticsRange): boolean {
  const cutoff = rangeCutoffIso(range);
  if (!cutoff) return true;
  return dateIso.slice(0, 10) >= cutoff;
}

/** Split trend into current window vs prior window of equal length. */
export function splitTrendPeriods<T extends { date: string }>(
  series: T[],
  range: AnalyticsRange,
): { current: T[]; prior: T[] } {
  if (range === "all" || series.length < 2) {
    const mid = Math.floor(series.length / 2);
    return { current: series.slice(mid), prior: series.slice(0, mid) };
  }
  const cutoff = rangeCutoffIso(range)!;
  const current = series.filter((p) => p.date.slice(0, 10) >= cutoff);
  const prior = series.filter((p) => p.date.slice(0, 10) < cutoff);
  return { current, prior };
}

export function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
