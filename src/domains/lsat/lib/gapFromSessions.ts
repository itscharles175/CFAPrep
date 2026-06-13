import type { GapRow } from "@lsat/components/viz";
import type { QType, ResultItem, SessionSummary } from "./types";
import type { AnalyticsRange } from "@lsat/components/analytics/AnalyticsFilters";
import { rangeCutoffIso } from "./dateRange";

export interface ComputedGap {
  timed_accuracy: number;
  br_accuracy: number;
  gap: number;
  by_type: { q_type: QType; timed_accuracy: number; br_accuracy: number }[];
}

function computeFromItems(items: ResultItem[]): ComputedGap {
  if (!items.length) {
    return { timed_accuracy: 0, br_accuracy: 0, gap: 0, by_type: [] };
  }
  const timedOk = items.filter((i) => i.attempt.is_correct).length;
  const brOk = items.filter((i) => i.attempt.br_correct === true).length;
  const total = items.length;

  const byType = new Map<
    string,
    { q_type: QType; timed: number; timedN: number; br: number; brN: number }
  >();
  for (const it of items) {
    const key = String(it.question.q_type);
    const agg =
      byType.get(key) ??
      { q_type: it.question.q_type, timed: 0, timedN: 0, br: 0, brN: 0 };
    agg.timedN++;
    if (it.attempt.is_correct) agg.timed++;
    if (it.attempt.br_correct != null) {
      agg.brN++;
      if (it.attempt.br_correct) agg.br++;
    }
    byType.set(key, agg);
  }

  const by_type = [...byType.values()].map((r) => ({
    q_type: r.q_type,
    timed_accuracy: r.timedN ? r.timed / r.timedN : 0,
    br_accuracy: r.brN ? r.br / r.brN : 0,
  }));

  const timed_accuracy = timedOk / total;
  const br_accuracy = brOk / total;
  return {
    timed_accuracy,
    br_accuracy,
    gap: br_accuracy - timed_accuracy,
    by_type,
  };
}

export interface OutcomeCounts {
  timed_ok: number;
  lucky: number;
  concept_gap: number;
  timing_problem: number;
}

/** B5 — 2×2 timed→BR transition counts for the gap Sankey. */
export function outcomeCountsForSessions(
  sessions: SessionSummary[],
  resultsBySessionId: Map<number, ResultItem[]>,
): OutcomeCounts {
  const counts: OutcomeCounts = {
    timed_ok: 0,
    lucky: 0,
    concept_gap: 0,
    timing_problem: 0,
  };
  for (const s of sessions) {
    for (const it of resultsBySessionId.get(s.id) ?? []) {
      const o = it.attempt.outcome;
      if (o in counts) counts[o as keyof OutcomeCounts]++;
    }
  }
  return counts;
}

export function gapRowsFromComputed(g: ComputedGap): GapRow[] {
  return g.by_type.map((r) => ({
    q_type: r.q_type,
    timed: r.timed_accuracy,
    blindReview: r.br_accuracy,
  }));
}

/** Split sessions into current window vs everything before cutoff. */
export function splitSessionsByRange(
  sessions: SessionSummary[],
  range: AnalyticsRange,
): { current: SessionSummary[]; prior: SessionSummary[] } {
  const cutoff = rangeCutoffIso(range);
  if (!cutoff) {
    const mid = Math.floor(sessions.length / 2);
    return { current: sessions.slice(0, mid), prior: sessions.slice(mid) };
  }
  const current = sessions.filter((s) => s.started.slice(0, 10) >= cutoff);
  const prior = sessions.filter((s) => s.started.slice(0, 10) < cutoff);
  return { current, prior };
}

export function computeGapForSessions(
  sessions: SessionSummary[],
  resultsBySessionId: Map<number, ResultItem[]>,
): ComputedGap {
  const items: ResultItem[] = [];
  for (const s of sessions) {
    items.push(...(resultsBySessionId.get(s.id) ?? []));
  }
  return computeFromItems(items);
}
