"""BC3 — reusable bulk-aggregate query helpers.

These helpers collapse the old O(n) per-entity query loops (one query per
preptest or per section) into a small, fixed number of set-based queries, then
aggregate in Python. Callers (``routers/content.py``) consume them to build the
exact same JSON payloads they built before — the shaping stays in the router;
this module only owns the data access + counting.

Why aggregate in Python rather than pure SQL ``GROUP BY``? The payloads need a
couple of cross-cutting facts (which sections have *any* attempt, which question
ids are official) that the routers already compute set-membership against. Doing
the heavy fan-in here in a handful of ``IN (...)`` queries keeps the query budget
flat with bank size while leaving the byte-identical shaping to the caller.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from sqlmodel import Session, select

from .models import (
    Attempt,
    AttemptMode,
    PrepTest,
    Question,
    QuestionSource,
    Section,
)


@dataclass
class PrepTestStat:
    """Per-preptest rollup used by the ``/preptests`` list view."""

    preptest: PrepTest
    section_count: int = 0
    completed_sections: int = 0


@dataclass
class SectionStat:
    """Per-section rollup used by the ``/preptests/{id}/progress`` view.

    ``question_ids`` / ``official_question_ids`` are the (servable) question ids
    in the section; the caller filters attempts against these sets exactly as the
    pre-BC3 per-section loop did.
    """

    section: Section
    question_ids: set[int] = field(default_factory=set)
    official_question_ids: set[int] = field(default_factory=set)


def bulk_preptest_stats(session: Session) -> list[PrepTestStat]:
    """Per-preptest section counts + completed-section counts in a few queries.

    Replaces a per-preptest loop (which would issue a section + question +
    attempt query for *each* preptest) with three set-based queries total:
    all preptests, all sections, the questions for those sections, and the
    attempts on those questions. A section counts as *completed* when at least
    one attempt (any mode) exists on any of its questions — byte-identical to the
    prior ``list_preptests`` semantics.

    Returned in ``PrepTest`` primary-key/select order so the caller's response
    ordering is unchanged.
    """
    pts = session.exec(select(PrepTest)).all()
    if not pts:
        return []

    all_secs = session.exec(select(Section)).all()
    secs_by_pt: dict[int, list[Section]] = {}
    for s in all_secs:
        secs_by_pt.setdefault(s.preptest_id, []).append(s)

    all_sec_ids = [s.id for s in all_secs]
    q_to_sec: dict[int, int] = {}
    if all_sec_ids:
        qs = session.exec(
            select(Question.id, Question.section_id).where(
                Question.section_id.in_(all_sec_ids)
            )
        ).all()
        q_to_sec = {qid: sid for qid, sid in qs}

    attempted_sec_ids: set[int] = set()
    if q_to_sec:
        attempted_qids = session.exec(
            select(Attempt.question_id)
            .where(Attempt.question_id.in_(list(q_to_sec)))
            .distinct()
        ).all()
        for qid in attempted_qids:
            sid = q_to_sec.get(qid)
            if sid is not None:
                attempted_sec_ids.add(sid)

    out: list[PrepTestStat] = []
    for pt in pts:
        secs = secs_by_pt.get(pt.id, [])
        completed = sum(1 for s in secs if s.id in attempted_sec_ids)
        out.append(
            PrepTestStat(
                preptest=pt,
                section_count=len(secs),
                completed_sections=completed,
            )
        )
    return out


def bulk_section_progress(session: Session, preptest_id: int) -> list[SectionStat]:
    """Per-section question-id sets for one preptest in two queries (sections +
    their questions) instead of one ``SELECT`` per section.

    Sections are returned ordered by ``Section.order`` (matching the prior
    ``preptest_progress`` query), each with the set of its question ids and the
    subset that are official-source — the two membership sets the caller tests
    every attempt against.
    """
    sections = session.exec(
        select(Section)
        .where(Section.preptest_id == preptest_id)
        .order_by(Section.order)
    ).all()
    if not sections:
        return []

    sec_ids = [s.id for s in sections]
    rows = session.exec(
        select(Question.id, Question.section_id, Question.source).where(
            Question.section_id.in_(sec_ids)
        )
    ).all()

    stats = {s.id: SectionStat(section=s) for s in sections}
    for qid, sid, source in rows:
        stat = stats.get(sid)
        if stat is None:
            continue
        stat.question_ids.add(qid)
        if source == QuestionSource.official:
            stat.official_question_ids.add(qid)

    # Preserve Section.order ordering from the sections query.
    return [stats[s.id] for s in sections]


def bulk_attempt_stats_by_question(
    session: Session, question_ids: "set[int] | list[int]"
) -> dict[int, dict[str, int]]:
    """Per-question attempt rollup (timed/drill practice, excluding blind review)
    for a fixed id set, in a single query.

    Returns ``{question_id: {"attempts": n, "correct": c}}``. A small reusable
    aggregate for any view that needs per-question hit counts without looping a
    query per question. Blind-review redo attempts are excluded so the counts
    reflect first-pass practice, matching the analytics convention.
    """
    ids = [i for i in question_ids if i is not None]
    if not ids:
        return {}
    rows = session.exec(
        select(Attempt.question_id, Attempt.is_correct)
        .where(Attempt.question_id.in_(ids))
        .where(Attempt.mode != AttemptMode.blind_review)
    ).all()
    out: dict[int, dict[str, int]] = {}
    for qid, is_correct in rows:
        bucket = out.setdefault(qid, {"attempts": 0, "correct": 0})
        bucket["attempts"] += 1
        if is_correct:
            bucket["correct"] += 1
    return out
