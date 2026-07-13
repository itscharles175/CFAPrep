"""Question serialization. The two forms are security-critical:

- test-mode: NEVER leaks is_correct / correct_answer / explanation / trap_type.
- review-mode: adds the answer key, per-choice info, and explanation.
"""
from __future__ import annotations

from typing import Optional

from sqlmodel import Session, select
from sqlmodel.sql.expression import SelectOfScalar

from .models import Attempt, AnswerChoice, AttemptChoiceEvent, Explanation, Question, SRSCard


# --- DATA-2 cross-domain canonical shapes -----------------------------------
# Mirrors src/lib/dataDictionary.ts (the host side of the same contract) and is
# pinned by docs/DATA-DICTIONARY.md. These project the LSAT-native SRSCard /
# Attempt onto the domain-agnostic shapes the host's StorageDriver.crossDomainBridge
# also speaks, so a cross-domain "what's due / how am I doing" read merges both
# planes with one vocabulary (namespaced identity, bucketed difficulty 1-5 ->
# foundation/intermediate/advanced, mastery as a 0..1 fraction). Additive: the
# existing question_test_mode / question_review_mode shapes are unchanged.

# Host Difficulty enum buckets (learningTypes.ts Difficulty).
_HOST_FOUNDATION = "foundation"
_HOST_INTERMEDIATE = "intermediate"
_HOST_ADVANCED = "advanced"


def _clamp_lsat_difficulty(value: object) -> int:
    """Clamp any value into the LSAT integer difficulty range [1, 5]."""
    try:
        rounded = round(float(value))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 3
    return max(1, min(5, rounded))


def lsat_difficulty_to_host(difficulty: object) -> str:
    """LSAT difficulty (int 1-5) -> host Difficulty (3 buckets). 1-2 foundation,
    3 intermediate, 4-5 advanced. Non-numeric defaults to the neutral middle.
    Identical rule to dataDictionary.ts ``lsatDifficultyToHost`` (DATA-DICTIONARY §2)."""
    if difficulty is None:
        return _HOST_INTERMEDIATE
    try:
        float(difficulty)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return _HOST_INTERMEDIATE
    d = _clamp_lsat_difficulty(difficulty)
    if d <= 2:
        return _HOST_FOUNDATION
    if d >= 4:
        return _HOST_ADVANCED
    return _HOST_INTERMEDIATE


def cross_domain_id(plane: str, kind: str, native_id: object) -> str:
    """Build the namespaced cross-domain id ``<plane>:<kind>:<nativeId>`` (§1)."""
    return f"{plane}:{kind}:{native_id}"


def cross_domain_review_card(session: Session, card: SRSCard, q: Optional[Question] = None) -> dict:
    """Project an LSAT ``SRSCard`` (+ its ``Question``) onto the canonical
    cross-domain review-card shape (mirrors ``CrossDomainReviewCard``)."""
    if q is None:
        q = session.get(Question, card.question_id)
    title = ""
    difficulty = _HOST_INTERMEDIATE
    empirical = None
    q_type = None
    if q is not None:
        raw = (q.stem or q.prompt or "").strip()
        title = (raw[:79] + "…") if len(raw) > 80 else raw
        difficulty = lsat_difficulty_to_host(q.difficulty)
        empirical = q.empirical_difficulty
        q_type = q.q_type
    if not title:
        title = f"LSAT item {card.question_id}"
    due = card.due_date.isoformat() if card.due_date else None
    return {
        "crossId": cross_domain_id("lsat", "review", card.id),
        "domain": "lsat",
        "questionCrossId": cross_domain_id("lsat", "question", card.question_id),
        "title": title,
        "difficulty": difficulty,
        "empiricalDifficulty": empirical,
        "dueAt": due,
        "itemType": q_type,
        "origin": card.origin,
    }


def cross_domain_attempt(attempt: Attempt) -> dict:
    """Project an LSAT ``Attempt`` onto the canonical cross-domain attempt shape
    (mirrors ``CrossDomainAttempt``). ``time_ms`` -> ``elapsedSeconds`` (§4)."""
    confidence = attempt.confidence
    confidence_value = (
        confidence.value if hasattr(confidence, "value") else confidence
    )
    elapsed = round(attempt.time_ms / 1000) if attempt.time_ms and attempt.time_ms > 0 else None
    created = attempt.created_at.isoformat() if attempt.created_at else None
    return {
        "crossId": cross_domain_id("lsat", "attempt", attempt.id),
        "domain": "lsat",
        "questionCrossId": cross_domain_id("lsat", "question", attempt.question_id),
        "correct": bool(attempt.is_correct),
        "chosenAnswer": attempt.chosen_answer,
        "confidence": confidence_value,
        "elapsedSeconds": elapsed,
        "createdAt": created,
    }


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
