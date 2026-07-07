"""Notebook OS endpoints: evidence graph, sources, notes, chat, jobs, podcasts."""
from __future__ import annotations

from typing import Any

import json
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from .. import embeddings, notebook_os
from ..db import get_session
from ..models import NotebookWorkspace, StudyArtifact

router = APIRouter()

MAX_IMPORT_REFS = 100
MAX_IMPORT_TAGS = 40
MAX_IMPORT_LIST_JSON_CHARS = 50_000


class WorkspaceBody(BaseModel):
    key: str = Field(default="default", max_length=80)
    title: str = Field(default="LSAT Notebook OS", max_length=160)
    description: str = Field(default="", max_length=2000)


class CaptureBody(BaseModel):
    workspace_id: int | None = Field(default=None, gt=0)
    kind: str = Field(default="note", max_length=80)
    title: str = Field(min_length=1, max_length=240)
    body: str = Field(default="", max_length=200000)
    summary: str = Field(default="", max_length=4000)
    source_kind: str = Field(default="manual", max_length=80)
    refs: list[str | dict[str, Any]] = Field(default_factory=list, max_length=100)
    tags: list[str] = Field(default_factory=list, max_length=40)
    q_type: str | None = Field(default=None, max_length=80)
    question_id: int | None = Field(default=None, gt=0)
    attempt_id: int | None = Field(default=None, gt=0)
    passage_id: int | None = Field(default=None, gt=0)
    official_firewall: bool = False
    cloud_allowed: bool = True
    export_eligible: bool = True
    meta: dict[str, Any] = Field(default_factory=dict)


class ArtifactPatchBody(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=240)
    body: str | None = Field(default=None, max_length=200000)
    summary: str | None = Field(default=None, max_length=4000)
    source_kind: str | None = Field(default=None, max_length=80)
    refs: list[str | dict[str, Any]] | None = Field(default=None, max_length=100)
    tags: list[str] | None = Field(default=None, max_length=40)
    q_type: str | None = Field(default=None, max_length=80)
    question_id: int | None = Field(default=None, gt=0)
    attempt_id: int | None = Field(default=None, gt=0)
    passage_id: int | None = Field(default=None, gt=0)
    official_firewall: bool | None = None
    cloud_allowed: bool | None = None
    export_eligible: bool | None = None
    meta: dict[str, Any] | None = None
    reason: str = Field(default="update", max_length=120)


class SourceBody(BaseModel):
    workspace_id: int | None = Field(default=None, gt=0)
    source_registry_key: str | None = Field(default=None, max_length=120)
    source_key: str | None = Field(default=None, max_length=120)
    title: str = Field(min_length=1, max_length=240)
    source_type: str = Field(default="text", max_length=80)
    content_type: str = Field(default="text/plain", max_length=120)
    content: str = Field(default="", max_length=300000)
    provider: str = Field(default="local", max_length=80)
    refs: list[str | dict[str, Any]] = Field(default_factory=list, max_length=100)
    tags: list[str] = Field(default_factory=list, max_length=40)
    official_firewall: bool = False


class ExportBody(BaseModel):
    title: str = Field(default="LSATLab Notebook Export", max_length=240)
    format: Literal["markdown", "html", "json"] = "markdown"
    refs: list[str | dict[str, Any]] = Field(default_factory=list, max_length=200)


class ImportBundleBody(BaseModel):
    workspace_id: int | None = Field(default=None, gt=0)
    title: str = Field(default="Imported notebook bundle", max_length=240)
    format: Literal["auto", "json", "markdown", "html"] = "auto"
    content: str = Field(min_length=1, max_length=2_000_000)
    provider: str = Field(default="local", max_length=80)
    tags: list[str] = Field(default_factory=list, max_length=40)
    official_firewall: bool = False


