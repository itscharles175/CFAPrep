/**
 * PSY-13 — ONE global, cross-domain due-review ranking model.
 *
 * The Review Inbox previously surfaced two SEPARATE queues: the host's local
 * Dexie review items first, then the LSAT sidecar's already-ranked due cards
 * appended after. That host-first concatenation means a freshly-due host card
 * outranks a badly-overdue LSAT leech purely because of its plane — the user's
 * scarce review minutes don't go to the highest-value card.
 *
 * This module replaces that with a SINGLE pure ranker over BOTH planes. It
 * accepts the existing data sources unchanged (host `ReviewQueueItem`s + the
 * LSAT bridge's `UnifiedReviewItem`s / canonical `CrossDomainReviewCard`s) and
 * emits one interleaved, ranked list using a domain-agnostic utility:
 *
 *     score = overdueComponent  +  abilityWeightedUtility  +  leechBoost
 *
 *   - overdueComponent     — how far past `dueAt` the card is (saturating), the
 *                            dominant term. A card with no `dueAt` is treated as
 *                            "due now" (overdue = 0) so it still ranks, just below
 *                            anything genuinely overdue.
 *   - abilityWeightedUtility — when a Wave-5 ability snapshot is available for the
 *                            card's plane, weight by the EXPECTED LEARNING GAIN:
 *                            an item near the user's ability frontier (difficulty
 *                            ≈ ability, high uncertainty) is worth more than one
 *                            far below (already mastered) or far above (will fail).
 *                            With NO ability data this term is 0 and the ranker
 *                            DEGRADES TO OVERDUE-ONLY — the documented fallback.
 *   - leechBoost           — a small fixed nudge for cards flagged as leeches
 *                            (LEARN-5), so chronic lapses surface sooner.
 *
 * PURE + OFFLINE + DETERMINISTIC: no I/O, no clock except the injectable `now`,
 * no network. The ability snapshots are PASSED IN by the caller (which already
 * reads them via psychometrics/abilitySnapshots or the LEARN-1 ability shape),
 * so this module neither imports the psychometrics layer nor touches storage.
 * Ties break stably (most-overdue → leech → plane order → id) so the same inputs
 * always yield the same order.
 */

import type { CrossDomainPlane, CrossDomainReviewCard } from './dataDictionary';
import type { Difficulty } from './learningTypes';

/** Seconds in a day — overdue saturation is expressed in days. */
const DAY_SECONDS = 24 * 60 * 60;

/**
 * A plane-agnostic ability reading consumed by the ranker. Deliberately a
 * STRUCTURAL SUBSET of the Wave-5 shapes (`PerDomainAbilitySnapshot` from
 * learningTypes / `AbilitySnapshot` from psychometrics/abilitySnapshots) so a
 * caller can pass either without an adapter:
 *   - `PerDomainAbilitySnapshot` has `{ theta, uncertainty }` ✓
 *   - `AbilitySnapshot`          has `{ theta, uncertainty }` ✓
 * Only these two fields are read; everything else on those richer shapes is
 * ignored. `theta` is on the logit ability scale (centred ~0); `uncertainty` is
 * the posterior SD (EAP standard error).
 */
export interface RankAbility {
  /** Ability estimate on the logit scale (centred ~0). */
  theta: number;
  /** Posterior SD / standard error — higher ⇒ more to learn from new evidence. */
  uncertainty: number;
}

/** Per-plane ability snapshots keyed by plane. Any subset is fine (degrades). */
export type AbilityByPlane = Partial<Record<CrossDomainPlane, RankAbility>>;

/**
 * The normalized, domain-agnostic card the ranker operates on. Both planes map
 * onto this via the adapters below, so the ranking logic never branches on the
 * source plane.
 */
export interface RankableCard {
  /** Stable identity within the merged queue (namespaced where available). */
  id: string;
  plane: CrossDomainPlane;
  title: string;
  /** ISO 8601 due timestamp; absent ⇒ treated as due-now (overdue 0). */
  dueAt?: string;
  /** Bucketed difficulty (host 3-bucket enum); used for ability weighting. */
  difficulty: Difficulty;
  /** LSAT observed-accuracy re-estimate in [0,1] when present (sharper than the bucket). */
  empiricalDifficulty?: number;
  /** Flagged as a leech (chronic lapses, LEARN-5) — small ranking boost. */
  leech?: boolean;
  /** Where to send the user to actually do this review. */
  path?: string;
  /** Free-text item kind (host topic / LSAT q_type) — carried for display. */
  itemType?: string;
  /** Opaque back-reference to the original source row (host item / LSAT item). */
  source?: unknown;
}

