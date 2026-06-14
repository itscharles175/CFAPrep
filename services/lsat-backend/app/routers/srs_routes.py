"""SRS (FSRS) endpoints."""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from .. import adaptivity, pedagogy, serializers, srs
from ..db import atomic_batch, get_session
from ..models import Question, SRSCard

router = APIRouter(prefix="/srs")


class ReviewBody(BaseModel):
    rating: int = Field(ge=1, le=4)


class BulkCardsBody(BaseModel):
    question_ids: list[int]


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
def concept_gap_queue(session: Session = Depends(get_session)):
    """1.1 — the concept-gap remediation queue: SRS cards created because the
    timed AND blind-review answers were both wrong (origin="concept_gap")."""
    cards = pedagogy.concept_gap_queue(session)
    return {"count": len(cards), "cards": cards}


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
    type never dominates a long review run. (Card response shape unchanged.)"""
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
def leeches(session: Session = Depends(get_session)):
    """3.2 — the leech remediation queue: cards that have lapsed too many times
    (``lapses >= config.SRS_LEECH_THRESHOLD``), most-lapsed first. Served in
    test mode (no answer leak) with the lapse count + card id attached."""
    out = []
    for card in srs.leeches(session):
        q = session.get(Question, card.question_id)
        if not q:
            continue
        payload = serializers.question_test_mode(session, q, card_id=card.id)
        payload["lapses"] = card.lapses
        out.append(payload)
    return {"count": len(out), "cards": out}


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
