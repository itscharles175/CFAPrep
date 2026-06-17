"""LSAT-6 — Annotation as a Notebook knowledge base.

Layered ADDITIVELY on top of the existing scope-based annotation CRUD
(``annotation_routes.py``), this module turns the ``Annotation`` table into a
searchable KB:

- ``GET  /api/annotations/search?q=&limit=`` — FTS5 keyword search over the
  flattened note text + user-authored explanations (LIKE fallback when FTS is
  unavailable), so the user can find every note mentioning "necessary condition".
- ``GET  /api/backlinks/{target}`` — every annotation that links back to a
  ``target`` ref (``question:{id}`` / ``attempt:{id}`` / a free ``tag:{name}``),
  the inverse of the per-question annotation fetch — the wiki backlink panel.
- ``GET/POST /api/annotations/{id}/explanation`` — read / author the
  user-written explanation surfaced beside the AI one on the Explanation page.
- ``PUT  /api/annotations/{id}/tags`` — replace the free tag list.

Every WRITE keeps the FTS5 mirror (``annotation_fts``, migration 25) in sync by
recomputing the flattened ``text`` column the same way the migration backfill
does (``migrations._annotation_search_text`` / ``_annotation_tag_text``) — the
note text lives in opaque ``data_json`` JSON that SQLite triggers cannot unpack,
so the sync is done here in the route layer rather than via triggers.
"""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import get_session
from ..migrations import _annotation_search_text, _annotation_tag_text
from ..models import Annotation

router = APIRouter()


# --- request/response bodies -------------------------------------------------
class ExplanationBody(BaseModel):
    user_explanation: str = ""


class TagsBody(BaseModel):
    tags: list[str] = []


# --- helpers -----------------------------------------------------------------
def _decode_tags(tags_json: str | None) -> list[str]:
    """Decode the stored JSON tag list; tolerant of NULL/malformed -> []."""
    if not tags_json:
        return []
    try:
        tags = json.loads(tags_json)
    except (TypeError, ValueError):
        return []
    return [str(t) for t in tags if t] if isinstance(tags, list) else []


def _annotation_target(row: Annotation) -> str:
    """The canonical ref string an annotation links back FROM/TO, e.g.
    ``question:42`` or ``attempt:7``. Mirrors the scope/ref_id contract."""
    return f"{row.scope}:{row.ref_id}"


def _serialize_hit(row: Annotation, *, snippet: str | None = None) -> dict[str, Any]:
    """Search/backlink wire shape for one annotation (see types.ts
    AnnotationSearchHit / Backlink)."""
    return {
        "annotation_id": row.id,
        "scope": row.scope,
        "ref_id": row.ref_id,
        "target": _annotation_target(row),
        "user_explanation": row.user_explanation or "",
        "tags": _decode_tags(row.tags_json),
        "snippet": snippet if snippet is not None else (row.user_explanation or "")[:280],
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def _sync_fts(session: Session, row: Annotation) -> None:
    """Re-mirror one annotation row into ``annotation_fts`` (idempotent).

    Deletes any prior FTS row for the annotation then re-inserts the freshly
    flattened ``text`` + ``tags``. Best-effort: a SQLite build without FTS5 (the
    table is then absent) is swallowed so a write never fails just because keyword
    search is unavailable (the route layer's LIKE fallback still serves search)."""
    if row.id is None:
        return
    text = _annotation_search_text(row.data_json, row.user_explanation)
    tags = _annotation_tag_text(row.tags_json)
    try:
        conn = session.connection()
        conn.exec_driver_sql(
            "DELETE FROM annotation_fts WHERE annotation_id = ?", (row.id,)
        )
        conn.exec_driver_sql(
            "INSERT INTO annotation_fts(annotation_id, scope, ref_id, text, tags) "
            "VALUES (?, ?, ?, ?, ?)",
            (row.id, row.scope, row.ref_id, text, tags),
        )
    except Exception:  # pragma: no cover - FTS5 unavailable / odd build
        # Keyword search degrades to LIKE; the write itself must still succeed.
        pass


def _get_or_404(session: Session, annotation_id: int) -> Annotation:
    row = session.get(Annotation, annotation_id)
    if row is None:
        raise HTTPException(404, "Annotation not found")
    return row


# --- search ------------------------------------------------------------------
@router.get("/annotations/search")
def search_annotations(
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=100),
    session: Session = Depends(get_session),
):
    """FTS5 keyword search over annotation note text + user explanations + tags.

    Returns ``{"query", "mode", "hits"}``. ``mode`` is ``"fts"`` when the FTS5
    index served the query, ``"like"`` when it fell back (no FTS5 / a malformed
    MATCH expression). The fallback keeps search working on any SQLite build."""
    term = q.strip()
    if not term:
        return {"query": q, "mode": "fts", "hits": []}

    conn = session.connection()
    hits: list[dict[str, Any]] = []
    mode = "fts"
    try:
        # Prefix-match the last token so partial words still hit (e.g. "necess").
        match_expr = " ".join(f"{tok}*" for tok in term.split() if tok) or term
        rows = conn.exec_driver_sql(
            "SELECT annotation_id, snippet(annotation_fts, 3, '[', ']', '…', 12) "
            "FROM annotation_fts WHERE annotation_fts MATCH ? "
            "ORDER BY rank LIMIT ?",
            (match_expr, limit),
        ).fetchall()
        for ann_id, snip in rows:
            row = session.get(Annotation, int(ann_id))
            if row is not None:
                hits.append(_serialize_hit(row, snippet=snip))
    except Exception:
        # FTS5 missing or the MATCH expression was rejected — LIKE fallback over
        # the user_explanation column (the structured note text is in data_json;
        # the explanation is the primary authored search surface).
        mode = "like"
        like = f"%{term}%"
        rows2 = session.exec(
            select(Annotation)
            .where(Annotation.user_explanation.is_not(None))  # type: ignore[union-attr]
            .where(Annotation.user_explanation.like(like))  # type: ignore[union-attr]
            .limit(limit)
        ).all()
        hits = [_serialize_hit(r) for r in rows2]
    return {"query": q, "mode": mode, "hits": hits}


