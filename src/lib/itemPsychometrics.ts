/**
 * IRT-lite item psychometrics.
 *
 * Single-user spaced-repetition apps cannot run full Item Response Theory
 * (IRT needs many examinees per item).  But we can do a useful pragmatic
 * subset against ONE user's history:
 *
 *   - Classical-Test-Theory empirical difficulty   = 1 - p_correct
 *   - Point-biserial discrimination               = correlation between
 *     getting THIS item right vs the user's contemporaneous mastery
 *     across all OTHER items in the same topic
 *   - Reliability proxy                           = standard error of the
 *     accuracy estimate (1/sqrt(attempts) Wald style)
 *
 * The output is a per-item calibration report flagging items as
 * `too-easy`, `too-hard`, `low-discrimination`, or `ok`.  We use it to
 * surface items that probably need review or retirement and to feed an
 * adaptive-difficulty selector in future work.
 *
 * Storage key:  `item-psychometrics:cache`
 */

import type { Confidence, DomainId, QuestionResult } from './learningTypes';
import { getStorage } from './storage';

export const PSYCHOMETRICS_CACHE_KEY = 'item-psychometrics:cache';

/** Items below this attempt threshold are flagged as `insufficient-data`. */
export const MIN_ATTEMPTS = 3;

/** Items above the high-accuracy threshold are flagged `too-easy`. */
export const TOO_EASY_THRESHOLD = 0.95;

/** Items below the low-accuracy threshold are flagged `too-hard`. */
export const TOO_HARD_THRESHOLD = 0.25;

/** Items with discrimination below this are flagged `low-discrimination`. */
export const LOW_DISCRIMINATION_THRESHOLD = 0.10;

export type ItemFlag =
  | 'ok'
  | 'too-easy'
  | 'too-hard'
  | 'low-discrimination'
  | 'insufficient-data';

export interface ItemStats {
  questionId: string;
  domain: DomainId;
  topic: string;
  attempts: number;
  correctCount: number;
  accuracy: number;             // fraction in [0, 1]
  empiricalDifficulty: number;  // 1 - accuracy
  discrimination: number;       // point-biserial correlation in [-1, 1]
  reliabilitySE: number;        // standard error of accuracy estimate
  avgConfidence: number;        // numeric average: low=0, medium=0.5, high=1
  flag: ItemFlag;
  // Per-topic accuracy at the time of each attempt (used for QA / debugging).
  meanTopicAccuracyAtAttempt: number;
}

export interface PsychometricsReport {
  generatedAt: string;
  totalAttempts: number;
  totalItems: number;
  itemsByFlag: Record<ItemFlag, number>;
  items: ItemStats[];
}

/** Confidence → numeric scalar (used for avgConfidence). */
function confidenceScalar(c: Confidence | undefined): number {
  if (c === 'high') return 1;
  if (c === 'low') return 0;
  return 0.5;
}

/** Pearson correlation between two arrays of equal length. */
export function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2 || n !== ys.length) return 0;
  let sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxy += xs[i] * ys[i];
    sxx += xs[i] * xs[i];
    syy += ys[i] * ys[i];
  }
  const num = n * sxy - sx * sy;
  const den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  if (den === 0) return 0;
  return num / den;
}

interface TimedResult {
  domain: DomainId;
  topic: string;
  questionId: string;
  correct: boolean;
  confidence: Confidence;
  at: number; // ms epoch
}

