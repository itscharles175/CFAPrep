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
 */

const LSAT_API_BASE = 'http://127.0.0.1:8100';
const LSAT_SRS_PATH = '/lsat/srs'; // deep-link target (host hard-navigates here)

/** A domain-agnostic "due review" row for the unified inbox. */
export interface UnifiedReviewItem {
  domain: 'lsat';
  id: string;
  title: string;
  /** Where to send the user to actually do this review (hard nav for LSAT). */
  deepLinkPath: string;
  qType?: string;
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

interface RawDueCard {
  card_id?: number | string;
  question_id?: number | string;
  stem?: string;
  prompt?: string;
  q_type?: string;
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${LSAT_API_BASE}/api/srs/due`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      return { ok: false, dueCount: 0, items: [], error: `LSAT backend responded ${res.status}.` };
    }
    const data = (await res.json()) as { due_count?: number; cards?: RawDueCard[] };
    const cards = Array.isArray(data.cards) ? data.cards : [];
    const items: UnifiedReviewItem[] = cards.slice(0, limit).map((card, i) => ({
      domain: 'lsat',
      id: String(card.card_id ?? card.question_id ?? i),
      title: titleFor(card, i),
      deepLinkPath: LSAT_SRS_PATH,
      qType: card.q_type,
    }));
    return {
      ok: true,
      dueCount: typeof data.due_count === 'number' ? data.due_count : cards.length,
      items,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, dueCount: 0, items: [], error: msg };
  } finally {
    clearTimeout(timer);
  }
}
