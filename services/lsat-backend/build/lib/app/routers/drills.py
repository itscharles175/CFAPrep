"""Drill creation: select real (or ai-generated) questions by type/difficulty."""
from __future__ import annotations

import random
import re
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any, Literal, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import and_, func, or_
from sqlmodel import Session, select

from .. import adaptivity, config, embeddings, pedagogy, serializers
from ..db import get_session
from ..models import (
    LR_TYPES,
    RC_TYPES,
    Attempt,
    AttemptMode,
    Question,
    QuestionSource,
    SectionType,
    SessionType,
    SRSCard,
    StudySession,
)

router = APIRouter()

ShortText = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)
]
DrillSource = Literal["any", "real", "ai"]


class DrillBody(BaseModel):
    q_type: Optional[ShortText] = None
    section_type: Optional[SectionType] = None
    difficulty: Optional[int] = Field(default=None, ge=1, le=5)
    count: int = Field(default=10, ge=1, le=50)
    source: DrillSource = "any"
    timed: bool = True
    # Q3: assemble the set from questions semantically near your recent misses
    # (uses the embedding index; falls back to normal selection when empty).
    near_misses: bool = False
    # 1.1: target questions whose SRS card has this origin (e.g. "concept_gap"),
    # so a drill can directly remediate the Blind-Review concept-gap queue.
    origin: Optional[ShortText] = None


class IntentBody(BaseModel):
    text: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)
    ]


# synonyms -> canonical q_type, longest phrases first so "parallel flaw" wins.
_TYPE_SYNONYMS: list[tuple[str, str]] = [
    ("parallel flaw", "ParallelFlaw"), ("parallel reasoning", "Parallel"),
    ("parallel", "Parallel"), ("necessary assumption", "NecessaryAssumption"),
    ("sufficient assumption", "SufficientAssumption"), ("assumption", "NecessaryAssumption"),
    ("main point", "MainPoint"), ("main idea", "MainPoint"),
    ("most strongly supported", "MostStronglySupported"), ("strengthen", "Strengthen"),
    ("weaken", "Weaken"), ("flaw", "Flaw"), ("principle", "PrincipleApply"),
    ("point at issue", "PointAtIssue"), ("paradox", "Paradox"), ("method", "Method"),
    ("role", "Role"), ("evaluate", "Evaluate"), ("attitude", "Attitude"),
    ("function", "Function"), ("structure", "Structure"), ("comparative", "Comparative"),
    ("inference", "Inference"), ("detail", "Detail"),
]


def parse_drill_intent(text: str) -> dict:
    """Heuristically turn a phrase like '3 harder Parallel, official only' into a
    DrillConfig. Deterministic + offline (no model call needed for short specs)."""
    t = (text or "").lower()

    q_type = None
    for phrase, canon in _TYPE_SYNONYMS:
        if phrase in t:
            q_type = canon
            break

    section_type = None
    if re.search(r"\brc\b|reading", t):
        section_type = "RC"
    elif re.search(r"\blr\b|logical reasoning", t):
        section_type = "LR"
    # an RC-only type implies the RC section.
    if section_type is None and q_type in RC_TYPES and q_type not in LR_TYPES:
        section_type = "RC"

    difficulty = None
    m = re.search(r"(?:difficulty|level)\s*([1-5])", t)
    if m:
        difficulty = int(m.group(1))
    elif "hardest" in t or "very hard" in t:
        difficulty = 5
    elif "harder" in t or "hard" in t or "difficult" in t:
        difficulty = 4
    elif "easier" in t or "easy" in t:
        difficulty = 2

    source = "any"
    if "official" in t or "real" in t:
        source = "real"
    elif re.search(r"\bai\b|generated|synthetic", t):
        source = "ai"

    m = re.search(r"\b(\d{1,2})\b", t)
    count = max(1, min(int(m.group(1)), 50)) if m else 10

    timed = not ("untimed" in t or "no timer" in t)

    return {
        "q_type": q_type,
        "section_type": section_type,
        "difficulty": difficulty,
        "count": count,
        "source": source,
        "timed": timed,
    }


@router.post("/drills/intent")
def drill_intent(body: IntentBody):
    """A8: natural-language drill spec -> a DrillConfig the client can submit."""
    return parse_drill_intent(body.text)


def _keep(q: Question, body: DrillBody) -> bool:
    """Whether a question is eligible for this drill (source/section/type/diff)."""
    if q.deleted_at is not None:  # D5: soft-deleted items are never served
        return False
    # ai-generated must be approved + not quarantined to be served
    if q.source == QuestionSource.ai_generated and (q.quarantined or not q.approved):
        return False
    if body.source == "real" and q.source == QuestionSource.ai_generated:
        return False
    if body.source == "ai" and q.source != QuestionSource.ai_generated:
        return False
    if body.section_type == SectionType.RC and q.passage_id is None:
        return False
    if body.section_type == SectionType.LR and q.passage_id is not None:
        return False
    if body.q_type and q.q_type != body.q_type:
        return False
    if body.difficulty and q.difficulty != body.difficulty:
        return False
    return True


