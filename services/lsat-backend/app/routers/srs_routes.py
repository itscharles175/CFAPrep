"""SRS (FSRS) endpoints."""
from __future__ import annotations

import re
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from .. import adaptivity, config, pedagogy, serializers, srs
from ..db import atomic_batch, get_session
from ..models import Attempt, AttemptRationale, Confidence, Question, SRSCard

router = APIRouter(prefix="/srs")


# LEARN-4 — Host-side FSRS parameter parity. The host (src/lib/scheduler.ts) runs
# its own ts-fsrs scheduler; this read-only endpoint lets it adopt the backend's
# source-of-truth FSRS weights + desired retention at boot so both domains
# schedule identically. ``srs.py`` owns the weights (``load_optimized_params``)
# and ``config.SRS_DESIRED_RETENTION`` owns the retention target; we are a pure
# read-only consumer of those — no side effects, no mutation of either.
class SrsParamsOut(BaseModel):
    """The backend's effective FSRS parameters (py-fsrs). ``weights`` are the
    per-user optimized weights when present, else the empty list (host then keeps
    its ts-fsrs library defaults / local fit). ``source`` always "backend" so the
    host can label where the params came from."""
    weights: list[float] = Field(default_factory=list)
    desired_retention: float
    source: str = "backend"


@router.get("/params", response_model=SrsParamsOut)
def srs_params(session: Session = Depends(get_session)) -> SrsParamsOut:
    """LEARN-4 — expose the backend's source-of-truth FSRS weights + desired
    retention so the host scheduler can mirror them. Idempotent + side-effect
    free: ``load_optimized_params`` only reads (and applies to the backend's own
    cached Scheduler) the persisted optimized weights — it never writes — and the
    retention is read straight from config. Returns ``weights=[]`` when no
    per-user optimization has been persisted yet."""
    weights = srs.load_optimized_params(session) or []
    retention = float(getattr(config, "SRS_DESIRED_RETENTION", 0.9) or 0.9)
    return SrsParamsOut(weights=list(weights), desired_retention=retention)

# LSAT-3 — the distinct origin for auto-generated cloze/pattern "Gap" cards. Kept
# separate from the plain ``concept_gap`` origin (which marks a question that
# resurfaces verbatim) so the UI can badge these as "Gap" and render the
# generated cloze, and so re-running the generator is idempotent (one Gap card
# per concept-gap question).
GAP_CARD_ORIGIN = "concept_gap_cloze"


class ReviewBody(BaseModel):
    rating: int = Field(ge=1, le=4)


class BulkCardsBody(BaseModel):
    question_ids: list[int]


class BlindReviewNoteBody(BaseModel):
    """LSAT-3 — the short reveal-time rationale captured in the Blind Review
    screen. Posted per attempt the moment the answer is revealed."""
    br_note: str = Field(min_length=1, max_length=4000)
    answer: Optional[str] = Field(default=None, max_length=5)
    confidence: Optional[Confidence] = None


class ConceptGapCardsBody(BaseModel):
    """LSAT-3 — bound the auto-cloze generation run (most-recent concept gaps
    first). Optional; the defaults cover a normal study session's gaps."""
    limit: int = Field(default=20, ge=1, le=100)


@router.post("/cards")
def create_cards(body: BulkCardsBody, session: Session = Depends(get_session)):
    """D5/H2: schedule SRS reviews for a set of questions (e.g. 'add similar to
    SRS'). Idempotent — questions that already have a card are skipped."""
    existing = {c.question_id for c in session.exec(select(SRSCard)).all()}
    created: list[int] = []
    skipped = 0
    # BA5: the whole set of new cards is one atomic batch. We flush (not commit)
    # per row so each card's autoincrement id is populated for the response,
    # then atomic_batch commits once on a clean exit — so a failure partway
    # through can't leave the bank with only some of the requested cards.
    with atomic_batch(session):
        for qid in body.question_ids:
            if qid in existing or not session.get(Question, qid):
                skipped += 1
                continue
            card = SRSCard(
                question_id=qid,
                fsrs_state=srs.new_card_state(),
                due_date=datetime.now(timezone.utc),
                lapses=0,
            )
            session.add(card)
            session.flush()
            session.refresh(card)
            created.append(card.id)
            existing.add(qid)
    return {"created": len(created), "skipped": skipped, "card_ids": created}


