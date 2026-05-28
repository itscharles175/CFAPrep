/**
 * Study Director — agentic study-plan synthesiser.
 *
 * Layer 1: Pure function `rankStudyActions` — unit-testable without Dexie.
 * Layer 2: Async orchestrator `buildStudyPlan` — fetches real data then calls
 *           `rankStudyActions`.
 */

// ---------------------------------------------------------------------------
// Types (exported so the UI panel can consume them)
// ---------------------------------------------------------------------------

export interface StudyAction {
  kind: 'review' | 'weak-topic' | 'forecast-spike' | 'continue';
  title: string;
  path: string;
  reason: string;
  priority: number;
}

export interface StudyPlan {
  generatedAt: string;
  headline: string;
  actions: StudyAction[];
  dueCount: number;
  weakCount: number;
  peakReviewDay?: { date: string; count: number } | null;
}

// ---------------------------------------------------------------------------
// Input shape for the pure function
// ---------------------------------------------------------------------------

export interface RankStudyActionsInputs {
  dueReviews: Array<{ title: string; path: string; retrievability?: number }>;
  readiness: Array<{ title: string; path: string; score: number }>;
  forecast: Array<{ date: string; count: number }>;
  continuePath?: string | null;
  now?: Date;
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
    actions.push({
      kind: 'review',
      title: item.title,
      path: item.path,
      reason: `Spaced-repetition review is due — ${retPct}.`,
      priority: reviewPriority,
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
    actions.push({
      kind: 'weak-topic',
      title: item.title,
      path: item.path,
      reason: `Topic readiness is only ${item.score}% — needs reinforcement.`,
      priority: weakPriority,
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
      actions.push({
        kind: 'forecast-spike',
        title: 'Upcoming review spike',
        path: '/cfa',
        reason: `${spike.count} items due on ${spike.date} — review ahead to reduce load.`,
        priority: 55,
      });
    }
  }

  // 4. Fallback 'continue' when the list would otherwise be short/empty.
  if (actions.length < 2) {
    actions.push({
      kind: 'continue',
      title: 'Continue studying',
      path: continuePath || '/cfa',
      reason:
        actions.length === 0
          ? 'No urgent reviews or weak areas — keep building momentum.'
          : 'Few action items today — keep progressing through the curriculum.',
      priority: 30,
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

  return {
    generatedAt,
    headline,
    actions,
    dueCount,
    weakCount,
    peakReviewDay,
  };
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
  ] = await Promise.all([
    import('./progressStore'),
    import('./scheduler'),
    import('./progressStore'),
  ]);

  const options = pathway ? { level3Pathway: pathway } : {};

  // Fetch in parallel; each call is graceful about empty data.
  const [dueItems, readinessByTopic, forecast, mastery, lessonProgress] =
    await Promise.all([
      getDueReviews(new Date(), options).catch(() => [] as Awaited<ReturnType<typeof getDueReviews>>),
      getReadinessByTopic(options).catch(() => [] as Awaited<ReturnType<typeof getReadinessByTopic>>),
      forecastReviewLoad(14, new Date(), options).catch(() => [] as Awaited<ReturnType<typeof forecastReviewLoad>>),
      getMasterySummary(options).catch(() => ({ snapshots: [], weakObjectives: [], averageScore: null })),
      db.lessonProgress.orderBy('lastVisitedAt').reverse().first().catch(() => undefined),
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

  return { mappedDue, mappedReadiness, mappedForecast, continuePath };
}

export async function buildStudyPlan(
  options: { pathway?: string } = {},
): Promise<StudyPlan> {
  try {
    const { mappedDue, mappedReadiness, mappedForecast, continuePath } =
      await fetchData(options.pathway);

    return rankStudyActions({
      dueReviews: mappedDue,
      readiness: mappedReadiness,
      forecast: mappedForecast,
      continuePath,
    });
  } catch {
    // Graceful degradation: return a minimal plan so the UI never breaks.
    return rankStudyActions({
      dueReviews: [],
      readiness: [],
      forecast: [],
      continuePath: '/cfa',
    });
  }
}
