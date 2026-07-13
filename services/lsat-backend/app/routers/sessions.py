"""Study sessions, attempts, blind review, finish, and the 2x2 results routing."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import case, func
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, col, select

from .. import analytics, pedagogy, scoring, serializers
from ..db import get_session
from ..pagination import LimitQuery, OffsetQuery, paginate
from ..schemas import SessionSummary
from ..models import (
    Attempt,
    AttemptChoiceEvent,
    AttemptMode,
    Confidence,
    Passage,
    Question,
    QuestionSource,
    Reflection,
    SessionType,
    StudySession,
)

router = APIRouter()


class SessionCreate(BaseModel):
    type: SessionType
    config: dict[str, Any] = {}


class ChoiceEvent(BaseModel):
    """1.2 — one process-of-elimination interaction within an attempt."""
    label: str
    action: str  # "select" | "eliminate" | "restore" | "reconsider"
    order_index: int = 0
    time_ms: int = 0
    confidence: Optional[str] = None


class AttemptCreate(BaseModel):
    question_id: int
    mode: AttemptMode = AttemptMode.timed
    chosen_answer: Optional[str] = None
    time_ms: int = 0
    flagged: bool = False
    confidence: Optional[Confidence] = None
    # 1.2 — optional process-of-elimination trace captured during the attempt.
    # audit M9 — bound it; a single question can't accrue thousands of POE events.
    choice_events: list[ChoiceEvent] = Field(default_factory=list, max_length=500)
    # 5.2 — optional client-generated idempotency token. When present, replaying
    # the same write (offline retry, double-fire on section finish) returns the
    # existing attempt instead of inserting a duplicate. Additive/optional.
    client_attempt_id: Optional[str] = None


class AttemptBatch(BaseModel):
    """5.2 — a list of attempts written in one request (finish-a-section flush)."""
    # audit M9 — bound the batch so a malformed/huge payload can't exhaust the
    # local worker. A real section flush is dozens of attempts, not thousands.
    attempts: list[AttemptCreate] = Field(default_factory=list, max_length=1000)


class BlindReview(BaseModel):
    br_answer: str
    confidence: Optional[Confidence] = None


@router.get("/sessions", response_model=list[SessionSummary])
def list_sessions(
    session: Session = Depends(get_session),
    limit: int | None = LimitQuery,
    offset: int | None = OffsetQuery,
):
    """Most-recent-first list of study sessions, enriched so SessionHistory and
    the analytics timeline don't have to N+1 per session.

    Adds ``duration_sec``, ``br_accuracy`` (over attempts with a BR answer), and
    ``official_only_score`` (scaled estimate over official timed attempts only).

    BC2: optional limit/offset slice the built list in Python (one aggregate
    query regardless); omit both for the full most-recent-first list as before.
    """
    sessions = session.exec(
        select(StudySession).order_by(StudySession.started.desc())
    ).all()
    if not sessions:
        return []

    br_mode = AttemptMode.blind_review
    timed_mode = AttemptMode.timed
    official = QuestionSource.official

    agg = session.exec(
        select(
            Attempt.session_id,
            func.sum(
                case((col(Attempt.mode) != br_mode, 1), else_=0)
            ).label("question_count"),
            func.sum(
                case(
                    (
                        (col(Attempt.mode) != br_mode)
                        & (col(Attempt.br_answer).is_not(None)),
                        1,
                    ),
                    else_=0,
                )
            ).label("br_n"),
            func.sum(
                case(
                    (
                        (col(Attempt.mode) != br_mode)
                        & (col(Attempt.br_correct).is_(True)),
                        1,
                    ),
                    else_=0,
                )
            ).label("br_ok"),
            func.sum(
                case(
                    (
                        (col(Attempt.mode) == timed_mode)
                        & (col(Question.source) == official)
                        & (col(Attempt.is_correct).is_(True)),
                        1,
                    ),
                    else_=0,
                )
            ).label("off_correct"),
            func.sum(
                case(
                    (
                        (col(Attempt.mode) == timed_mode)
                        & (col(Question.source) == official),
                        1,
                    ),
                    else_=0,
                )
            ).label("off_total"),
        )
        .join(Question, col(Attempt.question_id) == col(Question.id), isouter=True)
        .group_by(col(Attempt.session_id))
    ).all()

    stats: dict[int, tuple] = {row[0]: row[1:] for row in agg}

    out = []
    for s in sessions:
        row = stats.get(s.id)
        qc = int(row[0] or 0) if row else 0
        br_n = int(row[1] or 0) if row else 0
        br_ok = int(row[2] or 0) if row else 0
        off_correct = int(row[3] or 0) if row else 0
        off_total = int(row[4] or 0) if row else 0
        duration_sec = None
        if s.ended:
            duration_sec = max(0, int((s.ended - s.started).total_seconds()))
        out.append({
            "id": s.id,
            "type": s.type.value,
            "started": s.started.isoformat(),
            "ended": s.ended.isoformat() if s.ended else None,
            "scaled_score": s.scaled_score,
            "question_count": qc,
            "duration_sec": duration_sec,
            "br_accuracy": (
                round(br_ok / br_n, 4) if br_n else None
            ),
            "official_only_score": (
                scoring.predict_scaled(off_correct, off_total)
                if off_total else None
            ),
        })
    return paginate(out, limit=limit, offset=offset)


@router.post("/sessions")
def create_session(body: SessionCreate, session: Session = Depends(get_session)):
    s = StudySession(type=body.type, config_json=body.config)
    session.add(s)
    session.commit()
    session.refresh(s)
    return {"id": s.id, "type": s.type.value, "started": s.started.isoformat()}


@router.get("/sessions/{session_id}/questions")
def session_questions(session_id: int, session: Session = Depends(get_session)):
    """A drill / smart-set session's curated questions as a SECTION-shaped payload.

    Drills and playlists create a ``StudySession`` (no ``Section``) and persist the
    selected ``question_ids`` on ``config_json``. The runner plays them via
    ``/take/session/:id`` → this endpoint, which mirrors ``GET /sections/{id}``
    (test-mode, answer key withheld) so the same SectionRunner renders the set.
    ``id`` is the session id, used by the runner as its "section" id and as the
    existing session for attempts (no new section session is created).
    """
    s = session.get(StudySession, session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    cfg = s.config_json or {}
    qids: list[int] = [int(q) for q in (cfg.get("question_ids") or [])]
    by_id: dict[int, Question] = {}
    if qids:
        rows = session.exec(
            serializers.servable_questions(
                select(Question).where(col(Question.id).in_(qids))
            )
        ).all()
        by_id = {q.id: q for q in rows}
    # Preserve the stored order; drop any since-deleted questions.
    questions = [by_id[qid] for qid in qids if qid in by_id]
    passage_ids = {q.passage_id for q in questions if q.passage_id is not None}
    passages = (
        session.exec(select(Passage).where(col(Passage.id).in_(passage_ids))).all()
        if passage_ids
        else []
    )
    timed = bool(cfg.get("timed", True))
    section_type = cfg.get("section_type") or "LR"
    # ~1:24 per question is a reasonable drill budget; the runner's preset dialog
    # still lets the user switch to untimed.
    time_limit_sec = len(questions) * 84 if timed and questions else None
    return {
        "id": s.id,
        "preptest_id": None,
        "type": section_type,
        "time_limit_sec": time_limit_sec,
        "passages": [
            {"id": p.id, "text": p.text, "type": p.type, "topic": p.topic}
            for p in passages
        ],
        "questions": [serializers.question_test_mode(session, q) for q in questions],
    }


class ReflectionBody(BaseModel):
    text: str = ""
    prompts: list[str] = []


@router.post("/sessions/{session_id}/reflection")
def upsert_reflection(session_id: int, body: ReflectionBody,
                      session: Session = Depends(get_session)):
    """E3: create/update the reflection journal entry for a session."""
    s = session.get(StudySession, session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    refl = session.exec(
        select(Reflection).where(Reflection.session_id == session_id)
    ).first()
    if refl is None:
        refl = Reflection(session_id=session_id, text=body.text, prompts_json=body.prompts)
    else:
        refl.text = body.text
        refl.prompts_json = body.prompts
        refl.updated_at = datetime.now(timezone.utc)
    session.add(refl)
    session.commit()
    session.refresh(refl)
    return {"id": refl.id, "session_id": session_id, "text": refl.text,
            "prompts": refl.prompts_json}


@router.get("/sessions/{session_id}/reflection")
def get_reflection(session_id: int, session: Session = Depends(get_session)):
    refl = session.exec(
        select(Reflection).where(Reflection.session_id == session_id)
    ).first()
    if refl is None:
        return {"exists": False, "session_id": session_id, "text": "", "prompts": []}
    return {
        "exists": True,
        "id": refl.id,
        "session_id": session_id,
        "text": refl.text,
        "prompts": refl.prompts_json,
        "created_at": refl.created_at.isoformat(),
        "updated_at": refl.updated_at.isoformat(),
    }


def _scoped_client_attempt_id(session_id: int, client_attempt_id: str) -> str:
    return f"session:{session_id}:{client_attempt_id}"


def _client_id_candidates(session_id: int, client_attempt_id: str) -> list[str]:
    scoped = _scoped_client_attempt_id(session_id, client_attempt_id)
    return [client_attempt_id] if scoped == client_attempt_id else [client_attempt_id, scoped]


def _find_by_client_id(session: Session, session_id: int,
                       client_attempt_id: Optional[str]):
    """5.2 — existing attempt for a session-scoped idempotency token, else None."""
    if not client_attempt_id:
        return None
    return session.exec(
        select(Attempt)
        .where(Attempt.session_id == session_id)
        .where(Attempt.client_attempt_id.in_(
            _client_id_candidates(session_id, client_attempt_id)
        ))
        .order_by(Attempt.id)
    ).first()


def _build_attempt(session_id: int, body: AttemptCreate, q: Question,
                   client_attempt_id: Optional[str]) -> Attempt:
    return Attempt(
        question_id=body.question_id,
        session_id=session_id,
        mode=body.mode,
        chosen_answer=body.chosen_answer,
        is_correct=body.chosen_answer == q.correct_answer,
        time_ms=body.time_ms,
        flagged=body.flagged,
        confidence=body.confidence,
        client_attempt_id=client_attempt_id,
    )


def _persist_choice_events(session: Session, attempt_id: int,
                           events: list[ChoiceEvent]) -> None:
    """1.2 — persist the process-of-elimination trace for an attempt, if any."""
    for ev in events:
        session.add(AttemptChoiceEvent(
            attempt_id=attempt_id,
            label=ev.label,
            action=ev.action,
            order_index=ev.order_index,
            time_ms=ev.time_ms,
            confidence=ev.confidence,
        ))
    if events:
        session.commit()


def _create_one_attempt(session: Session, session_id: int, body: AttemptCreate,
                        q: Question) -> tuple[int, bool]:
    """Insert one attempt idempotently. Returns ``(attempt_id, created)``.

    5.2 — if ``client_attempt_id`` is set and an attempt in this session already
    carries it, the existing row is returned (``created=False``) and no duplicate
    is written. We check first, then catch the unique-index IntegrityError so a
    concurrent replay (two offline retries racing) still collapses to one row.
    """
    existing = _find_by_client_id(session, session_id, body.client_attempt_id)
    if existing is not None:
        return existing.id, False

    a = _build_attempt(session_id, body, q, body.client_attempt_id)
    session.add(a)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        existing = _find_by_client_id(session, session_id, body.client_attempt_id)
        if existing is not None:
            return existing.id, False
        if body.client_attempt_id:
            # Older DBs have a global unique index on client_attempt_id. Store a
            # scoped token on first cross-session reuse so the API behavior is
            # session-scoped without requiring a risky migration in this slice.
            a = _build_attempt(
                session_id,
                body,
                q,
                _scoped_client_attempt_id(session_id, body.client_attempt_id),
            )
            session.add(a)
            try:
                session.commit()
            except IntegrityError:
                session.rollback()
                existing = _find_by_client_id(
                    session, session_id, body.client_attempt_id
                )
                if existing is not None:
                    return existing.id, False
                raise
            session.refresh(a)
            _persist_choice_events(session, a.id, body.choice_events)
            return a.id, True
        raise
    session.refresh(a)
    _persist_choice_events(session, a.id, body.choice_events)
    return a.id, True


@router.post("/sessions/{session_id}/attempts")
def create_attempt(session_id: int, body: AttemptCreate,
                   session: Session = Depends(get_session)):
    s = session.get(StudySession, session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    q = session.get(Question, body.question_id)
    if not q:
        raise HTTPException(404, "Question not found")
    attempt_id, _created = _create_one_attempt(session, session_id, body, q)
    if _created:
        from .. import adaptivity
        adaptivity.refresh_question_stats(session, body.question_id)
    # Response shape preserved: single create returns just {"attempt_id": ...}.
    return {"attempt_id": attempt_id}


@router.post("/sessions/{session_id}/attempts/batch")
def create_attempts_batch(session_id: int, body: AttemptBatch,
                          session: Session = Depends(get_session)):
    """5.2 — write many attempts in ONE request (the finish-a-section flush).

    Replaces ~25-27 serial POSTs. Each item may carry a ``client_attempt_id`` so
    replaying the whole batch (offline retry) creates zero duplicates, and the
    Wave-1 ``choice_events`` so the PoE trace persists via the batch path too.
    Returns per-item ``{question_id, attempt_id, created}`` plus a summary.
    """
    s = session.get(StudySession, session_id)
    if not s:
        raise HTTPException(404, "Session not found")

    # Pre-load the questions referenced so we don't N+1 and can 404 early.
    qids = {item.question_id for item in body.attempts}
    qmap = {
        q.id: q for q in session.exec(
            select(Question).where(Question.id.in_(qids or {-1}))
        ).all()
    }

    results: list[dict] = []
    created_n = 0
    created_qids: set[int] = set()
    for item in body.attempts:
        q = qmap.get(item.question_id)
        if q is None:
            results.append({
                "question_id": item.question_id,
                "attempt_id": None,
                "created": False,
                "error": "question_not_found",
            })
            continue
        attempt_id, created = _create_one_attempt(session, session_id, item, q)
        if created:
            created_n += 1
            created_qids.add(item.question_id)
        results.append({
            "question_id": item.question_id,
            "attempt_id": attempt_id,
            "created": created,
        })
    if created_qids:
        from .. import adaptivity
        for qid in created_qids:
            adaptivity.refresh_question_stats(session, qid, commit=False)
        session.commit()

    return {
        "results": results,
        "created": created_n,
        "duplicates": sum(
            1 for r in results if r["attempt_id"] is not None and not r["created"]
        ),
        "total": len(results),
    }


@router.patch("/attempts/{attempt_id}/blind-review")
def blind_review(attempt_id: int, body: BlindReview,
                 session: Session = Depends(get_session)):
    a = session.get(Attempt, attempt_id)
    if not a:
        raise HTTPException(404, "Attempt not found")
    q = session.get(Question, a.question_id)
    a.br_answer = body.br_answer
    a.br_correct = body.br_answer == q.correct_answer if q else None
    if body.confidence:
        a.confidence = body.confidence
    session.add(a)
    session.commit()
    from .. import adaptivity
    adaptivity.refresh_question_stats(session, a.question_id)
    # 1.1 — fire the BR->SRS loop now that the BR answer exists. (It does NOT yet
    # exist at timed-finish; the BlindReview screen commits these per attempt
    # afterward, so routing must happen here to work in the real flow.)
    routing = pedagogy.route_one(session, a)
    return {"ok": True, "outcome_routing": routing}


@router.post("/sessions/{session_id}/finish")
def finish_session(session_id: int, session: Session = Depends(get_session)):
    s = session.get(StudySession, session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    if s.ended is None:
        s.ended = datetime.now(timezone.utc)

    attempts = session.exec(
        select(Attempt)
        .where(Attempt.session_id == session_id)
        .where(Attempt.mode != AttemptMode.blind_review)
    ).all()
    # Score prediction uses official questions only.
    qmap = {
        q.id: q for q in session.exec(
            select(Question).where(
                Question.id.in_([a.question_id for a in attempts] or [-1])
            )
        ).all()
    }
    official = [a for a in attempts if qmap.get(a.question_id)
                and qmap[a.question_id].source == QuestionSource.official]
    raw_correct = sum(1 for a in official if a.is_correct)
    total = len(official)
    scaled = scoring.predict_scaled(raw_correct, total) if total else None
    if scaled is not None:
        s.scaled_score = scaled
    session.add(s)
    session.commit()

    # 1.1 — close the Blind-Review loop: route the 2x2 outcomes into SRS /
    # pacing-drill actions. Idempotent, so re-finishing won't duplicate cards.
    routing = pedagogy.route_outcomes(session, session_id)

    resp: dict[str, Any] = {
        "raw_correct": raw_correct,
        "total": total,
        "ended": s.ended.isoformat() if s.ended else None,
        "outcome_routing": routing,
    }
    if scaled is not None:
        resp["scaled_score"] = scaled
    return resp


@router.get("/sessions/{session_id}/results")
def session_results(session_id: int, session: Session = Depends(get_session)):
    s = session.get(StudySession, session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    attempts = session.exec(
        select(Attempt)
        .where(Attempt.session_id == session_id)
        .where(Attempt.mode != AttemptMode.blind_review)
        .order_by(Attempt.id)
    ).all()
    items = []
    for a in attempts:
        q = session.get(Question, a.question_id)
        if not q:
            continue
        items.append({
            "question": serializers.question_review_mode(session, q),
            "attempt": {
                "attempt_id": a.id,
                "chosen_answer": a.chosen_answer,
                "br_answer": a.br_answer,
                "is_correct": a.is_correct,
                "br_correct": a.br_correct,
                "time_ms": a.time_ms,
                "flagged": a.flagged,
                "confidence": a.confidence.value if a.confidence else None,
                "outcome": analytics.blind_review_outcome(a.is_correct, a.br_correct),
                "choice_events": serializers.attempt_choice_events(session, a.id),
            },
        })
    return {
        "session": {
            "id": s.id,
            "type": s.type.value,
            "started": s.started.isoformat(),
            "ended": s.ended.isoformat() if s.ended else None,
            "scaled_score": s.scaled_score,
        },
        "items": items,
    }
