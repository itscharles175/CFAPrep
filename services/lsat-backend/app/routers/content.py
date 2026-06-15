"""Health + PrepTests / Sections / Questions content endpoints."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, func, select

from .. import ai, embeddings, queries, scoring, serializers
from ..db import get_session
from ..models import (
    Attempt,
    AttemptMode,
    Passage,
    PrepTest,
    Question,
    Section,
    StudySession,
)
from ..pagination import LimitQuery, OffsetQuery, paginate
from ..schemas import PrepTestSummary

router = APIRouter()


@router.get("/health", response_model=dict[str, bool])
def health() -> dict[str, bool]:
    return {"ok": True}


@router.get("/ai/health", response_model=dict[str, Any])
async def ai_health() -> dict[str, Any]:
    return await ai.health()


@router.get("/preptests", response_model=list[PrepTestSummary])
def list_preptests(
    session: Session = Depends(get_session),
    limit: int | None = LimitQuery,
    offset: int | None = OffsetQuery,
):
    # Audit B5 / BC3: a fixed handful of set-based queries (see
    # queries.bulk_preptest_stats) replace the prior O(n) per-preptest loop, so
    # the query count stays flat as the bank grows. Response shape unchanged.
    #
    # BC2: optional limit/offset slice the already-materialized list in Python
    # (zero extra queries); when both are omitted the full list is returned
    # exactly as before, so the host + query-budget gate stay unchanged.
    rows = [
        {
            "id": stat.preptest.id,
            "name": stat.preptest.name,
            "source": stat.preptest.source,
            "date_admin": stat.preptest.date_admin,
            "is_official": stat.preptest.is_official,
            "section_count": stat.section_count,
            "completed_sections": stat.completed_sections,
        }
        for stat in queries.bulk_preptest_stats(session)
    ]
    return paginate(rows, limit=limit, offset=offset)


@router.get("/preptests/{preptest_id}")
def get_preptest(preptest_id: int, session: Session = Depends(get_session)):
    pt = session.get(PrepTest, preptest_id)
    if not pt:
        raise HTTPException(404, "PrepTest not found")
    sections = session.exec(
        select(Section).where(Section.preptest_id == pt.id).order_by(Section.order)
    ).all()
    sec_out = []
    for s in sections:
        qcount = session.exec(
            select(func.count(Question.id)).where(Question.section_id == s.id)
        ).one()
        sec_out.append({
            "id": s.id,
            "type": s.type.value,
            "order": s.order,
            "time_limit_sec": s.time_limit_sec,
            "question_count": qcount,
        })
    return {
        "id": pt.id,
        "name": pt.name,
        "source": pt.source,
        "date_admin": pt.date_admin,
        "is_official": pt.is_official,
        "sections": sec_out,
    }


@router.get("/questions/{question_id}/similar")
def question_similar(question_id: int, k: int = 5,
                     reveal: bool = Query(False),
                     attempt_id: int | None = Query(None),
                     session_id: int | None = Query(None),
                     session: Session = Depends(get_session)):
    """H10/D7: semantically similar questions with a similarity score + source.

    Defaults to test-mode so answer keys never leak from exploratory lookups.
    Review-mode reveal requires the same attempted-question context as direct
    question reveal below.
    """
    q = session.get(Question, question_id)
    if not q:
        raise HTTPException(404, "Question not found")
    if reveal:
        _require_question_review_context(session, question_id, attempt_id, session_id)
    if not embeddings._question_vectors(session):
        return []
    sims = embeddings.similar_questions(session, question_id, k=max(1, min(k, 25)))
    out = []
    for s in sims:
        sq = session.get(Question, s["question_id"])
        if sq is None:
            continue
        data = (
            serializers.question_review_mode(session, sq)
            if reveal
            else serializers.question_test_mode(session, sq)
        )
        data["similarity"] = s["score"]
        out.append(data)
    return out


@router.get("/preptests/{preptest_id}/progress")
def preptest_progress(preptest_id: int, session: Session = Depends(get_session)):
    """Per-section progress for a PrepTest: attempted/total, accuracy, BR%, and a
    section scaled-score estimate (official questions only)."""
    pt = session.get(PrepTest, preptest_id)
    if not pt:
        raise HTTPException(404, "PrepTest not found")
    # BC3: two queries (sections + their questions) via bulk_section_progress
    # replace the prior per-section SELECT loop; per-attempt aggregation below is
    # unchanged so the payload stays byte-identical.
    sec_stats = queries.bulk_section_progress(session, pt.id)
    sections = [st.section for st in sec_stats]
    all_attempts = session.exec(select(Attempt)).all()

    sec_out = []
    for st in sec_stats:
        s = st.section
        q_ids = st.question_ids
        official_ids = st.official_question_ids
        sa = [a for a in all_attempts
              if a.question_id in q_ids and a.mode != AttemptMode.blind_review]
        attempted = len({a.question_id for a in sa})
        correct = sum(1 for a in sa if a.is_correct)
        with_br = [a for a in sa if a.br_answer is not None]
        official_timed = [a for a in sa
                          if a.mode == AttemptMode.timed and a.question_id in official_ids]
        off_raw = sum(1 for a in official_timed if a.is_correct)
        sec_out.append({
            "section_id": s.id,
            "type": s.type.value,
            "order": s.order,
            "question_count": len(q_ids),
            "attempted": attempted,
            "done": attempted >= len(q_ids) and len(q_ids) > 0,
            "accuracy": round(correct / len(sa), 4) if sa else None,
            "br_accuracy": (
                round(sum(1 for a in with_br if a.br_correct) / len(with_br), 4)
                if with_br else None
            ),
            "best_score": (
                scoring.predict_scaled(off_raw, len(official_timed))
                if official_timed else None
            ),
        })

    return {
        "preptest_id": pt.id,
        "name": pt.name,
        "section_count": len(sections),
        "sections_done": sum(1 for s in sec_out if s["done"]),
        "sections": sec_out,
    }


@router.get("/sections/{section_id}")
def get_section(section_id: int, session: Session = Depends(get_session)):
    s = session.get(Section, section_id)
    if not s:
        raise HTTPException(404, "Section not found")
    passages = session.exec(
        select(Passage).where(Passage.section_id == s.id)
    ).all()
    # 5.4: a soft-deleted question must not appear in a section view.
    questions = session.exec(
        serializers.servable_questions(
            select(Question).where(Question.section_id == s.id)
        ).order_by(Question.id)
    ).all()
    return {
        "id": s.id,
        "preptest_id": s.preptest_id,
        "type": s.type.value,
        "time_limit_sec": s.time_limit_sec,
        "passages": [
            {"id": p.id, "text": p.text, "type": p.type, "topic": p.topic}
            for p in passages
        ],
        # TEST-MODE: answers hidden.
        "questions": [serializers.question_test_mode(session, q) for q in questions],
    }


def _require_question_review_context(
    session: Session,
    question_id: int,
    attempt_id: int | None,
    session_id: int | None,
) -> Attempt:
    """Authorize direct review payloads with proof the question was attempted."""
    if attempt_id is not None:
        attempt = session.get(Attempt, attempt_id)
        if not attempt:
            raise HTTPException(404, "Attempt not found")
        if attempt.question_id != question_id:
            raise HTTPException(403, "Attempt does not belong to this question")
        if session_id is not None and attempt.session_id != session_id:
            raise HTTPException(403, "Attempt does not belong to this session")
        return attempt

    if session_id is not None:
        study_session = session.get(StudySession, session_id)
        if not study_session:
            raise HTTPException(404, "Session not found")
        attempt = session.exec(
            select(Attempt)
            .where(Attempt.session_id == session_id)
            .where(Attempt.question_id == question_id)
            .order_by(Attempt.id.desc())
        ).first()
        if attempt is not None:
            return attempt

    raise HTTPException(
        403,
        "Review reveal requires an attempt_id or session_id for this question",
    )


@router.get("/questions/{question_id}")
def get_question(question_id: int, reveal: bool = Query(False),
                 attempt_id: int | None = Query(None),
                 session_id: int | None = Query(None),
                 session: Session = Depends(get_session)):
    q = session.get(Question, question_id)
    if not q:
        raise HTTPException(404, "Question not found")
    if reveal:
        _require_question_review_context(session, question_id, attempt_id, session_id)
        return serializers.question_review_mode(session, q)
    return serializers.question_test_mode(session, q)


@router.delete("/questions/{question_id}")
def soft_delete_question(question_id: int, session: Session = Depends(get_session)):
    """D5 — soft-delete: retire a question from future selection (drills,
    coverage, embeddings) without breaking attempt/SRS FKs or rewriting history."""
    from datetime import datetime, timezone

    q = session.get(Question, question_id)
    if not q:
        raise HTTPException(404, "Question not found")
    q.deleted_at = datetime.now(timezone.utc)
    session.add(q)
    session.commit()
    return {"ok": True, "deleted_at": q.deleted_at.isoformat()}


@router.post("/questions/{question_id}/restore")
def restore_question(question_id: int, session: Session = Depends(get_session)):
    """D5 — undo a soft-delete."""
    q = session.get(Question, question_id)
    if not q:
        raise HTTPException(404, "Question not found")
    q.deleted_at = None
    session.add(q)
    session.commit()
    return {"ok": True}
