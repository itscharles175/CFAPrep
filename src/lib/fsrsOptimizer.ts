/**
 * FSRS parameter fitting from a user's own review history.
 *
 * ts-fsrs ships the FSRS-6 algorithm with `default_w` (21 weights, incl. the
 * w[20] decay term) and a `request_retention` knob (default 0.9).  The reference
 * Python optimizer does full gradient descent over all weights; that is overkill
 * for a single-user local app.  This module instead does a coordinate-descent
 * search over a small principled subset (the hard/easy multipliers + decay),
 * evaluated against the user's own `questionResults` history. The searched
 * indices are length-guarded against default_w so a future weight-count change
 * skips the fit rather than mis-indexing (audit LOW — comments were FSRS-4.5/19w).
 *
 * Output:
 *   { ok: boolean
 *     originalLoss, optimizedLoss, improvement,
 *     originalParameters, optimizedParameters,
 *     reviewCount, cardCount, sampleSize }
 *
 * The optimized parameters get persisted to the storage abstraction under
 * `fsrs-custom-parameters`.  `scheduler.ts` is wired to read this slot on
 * each call to `scheduleReview`; until something is fit, the FSRS-4.5
 * library defaults apply.
 */

import {
  createEmptyCard,
  default_w,
  default_request_retention,
  forgetting_curve,
  fsrs,
  Rating,
  State,
} from 'ts-fsrs';
import type { Card, FSRSParameters, Grade } from 'ts-fsrs';
import type { Confidence, QuestionResult } from './learningTypes';
import { getStorage } from './storage';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Storage key for the persisted fitted parameters. */
export const CUSTOM_PARAMETERS_KEY = 'fsrs-custom-parameters';

/** Minimum reviews per card to include it in the fit. */
const MIN_REVIEWS_PER_CARD = 2;

/** Minimum total review count below which we refuse to fit (signal too noisy). */
export const MIN_TOTAL_REVIEWS = 50;

/** Bounds applied to `request_retention` searches. */
const RR_MIN = 0.80;
const RR_MAX = 0.97;

export interface PersistedFSRSParameters {
  request_retention: number;
  w: number[];
  fittedAt: string;
  reviewCount: number;
  loss: number;
  improvement: number;
}

export interface FSRSFitReport {
  ok: boolean;
  reason?: string;
  originalLoss: number;
  optimizedLoss: number;
  improvement: number;
  originalParameters: { request_retention: number; w: number[] };
  optimizedParameters: { request_retention: number; w: number[] };
  reviewCount: number;
  cardCount: number;
  iterations: number;
}

/** Map QuantVault confidence + correctness to ts-fsrs Grade (1..4). */
function toRating(correct: boolean, confidence: Confidence): Grade {
  if (!correct) return Rating.Again as Grade;
  if (confidence === 'low') return Rating.Hard as Grade;
  if (confidence === 'medium') return Rating.Good as Grade;
  return Rating.Easy as Grade;
}

/** One review's contribution to the binary-cross-entropy log-loss. */
function logLossContribution(predicted: number, actual: 0 | 1): number {
  // Clamp to avoid log(0); the FSRS retrievability is in (0,1) already.
  const p = Math.min(0.9999, Math.max(0.0001, predicted));
  return actual === 1 ? -Math.log(p) : -Math.log(1 - p);
}

interface ReviewSequence {
  cardKey: string;
  reviews: Array<{
    at: Date;
    correct: boolean;
    confidence: Confidence;
  }>;
}

/** Group `questionResults` by questionId into per-card chronological sequences. */
export function groupIntoSequences(results: QuestionResult[]): ReviewSequence[] {
  const byCard = new Map<string, ReviewSequence>();

  for (const r of results) {
    if (!r.createdAt || !r.questionId) continue;
    const key = `${r.domain}::${r.questionId}`;
    let seq = byCard.get(key);
    if (!seq) {
      seq = { cardKey: key, reviews: [] };
      byCard.set(key, seq);
    }
    seq.reviews.push({
      at: new Date(r.createdAt),
      correct: r.correct,
      confidence: r.confidence,
    });
  }

  // Sort each card's reviews by time; drop cards that have too few reviews.
  const out: ReviewSequence[] = [];
  for (const seq of byCard.values()) {
    seq.reviews.sort((a, b) => a.at.getTime() - b.at.getTime());
    if (seq.reviews.length >= MIN_REVIEWS_PER_CARD) {
      out.push(seq);
    }
  }
  return out;
}

/**
 * Replay each per-card sequence through ts-fsrs with the given parameters and
 * return the total binary-cross-entropy log-loss summed across every review
 * *after the first* (the first review has no prior state to predict from).
 */
