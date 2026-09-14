/**
 * Study Director — agentic study-plan synthesiser.
 *
 * Layer 1: Pure function `rankStudyActions` — unit-testable without Dexie.
 * Layer 2: Async orchestrator `buildStudyPlan` — fetches real data then calls
 *           `rankStudyActions`.
 */

import type { StudyDomain, StudyTimeAllocation } from './types/StudyProfile';

// ---------------------------------------------------------------------------
// Types (exported so the UI panel can consume them)
// ---------------------------------------------------------------------------

export interface StudyAction {
  kind: 'review' | 'weak-topic' | 'forecast-spike' | 'continue';
  title: string;
  path: string;
  reason: string;
  priority: number;
  domain: StudyDomain;
  objective: string;
  estimatedMinutes: number;
  availability: 'ready' | 'deferred' | 'unavailable';
  /** Structured alias for `reason`, retained for existing consumers. */
  rationale: string;
}

export interface StudyPlan {
  generatedAt: string;
  headline: string;
  actions: StudyAction[];
  /** Ranked work that did not fit today's time budget. */
  backlogActions: StudyAction[];
  totalActionCount: number;
  totalEstimatedMinutes: number;
  scheduledMinutes: number;
  dueCount: number;
  weakCount: number;
  peakReviewDay?: { date: string; count: number } | null;
  /** Interleaving plan (only present when there are weak topics to interleave). */
  interleaving?: InterleavingResult | null;
  /** Human-readable explanation of why this ordering was chosen. */
  rationale?: string;
}

// ---------------------------------------------------------------------------
// Interleaving / desirable-difficulty types
// ---------------------------------------------------------------------------

export interface InterleavingOptions {
  /** Fraction of slots reserved for a non-weakest topic to encourage interleaving. */
  interleaveRatio?: number;        // default 0.30
  /** Number of slots to plan ahead — defaults to 10. */
  slotCount?: number;
  /** Minimum mastery delta below which we will NOT downshift difficulty
   *  (i.e. desirable difficulty: don't make it too easy when struggling). */
  desirableDifficultyMin?: number; // default 0.15
}

export interface InterleavingResult {
  pickedTopics: string[];          // ordered list
  rationale: string;               // human-readable, used in narrate
  spacingScore: number;            // measure of how interleaved we are
}

// ---------------------------------------------------------------------------
// Input shape for the pure function
// ---------------------------------------------------------------------------

export interface RankStudyActionsInputs {
  dueReviews: Array<{ title: string; path: string; retrievability?: number; domain?: StudyDomain; objective?: string; estimatedMinutes?: number; available?: boolean }>;
  readiness: Array<{ title: string; path: string; score: number; domain?: StudyDomain; objective?: string; estimatedMinutes?: number; available?: boolean }>;
  forecast: Array<{ date: string; count: number }>;
  continuePath?: string | null;
  availableMinutes?: number;
  timeAllocation?: StudyTimeAllocation;
  now?: Date;
}

function domainFromPath(path: string): StudyDomain {
  const segment = path.split('/').filter(Boolean)[0];
  return segment === 'lsat' || segment === 'quant' || segment === 'excel' ? segment : 'cfa';
}

function actionMetadata(
  item: { title: string; path: string; domain?: StudyDomain; objective?: string; estimatedMinutes?: number; available?: boolean },
  defaultMinutes: number,
  rationale: string,
) {
  return {
    domain: item.domain ?? domainFromPath(item.path),
    objective: item.objective ?? item.title,
    estimatedMinutes: Math.max(5, Math.round(item.estimatedMinutes ?? defaultMinutes)),
    availability: item.available === false ? 'unavailable' as const : 'ready' as const,
    rationale,
  };
}

// ---------------------------------------------------------------------------
// Layer 1: Pure ranking function
// ---------------------------------------------------------------------------

