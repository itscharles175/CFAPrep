/**
 * ANL-4 — host-side learning-curve + readiness shaping (data layer).
 *
 * A pure host-side backport: it consumes the SHIPPED cross-domain reads and
 * shapes them into the two Dashboard surfaces this item owns — per-domain
 * learning-curve sparklines (DashboardSparklineGrid) and a green/amber/red
 * readiness checklist (DashboardReadinessChecklist). NO backend changes: every
 * number comes from contracts already shipped this wave.
 *
 *  - GET /api/adaptivity/ability?domain=<cfa|quant|excel>  (LEARN-1)
 *      → the per-domain `UnifiedAbilityEstimate` (mastery / uncertainty /
 *        learning_velocity.slope_per_week / plateau / mastery_eta_days /
 *        evidence_n / blind-review outcomes / accuracy).
 *  - GET /api/study/profile  (DATA-6, via `fetchStudyProfile`)
 *      → exam date + target so the readiness checklist can score goal/pacing.
 *
 * Same fully-degrading transport idiom as the sibling host bridges
 * (`blindReviewBridge.ts` / `lsatCrossDomainBridge.ts`): every fetch is wrapped
 * in an AbortController timeout and NEVER throws. A down/timed-out/shape-drifted
 * sidecar yields `reachable: false` per domain, and the shaping helpers stay
 * total (no `undefined`) so the Dashboard cards render an honest "no signal yet"
 * state rather than hanging or crashing.
 *
 * DATA-1: the route path is anchored to the generated OpenAPI client; callers
 * append the typed `?domain=` query without weakening route-removal checks.
 */
import type { paths } from '../domains/lsat/lib/api.gen';
import type { DomainId, UnifiedAbilityEstimate } from './learningTypes';
import { fetchLsatSidecarJson } from './lsatSidecarClient';
import { fetchStudyProfile } from './studyProfileBridge';
import type { SharedStudyProfile } from './types/StudyProfile';

const ABILITY_PATH = '/api/adaptivity/ability' satisfies keyof paths;

/** The three host evidence planes the ability route accepts via `?domain=`. */
export const HOST_DOMAINS: readonly DomainId[] = ['cfa', 'quant', 'excel'];

/** Human label for a host domain plane. */
export const DOMAIN_LABELS: Record<DomainId, string> = {
  cfa: 'CFA',
  quant: 'Quant',
  excel: 'Excel',
};

/** Mastery target the backend's ETA is anchored to (parity with `_mastery_eta_days`). */
export const MASTERY_TARGET = 0.82;

/**
 * One domain's shaped learning curve. A degrading projection over the SHIPPED
 * ability estimate — `reachable: false` (the default) means the sidecar didn't
 * answer for this plane, so the sparkline renders an empty "no signal" cell.
 */
export interface DomainLearningCurve {
  domain: DomainId;
  label: string;
  /** True when the sidecar returned a usable estimate for this plane. */
  reachable: boolean;
  /** Current mastery 0..1 (0 when unreachable / no evidence). */
  mastery: number;
  /** Estimation uncertainty 0..1 (1 = no evidence). */
  uncertainty: number;
  /** Learning velocity (mastery-signal change per week); +up / -down / 0 flat. */
  slopePerWeek: number;
  /** True once evidence shows the curve has flattened (backend `plateau`). */
  plateau: boolean;
  /** Directional days-to-target, or null when flat/at-target-unknown. */
  masteryEtaDays: number | null;
  /** How many attempts back the estimate (the curve's confidence). */
  evidenceN: number;
  /** Realized accuracy 0..1, or null when no graded evidence. */
  accuracy: number | null;
  /**
   * The 2x2 blind-review outcome counts the estimate folded in
   * (`components.blind_review_outcomes`), in the shared
   * `blindReviewBridge` vocabulary. All zero when this plane has no BR passes.
   */
  blindReviewOutcomes: { timed_ok: number; timing_problem: number; concept_gap: number; lucky: number };
  /**
   * A small synthetic two-point sparkline series in mastery-space, derived from
   * the estimate's early/recent learning-velocity signals (NO chart lib — the
   * SVG component plots these points). Empty when there's no curve to draw.
   */
  series: number[];
  /** Coarse trend label for the sparkline caption / a11y text. */
  trend: 'new' | 'up' | 'flat' | 'down';
}

