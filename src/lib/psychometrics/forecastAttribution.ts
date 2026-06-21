/**
 * PSY-3 — causal forecast attribution waterfall.
 *
 * The Exam-Readiness Cockpit (examReadiness.ts) projects a single number: where
 * mastery lands on exam day. PSY-3 answers "WHY that number, and what is holding
 * it back from 100%?" by decomposing the GAP between the projected readiness and
 * the goal into a ranked set of named DRIVER contributions. Each driver is a
 * pure, signed, additive slice of the gap so the contributions form a waterfall
 * that sums (within rounding) to the total gap.
 *
 * Drivers (all measured against the same `now`, fully offline, no I/O):
 *   - topic-mastery : per-topic mastery deficit weighted by topic attempt share —
 *                     the dominant driver; ranks WHICH topics drag readiness.
 *   - coverage      : topics/objectives with little or no evidence yet (you can't
 *                     be ready on what you haven't practised).
 *   - recency       : decay since last practice — stale topics lose retrievability.
 *   - calibration   : confidence-vs-accuracy miscalibration (over/under-confidence
 *                     inflates or deflates perceived readiness).
 *   - momentum      : whether the trailing attempt rate × per-attempt lift will
 *                     actually close the remaining gap before the exam (a pace
 *                     driver — negative when there isn't enough runway).
 *
 * The decomposition is deliberately interpretable, not a black-box regression:
 * each driver is computed from observable telemetry and explains itself. PSY-5
 * (recommendations.ts) turns these ranked drivers into actions.
 *
 * Pure + deterministic given `{ snapshots, results, examDate, now }`.
 */

import type { Confidence, MasterySnapshot, QuestionResult } from '../learningTypes';
import { projectExamReadiness, type ReadinessProjection } from '../examReadiness';

export type ForecastDriverKind =
  | 'topic-mastery'
  | 'coverage'
  | 'recency'
  | 'calibration'
  | 'momentum';

export interface ForecastDriver {
  kind: ForecastDriverKind;
  /** Human label, e.g. "Topic mastery: Derivatives". */
  label: string;
  /**
   * Signed contribution to the readiness gap, in mastery points. POSITIVE =
   * this driver is COSTING readiness (it explains part of the shortfall);
   * negative = it is HELPING (a tailwind). The drivers sum (≈) to `gap`.
   */
  contribution: number;
  /** 0..1 share of the absolute total gap this driver accounts for. */
  share: number;
  /** The measured signal behind the number, surfaced for explanation/PSY-5. */
  detail: {
    /** Optional topic/objective key this driver localises to. */
    topic?: string;
    /** Free-form measured metric (e.g. mastery %, days stale, calibration gap). */
    metric: number;
    /** Short machine-readable signal name PSY-5 keys actions off. */
    signal: string;
  };
}