export function rankStudyActions(inputs: RankStudyActionsInputs): StudyPlan {
  const { dueReviews, readiness, forecast, continuePath, now } = inputs;
  const generatedAt = (now ?? new Date()).toISOString();

  const actions: StudyAction[] = [];

  // 1. Due reviews — sorted ascending by retrievability (most-forgotten first),
  //    cap at 5.
  const sortedDue = [...dueReviews].sort((a, b) => {
    const ra = a.retrievability ?? 0;
    const rb = b.retrievability ?? 0;
    return ra - rb;
  });
  const cappedDue = sortedDue.slice(0, 5);
  let reviewPriority = 100;
  for (const item of cappedDue) {
    const retPct =
      item.retrievability != null
        ? `${Math.round(item.retrievability * 100)}% retention remaining`
        : 'due for review';
    const reason = `Spaced-repetition review is due — ${retPct}.`;
    actions.push({
      kind: 'review',
      title: item.title,
      path: item.path,
      reason,
      priority: reviewPriority,
      ...actionMetadata(item, 15, reason),
    });
    // Give successive review actions slightly lower priority so ordering is stable
    reviewPriority -= 1;
  }

  // 2. Weak topics — below ~70, ascending score, cap at 3.
  const weakTopics = [...readiness]
    .filter((item) => item.score < 70)
    .sort((a, b) => a.score - b.score)
    .slice(0, 3);
  let weakPriority = 70;
  for (const item of weakTopics) {
    const reason = `Topic readiness is only ${item.score}% — needs reinforcement.`;
    actions.push({
      kind: 'weak-topic',
      title: item.title,
      path: item.path,
      reason,
      priority: weakPriority,
      ...actionMetadata(item, 30, reason),
    });
    weakPriority -= 1;
  }

  // 3. Forecast spike — one action if any future day is notably high
  //    (>= 1.5× the mean AND >= 8 items).
  let peakReviewDay: StudyPlan['peakReviewDay'] = null;
  if (forecast.length > 0) {
    const mean =
      forecast.reduce((sum, day) => sum + day.count, 0) / forecast.length;
    const spike = forecast.find(
      (day) => day.count >= 8 && day.count >= mean * 1.5,
    );
    if (spike) {
      peakReviewDay = { date: spike.date, count: spike.count };
      const reason = `${spike.count} items due on ${spike.date} — review ahead to reduce load.`;
      actions.push({
        kind: 'forecast-spike',
        title: 'Upcoming review spike',
        path: '/cfa',
        reason,
        priority: 55,
        ...actionMetadata({ title: 'Upcoming review spike', path: '/cfa' }, 20, reason),
      });
    }
  }

  // 4. Fallback 'continue' when the list would otherwise be short/empty.
  if (actions.length < 2) {
    const reason = actions.length === 0
      ? 'No urgent reviews or weak areas — keep building momentum.'
      : 'Few action items today — keep progressing through the curriculum.';
    const path = continuePath || '/cfa';
    actions.push({
      kind: 'continue',
      title: 'Continue studying',
      path,
      reason,
      priority: 30,
      ...actionMetadata({ title: 'Continue studying', path }, 30, reason),
    });
  }

  // Build headline
  const dueCount = cappedDue.length;
  const weakCount = weakTopics.length;
  let headline: string;
  if (dueCount > 0 && weakCount > 0) {
    headline = `${dueCount} review${dueCount !== 1 ? 's' : ''} due, ${weakCount} weak topic${weakCount !== 1 ? 's' : ''} to shore up`;
  } else if (dueCount > 0) {
    headline = `${dueCount} review${dueCount !== 1 ? 's' : ''} due`;
  } else if (weakCount > 0) {
    headline = `${weakCount} weak topic${weakCount !== 1 ? 's' : ''} to strengthen`;
  } else {
    headline = 'No urgent items — great progress!';
  }

  const totalEstimatedMinutes = actions.reduce((sum, action) => sum + action.estimatedMinutes, 0);
  const availableMinutes = Number.isFinite(inputs.availableMinutes)
    ? Math.max(0, Math.round(inputs.availableMinutes ?? 0))
    : Number.POSITIVE_INFINITY;
  const remainingByDomain = new Map<StudyDomain, number>();
  for (const [domain, minutes] of Object.entries(inputs.timeAllocation ?? {})) {
    if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0) {
      remainingByDomain.set(domain as StudyDomain, Math.round(minutes));
    }
  }
  let remaining = availableMinutes;
  const scheduled: StudyAction[] = [];
  const backlogActions: StudyAction[] = [];
  for (const action of actions) {
    const domainRemaining = remainingByDomain.get(action.domain);
    const fitsDomain = domainRemaining === undefined || action.estimatedMinutes <= domainRemaining;
    const fitsTotal = action.estimatedMinutes <= remaining;
    if (action.availability === 'ready' && fitsDomain && fitsTotal) {
      scheduled.push(action);
      remaining -= action.estimatedMinutes;
      if (domainRemaining !== undefined) {
        remainingByDomain.set(action.domain, domainRemaining - action.estimatedMinutes);
      }
    } else {
      backlogActions.push({
        ...action,
        availability: action.availability === 'unavailable' ? 'unavailable' : 'deferred',
      });
    }
  }

  return {
    generatedAt,
    headline,
    actions: scheduled,
    backlogActions,
    totalActionCount: actions.length,
    totalEstimatedMinutes,
    scheduledMinutes: scheduled.reduce((sum, action) => sum + action.estimatedMinutes, 0),
    dueCount,
    weakCount,
    peakReviewDay,
  };
}