class NoteBody(BaseModel):
    workspace_id: int | None = Field(default=None, gt=0)
    note_type: str = Field(default="manual", max_length=80)
    title: str = Field(min_length=1, max_length=240)
    content: str = Field(default="", max_length=200000)
    citations: list[str | dict[str, Any]] = Field(default_factory=list, max_length=100)
    tags: list[str] = Field(default_factory=list, max_length=40)


class NotePatchBody(BaseModel):
    note_type: str | None = Field(default=None, max_length=80)
    title: str | None = Field(default=None, min_length=1, max_length=240)
    content: str | None = Field(default=None, max_length=200000)
    citations: list[str | dict[str, Any]] | None = Field(default=None, max_length=100)
    reason: str = Field(default="note_update", max_length=120)


class ChatSessionBody(BaseModel):
    workspace_id: int | None = Field(default=None, gt=0)
    title: str = Field(default="Notebook tutor", max_length=160)
    mode: str = Field(default="summary", max_length=80)
    model: str = Field(default="local", max_length=120)
    context: dict[str, Any] = Field(default_factory=dict)


class ChatTurnBody(BaseModel):
    role: str = Field(default="user", max_length=30)
    content: str = Field(min_length=1, max_length=40000)
    mode: str | None = Field(default=None, max_length=80)
    refs: list[str | dict[str, Any]] = Field(default_factory=list, max_length=100)


class TransformationBody(BaseModel):
    workspace_id: int | None = Field(default=None, gt=0)
    template_key: str = Field(default="summarize", max_length=80)
    title: str | None = Field(default=None, max_length=240)
    prompt: str = Field(default="", max_length=20000)
    input_refs: list[str | dict[str, Any]] = Field(default_factory=list, max_length=100)
    provider: str = Field(default="local", max_length=80)
    model: str = Field(default="local", max_length=120)


class PodcastBody(BaseModel):
    workspace_id: int | None = Field(default=None, gt=0)
    title: str = Field(default="Notebook study briefing", max_length=240)
    episode_type: str = Field(default="weekly_briefing", max_length=80)
    transcript: str | None = Field(default=None, max_length=200000)
    source_refs: list[str | dict[str, Any]] = Field(default_factory=list, max_length=100)
    provider: str = Field(default="local", max_length=80)
    model: str | None = Field(default=None, max_length=120)
    generate_audio: bool = False


class ContextPresetBody(BaseModel):
    workspace_id: int | None = Field(default=None, gt=0)
    name: str = Field(min_length=1, max_length=120)
    modes: dict[str, Any] = Field(default_factory=dict)
    policy: dict[str, Any] = Field(default_factory=dict)


class InboxPatchBody(BaseModel):
    status: str | None = Field(default=None, max_length=40)
    priority: int | None = Field(default=None, ge=0, le=100)
    reason: str | None = Field(default=None, max_length=500)


class GroundingChunk(BaseModel):
    """A host curriculum chunk submitted for cross-domain grounding."""
    id: str | None = Field(default=None, max_length=240)
    document_id: str | None = Field(default=None, max_length=240, alias="documentId")
    domain: str | None = Field(default=None, max_length=80)
    level: str | None = Field(default=None, max_length=80)
    topic: str | None = Field(default=None, max_length=120)
    locator: str = Field(default="", max_length=240)
    text: str = Field(default="", max_length=20000)

    model_config = {"populate_by_name": True}


class CrossDomainGroundingBody(BaseModel):
    """INT-3 — union request: rank the host's curriculum chunks against a query
    and surface matching local notebook sources, so host material and LSAT/
    notebook sources share one grounded retrieval set."""
    query: str = Field(min_length=1, max_length=2000)
    chunks: list[GroundingChunk] = Field(default_factory=list, max_length=200)
    k: int = Field(default=6, ge=1, le=50)
    include_notebook_sources: bool = Field(default=True, alias="includeNotebookSources")

    model_config = {"populate_by_name": True}


@router.get("/notebook-capabilities")
def notebook_capabilities(session: Session = Depends(get_session)):
    return notebook_os.capabilities(session)


@router.get("/notebook-search/health")
def notebook_search_health(session: Session = Depends(get_session)):
    return notebook_os.knowledge_index_health(session)


