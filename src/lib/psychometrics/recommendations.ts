/**
 * PSY-5 — explainable ranked study recommendations.
 *
 * Turns PSY-3's ranked forecast drivers (forecastAttribution.ts) into concrete,
 * self-explaining candidate ACTIONS. Each recommendation states WHAT to do, the
 * SIGNAL that triggered it, the EXPECTED IMPACT on readiness (in mastery points,
 * read straight off the driver's contribution to the gap), and a one-line WHY.
 *
 * This is the "so what do I do about it?" layer on top of the attribution
 * waterfall: drivers explain the shortfall; recommendations prescribe the fix and
 * rank by how much readiness each fix would recover.
 *
 * Pure + deterministic: a `ForecastAttribution` in → a stable, ordered list out.
 * No I/O, no clock, fully offline.
 */

import type {
  ForecastAttribution,
  ForecastDriver,
  ForecastDriverKind,
} from './forecastAttribution';

export type RecommendationActionKind =
  | 'drill-topic'
  | 'broaden-coverage'
  | 'refresh-stale'
  | 'recalibrate-confidence'
  | 'increase-pace';

export interface StudyRecommendation {
  /** The kind of action to take. */
  action: RecommendationActionKind;
  /** Imperative, human-facing instruction, e.g. "Drill Derivatives". */
  title: string;
  /** Optional topic the action localises to. */
  topic?: string;
  /** The PSY-3 signal that triggered this action (e.g. 'stale-topic'). */
  triggeringSignal: string;
  /**
   * Expected readiness recovery in mastery points if the user acts on this — read
   * off the driver's contribution to the gap. Higher = act first.
   */
  expectedImpact: number;
  /** One-line, plain-language justification tying the signal to the action. */
  whyThis: string;
  /** The driver kind this recommendation derives from (for grouping/telemetry). */
  driverKind: ForecastDriverKind;
}

/** Map a driver kind to the action it prescribes + a why-template. */
const ACTION_FOR_DRIVER: Record<
  ForecastDriverKind,
  { action: RecommendationActionKind; verb: (topic?: string) => string; why: (d: ForecastDriver) => string }
> = {
  'topic-mastery': {
    action: 'drill-topic',
    verb: (topic) => (topic ? `Drill ${topic}` : 'Drill your weakest topics'),
    why: (d) =>
      `Mastery here is ${Math.round(d.detail.metric)}% and it weighs heavily on your readiness — focused practice closes the largest single slice of the gap.`,
  },
  coverage: {
    action: 'broaden-coverage',
    verb: () => 'Practise under-covered topics',
    why: () =>
      'Several topics have too little evidence to count toward readiness — a few attempts each turns blind spots into measured progress.',
  },
  recency: {
    action: 'refresh-stale',
    verb: (topic) => (topic ? `Refresh ${topic}` : 'Refresh stale topics'),
    why: (d) =>
      `It has been ~${Math.round(d.detail.metric)} days since you practised this; retrievability is decaying, so a short refresh recovers readiness cheaply.`,
  },
  calibration: {
    action: 'recalibrate-confidence',
    verb: () => 'Recalibrate your confidence',
    why: (d) =>
      d.detail.signal === 'overconfident'
        ? `Your confidence runs ~${Math.abs(Math.round(d.detail.metric))} points ahead of your accuracy — review missed "sure" answers to close the overconfidence gap.`
        : `You are under-confident by ~${Math.abs(Math.round(d.detail.metric))} points — trusting correct instincts will steady your pacing under exam pressure.`,
  },
  momentum: {
    action: 'increase-pace',
    verb: () => 'Increase your daily pace',
    why: (d) =>
      `At ~${d.detail.metric} attempts/day you won't close the gap before the exam — adding a daily block puts the projection back on track.`,
  },
};

export interface RecommendationOptions {
  /** Max recommendations to emit (default 5). */
  limit?: number;
  /** Drop drivers whose expected impact is below this (default 0.5 pts). */
  minImpact?: number;
}

/**
 * Emit ranked, explainable recommendations from a forecast attribution.
 *
 * Only COST drivers (positive contribution = they hurt readiness) become
 * recommendations — a tailwind needs no action. Recommendations are ranked by
 * expected impact (the driver's contribution) descending.
 */
export function recommendFromAttribution(
  attribution: ForecastAttribution,
  options: RecommendationOptions = {},
): StudyRecommendation[] {
  const limit = options.limit ?? 5;
  const minImpact = options.minImpact ?? 0.5;

  const recs: StudyRecommendation[] = [];
  for (const driver of attribution.drivers) {
    // Tailwinds (≤0) and sub-threshold drivers don't warrant an action.
    if (driver.contribution < minImpact) continue;
    const spec = ACTION_FOR_DRIVER[driver.kind];
    if (!spec) continue;
    recs.push({
      action: spec.action,
      title: spec.verb(driver.detail.topic),
      topic: driver.detail.topic,
      triggeringSignal: driver.detail.signal,
      expectedImpact: driver.contribution,
      whyThis: spec.why(driver),
      driverKind: driver.kind,
    });
  }

  // Already ranked by contribution via the driver order, but re-sort defensively
  // so ties + any future driver reordering stay impact-ranked + deterministic.
  recs.sort((a, b) => {
    if (b.expectedImpact !== a.expectedImpact) return b.expectedImpact - a.expectedImpact;
    return a.title.localeCompare(b.title);
  });

  return recs.slice(0, limit);
}
