/**
 * PSY-1 — Computerized Adaptive Testing (CAT) over a calibrated item pool.
 *
 * StudyVault is single-user, so we cannot run full multi-examinee IRT calibration
 * at runtime. Instead we treat the per-item empirical statistics produced by
 * {@link computePsychometrics} (itemPsychometrics.ts) as a *pre-calibrated* 2PL
 * item bank and run a textbook adaptive loop against it:
 *
 *   - 2-parameter logistic (2PL) item response model:
 *       P(correct | theta) = c + (1 - c) / (1 + exp(-a * (theta - b)))
 *     with guessing `c` defaulting to 0 (pure 2PL); a 3PL `c` is supported when a
 *     pool carries it.
 *   - Item selection by MAXIMUM FISHER INFORMATION at the current theta estimate
 *     (the standard CAT selection rule) — pick the un-administered item that most
 *     reduces the standard error of the ability estimate.
 *   - EAP (Expected A Posteriori) theta re-estimation after every response over a
 *     fixed quadrature grid with a N(0,1) prior. EAP is bounded and never diverges
 *     on an all-correct / all-incorrect run (unlike MLE), which matters for short
 *     single-user sessions.
 *   - A standard-error STOP RULE: stop when the posterior SD (the EAP standard
 *     error) drops below a target, or when the pool / max-items budget is spent.
 *
 * Everything here is PURE and synchronous — no storage, no network, no Date.now()
 * in the hot path. Deterministic given the same pool + response sequence, so it is
 * trivially unit-testable and safe to run fully offline.
 *
 * Mapping from the empirical bank to 2PL params (see {@link itemToCatParams}):
 *   - b (difficulty)      = logit(empiricalDifficulty) clamped to [-4, 4]; an item
 *                           the user gets right 50% of the time sits at b≈0.
 *   - a (discrimination)  = point-biserial discrimination rescaled to a sane 2PL
 *                           slope, floored so a near-zero discriminator still
 *                           carries a little information.
 */

export interface CatItemParams {
  /** Stable item identifier (questionId). */
  id: string;
  /** Discrimination (2PL `a`). Higher = steeper ICC = more informative near b. */
  a: number;
  /** Difficulty (2PL `b`) on the theta scale. */
  b: number;
  /** Guessing/lower-asymptote (3PL `c`). Defaults to 0 (pure 2PL). */
  c?: number;
  /** Optional passthrough metadata (topic/domain) for the caller's bookkeeping. */
  topic?: string;
  domain?: string;
}

export interface CatResponse {
  /** Item that was administered. */
  id: string;
  /** Whether the user answered correctly. */
  correct: boolean;
}

export interface CatConfig {
  /** Posterior-SD target; the session stops once SE ≤ this. Default 0.30. */
  seTarget?: number;
  /** Hard cap on administered items regardless of SE. Default 30. */
  maxItems?: number;
  /** Minimum items before the SE stop rule can fire. Default 1. */
  minItems?: number;
  /** Quadrature grid bound (theta in [-gridBound, +gridBound]). Default 4. */
  gridBound?: number;
  /** Number of quadrature points across the grid. Default 61. */
  gridPoints?: number;
  /** Prior mean for the N(priorMean, priorSd) ability prior. Default 0. */
  priorMean?: number;
  /** Prior SD for the ability prior. Default 1. */
  priorSd?: number;
}

export interface CatEstimate {
  /** EAP ability estimate (posterior mean). */
  theta: number;
  /** Posterior standard deviation — the EAP standard error. */
  se: number;
  /** Number of responses folded into this estimate. */
  responses: number;
}

export interface CatSelection {
  /** The selected next item, or null when the pool is exhausted / all done. */
  item: CatItemParams | null;
  /** Fisher information of the selected item at the current theta (0 when none). */
  information: number;
  /** The current ability estimate selection was computed against. */
  estimate: CatEstimate;
  /** True when the stop rule says the session should end (SE target met / budget). */
  done: boolean;
}