@router.get("/workspaces")
def list_workspaces(session: Session = Depends(get_session)):
    rows = session.exec(select(NotebookWorkspace).order_by(NotebookWorkspace.updated_at.desc())).all()
    if not rows:
        rows = [notebook_os.default_workspace(session)]
    return [notebook_os.workspace_payload(row) for row in rows]


@router.get("/workspaces/default")
def get_default_workspace(session: Session = Depends(get_session)):
    return notebook_os.workspace_payload(notebook_os.default_workspace(session))


@router.post("/workspaces")
def create_workspace(body: WorkspaceBody, session: Session = Depends(get_session)):
    existing = session.exec(
        select(NotebookWorkspace).where(NotebookWorkspace.key == body.key)
    ).first()
    if existing:
        return notebook_os.workspace_payload(existing)
    row = NotebookWorkspace(key=body.key, title=body.title, description=body.description)
    session.add(row)
    session.commit()
    session.refresh(row)
    return notebook_os.workspace_payload(row)


@router.get("/evidence/artifacts")
def list_artifacts(
    q: str | None = Query(default=None, max_length=120),
    kind: str | None = Query(default=None, max_length=80),
    limit: int = Query(default=100, ge=1, le=500),
    session: Session = Depends(get_session),
):
    rows = notebook_os.list_artifacts(session, q=q, kind=kind, limit=limit)
    return [notebook_os.artifact_payload(session, row, include_edges=False) for row in rows]


@router.post("/evidence/artifacts")
def create_artifact(body: CaptureBody, session: Session = Depends(get_session)):
    row = notebook_os.capture_artifact(session, body.model_dump())
    return notebook_os.artifact_payload(session, row)


@router.post("/evidence/capture")
def capture_evidence(body: CaptureBody, session: Session = Depends(get_session)):
    row = notebook_os.capture_artifact(session, body.model_dump())
    return notebook_os.artifact_payload(session, row)


@router.get("/evidence/artifacts/{artifact_id}")
def get_artifact(artifact_id: int, session: Session = Depends(get_session)):
    row = session.get(StudyArtifact, artifact_id)
    if not row:
        raise HTTPException(404, "Artifact not found")
    return notebook_os.artifact_payload(session, row)


@router.patch("/evidence/artifacts/{artifact_id}")
def update_artifact(artifact_id: int, body: ArtifactPatchBody, session: Session = Depends(get_session)):
    try:
        row = notebook_os.update_artifact(
            session,
            artifact_id,
            body.model_dump(exclude_unset=True),
        )
    except ValueError as exc:
        if str(exc) == "artifact_not_found":
            raise HTTPException(404, "Artifact not found") from exc
        raise
    return notebook_os.artifact_payload(session, row)


@router.get("/evidence/artifacts/{artifact_id}/versions")
def get_artifact_versions(artifact_id: int, session: Session = Depends(get_session)):
    try:
        return notebook_os.artifact_versions(session, artifact_id)
    except ValueError as exc:
        if str(exc) == "artifact_not_found":
            raise HTTPException(404, "Artifact not found") from exc
        raise


@router.get("/citations/{target:path}")
def resolve_citation(target: str, session: Session = Depends(get_session)):
    return notebook_os.resolve_target(session, target)


@router.get("/backlinks/{target:path}")
def backlinks(target: str, session: Session = Depends(get_session)):
    return notebook_os.list_backlinks(session, target)


@router.get("/knowledge-inbox")
def knowledge_inbox(
    status: str | None = Query(default=None, max_length=40),
    session: Session = Depends(get_session),
):
    return notebook_os.list_inbox(session, status=status)


@router.patch("/knowledge-inbox/{item_id}")
def update_knowledge_inbox_item(
    item_id: int,
    body: InboxPatchBody,
    session: Session = Depends(get_session),
):
    try:
        return notebook_os.update_inbox_item(session, item_id, body.model_dump(exclude_unset=True))
    except ValueError as exc:
        if str(exc) == "inbox_item_not_found":
            raise HTTPException(404, "Knowledge inbox item not found") from exc
        raise