# --- backlinks ---------------------------------------------------------------
# NB: the path is ``/api/annotations/backlinks/{target}`` — deliberately NOT the
# bare ``/api/backlinks/{target}`` that ``notebook_os_routes`` already owns (that
# one returns the notebook artifact backlink list). Namespacing under
# ``annotations`` keeps both inverse indexes independent.
@router.get("/annotations/backlinks/{target:path}")
def get_backlinks(target: str, session: Session = Depends(get_session)):
    """Every annotation that references ``target``.

    ``target`` is either a ``scope:ref_id`` ref (``question:42`` / ``attempt:7``)
    — resolved against the matching annotation row — or a free ``tag:{name}``
    pseudo-ref, which returns every annotation carrying that tag. This is the
    inverse index powering the wiki backlink panel: "what notes point here?"."""
    target = target.strip()
    hits: list[dict[str, Any]] = []

    if target.startswith("tag:"):
        tag = target[len("tag:"):].strip().lower()
        if tag:
            for row in session.exec(
                select(Annotation).where(Annotation.tags_json.is_not(None))  # type: ignore[union-attr]
            ).all():
                if tag in [t.lower() for t in _decode_tags(row.tags_json)]:
                    hits.append(_serialize_hit(row))
        return {"target": target, "count": len(hits), "backlinks": hits}

    # A scope:ref_id ref — return the annotation(s) for that scope/ref.
    scope, _, ref = target.partition(":")
    if scope in {"question", "attempt"} and ref.isdigit():
        rows = session.exec(
            select(Annotation)
            .where(Annotation.scope == scope)
            .where(Annotation.ref_id == int(ref))
        ).all()
        hits = [_serialize_hit(r) for r in rows]
    return {"target": target, "count": len(hits), "backlinks": hits}


# --- user-authored explanation ----------------------------------------------
@router.get("/annotations/{annotation_id}/explanation")
def get_annotation_explanation(
    annotation_id: int, session: Session = Depends(get_session)
):
    row = _get_or_404(session, annotation_id)
    return {
        "annotation_id": row.id,
        "scope": row.scope,
        "ref_id": row.ref_id,
        "target": _annotation_target(row),
        "user_explanation": row.user_explanation or "",
        "tags": _decode_tags(row.tags_json),
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


@router.post("/annotations/{annotation_id}/explanation")
def save_annotation_explanation(
    annotation_id: int,
    body: ExplanationBody,
    session: Session = Depends(get_session),
):
    """Author / replace the user-written explanation on an annotation, then
    re-mirror the row into the FTS index so it becomes searchable."""
    row = _get_or_404(session, annotation_id)
    row.user_explanation = body.user_explanation or None
    from ..models import utcnow

    row.updated_at = utcnow()
    session.add(row)
    _sync_fts(session, row)
    session.commit()
    session.refresh(row)
    return {
        "ok": True,
        "annotation_id": row.id,
        "user_explanation": row.user_explanation or "",
    }


# --- tags --------------------------------------------------------------------
@router.put("/annotations/{annotation_id}/tags")
def save_annotation_tags(
    annotation_id: int, body: TagsBody, session: Session = Depends(get_session)
):
    """Replace an annotation's free tag list (de-duplicated, trimmed), then
    re-mirror it into FTS so tag search + ``tag:`` backlinks stay current."""
    row = _get_or_404(session, annotation_id)
    seen: list[str] = []
    for raw in body.tags:
        t = str(raw).strip()
        if t and t not in seen:
            seen.append(t)
    row.tags_json = json.dumps(seen) if seen else None
    from ..models import utcnow

    row.updated_at = utcnow()
    session.add(row)
    _sync_fts(session, row)
    session.commit()
    session.refresh(row)
    return {"ok": True, "annotation_id": row.id, "tags": _decode_tags(row.tags_json)}