/** Move an action within today's shortlist while keeping descending priorities. */
export function reprioritizeStudyPlan(plan: StudyPlan, fromIndex: number, toIndex: number): StudyPlan {
  if (fromIndex < 0 || fromIndex >= plan.actions.length) return plan;
  const target = Math.max(0, Math.min(plan.actions.length - 1, toIndex));
  const actions = [...plan.actions];
  const [moved] = actions.splice(fromIndex, 1);
  actions.splice(target, 0, moved);
  const topPriority = Math.max(...actions.map((action) => action.priority), 0);
  return { ...plan, actions: actions.map((action, index) => ({ ...action, priority: topPriority - index })) };
}

/** Defer one scheduled action without discarding it from the day's workload. */
export function postponeStudyAction(plan: StudyPlan, actionIndex: number): StudyPlan {
  if (actionIndex < 0 || actionIndex >= plan.actions.length) return plan;
  const actions = [...plan.actions];
  const [postponed] = actions.splice(actionIndex, 1);
  return {
    ...plan,
    actions,
    backlogActions: [...plan.backlogActions, { ...postponed, availability: 'deferred' }],
    scheduledMinutes: actions.reduce((sum, action) => sum + action.estimatedMinutes, 0),
  };
}

/** Rebuild the remaining plan with a new total or per-domain time budget. */
export function regenerateStudyPlan(
  inputs: RankStudyActionsInputs,
  budget: { availableMinutes?: number; timeAllocation?: StudyTimeAllocation },
): StudyPlan {
  return rankStudyActions({ ...inputs, ...budget });
}

// ---------------------------------------------------------------------------
// Layer 1b: Pure interleaving / desirable-difficulty rules
// ---------------------------------------------------------------------------

const DEFAULT_INTERLEAVE_RATIO = 0.30;
const DEFAULT_SLOT_COUNT = 10;
const DEFAULT_DESIRABLE_DIFFICULTY_MIN = 0.15;

/**
 * Plan a study session as an ordered sequence of topic slots.
 *
 * Rules:
 *   - PRIMARY slot is the weakest topic (lowest mastery).
 *   - With >=2 weak topics, every `1 / interleaveRatio`-th slot is the
 *     SECOND-weakest topic (the "interleaving" — practising adjacent material
 *     between blocks of the weakest topic).
 *   - When the next natural pick equals the most recent `history` entry, swap
 *     in the alternate weak topic (avoid back-to-back same-topic, window=3).
 *   - `desirableDifficultyMin`: when mastery is below this threshold we don't
 *     ramp down the difficulty further — encoded in the rationale string;
 *     callers consult the psychometrics report to pick mid-difficulty items.
 *   - `spacingScore`: 1 - (max run length / total length).
 *     0 means all-same-topic; 1 means perfectly alternating.
 */
export function applyInterleavingRules(
  weakTopics: Array<{ topic: string; mastery: number }>,
  history: Array<{ topic: string; at: string }>,
  options: InterleavingOptions = {},
): InterleavingResult {
  const interleaveRatio = options.interleaveRatio ?? DEFAULT_INTERLEAVE_RATIO;
  const slotCount = Math.max(1, options.slotCount ?? DEFAULT_SLOT_COUNT);
  const desirableDifficultyMin =
    options.desirableDifficultyMin ?? DEFAULT_DESIRABLE_DIFFICULTY_MIN;

  if (!weakTopics || weakTopics.length === 0) {
    return {
      pickedTopics: [],
      rationale: 'No weak topics provided — nothing to interleave.',
      spacingScore: 0,
    };
  }

  // Sort weak topics ascending by mastery so primary = weakest.
  const sorted = [...weakTopics].sort((a, b) => a.mastery - b.mastery);
  const primary = sorted[0];
  const secondary = sorted[1] ?? null;

  // Build a sliding window of the last 3 entries from history (most recent first).
  const recentHistory = [...history]
    .slice(-3)
    .reverse(); // index 0 is most recent
  const lastHistoryTopic = recentHistory[0]?.topic ?? null;

  // Single-weak-topic case: pick it for every slot (will produce spacingScore=0).
  if (!secondary) {
    const picked = Array.from({ length: slotCount }, () => primary.topic);
    const rationale = buildSingleTopicRationale(primary, desirableDifficultyMin);
    return {
      pickedTopics: picked,
      rationale,
      spacingScore: computeSpacingScore(picked),
    };
  }

  // Interleave every Nth slot, where N = round(1 / interleaveRatio).
  // Guard against pathological ratios (<=0 or >=1).
  const safeRatio = Math.min(0.9, Math.max(0.05, interleaveRatio));
  const step = Math.max(2, Math.round(1 / safeRatio));

  const picked: string[] = [];
  let lastEmitted: string | null = lastHistoryTopic; // seed avoid-repeat with history

  for (let i = 0; i < slotCount; i++) {
    // Natural pick: primary, except every `step`-th slot is secondary (1-indexed).
    const slotIndex = i + 1;
    const naturalPick = slotIndex % step === 0 ? secondary.topic : primary.topic;

    let chosen = naturalPick;
    // Avoid back-to-back with the previous slot OR with the most recent history.
    if (chosen === lastEmitted) {
      chosen = chosen === primary.topic ? secondary.topic : primary.topic;
    }
    picked.push(chosen);
    lastEmitted = chosen;
  }

  const rationale = buildInterleaveRationale(
    primary,
    secondary,
    desirableDifficultyMin,
    safeRatio,
  );

  return {
    pickedTopics: picked,
    rationale,
    spacingScore: computeSpacingScore(picked),
  };
}

