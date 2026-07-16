/**
 * Cross-domain leech + concept-gap bridge (roadmap LEARN-5).
 *
 * StudyVault unifies the *surface* of remediation across domains without merging
 * the engines. The LSAT backend sidecar already tracks two remediation queues:
 *
 *   - LEECHES — cards that have lapsed too many times
 *     (`GET /api/srs/leeches`, `lapses >= SRS_LEECH_THRESHOLD`);
 *   - CONCEPT GAPS — cards created because both the timed AND blind-review
 *     answers were wrong (`GET /api/srs/concept-gap-queue`).
 *
 * LEARN-5 extends BOTH endpoints with an optional `include_host=true` query
 * param: when set, the backend ALSO returns the HOST (CFA/Quant/Excel) leech /
 * gap rows it has mirrored (DATA-4a `HostProgressSnapshot` review snapshots),
 * already projected onto the canonical {@link CrossDomainReviewCard} shape (under
 * a separate `host_cards` array so the LSAT-native `cards` payload is unchanged).
 *
 * This bridge fetches both queues with `include_host=true`, projects the
 * LSAT-native rows onto the SAME canonical shape (`dataDictionary.ts`), and
 * concatenates the host rows the backend already canonicalised — so the
 * standalone Leeches & Gaps page renders both planes with one vocabulary
 * (namespaced identity, bucketed difficulty, lapse count, leech flag).
 *
 * Fully degrading: any failure (sidecar down, timeout, shape drift) returns
 * `{ ok: false, leeches: [], gaps: [] }` so the page simply shows an empty
 * state rather than erroring. LSAT rows deep-link to `/lsat/srs`; host rows are
 * shown inline (no deep link — the host owns its own review surface).
 */
import type { paths } from '../domains/lsat/lib/api.gen';
import {
  lsatSrsCardToCanonical,
  type CrossDomainReviewCard,
  type RawLsatSrsCard,
} from './dataDictionary';
import { fetchLsatSidecar } from './lsatSidecarClient';

const LEECHES_PATH = '/api/srs/leeches' satisfies keyof paths;
const CONCEPT_GAP_PATH = '/api/srs/concept-gap-queue' satisfies keyof paths;

/** Deep-link path into the LSAT SRS review flow (host hard-navigates here). */
export const LSAT_SRS_PATH = '/lsat/srs';

/** Result of {@link fetchLeechesAndGaps} — canonical cross-domain cards per queue. */
export interface LeechesAndGapsResult {
  ok: boolean;
  /** Leeches (too many lapses), most-lapsed first, both planes merged. */
  leeches: CrossDomainReviewCard[];
  /** Concept gaps (unfinished understanding), both planes merged. */
  gaps: CrossDomainReviewCard[];
  /** Present when the bridge could not reach / parse the sidecar. */
  error?: string;
}

/**
 * One LSAT-native row inside a `/api/srs/leeches` or `/api/srs/concept-gap-queue`
 * body. The routes still return the permissive `LegacySuccessResponse` shape (no
 * narrow `response_model`), so rows are read defensively. The leech rows are
 * `question_test_mode` payloads (`id` = question id, plus `lapses`); the gap rows
 * are `pedagogy.concept_gap_queue` rows (`question_id`, `due_date`, `lapses`,
 * `origin`). Both project cleanly onto {@link RawLsatSrsCard}.
 */
interface RawLsatQueueRow extends RawLsatSrsCard {
  /** Leech rows carry the question id as `id` (not `question_id`). */
  id?: number | string;
}

/** Documented `/api/srs/leeches` + `/api/srs/concept-gap-queue` body shape. */
interface RawQueueResponse {
  count?: number;
  cards?: RawLsatQueueRow[];
  /** LEARN-5 — host rows the backend already canonicalised (include_host=true). */
  host_cards?: Array<Partial<CrossDomainReviewCard>>;
}

/** Project an LSAT-native queue row onto the canonical shape, carrying lapses/leech. */
function lsatRowToCanonical(row: RawLsatQueueRow): CrossDomainReviewCard {
  // Leech rows use `id` for the question id; gap rows use `question_id`. Normalise
  // so `lsatSrsCardToCanonical` (which reads `question_id ?? card_id`) sees it.
  const normalised: RawLsatSrsCard = {
    ...row,
    question_id: row.question_id ?? row.id,
  };
  return lsatSrsCardToCanonical(normalised);
}

/** Defensively coerce a backend-canonicalised host row (already CrossDomainReviewCard). */
function hostRowToCanonical(
  row: Partial<CrossDomainReviewCard>,
  index: number,
): CrossDomainReviewCard {
  const crossId = row.crossId || `host:review:${index}`;
  const nativeId = String(crossId).split(':').at(-1) || String(index);
  return {
    crossId: crossId as CrossDomainReviewCard['crossId'],
    domain: row.domain ?? 'cfa',
    questionCrossId: (row.questionCrossId ||
      `${row.domain ?? 'cfa'}:question:${nativeId}`) as CrossDomainReviewCard['questionCrossId'],
    title: row.title || `Review item ${nativeId}`,
    difficulty: row.difficulty || 'intermediate',
    empiricalDifficulty:
      typeof row.empiricalDifficulty === 'number' ? row.empiricalDifficulty : undefined,
    dueAt: typeof row.dueAt === 'string' ? row.dueAt : undefined,
    itemType: row.itemType,
    origin: row.origin,
    lapses: typeof row.lapses === 'number' ? row.lapses : undefined,
    leech: typeof row.leech === 'boolean' ? row.leech : undefined,
  };
}

async function fetchQueue(
  path: string,
  includeHost: boolean,
  signal: AbortSignal,
): Promise<CrossDomainReviewCard[]> {
  const res = await fetchLsatSidecar(`${path}${includeHost ? '?include_host=true' : ''}`, {
    signal,
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`LSAT backend responded ${res.status}.`);
  const data = (await res.json()) as RawQueueResponse;
  const lsatRows = Array.isArray(data.cards) ? data.cards : [];
  const hostRows = Array.isArray(data.host_cards) ? data.host_cards : [];
  return [
    ...lsatRows.map(lsatRowToCanonical),
    ...hostRows.map(hostRowToCanonical),
  ];
}

/**
 * Fetch the unified leech + concept-gap queues from the sidecar. With
 * `include_host` (default true), host rows the backend mirrored are merged in.
 * `signal`/timeout keep a down sidecar from hanging the page. Fully degrading —
 * any failure returns `{ ok: false, leeches: [], gaps: [] }`.
 */
export async function fetchLeechesAndGaps(
  opts: { include_host?: boolean; timeoutMs?: number } = {},
): Promise<LeechesAndGapsResult> {
  const { include_host = true, timeoutMs = 2500 } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const [leeches, gaps] = await Promise.all([
      fetchQueue(LEECHES_PATH, include_host, controller.signal),
      fetchQueue(CONCEPT_GAP_PATH, include_host, controller.signal),
    ]);
    // Leeches: most-lapsed first (host rows may already be sorted; re-sort the
    // merged list so both planes interleave by lapse count, matching LSAT order).
    leeches.sort((a, b) => (b.lapses ?? 0) - (a.lapses ?? 0));
    return { ok: true, leeches, gaps };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, leeches: [], gaps: [], error: msg };
  } finally {
    clearTimeout(timer);
  }
}
