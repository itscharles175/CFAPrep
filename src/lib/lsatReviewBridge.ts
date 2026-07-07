/**
 * Cross-domain review bridge (merge plan Phase 4.1).
 *
 * StudyVault unifies the *surface* of spaced-repetition across domains without
 * merging the engines: CFA/Quant/Excel reviews live in Dexie (client `ts-fsrs`,
 * via the StorageDriver `reviewItems` namespace); LSAT reviews live behind the
 * LSAT backend sidecar (server `fsrs`, `GET /api/srs/due`). The host can't
 * reach the LSAT React app (it's a separate top-level branch), but it CAN reach
 * the sidecar over HTTP — so the host Review Inbox fetches the LSAT due queue
 * directly and renders it alongside the local items, deep-linking into the LSAT
 * app for the actual review.
 *
 * Fully degrading: any failure (sidecar down, timeout, shape drift) returns
 * `{ ok: false, dueCount: 0, items: [] }` so the inbox simply omits the LSAT
 * section rather than erroring.
 *
 * DATA-1 (K1): the `/api/srs/due` endpoint is anchored to the generated OpenAPI
 * contract (`@/domains/lsat/lib/api.gen` — the same `api.gen.ts` the LSAT app
 * uses, regenerated from the committed `openapi-baseline.json`). The route still
 * returns the backend's permissive `LegacySuccessResponse` (an untyped legacy
 * shape — no narrow `response_model` yet), so the card payload is parsed
 * defensively below; but binding the path + operation to the contract means a
 * `/api/srs/due` rename or removal fails the host build via the drift gate
 * (`scripts/export-lsat-openapi.mjs`) and `tsc` rather than silently at runtime.
 */
import type { paths } from '@/domains/lsat/lib/api.gen';
import {
  lsatSrsCardToCanonical,
  type CrossDomainReviewCard,
  type RawLsatSrsCard,
} from './dataDictionary';
import { fetchLsatSidecarJson } from './lsatSidecarClient';

/** The contract path the bridge consumes — kept honest against `api.gen.ts`. */
const LSAT_DUE_PATH: keyof paths = '/api/srs/due';
// LEARN-2 — the unified, ability-ranked cross-domain due queue. NOT yet bound to
// `keyof paths`: the route ships ahead of the next `api.gen.ts` regeneration, so
// it's a string literal for now (same as the legacy `/api/srs/due` body fields).
// Swap to `keyof paths` once the contract is regenerated with this path.
const LSAT_UNIFIED_DUE_PATH = '/api/study/due-unified';
const LSAT_SRS_PATH = '/lsat/srs'; // deep-link target (host hard-navigates here)

/** A domain-agnostic "due review" row for the unified inbox. */
export interface UnifiedReviewItem {
  domain: 'lsat';
  id: string;
  title: string;
  /** Where to send the user to actually do this review (hard nav for LSAT). */
  deepLinkPath: string;
  qType?: string;
  /**
   * DATA-2 — the same row projected onto the canonical cross-domain shape
   * (`dataDictionary.ts`), so a unified consumer can rank/merge LSAT cards with
   * host cards using one vocabulary (bucketed difficulty, namespaced identity).
   * Additive: existing `UnifiedReviewItem` fields are unchanged.
   */
  canonical: CrossDomainReviewCard;
}

export interface LsatDueResult {
  ok: boolean;
  dueCount: number;
  items: UnifiedReviewItem[];
  /** Present when the bridge could not reach / parse the sidecar. */
  error?: string;
}

/** Deep-link path into the LSAT SRS review flow. */
export const LSAT_REVIEW_PATH = LSAT_SRS_PATH;

/**
 * One card inside the `/api/srs/due` body. The contract still types that route's
 * 2xx response as `LegacySuccessResponse` (a permissive legacy shape with no
 * narrow `response_model`), so the per-card fields aren't statically described by
 * `api.gen.ts` — this mirrors the documented payload from
 * `app/routers/srs.py::due_cards`. When the backend grows a typed `response_model`
 * for this route, regenerate `api.gen.ts` and swap this for the schema alias.
 */
