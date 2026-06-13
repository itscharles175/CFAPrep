"""Question serialization. The two forms are security-critical:

- test-mode: NEVER leaks is_correct / correct_answer / explanation / trap_type.
- review-mode: adds the answer key, per-choice info, and explanation.
"""
from __future__ import annotations

from typing import Optional

from sqlmodel import Session, select
from sqlmodel.sql.expression import SelectOfScalar

from .models import AnswerChoice, AttemptChoiceEvent, Explanation, Question


# --- 5.4 shared soft-delete filter ------------------------------------------
def servable_questions(stmt: "SelectOfScalar | None" = None) -> "SelectOfScalar":
    """Return a ``select(Question)`` (or refine the one passed) restricted to
    NON-soft-deleted questions.

    A single source of truth so a tombstoned (``deleted_at`` set) question never
    leaks into a section view, export, or analytics. Pass an existing statement
    to add the filter to it; omit to start a fresh ``select(Question)``."""
    if stmt is None:
        stmt = select(Question)
    return stmt.where(Question.deleted_at.is_(None))


def is_servable(q: Question) -> bool:
    """In-Python counterpart for callers that already hold a Question object."""
    return getattr(q, "deleted_at", None) is None


def attempt_choice_events(session: Session, attempt_id: int) -> list[dict]:
    """1.2 — the process-of-elimination trace for an attempt, in event order.

    Surfaced in review mode so a finished attempt can be replayed (which choices
    were eliminated/selected, in what order, and when)."""
    rows = session.exec(
        select(AttemptChoiceEvent)
        .where(AttemptChoiceEvent.attempt_id == attempt_id)
        .order_by(AttemptChoiceEvent.order_index, AttemptChoiceEvent.id)
    ).all()
    return [
        {
            "label": e.label,
            "action": e.action,
            "order_index": e.order_index,
            "time_ms": e.time_ms,
            "confidence": e.confidence,
        }
        for e in rows
    ]


def _choices(session: Session, question_id: int) -> list[AnswerChoice]:
    rows = session.exec(
        select(AnswerChoice).where(AnswerChoice.question_id == question_id)
    ).all()
    return sorted(rows, key=lambda c: c.label)


def question_test_mode(session: Session, q: Question, card_id: Optional[int] = None) -> dict:
    """Test-mode shape. Deliberately omits all answer-key information."""
    data = {
        "id": q.id,
        "section_id": q.section_id,
        "passage_id": q.passage_id,
        "prompt": q.prompt,
        "stem": q.stem,
        "q_type": q.q_type,
        "difficulty": q.difficulty,
        "source": q.source.value if hasattr(q.source, "value") else q.source,
        "choices": [
            {"id": c.id, "label": c.label, "text": c.text}
            for c in _choices(session, q.id)
        ],
    }
    if card_id is not None:
        data["card_id"] = card_id
    return data


def question_review_mode(session: Session, q: Question) -> dict:
    """Review-mode shape: full answer key + explanation."""
    data = question_test_mode(session, q)
    data["correct_answer"] = q.correct_answer
    data["parent_question_id"] = q.parent_question_id
    data["choices"] = [
        {
            "id": c.id,
            "label": c.label,
            "text": c.text,
            "is_correct": c.is_correct,
            "trap_type": c.trap_type,
        }
        for c in _choices(session, q.id)
    ]
    exp = session.exec(
        select(Explanation)
        .where(Explanation.question_id == q.id)
        .order_by(Explanation.id.desc())
    ).first()
    if exp:
        data["explanation"] = {
            "id": exp.id,
            "body": exp.body,
            "per_choice": exp.per_choice_json or {},
            "source": exp.source.value if hasattr(exp.source, "value") else exp.source,
        }
    else:
        data["explanation"] = None
    return data