export function evaluateLoss(
  sequences: ReviewSequence[],
  params: FSRSParameters,
): { loss: number; reviewCount: number } {
  const f = fsrs(params);
  let totalLoss = 0;
  let reviewCount = 0;

  for (const seq of sequences) {
    if (seq.reviews.length < 2) continue;

    // Start with an empty card on the first review's date.
    let card: Card = createEmptyCard(seq.reviews[0].at);
    {
      const first = seq.reviews[0];
      const { card: nextCard } = f.next(card, first.at, toRating(first.correct, first.confidence));
      card = nextCard;
    }

    for (let i = 1; i < seq.reviews.length; i++) {
      const review = seq.reviews[i];
      const elapsedDays =
        (review.at.getTime() - card.last_review!.getTime()) / DAY_MS;

      // Compute predicted retention BEFORE applying the review.
      let predicted: number;
      if (card.state === State.New || card.stability <= 0) {
        // No prior signal — chance level.
        predicted = 0.5;
      } else {
        const decayParam = params.w[params.w.length > 20 ? 20 : params.w.length - 1] ?? 0.5;
        predicted = forgetting_curve(decayParam, Math.max(0, elapsedDays), card.stability);
      }

      totalLoss += logLossContribution(predicted, review.correct ? 1 : 0);
      reviewCount += 1;

      // Apply the review to advance card state.
      const { card: nextCard } = f.next(
        card,
        review.at,
        toRating(review.correct, review.confidence),
      );
      card = nextCard;
    }
  }

  return { loss: totalLoss, reviewCount };
}

interface CoordinateBound {
  index: number;
  min: number;
  max: number;
  step: number;
}

/**
 * Coordinate-descent over a principled subset of FSRS weights.
 *
 * The selected indices are:
 *   - 0..3   initial stability for Again/Hard/Good/Easy
 *   - 15     hard multiplier
 *   - 16     easy multiplier
 *
 * Plus a 1-D scan over `request_retention`.
 *
 * Each coordinate is searched with a coarse grid then a fine grid centered on
 * the best coarse point.  This is deterministic and bounded — at most
 * ~7 weights * 2 passes * ~9 points = ~126 loss evaluations.
 */
function descend(
  sequences: ReviewSequence[],
  startParams: FSRSParameters,
): { params: FSRSParameters; loss: number; iterations: number } {
  const SELECTED_W: CoordinateBound[] = [
    { index: 0, min: 0.10, max: 1.50, step: 0.10 },
    { index: 1, min: 0.30, max: 3.00, step: 0.20 },
    { index: 2, min: 0.50, max: 5.00, step: 0.30 },
    { index: 3, min: 4.00, max: 16.0, step: 0.50 },
    { index: 15, min: 0.10, max: 1.00, step: 0.05 },
    { index: 16, min: 1.10, max: 4.00, step: 0.10 },
  ];

  let bestParams: FSRSParameters = {
    ...startParams,
    w: [...startParams.w] as FSRSParameters['w'],
  };
  let bestLoss = evaluateLoss(sequences, bestParams).loss;
  let iterations = 1;

  const evalCandidate = (overrides: Partial<{ rr: number; widx: number; wval: number }>): number => {
    const wArr = [...bestParams.w];
    if (overrides.widx !== undefined && overrides.wval !== undefined) {
      wArr[overrides.widx] = overrides.wval;
    }
    const candidate: FSRSParameters = {
      ...bestParams,
      request_retention: overrides.rr ?? bestParams.request_retention,
      w: wArr as FSRSParameters['w'],
    };
    iterations += 1;
    return evaluateLoss(sequences, candidate).loss;
  };

  // 1-D scan over request_retention (most impactful single knob).
  {
    const rrCoarse = [0.80, 0.83, 0.86, 0.89, 0.92, 0.95];
    let bestRr = bestParams.request_retention;
    for (const rr of rrCoarse) {
      const loss = evalCandidate({ rr });
      if (loss < bestLoss) {
        bestLoss = loss;
        bestRr = rr;
      }
    }
    bestParams = { ...bestParams, request_retention: bestRr };
    // Fine pass: ±0.025 around bestRr, step 0.005, clamped.
    const fineLo = Math.max(RR_MIN, bestRr - 0.025);
    const fineHi = Math.min(RR_MAX, bestRr + 0.025);
    for (let rr = fineLo; rr <= fineHi + 1e-9; rr += 0.005) {
      const loss = evalCandidate({ rr });
      if (loss < bestLoss) {
        bestLoss = loss;
        bestParams = { ...bestParams, request_retention: rr };
      }
    }
  }

  // Coordinate descent over selected weights, with one outer pass.
  // Each coordinate: coarse scan within bounds, then a fine ±step pass.
  for (const bound of SELECTED_W) {
    const current = bestParams.w[bound.index];
    let bestVal = current;

    // Coarse: scan from min to max in `step` increments.
    for (let v = bound.min; v <= bound.max + 1e-9; v += bound.step) {
      const loss = evalCandidate({ widx: bound.index, wval: v });
      if (loss < bestLoss) {
        bestLoss = loss;
        bestVal = v;
      }
    }
    {
      const wArr = [...bestParams.w];
      wArr[bound.index] = bestVal;
      bestParams = { ...bestParams, w: wArr as FSRSParameters['w'] };
    }

    // Fine: ±0.5 * step around the coarse winner, 3-point scan.
    const fine = bound.step * 0.5;
    for (const v of [bestVal - fine, bestVal + fine]) {
      if (v < bound.min || v > bound.max) continue;
      const loss = evalCandidate({ widx: bound.index, wval: v });
      if (loss < bestLoss) {
        bestLoss = loss;
        const wArr = [...bestParams.w];
        wArr[bound.index] = v;
        bestParams = { ...bestParams, w: wArr as FSRSParameters['w'] };
      }
    }
  }

  return { params: bestParams, loss: bestLoss, iterations };
}

