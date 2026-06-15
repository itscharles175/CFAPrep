// LSAT-3 — Blind-review rationale capture + auto-cloze gap cards.
//
// Two thin POST helpers for the LSAT-3 endpoints added on the sidecar
// (`services/lsat-backend/app/routers/srs_routes.py`). They live in their own
// module (rather than `api.ts`) because LSAT-3 owns only `BlindReview.tsx` and
// `Srs.tsx` on the host side; folding these into the generated client / `api.ts`
// is left to the typed-client item (DATA-1). The fetch convention mirrors
// `api.ts` (absolute `VITE_API_BASE` base, JSON body, JSON `detail` errors), so
// these calls behave identically to the rest of the client and degrade the same
// way when the sidecar is unreachable.

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8100";

/** A single auto-generated cloze/pattern "Gap" card (one per concept gap). */
export interface GapCard {
  card_id: number;
  question_id: number;
  q_type: string;
  difficulty: number;
  origin: string;
  card_type: "gap";
  /** True = brand-new card; false = an existing concept_gap card promoted. */
  is_new: boolean;
  /** The stem with its most distinctive content word blanked out. */
  cloze: string;
  /** The deleted word (the cloze answer), or null when none could be chosen. */
  answer: string | null;
  /** The user's captured Blind-Review takeaway, or a generic q_type prompt. */
  pattern: string;
}

export interface ConceptGapCardsResult {
  generated: number;
  skipped: number;
  card_type: "gap";
  origin: string;
  cards: GapCard[];
}

export interface BlindReviewNoteResult {
  id: number;
  attempt_id: number;
  question_id: number;
  stage: string;
  br_note: string;
  created_at: string;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = (json as { detail?: unknown } | null)?.detail;
    const message =
      typeof detail === "string" ? detail : res.statusText || "Request failed";
    throw new Error(message);
  }
  return json as T;
}

/**
 * LSAT-3 — capture the short "why" the user writes when revealing a Blind Review
 * item. Optional rationale, so callers treat a failure as non-fatal (the reveal
 * itself is already persisted by the blind-review PATCH).
 */
export function postBlindReviewNote(
  attemptId: number,
  body: { br_note: string; answer?: string | null; confidence?: string | null },
): Promise<BlindReviewNoteResult> {
  return post<BlindReviewNoteResult>(
    `/api/srs/attempts/${attemptId}/blind-review-note`,
    body,
  );
}

/**
 * LSAT-3 — auto-generate cloze/pattern "Gap" SRS cards from the concept-gap
 * queue. Idempotent server-side (one Gap card per concept-gap question).
 */
export function generateConceptGapCards(
  limit?: number,
): Promise<ConceptGapCardsResult> {
  return post<ConceptGapCardsResult>(
    "/api/srs/concept-gap-cards",
    limit != null ? { limit } : {},
  );
}

/** The distinct origin the backend stamps on auto-cloze Gap cards. */
export const GAP_CARD_ORIGIN = "concept_gap_cloze";

/** Whether an SRS card's origin marks it as an auto-cloze "Gap" card. */
export function isGapCard(origin: string | null | undefined): boolean {
  return origin === GAP_CARD_ORIGIN;
}