function buildSingleTopicRationale(
  primary: { topic: string; mastery: number },
  desirableDifficultyMin: number,
): string {
  const masteryPct = Math.round(primary.mastery * 100);
  const difficultyNote =
    primary.mastery < desirableDifficultyMin
      ? ` Mastery is below the desirable-difficulty floor (${Math.round(desirableDifficultyMin * 100)}%) — keep items at mid-difficulty, not the easiest available.`
      : '';
  return `Only one weak topic (${primary.topic} at ${masteryPct}%) — full session focused on consolidation.${difficultyNote}`;
}

function buildInterleaveRationale(
  primary: { topic: string; mastery: number },
  secondary: { topic: string; mastery: number },
  desirableDifficultyMin: number,
  ratio: number,
): string {
  const primaryPct = Math.round(primary.mastery * 100);
  const secondaryPct = Math.round(secondary.mastery * 100);
  const ratioPct = Math.round(ratio * 100);
  const difficultyNote =
    primary.mastery < desirableDifficultyMin
      ? ` Mastery on ${primary.topic} is below the desirable-difficulty floor (${Math.round(desirableDifficultyMin * 100)}%); the orchestrator avoids the easiest items so retrieval stays effortful.`
      : '';
  return `Interleaved between ${primary.topic} (${primaryPct}%) and ${secondary.topic} (${secondaryPct}%) to consolidate both before the exam — ~${ratioPct}% of slots are reserved for the second-weakest topic.${difficultyNote}`;
}

/**
 * Spacing score = 1 - (max run length / total length).
 * - All-same topic → 0
 * - Perfectly alternating → ~1 (max run = 1, total = N → 1 - 1/N).
 */
export function computeSpacingScore(picks: string[]): number {
  if (picks.length === 0) return 0;
  let maxRun = 1;
  let currentRun = 1;
  for (let i = 1; i < picks.length; i++) {
    if (picks[i] === picks[i - 1]) {
      currentRun += 1;
      if (currentRun > maxRun) maxRun = currentRun;
    } else {
      currentRun = 1;
    }
  }
  return 1 - maxRun / picks.length;
}

// ---------------------------------------------------------------------------
// Layer 2: Async orchestrator (fetches real data, calls rankStudyActions)
// ---------------------------------------------------------------------------