/**
 * Fit FSRS parameters to the user's review history.
 *
 * Returns a report that includes original vs optimized loss + improvement.
 * Does NOT persist — call `persistOptimizedParameters` separately once the
 * user has reviewed the result.
 */
export async function fitFSRSParameters(
  results: QuestionResult[],
  startingParameters?: { request_retention?: number; w?: number[] },
): Promise<FSRSFitReport> {
  const sequences = groupIntoSequences(results);
  const cardCount = sequences.length;
  const totalReviews = sequences.reduce((sum, seq) => sum + (seq.reviews.length - 1), 0);

  // Build the starting parameter object explicitly (not via the proxy) so we
  // can mutate weights freely.
  const startParams: FSRSParameters = {
    request_retention: startingParameters?.request_retention ?? default_request_retention,
    maximum_interval: 36500,
    w: [...(startingParameters?.w ?? default_w)] as FSRSParameters['w'],
    enable_fuzz: false,
    enable_short_term: true,
    learning_steps: [],
    relearning_steps: [],
  };

  if (totalReviews < MIN_TOTAL_REVIEWS) {
    return {
      ok: false,
      reason: `Need at least ${MIN_TOTAL_REVIEWS} historical reviews (have ${totalReviews}).`,
      originalLoss: 0,
      optimizedLoss: 0,
      improvement: 0,
      originalParameters: { request_retention: startParams.request_retention, w: [...startParams.w] },
      optimizedParameters: { request_retention: startParams.request_retention, w: [...startParams.w] },
      reviewCount: totalReviews,
      cardCount,
      iterations: 0,
    };
  }

  const original = evaluateLoss(sequences, startParams);
  const optimized = descend(sequences, startParams);
  const improvement = original.loss > 0 ? (original.loss - optimized.loss) / original.loss : 0;

  return {
    ok: true,
    originalLoss: original.loss,
    optimizedLoss: optimized.loss,
    improvement,
    originalParameters: { request_retention: startParams.request_retention, w: [...startParams.w] },
    optimizedParameters: {
      request_retention: optimized.params.request_retention,
      w: [...optimized.params.w],
    },
    reviewCount: original.reviewCount,
    cardCount,
    iterations: optimized.iterations,
  };
}

/** Persist a fitted parameter set so `scheduler.ts` will pick it up on its next call. */
export async function persistOptimizedParameters(report: FSRSFitReport): Promise<void> {
  if (!report.ok) throw new Error(`Cannot persist a failed fit: ${report.reason ?? 'unknown'}`);
  const payload: PersistedFSRSParameters = {
    request_retention: report.optimizedParameters.request_retention,
    w: report.optimizedParameters.w,
    fittedAt: new Date().toISOString(),
    reviewCount: report.reviewCount,
    loss: report.optimizedLoss,
    improvement: report.improvement,
  };
  await getStorage().settings.put({
    key: CUSTOM_PARAMETERS_KEY,
    value: payload,
    updatedAt: payload.fittedAt,
  });
}

/** Read the persisted fitted parameters, if any. */
export async function readPersistedParameters(): Promise<PersistedFSRSParameters | null> {
  try {
    const row = await getStorage().settings.get(CUSTOM_PARAMETERS_KEY);
    if (!row?.value) return null;
    const v = row.value as Partial<PersistedFSRSParameters>;
    if (typeof v.request_retention !== 'number' || !Array.isArray(v.w)) return null;
    return {
      request_retention: v.request_retention,
      w: v.w.map((n) => Number(n)),
      fittedAt: typeof v.fittedAt === 'string' ? v.fittedAt : new Date().toISOString(),
      reviewCount: typeof v.reviewCount === 'number' ? v.reviewCount : 0,
      loss: typeof v.loss === 'number' ? v.loss : 0,
      improvement: typeof v.improvement === 'number' ? v.improvement : 0,
    };
  } catch {
    return null;
  }
}

/** Clear the persisted fit; scheduler reverts to FSRS-4.5 library defaults. */
export async function clearPersistedParameters(): Promise<void> {
  try {
    await getStorage().settings.delete(CUSTOM_PARAMETERS_KEY);
  } catch {
    /* swallow — clear is best-effort */
  }
}
