"""6.1 — Playlist ("Smart set") endpoints: thin shell over ``app.playlists``.

  POST   /api/playlists                 create (manual ids OR smart criteria)
  GET    /api/playlists                 list
  GET    /api/playlists/{id}            detail (+ live resolved_count)
  PUT    /api/playlists/{id}            rename / re-target
  DELETE /api/playlists/{id}            delete
  GET    /api/playlists/{id}/questions  resolved set in TEST MODE (no answer key)
  POST   /api/playlists/{id}/play       resolve + create a drill session to play

The two question-bearing endpoints (``/questions`` and ``/play``) serialize via
``serializers.question_test_mode`` so the answer key is NEVER leaked into a
playable payload — the same guarantee a drill or section view gives.
"""
from __future__ import annotations

from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, StringConstraints
from sqlmodel import Session

from .. import playlists, serializers
from ..db import get_session
from ..models import SessionType, StudySession

router = APIRouter()

PlaylistKind = Literal["smart", "manual"]
QuestionId = Annotated[int, Field(gt=0)]
PlaylistName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)
]
CriterionText = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)
]


class PlaylistCriteria(BaseModel):
    q_type: Optional[CriterionText] = None
    section_type: Optional[Literal["LR", "RC"]] = None
    source: Optional[Literal[
        "official", "sample", "ai_generated", "research", "reclor",
    ]] = None
    difficulty: Optional[int] = Field(default=None, ge=1, le=5)
    flagged: Optional[bool] = None
    outcome: Optional[Literal[
        "concept_gap", "lucky", "timing_problem", "timed_ok",
    ]] = None
    preptest_ids: Optional[list[QuestionId]] = Field(default=None, max_length=100)
    preptest_name_contains: Optional[CriterionText] = None
    passage_type: Optional[CriterionText] = None
    incorrect_only: Optional[bool] = None
    limit: Optional[int] = Field(default=None, ge=1, le=500)


class PlaylistCreate(BaseModel):
    name: PlaylistName
    kind: PlaylistKind = "smart"
    criteria: Optional[PlaylistCriteria] = None
    question_ids: Optional[list[QuestionId]] = Field(default=None, max_length=1000)


class PlaylistUpdate(BaseModel):
    name: Optional[PlaylistName] = None
    kind: Optional[PlaylistKind] = None
    criteria: Optional[PlaylistCriteria] = None
    question_ids: Optional[list[QuestionId]] = Field(default=None, max_length=1000)


def _criteria_dict(criteria: Optional[PlaylistCriteria]) -> Optional[dict]:
    if criteria is None:
        return None
    return criteria.model_dump(exclude_none=True)


def _get_or_404(session: Session, playlist_id: int):
    pl = playlists.get(session, playlist_id)
    if pl is None:
        raise HTTPException(404, "Playlist not found")
    return pl


@router.post("/playlists")
def create_playlist(body: PlaylistCreate, session: Session = Depends(get_session)):
    return playlists.create(
        session,
        name=body.name,
        kind=body.kind,
        criteria=_criteria_dict(body.criteria),
        question_ids=body.question_ids,
    )


@router.get("/playlists")
def list_playlists(session: Session = Depends(get_session)):
    return {
        "playlists": playlists.list_all(session),
        # The full smart-set filter vocabulary, so the UI can build a criteria form.
        "criteria_keys": list(playlists.CRITERIA_KEYS),
    }


@router.get("/playlists/{playlist_id}")
def get_playlist(playlist_id: int, session: Session = Depends(get_session)):
    pl = _get_or_404(session, playlist_id)
    return playlists.detail(session, pl)


@router.put("/playlists/{playlist_id}")
def update_playlist(playlist_id: int, body: PlaylistUpdate,
                    session: Session = Depends(get_session)):
    pl = _get_or_404(session, playlist_id)
    return playlists.update(
        session,
        pl,
        name=body.name,
        kind=body.kind,
        criteria=_criteria_dict(body.criteria),
        question_ids=body.question_ids,
    )


@router.delete("/playlists/{playlist_id}")
def delete_playlist(playlist_id: int, session: Session = Depends(get_session)):
    pl = _get_or_404(session, playlist_id)
    playlists.delete(session, pl)
    return {"ok": True}


@router.get("/playlists/{playlist_id}/questions")
def playlist_questions(playlist_id: int, session: Session = Depends(get_session)):
    """The resolved set in TEST MODE — answer key withheld (no ``correct_answer``,
    no ``is_correct``/``trap_type``/explanation), exactly like a section/drill."""
    pl = _get_or_404(session, playlist_id)
    questions = playlists.resolved_questions(session, pl)
    return {
        "playlist_id": pl.id,
        "count": len(questions),
        "questions": [serializers.question_test_mode(session, q) for q in questions],
    }


@router.post("/playlists/{playlist_id}/play")
def play_playlist(playlist_id: int, session: Session = Depends(get_session)):
    """Resolve the set and spin up a drill ``StudySession`` over those questions,
    returning the SAME shape as ``POST /api/drills`` (``session_id`` + test-mode
    questions) so the client can navigate straight into the player."""
    pl = _get_or_404(session, playlist_id)
    questions = playlists.resolved_questions(session, pl)

    # Reuse the drill session-creation path: a SessionType.drill session whose
    # config records the playlist it came from (so history shows its origin).
    s = StudySession(
        type=SessionType.drill,
        config_json={
            "playlist_id": pl.id,
            "playlist_name": pl.name,
            "kind": pl.kind,
            "count": len(questions),
            "timed": True,
            # Persist the resolved set (in order) so /take/session/:id can play
            # exactly these via GET /sessions/{id}/questions.
            "question_ids": [q.id for q in questions],
        },
    )
    session.add(s)
    session.commit()
    session.refresh(s)

    return {
        "session_id": s.id,
        "questions": [serializers.question_test_mode(session, q) for q in questions],
    }
