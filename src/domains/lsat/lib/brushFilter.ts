import type { ActivityDay } from "./types";

/** R4-E11 — client filter helper for brushed date ranges. */
export function inBrushRange(
  date: string,
  brushStart?: string,
  brushEnd?: string,
): boolean {
  if (!brushStart && !brushEnd) return true;
  const d = date.slice(0, 10);
  if (brushStart && d < brushStart.slice(0, 10)) return false;
  if (brushEnd && d > brushEnd.slice(0, 10)) return false;
  return true;
}

export function filterActivityByBrush(
  days: ActivityDay[],
  brushStart?: string,
  brushEnd?: string,
): ActivityDay[] {
  if (!brushStart && !brushEnd) return days;
  return days.filter((d) => inBrushRange(d.date, brushStart, brushEnd));
}
