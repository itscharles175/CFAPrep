"""vNext adaptive ability, readiness, and Socratic tutor endpoints."""
from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
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


class UnifiedAbilityEstimate(BaseModel):
    """LEARN-1 — inline typed shape of a unified cross-domain ability estimate
    (BC2 style; mirrors ``adaptivity.ability_estimate``'s payload + ``domain``).

    Returned for the host-plane read (``GET /api/adaptivity/ability?domain=…``).
    ``model_config`` allows extra keys so future estimate fields surface without
    a contract break, and so the existing LSAT-only matrix/estimate branches keep
    returning their own (un-narrowed) shapes through this same route."""

    model_config = ConfigDict(extra="allow")

    domain: str
    q_type: str | None = None
    section_type: str | None = None
    ability: float
    mastery: float
    uncertainty: float
    evidence_n: int
    accuracy: float | None = None
    avg_time_ms: float | None = None
    model: str
    learning_velocity: dict[str, Any]
    plateau: bool
    mastery_eta_days: int | None = None
    components: dict[str, Any]


class NextBody(BaseModel):
    count: int = Field(default=5, ge=1, le=25)
    q_type: ShortText | None = None
    section_type: SectionType | None = None
    source: Literal["real", "ai", "any"] = "real"
    include_recent: bool = False
    # LEARN-6 — cross-domain content plane. Omit (default) for the current
    # LSAT-only ranking over the Question pool. A host plane routes over the
    # host content mirrored in HostProgressSnapshot (DATA-4a) via the unified
    # ability; the LSAT-only filters above don't apply to a host plane.
    domain: Literal["cfa", "quant", "excel"] | None = Field(
        default=None,
        description=(
            "LEARN-6 — cross-domain content plane. Omit for the current "
            "LSAT-only ranking. A host plane (cfa|quant|excel) routes over host "
            "content via the unified cross-domain ability."
        ),
    )


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
    domain: Literal["cfa", "quant", "excel"] | None = Query(
        default=None,
        description=(
            "LEARN-1 — cross-domain ability plane. Omit (default) for the "
            "current LSAT-only matrix/estimate. A host plane reads that domain's "
            "attempt snapshots (DATA-4a) and returns a single unified estimate."
        ),
    ),
    session: Session = Depends(get_session),
):
    # LEARN-1 — host-plane read. The LSAT-only q_type/section_type/matrix path
    # below is unchanged when ``domain`` is omitted (backward compat). A host
    # plane has no LSAT selector/matrix, so we return its unified estimate alone,
    # validated through the inline typed shape (extra keys preserved).
    if domain is not None:
        estimate = adaptivity.ability_estimate(
            session,
            days=days,
            domain=domain,
        )
        return UnifiedAbilityEstimate.model_validate(estimate)
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
        domain=body.domain,
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
