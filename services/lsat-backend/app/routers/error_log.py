"""Error log (wrong-answer journal): create (+auto AI diagnosis), list, edit, delete."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from .. import ai, config, serializers
from ..db import engine, get_session
from ..models import Attempt, ErrorLogEntry, ErrorReason, Question

router = APIRouter()


class ErrorLogBody(BaseModel):
    reason: ErrorReason
    note: Optional[str] = None


class ErrorLogPatch(BaseModel):
    reason: Optional[ErrorReason] = None
    note: Optional[str] = None


def generate_diagnosis(session: Session, entry_id: int, *, diagnoser=None) -> Optional[str]:
    """Populate ``ai_diagnosis`` for one entry. Best-effort; injectable for tests."""
    diagnoser = diagnoser or ai.error_diagnosis_sync
    entry = session.get(ErrorLogEntry, entry_id)
    if entry is None:
        return None
    attempt = session.get(Attempt, entry.attempt_id)
    q = session.get(Question, attempt.question_id) if attempt else None
    if q is None:
        return None
    try:
        text = diagnoser(
            q.stem,
            entry.reason.value if hasattr(entry.reason, "value") else str(entry.reason),
            entry.user_note or "",
            attempt.chosen_answer,
            q.correct_answer,
        )
    except Exception:
        return None
    if text and text.strip():
        entry.ai_diagnosis = text.strip()
        session.add(entry)
        session.commit()
    return entry.ai_diagnosis


def _bg_diagnose(entry_id: int) -> None:
    with Session(engine) as s:
        generate_diagnosis(s, entry_id)


@router.post("/attempts/{attempt_id}/error-log")
def create_error_log(attempt_id: int, body: ErrorLogBody,
                     background: BackgroundTasks,
                     session: Session = Depends(get_session)):
    a = session.get(Attempt, attempt_id)
    if not a:
        raise HTTPException(404, "Attempt not found")
    entry = ErrorLogEntry(attempt_id=attempt_id, reason=body.reason,
                          user_note=body.note)
    session.add(entry)
    session.commit()
    session.refresh(entry)
    # A6: enrich with a short AI diagnosis off the request path.
    if config.ERRORLOG_AUTODIAGNOSE:
        background.add_task(_bg_diagnose, entry.id)
    return {"id": entry.id}


@router.patch("/error-log/{entry_id}")
def update_error_log(entry_id: int, body: ErrorLogPatch,
                     session: Session = Depends(get_session)):
    entry = session.get(ErrorLogEntry, entry_id)
    if not entry:
        raise HTTPException(404, "Entry not found")
    if body.reason is not None:
        entry.reason = body.reason
    if body.note is not None:
        entry.user_note = body.note
    session.add(entry)
    session.commit()
    return {"ok": True, "id": entry_id}


@router.delete("/error-log/{entry_id}")
def delete_error_log(entry_id: int, session: Session = Depends(get_session)):
    entry = session.get(ErrorLogEntry, entry_id)
    if not entry:
        raise HTTPException(404, "Entry not found")
    session.delete(entry)
    session.commit()
    return {"ok": True}


@router.get("/error-log")
def list_error_log(session: Session = Depends(get_session)):
    entries = session.exec(
        select(ErrorLogEntry).order_by(ErrorLogEntry.id.desc())
    ).all()
    out = []
    for e in entries:
        a = session.get(Attempt, e.attempt_id)
        q = session.get(Question, a.question_id) if a else None
        out.append({
            "id": e.id,
            "question": serializers.question_review_mode(session, q) if q else None,
            "reason": e.reason.value,
            "note": e.user_note,
            "ai_diagnosis": e.ai_diagnosis,
            "created_at": e.created_at.isoformat(),
        })
    return out
