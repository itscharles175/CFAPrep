"""Full timed exam endpoints: create a multi-section exam, fetch its results.

Also hosts the 3.5 PrepTest scale-table endpoint (a test's real published
raw->scaled conversion), kept here alongside scoring rather than in the read-only
content router.
"""
from __future__ import annotations

from typing import Dict

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session

from .. import exams, scoring
from ..db import get_session
from ..models import PrepTest

router = APIRouter()
exam_router = APIRouter(prefix="/exams")
preptest_router = APIRouter(prefix="/preptests")


class ExamCreate(BaseModel):
    preptest_id: int


class ScaleTableBody(BaseModel):
    # Real published raw->scaled conversion for this test, e.g. {"45": 152, ...}.
    # Keys are raw-correct counts (as strings, per JSON), values are 120-180.
    raw_to_scaled: Dict[str, int]


@exam_router.post("")
def create_exam(body: ExamCreate, session: Session = Depends(get_session)):
    """Start a full timed exam: one session spanning the PrepTest's sections."""
    try:
        return exams.create_exam(session, body.preptest_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc))


@exam_router.get("/{session_id}/results")
def exam_results(session_id: int, session: Session = Depends(get_session)):
    """Per-section breakdown + combined scaled score (official questions only)."""
    try:
        return exams.exam_results(session, session_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc))


@preptest_router.put("/{preptest_id}/scale-table")
def set_scale_table(preptest_id: int, body: ScaleTableBody,
                    session: Session = Depends(get_session)):
    """3.5 — set/replace the PrepTest's real raw->scaled conversion table.

    Validates the shape (integer raw counts -> 120-180 scaled scores); a bad
    payload is rejected with 400. Once set, this test's exam/section scoring uses
    THIS curve instead of the generic representative one (``scale_source`` in the
    results reports which was used)."""
    pt = session.get(PrepTest, preptest_id)
    if not pt:
        raise HTTPException(404, "PrepTest not found")
    table = {"raw_to_scaled": dict(body.raw_to_scaled)}
    try:
        anchors = scoring.parse_scale_table(table)
    except ValueError as exc:
        raise HTTPException(400, f"Invalid scale table: {exc}")
    pt.scale_table_json = table
    session.add(pt)
    session.commit()
    return {
        "preptest_id": preptest_id,
        "scale_table": table,
        "n_anchors": len(anchors or []),
        "scale_source": scoring.SCALE_SOURCE_OFFICIAL,
    }


# Compose both sub-routers under this module's router so main.py's single
# `include_router(exam_routes.router, prefix="/api")` still wires everything.
router.include_router(exam_router)
router.include_router(preptest_router)