@router.get("/concept-gap-queue")
def concept_gap_queue(
    session: Session = Depends(get_session),
    include_host: bool = Query(
        False,
        description="LEARN-5 — also append HOST concept-gap rows (from "
        "HostProgressSnapshot review snapshots, DATA-4a) projected onto the "
        "canonical CrossDomainReviewCard shape. Default false → the response is "
        "byte-for-byte the LSAT-only queue (backward compatible).",
    ),
):
    """1.1 — the concept-gap remediation queue: SRS cards created because the
    timed AND blind-review answers were both wrong (origin="concept_gap").

    LEARN-5 — with ``include_host=true`` the cross-domain concept gaps the host
    mirrored (DATA-4a review snapshots whose ``origin`` marks unfinished
    understanding) are ALSO appended, already projected onto the canonical
    cross-domain shape (``cross_domain_review_card`` / ``CrossDomainReviewCard``)
    so the unified UI renders both planes with one vocabulary. Read-only on the
    host mirror. When ``include_host`` is false (the default) nothing host-side is
    read and the response is unchanged."""
    cards = pedagogy.concept_gap_queue(session)
    if not include_host:
        return {"count": len(cards), "cards": cards}
    _leech_rows, host_gaps = srs.host_leech_and_gap_rows(session)
    return {
        "count": len(cards) + len(host_gaps),
        "cards": cards,
        # Host rows are kept in their own array (already-canonical shape) so the
        # LSAT-native ``cards`` payload stays exactly as before — a consumer that
        # ignores ``host_cards`` sees the unchanged queue.
        "host_cards": host_gaps,
        "include_host": True,
    }


