import type { AnalyticsRange } from "@lsat/components/analytics/AnalyticsFilters";
import { rangeCutoffIso } from "./dateRange";
import type { SessionSummary } from "./types";

/** Map UI range to optional API `days` (backend may ignore until supported). */
export function daysFromRange(range: AnalyticsRange): number | undefined {
  if (range === "7") return 7;
  if (range === "30") return 30;
  return undefined;
}

export function appendDaysQuery(path: string, days?: number): string {
  if (days == null) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}days=${days}`;
}

export function filterSessionsByRange(
  sessions: SessionSummary[],
  range: AnalyticsRange,
): SessionSummary[] {
  const cutoff = rangeCutoffIso(range);
  if (!cutoff) return sessions;
  return sessions.filter((s) => s.started.slice(0, 10) >= cutoff);
}

/** Trend brush selection (ISO date strings, inclusive). */
export function inBrushRange(
  dateIso: string,
  brushStart?: string,
  brushEnd?: string,
): boolean {
  if (!brushStart || !brushEnd) return true;
  const d = dateIso.slice(0, 10);
  return d >= brushStart && d <= brushEnd;
}

export function filterSessionsByBrush(
  sessions: SessionSummary[],
  brushStart?: string,
  brushEnd?: string,
): SessionSummary[] {
  if (!brushStart || !brushEnd) return sessions;
  return sessions.filter((s) => inBrushRange(s.started, brushStart, brushEnd));
}

/** Brush overrides range when both ends are set. */
export function filterSessionsForAnalytics(
  sessions: SessionSummary[],
  range: AnalyticsRange,
  brushStart?: string,
  brushEnd?: string,
): SessionSummary[] {
  if (brushStart && brushEnd) {
    return filterSessionsByBrush(sessions, brushStart, brushEnd);
  }
  return filterSessionsByRange(sessions, range);
}