def _near_miss_questions(session: Session, body: DrillBody) -> list[Question]:
    """Q3 — questions semantically near the student's recent misses.

    Only considers misses that are ALREADY embedded so the realtime drill path
    never triggers a model call; returns [] (caller falls back) when the embedding
    index is empty or unavailable."""
    miss_rows = session.exec(
        select(Attempt)
        .where(Attempt.is_correct == False)  # noqa: E712
        .order_by(Attempt.id.desc())
    ).all()
    vectors = embeddings._question_vectors(session)
    miss_ids: list[int] = []
    seen: set[int] = set()
    for a in miss_rows:
        if a.question_id in vectors and a.question_id not in seen:
            seen.add(a.question_id)
            miss_ids.append(a.question_id)
        if len(miss_ids) >= 8:
            break
    if not miss_ids:
        return []
    sim_seen = set(miss_ids)  # don't re-serve the exact missed questions
    out: list[Question] = []
    try:
        for qid in miss_ids:
            for sim in embeddings.similar_questions(session, qid, k=5):
                sid = sim["question_id"]
                if sid in sim_seen:
                    continue
                sim_seen.add(sid)
                q = session.get(Question, sid)
                if q and _keep(q, body):
                    out.append(q)
    except Exception:
        return []
    return out


def _origin_questions(session: Session, body: DrillBody) -> list[Question]:
    """1.1 — questions whose SRS card carries ``body.origin`` (e.g. concept_gap),
    filtered through the usual drill eligibility, most-recent card first."""
    cards = session.exec(
        select(SRSCard).where(SRSCard.origin == body.origin).order_by(SRSCard.id.desc())
    ).all()
    out: list[Question] = []
    seen: set[int] = set()
    for c in cards:
        if c.question_id in seen:
            continue
        q = session.get(Question, c.question_id)
        if q and _keep(q, body):
            seen.add(c.question_id)
            out.append(q)
    return out


def _recently_seen_qids(session: Session, *, days: int) -> set[int]:
    """3.4 — question ids attempted (any practice mode) within the last ``days``,
    so a fresh drill doesn't re-serve items you just saw. ``days<=0`` disables."""
    if days <= 0:
        return set()
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    rows = session.exec(
        select(Attempt.question_id)
        .where(Attempt.mode != AttemptMode.blind_review)
        .where(Attempt.created_at >= cutoff)
    ).all()
    return {qid for qid in rows if qid is not None}


def _selector_for_drill(
    session: Session,
    *,
    q_type: Optional[str],
    section_type: Optional[SectionType],
) -> dict[str, Any] | None:
    """Return the shared Ability Engine selector for a drill request.

    This is deliberately best-effort so drill creation never fails just because
    an analytics snapshot cannot be computed. The returned selector is persisted
    with the session config and echoed to clients as transparent routing
    metadata.
    """
    try:
        return adaptivity.ability_selector(
            session,
            q_type=q_type,
            section_type=section_type,
            days=180,
        )
    except Exception:
        return None


def _target_difficulty(session: Session, q_type: Optional[str]) -> Optional[int]:
    """3.4 / Ability Engine V2 — pick the drill band from the shared ZPD selector.

    Returns None only when no q_type was requested or selector computation fails;
    otherwise the ZPD target is rounded into the authored 1-5 difficulty scale.
    """
    if not q_type:
        return None
    selector = _selector_for_drill(session, q_type=q_type, section_type=None)
    if not selector:
        return None
    zpd = selector.get("zpd") or {}
    target = zpd.get("target_difficulty")
    if target is None:
        return None
    return max(1, min(5, int(round(float(target)))))


def _drill_sql_candidates(session: Session, body: DrillBody, *,
                          exclude_ids: set[int], limit: int) -> list[Question]:
    """Wave 4.1 — push drill eligibility into SQL + RANDOM() sample."""
    stmt = select(Question).where(Question.deleted_at.is_(None))
    stmt = stmt.where(
        or_(
            Question.source != QuestionSource.ai_generated,
            and_(Question.approved == True, Question.quarantined == False),  # noqa: E712
        )
    )
    if body.source == "real":
        stmt = stmt.where(Question.source != QuestionSource.ai_generated)
    elif body.source == "ai":
        stmt = stmt.where(Question.source == QuestionSource.ai_generated)
        stmt = stmt.where(Question.approved == True, Question.quarantined == False)  # noqa: E712
    if body.section_type == SectionType.RC:
        stmt = stmt.where(Question.passage_id.is_not(None))
    elif body.section_type == SectionType.LR:
        stmt = stmt.where(Question.passage_id.is_(None))
    if body.q_type:
        stmt = stmt.where(Question.q_type == body.q_type)
    if body.difficulty:
        stmt = stmt.where(Question.difficulty == body.difficulty)
    if exclude_ids:
        stmt = stmt.where(Question.id.not_in(list(exclude_ids)))
    stmt = stmt.order_by(func.random()).limit(max(limit, 1))
    return list(session.exec(stmt).all())


