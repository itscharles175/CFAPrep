"""Full timed exam mode: assemble a multi-section exam and score it as one sitting.

Why this exists
---------------
``SessionType.full_exam`` and per-question attempt recording already existed, but
nothing assembled a PrepTest's sections into an exam or reported a combined,
multi-section result. This adds that orchestration: one StudySession spans all
sections (the frontend runs each timed, recording attempts under the single
session id), and results aggregate per-section accuracy plus a combined scaled
score over the official questions only (AI/research never feed the score —
docs/01-architecture.md).
"""
from __future__ import annotations

from collections import defaultdict

from sqlmodel import Session, select

from . import scoring
from .models import (
    Attempt,
    AttemptMode,
    PrepTest,
    Question,
    QuestionSource,
    Section,
    SessionType,
    StudySession,
)


def assemble_sections(session: Session, preptest_id: int) -> list[dict]:
    sections = session.exec(
        select(Section)
        .where(Section.preptest_id == preptest_id)
        .order_by(Section.order)
    ).all()
    out = []
    for s in sections:
        qcount = len(
            session.exec(select(Question.id).where(Question.section_id == s.id)).all()
        )
        out.append({
            "section_id": s.id,
            "type": s.type.value if hasattr(s.type, "value") else str(s.type),
            "order": s.order,
            "time_limit_sec": s.time_limit_sec,
            "question_count": qcount,
        })
    return out


def create_exam(session: Session, preptest_id: int) -> dict:
    pt = session.get(PrepTest, preptest_id)
    if pt is None:
        raise ValueError("PrepTest not found")
    sections = assemble_sections(session, preptest_id)
    if not sections:
        raise ValueError("PrepTest has no sections")
    s = StudySession(
        type=SessionType.full_exam,
        config_json={
            "preptest_id": preptest_id,
            "section_ids": [x["section_id"] for x in sections],
        },
    )
    session.add(s)
    session.commit()
    session.refresh(s)
    return {
        "session_id": s.id,
        "preptest_id": preptest_id,
        "name": pt.name,
        "sections": sections,
    }


def _preptest_scale_table(session: Session, s: StudySession) -> dict | None:
    """3.5 — the owning PrepTest's real raw->scaled table for this exam session,
    if one is set. The exam's sections all belong to one PrepTest (recorded in
    config_json at create time); fall back to the section's PrepTest if absent."""
    pt_id = (s.config_json or {}).get("preptest_id")
    if pt_id is None:
        sec_ids = (s.config_json or {}).get("section_ids") or []
        if sec_ids:
            sec = session.get(Section, sec_ids[0])
            pt_id = sec.preptest_id if sec else None
    if pt_id is None:
        return None
    pt = session.get(PrepTest, pt_id)
    return pt.scale_table_json if pt else None


def exam_results(session: Session, session_id: int) -> dict:
    s = session.get(StudySession, session_id)
    if s is None:
        raise ValueError("Session not found")

    attempts = session.exec(
        select(Attempt)
        .where(Attempt.session_id == session_id)
        .where(Attempt.mode != AttemptMode.blind_review)
    ).all()
    # Exclude soft-deleted (tombstoned) questions so a retired item can't keep
    # influencing the exam's scaled score — consistent with analytics, which
    # resolves questions through the same deleted_at filter.
    qmap = {q.id: q for q in session.exec(
        select(Question).where(Question.deleted_at.is_(None))
    ).all()}

    by_section: dict[int, list] = defaultdict(list)
    raw_correct = total = 0
    official_correct = official_total = 0
    official_by_section: dict[int, list[int]] = defaultdict(lambda: [0, 0])  # [correct, total]
    for a in attempts:
        q = qmap.get(a.question_id)
        if q is None:
            continue
        by_section[q.section_id].append(a)
        total += 1
        raw_correct += 1 if a.is_correct else 0
        if q.source == QuestionSource.official:
            official_total += 1
            official_correct += 1 if a.is_correct else 0
            official_by_section[q.section_id][1] += 1
            official_by_section[q.section_id][0] += 1 if a.is_correct else 0

    # 3.5 — use the owning PrepTest's real conversion table when present.
    scale_table = _preptest_scale_table(session, s)

    sections_out = []
    for sec_id, items in by_section.items():
        sec = session.get(Section, sec_id) if sec_id else None
        correct = sum(1 for a in items if a.is_correct)
        off_correct, off_total = official_by_section[sec_id]
        sec_scaled, sec_source = (
            scoring.predict_scaled_with_source(off_correct, off_total, scale_table)
            if off_total else (None, scoring.SCALE_SOURCE_GENERIC)
        )
        sections_out.append({
            "section_id": sec_id,
            "type": (sec.type.value if sec and hasattr(sec.type, "value") else None),
            "correct": correct,
            "total": len(items),
            "accuracy": round(correct / len(items), 4) if items else 0.0,
            # Additive (3.5): per-section scaled estimate over its official questions.
            "scaled_score": sec_scaled,
            "scale_source": sec_source,
        })

    scaled, scale_source = (
        scoring.predict_scaled_with_source(official_correct, official_total, scale_table)
        if official_total else (None, scoring.SCALE_SOURCE_GENERIC)
    )
    return {
        "session_id": session_id,
        "type": s.type.value if hasattr(s.type, "value") else str(s.type),
        "started": s.started.isoformat() if s.started else None,
        "ended": s.ended.isoformat() if s.ended else None,
        "scaled_score": scaled,
        "raw_correct": raw_correct,
        "total": total,
        "official_correct": official_correct,
        "official_total": official_total,
        # Additive (3.5): which curve produced the combined scaled_score.
        "scale_source": scale_source,
        "sections": sorted(sections_out, key=lambda x: (x["section_id"] or 0)),
    }