// Lazy imports to keep this file side-effect-free at module load time and
// avoid hard-coding Dexie types in the pure-function half.
async function fetchData(pathway?: string) {
  const [
    { getDueReviews, getReadinessByTopic, forecastReviewLoad, getMasterySummary },
    { currentRetrievability },
    { db },
    { fetchStudyProfile },
  ] = await Promise.all([
    import('./progressStore'),
    import('./scheduler'),
    import('./progressStore'),
    import('./studyProfileBridge'),
  ]);

  const options = pathway ? { level3Pathway: pathway } : {};

  // Fetch in parallel; each call is graceful about empty data.
  const [dueItems, readinessByTopic, forecast, mastery, lessonProgress, profileResult] =
    await Promise.all([
      getDueReviews(new Date(), options).catch(() => [] as Awaited<ReturnType<typeof getDueReviews>>),
      getReadinessByTopic(options).catch(() => [] as Awaited<ReturnType<typeof getReadinessByTopic>>),
      forecastReviewLoad(14, new Date(), options).catch(() => [] as Awaited<ReturnType<typeof forecastReviewLoad>>),
      getMasterySummary(options).catch(() => ({ snapshots: [], weakObjectives: [], averageScore: null })),
      db.lessonProgress.orderBy('lastVisitedAt').reverse().first().catch(() => undefined),
      fetchStudyProfile({ timeoutMs: 500 }).catch(() => null),
    ]);

  // Map due reviews — attach current retrievability from FSRS scheduler.
  const mappedDue = dueItems.map((item) => ({
    title: item.title,
    path: item.path,
    retrievability: currentRetrievability(item),
  }));

  // Map weak topics from mastery snapshots (via getMasterySummary.weakObjectives)
  // Each weakObjective: { id, domain, topic, title, score, attempts, ... }
  const mappedReadiness = mastery.weakObjectives.map((obj) => ({
    title: obj.title,
    // Build a sensible path; use readinessScore < 70 filter inside rankStudyActions
    path: `/${obj.domain}/${obj.topic.replace(':', '/')}`,
    score: obj.score,
  }));

  // Supplement with any readiness rows not already covered.
  const weakObjectiveIds = new Set(mastery.weakObjectives.map((o) => o.id));
  for (const row of readinessByTopic) {
    if (!weakObjectiveIds.has(row.id) && row.readinessScore < 70) {
      mappedReadiness.push({
        title: row.title,
        path: `/${row.domain}/${row.topic.replace(':', '/')}`,
        score: row.readinessScore,
      });
    }
  }

  // Map forecast: RetentionForecast has { date, count, averageRetention, atRiskCount }
  const mappedForecast = forecast.map((day) => ({
    date: day.date,
    count: day.count,
  }));

  const continuePath = lessonProgress?.path ?? null;

  // Build a weak-topic list keyed by `topic` (string id) for the interleaver,
  // and a short study history from mastery snapshots / lessonProgress so the
  // interleaver can avoid back-to-back repeats.
  const weakForInterleave: Array<{ topic: string; mastery: number }> =
    mastery.weakObjectives.map((obj) => ({
      topic: obj.topic,
      mastery: obj.score / 100,
    }));

  const recentHistory: Array<{ topic: string; at: string }> = mastery.snapshots
    .filter((s) => s.lastAttemptAt)
    .sort((a, b) => a.lastAttemptAt.localeCompare(b.lastAttemptAt))
    .slice(-3)
    .map((s) => ({ topic: s.topic, at: s.lastAttemptAt }));

  return {
    mappedDue,
    mappedReadiness,
    mappedForecast,
    continuePath,
    weakForInterleave,
    recentHistory,
    profile: profileResult?.profile ?? DEFAULT_PROFILE_BUDGET,
  };
}

const DEFAULT_PROFILE_BUDGET = { dailyMinutes: 60, timeAllocation: {} as StudyTimeAllocation };

export async function buildStudyPlan(
  options: {
    pathway?: string;
    interleavingOptions?: InterleavingOptions;
    availableMinutes?: number;
    timeAllocation?: StudyTimeAllocation;
  } = {},
): Promise<StudyPlan> {
  try {
    const {
      mappedDue,
      mappedReadiness,
      mappedForecast,
      continuePath,
      weakForInterleave,
      recentHistory,
      profile,
    } = await fetchData(options.pathway);

    const plan = rankStudyActions({
      dueReviews: mappedDue,
      readiness: mappedReadiness,
      forecast: mappedForecast,
      continuePath,
      availableMinutes: options.availableMinutes ?? profile.dailyMinutes,
      timeAllocation: options.timeAllocation ?? profile.timeAllocation,
    });

    // Layer plan with interleaving + rationale (only when there's at least one
    // weak topic — otherwise the plan is forecast/review-driven).
    if (weakForInterleave.length > 0) {
      const interleaving = applyInterleavingRules(
        weakForInterleave,
        recentHistory,
        options.interleavingOptions,
      );
      plan.interleaving = interleaving;
      plan.rationale = interleaving.rationale;
    } else {
      plan.interleaving = null;
      plan.rationale =
        plan.dueCount > 0
          ? 'No weak topics — session is fully driven by spaced-repetition due reviews.'
          : 'No urgent items — keep building momentum on the next curriculum module.';
    }

    return plan;
  } catch {
    // Graceful degradation: return a minimal plan so the UI never breaks.
    const fallback = rankStudyActions({
      dueReviews: [],
      readiness: [],
      forecast: [],
      continuePath: '/cfa',
    });
    fallback.interleaving = null;
    fallback.rationale =
      'Local vault is offline — falling back to the continue-where-you-left-off plan.';
    return fallback;
  }
}
