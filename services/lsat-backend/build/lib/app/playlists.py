"""6.1 — Playlists ("Smart sets"): saved, replayable problem sets.

A Playlist is either:
  - kind="manual": an explicit, pinned list of question ids (``question_ids_json``).
  - kind="smart":  a saved FILTER (``criteria_json``) evaluated live against the
                   user's questions + attempts, so e.g. "all my Flaw misses in
                   PT70-80" stays current as more attempts accrue.

This module owns all DB logic + the smart-set resolver; the router in
``routers/playlist_routes.py`` is a thin shell over it. Resolution always runs
through the shared soft-delete filter (``serializers.servable_questions``) so a
tombstoned question can never re-enter a set, an export, or a replay.

Schema (defined in models.Playlist, from Wave 0):
    Playlist(id, name, kind, criteria_json: dict, question_ids_json: list,
             created_at, updated_at)
``bank_export`` already serializes Playlist into the portable backup, so storing
the set server-side (rather than re-deriving it on the client) is the right design.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlmodel import Session, select

from . import serializers
from .analytics import blind_review_outcome
from .models import (
    Attempt,
    AttemptMode,
    Passage,
    Playlist,
    Question,
    QuestionSource,
    Section,
)

# Smart-set criteria vocabulary (every supported key). All keys are OPTIONAL and
# ANDed together; an empty/absent criteria set therefore matches every servable
# question. Documented here so the router can echo it and tests can assert it.
CRITERIA_KEYS: tuple[str, ...] = (
    "q_type",                 # exact q_type, e.g. "Flaw"
    "section_type",           # "LR" | "RC"
    "source",                 # QuestionSource value, e.g. "official" | "sample"
    "difficulty",             # exact difficulty band 1-5
    "flagged",                # bool — question has any flagged attempt
    "outcome",                # concept_gap | lucky | timing_problem | timed_ok
    "preptest_ids",           # list[int] — restrict to these PrepTests
    "preptest_name_contains", # str — substring match on PrepTest.name (case-insensitive)
    "passage_type",           # str — Passage.type, e.g. "comparative" | "single"
    "incorrect_only",         # bool — question has at least one wrong practice attempt
    "limit",                  # int — cap the resolved set size
)

VALID_KINDS = ("smart", "manual")


# --- CRUD -------------------------------------------------------------------
def _validate_kind(kind: str) -> str:
    if kind not in VALID_KINDS:
        raise ValueError(f"Invalid playlist kind: {kind!r}")
    return kind


def _serialize(pl: Playlist) -> dict:
    """Stable dict shape for a Playlist (CRUD responses)."""
    return {
        "id": pl.id,
        "name": pl.name,
        "kind": pl.kind,
        "criteria": pl.criteria_json or {},
        "question_ids": pl.question_ids_json or [],
        "created_at": pl.created_at.isoformat() if pl.created_at else None,
        "updated_at": pl.updated_at.isoformat() if pl.updated_at else None,
    }


def create(
    session: Session,
    *,
    name: str,
    kind: str = "smart",
    criteria: Optional[dict] = None,
    question_ids: Optional[list[int]] = None,
) -> dict:
    """Create a playlist. ``kind`` defaults to "smart" and must be supported."""
    kind = _validate_kind(kind)
    pl = Playlist(
        name=name,
        kind=kind,
        criteria_json=criteria or {},
        question_ids_json=list(question_ids or []),
    )
    session.add(pl)
    session.commit()
    session.refresh(pl)
    return _serialize(pl)


def list_all(session: Session) -> list[dict]:
    """All playlists, most-recently-created first, each with its live resolved
    count so the list view can show how many questions a set currently matches."""
    rows = session.exec(select(Playlist).order_by(Playlist.id.desc())).all()
    out = []
    for pl in rows:
        data = _serialize(pl)
        n = len(resolve(session, pl))
        data["resolved_count"] = n
        data["count"] = n  # alias the list UI reads
        out.append(data)
    return out


def get(session: Session, playlist_id: int) -> Optional[Playlist]:
    return session.get(Playlist, playlist_id)


def detail(session: Session, pl: Playlist) -> dict:
    """Serialized playlist + the live resolved count (so the list/detail view can
    show how many questions a smart set currently matches)."""
    data = _serialize(pl)
    n = len(resolve(session, pl))
    data["resolved_count"] = n
    data["count"] = n  # alias the list/detail UI reads
    return data


def update(
    session: Session,
    pl: Playlist,
    *,
    name: Optional[str] = None,
    kind: Optional[str] = None,
    criteria: Optional[dict] = None,
    question_ids: Optional[list[int]] = None,
) -> dict:
    """Rename / re-target a playlist. Only provided fields change."""
    if name is not None:
        pl.name = name
    if kind is not None:
        pl.kind = _validate_kind(kind)
    if criteria is not None:
        pl.criteria_json = criteria
    if question_ids is not None:
        pl.question_ids_json = list(question_ids)
    pl.updated_at = datetime.now(timezone.utc)
    session.add(pl)
    session.commit()
    session.refresh(pl)
    return _serialize(pl)


def delete(session: Session, pl: Playlist) -> None:
    session.delete(pl)
    session.commit()


# --- resolution -------------------------------------------------------------
def _servable_map(session: Session) -> dict[int, Question]:
    """All NON-soft-deleted questions keyed by id (single source of truth for
    every resolve path, so a tombstoned question never leaks into a set)."""
    rows = session.exec(serializers.servable_questions()).all()
    return {q.id: q for q in rows}


def _attempt_index(session: Session) -> dict[int, list[Attempt]]:
    """Practice + BR attempts grouped by question id, used by the attempt-derived
    criteria (flagged / incorrect_only / outcome)."""
    rows = session.exec(select(Attempt)).all()
    idx: dict[int, list[Attempt]] = {}
    for a in rows:
        idx.setdefault(a.question_id, []).append(a)
    return idx


def _question_outcome(attempts: list[Attempt]) -> Optional[str]:
    """The 2x2 blind-review outcome for a question, computed from its MOST RECENT
    practice attempt (timed/drill) via ``analytics.blind_review_outcome``.

    Mirrors how the results screen labels an attempt: a timed/drill attempt with a
    BR answer yields the full 2x2 (concept_gap/lucky/timing_problem/timed_ok); one
    without a BR answer falls back to the timed-only label (timed_ok / concept_gap).
    Returns None when the question has no practice attempt to judge."""
    practice = [a for a in attempts if a.mode in (AttemptMode.timed, AttemptMode.drill)]
    if not practice:
        return None
    latest = max(practice, key=lambda a: (a.id or 0))
    return blind_review_outcome(latest.is_correct, latest.br_correct)


def resolve(session: Session, pl: Playlist) -> list[int]:
    """Resolve a playlist to an ordered list of servable question ids.

    - kind="manual": ``question_ids_json`` filtered to currently-servable ids,
      preserving the saved order (soft-deleted/missing ids drop out).
    - kind="smart": every servable question matching ALL of ``criteria_json``
      (see ``CRITERIA_KEYS``), ordered by question id.
    """
    qmap = _servable_map(session)

    if pl.kind == "manual":
        return [qid for qid in (pl.question_ids_json or []) if qid in qmap]

    return _resolve_smart(session, pl.criteria_json or {}, qmap)


def _resolve_smart(
    session: Session, criteria: dict, qmap: dict[int, Question]
) -> list[int]:
    """Evaluate a smart-set's criteria against the servable questions."""
    q_type = criteria.get("q_type")
    section_type = criteria.get("section_type")
    source = criteria.get("source")
    difficulty = criteria.get("difficulty")
    flagged = criteria.get("flagged")
    outcome = criteria.get("outcome")
    preptest_ids = criteria.get("preptest_ids")
    preptest_name_contains = criteria.get("preptest_name_contains")
    passage_type = criteria.get("passage_type")
    incorrect_only = criteria.get("incorrect_only")
    limit = criteria.get("limit")

    # PrepTest scoping: map PrepTest -> its section ids, so a question's
    # section_id can be tested for membership. Only built when needed.
    allowed_section_ids: Optional[set[int]] = None
    if preptest_ids or preptest_name_contains:
        from .models import PrepTest

        pt_ids: set[int] = set()
        if preptest_ids:
            pt_ids.update(int(i) for i in preptest_ids)
        if preptest_name_contains:
            needle = str(preptest_name_contains).lower()
            for pt in session.exec(select(PrepTest)).all():
                if needle in (pt.name or "").lower():
                    pt_ids.add(pt.id)
        secs = (
            session.exec(select(Section).where(Section.preptest_id.in_(pt_ids))).all()
            if pt_ids
            else []
        )
        allowed_section_ids = {s.id for s in secs}

    # Passage-type scoping: question.passage_id must reference a passage of this
    # type. Built only when requested.
    allowed_passage_ids: Optional[set[int]] = None
    if passage_type is not None:
        rows = session.exec(
            select(Passage).where(Passage.type == passage_type)
        ).all()
        allowed_passage_ids = {p.id for p in rows}

    # Attempt-derived predicates (flagged / incorrect_only / outcome) only need an
    # attempt index when one of them is requested.
    attempt_idx: dict[int, list[Attempt]] = {}
    if flagged is not None or incorrect_only is not None or outcome is not None:
        attempt_idx = _attempt_index(session)

    matched: list[int] = []
    for qid, q in qmap.items():
        if q_type is not None and q.q_type != q_type:
            continue
        if section_type is not None:
            sec = "RC" if q.passage_id is not None else "LR"
            if sec != section_type:
                continue
        if source is not None:
            qsrc = q.source.value if hasattr(q.source, "value") else q.source
            if qsrc != source:
                continue
        if difficulty is not None and q.difficulty != difficulty:
            continue
        if allowed_section_ids is not None and q.section_id not in allowed_section_ids:
            continue
        if allowed_passage_ids is not None and q.passage_id not in allowed_passage_ids:
            continue

        if flagged is not None or incorrect_only is not None or outcome is not None:
            atts = attempt_idx.get(qid, [])
            if flagged is not None:
                has_flag = any(a.flagged for a in atts)
                if bool(flagged) != has_flag:
                    continue
            if incorrect_only:
                practice = [
                    a for a in atts
                    if a.mode in (AttemptMode.timed, AttemptMode.drill)
                ]
                if not any(not a.is_correct for a in practice):
                    continue
            if outcome is not None:
                if _question_outcome(atts) != outcome:
                    continue

        matched.append(qid)

    matched.sort()
    if isinstance(limit, int) and limit > 0:
        matched = matched[:limit]
    return matched


def resolved_questions(session: Session, pl: Playlist) -> list[Question]:
    """Resolved Question objects, in resolved-id order (servable by construction)."""
    qmap = _servable_map(session)
    return [qmap[qid] for qid in resolve(session, pl) if qid in qmap]