/** A ranked card with its computed score + the component breakdown (for audit/UI). */
export interface RankedCard extends RankableCard {
  score: number;
  /** Days past due (saturated, ≥ 0). */
  overdueDays: number;
  /** The three score components, exposed so a UI can explain the order. */
  components: {
    overdue: number;
    abilityUtility: number;
    leech: number;
  };
}

export interface RankDueQueueOptions {
  /** Per-plane ability snapshots; omit a plane (or all) to degrade gracefully. */
  ability?: AbilityByPlane;
  /** Evaluation time. Defaults to now; tests pin it. */
  now?: Date;
  /** Cap the returned list. Omitted ⇒ all cards. */
  limit?: number;
}

/** Map the host 3-bucket {@link Difficulty} onto the logit `b` (theta) scale. */
function difficultyToTheta(difficulty: Difficulty): number {
  switch (difficulty) {
    case 'foundation':
      return -1;
    case 'advanced':
      return 1;
    case 'intermediate':
    default:
      return 0;
  }
}

/**
 * Card difficulty on the theta scale. Prefer the sharper `empiricalDifficulty`
 * (an observed accuracy in [0,1]: lower accuracy ⇒ harder ⇒ higher b) when the
 * plane provides it; otherwise fall back to the bucketed difficulty. The
 * accuracy→logit map uses the standard logit, clamped to keep extremes finite.
 */
function cardDifficultyTheta(card: RankableCard): number {
  const emp = card.empiricalDifficulty;
  if (typeof emp === 'number' && Number.isFinite(emp)) {
    const p = Math.min(0.98, Math.max(0.02, emp));
    // accuracy p ⇒ b = ln((1-p)/p): p=0.5→0, easier (p→1)→ negative, harder→positive
    return Math.log((1 - p) / p);
  }
  return difficultyToTheta(card.difficulty);
}

/**
 * Overdue component: days past due, saturating so a card that is months overdue
 * doesn't crowd out everything else forever. `dueAt` absent ⇒ due-now ⇒ 0.
 * Negative (not-yet-due) is clamped to 0 — a not-yet-due card can still appear
 * if the caller passes it, but it carries no overdue urgency.
 */
function overdueDays(card: RankableCard, now: Date): number {
  if (!card.dueAt) return 0;
  const due = Date.parse(card.dueAt);
  if (!Number.isFinite(due)) return 0;
  const seconds = (now.getTime() - due) / 1000;
  if (seconds <= 0) return 0;
  return seconds / DAY_SECONDS;
}

/** Saturating transform on overdue days — diminishing returns past ~30 days. */
function overdueScore(days: number): number {
  // 1 - e^(-days/14): ~0.5 at 10d, ~0.88 at 30d, asymptotes to 1. Scaled ×100 so
  // the overdue term dominates the [0, ~30] ability term across realistic ranges.
  return (1 - Math.exp(-days / 14)) * 100;
}

/**
 * Ability-weighted utility: expected learning gain from reviewing this card now.
 * Peaks when the card's difficulty sits at the user's ability frontier (b ≈ θ)
 * and scales with posterior uncertainty (more to learn when less certain). With
 * no ability snapshot for the plane this returns 0 — the overdue-only fallback.
 *
 * gain = uncertaintyWeight · informationPeak(θ − b)
 *   informationPeak — a bell centred at 0 (b = θ): items at the frontier are most
 *                     informative; far-easier / far-harder items teach little.
 *   uncertaintyWeight — grows with SD, saturating, so a brand-new (very uncertain)
 *                       plane prioritises evidence-gathering reviews.
 */
function abilityUtility(card: RankableCard, ability: RankAbility | undefined): number {
  if (!ability || !Number.isFinite(ability.theta)) return 0;
  const b = cardDifficultyTheta(card);
  const delta = ability.theta - b;
  // Bell curve (Gaussian, σ≈1.2 on the logit scale) peaking at the frontier.
  const informationPeak = Math.exp(-(delta * delta) / (2 * 1.2 * 1.2));
  const sd = Number.isFinite(ability.uncertainty) ? Math.max(0, ability.uncertainty) : 0;
  // Saturating uncertainty weight in [0,1): 0 SD ⇒ 0, ~0.5 SD ⇒ 0.5, large ⇒ ~1.
  const uncertaintyWeight = sd / (sd + 0.5);
  // Scale ×30 so a frontier card with high uncertainty adds meaningful lift but
  // never out-weighs a genuinely overdue card (overdue term reaches ~100).
  return informationPeak * uncertaintyWeight * 30;
}

/** Fixed boost for leech cards (LEARN-5) so chronic lapses surface sooner. */
const LEECH_BOOST = 12;

/** Deterministic plane ordering for stable tie-breaks. */
const PLANE_ORDER: CrossDomainPlane[] = ['cfa', 'quant', 'excel', 'lsat'];
function planeRank(plane: CrossDomainPlane): number {
  const i = PLANE_ORDER.indexOf(plane);
  return i === -1 ? PLANE_ORDER.length : i;
}