export interface ForecastAttribution {
  /** Mirrors the projection this attribution decomposes. */
  projection: ReadinessProjection;
  /** Target readiness the gap is measured against (default 100). */
  goal: number;
  /** Projected readiness on the exam date (or 90-day horizon). */
  projected: number;
  /** goal − projected, in mastery points (≥ 0 when below goal). */
  gap: number;
  /** Ranked drivers, largest positive (most costly) contribution first. */
  drivers: ForecastDriver[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_DAYS = 14; // topics not touched in this long start decaying in this model.

function confidenceScalar(c: Confidence | undefined): number {
  if (c === 'high') return 1;
  if (c === 'low') return 0;
  return 0.5;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Decompose the readiness gap into ranked drivers.
 *
 * @param goal Target readiness (default 100). The gap is `goal − projected`.
 */
export function attributeForecast(args: {
  snapshots: MasterySnapshot[];
  results: QuestionResult[];
  examDate: string | null;
  now?: Date;
  goal?: number;
}): ForecastAttribution {
  const now = args.now ?? new Date();
  const goal = args.goal ?? 100;
  const projection = projectExamReadiness({
    snapshots: args.snapshots,
    results: args.results,
    examDate: args.examDate,
    now,
  });
  const projected = projection.projectedOnExamDate ?? projection.currentMastery;
  const gap = Math.max(0, goal - projected);

  // ---- attempt share per topic (drives the topic-mastery weighting) --------
  const attemptsByTopic = new Map<string, number>();
  let totalAttempts = 0;
  for (const r of args.results) {
    const key = `${r.domain}::${r.topic}`;
    attemptsByTopic.set(key, (attemptsByTopic.get(key) ?? 0) + 1);
    totalAttempts += 1;
  }

  // ---- raw (unscaled) driver magnitudes ------------------------------------
  // We compute each driver as a raw "cost" first, then scale the whole set so the
  // sum of positive raw costs maps onto the actual `gap`. This keeps the waterfall
  // honest (sums to the gap) while preserving the RELATIVE ranking each raw signal
  // produces.
  const raw: ForecastDriver[] = [];

  // topic-mastery: per-topic (1 - mastery/100) weighted by attempt share.
  for (const snap of args.snapshots) {
    const key = `${snap.domain}::${snap.topic}`;
    const attempts = attemptsByTopic.get(key) ?? 0;
    const share = totalAttempts > 0 ? attempts / totalAttempts : 0;
    const deficit = Math.max(0, 100 - snap.score) / 100; // 0..1
    const cost = deficit * (0.25 + 0.75 * share); // weight toward practised topics
    if (cost <= 0) continue;
    raw.push({
      kind: 'topic-mastery',
      label: `Topic mastery: ${snap.topic}`,
      contribution: cost,
      share: 0,
      detail: { topic: snap.topic, metric: snap.score, signal: 'low-topic-mastery' },
    });
  }

  // coverage: topics with snapshots but thin evidence (few attempts) AND any
  // implied coverage hole (no snapshot rows at all → a single coverage driver).
  let thinCoverageCost = 0;
  for (const snap of args.snapshots) {
    const key = `${snap.domain}::${snap.topic}`;
    const attempts = attemptsByTopic.get(key) ?? 0;
    if (attempts < 3) {
      // Under-evidenced topic: contributes proportional to its remaining deficit.
      thinCoverageCost += (Math.max(0, 100 - snap.score) / 100) * (3 - attempts) * 0.15;
    }
  }
  if (args.snapshots.length === 0 && totalAttempts === 0) {
    // Nothing practised yet — coverage is the entire story.
    thinCoverageCost += 1;
  }
  if (thinCoverageCost > 0) {
    raw.push({
      kind: 'coverage',
      label: 'Coverage: under-practised topics',
      contribution: thinCoverageCost,
      share: 0,
      detail: { metric: round1(thinCoverageCost), signal: 'thin-coverage' },
    });
  }

  // recency: topics not touched within STALE_DAYS decay; cost scales with staleness.
  let recencyCost = 0;
  let stalest: { topic: string; days: number } | null = null;
  for (const snap of args.snapshots) {
    const last = Date.parse(snap.lastAttemptAt);
    if (!Number.isFinite(last)) continue;
    const days = Math.max(0, (now.getTime() - last) / DAY_MS);
    if (days > STALE_DAYS) {
      const staleness = Math.min(1, (days - STALE_DAYS) / 30); // 0..1 over a month
      recencyCost += staleness * (Math.max(0, 100 - snap.score) / 100) * 0.4;
      if (!stalest || days > stalest.days) stalest = { topic: snap.topic, days: Math.round(days) };
    }
  }
  if (recencyCost > 0) {
    raw.push({
      kind: 'recency',
      label: stalest ? `Recency decay: ${stalest.topic}` : 'Recency decay',
      contribution: recencyCost,
      share: 0,
      detail: {
        topic: stalest?.topic,
        metric: stalest?.days ?? 0,
        signal: 'stale-topic',
      },
    });
  }

  // calibration: aggregate confidence-vs-accuracy gap over recent results. Positive
  // gap (confidence ahead of accuracy = overconfidence) is a readiness RISK; we
  // surface its magnitude as a cost. Underconfidence (negative gap) is a small
  // tailwind (negative contribution).
  let confSum = 0;
  let correctSum = 0;
  let n = 0;
  for (const r of args.results) {
    confSum += confidenceScalar(r.confidence);
    correctSum += r.correct ? 1 : 0;
    n += 1;
  }
  if (n > 0) {
    const meanConf = confSum / n; // 0..1
    const meanAcc = correctSum / n; // 0..1
    const calibGap = meanConf - meanAcc; // + overconfident, − underconfident
    const calibCost = calibGap * 0.6; // signed; over-confidence costs, under helps
    if (Math.abs(calibCost) > 1e-6) {
      raw.push({
        kind: 'calibration',
        label: calibGap >= 0 ? 'Calibration: overconfidence' : 'Calibration: underconfidence',
        contribution: calibCost,
        share: 0,
        detail: { metric: Math.round(calibGap * 100), signal: calibGap >= 0 ? 'overconfident' : 'underconfident' },
      });
    }
  }

  // momentum: will the projected pace close the gap before the exam? Compare the
  // remaining gap to the lift the trailing rate would add over the remaining days.
  // A shortfall (not enough runway) is a positive cost; ample runway is a tailwind.
  const remainingDays = projection.daysUntilExam || 0;
  const dailyLift = projection.averageDailyAttempts * projection.perAttemptLift;
  const projectedAdditionalLift = dailyLift * remainingDays;
  if (gap > 0 && remainingDays > 0) {
    const shortfall = (gap - projectedAdditionalLift) / 100; // fraction of full scale
    const momentumCost = shortfall * 0.5; // signed
    if (Math.abs(momentumCost) > 1e-6) {
      raw.push({
        kind: 'momentum',
        label: shortfall >= 0 ? 'Momentum: pace too slow for exam date' : 'Momentum: on pace',
        contribution: momentumCost,
        share: 0,
        detail: { metric: round1(projection.averageDailyAttempts), signal: shortfall >= 0 ? 'insufficient-pace' : 'on-pace' },
      });
    }
  }

  // ---- scale raw costs so positive contributions sum to the actual gap -----
  const positiveRaw = raw.filter((d) => d.contribution > 0).reduce((s, d) => s + d.contribution, 0);
  const scale = positiveRaw > 0 && gap > 0 ? gap / positiveRaw : 0;

  const drivers: ForecastDriver[] = raw.map((d) => ({
    ...d,
    contribution: round1(d.contribution * scale),
  }));

  // share is computed against the absolute total so tailwinds don't distort it.
  const absTotal = drivers.reduce((s, d) => s + Math.abs(d.contribution), 0) || 1;
  for (const d of drivers) {
    d.share = Math.round((Math.abs(d.contribution) / absTotal) * 100) / 100;
  }

  // Rank: most COSTLY (largest positive) first; tailwinds sink to the bottom.
  drivers.sort((a, b) => b.contribution - a.contribution);

  return { projection, goal, projected, gap: round1(gap), drivers };
}