@router.get("/notebook-sources")
def list_sources(session: Session = Depends(get_session)):
    return notebook_os.list_sources(session)


@router.post("/notebook-sources")
def create_source(body: SourceBody, session: Session = Depends(get_session)):
    try:
        row = notebook_os.create_source(session, body.model_dump())
    except ValueError as exc:
        mapping = {
            "official_firewall_block": (403, "Official LSAT content cannot use a cloud provider"),
            "empty_source": (400, "Source needs pasted content, a file, URL, or evidence reference"),
            "source_registry_not_found": (404, "Source registry key was not found"),
        }
        if str(exc) in mapping:
            status, detail = mapping[str(exc)]
            raise HTTPException(status, detail) from exc
        raise
    return notebook_os.source_payload(row)


@router.post("/notebook-sources/import")
async def import_source(
    title: str = Form(..., min_length=1, max_length=240),
    source_type: str = Form(default="auto", max_length=80),
    content_type: str = Form(default="", max_length=120),
    content: str = Form(default="", max_length=300000),
    url: str = Form(default="", max_length=2000),
    provider: str = Form(default="local", max_length=80),
    source_registry_key: str = Form(default="", max_length=120),
    refs: str = Form(default="[]", max_length=MAX_IMPORT_LIST_JSON_CHARS),
    tags: str = Form(default="[]", max_length=MAX_IMPORT_LIST_JSON_CHARS),
    official_firewall: bool = Form(default=False),
    file: UploadFile | None = File(default=None),
    session: Session = Depends(get_session),
):
    try:
        parsed_refs = _json_list(refs, max_items=MAX_IMPORT_REFS, too_many_code="too_many_refs")
        parsed_tags = [
            str(item)
            for item in _json_list(tags, max_items=MAX_IMPORT_TAGS, too_many_code="too_many_tags")
        ]
        data = await _read_upload_bounded(file) if file else None
        row = notebook_os.import_source(
            session,
            {
                "title": title,
                "source_type": source_type,
                "content_type": content_type,
                "content": content,
                "provider": provider,
                "source_registry_key": source_registry_key or None,
                "refs": parsed_refs,
                "tags": parsed_tags,
                "official_firewall": official_firewall,
            },
            filename=file.filename if file else "",
            content_type=file.content_type or content_type if file else content_type,
            file_bytes=data,
            url=url,
        )
    except ValueError as exc:
        mapping = {
            "official_firewall_block": (403, "Official LSAT content cannot use a cloud provider"),
            "empty_source": (400, "Source needs pasted content, a file, URL, or evidence reference"),
            "source_registry_not_found": (404, "Source registry key was not found"),
            "unsupported_url": (400, "Only http(s) URLs are supported"),
            "private_url_blocked": (400, "Private or local network URLs are blocked by default"),
            "url_host_unresolved": (400, "Source URL host could not be resolved"),
            "source_upload_too_large": (413, "Source upload is too large"),
            "source_url_too_large": (413, "Source URL response is too large"),
            "source_content_too_large": (413, "Source content is too large"),
            "json_list_too_large": (422, "Source refs/tags metadata is too large"),
            "too_many_refs": (422, "Too many source refs"),
            "too_many_tags": (422, "Too many source tags"),
            "invalid_json_list": (422, "Source refs/tags metadata must be valid JSON arrays"),
            "pdf_extractor_unavailable": (422, "PDF extraction is unavailable"),
            "docx_parse_failed": (422, "DOCX text extraction failed"),
        }
        status, detail = mapping.get(str(exc), (422, f"Source import failed: {exc}"))
        raise HTTPException(status, detail) from exc
    except Exception as exc:
        raise HTTPException(422, f"Source import failed: {exc}") from exc
    return notebook_os.source_payload(row)