@router.post("/attempts/{attempt_id}/blind-review-note")
def blind_review_note(attempt_id: int, body: BlindReviewNoteBody,
                      session: Session = Depends(get_session)):
    """LSAT-3 — capture the short "why" the user writes when revealing a Blind
    Review item. Stored as an ``AttemptRationale`` (stage="blind_review") with the
    note in ``br_note``; the longer Socratic ``rationale_text`` stays empty here.
    The captured note then feeds the auto-cloze "Gap" card generation below.

    Append-only (one row per reveal) — matching how the why-loop records
    rationales — so re-revealing keeps a small history rather than overwriting."""
    attempt = session.get(Attempt, attempt_id)
    if attempt is None:
        raise HTTPException(404, "Attempt not found")
    row = AttemptRationale(
        attempt_id=attempt_id,
        question_id=attempt.question_id,
        stage="blind_review",
        answer=body.answer,
        confidence=body.confidence,
        rationale_text="",
        br_note=body.br_note,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return {
        "id": row.id,
        "attempt_id": row.attempt_id,
        "question_id": row.question_id,
        "stage": row.stage,
        "br_note": row.br_note,
        "created_at": row.created_at.isoformat(),
    }


# Tokens we never blank out when auto-clozing a stem: short function words carry
# no recall value, so deleting them would make a meaningless gap.
_CLOZE_STOPWORDS = frozenset({
    "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "but", "if",
    "is", "are", "was", "were", "be", "been", "that", "this", "it", "as", "at",
    "by", "with", "from", "which", "who", "whom", "whose", "than", "then",
})


def _latest_br_note(session: Session, question_id: int) -> str | None:
    """The most-recent captured Blind Review ``br_note`` for a question, if any.
    Used to seed the cloze 'pattern' line with the user's own takeaway."""
    row = session.exec(
        select(AttemptRationale)
        .where(AttemptRationale.question_id == question_id)
        .where(AttemptRationale.br_note.is_not(None))
        .order_by(AttemptRationale.id.desc())
    ).first()
    note = (row.br_note or "").strip() if row is not None else ""
    return note or None


def _build_cloze(q: Question, br_note: str | None) -> dict:
    """Deterministically derive a cloze/pattern card body from a question.

    The cloze deletes the single most distinctive content word from the stem
    (longest non-stopword token) so the card tests recall of the load-bearing
    phrase; ``pattern`` carries the user's own Blind-Review takeaway when present,
    else a generic q_type prompt. Purely local + deterministic — no model call —
    so generation is offline-safe and re-runs identically."""
    stem = (q.stem or q.prompt or "").strip()
    words = re.findall(r"[A-Za-z][A-Za-z'-]+", stem)
    candidates = [w for w in words if w.lower() not in _CLOZE_STOPWORDS and len(w) >= 4]
    target = max(candidates, key=len) if candidates else None
    if target:
        # Blank only the first occurrence so the rest of the stem stays readable.
        cloze = re.sub(rf"\b{re.escape(target)}\b", "______", stem, count=1)
    else:
        cloze = stem
    pattern = br_note or (
        f"Recall the reasoning move this {q.q_type} question turns on."
    )
    return {"cloze": cloze, "answer": target, "pattern": pattern}


@router.post("/concept-gap-cards")
def concept_gap_cards(body: ConceptGapCardsBody | None = None,
                      session: Session = Depends(get_session)):
    """LSAT-3 — auto-generate cloze/pattern "Gap" SRS cards from the concept-gap
    queue. For each concept-gap question (timed AND blind-review both wrong) we
    ensure one card tagged ``origin="concept_gap_cloze"`` — a distinct "Gap" card
    type surfaced in the SRS screen — and derive a deterministic cloze + pattern
    from the stem and the captured Blind Review note (LSAT-3's ``br_note``).

    Idempotent: ``ensure_card`` is one card per question, so re-running creates no
    duplicates and a question already promoted to a Gap card is skipped. Returns
    each generated card's id + cloze/pattern preview so the caller can show what
    was made and the SRS screen can render the Gap card body."""
    limit = body.limit if body is not None else 20
    queue = pedagogy.concept_gap_queue(session)[:limit]
    created: list[dict] = []
    skipped = 0
    with atomic_batch(session):
        for entry in queue:
            qid = entry["question_id"]
            q = session.get(Question, qid)
            if q is None or q.deleted_at is not None:
                skipped += 1
                continue
            existing = srs.get_card(session, qid)
            # Skip a question already promoted to a Gap card (idempotent re-run).
            if existing is not None and existing.origin == GAP_CARD_ORIGIN:
                skipped += 1
                continue
            card, was_created = srs.ensure_card(
                session, qid, origin=GAP_CARD_ORIGIN, commit=False,
            )
            # A concept-gap question usually already has a plain ``concept_gap``
            # card (created by the BR->SRS loop). Promote it to the distinct Gap
            # type so it badges + renders as a cloze; a manual/lucky/seed card the
            # user owns keeps its origin (we only promote the auto concept_gap).
            promoted = False
            if not was_created and card.origin == "concept_gap":
                card.origin = GAP_CARD_ORIGIN
                session.add(card)
                promoted = True
            session.flush()
            session.refresh(card)
            cloze = _build_cloze(q, _latest_br_note(session, qid))
            created.append({
                "card_id": card.id,
                "question_id": qid,
                "q_type": q.q_type,
                "difficulty": q.difficulty,
                "origin": card.origin,
                "card_type": "gap",
                # True = a brand-new card; False = an existing concept_gap card
                # promoted into the Gap type. Either way it is a Gap card now.
                "is_new": was_created,
                **cloze,
            })
    return {
        # Cards that became Gap cards on this run (new + promoted). A re-run finds
        # no remaining plain concept_gap questions, so it returns generated=0.
        "generated": len(created),
        "skipped": skipped,
        "card_type": "gap",
        "origin": GAP_CARD_ORIGIN,
        "cards": created,
    }


def _interleave_by_qtype(items: list[tuple[SRSCard, Question]]) -> list[tuple[SRSCard, Question]]:
    """Round-robin a most-overdue-first list across q_types so the queue never
    serves a long run of the same type. Within each q_type the input order
    (most-overdue-first) is preserved; ties across types break by which type's
    most-overdue card is more overdue, so the order still leads with urgency."""
    buckets: dict[str, list[tuple[SRSCard, Question]]] = defaultdict(list)
    order: list[str] = []
    for card, q in items:
        qt = q.q_type or "?"
        if qt not in buckets:
            order.append(qt)
        buckets[qt].append((card, q))
    out: list[tuple[SRSCard, Question]] = []
    # Drain round-robin in the order each q_type first appears (its head is its
    # most-overdue card, so leading types are the most urgent).
    while any(buckets[qt] for qt in order):
        for qt in order:
            if buckets[qt]:
                out.append(buckets[qt].pop(0))
    return out


@router.get("/due")
def due_cards(session: Session = Depends(get_session)):
    """Due SRS cards, most-overdue-first AND interleaved by q_type so a single
    type never dominates a long review run. Each card additionally carries its
    ``origin`` (why it's queued) — answer-key-free, used by the SRS screen to
    badge the card (incl. LSAT-3's distinct "Gap" cloze cards)."""
    selector = adaptivity.ability_selector(session, days=180)
    now = datetime.now(timezone.utc)
    cards = session.exec(select(SRSCard)).all()
    due_pairs: list[tuple[SRSCard, Question, float]] = []
    for card in cards:
        cd = card.due_date
        if cd.tzinfo is None:
            cd = cd.replace(tzinfo=timezone.utc)
        if cd <= now:
            q = session.get(Question, card.question_id)
            if q:
                overdue_s = (now - cd).total_seconds()
                due_pairs.append((card, q, overdue_s))
    # Most-overdue first, then interleave across q_types.
    due_pairs.sort(key=lambda t: -t[2])
    ordered = _interleave_by_qtype([(c, q) for c, q, _ in due_pairs])
    cards_out = []
    for card, q in ordered:
        payload = serializers.question_test_mode(session, q, card_id=card.id)
        payload["predicted_intervals"] = srs.predicted_intervals(card.fsrs_state or {})
        payload["origin"] = card.origin
        cards_out.append(payload)
    return {
        "due_count": len(cards_out),
        "cards": cards_out,
        "ability_selector": selector,
        "utility_model": "ability_engine_v2",
        "review_strategy": {
            "ordering": "overdue_interleaved_by_qtype",
            "selector_strategy": selector.get("strategy"),
            "target_difficulty": (selector.get("zpd") or {}).get("target_difficulty"),
            "srs_due": (selector.get("srs") or {}).get("due"),
            "utility_model": selector.get("utility_model"),
            "utility_score": (selector.get("utility") or {}).get("score"),
            "srs_pressure": (
                ((selector.get("utility") or {}).get("signals") or {})
                .get("srs_pressure")
            ),
        },
    }


@router.get("/leeches")
def leeches(
    session: Session = Depends(get_session),
    include_host: bool = Query(
        False,
        description="LEARN-5 — also append HOST leech rows (from "
        "HostProgressSnapshot review snapshots, DATA-4a) projected onto the "
        "canonical CrossDomainReviewCard shape. Default false → the response is "
        "byte-for-byte the LSAT-only queue (backward compatible).",
    ),
):
    """3.2 — the leech remediation queue: cards that have lapsed too many times
    (``lapses >= config.SRS_LEECH_THRESHOLD``), most-lapsed first. Served in
    test mode (no answer leak) with the lapse count + card id attached.

    LEARN-5 — with ``include_host=true`` the host leeches mirrored cross-domain
    (DATA-4a review snapshots that self-report ``leech`` / enough ``lapses``) are
    ALSO appended, already projected onto the canonical cross-domain shape
    (``CrossDomainReviewCard`` + ``lapses`` / ``leech``) and sorted most-lapsed
    first, so the unified UI renders both planes with one vocabulary. Read-only on
    the host mirror. When ``include_host`` is false (the default) nothing host-side
    is read and the response is unchanged."""
    out = []
    for card in srs.leeches(session):
        q = session.get(Question, card.question_id)
        if not q:
            continue
        payload = serializers.question_test_mode(session, q, card_id=card.id)
        payload["lapses"] = card.lapses
        out.append(payload)
    if not include_host:
        return {"count": len(out), "cards": out}
    host_leeches, _gaps = srs.host_leech_and_gap_rows(session)
    return {
        "count": len(out) + len(host_leeches),
        "cards": out,
        # Host rows kept in their own array (already-canonical shape) so the
        # LSAT-native ``cards`` payload stays exactly as before.
        "host_cards": host_leeches,
        "include_host": True,
    }


@router.post("/optimize")
def optimize(session: Session = Depends(get_session)):
    """3.2 — optimize the FSRS weights from the user's own review history and
    persist them. Returns whether it actually ran + the number of reviews seen;
    falls back gracefully (ran=False + reason) when history is thin or the
    optional optimizer dependencies (torch/pandas) are unavailable."""
    return srs.optimize_parameters(session)


@router.post("/{card_id}/review")
def review_card(card_id: int, body: ReviewBody,
                session: Session = Depends(get_session)):
    card = session.get(SRSCard, card_id)
    if not card:
        raise HTTPException(404, "Card not found")
    new_state, due, interval_days = srs.review(card.fsrs_state or {}, body.rating)
    card.fsrs_state = new_state
    card.due_date = due
    if body.rating == 1:
        card.lapses += 1
    # 3.2 — flag leeches at the lapse threshold and log the review (the optimizer
    # consumes this append-only history).
    srs.flag_leech_if_needed(card)
    session.add(card)
    srs.log_review(session, card, body.rating, commit=False)
    session.commit()
    return {
        "next_due": due.isoformat(),
        "interval_days": interval_days,
        "predicted_intervals": srs.predicted_intervals(new_state),
    }
