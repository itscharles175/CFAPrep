"""Keyword search endpoints (FTS5)."""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, Query
from sqlmodel import Session

from .. import search
from ..db import get_session

router = APIRouter(prefix="/search")

# B4: constrain source to valid QuestionSource values (prevents arbitrary
# string injection into the SQL source filter).
_SourceLiteral = Optional[Literal["official", "sample", "ai_generated", "research", "reclor"]]


@router.get("/questions")
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