/**
 * Rank a merged set of due cards across all planes with one model. PURE: same
 * inputs ⇒ same output. The result is sorted by descending score; ties break
 * stably (more overdue → leech → plane order → id) so the order is deterministic.
 */
export function rankDueQueue(
  cards: RankableCard[],
  options: RankDueQueueOptions = {},
): RankedCard[] {
  const now = options.now ?? new Date();
  const ability = options.ability ?? {};

  const ranked: RankedCard[] = cards.map((card) => {
    const days = overdueDays(card, now);
    const overdue = overdueScore(days);
    const abilityComp = abilityUtility(card, ability[card.plane]);
    const leech = card.leech ? LEECH_BOOST : 0;
    return {
      ...card,
      overdueDays: days,
      score: overdue + abilityComp + leech,
      components: { overdue, abilityUtility: abilityComp, leech },
    };
  });

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.overdueDays !== a.overdueDays) return b.overdueDays - a.overdueDays;
    const aLeech = a.leech ? 1 : 0;
    const bLeech = b.leech ? 1 : 0;
    if (bLeech !== aLeech) return bLeech - aLeech;
    const planeDelta = planeRank(a.plane) - planeRank(b.plane);
    if (planeDelta !== 0) return planeDelta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return typeof options.limit === 'number' ? ranked.slice(0, Math.max(0, options.limit)) : ranked;
}

// ---------------------------------------------------------------------------
// Adapters — map the existing data sources onto RankableCard WITHOUT changing
// them. The ranker stays plane-agnostic; these own the per-source projection.
// ---------------------------------------------------------------------------

/** The host `ReviewQueueItem` fields the adapter reads (structural subset). */
export interface HostReviewQueueRow {
  id: string;
  title: string;
  path: string;
  dueAt?: string;
  topic?: string;
  /** Host queue 'type' (due-review, weak-objective, …) — carried as itemType. */
  type?: string;
  /** Host domain when known; defaults to 'cfa' (the primary host plane). */
  domain?: CrossDomainPlane;
  leech?: boolean;
}

/**
 * Map a host Review-Inbox row onto a {@link RankableCard}. The host has no
 * first-class difficulty on the queue row (it's implied by the objective), so we
 * expose the neutral middle — same convention `reviewItemToCanonical` uses. The
 * id is namespaced so it can't collide with an LSAT id in the merged queue.
 */
export function hostRowToRankable(row: HostReviewQueueRow): RankableCard {
  const plane: CrossDomainPlane = row.domain ?? 'cfa';
  return {
    id: `${plane}:host:${row.id}`,
    plane,
    title: row.title,
    dueAt: row.dueAt,
    difficulty: 'intermediate',
    leech: row.leech,
    path: row.path,
    itemType: row.topic ?? row.type,
    source: row,
  };
}

/**
 * Map a canonical {@link CrossDomainReviewCard} (the shape the LSAT bridge's
 * `UnifiedReviewItem.canonical` carries, and the same shape the host cross-domain
 * bridge emits) onto a {@link RankableCard}. Carries the LSAT empirical
 * difficulty + leech flag through so the ranker can use the sharper signal.
 */
export function canonicalToRankable(
  card: CrossDomainReviewCard,
  opts: { path?: string } = {},
): RankableCard {
  return {
    id: card.crossId,
    plane: card.domain,
    title: card.title,
    dueAt: card.dueAt,
    difficulty: card.difficulty,
    empiricalDifficulty: card.empiricalDifficulty,
    leech: card.leech,
    path: opts.path,
    itemType: card.itemType,
    source: card,
  };
}

/**
 * Convenience: build ONE ranked queue from the two real data sources the Review
 * Inbox already has in hand — the host queue rows and the LSAT bridge's canonical
 * cards — with one ranking pass. This is the PSY-13 entry point the inbox calls;
 * it just adapts + delegates to {@link rankDueQueue}, so it inherits the pure /
 * degrading behaviour (no ability ⇒ overdue-only).
 */
export function buildUnifiedDueQueue(
  input: {
    hostRows?: HostReviewQueueRow[];
    lsatCards?: Array<{ canonical: CrossDomainReviewCard; deepLinkPath?: string }>;
  },
  options: RankDueQueueOptions = {},
): RankedCard[] {
  const hostCards = (input.hostRows ?? []).map(hostRowToRankable);
  const lsatCards = (input.lsatCards ?? []).map((it) =>
    canonicalToRankable(it.canonical, { path: it.deepLinkPath }),
  );
  return rankDueQueue([...hostCards, ...lsatCards], options);
}
