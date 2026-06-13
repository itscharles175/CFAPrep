"""vNext adaptive ability, readiness, and Socratic tutor endpoints."""
from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, StringConstraints
from sqlmodel import Session, select

from .. import adaptivity
from ..db import get_session
from ..models import (
    AttemptRationale,
    Confidence,
    QuestionConversation,
    SectionType,
)

router = APIRouter()

ShortText = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=240)
]


class NextBody(BaseModel):
    count: int = Field(default=5, ge=1, le=25)
    q_type: ShortText | None = None
    section_type: SectionType | None = None
    source: Literal["real", "ai", "any"] = "real"
    include_recent: bool = False


class PlanBody(BaseModel):
    minutes: int = Field(default=60, ge=10, le=240)


class RationaleBody(BaseModel):
    stage: Literal["timed", "blind_review", "revision"] = "blind_review"
    answer: str | None = Field(default=None, max_length=5)
    confidence: Confidence | None = None
    rationale_text: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)
    ]
    trap_guess: str | None = Field(default=None, max_length=80)


class ConversationBody(BaseModel):
    question_id: int = Field(gt=0)
    attempt_id: int | None = Field(default=None, gt=0)
    title: str | None = Field(default=None, max_length=160)
    mode: str = Field(default="socratic", max_length=40)


class TurnBody(BaseModel):
    role: Literal["user", "assistant"] = "user"
    content: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=8000)
    ]
    auto_reply: bool = True


@router.get("/adaptivity/ability")
def ability(
    q_type: str | None = Query(None),
    section_type: SectionType | None = Query(None),
    days: int | None = Query(default=180, ge=1, le=730),
    persist: bool = Query(default=False),
    session: Session = Depends(get_session),
):
    if q_type or section_type:
        payload = adaptivity.ability_estimate(
            session,
            q_type=q_type,
            section_type=section_type,
            days=days,
            persist=persist,
        )
        payload["selector"] = adaptivity.selector_from_ability(
            session, payload, days=days,
        )
        return payload
    return adaptivity.ability_matrix(session, days=days, persist=persist)


@router.post("/adaptivity/next")
def next_questions(body: NextBody, session: Session = Depends(get_session)):
    return adaptivity.next_questions(
        session,
        count=body.count,
        q_type=body.q_type,
        section_type=body.section_type,
        source=body.source,
        include_recent=body.include_recent,
    )


@router.post("/adaptivity/plan")
def plan(body: PlanBody | None = None, session: Session = Depends(get_session)):
    return adaptivity.daily_plan(session, minutes=(body.minutes if body else 60))


@router.post("/adaptivity/recompute-item-stats")
def recompute_item_stats(session: Session = Depends(get_session)):
    return adaptivity.refresh_all_item_stats(session)


@router.get("/readiness")
def readiness(
    section_type: SectionType | None = Query(None),
    days: int | None = Query(default=None, ge=7, le=730),
    persist: bool = Query(default=True),
    session: Session = Depends(get_session),
):
    return adaptivity.readiness(
        session,
        section_type=section_type,
        days=days,
        persist=persist,
    )


@router.post("/attempts/{attempt_id}/rationale")
def save_rationale(attempt_id: int, body: RationaleBody,
                   session: Session = Depends(get_session)):
    try:
        row = adaptivity.save_rationale(
            session,
            attempt_id=attempt_id,
            stage=body.stage,
            answer=body.answer,
            confidence=body.confidence,
            rationale_text=body.rationale_text,
            trap_guess=body.trap_guess,
        )
    except ValueError as exc:
        if str(exc) == "attempt_not_found":
            raise HTTPException(404, "Attempt not found") from exc
        raise
    return _rationale_payload(row)


@router.get("/attempts/{attempt_id}/rationales")
def list_rationales(attempt_id: int, session: Session = Depends(get_session)):
    rows = session.exec(
        select(AttemptRationale)
        .where(AttemptRationale.attempt_id == attempt_id)
        .order_by(AttemptRationale.id)
    ).all()
    return [_rationale_payload(r) for r in rows]


@router.get("/attempts/{attempt_id}/why-loop")
def why_loop(
    attempt_id: int,
    reveal: bool = Query(default=False),
    session: Session = Depends(get_session),
):
    try:
        return adaptivity.why_loop_state(
            session,
            attempt_id=attempt_id,
            reveal=reveal,
        )
    except ValueError as exc:
        if str(exc) == "attempt_not_found":
            raise HTTPException(404, "Attempt not found") from exc
        raise


@router.post("/attempts/{attempt_id}/concept-cards")
def create_concept_cards(attempt_id: int, session: Session = Depends(get_session)):
    try:
        return adaptivity.create_concept_gap_cards_from_rationale(
            session,
            attempt_id=attempt_id,
        )
    except ValueError as exc:
        if str(exc) == "attempt_not_found":
            raise HTTPException(404, "Attempt not found") from exc
        raise


@router.post("/conversations")
def create_conversation(body: ConversationBody,
                        session: Session = Depends(get_session)):
    try:
        conv = adaptivity.start_conversation(
            session,
            question_id=body.question_id,
            attempt_id=body.attempt_id,
            title=body.title,
            mode=body.mode,
        )
    except ValueError as exc:
        if str(exc) == "question_not_found":
            raise HTTPException(404, "Question not found") from exc
        if str(exc) == "attempt_not_found":
            raise HTTPException(404, "Attempt not found") from exc
        raise
    return adaptivity.conversation_payload(session, conv)


@router.get("/conversations")
def list_conversations(
    question_id: int | None = Query(default=None, gt=0),
    session: Session = Depends(get_session),
):
    stmt = select(QuestionConversation).order_by(QuestionConversation.updated_at.desc())
    if question_id is not None:
        stmt = stmt.where(QuestionConversation.question_id == question_id)
    rows = session.exec(stmt.limit(50)).all()
    return [adaptivity.conversation_payload(session, row) for row in rows]


@router.get("/conversations/{conversation_id}")
def get_conversation(conversation_id: int, session: Session = Depends(get_session)):
    conv = session.get(QuestionConversation, conversation_id)
    if conv is None:
        raise HTTPException(404, "Conversation not found")
    return adaptivity.conversation_payload(session, conv)


@router.post("/conversations/{conversation_id}/turns")
def add_turn(conversation_id: int, body: TurnBody,
             session: Session = Depends(get_session)):
    try:
        return adaptivity.add_tutor_turn(
            session,
            conversation_id=conversation_id,
            role=body.role,
            content=body.content,
            auto_reply=body.auto_reply,
        )
    except ValueError as exc:
        if str(exc) == "conversation_not_found":
            raise HTTPException(404, "Conversation not found") from exc
        raise


def _rationale_payload(row: AttemptRationale):
    return {
        "id": row.id,
        "attempt_id": row.attempt_id,
        "question_id": row.question_id,
        "stage": row.stage,
        "answer": row.answer,
        "confidence": row.confidence.value if hasattr(row.confidence, "value") else row.confidence,
        "rationale_text": row.rationale_text,
        "trap_guess": row.trap_guess,
        "created_at": row.created_at.isoformat(),
    }