interface RawDueCard extends RawLsatSrsCard {
  card_id?: number | string;
  question_id?: number | string;
  stem?: string;
  prompt?: string;
  q_type?: string;
}

/** Documented `/api/srs/due` body shape (still `LegacySuccessResponse` on the wire). */
interface RawDueResponse {
  due_count?: number;
  cards?: RawDueCard[];
}

function titleFor(card: RawDueCard, index: number): string {
  const raw = (card.stem || card.prompt || '').replace(/\s+/g, ' ').trim();
  if (raw) return raw.length > 80 ? `${raw.slice(0, 79)}…` : raw;
  return `LSAT item ${card.question_id ?? card.card_id ?? index + 1}`;
}

/**
 * Fetch the LSAT due-review queue from the sidecar. `signal`/timeout keep a
 * down sidecar from hanging the inbox.
 */
export async function fetchLsatDue(opts: { limit?: number; timeoutMs?: number } = {}): Promise<LsatDueResult> {
  const { limit = 5, timeoutMs = 2500 } = opts;
  const res = await fetchLsatSidecarJson<RawDueResponse>(LSAT_DUE_PATH, {
    timeoutMs,
    headers: { accept: 'application/json' },
  });
  if (!res.reachable) return { ok: false, dueCount: 0, items: [], error: res.error };
  if (!res.ok) {
    return { ok: false, dueCount: 0, items: [], error: `LSAT backend responded ${res.status}.` };
  }
  if (res.data == null) return { ok: false, dueCount: 0, items: [], error: 'Unparseable LSAT due body.' };
  const data = res.data ?? {};
  const cards = Array.isArray(data.cards) ? data.cards : [];
  const items: UnifiedReviewItem[] = cards.slice(0, limit).map((card, i) => ({
    domain: 'lsat',
    id: String(card.card_id ?? card.question_id ?? i),
    title: titleFor(card, i),
    deepLinkPath: LSAT_SRS_PATH,
    qType: card.q_type,
    // DATA-2: project the same raw row onto the canonical cross-domain shape so
    // consumers can merge/rank it against host cards with one vocabulary.
    canonical: lsatSrsCardToCanonical(card),
  }));
  return {
    ok: true,
    dueCount: typeof data.due_count === 'number' ? data.due_count : cards.length,
    items,
  };
}

/**
 * One card inside the LEARN-2 `/api/study/due-unified` body. The backend emits
 * the canonical `CrossDomainReviewCard` shape directly (mirrors
 * `dataDictionary.ts` §1 / `lsatSrsCardToCanonical`), plus the two LEARN-2
 * ranking signals (`overdueSeconds`, `utilityScore`). Read permissively: a
 * shape drift just degrades a row rather than throwing.
 */
interface RawUnifiedDueCard
  extends Omit<Partial<CrossDomainReviewCard>, 'crossId' | 'questionCrossId'> {
  // Read the branded id fields permissively off the wire as plain strings: the
  // canonical `CrossDomainId` template-literal type is validated/coerced
  // downstream (`unifiedItemFromCanonical`), so we must NOT inherit the strict
  // branded type here (that drift would throw instead of degrading a row).
  crossId?: string;
  questionCrossId?: string;
  overdueSeconds?: number;
  utilityScore?: number | null;
}

/** Documented `/api/study/due-unified` body shape. */
interface RawUnifiedDueResponse {
  ok?: boolean;
  due_count?: number;
  items?: RawUnifiedDueCard[];
}

/**
 * LEARN-2 — fetch the unified, ability-ranked due queue from the sidecar
 * (`GET /api/study/due-unified`). The backend already projects LSAT due cards
 * onto the canonical {@link CrossDomainReviewCard} shape and ranks them
 * (overdue DESC, q_type interleave, ability-weighted utility), so the host can
 * merge these with its OWN local Dexie queue into one ranked list. Parallel to
 * {@link fetchLsatDue}: same degrading-fetch pattern — any failure (sidecar
 * down, timeout, shape drift) returns `{ ok: false, dueCount: 0, items: [] }`
 * so the inbox simply omits the LSAT rows rather than erroring.
 *
 * Returns the same {@link UnifiedReviewItem} shape `fetchLsatDue` does (so the
 * inbox renders both identically), carrying the canonical card the backend
 * sent so a consumer can rank/merge with one vocabulary.
 */
