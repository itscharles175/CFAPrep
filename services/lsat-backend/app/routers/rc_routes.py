"""RC intelligence endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session

from .. import rc_intelligence
from ..db import get_session

router = APIRouter(prefix="/rc")


@router.get("/dashboard")
def rc_dashboard(session: Session = Depends(get_session)):
    return rc_intelligence.rc_dashboard(session)


@router.get("/passages")
def passage_maps(
    limit: int = Query(default=50, ge=1, le=200),
    session: Session = Depends(get_session),
):
    return rc_intelligence.list_passage_maps(session, limit=limit)


@router.get("/passages/{passage_id}/map")
def passage_map(
    passage_id: int,
    persist: bool = Query(default=True),
    session: Session = Depends(get_session),
):
    try:
        return rc_intelligence.analyze_passage(session, passage_id, persist=persist)
    except ValueError as exc:
        if str(exc) == "passage_not_found":
            raise HTTPException(404, "Passage not found") from exc
        raise
