"""1.1 — Close the Blind-Review loop: route 2x2 outcomes into action.

The 2x2 BR outcome used to be a label only (analytics + the results screen). This
module turns each outcome into a concrete pedagogical action when a session is
finished, so the product's signature loop actually drives study:

  - concept_gap    -> ensure an SRS card (origin="concept_gap"): needs teaching.
  - lucky          -> ensure an SRS card (origin="lucky") AND pull it due SOON:
                      guessed-right knowledge is fragile, resurface it fast.
  - timing_problem -> NO concept card (the concept is fine); instead these are
                      retrievable via ``pacing_queue`` for a pacing drill.
  - timed_ok       -> nothing.

Everything here is idempotent: re-finishing a session must not create duplicate
cards or keep pulling due dates earlier, because there is one card per question
and ``ensure_card``/``pull_due_sooner`` are no-ops once satisfied.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlmodel import Session, select

from . import srs
from .analytics import blind_review_outcome
from .models import Attempt, AttemptMode, Question, SRSCard


def _empty_summary() -> dict:
    return {
        "concept_gap_cards": 0,
        "lucky_cards": 0,
        "lucky_pulled_sooner": 0,
        "timing_problems": 0,
        "counts": {"concept_gap": 0, "lucky": 0, "timing_problem": 0, "timed_ok": 0},
    }


def _apply_outcome(session: Session, a: Attempt, summary: dict) -> bool:
    """Apply one attempt's 2x2 outcome to SRS, mutating ``summary`` (route_outcomes
    shape). Returns whether anything changed. Idempotent; never commits."""
    # Only attempts that were actually blind-reviewed get true 2x2 routing;
    # without a BR answer the outcome is a timed-only fallback we don't act on.
    if a.br_answer is None:
        return False
    outcome = blind_review_outcome(a.is_correct, a.br_correct)
    summary["counts"][outcome] = summary["counts"].get(outcome, 0) + 1
    changed = False
    if outcome == "concept_gap":
        _card, created = srs.ensure_card(
            session, a.question_id, origin="concept_gap", commit=False
        )
        if created:
            summary["concept_gap_cards"] += 1
            changed = True
    elif outcome == "lucky":
        card, created = srs.ensure_card(
            session, a.question_id, origin="lucky", commit=False
        )
        if created:
            summary["lucky_cards"] += 1
            changed = True
        # Fragile: make sure it resurfaces soon whether new or pre-existing.
        if srs.pull_due_sooner(session, card, commit=False):
            summary["lucky_pulled_sooner"] += 1
            changed = True
    elif outcome == "timing_problem":
        # No concept card — the concept is solid. Just count it; it's retrievable
        # for a pacing drill via ``pacing_queue`` below.
        summary["timing_problems"] += 1
    return changed


def route_outcomes(session: Session, study_session_id: int) -> dict:
    """Walk a session's (non-BR) attempts and route each 2x2 outcome to action.

    Returns a small summary of what changed so the finish endpoint can surface it
    and tests can assert on it. Safe to call repeatedly (idempotent).

    Note: in the real flow BR answers are committed *after* the timed section
    finishes (the BlindReview screen PATCHes them per attempt), so this call at
    finish time is a near no-op — ``route_one`` (invoked from the blind-review
    endpoint) is what fires the loop. This remains for review/drill sessions
    where BR data already exists at finish, and as an idempotent backstop."""
    attempts = session.exec(
        select(Attempt)
        .where(Attempt.session_id == study_session_id)
        .where(Attempt.mode != AttemptMode.blind_review)
    ).all()
    summary = _empty_summary()
    changed = False
    for a in attempts:
        if _apply_outcome(session, a, summary):
            changed = True
    if changed:
        session.commit()
    return summary


def route_one(session: Session, attempt: Attempt) -> dict:
    """Route a single attempt's 2x2 outcome the moment its BR answer is committed.

    This is the hook that makes the Blind-Review loop actually fire in production,
    where BR happens after the timed finish. Idempotent (one card per question)."""
    summary = _empty_summary()
    if _apply_outcome(session, attempt, summary):
        session.commit()
    return summary


def _outcome_for(a: Attempt) -> str | None:
    if a.br_answer is None:
        return None
    return blind_review_outcome(a.is_correct, a.br_correct)


def concept_gap_queue(session: Session) -> list[dict]:
    """The concept-gap remediation queue: SRS cards created because both the timed
    and BR answers were wrong (origin="concept_gap"), most-recent first.

    Returns a compact, answer-key-free row per card so it can drive a review UI."""
    cards = session.exec(
        select(SRSCard)
        .where(SRSCard.origin == "concept_gap")
        .order_by(SRSCard.id.desc())
    ).all()
    out: list[dict] = []
    for c in cards:
        q = session.get(Question, c.question_id)
        if not q or q.deleted_at is not None:
            continue
        out.append({
            "card_id": c.id,
            "question_id": c.question_id,
            "q_type": q.q_type,
            "difficulty": q.difficulty,
            "due_date": _iso(c.due_date),
            "lapses": c.lapses,
            "origin": c.origin,
        })
    return out


def pacing_queue(session: Session, *, limit: int = 50) -> list[dict]:
    """The timing/pacing queue: questions you got wrong under time but right in
    blind review (timing_problem). These are NOT concept gaps — they need pace
    practice, so they're surfaced here (not as SRS concept cards) for a timed
    pacing drill. Most-recent attempt first, de-duplicated by question."""
    rows = session.exec(
        select(Attempt)
        .where(Attempt.mode != AttemptMode.blind_review)
        .where(Attempt.br_answer.is_not(None))
        .order_by(Attempt.id.desc())
    ).all()
    out: list[dict] = []
    seen: set[int] = set()
    for a in rows:
        if _outcome_for(a) != "timing_problem":
            continue
        if a.question_id in seen:
            continue
        q = session.get(Question, a.question_id)
        if not q or q.deleted_at is not None:
            continue
        seen.add(a.question_id)
        out.append({
            "question_id": a.question_id,
            "q_type": q.q_type,
            "difficulty": q.difficulty,
            "time_ms": a.time_ms,
            "attempt_id": a.id,
            "session_id": a.session_id,
        })
        if len(out) >= limit:
            break
    return out


def _iso(dt: datetime) -> str:
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).isoformat()