export async function fetchUnifiedDue(
  opts: { limit?: number; timeoutMs?: number } = {},
): Promise<LsatDueResult> {
  const { limit = 5, timeoutMs = 2500 } = opts;
  const res = await fetchLsatSidecarJson<RawUnifiedDueResponse>(LSAT_UNIFIED_DUE_PATH, {
    timeoutMs,
    headers: { accept: 'application/json' },
  });
  if (!res.reachable) return { ok: false, dueCount: 0, items: [], error: res.error };
  if (!res.ok) {
    return { ok: false, dueCount: 0, items: [], error: `LSAT backend responded ${res.status}.` };
  }
  if (res.data == null) return { ok: false, dueCount: 0, items: [], error: 'Unparseable unified due body.' };
  const data = res.data ?? {};
  const cards = Array.isArray(data.items) ? data.items : [];
  const items: UnifiedReviewItem[] = cards.slice(0, limit).map((card, i) =>
    unifiedItemFromCanonical(card, i),
  );
  return {
    ok: true,
    dueCount: typeof data.due_count === 'number' ? data.due_count : cards.length,
    items,
  };
}

/** Project a canonical due card (from `/api/study/due-unified`) onto the inbox's
 * {@link UnifiedReviewItem} shape. The backend already sent the canonical record,
 * so this just fills the missing `crossId`/`questionCrossId`/`difficulty`
 * defaults defensively (a drifted/partial row degrades rather than throwing). */
function unifiedItemFromCanonical(card: RawUnifiedDueCard, index: number): UnifiedReviewItem {
  const crossId = card.crossId || `lsat:review:${index}`;
  const nativeId = crossId.split(':').at(-1) || String(index);
  const canonical: CrossDomainReviewCard = {
    crossId: crossId as CrossDomainReviewCard['crossId'],
    domain: 'lsat',
    questionCrossId: (card.questionCrossId ||
      `lsat:question:${nativeId}`) as CrossDomainReviewCard['questionCrossId'],
    title: card.title || `LSAT item ${nativeId}`,
    difficulty: card.difficulty || 'intermediate',
    empiricalDifficulty:
      typeof card.empiricalDifficulty === 'number' ? card.empiricalDifficulty : undefined,
    dueAt: typeof card.dueAt === 'string' ? card.dueAt : undefined,
    itemType: card.itemType,
    origin: card.origin,
  };
  return {
    domain: 'lsat',
    id: nativeId,
    title: canonical.title,
    deepLinkPath: LSAT_SRS_PATH,
    qType: canonical.itemType,
    canonical,
  };
}

/** Result of {@link fetchLsatDueCanonical} — canonical cross-domain cards. */
export interface LsatDueCanonicalResult {
  ok: boolean;
  dueCount: number;
  cards: CrossDomainReviewCard[];
  error?: string;
}

/**
 * DATA-2 — fetch the LSAT due queue projected entirely onto the canonical
 * cross-domain shape (`dataDictionary.ts`), so a unified "what's due across all
 * domains" caller can merge these with the host's `crossDomainBridge.reviewCards()`
 * output and rank both with one vocabulary (bucketed difficulty, namespaced
 * identity). Thin wrapper over {@link fetchLsatDue} — same degrading behaviour;
 * any failure returns `{ ok: false, dueCount: 0, cards: [] }`.
 */
export async function fetchLsatDueCanonical(
  opts: { limit?: number; timeoutMs?: number } = {},
): Promise<LsatDueCanonicalResult> {
  const result = await fetchLsatDue(opts);
  return {
    ok: result.ok,
    dueCount: result.dueCount,
    cards: result.items.map((item) => item.canonical),
    error: result.error,
  };
}