function ingest(results: QuestionResult[]): TimedResult[] {
  const out: TimedResult[] = [];
  for (const r of results) {
    if (!r.questionId || !r.createdAt) continue;
    const at = Date.parse(r.createdAt);
    if (!Number.isFinite(at)) continue;
    out.push({
      domain: r.domain,
      topic: r.topic,
      questionId: r.questionId,
      correct: r.correct,
      confidence: r.confidence,
      at,
    });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/** Per-topic rolling accuracy at time `t`, excluding the index attempt itself. */
function topicAccuracyExcluding(
  topicAttempts: TimedResult[],
  excludeIndex: number,
): number {
  let n = 0;
  let correct = 0;
  for (let i = 0; i < topicAttempts.length; i++) {
    if (i === excludeIndex) continue;
    n += 1;
    if (topicAttempts[i].correct) correct += 1;
  }
  return n === 0 ? 0.5 : correct / n;
}

/**
 * Compute psychometrics for every distinct item observed in `results`.
 * Returns a deterministic, fully self-contained report.
 */
export function computePsychometrics(results: QuestionResult[]): PsychometricsReport {
  const timed = ingest(results);

  // Group attempts by (domain, topic) — discrimination is computed within-topic
  // to control for topic-specific mastery.
  const byTopic = new Map<string, TimedResult[]>();
  for (const r of timed) {
    const key = `${r.domain}::${r.topic}`;
    const arr = byTopic.get(key) ?? [];
    arr.push(r);
    byTopic.set(key, arr);
  }

  // Group attempts by (domain, questionId).
  const byItem = new Map<string, TimedResult[]>();
  for (const r of timed) {
    const key = `${r.domain}::${r.questionId}`;
    const arr = byItem.get(key) ?? [];
    arr.push(r);
    byItem.set(key, arr);
  }

  const items: ItemStats[] = [];

  for (const [key, attempts] of byItem.entries()) {
    const [domain, questionId] = key.split('::') as [DomainId, string];
    const topic = attempts[0].topic;
    const topicKey = `${domain}::${topic}`;
    const topicAttempts = byTopic.get(topicKey) ?? [];

    const correctCount = attempts.reduce((acc, a) => acc + (a.correct ? 1 : 0), 0);
    const accuracy = attempts.length === 0 ? 0 : correctCount / attempts.length;
    const empiricalDifficulty = 1 - accuracy;
    // Wald-style SE for a binomial proportion; clamp away from the boundary.
    const p = Math.min(0.999, Math.max(0.001, accuracy));
    const reliabilitySE = Math.sqrt((p * (1 - p)) / Math.max(1, attempts.length));

    const avgConfidence =
      attempts.reduce((acc, a) => acc + confidenceScalar(a.confidence), 0) /
      Math.max(1, attempts.length);

    // Build the two parallel arrays for the point-biserial correlation:
    //   xs = 1 if this attempt was correct, else 0
    //   ys = mastery on OTHER items in the same topic at that point in time
    const xs: number[] = [];
    const ys: number[] = [];
    let meanTopicAccuracyAtAttempt = 0;
    for (const attempt of attempts) {
      const otherTopicAttempts = topicAttempts.filter(
        (a) => a.questionId !== questionId && a.at <= attempt.at,
      );
      if (otherTopicAttempts.length === 0) continue;
      const otherCorrect = otherTopicAttempts.reduce((acc, a) => acc + (a.correct ? 1 : 0), 0);
      const topicAccuracy = otherCorrect / otherTopicAttempts.length;
      xs.push(attempt.correct ? 1 : 0);
      ys.push(topicAccuracy);
      meanTopicAccuracyAtAttempt += topicAccuracy;
    }
    meanTopicAccuracyAtAttempt = xs.length === 0 ? 0 : meanTopicAccuracyAtAttempt / xs.length;
    const discrimination = pearson(xs, ys);

    let flag: ItemFlag;
    if (attempts.length < MIN_ATTEMPTS) {
      flag = 'insufficient-data';
    } else if (accuracy >= TOO_EASY_THRESHOLD) {
      flag = 'too-easy';
    } else if (accuracy <= TOO_HARD_THRESHOLD) {
      flag = 'too-hard';
    } else if (discrimination < LOW_DISCRIMINATION_THRESHOLD) {
      flag = 'low-discrimination';
    } else {
      flag = 'ok';
    }

    items.push({
      questionId,
      domain,
      topic,
      attempts: attempts.length,
      correctCount,
      accuracy,
      empiricalDifficulty,
      discrimination,
      reliabilitySE,
      avgConfidence,
      flag,
      meanTopicAccuracyAtAttempt,
    });
  }

  // Sort by flag importance, then by attempts descending.
  const flagOrder: Record<ItemFlag, number> = {
    'too-hard': 0,
    'too-easy': 1,
    'low-discrimination': 2,
    'ok': 3,
    'insufficient-data': 4,
  };
  items.sort((a, b) => {
    if (flagOrder[a.flag] !== flagOrder[b.flag]) return flagOrder[a.flag] - flagOrder[b.flag];
    return b.attempts - a.attempts;
  });

  const itemsByFlag: Record<ItemFlag, number> = {
    ok: 0,
    'too-easy': 0,
    'too-hard': 0,
    'low-discrimination': 0,
    'insufficient-data': 0,
  };
  for (const item of items) {
    itemsByFlag[item.flag] += 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    totalAttempts: timed.length,
    totalItems: items.length,
    itemsByFlag,
    items,
  };
}

/** Persist the report to storage for reuse without recomputation. */
export async function persistPsychometricsReport(report: PsychometricsReport): Promise<void> {
  await getStorage().settings.put({
    key: PSYCHOMETRICS_CACHE_KEY,
    value: report,
    updatedAt: report.generatedAt,
  });
}

/** Read a previously persisted report, or null if none is cached. */
export async function readCachedPsychometricsReport(): Promise<PsychometricsReport | null> {
  try {
    const row = await getStorage().settings.get(PSYCHOMETRICS_CACHE_KEY);
    if (!row?.value) return null;
    return row.value as PsychometricsReport;
  } catch {
    return null;
  }
}

/** Clear the cached report. */
export async function clearPsychometricsCache(): Promise<void> {
  try {
    await getStorage().settings.delete(PSYCHOMETRICS_CACHE_KEY);
  } catch {
    /* swallow */
  }
}