const DEFAULTS: Required<CatConfig> = {
  seTarget: 0.3,
  maxItems: 30,
  minItems: 1,
  gridBound: 4,
  gridPoints: 61,
  priorMean: 0,
  priorSd: 1,
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Logistic 2PL/3PL probability of a correct response at ability `theta`. */
export function probCorrect(item: CatItemParams, theta: number): number {
  const c = clamp(item.c ?? 0, 0, 0.5);
  const z = item.a * (theta - item.b);
  // Numerically stable logistic.
  const logistic = z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
  return c + (1 - c) * logistic;
}

/**
 * Fisher information of a 3PL item at `theta`. For pure 2PL (c=0) this reduces to
 * a^2 * P * (1 - P). Information is maximal where the item best discriminates the
 * examinee's ability, which is exactly what CAT selection wants to maximise.
 */
export function fisherInformation(item: CatItemParams, theta: number): number {
  const p = probCorrect(item, theta);
  if (p <= 0 || p >= 1) return 0;
  const c = clamp(item.c ?? 0, 0, 0.5);
  // 3PL information: a^2 * (Q/P) * ((P - c)/(1 - c))^2
  const q = 1 - p;
  const num = (p - c) / (1 - c);
  const info = item.a * item.a * (q / p) * num * num;
  return Number.isFinite(info) && info > 0 ? info : 0;
}

/** Build the quadrature grid + a (normalised) Gaussian prior over it. */
function buildGrid(cfg: Required<CatConfig>): { nodes: number[]; prior: number[] } {
  const { gridBound, gridPoints, priorMean, priorSd } = cfg;
  const nodes: number[] = [];
  const prior: number[] = [];
  const step = (2 * gridBound) / (gridPoints - 1);
  let sum = 0;
  for (let i = 0; i < gridPoints; i++) {
    const x = -gridBound + i * step;
    const d = (x - priorMean) / priorSd;
    const w = Math.exp(-0.5 * d * d); // unnormalised N(priorMean, priorSd)
    nodes.push(x);
    prior.push(w);
    sum += w;
  }
  // Normalise so the prior is a proper discrete distribution.
  for (let i = 0; i < prior.length; i++) prior[i] /= sum;
  return { nodes, prior };
}

/**
 * EAP ability estimate over the quadrature grid given a response history.
 *
 * Posterior(theta) ∝ prior(theta) * Π_responses likelihood(response | theta).
 * Returns the posterior mean (theta) and SD (se). With zero responses this is
 * exactly the prior, so theta = priorMean and se = priorSd.
 */
export function estimateAbilityEAP(
  pool: CatItemParams[],
  responses: CatResponse[],
  config: CatConfig = {},
): CatEstimate {
  const cfg = { ...DEFAULTS, ...config };
  const { nodes, prior } = buildGrid(cfg);
  const byId = new Map(pool.map((it) => [it.id, it]));

  // Work in log-space for the likelihood to avoid underflow on long sessions.
  const logPost = prior.map((w) => (w > 0 ? Math.log(w) : -Infinity));
  for (const resp of responses) {
    const item = byId.get(resp.id);
    if (!item) continue;
    for (let i = 0; i < nodes.length; i++) {
      const p = probCorrect(item, nodes[i]);
      const like = resp.correct ? p : 1 - p;
      logPost[i] += Math.log(clamp(like, 1e-12, 1));
    }
  }

  // Exponentiate with a max-shift for stability, then normalise.
  const maxLog = Math.max(...logPost.filter((v) => Number.isFinite(v)));
  let total = 0;
  const post = logPost.map((v) => {
    const p = Number.isFinite(v) ? Math.exp(v - maxLog) : 0;
    total += p;
    return p;
  });
  if (total <= 0) {
    // Degenerate (shouldn't happen with a proper prior) — fall back to the prior.
    return { theta: cfg.priorMean, se: cfg.priorSd, responses: responses.length };
  }

  let mean = 0;
  for (let i = 0; i < nodes.length; i++) mean += nodes[i] * (post[i] / total);
  let varAcc = 0;
  for (let i = 0; i < nodes.length; i++) {
    const d = nodes[i] - mean;
    varAcc += d * d * (post[i] / total);
  }
  return {
    theta: mean,
    se: Math.sqrt(Math.max(0, varAcc)),
    responses: responses.length,
  };
}

/**
 * Select the next CAT item by maximum Fisher information at the current EAP theta,
 * excluding already-administered items, and report whether the stop rule has fired.
 *
 * Stop rule: done when (responses ≥ minItems AND se ≤ seTarget) OR responses ≥
 * maxItems OR no un-administered items remain.
 */
export function selectNextItem(
  pool: CatItemParams[],
  responses: CatResponse[],
  config: CatConfig = {},
): CatSelection {
  const cfg = { ...DEFAULTS, ...config };
  const estimate = estimateAbilityEAP(pool, responses, cfg);

  const administered = new Set(responses.map((r) => r.id));
  const remaining = pool.filter((it) => !administered.has(it.id));

  const seStop = responses.length >= cfg.minItems && estimate.se <= cfg.seTarget;
  const budgetStop = responses.length >= cfg.maxItems;
  const poolStop = remaining.length === 0;
  const done = poolStop || seStop || budgetStop;

  if (done) {
    return { item: null, information: 0, estimate, done: true };
  }

  // Argmax Fisher information; ties broken by the higher `a`, then lex/id for
  // determinism so the same pool + history always yields the same next item.
  let best: CatItemParams | null = null;
  let bestInfo = -Infinity;
  for (const it of remaining) {
    const info = fisherInformation(it, estimate.theta);
    if (
      info > bestInfo ||
      (info === bestInfo && best != null && (it.a > best.a || (it.a === best.a && it.id < best.id)))
    ) {
      best = it;
      bestInfo = info;
    }
  }

  return {
    item: best,
    information: best ? Math.max(0, bestInfo) : 0,
    estimate,
    done: false,
  };
}

/**
 * Map an empirical item-stats row (itemPsychometrics.ts) into 2PL CAT params.
 *
 * - b: place the item on the theta scale from its empirical difficulty. We use a
 *   logit of `empiricalDifficulty` (= 1 - accuracy) so a 50/50 item sits at b≈0,
 *   a rarely-missed easy item at strongly-negative b, and a usually-missed hard
 *   item at strongly-positive b. Clamped to [-4, 4] to stay on the grid.
 * - a: rescale the point-biserial discrimination into a usable 2PL slope. Empirical
 *   point-biserials are typically ~0.1–0.5; we map them onto ~[0.3, 2.5] and floor
 *   at a small positive slope so an undiscriminating item still carries a little
 *   information rather than zero.
 */
export function itemToCatParams(stats: {
  questionId: string;
  empiricalDifficulty: number;
  discrimination: number;
  topic?: string;
  domain?: string;
}): CatItemParams {
  const p = clamp(stats.empiricalDifficulty, 0.02, 0.98);
  const b = clamp(Math.log(p / (1 - p)), -4, 4);
  // Discrimination → slope: scale up, floor, cap. abs() so a (rare) negative
  // point-biserial still contributes magnitude rather than zero/negative slope.
  const a = clamp(Math.abs(stats.discrimination) * 4 + 0.3, 0.3, 2.5);
  return {
    id: stats.questionId,
    a,
    b,
    c: 0,
    topic: stats.topic,
    domain: stats.domain,
  };
}

/**
 * Run a full CAT session OFFLINE against a fixed responder function (e.g. a 2PL
 * simulator, or a deterministic answer key). Returns the administered items in
 * order plus the final estimate. Pure: the responder is the only source of
 * "answers", so a test can drive it with a known true theta and assert recovery.
 */
export function runCatSession(
  pool: CatItemParams[],
  respond: (item: CatItemParams) => boolean,
  config: CatConfig = {},
): { responses: CatResponse[]; estimate: CatEstimate; administered: CatItemParams[] } {
  const cfg = { ...DEFAULTS, ...config };
  const responses: CatResponse[] = [];
  const administered: CatItemParams[] = [];

  for (let i = 0; i < cfg.maxItems; i++) {
    const sel = selectNextItem(pool, responses, cfg);
    if (sel.done || !sel.item) break;
    const correct = respond(sel.item);
    responses.push({ id: sel.item.id, correct });
    administered.push(sel.item);
  }

  return { responses, estimate: estimateAbilityEAP(pool, responses, cfg), administered };
}