@router.get("/notebook-notes")
def list_notes(session: Session = Depends(get_session)):
    return notebook_os.list_notes(session)


@router.post("/notebook-notes")
def create_note(body: NoteBody, session: Session = Depends(get_session)):
    row = notebook_os.create_note(session, body.model_dump())
    return notebook_os.note_payload(row)


@router.patch("/notebook-notes/{note_id}")
def update_note(note_id: int, body: NotePatchBody, session: Session = Depends(get_session)):
    try:
        row = notebook_os.update_note(session, note_id, body.model_dump(exclude_unset=True))
    except ValueError as exc:
        if str(exc) == "note_not_found":
            raise HTTPException(404, "Notebook note not found") from exc
        raise
    return notebook_os.note_payload(row)


@router.post("/notebook-export")
def export_notebook(body: ExportBody, session: Session = Depends(get_session)):
    return notebook_os.export_bundle(
        session,
        refs=body.refs,
        title=body.title,
        format=body.format,
    )


@router.post("/notebook-import")
def import_notebook_bundle(body: ImportBundleBody, session: Session = Depends(get_session)):
    try:
        return notebook_os.import_bundle(session, body.model_dump())
    except ValueError as exc:
        mapping = {
            "empty_import_bundle": (400, "Notebook import bundle is empty"),
            "invalid_import_json": (422, "Notebook import JSON could not be parsed"),
            "official_firewall_block": (403, "Official LSAT content cannot use a cloud provider"),
        }
        status, detail = mapping.get(str(exc), (422, f"Notebook import failed: {exc}"))
        raise HTTPException(status, detail) from exc


@router.get("/notebook-search")
def notebook_search(
    q: str = Query(min_length=1, max_length=120),
    limit: int = Query(default=25, ge=1, le=100),
    session: Session = Depends(get_session),
):
    return notebook_os.search(session, q, limit=limit)


@router.post("/notebook-grounding")
def cross_domain_grounding(
    body: CrossDomainGroundingBody,
    session: Session = Depends(get_session),
):
    """INT-3 — cross-domain chunk grounding.

    Ranks the host curriculum chunks the caller submits against ``query`` (so
    host material can be unioned into LSAT/Notebook retrieval) AND, unless
    ``include_notebook_sources`` is false, surfaces local notebook sources that
    match the query as chunk-shaped hits. The two streams are merged and
    re-ranked into one ``hits`` list, mirroring the host-side union in
    ``localRag.ts`` so both planes ground over the same set.

    Degrades gracefully: when embeddings are unavailable the host-chunk ranking
    is simply empty and only the notebook full-text matches are returned (and
    vice-versa), so neither plane being offline breaks the other.
    """
    chunk_dicts = [c.model_dump(by_alias=False) for c in body.chunks]
    host_hits = embeddings.rank_host_chunks(body.query, chunk_dicts, k=body.k)
    for hit in host_hits:
        hit["source"] = "host"

    notebook_hits: list[dict[str, Any]] = []
    if body.include_notebook_sources:
        try:
            found = notebook_os.search(session, body.query, limit=body.k)
        except Exception:  # notebook index offline -> host-only union
            found = {"sources": []}
        for src in found.get("sources", []) or []:
            if src.get("official_firewall"):
                continue  # never leak firewalled official content cross-domain
            title = str(src.get("title") or "")
            notebook_hits.append({
                "id": str(src.get("id") or ""),
                "documentId": str(src.get("id") or ""),
                "domain": "open-notebook",
                "level": None,
                "topic": None,
                "locator": title,
                "text": title,
                # Notebook full-text matches carry no cosine score; tag them just
                # below an exact host match so host semantic hits sort first while
                # notebook sources still surface ahead of weak host matches.
                "score": 0.5,
                "source": "notebook",
            })

    merged = [*host_hits, *notebook_hits]
    merged.sort(key=lambda h: float(h.get("score") or 0.0), reverse=True)
    merged = merged[: body.k]
    return {
        "query": body.query,
        "hits": merged,
        "host_count": len(host_hits),
        "notebook_count": len(notebook_hits),
    }


