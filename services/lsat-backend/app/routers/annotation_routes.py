"""Annotation CRUD (H1/C1/C2): highlights/underlines/notes for a question.

Scoped to an attempt (a specific take, cross-device) or to a question
(cross-attempt). The mark shape is opaque JSON owned by the UI; the backend just
persists ``{"highlights": [...]}`` (and any future keys) per (scope, ref_id).
The frontend tries attempt scope first, then question scope, so both are served.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm.attributes import flag_modified
from sqlmodel import Session, select

from ..db import get_session
from ..models import Annotation, Attempt, Question

router = APIRouter()


class AnnotationBody(BaseModel):
    highlights: list[Any] = []


def _get(session: Session, scope: str, ref_id: int) -> Annotation | None:
    return session.exec(
        select(Annotation)
        .where(Annotation.scope == scope)
        .where(Annotation.ref_id == ref_id)
    ).first()


def _read(session: Session, scope: str, ref_id: int) -> dict:
    row = _get(session, scope, ref_id)
    return row.data_json if row else {"highlights": []}


def _upsert(session: Session, scope: str, ref_id: int, data: dict) -> dict:
    row = _get(session, scope, ref_id)
    if row is None:
        row = Annotation(scope=scope, ref_id=ref_id, data_json=data)
    else:
        row.data_json = data
        flag_modified(row, "data_json")
    session.add(row)
    session.commit()
    return data


def _delete(session: Session, scope: str, ref_id: int) -> bool:
    row = _get(session, scope, ref_id)
    if row is None:
        return False
    session.delete(row)
    session.commit()
    return True


# --- attempt-scoped (primary; cross-device markup for a specific take) ------
@router.get("/attempts/{attempt_id}/annotations")
def get_attempt_annotations(attempt_id: int, session: Session = Depends(get_session)):
    if not session.get(Attempt, attempt_id):
        raise HTTPException(404, "Attempt not found")
    return _read(session, "attempt", attempt_id)


@router.put("/attempts/{attempt_id}/annotations")
def put_attempt_annotations(attempt_id: int, body: AnnotationBody,
                            session: Session = Depends(get_session)):
    if not session.get(Attempt, attempt_id):
        raise HTTPException(404, "Attempt not found")
    return {"ok": True, **_upsert(session, "attempt", attempt_id, body.model_dump())}


@router.delete("/attempts/{attempt_id}/annotations")
def delete_attempt_annotations(attempt_id: int, session: Session = Depends(get_session)):
    return {"ok": _delete(session, "attempt", attempt_id)}


# --- question-scoped (cross-attempt; UI fallback) ---------------------------
@router.get("/questions/{question_id}/annotations")
def get_question_annotations(question_id: int, session: Session = Depends(get_session)):
    if not session.get(Question, question_id):
        raise HTTPException(404, "Question not found")
    return _read(session, "question", question_id)


@router.put("/questions/{question_id}/annotations")
@router.post("/questions/{question_id}/annotations")
def put_question_annotations(question_id: int, body: AnnotationBody,
                             session: Session = Depends(get_session)):
    if not session.get(Question, question_id):
        raise HTTPException(404, "Question not found")
    return {"ok": True, **_upsert(session, "question", question_id, body.model_dump())}


@router.delete("/questions/{question_id}/annotations")
def delete_question_annotations(question_id: int, session: Session = Depends(get_session)):
    return {"ok": _delete(session, "question", question_id)}
