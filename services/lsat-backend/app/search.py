"""Keyword (FTS5) search over the bank — the keyword-recall mode alongside the
semantic cosine layer in ``embeddings.py``.

FTS5 is compiled into SQLite (no extension load). The ``question_fts`` virtual
table + sync triggers are created by migration m013. User input is sanitized into
quoted tokens so arbitrary text can never inject FTS5 operator syntax. Search
never returns correct answers — only id / q_type / source / a stem snippet.
"""
from __future__ import annotations

import logging
import re
from typing import Optional

from sqlalchemy import text
from sqlmodel import Session, select

from .models import Question

log = logging.getLogger("lsatlab.search")

_TOKEN_RE = re.compile(r"\w+", re.UNICODE)


def _fts_query(raw: str) -> str:
    """Free user text -> a safe FTS5 MATCH expression: each word becomes a quoted
    term, implicitly ANDed. "" when there is nothing to search (caller short-circuits)."""
    tokens = _TOKEN_RE.findall(raw or "")
    return " ".join(f'"{t}"' for t in tokens)


def search_questions(session: Session, query: str, *, limit: int = 20,
                     source: Optional[str] = None) -> list[dict]:
    """Top keyword matches over question stem+prompt (servable only), ranked by
    FTS5 relevance. Returns light dicts; never leaks correct answers."""
    match = _fts_query(query)
    if not match:
        return []
    sql = (
        "SELECT q.id FROM question_fts JOIN question q ON q.id = question_fts.rowid "
        "WHERE question_fts MATCH :m AND q.deleted_at IS NULL"
    )
    # B14: cap matches the route's le=100 constraint.
    params: dict = {"m": match, "lim": max(1, min(100, limit))}
    if source:
        sql += " AND q.source = :src"
        params["src"] = source
    sql += " ORDER BY rank LIMIT :lim"
    try:
        ids = [int(r[0]) for r in session.execute(text(sql), params).all()]
    except Exception:
        # FTS table absent (pre-m013) or a malformed match — degrade to no results.
        # B32: log the failure so debugging FTS issues leaves a trace.
        log.warning("fts5_search failed", exc_info=True)
        return []
    if not ids:
        return []
    # B6: bulk-fetch all matching questions in one query then re-sort to FTS rank order.
    q_map = {
        q.id: q
        for q in session.exec(select(Question).where(Question.id.in_(ids))).all()
    }
    out: list[dict] = []
    for qid in ids:
        q = q_map.get(qid)
        if q is None:
            continue
        out.append({
            "question_id": q.id,
            "q_type": q.q_type,
            "source": q.source.value if hasattr(q.source, "value") else str(q.source),
            "stem": (q.stem or "")[:200],
        })
    return out