/** The full ANL-4 Dashboard metrics bundle (curves + the profile they're scored against). */
export interface DashboardMetrics {
  generatedAt: string;
  /** Per-domain learning curves (always all three planes; unreachable ones are empty). */
  curves: DomainLearningCurve[];
  /** True when at least one domain answered with a usable estimate. */
  anyReachable: boolean;
  /** The reconciled shared study profile (local fallback when the sidecar is down). */
  profile: SharedStudyProfile;
  /** True when the profile came from the backend arbiter (vs the local fallback). */
  profileFromBackend: boolean;
}

// ---------------------------------------------------------------------------
// Degrading fetch (mirrors blindReviewBridge.ts / lsatCrossDomainBridge.ts)
// ---------------------------------------------------------------------------

async function fetchJson(
  path: string,
  timeoutMs: number,
): Promise<{ ok: boolean; data: unknown } | { ok: false; error: string }> {
  const res = await fetchLsatSidecarJson(path, {
    timeoutMs,
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  if (res.reachable) return { ok: res.ok, data: res.data };
  return { ok: false, error: res.error ?? 'LSAT backend unreachable' };
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

// ---------------------------------------------------------------------------
// Pure shaping (exported so the components + tests can reuse them)
// ---------------------------------------------------------------------------

/** Coarse trend label from the slope + evidence, mirroring the host trend vocab. */
export function curveTrend(slopePerWeek: number, evidenceN: number): DomainLearningCurve['trend'] {
  if (evidenceN < 1) return 'new';
  if (slopePerWeek > 0.015) return 'up';
  if (slopePerWeek < -0.015) return 'down';
  return 'flat';
}

/**
 * Build the sparkline series in mastery-space from a unified ability estimate.
 *
 * The backend's `learning_velocity` carries an `early_signal`/`recent_signal`
 * pair (a transparent two-window proxy of the local attempt stream). We map
 * those signal averages onto a small ascending/descending series anchored at
 * current mastery so the SVG sparkline shows the SHAPE of the curve without
 * inventing data the backend didn't measure. With no velocity window (fewer
 * than the backend's 4-attempt floor) the series is empty.
 */
export function masterySeriesFromEstimate(estimate: UnifiedAbilityEstimate): number[] {
  const v = estimate.learning_velocity || {};
  const early = numOrNull(v.early_signal);
  const recent = numOrNull(v.recent_signal);
  const mastery = clamp01(num(estimate.mastery));
  if (early === null || recent === null) {
    // No measured window — fall back to a flat segment at current mastery only
    // when there is *some* evidence, else an empty (no-signal) series.
    return estimate.evidence_n > 0 ? [mastery, mastery] : [];
  }
  // The signals live in the ability/accuracy proxy space the backend uses for
  // the slope; anchor the endpoint at the reported mastery so the line lands on
  // the gauge the checklist reads, and derive the start from the early/recent
  // delta so the slope direction matches `slope_per_week`.
  const delta = clamp01(recent) - clamp01(early);
  const start = clamp01(mastery - delta);
  const mid = clamp01(start + delta / 2);
  return [start, mid, clamp01(mastery)];
}

/** A reachable-false curve placeholder for a plane the sidecar didn't answer. */
function unreachableCurve(domain: DomainId): DomainLearningCurve {
  return {
    domain,
    label: DOMAIN_LABELS[domain],
    reachable: false,
    mastery: 0,
    uncertainty: 1,
    slopePerWeek: 0,
    plateau: false,
    masteryEtaDays: null,
    evidenceN: 0,
    accuracy: null,
    blindReviewOutcomes: { timed_ok: 0, timing_problem: 0, concept_gap: 0, lucky: 0 },
    series: [],
    trend: 'new',
  };
}

/** Read the 2x2 BR outcome counts out of an estimate's `components` block. */
function readBlindReviewOutcomes(value: unknown): DomainLearningCurve['blindReviewOutcomes'] {
  const o = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    timed_ok: Math.max(0, Math.round(num(o.timed_ok))),
    timing_problem: Math.max(0, Math.round(num(o.timing_problem))),
    concept_gap: Math.max(0, Math.round(num(o.concept_gap))),
    lucky: Math.max(0, Math.round(num(o.lucky))),
  };
}

/** Coerce a raw `/adaptivity/ability?domain=` body into a {@link DomainLearningCurve}. */
export function curveFromEstimate(domain: DomainId, raw: unknown): DomainLearningCurve {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unreachableCurve(domain);
  const body = raw as Record<string, unknown>;
  const velocity =
    body.learning_velocity && typeof body.learning_velocity === 'object'
      ? (body.learning_velocity as Record<string, unknown>)
      : {};
  const components =
    body.components && typeof body.components === 'object'
      ? (body.components as Record<string, unknown>)
      : {};
  const estimate: UnifiedAbilityEstimate = {
    domain: domain,
    q_type: null,
    section_type: null,
    ability: num(body.ability),
    mastery: clamp01(num(body.mastery)),
    uncertainty: clamp01(num(body.uncertainty)),
    evidence_n: Math.max(0, Math.round(num(body.evidence_n))),
    accuracy: numOrNull(body.accuracy),
    avg_time_ms: numOrNull(body.avg_time_ms),
    model: typeof body.model === 'string' ? body.model : 'unknown',
    learning_velocity: {
      slope_per_week: num(velocity.slope_per_week),
      window: typeof velocity.window === 'string' ? velocity.window : 'unknown',
      early_signal: numOrNull(velocity.early_signal),
      recent_signal: numOrNull(velocity.recent_signal),
      days: numOrNull(velocity.days) ?? undefined,
    },
    plateau: Boolean(body.plateau),
    mastery_eta_days: numOrNull(body.mastery_eta_days),
    components: {
      blind_review_outcomes:
        components.blind_review_outcomes && typeof components.blind_review_outcomes === 'object'
          ? (components.blind_review_outcomes as Record<string, number>)
          : {},
      days: numOrNull(components.days),
      model: typeof components.model === 'string' ? components.model : 'unknown',
      uses_official_score_anchor_only: Boolean(components.uses_official_score_anchor_only),
    },
  };
  const slope = estimate.learning_velocity.slope_per_week;
  return {
    domain,
    label: DOMAIN_LABELS[domain],
    reachable: true,
    mastery: estimate.mastery,
    uncertainty: estimate.uncertainty,
    slopePerWeek: slope,
    plateau: estimate.plateau,
    masteryEtaDays: estimate.mastery_eta_days,
    evidenceN: estimate.evidence_n,
    accuracy: estimate.accuracy,
    blindReviewOutcomes: readBlindReviewOutcomes(estimate.components.blind_review_outcomes),
    series: masterySeriesFromEstimate(estimate),
    trend: curveTrend(slope, estimate.evidence_n),
  };
}

/** Sum the per-domain 2x2 BR outcome counts into one aggregate block. */
export function aggregateBlindReviewOutcomes(
  curves: DomainLearningCurve[],
): DomainLearningCurve['blindReviewOutcomes'] {
  return curves.reduce(
    (acc, c) => ({
      timed_ok: acc.timed_ok + c.blindReviewOutcomes.timed_ok,
      timing_problem: acc.timing_problem + c.blindReviewOutcomes.timing_problem,
      concept_gap: acc.concept_gap + c.blindReviewOutcomes.concept_gap,
      lucky: acc.lucky + c.blindReviewOutcomes.lucky,
    }),
    { timed_ok: 0, timing_problem: 0, concept_gap: 0, lucky: 0 },
  );
}

/**
 * Fetch one host plane's learning curve. Never throws — a down/garbled sidecar
 * yields an `unreachableCurve` so the grid degrades per-domain.
 */
export async function fetchDomainCurve(
  domain: DomainId,
  timeoutMs = 3000,
): Promise<DomainLearningCurve> {
  const res = await fetchJson(`${ABILITY_PATH}?domain=${encodeURIComponent(domain)}`, timeoutMs);
  if (!('ok' in res) || !res.ok) return unreachableCurve(domain);
  return curveFromEstimate(domain, res.data);
}

/**
 * Fetch the full ANL-4 Dashboard metrics bundle: the three host learning curves
 * (in parallel) + the reconciled study profile. Never throws — every leg
 * degrades independently so a partial outage still renders an honest picture.
 */
export async function fetchDashboardMetrics(
  opts: { domains?: readonly DomainId[]; timeoutMs?: number } = {},
): Promise<DashboardMetrics> {
  const { domains = HOST_DOMAINS, timeoutMs = 3000 } = opts;
  const [curves, profileResult] = await Promise.all([
    Promise.all(domains.map((d) => fetchDomainCurve(d, timeoutMs))),
    fetchStudyProfile({ timeoutMs }),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    curves,
    anyReachable: curves.some((c) => c.reachable),
    profile: profileResult.profile,
    profileFromBackend: profileResult.fromBackend,
  };
}

// ---------------------------------------------------------------------------
// Readiness checklist (pure scoring)
// ---------------------------------------------------------------------------

/** Traffic-light status for one readiness check. */
export type ReadinessStatus = 'green' | 'amber' | 'red' | 'unknown';

/** The dimensions the readiness checklist scores (stable ids for keys/tests). */
export type ReadinessCheckId =
  | 'goal'
  | 'forecast'
  | 'mastery'
  | 'evidence'
  | 'br-control'
  | 'calibration'
  | 'pacing'
  | 'srs'
  | 'plateau';

/** One scored readiness row. */
export interface ReadinessCheck {
  id: ReadinessCheckId;
  label: string;
  status: ReadinessStatus;
  /** Short human verdict (e.g. "62% avg mastery — on track"). */
  detail: string;
}

function round(value: number, places = 0): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

function pct(value: number): string {
  return `${round(value * 100)}%`;
}

/** Mean of a numeric list, or null when empty. */
function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Days from today to an ISO "YYYY-MM-DD" exam date, or null when unset/garbled. */
export function daysToExam(examDate: string | null, now: Date = new Date()): number | null {
  if (!examDate) return null;
  const parsed = Date.parse(`${examDate}T00:00:00`);
  if (Number.isNaN(parsed)) return null;
  const ms = parsed - Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00`);
  return Math.round(ms / 86_400_000);
}

/**
 * Score the full green/amber/red readiness checklist from the shaped curves +
 * the study profile. Pure and total: a dimension with no signal is `unknown`
 * (rendered grey) rather than a false green/red. Thresholds are deliberately
 * coarse + transparent (this is a directional cockpit, not a psychometric
 * promise — same spirit as the backend's ETA).
 */
export function scoreReadiness(
  metrics: Pick<DashboardMetrics, 'curves' | 'profile'>,
  opts: {
    /** Aggregate blind-review outcome counts (from the raw estimates). */
    blindReview?: { timed_ok: number; timing_problem: number; concept_gap: number; lucky: number };
    /** Aggregate confidence-calibration gap 0..1 (|stated − realized|), if known. */
    calibrationGap?: number | null;
    /** Total SRS reviews due now across domains, if known. */
    srsDue?: number | null;
    /** Pacing health 0..1 (1 = on-pace), if known. */
    pacingScore?: number | null;
    now?: Date;
  } = {},
): ReadinessCheck[] {
  const { curves, profile } = metrics;
  const reachable = curves.filter((c) => c.reachable);
  const masteries = reachable.filter((c) => c.evidenceN > 0).map((c) => c.mastery);
  const avgMastery = mean(masteries);
  const totalEvidence = reachable.reduce((sum, c) => sum + c.evidenceN, 0);
  const checks: ReadinessCheck[] = [];

  // 1) Goal — is a target + exam date set?
  const dte = daysToExam(profile.examDate, opts.now);
  if (!profile.hasPlan && profile.examDate === null) {
    checks.push({
      id: 'goal',
      label: 'Goal set',
      status: 'red',
      detail: 'No exam date or target on the shared study profile yet.',
    });
  } else if (profile.examDate === null) {
    checks.push({
      id: 'goal',
      label: 'Goal set',
      status: 'amber',
      detail: `Target ${profile.targetScore} set, but no exam date.`,
    });
  } else {
    checks.push({
      id: 'goal',
      label: 'Goal set',
      status: 'green',
      detail:
        dte !== null && dte >= 0
          ? `Target ${profile.targetScore}, exam in ${dte} day${dte === 1 ? '' : 's'}.`
          : `Target ${profile.targetScore}, exam date ${profile.examDate}.`,
    });
  }

  // 2) Forecast — does the curve trend point the right way before the exam?
  const upCount = reachable.filter((c) => c.trend === 'up').length;
  const downCount = reachable.filter((c) => c.trend === 'down').length;
  if (reachable.length === 0 || totalEvidence === 0) {
    checks.push({ id: 'forecast', label: 'Trajectory', status: 'unknown', detail: 'Not enough attempts to project a trend yet.' });
  } else if (downCount > upCount) {
    checks.push({ id: 'forecast', label: 'Trajectory', status: 'red', detail: `${downCount} domain${downCount === 1 ? '' : 's'} trending down.` });
  } else if (upCount > 0 && downCount === 0) {
    checks.push({ id: 'forecast', label: 'Trajectory', status: 'green', detail: `${upCount} domain${upCount === 1 ? '' : 's'} improving, none declining.` });
  } else {
    checks.push({ id: 'forecast', label: 'Trajectory', status: 'amber', detail: 'Mixed or flat trajectory across domains.' });
  }

  // 3) Mastery — average mastery vs the target band.
  if (avgMastery === null) {
    checks.push({ id: 'mastery', label: 'Mastery', status: 'unknown', detail: 'No graded evidence yet.' });
  } else if (avgMastery >= MASTERY_TARGET) {
    checks.push({ id: 'mastery', label: 'Mastery', status: 'green', detail: `${pct(avgMastery)} avg mastery — at or above target.` });
  } else if (avgMastery >= 0.6) {
    checks.push({ id: 'mastery', label: 'Mastery', status: 'amber', detail: `${pct(avgMastery)} avg mastery — approaching target.` });
  } else {
    checks.push({ id: 'mastery', label: 'Mastery', status: 'red', detail: `${pct(avgMastery)} avg mastery — below the build-up band.` });
  }

  // 4) Evidence — is there enough data to trust the estimate?
  if (totalEvidence >= 30) {
    checks.push({ id: 'evidence', label: 'Evidence', status: 'green', detail: `${totalEvidence} graded attempts back the estimate.` });
  } else if (totalEvidence >= 8) {
    checks.push({ id: 'evidence', label: 'Evidence', status: 'amber', detail: `${totalEvidence} attempts — estimate still firming up.` });
  } else {
    checks.push({ id: 'evidence', label: 'Evidence', status: 'red', detail: `Only ${totalEvidence} attempts — low confidence.` });
  }

  // 5) Blind-review control — careless vs concept split from the 2x2 outcomes.
  const br = opts.blindReview;
  const brTotal = br ? br.timed_ok + br.timing_problem + br.concept_gap + br.lucky : 0;
  if (!br || brTotal === 0) {
    checks.push({ id: 'br-control', label: 'Blind-review control', status: 'unknown', detail: 'No blind-review passes captured yet.' });
  } else {
    const conceptRate = br.concept_gap / brTotal;
    const carelessRate = br.timing_problem / brTotal;
    if (conceptRate > 0.3) {
      checks.push({ id: 'br-control', label: 'Blind-review control', status: 'red', detail: `${pct(conceptRate)} true concept gaps — knowledge, not timing.` });
    } else if (carelessRate > 0.25) {
      checks.push({ id: 'br-control', label: 'Blind-review control', status: 'amber', detail: `${pct(carelessRate)} careless/timing misses to tighten.` });
    } else {
      checks.push({ id: 'br-control', label: 'Blind-review control', status: 'green', detail: 'Few concept gaps or careless slips under BR.' });
    }
  }

  // 6) Calibration — is stated confidence matching realized accuracy?
  const calGap = opts.calibrationGap;
  if (calGap === null || calGap === undefined) {
    checks.push({ id: 'calibration', label: 'Calibration', status: 'unknown', detail: 'No confidence-vs-accuracy signal yet.' });
  } else if (calGap <= 0.1) {
    checks.push({ id: 'calibration', label: 'Calibration', status: 'green', detail: `${pct(calGap)} confidence gap — well calibrated.` });
  } else if (calGap <= 0.2) {
    checks.push({ id: 'calibration', label: 'Calibration', status: 'amber', detail: `${pct(calGap)} confidence gap — drifting.` });
  } else {
    checks.push({ id: 'calibration', label: 'Calibration', status: 'red', detail: `${pct(calGap)} confidence gap — over/under-confident.` });
  }

  // 7) Pacing — daily budget vs exam runway (or an explicit pacing score).
  if (opts.pacingScore !== null && opts.pacingScore !== undefined) {
    const ps = opts.pacingScore;
    const status: ReadinessStatus = ps >= 0.75 ? 'green' : ps >= 0.5 ? 'amber' : 'red';
    checks.push({ id: 'pacing', label: 'Pacing', status, detail: `${pct(ps)} on-pace against plan.` });
  } else if (dte === null) {
    checks.push({ id: 'pacing', label: 'Pacing', status: 'unknown', detail: 'No exam date to pace against.' });
  } else if (dte < 0) {
    checks.push({ id: 'pacing', label: 'Pacing', status: 'red', detail: 'Exam date has passed — reset the plan.' });
  } else if (profile.dailyMinutes <= 0) {
    checks.push({ id: 'pacing', label: 'Pacing', status: 'amber', detail: 'No daily study budget set.' });
  } else if (dte <= 14 && avgMastery !== null && avgMastery < 0.6) {
    checks.push({ id: 'pacing', label: 'Pacing', status: 'amber', detail: `${dte} days left at ${profile.dailyMinutes} min/day — tight runway.` });
  } else {
    checks.push({ id: 'pacing', label: 'Pacing', status: 'green', detail: `${profile.dailyMinutes} min/day with ${dte} days of runway.` });
  }

  // 8) SRS — is the spaced-review backlog under control?
  const due = opts.srsDue;
  if (due === null || due === undefined) {
    checks.push({ id: 'srs', label: 'Reviews', status: 'unknown', detail: 'Review backlog not loaded.' });
  } else if (due === 0) {
    checks.push({ id: 'srs', label: 'Reviews', status: 'green', detail: 'No reviews due — backlog clear.' });
  } else if (due <= 25) {
    checks.push({ id: 'srs', label: 'Reviews', status: 'amber', detail: `${due} review${due === 1 ? '' : 's'} due today.` });
  } else {
    checks.push({ id: 'srs', label: 'Reviews', status: 'red', detail: `${due} reviews due — backlog building.` });
  }

  // 9) Plateau — is progress stalling despite continued evidence?
  const plateaued = reachable.filter((c) => c.plateau);
  if (reachable.length === 0 || totalEvidence === 0) {
    checks.push({ id: 'plateau', label: 'Plateau watch', status: 'unknown', detail: 'No curve to watch yet.' });
  } else if (plateaued.length === 0) {
    checks.push({ id: 'plateau', label: 'Plateau watch', status: 'green', detail: 'No domain has flattened.' });
  } else {
    const labels = plateaued.map((c) => c.label).join(', ');
    const belowTarget = plateaued.some((c) => c.mastery < MASTERY_TARGET);
    checks.push({
      id: 'plateau',
      label: 'Plateau watch',
      status: belowTarget ? 'red' : 'amber',
      detail: `${labels} ${plateaued.length === 1 ? 'has' : 'have'} plateaued${belowTarget ? ' below target' : ' at target'}.`,
    });
  }

  return checks;
}

/** Roll the per-check statuses into one headline traffic-light for the card header. */
export function aggregateReadiness(checks: ReadinessCheck[]): ReadinessStatus {
  const scored = checks.filter((c) => c.status !== 'unknown');
  if (scored.length === 0) return 'unknown';
  if (scored.some((c) => c.status === 'red')) return 'red';
  if (scored.some((c) => c.status === 'amber')) return 'amber';
  return 'green';
}
