"""Keyword search endpoints (FTS5)."""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict
from sqlmodel import Session

from .. import search
from ..db import get_session

router = APIRouter(prefix="/search")

# B4: constrain source to valid QuestionSource values (prevents arbitrary
# string injection into the SQL source filter).
_SourceLiteral = Optional[Literal["official", "sample", "ai_generated", "research", "reclor"]]


class SearchResultRowOut(BaseModel):
    """One FTS5 hit from ``search.search_questions`` — deliberately answer-key
    free (never includes ``correct_answer``/``is_correct``). ``extra="allow"``
    keeps future additive row keys on the wire without a schema bump."""

    model_config = ConfigDict(extra="allow")

    question_id: int
    q_type: str
    source: str
    stem: str


class SearchQuestionsOut(BaseModel):
    """Envelope for GET /api/search/questions: the echoed query plus the ranked
    result rows (``[]`` on no match / absent FTS table)."""

    model_config = ConfigDict(extra="allow")

    query: str
    results: list[SearchResultRowOut]


@router.get(
    "/questions",
    response_model=SearchQuestionsOut,
    response_model_exclude_unset=True,
)
def search_questions(
    q: str = Query(min_length=1, max_length=200),
    # B14: align route max with search module cap (both 100).
    limit: int = Query(default=20, ge=1, le=100),
    source: _SourceLiteral = Query(default=None),
    session: Session = Depends(get_session),
):
    """Keyword (FTS5) search over question stem + prompt (servable items only)."""
    return {
        "query": q,
        "results": search.search_questions(session, q, limit=limit, source=source),
    }