@router.get("/notebook-chat/sessions")
def list_chat_sessions(session: Session = Depends(get_session)):
    return notebook_os.list_chat_sessions(session)


@router.post("/notebook-chat/sessions")
def create_chat_session(body: ChatSessionBody, session: Session = Depends(get_session)):
    row = notebook_os.create_chat_session(session, body.model_dump())
    return notebook_os.chat_session_payload(row)


@router.get("/notebook-chat/sessions/{session_id}/messages")
def list_chat_messages(session_id: int, session: Session = Depends(get_session)):
    return notebook_os.list_chat_messages(session, session_id)


@router.post("/notebook-chat/sessions/{session_id}/messages")
def add_chat_message(session_id: int, body: ChatTurnBody, session: Session = Depends(get_session)):
    try:
        return notebook_os.add_chat_turn(session, session_id, body.model_dump())
    except ValueError as exc:
        mapping = {
            "chat_not_found": (404, "Notebook chat not found"),
            "official_firewall_block": (403, "Official LSAT content cannot use a cloud provider"),
        }
        if str(exc) in mapping:
            status, detail = mapping[str(exc)]
            raise HTTPException(status, detail) from exc
        raise


@router.get("/transformations")
def list_transformations(session: Session = Depends(get_session)):
    return notebook_os.list_transformations(session)


@router.post("/transformations/run")
def run_transformation(body: TransformationBody, session: Session = Depends(get_session)):
    try:
        row = notebook_os.run_transformation(session, body.model_dump())
    except ValueError as exc:
        if str(exc) == "official_firewall_block":
            raise HTTPException(403, "Official LSAT content cannot use a cloud provider") from exc
        raise
    return notebook_os.transformation_payload(row)


@router.get("/podcasts")
def list_podcasts(session: Session = Depends(get_session)):
    return notebook_os.list_podcasts(session)


@router.post("/podcasts")
def create_podcast(body: PodcastBody, session: Session = Depends(get_session)):
    try:
        row = notebook_os.create_podcast(session, body.model_dump())
    except ValueError as exc:
        if str(exc) == "official_firewall_block":
            raise HTTPException(403, "Official LSAT content cannot use a cloud provider") from exc
        raise
    return notebook_os.podcast_payload(row)


@router.get("/podcasts/{episode_id}/audio")
def podcast_audio(episode_id: int, session: Session = Depends(get_session)):
    try:
        path = notebook_os.podcast_audio_file(session, episode_id)
    except ValueError as exc:
        if str(exc) == "audio_not_found":
            raise HTTPException(404, "Podcast audio is not available") from exc
        raise
    return FileResponse(path, media_type="audio/wav", filename=path.name)


@router.get("/activity")
def activity(limit: int = Query(default=100, ge=1, le=500), session: Session = Depends(get_session)):
    return notebook_os.activity_feed(session, limit=limit)


@router.get("/context-presets")
def list_context_presets(session: Session = Depends(get_session)):
    return notebook_os.default_context_presets(session)


@router.post("/context-presets")
def create_context_preset(body: ContextPresetBody, session: Session = Depends(get_session)):
    row = notebook_os.create_context_preset(session, body.model_dump())
    return notebook_os.context_preset_payload(row)


async def _read_upload_bounded(file: UploadFile) -> bytes:
    limit = notebook_os.MAX_SOURCE_UPLOAD_BYTES
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise ValueError("source_upload_too_large")
    return data


def _json_list(raw: str, *, max_items: int, too_many_code: str) -> list[Any]:
    if len(raw or "") > MAX_IMPORT_LIST_JSON_CHARS:
        raise ValueError("json_list_too_large")
    try:
        value = json.loads(raw or "[]")
    except json.JSONDecodeError as exc:
        raise ValueError("invalid_json_list") from exc
    if not isinstance(value, list):
        return []
    if len(value) > max_items:
        raise ValueError(too_many_code)
    return value
