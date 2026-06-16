"""INT-4 — shared study-artifact store.

A narrow, typed CRUD surface over the existing ``StudyArtifact`` SQLModel
(``app/models.py``) so the HOST plane (CFA/Quant explanations) and the LSAT
plane (Socratic tutor notes, rationales, RC maps) can persist their study
artifacts in one canonical, query-able place and retrieve them by question,
topic, or kind.

Routes (all under ``/api/study-artifacts``):

  * ``POST   /``          — create an artifact, returns the created row.
  * ``GET    /``          — list with optional ``?question_id=&topic=&type=``
    filters and BC2 ``?limit=&offset=`` pagination; returns
    ``{items, total, limit, offset, has_more}``.
  * ``GET    /{id}``      — fetch one (404 if missing).
  * ``PUT    /{id}``      — partial update (only sent fields change); 404 if missing.
  * ``DELETE /{id}``      — remove one; returns ``{ok, deleted_id}``; 404 if missing.

Field mapping (the task's vocabulary -> the existing model):
  * ``type``  -> ``StudyArtifact.kind``        (note | rationale | source | map | tutor)
  * ``topic`` -> a member of ``StudyArtifact.tags_json`` (topics are stored as tags)
  * ``question_id`` -> ``StudyArtifact.question_id``

This uses the SQLite-backed backend table directly — the simplest correct path
for a local-only app. A SurrealDB mirror is intentionally NOT built here; that
is a deliberate followup (see the structured-output ``followups``). The
``StudyArtifact`` table already exists (created by ``SQLModel.create_all`` and
indexed by migration 18), so INT-4 adds no new migration.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from ..db import get_session
from ..models import StudyArtifact, utcnow

router = APIRouter(prefix="/study-artifacts")


# --- response_models (inline; INT-4 owns this narrow typed surface) ----------
class StudyArtifactOut(BaseModel):
    """Serialized study artifact. ``type`` mirrors the model's ``kind`` column;
    ``topic`` mirrors the first tag (the canonical topic) while ``tags`` carries
    the full list."""

    id: int
    type: str
    kind: str
    title: str
    body: str = ""
    summary: str = ""
    source_kind: str = "manual"
    q_type: Optional[str] = None
    question_id: Optional[int] = None
    attempt_id: Optional[int] = None
    passage_id: Optional[int] = None
    workspace_id: Optional[int] = None
    visibility: str = "local"
    official_firewall: bool = False
    cloud_allowed: bool = True
    export_eligible: bool = True
    topic: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    meta: dict[str, Any] = Field(default_factory=dict)
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class StudyArtifactListOut(BaseModel):
    """BC2 pagination envelope for the list endpoint."""

    items: list[StudyArtifactOut] = Field(default_factory=list)
    total: int = 0
    limit: int = 50
    offset: int = 0
    has_more: bool = False


class StudyArtifactDeleteOut(BaseModel):
    ok: bool = True
    deleted_id: int


# --- request bodies ----------------------------------------------------------
class StudyArtifactCreate(BaseModel):
    """Create a study artifact. ``type`` maps to the model's ``kind`` column;
    ``topic`` (when given) is prepended to ``tags`` as the canonical topic tag."""

    type: str = Field(default="note", min_length=1, max_length=80)
    title: str = Field(min_length=1, max_length=240)
    body: str = Field(default="", max_length=200000)
    summary: str = Field(default="", max_length=4000)
    source_kind: str = Field(default="manual", max_length=80)
    topic: Optional[str] = Field(default=None, max_length=120)
    tags: list[str] = Field(default_factory=list, max_length=40)
    q_type: Optional[str] = Field(default=None, max_length=80)
    question_id: Optional[int] = Field(default=None, gt=0)
    attempt_id: Optional[int] = Field(default=None, gt=0)
    passage_id: Optional[int] = Field(default=None, gt=0)
    workspace_id: Optional[int] = Field(default=None, gt=0)
    visibility: str = Field(default="local", max_length=40)
    official_firewall: bool = False
    cloud_allowed: bool = True
    export_eligible: bool = True
    meta: dict[str, Any] = Field(default_factory=dict)


class StudyArtifactUpdate(BaseModel):
    """Partial update. Only fields explicitly provided are changed; everything
    else is left as-is (additive / backward-compatible PUT semantics)."""

    type: Optional[str] = Field(default=None, min_length=1, max_length=80)
    title: Optional[str] = Field(default=None, min_length=1, max_length=240)
    body: Optional[str] = Field(default=None, max_length=200000)
    summary: Optional[str] = Field(default=None, max_length=4000)
    source_kind: Optional[str] = Field(default=None, max_length=80)
    topic: Optional[str] = Field(default=None, max_length=120)
    tags: Optional[list[str]] = Field(default=None, max_length=40)
    q_type: Optional[str] = Field(default=None, max_length=80)
    question_id: Optional[int] = Field(default=None, gt=0)
    attempt_id: Optional[int] = Field(default=None, gt=0)
    passage_id: Optional[int] = Field(default=None, gt=0)
    workspace_id: Optional[int] = Field(default=None, gt=0)
    visibility: Optional[str] = Field(default=None, max_length=40)
    official_firewall: Optional[bool] = None
    cloud_allowed: Optional[bool] = None
    export_eligible: Optional[bool] = None
    meta: Optional[dict[str, Any]] = None


# --- helpers -----------------------------------------------------------------
def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if isinstance(value, datetime) else None


def _merge_topic_tags(topic: Optional[str], tags: list[str]) -> list[str]:
    """Store ``topic`` as the canonical (first) tag without duplicating it.

    Topics are persisted in ``tags_json`` so the list filter can match either a
    dedicated topic or a free tag. The topic is placed first so ``_payload``
    can echo it back as the canonical ``topic`` field.
    """
    clean = [str(t) for t in (tags or []) if str(t).strip()]
    if topic and topic.strip():
        t = topic.strip()
        clean = [t] + [x for x in clean if x != t]
    return clean


def _payload(row: StudyArtifact) -> StudyArtifactOut:
    tags = [str(t) for t in (row.tags_json or [])]
    return StudyArtifactOut(
        id=int(row.id) if row.id is not None else 0,
        type=row.kind,
        kind=row.kind,
        title=row.title,
        body=row.body,
        summary=row.summary,
        source_kind=row.source_kind,
        q_type=row.q_type,
        question_id=row.question_id,
        attempt_id=row.attempt_id,
        passage_id=row.passage_id,
        workspace_id=row.workspace_id,
        visibility=row.visibility,
        official_firewall=row.official_firewall,
        cloud_allowed=row.cloud_allowed,
        export_eligible=row.export_eligible,
        topic=tags[0] if tags else None,
        tags=tags,
        meta=row.meta_json or {},
        created_at=_iso(row.created_at),
        updated_at=_iso(row.updated_at),
    )


def _get_or_404(session: Session, artifact_id: int) -> StudyArtifact:
    row = session.get(StudyArtifact, artifact_id)
    if row is None:
        raise HTTPException(404, "Study artifact not found")
    return row


# --- routes ------------------------------------------------------------------
@router.post("", response_model=StudyArtifactOut)
@router.post("/", response_model=StudyArtifactOut)
def create_artifact(
    body: StudyArtifactCreate,
    session: Session = Depends(get_session),
) -> StudyArtifactOut:
    """Persist a host explanation or LSAT Socratic note as a ``StudyArtifact``."""
    row = StudyArtifact(
        kind=body.type,
        title=body.title,
        body=body.body,
        summary=body.summary,
        source_kind=body.source_kind,
        q_type=body.q_type,
        question_id=body.question_id,
        attempt_id=body.attempt_id,
        passage_id=body.passage_id,
        workspace_id=body.workspace_id,
        visibility=body.visibility,
        official_firewall=body.official_firewall,
        cloud_allowed=body.cloud_allowed,
        export_eligible=body.export_eligible,
        tags_json=_merge_topic_tags(body.topic, body.tags),
        meta_json=body.meta or {},
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return _payload(row)


@router.get("", response_model=StudyArtifactListOut)
@router.get("/", response_model=StudyArtifactListOut)
def list_artifacts(
    question_id: Optional[int] = Query(default=None, gt=0),
    topic: Optional[str] = Query(default=None, max_length=120),
    type: Optional[str] = Query(default=None, max_length=80),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_session),
) -> StudyArtifactListOut:
    """List artifacts, newest first, filtered by question/topic/type with BC2
    ``limit``/``offset`` pagination.

    ``question_id`` and ``type`` (``kind``) are scalar columns filtered in SQL.
    ``topic`` matches an artifact whose ``tags_json`` list contains that exact
    tag; since ``tags_json`` is a JSON column (no portable SQL membership
    operator across SQLite here), that match is applied in Python after the
    scalar filters have narrowed the rows.
    """
    stmt = select(StudyArtifact)
    if question_id is not None:
        stmt = stmt.where(StudyArtifact.question_id == question_id)
    if type is not None:
        stmt = stmt.where(StudyArtifact.kind == type)

    rows = session.exec(stmt.order_by(StudyArtifact.id.desc())).all()  # type: ignore[union-attr]

    if topic is not None and topic.strip():
        needle = topic.strip()
        rows = [r for r in rows if needle in [str(t) for t in (r.tags_json or [])]]

    total = len(rows)
    page = rows[offset : offset + limit]
    return StudyArtifactListOut(
        items=[_payload(r) for r in page],
        total=total,
        limit=limit,
        offset=offset,
        has_more=(offset + len(page)) < total,
    )


@router.get("/{artifact_id}", response_model=StudyArtifactOut)
def get_artifact(
    artifact_id: int,
    session: Session = Depends(get_session),
) -> StudyArtifactOut:
    """Fetch a single artifact by id (404 if missing)."""
    return _payload(_get_or_404(session, artifact_id))


@router.put("/{artifact_id}", response_model=StudyArtifactOut)
def update_artifact(
    artifact_id: int,
    body: StudyArtifactUpdate,
    session: Session = Depends(get_session),
) -> StudyArtifactOut:
    """Partial update: only fields present in the request body are changed."""
    row = _get_or_404(session, artifact_id)
    data = body.model_dump(exclude_unset=True)

    if "type" in data and data["type"] is not None:
        row.kind = data["type"]
    for field in (
        "title",
        "body",
        "summary",
        "source_kind",
        "q_type",
        "question_id",
        "attempt_id",
        "passage_id",
        "workspace_id",
        "visibility",
        "official_firewall",
        "cloud_allowed",
        "export_eligible",
    ):
        if field in data and data[field] is not None:
            setattr(row, field, data[field])

    # Tags/topic: recompute the stored tag list only if either was sent. When
    # only `topic` is sent, preserve the existing free tags; when only `tags` is
    # sent, preserve the existing canonical topic (the current first tag).
    if "tags" in data or "topic" in data:
        existing = [str(t) for t in (row.tags_json or [])]
        new_topic = data.get("topic") if "topic" in data else (existing[0] if existing else None)
        new_tags = data.get("tags") if ("tags" in data and data["tags"] is not None) else existing
        row.tags_json = _merge_topic_tags(new_topic, list(new_tags or []))

    if "meta" in data and data["meta"] is not None:
        row.meta_json = data["meta"]

    row.updated_at = utcnow()
    session.add(row)
    session.commit()
    session.refresh(row)
    return _payload(row)


@router.delete("/{artifact_id}", response_model=StudyArtifactDeleteOut)
def delete_artifact(
    artifact_id: int,
    session: Session = Depends(get_session),
) -> StudyArtifactDeleteOut:
    """Delete a single artifact by id (404 if missing)."""
    row = _get_or_404(session, artifact_id)
    deleted_id = int(row.id) if row.id is not None else artifact_id
    session.delete(row)
    session.commit()
    return StudyArtifactDeleteOut(ok=True, deleted_id=deleted_id)