def _spread_select(
    candidates: list[Question], *, count: int, target_difficulty: Optional[int],
) -> list[Question]:
    """3.4 — randomized, difficulty-aware selection.

    Shuffles so repeated drills of the same type vary, and (when a target band is
    given) draws preferentially from questions AT/NEAR that band before filling
    from the rest — so we target the ability band without ever returning fewer
    than ``count`` when more eligible questions exist."""
    pool = list(candidates)
    random.shuffle(pool)
    if target_difficulty is None:
        return pool[:count]
    # Order by distance from the target band (nearest first), randomized within a
    # band (the shuffle above already randomized; stable sort keeps it varied).
    pool.sort(key=lambda q: abs((q.difficulty or 3) - target_difficulty))
    return pool[:count]


@router.post("/drills")
def create_drill(body: DrillBody, session: Session = Depends(get_session)):
    selector = _selector_for_drill(
        session, q_type=body.q_type, section_type=body.section_type,
    )
    selector_target = None
    if selector:
        zpd = selector.get("zpd") or {}
        raw_target = zpd.get("target_difficulty")
        if raw_target is not None:
            selector_target = max(1, min(5, int(round(float(raw_target)))))

    selected: list[Question] = []
    if body.origin:  # 1.1: remediation drill over an SRS origin (e.g. concept_gap)
        selected = _origin_questions(session, body)[: body.count]
    elif body.near_misses:
        selected = _near_miss_questions(session, body)[: body.count]

    if not selected and not body.origin:  # default selection (near-miss fallback)
        recent = _recently_seen_qids(
            session, days=config.DRILL_EXCLUDE_RECENT_DAYS
        )
        pool_limit = max(body.count * 3, body.count)
        questions = _drill_sql_candidates(
            session, body, exclude_ids=recent, limit=pool_limit,
        )
        if len(questions) < min(body.count, 1):
            questions = _drill_sql_candidates(
                session, body, exclude_ids=set(), limit=pool_limit,
            )
        target = None if body.difficulty else selector_target
        selected = _spread_select(questions, count=body.count, target_difficulty=target)

    selection = {
        "utility_model": "ability_engine_v2",
        "explicit_difficulty": body.difficulty is not None,
        "target_difficulty": body.difficulty or selector_target,
        "selector_strategy": selector.get("strategy") if selector else None,
        "selector_utility_model": selector.get("utility_model") if selector else None,
        "utility_score": (selector.get("utility") or {}).get("score") if selector else None,
        "zpd": selector.get("zpd") if selector else None,
        "recent_exclusion_days": config.DRILL_EXCLUDE_RECENT_DAYS,
        "source": body.source,
        "origin": body.origin,
        "near_misses": body.near_misses,
    }
    s = StudySession(
        type=SessionType.drill,
        config_json={
            "q_type": body.q_type,
            "section_type": body.section_type.value if body.section_type else None,
            "difficulty": body.difficulty,
            "source": body.source,
            "timed": body.timed,
            "count": body.count,
            "origin": body.origin,
            # Persist the curated set (in order) so the runner can play exactly
            # these questions via GET /sessions/{id}/questions — drills have no
            # Section, so /take/session/:id loads them from here.
            "question_ids": [q.id for q in selected],
            "ability_selector": selector,
            "utility_model": "ability_engine_v2",
            "selection": selection,
        },
    )
    session.add(s)
    session.commit()
    session.refresh(s)

    return {
        "session_id": s.id,
        "questions": [serializers.question_test_mode(session, q) for q in selected],
        "ability_selector": selector,
        "utility_model": "ability_engine_v2",
        "selection": selection,
    }


@router.get("/drills/pacing-queue")
def pacing_queue(session: Session = Depends(get_session)):
    """1.1 — the timing/pacing queue: questions answered wrong under time but
    right in blind review (timing_problem). These are pace issues, not concept
    gaps, so they feed a pacing drill rather than the SRS concept queue."""
    items = pedagogy.pacing_queue(session)
    return {"count": len(items), "questions": items}
