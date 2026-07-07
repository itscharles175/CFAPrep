"""Notebook OS domain helpers.

This module functionally absorbs NotebookLM-style primitives into LSATLab's
local-first stack: sources, notes, scoped chat, citations, transformations,
podcasts, activity, and the official-content firewall.
"""
from __future__ import annotations

import io
import ipaddress
import json
import logging
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import zipfile
from contextlib import contextmanager
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from xml.etree import ElementTree

import httpx
from sqlalchemy import and_, or_, text
from sqlmodel import Session, select

from . import config, embeddings, llm
from .ai import strip_think
from .search import _fts_query
from .models import (
    ActivityEvent,
    AnswerChoice,
    ArtifactVersion,
    Attempt,
    AttemptRationale,
    Backlink,
    Citation,
    ContextPreset,
    EvidenceRef,
    KnowledgeInboxItem,
    NotebookChatMessage,
    NotebookChatSession,
    NotebookNote,
    NotebookPage,
    NotebookQuestionLink,
    NotebookSource,
    NotebookWorkspace,
    Passage,
    PodcastEpisode,
    PrepTest,
    Question,
    QuestionConversation,
    QuestionSource,
    Section,
    SourceRegistry,
    StudyArtifact,
    TransformationRun,
    TutorTurn,
    utcnow,
)

log = logging.getLogger("lsatlab.notebook_os")

DEFAULT_WORKSPACE_KEY = "default"
LOCAL_PROVIDERS = {"local", "ollama", "lmstudio", "deterministic"}
TRANSCRIPT_TYPES = {"audio_transcript", "video_transcript", "transcript"}
SOURCE_TYPES = ("auto", "text", "markdown", "pdf", "docx", "web", "audio_transcript", "video_transcript")
NOTE_TYPES = ("manual", "captured", "ai_generated", "transformed", "daily_journal")
TRANSFORMATION_TEMPLATES = (
    "summarize",
    "extract_rules",
    "generate_flaw_patterns",
    "make_rc_structure_notes",
    "create_srs_cards",
    "wrong_answer_packet",
    "weekly_study_sheet",
)
EXPORT_FORMATS = ("markdown", "html", "json")
IMPORT_FORMATS = ("auto", "json", "markdown", "html")
PODCAST_EPISODE_TYPES = (
    "wrong_answer_review",
    "rc_passage_walkthrough",
    "weekly_briefing",
    "flaw_family_drill",
    "commute_srs_recap",
)
CONTEXT_MODES = {
    "off",
    "summary",
    "full",
    "answer_key_locked",
    "after_reveal",
    "official_firewalled",
}
OFFICIAL_REDACTED_SNIPPET = "Official LSAT content is local-only; reopen it inside LSATLab."
OFFICIAL_SOURCE_TYPES = {"official", "official_lsat", "lsat_official", "lawhub", "real_lsat"}
# Swarm P2 #48 — paste-leak safety net for the export firewall.
# The ref-based firewall only redacts artifact bodies *linked* to official
# questions/passages/refs. A body where the user pasted official LSAT text WITHOUT
# any official ref still exports. This is an ADDITIVE embeddings guard: on export we
# compare a body's embedding (cosine) against stored OFFICIAL question embeddings
# and redact it like a linked-official artifact when the max similarity clears a
# HIGH bar. The threshold is deliberately high so only near-verbatim copies trip it
# — paraphrases / a student's own analysis must export normally (a false redaction
# of the user's own notes is a real harm). 0.92 sits comfortably above the
# "same-topic, different-question" band (~0.6–0.85 with nomic-embed-text) and below
# near-duplicate text (~0.95+). It NEVER raises and NEVER fires unless official
# content with stored embeddings exists, so it adds no new failure mode and degrades
# to the existing ref-based behaviour whenever embeddings are unavailable.
OFFICIAL_SIMILARITY_THRESHOLD = 0.92
# Skip the embedding call entirely for trivially short bodies: too little signal to
# match reliably, and not worth a model round-trip on every export item.
_SIMILARITY_MIN_BODY_CHARS = 40
MAX_SOURCE_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_URL_SOURCE_BYTES = 5 * 1024 * 1024
MAX_SOURCE_CONTENT_CHARS = 300_000
MAX_DOCX_DOCUMENT_XML_BYTES = 2 * 1024 * 1024


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._parts: list[str] = []

    def handle_data(self, data: str) -> None:
        text = data.strip()
        if text:
            self._parts.append(text)

    def text(self) -> str:
        return "\n".join(self._parts)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _source_value(value: Any) -> str:
    return getattr(value, "value", str(value))


def _context_mode(value: str | None) -> str:
    key = re.sub(r"[^a-z0-9]+", "_", (value or "summary").strip().lower()).strip("_")
    aliases = {
        "locked": "answer_key_locked",
        "answer_key": "answer_key_locked",
        "after_reveal_only": "after_reveal",
        "firewall": "official_firewalled",
        "firewalled": "official_firewalled",
    }
    key = aliases.get(key, key)
    return key if key in CONTEXT_MODES else "summary"


def _source_type_for_inline_content(
    requested: str | None,
    *,
    content: str,
    refs: list[str | dict[str, Any]],
) -> str:
    value = (requested or "auto").strip().lower() or "auto"
    if value != "auto":
        return value
    if not content.strip() and refs:
        return "evidence_ref"
    stripped = content.lstrip()
    if stripped.startswith("#") or re.search(r"(^|\n)\s{0,3}([-*]|\d+\.)\s+", content):
        return "markdown"
    return "text"


def _source_registry_policy(
    session: Session,
    body: dict[str, Any],
    *,
    source_type: str,
) -> dict[str, Any]:
    key = str(
        body.get("source_registry_key")
        or body.get("source_key")
        or body.get("registry_key")
        or ""
    ).strip()
    registry = None
    if key:
        registry = session.exec(select(SourceRegistry).where(SourceRegistry.key == key)).first()
        if not registry:
            raise ValueError("source_registry_not_found")
    firewall = registry.firewall_json if registry and isinstance(registry.firewall_json, dict) else {}
    eligibility = registry.eligibility_json if registry and isinstance(registry.eligibility_json, dict) else {}
    source_marker = (registry.source_type if registry else source_type).strip().lower()
    cloud_policy = str(firewall.get("cloud", "")).strip().lower()
    export_policy = str(firewall.get("export", "")).strip().lower()
    official = source_marker in OFFICIAL_SOURCE_TYPES or bool(
        firewall.get("official")
        or firewall.get("official_firewall")
        or firewall.get("local_only")
        or firewall.get("cloud") is False
        or cloud_policy in {"deny", "blocked", "local_only"}
    )
    return {
        "key": key or None,
        "label": registry.label if registry else "",
        "source_type": registry.source_type if registry else source_type,
        "firewall": firewall,
        "eligibility": eligibility,
        "official_firewall": official,
        "cloud_allowed": False if official else firewall.get("cloud", True) is not False and cloud_policy not in {"deny", "blocked"},
        "export_eligible": False if official else firewall.get("export", True) is not False and export_policy not in {"deny", "blocked"},
    }


def _split_ref(target: str) -> tuple[str, str]:
    if ":" not in target:
        return "artifact", target
    kind, entity_id = target.split(":", 1)
    return kind.strip().lower(), entity_id.strip()


def _as_ref(item: str | dict[str, Any]) -> dict[str, Any]:
    if isinstance(item, str):
        kind, entity_id = _split_ref(item)
        return {"target": item, "kind": kind, "entity_id": entity_id}
    target = str(item.get("target") or "")
    kind, entity_id = _split_ref(target) if target else (str(item.get("kind") or ""), str(item.get("entity_id") or ""))
    return {
        "target": target or f"{kind}:{entity_id}",
        "kind": kind,
        "entity_id": entity_id,
        "quote": str(item.get("quote") or ""),
        "line_ref": item.get("line_ref"),
        "reveal_state": str(item.get("reveal_state") or "safe"),
        "label": str(item.get("label") or ""),
        "range": item.get("range") if isinstance(item.get("range"), dict) else {},
        "meta": item.get("meta") if isinstance(item.get("meta"), dict) else {},
    }


def default_workspace(session: Session) -> NotebookWorkspace:
    row = session.exec(
        select(NotebookWorkspace).where(NotebookWorkspace.key == DEFAULT_WORKSPACE_KEY)
    ).first()
    if row:
        return row
    row = NotebookWorkspace(
        key=DEFAULT_WORKSPACE_KEY,
        title="LSAT Notebook OS",
        description="Local evidence graph, sources, notes, tutor chat, and study transformations.",
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    _activity(
        session,
        kind="workspace",
        status="done",
        title="Notebook OS workspace created",
        entity="workspace",
        entity_id=row.id,
    )
    return row


def workspace_payload(row: NotebookWorkspace) -> dict[str, Any]:
    return {
        "id": row.id,
        "key": row.key,
        "title": row.title,
        "description": row.description,
        "home_artifact_id": row.home_artifact_id,
        "created_at": _iso(row.created_at),
        "updated_at": _iso(row.updated_at),
    }


def capabilities(session: Session | None = None) -> dict[str, Any]:
    """Machine-readable Notebook OS feature map for UI gates and tests."""
    source_registry_rows = []
    if session is not None:
        source_registry_rows = [
            {
                "key": row.key,
                "label": row.label,
                "source_type": row.source_type,
                "official_firewall": bool((row.firewall_json or {}).get("official")),
                "cloud_allowed": (row.firewall_json or {}).get("cloud") != "deny",
                "export_allowed": (row.firewall_json or {}).get("export") != "deny",
            }
            for row in session.exec(select(SourceRegistry).order_by(SourceRegistry.key)).all()
        ]
    transform_templates = [
        {
            "key": key,
            "value": key,
            "label": key.replace("_", " ").title(),
            "local_only": True,
        }
        for key in TRANSFORMATION_TEMPLATES
    ]
    return {
        "schema": "lsatlab.notebook_capabilities.v1",
        "source_types": list(SOURCE_TYPES),
        "note_types": list(NOTE_TYPES),
        "context_modes": sorted(CONTEXT_MODES),
        "transform_templates": transform_templates,
        "transformation_templates": transform_templates,
        "export_formats": list(EXPORT_FORMATS),
        "import_formats": list(IMPORT_FORMATS),
        "podcast_episode_types": list(PODCAST_EPISODE_TYPES),
        "limits": {
            "max_upload_bytes": MAX_SOURCE_UPLOAD_BYTES,
            "max_url_bytes": MAX_URL_SOURCE_BYTES,
        },
        "providers": {
            "realtime_tutor": sorted(LOCAL_PROVIDERS),
            "cloud_default": "disabled",
            "official_content_cloud": "blocked",
        },
        "source_registry": source_registry_rows,
    }


def _activity(
    session: Session,
    *,
    kind: str,
    status: str,
    title: str,
    detail: dict[str, Any] | None = None,
    entity: str = "",
    entity_id: int | None = None,
    progress_pct: float = 100.0,
) -> ActivityEvent:
    row = ActivityEvent(
        kind=kind,
        status=status,
        title=title,
        detail_json=detail or {},
        entity=entity,
        entity_id=entity_id,
        progress_pct=progress_pct,
    )
    session.add(row)
    return row


def _question_official(session: Session, question_id: int | None) -> bool:
    if not question_id:
        return False
    question = session.get(Question, question_id)
    if not question:
        return False
    return _source_value(question.source) == QuestionSource.official.value


def _passage_official(session: Session, passage_id: int | None) -> bool:
    if not passage_id:
        return False
    passage = session.get(Passage, passage_id)
    if not passage:
        return False
    official_question = session.exec(
        select(Question.id).where(
            Question.passage_id == passage_id,
            Question.source == QuestionSource.official,
        )
    ).first()
    if official_question:
        return True
    section = session.get(Section, passage.section_id)
    if not section:
        return False
    pt = session.get(PrepTest, section.preptest_id)
    return bool(pt and pt.is_official)


def ref_is_official(session: Session, target: str) -> bool:
    kind, raw_id = _split_ref(target)
    try:
        entity_id = int(raw_id)
    except (TypeError, ValueError):
        return False
    if kind == "question":
        return _question_official(session, entity_id)
    if kind == "choice":
        choice = session.get(AnswerChoice, entity_id)
        return bool(choice and _question_official(session, choice.question_id))
    if kind == "passage":
        return _passage_official(session, entity_id)
    if kind == "attempt":
        attempt = session.get(Attempt, entity_id)
        return bool(attempt and _question_official(session, attempt.question_id))
    if kind == "rationale":
        rationale = session.get(AttemptRationale, entity_id)
        return bool(rationale and _question_official(session, rationale.question_id))
    if kind == "turn":
        turn = session.get(TutorTurn, entity_id)
        if not turn:
            return False
        conv = session.get(QuestionConversation, turn.conversation_id)
        return bool(conv and _question_official(session, conv.question_id))
    if kind in {"artifact", "source", "note"}:
        model = StudyArtifact if kind == "artifact" else NotebookSource if kind == "source" else NotebookNote
        row = session.get(model, entity_id)
        artifact_id = getattr(row, "artifact_id", None)
        if kind == "artifact" and row:
            return bool(getattr(row, "official_firewall", False))
        artifact = session.get(StudyArtifact, artifact_id) if artifact_id else None
        return bool(artifact and artifact.official_firewall)
    if kind == "page":
        links = session.exec(
            select(NotebookQuestionLink.question_id).where(NotebookQuestionLink.page_id == entity_id)
        ).all()
        return any(_question_official(session, int(question_id)) for question_id in links)
    return False


def firewall_decision(session: Session, refs: list[str | dict[str, Any]], provider: str = "local") -> dict[str, Any]:
    normalized = [_as_ref(ref) for ref in refs]
    official_refs = [ref["target"] for ref in normalized if ref_is_official(session, ref["target"])]
    provider_key = (provider or "local").lower()
    cloud_requested = provider_key not in LOCAL_PROVIDERS
    blocked = bool(official_refs and cloud_requested)
    return {
        "official_firewall": bool(official_refs),
        "official_refs": official_refs,
        "provider": provider_key,
        "cloud_requested": cloud_requested,
        "cloud_allowed": not official_refs,
        "export_eligible": not official_refs,
        "blocked": blocked,
        "reason": "official_firewall_block" if blocked else "allowed",
    }


def _firewall_decision_for_scope(
    session: Session,
    refs: list[str | dict[str, Any]],
    *,
    provider: str = "local",
    snapshots: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    decision = firewall_decision(session, refs, provider)
    official_refs = list(dict.fromkeys([
        *decision["official_refs"],
        *[
            str(snapshot["target"])
            for snapshot in (snapshots or [])
            if snapshot.get("official_firewall")
        ],
    ]))
    provider_key = (provider or "local").lower()
    cloud_requested = provider_key not in LOCAL_PROVIDERS
    blocked = bool(official_refs and cloud_requested)
    return {
        **decision,
        "official_firewall": bool(official_refs),
        "official_refs": official_refs,
        "cloud_requested": cloud_requested,
        "cloud_allowed": not official_refs,
        "export_eligible": not official_refs,
        "blocked": blocked,
        "reason": "official_firewall_block" if blocked else "allowed",
    }


def source_from_upload(
    *,
    filename: str,
    content_type: str,
    data: bytes,
    requested_type: str = "auto",
) -> dict[str, str]:
    """Extract local source text from a supported upload without writing it to disk."""
    if len(data) > MAX_SOURCE_UPLOAD_BYTES:
        raise ValueError("source_upload_too_large")
    inferred = _infer_source_type(filename=filename, content_type=content_type, requested=requested_type)
    if inferred == "pdf":
        text = _extract_pdf_text(data)
        media_type = content_type or "application/pdf"
    elif inferred == "docx":
        text = _extract_docx_text(data)
        media_type = content_type or "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    elif inferred in TRANSCRIPT_TYPES:
        text = _normalize_transcript(_decode_text(data))
        media_type = content_type or "text/plain"
    else:
        text = _decode_text(data)
        media_type = content_type or "text/plain"
    return {
        "source_type": inferred,
        "content_type": media_type,
        "content": _bounded_source_content(text),
    }


MAX_URL_REDIRECTS = 5
_URL_DNS_PIN_LOCK = threading.RLock()


def _read_url_response_bounded(response: httpx.Response) -> bytes:
    declared_length = response.headers.get("content-length")
    if declared_length:
        try:
            if int(declared_length) > MAX_URL_SOURCE_BYTES:
                raise ValueError("source_url_too_large")
        except ValueError:
            if declared_length.strip().isdigit():
                raise

    chunks: list[bytes] = []
    total = 0
    for chunk in response.iter_bytes():
        total += len(chunk)
        if total > MAX_URL_SOURCE_BYTES:
            raise ValueError("source_url_too_large")
        chunks.append(chunk)
    return b"".join(chunks)


def source_from_url(url: str, *, requested_type: str = "web") -> dict[str, str]:
    """Fetch a non-official research URL and normalize it into searchable text.

    Redirects are followed MANUALLY (``follow_redirects=False``) so each hop's
    target host is validated by :func:`_validate_public_url` BEFORE the next
    request is issued. Letting httpx auto-follow would fetch a private/loopback
    target on a public->internal redirect before we could reject it (SSRF).
    """
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("unsupported_url")
    next_url = url
    body = b""
    content_type = "text/html"
    encoding = "utf-8"
    with httpx.Client(timeout=12.0, follow_redirects=False, trust_env=False) as client:
        for _ in range(MAX_URL_REDIRECTS + 1):
            hop = urlparse(next_url)
            if hop.scheme not in {"http", "https"}:
                raise ValueError("unsupported_url")
            with _public_url_dns_guard(hop.hostname or ""):
                with client.stream("GET", next_url) as response:
                    if response.is_redirect:
                        location = response.headers.get("location")
                        if not location:
                            response.raise_for_status()
                        next_url = str(httpx.URL(next_url).join(location))
                        continue
                    response.raise_for_status()
                    body = _read_url_response_bounded(response)
                    content_type = response.headers.get("content-type", "").split(";", 1)[0] or "text/html"
                    encoding = response.encoding or "utf-8"
                    break
        else:
            raise ValueError("too_many_redirects")
    source_type = requested_type if requested_type != "auto" else "web"
    response_text = body.decode(encoding, errors="replace")
    if "html" in content_type:
        text = _html_to_text(response_text)
    elif source_type in TRANSCRIPT_TYPES or url.lower().endswith((".vtt", ".srt")):
        text = _normalize_transcript(response_text)
        if source_type == "web":
            source_type = "video_transcript"
    else:
        text = response_text
    text = _bounded_source_content(text)
    return {
        "source_type": source_type,
        "content_type": content_type,
        "content": text,
    }


def _bounded_source_content(text: str) -> str:
    if len(text) > MAX_SOURCE_CONTENT_CHARS:
        raise ValueError("source_content_too_large")
    return text


def _normalize_url_host(hostname: str) -> str:
    return hostname.strip().strip("[]").lower()


def _validate_public_url(hostname: str) -> set[str]:
    """Return validated public IPs for ``hostname`` or raise.

    The returned addresses are later pinned through the actual request so a host
    cannot validate as public and then re-resolve to a private address at connect
    time.
    """

    host = _normalize_url_host(hostname)
    if not host or host in {"localhost", "localhost.localdomain"} or host.endswith(".local"):
        raise ValueError("private_url_blocked")
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(host, None)}
    except socket.gaierror as exc:
        raise ValueError("url_host_unresolved") from exc
    if not addresses:
        raise ValueError("url_host_unresolved")
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if (
            ip.is_loopback
            or ip.is_private
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
            or not ip.is_global
        ):
            raise ValueError("private_url_blocked")
    return addresses


@contextmanager
def _public_url_dns_guard(hostname: str):
    host = _normalize_url_host(hostname)
    with _URL_DNS_PIN_LOCK:
        addresses = _validate_public_url(host)
        original_getaddrinfo = socket.getaddrinfo

        def pinned_getaddrinfo(query_host, port, family=0, type=0, proto=0, flags=0):  # noqa: ANN001
            query = _normalize_url_host(str(query_host))
            if query != host:
                return original_getaddrinfo(query_host, port, family, type, proto, flags)
            results = []
            for address in sorted(addresses):
                ip = ipaddress.ip_address(address)
                addr_family = socket.AF_INET6 if ip.version == 6 else socket.AF_INET
                sockaddr = (address, port, 0, 0) if ip.version == 6 else (address, port)
                results.append((addr_family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sockaddr))
            return results

        socket.getaddrinfo = pinned_getaddrinfo
        try:
            yield
        finally:
            socket.getaddrinfo = original_getaddrinfo


def _infer_source_type(*, filename: str, content_type: str, requested: str) -> str:
    value = (requested or "auto").lower()
    if value != "auto":
        return value
    name = filename.lower()
    ctype = content_type.lower()
    if name.endswith(".pdf") or "pdf" in ctype:
        return "pdf"
    if name.endswith(".docx") or "wordprocessingml" in ctype:
        return "docx"
    if name.endswith(".md") or name.endswith(".markdown"):
        return "markdown"
    if name.endswith((".vtt", ".srt")):
        return "video_transcript"
    return "text"


def _decode_text(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "cp1252"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _normalize_transcript(raw: str) -> str:
    """Collapse SRT/VTT cue metadata into readable source text."""
    lines: list[str] = []
    skipping_metadata_block = False
    for original in raw.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        stripped = original.strip()
        if not stripped:
            skipping_metadata_block = False
            if lines and lines[-1] != "":
                lines.append("")
            continue
        if skipping_metadata_block:
            continue

        upper = stripped.upper()
        if upper == "WEBVTT":
            continue
        if upper.startswith(("NOTE", "STYLE", "REGION")):
            skipping_metadata_block = True
            continue
        if re.fullmatch(r"\d+", stripped):
            continue
        if "-->" in stripped and re.search(r"\d{1,2}:\d{2}", stripped):
            continue

        text = re.sub(r"<[^>]+>", "", stripped)
        text = re.sub(r"\s+", " ", text).strip()
        if text:
            lines.append(text)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def _extract_pdf_text(data: bytes) -> str:
    try:
        import fitz  # type: ignore
    except Exception as exc:  # pragma: no cover - dependency is part of pyproject
        raise ValueError("pdf_extractor_unavailable") from exc
    pages: list[str] = []
    with fitz.open(stream=data, filetype="pdf") as doc:
        for idx, page in enumerate(doc, start=1):
            text = page.get_text("text").strip()
            if text:
                pages.append(f"[page {idx}]\n{text}")
    return "\n\n".join(pages)


def _extract_docx_text(data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            info = archive.getinfo("word/document.xml")
            if info.file_size > MAX_DOCX_DOCUMENT_XML_BYTES:
                raise ValueError("source_upload_too_large")
            xml = archive.read(info)
    except ValueError:
        raise
    except (KeyError, zipfile.BadZipFile) as exc:
        raise ValueError("docx_parse_failed") from exc
    root = ElementTree.fromstring(xml)
    namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    paragraphs: list[str] = []
    for paragraph in root.findall(".//w:p", namespace):
        parts = [node.text or "" for node in paragraph.findall(".//w:t", namespace)]
        text = "".join(parts).strip()
        if text:
            paragraphs.append(text)
    return "\n\n".join(paragraphs)


def _html_to_text(html: str) -> str:
    parser = _TextExtractor()
    parser.feed(html)
    text = parser.text()
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def resolve_target(session: Session, target: str) -> dict[str, Any]:
    kind, raw_id = _split_ref(target)
    official = ref_is_official(session, target)
    label = target
    snippet = ""
    exists = True
    try:
        entity_id = int(raw_id)
    except (TypeError, ValueError):
        entity_id = None
    if kind == "question" and entity_id is not None:
        row = session.get(Question, entity_id)
        exists = row is not None
        if row:
            label = f"Question {row.id} · {row.q_type}"
            snippet = "Official LSAT question text is local-only." if official else (row.prompt or row.stem)[:240]
    elif kind == "choice" and entity_id is not None:
        row = session.get(AnswerChoice, entity_id)
        exists = row is not None
        if row:
            label = f"Choice {row.label} · question {row.question_id}"
            snippet = row.text[:240]
    elif kind == "attempt" and entity_id is not None:
        row = session.get(Attempt, entity_id)
        exists = row is not None
        if row:
            label = f"Attempt {row.id} · question {row.question_id}"
            snippet = f"Answer {row.chosen_answer or 'blank'} · {row.time_ms} ms"
    elif kind == "passage" and entity_id is not None:
        row = session.get(Passage, entity_id)
        exists = row is not None
        if row:
            label = f"Passage {row.id}"
            snippet = "Official LSAT passage text is local-only." if official else (row.text or "")[:240]
    elif kind == "rationale" and entity_id is not None:
        row = session.get(AttemptRationale, entity_id)
        exists = row is not None
        if row:
            label = f"Rationale {row.id} · {row.stage}"
            snippet = row.rationale_text[:240]
    elif kind == "turn" and entity_id is not None:
        row = session.get(TutorTurn, entity_id)
        exists = row is not None
        if row:
            label = f"Tutor turn {row.id} · {row.role}"
            snippet = row.content[:240]
    elif kind == "note" and entity_id is not None:
        row = session.get(NotebookNote, entity_id)
        exists = row is not None
        if row:
            label = row.title
            snippet = row.content[:240]
    elif kind == "source" and entity_id is not None:
        row = session.get(NotebookSource, entity_id)
        exists = row is not None
        if row:
            label = row.title
            snippet = f"{row.source_type} · {row.status}"
    elif kind == "page" and entity_id is not None:
        row = session.get(NotebookPage, entity_id)
        exists = row is not None
        if row:
            label = row.title
            snippet = row.summary or row.body[:240]
    elif kind == "artifact" and entity_id is not None:
        row = session.get(StudyArtifact, entity_id)
        exists = row is not None
        if row:
            label = row.title
            snippet = (
                "Official LSAT artifact text is local-only."
                if row.official_firewall
                else row.summary or row.body[:240]
            )
            official = row.official_firewall
    if official:
        snippet = OFFICIAL_REDACTED_SNIPPET
    return {
        "target": target,
        "kind": kind,
        "entity_id": raw_id,
        "exists": exists,
        "label": label,
        "snippet": snippet,
        "official_firewall": official,
        "cloud_allowed": not official,
        "export_eligible": not official,
    }


def _artifact_version(session: Session, artifact: StudyArtifact, reason: str = "create") -> None:
    count = len(session.exec(
        select(ArtifactVersion).where(ArtifactVersion.artifact_id == artifact.id)
    ).all())
    session.add(
        ArtifactVersion(
            artifact_id=artifact.id or 0,
            version=count + 1,
            reason=reason,
            snapshot_json=artifact_payload(session, artifact, include_edges=False),
        )
    )


def _index_artifact(session: Session, artifact: StudyArtifact) -> None:
    if not artifact.id:
        return
    try:
        session.execute(
            text("DELETE FROM knowledge_fts WHERE entity = :entity AND entity_id = :entity_id"),
            {"entity": "artifact", "entity_id": artifact.id},
        )
        session.execute(
            text(
                "INSERT INTO knowledge_fts(entity, entity_id, title, body, summary, tags) "
                "VALUES (:entity, :entity_id, :title, :body, :summary, :tags)"
            ),
            {
                "entity": "artifact",
                "entity_id": artifact.id,
                "title": artifact.title,
                "body": "" if artifact.official_firewall else artifact.body,
                "summary": artifact.summary,
                "tags": " ".join(str(tag) for tag in (artifact.tags_json or [])),
            },
        )
    except Exception as exc:
        # Older DBs before migration 19 still work via LIKE fallback.
        log.warning("knowledge FTS index update failed artifact_id=%s", artifact.id, exc_info=True)
        _activity(
            session,
            kind="index_health",
            status="attention",
            title="Knowledge search index update failed",
            detail={"artifact_id": artifact.id, "error": str(exc)[:500]},
            entity="artifact",
            entity_id=artifact.id,
            progress_pct=0.0,
        )
        return


def knowledge_index_health(session: Session) -> dict[str, Any]:
    """Read-only health proof for the Notebook OS full-text index."""
    detail: dict[str, Any] = {
        "table": "knowledge_fts",
        "available": False,
        "artifact_count": 0,
        "indexed_artifact_count": 0,
        "missing_artifact_ids": [],
        "orphaned_entity_ids": [],
        "official_body_leak_ids": [],
        "last_index_error": None,
    }
    try:
        table = session.execute(
            text("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_fts'")
        ).first()
        if table is None:
            return {"ok": False, "status": "missing", "detail": detail}
        detail["available"] = True
        detail["artifact_count"] = int(
            session.execute(text("SELECT COUNT(*) FROM studyartifact")).scalar() or 0
        )
        detail["indexed_artifact_count"] = int(
            session.execute(
                text("SELECT COUNT(DISTINCT entity_id) FROM knowledge_fts WHERE entity = 'artifact'")
            ).scalar() or 0
        )
        detail["missing_artifact_ids"] = [
            int(row[0])
            for row in session.execute(
                text(
                    "SELECT a.id FROM studyartifact a "
                    "LEFT JOIN knowledge_fts f ON f.entity = 'artifact' AND f.entity_id = a.id "
                    "WHERE f.entity_id IS NULL ORDER BY a.id LIMIT 20"
                )
            ).all()
        ]
        detail["orphaned_entity_ids"] = [
            int(row[0])
            for row in session.execute(
                text(
                    "SELECT f.entity_id FROM knowledge_fts f "
                    "LEFT JOIN studyartifact a ON a.id = f.entity_id "
                    "WHERE f.entity = 'artifact' AND a.id IS NULL "
                    "ORDER BY f.entity_id LIMIT 20"
                )
            ).all()
        ]
        detail["official_body_leak_ids"] = [
            int(row[0])
            for row in session.execute(
                text(
                    "SELECT a.id FROM knowledge_fts f "
                    "JOIN studyartifact a ON a.id = f.entity_id "
                    "WHERE f.entity = 'artifact' AND a.official_firewall = 1 "
                    "AND length(coalesce(f.body, '')) > 0 "
                    "ORDER BY a.id LIMIT 20"
                )
            ).all()
        ]
        last_error = session.exec(
            select(ActivityEvent)
            .where(ActivityEvent.kind == "index_health")
            .where(ActivityEvent.status != "done")
            .order_by(ActivityEvent.id.desc())
        ).first()
        if last_error:
            detail["last_index_error"] = {
                "id": last_error.id,
                "status": last_error.status,
                "title": last_error.title,
                "detail": last_error.detail_json or {},
                "created_at": _iso(last_error.created_at),
            }
        blockers = bool(detail["official_body_leak_ids"])
        warnings = bool(detail["missing_artifact_ids"] or detail["orphaned_entity_ids"] or detail["last_index_error"])
        return {
            "ok": not blockers,
            "status": "block" if blockers else "warn" if warnings else "ok",
            "detail": detail,
        }
    except Exception as exc:  # noqa: BLE001
        detail["error"] = str(exc)
        return {"ok": False, "status": "error", "detail": detail}


def artifact_payload(
    session: Session,
    row: StudyArtifact,
    *,
    include_edges: bool = True,
) -> dict[str, Any]:
    payload = {
        "id": row.id,
        "workspace_id": row.workspace_id,
        "kind": row.kind,
        "title": row.title,
        "body": row.body,
        "summary": row.summary,
        "source_kind": row.source_kind,
        "q_type": row.q_type,
        "question_id": row.question_id,
        "attempt_id": row.attempt_id,
        "passage_id": row.passage_id,
        "visibility": row.visibility,
        "official_firewall": row.official_firewall,
        "cloud_allowed": row.cloud_allowed,
        "export_eligible": row.export_eligible,
        "tags": row.tags_json or [],
        "meta": row.meta_json or {},
        "created_at": _iso(row.created_at),
        "updated_at": _iso(row.updated_at),
    }
    if include_edges and row.id:
        refs = session.exec(
            select(EvidenceRef).where(EvidenceRef.artifact_id == row.id)
        ).all()
        citations = session.exec(
            select(Citation).where(Citation.artifact_id == row.id)
        ).all()
        payload["evidence_refs"] = [evidence_ref_payload(ref) for ref in refs]
        payload["citations"] = [citation_payload(citation) for citation in citations]
    return payload


def evidence_ref_payload(row: EvidenceRef) -> dict[str, Any]:
    return {
        "id": row.id,
        "artifact_id": row.artifact_id,
        "kind": row.kind,
        "entity_id": row.entity_id,
        "target": f"{row.kind}:{row.entity_id}",
        "quote": row.quote,
        "range": row.range_json or {},
        "line_ref": row.line_ref,
        "reveal_state": row.reveal_state,
        "official_firewall": row.official_firewall,
        "label": row.label,
        "meta": row.meta_json or {},
        "created_at": _iso(row.created_at),
    }


def citation_payload(row: Citation) -> dict[str, Any]:
    return {
        "id": row.id,
        "artifact_id": row.artifact_id,
        "target": row.target,
        "target_kind": row.target_kind,
        "label": row.label,
        "snippet": row.snippet,
        "official_firewall": row.official_firewall,
        "created_at": _iso(row.created_at),
    }


def _create_edges(
    session: Session,
    artifact: StudyArtifact,
    refs: list[str | dict[str, Any]],
) -> None:
    for raw_ref in refs:
        ref = _as_ref(raw_ref)
        target = ref["target"]
        resolved = resolve_target(session, target)
        session.add(
            EvidenceRef(
                artifact_id=artifact.id or 0,
                kind=ref["kind"],
                entity_id=ref["entity_id"],
                quote=ref.get("quote", ""),
                range_json=ref.get("range") or {},
                line_ref=ref.get("line_ref"),
                reveal_state=ref.get("reveal_state") or "safe",
                official_firewall=resolved["official_firewall"],
                label=ref.get("label") or resolved["label"],
                meta_json=ref.get("meta") or {},
            )
        )
        session.add(
            Citation(
                artifact_id=artifact.id,
                target=target,
                target_kind=ref["kind"],
                label=ref.get("label") or resolved["label"],
                snippet=resolved["snippet"],
                official_firewall=resolved["official_firewall"],
            )
        )
        session.add(
            Backlink(
                source_artifact_id=artifact.id,
                target_ref=target,
                relation="cites",
                q_type=artifact.q_type,
                meta_json={"source_kind": artifact.source_kind},
            )
        )


def _clear_edges(session: Session, artifact_id: int) -> None:
    for model in (EvidenceRef, Citation, Backlink):
        rows = session.exec(
            select(model).where(getattr(model, "artifact_id", None) == artifact_id)
            if model is not Backlink
            else select(model).where(Backlink.source_artifact_id == artifact_id)
        ).all()
        for row in rows:
            session.delete(row)


def capture_artifact(session: Session, body: dict[str, Any], *, commit: bool = True) -> StudyArtifact:
    ws = session.get(NotebookWorkspace, body.get("workspace_id")) if body.get("workspace_id") else default_workspace(session)
    refs = body.get("refs") or body.get("evidence_refs") or []
    if not isinstance(refs, list):
        refs = []
    decision = firewall_decision(session, refs, body.get("provider") or "local")
    forced_official = bool(body.get("official_firewall"))
    direct_official = _question_official(session, body.get("question_id")) or _passage_official(session, body.get("passage_id"))
    if body.get("attempt_id"):
        direct_official = direct_official or ref_is_official(session, f"attempt:{body.get('attempt_id')}")
    official = decision["official_firewall"] or forced_official or direct_official
    artifact = StudyArtifact(
        workspace_id=ws.id,
        kind=str(body.get("kind") or "note"),
        title=str(body.get("title") or "Untitled artifact")[:240],
        body=str(body.get("body") or ""),
        summary=str(body.get("summary") or ""),
        source_kind=str(body.get("source_kind") or "manual"),
        q_type=body.get("q_type"),
        question_id=body.get("question_id"),
        attempt_id=body.get("attempt_id"),
        passage_id=body.get("passage_id"),
        visibility=str(body.get("visibility") or "local"),
        official_firewall=official,
        cloud_allowed=False if official else bool(body.get("cloud_allowed", True)),
        export_eligible=False if official else bool(body.get("export_eligible", True)),
        tags_json=body.get("tags") if isinstance(body.get("tags"), list) else [],
        meta_json=body.get("meta") if isinstance(body.get("meta"), dict) else {},
    )
    session.add(artifact)
    session.flush()
    _create_edges(session, artifact, refs)
    session.add(
        KnowledgeInboxItem(
            artifact_id=artifact.id,
            origin=str(body.get("origin") or "capture"),
            priority=int(body.get("priority") or 0),
            reason=str(body.get("reason") or "Captured into Notebook OS"),
        )
    )
    _artifact_version(session, artifact, reason="capture")
    _index_artifact(session, artifact)
    _activity(
        session,
        kind="capture",
        status="done",
        title=f"Captured {artifact.kind}: {artifact.title}",
        detail={"official_firewall": official, "refs": [(_as_ref(ref))["target"] for ref in refs]},
        entity="artifact",
        entity_id=artifact.id,
    )
    if commit:
        session.commit()
        session.refresh(artifact)
    return artifact


def update_artifact(session: Session, artifact_id: int, body: dict[str, Any], *, commit: bool = True) -> StudyArtifact:
    artifact = session.get(StudyArtifact, artifact_id)
    if not artifact:
        raise ValueError("artifact_not_found")

    refs_provided = "refs" in body or "evidence_refs" in body or "citations" in body
    refs = body.get("refs") or body.get("evidence_refs") or body.get("citations") or []
    if not isinstance(refs, list):
        refs = []

    decision = firewall_decision(session, refs, body.get("provider") or "local")
    direct_official = _question_official(session, body.get("question_id")) or _passage_official(session, body.get("passage_id"))
    if body.get("attempt_id"):
        direct_official = direct_official or ref_is_official(session, f"attempt:{body.get('attempt_id')}")
    official = artifact.official_firewall or bool(body.get("official_firewall")) or decision["official_firewall"] or direct_official

    if "title" in body and body.get("title") is not None:
        artifact.title = str(body.get("title") or artifact.title)[:240]
    if "body" in body:
        artifact.body = str(body.get("body") or "")
    if "summary" in body:
        artifact.summary = str(body.get("summary") or "")
    elif "body" in body:
        artifact.summary = artifact.body[:220]
    if "source_kind" in body and body.get("source_kind") is not None:
        artifact.source_kind = str(body.get("source_kind") or artifact.source_kind)[:80]
    if "q_type" in body:
        artifact.q_type = body.get("q_type")
    if "question_id" in body:
        artifact.question_id = body.get("question_id")
    if "attempt_id" in body:
        artifact.attempt_id = body.get("attempt_id")
    if "passage_id" in body:
        artifact.passage_id = body.get("passage_id")
    if "visibility" in body and body.get("visibility") is not None:
        artifact.visibility = str(body.get("visibility") or artifact.visibility)
    if isinstance(body.get("tags"), list):
        artifact.tags_json = body.get("tags")
    if isinstance(body.get("meta"), dict):
        artifact.meta_json = {**(artifact.meta_json or {}), **body.get("meta", {})}
    artifact.official_firewall = official
    artifact.cloud_allowed = False if official else bool(body.get("cloud_allowed", artifact.cloud_allowed))
    artifact.export_eligible = False if official else bool(body.get("export_eligible", artifact.export_eligible))
    artifact.updated_at = utcnow()

    if refs_provided:
        _clear_edges(session, artifact.id or artifact_id)
        _create_edges(session, artifact, refs)

    _artifact_version(session, artifact, reason=str(body.get("reason") or "update"))
    _index_artifact(session, artifact)
    _activity(
        session,
        kind="artifact_update",
        status="done",
        title=f"Updated {artifact.kind}: {artifact.title}",
        detail={
            "official_firewall": artifact.official_firewall,
            "refs": [(_as_ref(ref))["target"] for ref in refs] if refs_provided else None,
        },
        entity="artifact",
        entity_id=artifact.id,
    )
    if commit:
        session.commit()
        session.refresh(artifact)
    return artifact


def list_artifacts(session: Session, *, q: str | None = None, kind: str | None = None, limit: int = 100) -> list[StudyArtifact]:
    stmt = select(StudyArtifact)
    if kind:
        stmt = stmt.where(StudyArtifact.kind == kind)
    if q:
        needle = f"%{q}%"
        stmt = stmt.where(
            or_(
                StudyArtifact.title.like(needle),
                StudyArtifact.summary.like(needle),
                and_(
                    StudyArtifact.official_firewall == False,  # noqa: E712
                    StudyArtifact.body.like(needle),
                ),
            )
        )
    return session.exec(stmt.order_by(StudyArtifact.updated_at.desc()).limit(limit)).all()


def list_backlinks(session: Session, target: str) -> list[dict[str, Any]]:
    rows = session.exec(select(Backlink).where(Backlink.target_ref == target)).all()
    out = []
    for row in rows:
        artifact = session.get(StudyArtifact, row.source_artifact_id) if row.source_artifact_id else None
        out.append({
            "id": row.id,
            "source_artifact_id": row.source_artifact_id,
            "source_title": artifact.title if artifact else "",
            "source_kind": artifact.kind if artifact else "",
            "source_summary": artifact.summary if artifact else "",
            "source_official_firewall": bool(artifact.official_firewall) if artifact else False,
            "target_ref": row.target_ref,
            "relation": row.relation,
            "q_type": row.q_type,
            "trap": row.trap,
            "role": row.role,
            "meta": row.meta_json or {},
            "created_at": _iso(row.created_at),
        })
    return out


def artifact_versions(session: Session, artifact_id: int) -> list[dict[str, Any]]:
    artifact = session.get(StudyArtifact, artifact_id)
    if not artifact:
        raise ValueError("artifact_not_found")
    rows = session.exec(
        select(ArtifactVersion)
        .where(ArtifactVersion.artifact_id == artifact_id)
        .order_by(ArtifactVersion.version.desc())
    ).all()
    return [
        {
            "id": row.id,
            "artifact_id": row.artifact_id,
            "version": row.version,
            "reason": row.reason,
            "snapshot": row.snapshot_json or {},
            "created_at": _iso(row.created_at),
        }
        for row in rows
    ]


def list_inbox(session: Session, status: str | None = None) -> list[dict[str, Any]]:
    stmt = select(KnowledgeInboxItem)
    if status:
        stmt = stmt.where(KnowledgeInboxItem.status == status)
    rows = session.exec(stmt.order_by(KnowledgeInboxItem.created_at.desc()).limit(200)).all()
    out = []
    for row in rows:
        artifact = session.get(StudyArtifact, row.artifact_id) if row.artifact_id else None
        out.append({
            "id": row.id,
            "artifact_id": row.artifact_id,
            "artifact_title": artifact.title if artifact else "",
            "origin": row.origin,
            "status": row.status,
            "priority": row.priority,
            "reason": row.reason,
            "created_at": _iso(row.created_at),
            "resolved_at": _iso(row.resolved_at),
        })
    return out


def update_inbox_item(session: Session, item_id: int, body: dict[str, Any]) -> dict[str, Any]:
    row = session.get(KnowledgeInboxItem, item_id)
    if not row:
        raise ValueError("inbox_item_not_found")
    if "status" in body and body.get("status") is not None:
        status = re.sub(r"[^a-z0-9_]+", "_", str(body.get("status")).strip().lower()).strip("_")
        row.status = status or row.status
        if row.status in {"resolved", "done", "archived"}:
            row.resolved_at = utcnow()
        elif row.status == "open":
            row.resolved_at = None
    if "priority" in body and body.get("priority") is not None:
        row.priority = max(0, min(100, int(body.get("priority") or 0)))
    if "reason" in body and body.get("reason") is not None:
        row.reason = str(body.get("reason") or "")[:500]
    _activity(
        session,
        kind="knowledge_inbox",
        status="done",
        title=f"Knowledge inbox updated: {row.status}",
        detail={"item_id": row.id, "artifact_id": row.artifact_id, "priority": row.priority},
        entity="knowledge_inbox",
        entity_id=row.id,
    )
    session.commit()
    return list_inbox_item_payload(session, row)


def list_inbox_item_payload(session: Session, row: KnowledgeInboxItem) -> dict[str, Any]:
    artifact = session.get(StudyArtifact, row.artifact_id) if row.artifact_id else None
    return {
        "id": row.id,
        "artifact_id": row.artifact_id,
        "artifact_title": artifact.title if artifact else "",
        "origin": row.origin,
        "status": row.status,
        "priority": row.priority,
        "reason": row.reason,
        "created_at": _iso(row.created_at),
        "resolved_at": _iso(row.resolved_at),
    }


def create_source(session: Session, body: dict[str, Any]) -> NotebookSource:
    refs = body.get("refs") if isinstance(body.get("refs"), list) else []
    content = str(body.get("content") or body.get("body") or "")
    if not content.strip() and not refs:
        raise ValueError("empty_source")
    source_type = _source_type_for_inline_content(
        body.get("source_type"),
        content=content,
        refs=refs,
    )
    registry_policy = _source_registry_policy(session, body, source_type=source_type)
    provider = str(body.get("provider") or "local")
    decision = firewall_decision(session, refs, provider)
    forced_official = (
        bool(body.get("official_firewall"))
        or bool(registry_policy["official_firewall"])
        or source_type.strip().lower() in OFFICIAL_SOURCE_TYPES
    )
    if forced_official and provider.lower() not in LOCAL_PROVIDERS:
        raise ValueError("official_firewall_block")
    if decision["blocked"]:
        raise ValueError("official_firewall_block")
    decision = {
        **decision,
        "official_firewall": decision["official_firewall"] or forced_official,
        "cloud_allowed": decision["cloud_allowed"] and bool(registry_policy["cloud_allowed"]) and not forced_official,
        "export_eligible": decision["export_eligible"] and bool(registry_policy["export_eligible"]) and not forced_official,
        "source_registry": registry_policy,
    }
    artifact = capture_artifact(
        session,
        {
            "workspace_id": body.get("workspace_id"),
            "kind": "source",
            "title": body.get("title") or "Untitled source",
            "body": content,
            "summary": body.get("summary") or "",
            "source_kind": source_type,
            "refs": refs,
            "tags": body.get("tags") if isinstance(body.get("tags"), list) else [],
            "origin": "source_ingest",
            "official_firewall": decision["official_firewall"],
            "cloud_allowed": decision["cloud_allowed"],
            "export_eligible": decision["export_eligible"],
            "meta": {
                "content_type": body.get("content_type") or "text/plain",
                "source_registry": registry_policy,
            },
        },
        commit=False,
    )
    row = NotebookSource(
        workspace_id=artifact.workspace_id,
        artifact_id=artifact.id,
        title=artifact.title,
        source_type=source_type,
        status="ready",
        content_type=str(body.get("content_type") or "text/plain"),
        provider=provider,
        official_firewall=artifact.official_firewall,
        processing_json={"decision": decision, "chars": len(artifact.body)},
    )
    session.add(row)
    session.flush()
    _activity(
        session,
        kind="source_ingest",
        status="done",
        title=f"Source ingested: {row.title}",
        detail={"source_type": row.source_type, "official_firewall": row.official_firewall},
        entity="source",
        entity_id=row.id,
    )
    session.commit()
    session.refresh(row)
    return row


def import_source(
    session: Session,
    body: dict[str, Any],
    *,
    filename: str = "",
    content_type: str = "",
    file_bytes: bytes | None = None,
    url: str = "",
) -> NotebookSource:
    source_type = str(body.get("source_type") or "auto")
    extracted: dict[str, str] | None = None
    if file_bytes:
        extracted = source_from_upload(
            filename=filename,
            content_type=content_type,
            data=file_bytes,
            requested_type=source_type,
        )
    elif url:
        extracted = source_from_url(url, requested_type=source_type)

    payload = dict(body)
    if extracted:
        payload["source_type"] = extracted["source_type"]
        payload["content_type"] = extracted["content_type"]
        payload["content"] = extracted["content"]
        meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
        payload["meta"] = {
            **meta,
            "filename": filename,
            "url": url,
            "chars": len(extracted["content"]),
        }
    return create_source(session, payload)


def source_payload(row: NotebookSource) -> dict[str, Any]:
    return {
        "id": row.id,
        "workspace_id": row.workspace_id,
        "artifact_id": row.artifact_id,
        "title": row.title,
        "source_type": row.source_type,
        "status": row.status,
        "content_type": row.content_type,
        "provider": row.provider,
        "official_firewall": row.official_firewall,
        "processing": row.processing_json or {},
        "created_at": _iso(row.created_at),
        "updated_at": _iso(row.updated_at),
    }


def list_sources(session: Session) -> list[dict[str, Any]]:
    rows = session.exec(select(NotebookSource).order_by(NotebookSource.updated_at.desc())).all()
    return [source_payload(row) for row in rows]


def import_bundle(session: Session, body: dict[str, Any]) -> dict[str, Any]:
    """Import LSATLab/Open Notebook style JSON or Markdown into the evidence graph."""
    content = str(body.get("content") or "")
    if not content.strip():
        raise ValueError("empty_import_bundle")
    requested = str(body.get("format") or "auto").strip().lower() or "auto"
    if requested not in IMPORT_FORMATS:
        requested = "auto"
    fmt = _detect_bundle_format(content, requested)
    provider = str(body.get("provider") or "local")
    workspace_id = body.get("workspace_id")
    forced_official = bool(body.get("official_firewall"))
    tags = [str(tag) for tag in body.get("tags", [])] if isinstance(body.get("tags"), list) else []
    title = str(body.get("title") or "Imported notebook bundle")[:240]

    try:
        items = _bundle_items_from_content(content, fmt, fallback_title=title)
    except json.JSONDecodeError as exc:
        raise ValueError("invalid_import_json") from exc
    if not items:
        raise ValueError("empty_import_bundle")

    created_refs: list[str] = []
    skipped: list[dict[str, Any]] = []
    created = {"sources": 0, "notes": 0, "artifacts": 0}
    official_refs: list[str] = []
    provider_key = provider.lower()

    for index, raw_item in enumerate(items, start=1):
        item = _normalize_bundle_item(raw_item, index=index, forced_official=forced_official)
        if item["official_firewall"]:
            official_refs.append(item["title"])
        if item["official_firewall"] and provider_key not in LOCAL_PROVIDERS:
            raise ValueError("official_firewall_block")
        body_text = item["body"] or item["summary"]
        if not item["title"] or not body_text.strip():
            skipped.append({"index": index, "reason": "empty_item", "title": item["title"]})
            continue

        common_tags = list(dict.fromkeys([*tags, *item["tags"], "imported"]))
        content_text = OFFICIAL_REDACTED_SNIPPET if item["redacted"] and not item["body"].strip() else body_text
        if item["kind"] in {"source", "reference", "web", "pdf", "docx", "markdown", "text", *TRANSCRIPT_TYPES}:
            source_type = item["source_type"]
            if source_type not in SOURCE_TYPES and source_type not in OFFICIAL_SOURCE_TYPES:
                source_type = "text"
            source = create_source(
                session,
                {
                    "workspace_id": workspace_id,
                    "title": item["title"],
                    "source_type": source_type,
                    "content_type": item["content_type"],
                    "content": content_text,
                    "provider": provider,
                    "refs": item["refs"],
                    "tags": common_tags,
                    "official_firewall": item["official_firewall"],
                    "meta": {"import_format": fmt, "original_target": item["target"]},
                },
            )
            created["sources"] += 1
            if source.artifact_id:
                created_refs.append(f"artifact:{source.artifact_id}")
        elif item["kind"] in {"note", "rationale", "tutor_turn", "transformation", "study_sheet", "daily_journal", "page"}:
            note_type = item["note_type"] if item["note_type"] in NOTE_TYPES else "transformed"
            note = create_note(
                session,
                {
                    "workspace_id": workspace_id,
                    "title": item["title"],
                    "note_type": note_type,
                    "content": content_text,
                    "citations": item["refs"],
                    "tags": common_tags,
                    "provider": provider,
                    "official_firewall": item["official_firewall"],
                    "cloud_allowed": not item["official_firewall"],
                    "export_eligible": not item["official_firewall"],
                    "meta": {"import_format": fmt, "original_target": item["target"]},
                },
            )
            created["notes"] += 1
            if note.artifact_id:
                created_refs.append(f"artifact:{note.artifact_id}")
        else:
            artifact = capture_artifact(
                session,
                {
                    "workspace_id": workspace_id,
                    "kind": item["kind"] or "artifact",
                    "title": item["title"],
                    "body": content_text,
                    "summary": item["summary"],
                    "source_kind": "imported",
                    "refs": item["refs"],
                    "tags": common_tags,
                    "provider": provider,
                    "official_firewall": item["official_firewall"],
                    "cloud_allowed": not item["official_firewall"],
                    "export_eligible": not item["official_firewall"],
                    "meta": {"import_format": fmt, "original_target": item["target"]},
                    "origin": "notebook_import",
                },
            )
            created["artifacts"] += 1
            created_refs.append(f"artifact:{artifact.id}")

    _activity(
        session,
        kind="notebook_import",
        status="done" if created_refs else "skipped",
        title=f"Notebook bundle imported: {title}",
        detail={
            "format": fmt,
            "created": created,
            "skipped": len(skipped),
            "official_items": len(official_refs),
        },
        entity="notebook_import",
    )
    session.commit()
    return {
        "schema": "lsatlab.notebook_import.v1",
        "title": title,
        "format": fmt,
        "created": created,
        "created_refs": created_refs,
        "skipped": skipped,
        "firewall_decision": {
            "provider": provider_key,
            "official_firewall": bool(official_refs),
            "official_refs": official_refs[:50],
            "cloud_allowed": not official_refs,
            "export_eligible": not official_refs,
            "blocked": False,
            "reason": "allowed",
        },
    }


def _detect_bundle_format(content: str, requested: str) -> str:
    if requested != "auto":
        return requested
    stripped = content.lstrip()
    if stripped.startswith("{") or stripped.startswith("["):
        return "json"
    if re.match(r"(?is)<!doctype\s+html|<html\b|<h[1-6]\b", stripped):
        return "html"
    return "markdown"


def _bundle_items_from_content(content: str, fmt: str, *, fallback_title: str) -> list[dict[str, Any]]:
    if fmt == "json":
        parsed = json.loads(content)
        return _bundle_items_from_json(parsed)
    if fmt == "html":
        text = _html_to_text(content)
        return [
            {
                "kind": "source",
                "title": fallback_title,
                "body": text,
                "source_type": "web",
                "content_type": "text/html",
            }
        ] if text.strip() else []
    return _bundle_items_from_markdown(content, fallback_title=fallback_title)


def _bundle_items_from_json(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if not isinstance(value, dict):
        return []
    items: list[dict[str, Any]] = []
    raw_items = value.get("items")
    if isinstance(raw_items, list):
        items.extend(item for item in raw_items if isinstance(item, dict))

    for key, kind in (
        ("sources", "source"),
        ("documents", "source"),
        ("resources", "source"),
        ("notes", "note"),
        ("highlights", "note"),
        ("cards", "note"),
    ):
        raw_list = value.get(key)
        if isinstance(raw_list, list):
            for item in raw_list:
                if isinstance(item, dict):
                    items.append({"kind": kind, **item})

    notebooks = value.get("notebooks")
    if isinstance(notebooks, list):
        for notebook in notebooks:
            if isinstance(notebook, dict):
                items.extend(_bundle_items_from_json(notebook))

    if not items and any(key in value for key in ("title", "name", "body", "content", "text", "transcript")):
        items.append(value)
    return items


def _bundle_items_from_markdown(content: str, *, fallback_title: str) -> list[dict[str, Any]]:
    text = content.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        return []
    sections: list[dict[str, Any]] = []
    current_title = ""
    current_lines: list[str] = []
    for line in text.split("\n"):
        match = re.match(r"^##\s+(.+?)\s*$", line)
        if match:
            preamble_has_body = any(
                item.strip() and not item.lstrip().startswith("# ")
                for item in current_lines
            )
            if current_title or preamble_has_body:
                sections.append(_markdown_section_item(current_title or fallback_title, current_lines))
            current_title = match.group(1).strip()
            current_lines = []
        else:
            current_lines.append(line)
    if current_title or current_lines:
        sections.append(_markdown_section_item(current_title or fallback_title, current_lines))
    if len(sections) == 1 and not sections[0].get("body"):
        sections[0]["body"] = text
    return sections


def _markdown_section_item(title: str, lines: list[str]) -> dict[str, Any]:
    meta: dict[str, str] = {}
    body_lines: list[str] = []
    for line in lines:
        match = re.match(r"^-\s+([A-Za-z][A-Za-z _-]+):\s+`?([^`]+?)`?\s*$", line.strip())
        if match:
            meta[match.group(1).strip().lower().replace(" ", "_").replace("-", "_")] = match.group(2).strip()
        else:
            body_lines.append(line)
    raw_title = title.strip()
    kind_hint = ""
    title_match = re.match(r"^(source|note|artifact|highlight|document|page)\s*:\s*(.+)$", raw_title, re.I)
    if title_match:
        kind_hint = title_match.group(1).lower()
        raw_title = title_match.group(2).strip()
    return {
        "title": raw_title,
        "kind": meta.get("kind") or ("source" if kind_hint in {"source", "document"} else "note" if kind_hint == "highlight" else kind_hint),
        "target": meta.get("target", ""),
        "official_firewall": meta.get("official_firewall", "").lower() == "true",
        "body": "\n".join(body_lines).strip(),
        "source_type": meta.get("source_type", "markdown"),
        "content_type": "text/markdown",
    }


def _normalize_bundle_item(raw: dict[str, Any], *, index: int, forced_official: bool) -> dict[str, Any]:
    title = str(raw.get("title") or raw.get("name") or raw.get("heading") or f"Imported item {index}")[:240]
    kind = str(raw.get("kind") or raw.get("type") or raw.get("item_type") or raw.get("source_type") or "note").strip().lower()
    kind = re.sub(r"[^a-z0-9_]+", "_", kind).strip("_") or "note"
    body = str(
        raw.get("body")
        or raw.get("content")
        or raw.get("text")
        or raw.get("transcript")
        or raw.get("note")
        or raw.get("markdown")
        or ""
    )
    summary = str(raw.get("summary") or raw.get("description") or body[:220])
    redacted = bool(raw.get("redacted")) or "Official LSAT content redacted" in body
    official = forced_official or bool(raw.get("official_firewall")) or bool(raw.get("local_only")) or redacted
    citations = raw.get("citations") or raw.get("refs") or raw.get("source_refs") or []
    if not isinstance(citations, list):
        citations = []
    refs = []
    for citation in citations:
        if isinstance(citation, str):
            refs.append(citation)
        elif isinstance(citation, dict):
            target = citation.get("target") or citation.get("ref") or citation.get("id")
            if target:
                refs.append({**citation, "target": str(target)})
    tags = raw.get("tags") if isinstance(raw.get("tags"), list) else []
    source_type = str(raw.get("source_type") or raw.get("media_type") or ("markdown" if kind == "markdown" else "text")).lower()
    note_type = str(raw.get("note_type") or raw.get("source_kind") or ("daily_journal" if kind == "daily_journal" else "transformed")).lower()
    return {
        "title": title,
        "kind": kind,
        "target": str(raw.get("target") or raw.get("id") or ""),
        "body": body,
        "summary": summary,
        "refs": refs,
        "tags": [str(tag) for tag in tags],
        "official_firewall": official,
        "redacted": redacted,
        "source_type": source_type,
        "note_type": note_type,
        "content_type": str(raw.get("content_type") or "text/plain"),
    }


def export_bundle(
    session: Session,
    *,
    refs: list[str | dict[str, Any]] | None = None,
    title: str = "LSATLab Notebook Export",
    format: str = "markdown",
) -> dict[str, Any]:
    selected = [_as_ref(ref) for ref in (refs or [])]
    artifacts: list[StudyArtifact] = []
    if selected:
        for ref in selected:
            kind = ref["kind"]
            try:
                entity_id = int(ref["entity_id"])
            except (TypeError, ValueError):
                continue
            artifact: StudyArtifact | None = None
            if kind == "artifact":
                artifact = session.get(StudyArtifact, entity_id)
            elif kind == "source":
                source = session.get(NotebookSource, entity_id)
                artifact = session.get(StudyArtifact, source.artifact_id) if source and source.artifact_id else None
            elif kind == "note":
                note = session.get(NotebookNote, entity_id)
                artifact = session.get(StudyArtifact, note.artifact_id) if note and note.artifact_id else None
            if artifact:
                artifacts.append(artifact)
    else:
        artifacts = list_artifacts(session, limit=100)

    items = [_export_artifact(session, artifact) for artifact in artifacts]
    fmt = (format or "markdown").lower()
    if fmt == "json":
        body: Any = {"title": title, "items": items}
        content_type = "application/json"
    elif fmt == "html":
        body = _export_html(title, items)
        content_type = "text/html"
    else:
        body = _export_markdown(title, items)
        content_type = "text/markdown"
        fmt = "markdown"
    _activity(
        session,
        kind="export",
        status="done",
        title=f"Notebook export prepared: {title}",
        detail={"format": fmt, "items": len(items), "redacted": sum(1 for item in items if item["redacted"])},
        entity="export",
    )
    session.commit()
    return {
        "title": title,
        "format": fmt,
        "content_type": content_type,
        "body": body,
        "items": items,
        "redacted_count": sum(1 for item in items if item["redacted"]),
    }


def _official_question_vectors(session: Session) -> dict[int, list[float]]:
    """Stored embeddings of OFFICIAL questions, ``{question_id: vector}``.

    Reuses the existing vector store (cached question vectors) and keeps only the
    official ones. Returns ``{}`` when no official question has a stored embedding,
    so the similarity guard can skip the (expensive) body-embedding call entirely
    on banks without official content. Never raises.
    """
    try:
        vectors = embeddings.vector_store(session).all_for(embeddings.QUESTION)
        if not vectors:
            return {}
        official_ids = {
            int(qid)
            for qid in session.exec(
                select(Question.id).where(Question.source == QuestionSource.official)
            ).all()
        }
        return {qid: vec for qid, vec in vectors.items() if qid in official_ids and vec}
    except Exception:  # pragma: no cover - additive safety net, never fatal
        return {}


def _body_matches_official(session: Session, body: str) -> bool:
    """Swarm P2 #48 — does ``body`` look like pasted OFFICIAL LSAT text?

    Additive embeddings safety net for the export firewall: compares ``body``'s
    embedding (cosine) against stored official-question embeddings and returns
    ``True`` when the max similarity clears :data:`OFFICIAL_SIMILARITY_THRESHOLD`.
    Used to firewall a free-text body the user pasted from an official item even
    when it carries NO official ref link.

    Deliberately conservative and cheap:
    - skips trivially short/empty bodies (``_SIMILARITY_MIN_BODY_CHARS``),
    - no-ops (no model call) when no official question has a stored embedding,
    - skips dimension-mismatched stored vectors via the embeddings layer's own
      ``_comparable`` guard (a prior embed model never scores a bogus hit).

    NEVER raises: any embedding/compare failure degrades to ``False`` so the caller
    falls back to the existing ref-based redaction (no new failure mode).
    """
    text = (body or "").strip()
    if len(text) < _SIMILARITY_MIN_BODY_CHARS:
        return False
    official_vectors = _official_question_vectors(session)
    if not official_vectors:  # no official embeddings (or lookup failed) -> no-op
        return False
    try:
        query = llm.embed_sync(text)
    except Exception:
        return False
    if not query:
        return False
    try:
        best = max(
            (
                embeddings.cosine(query, vec)
                for vec in official_vectors.values()
                if embeddings._comparable(query, vec)
            ),
            default=0.0,
        )
    except Exception:  # pragma: no cover - cosine over sane vectors won't raise
        return False
    return best >= OFFICIAL_SIMILARITY_THRESHOLD


def _export_artifact(session: Session, artifact: StudyArtifact) -> dict[str, Any]:
    official = bool(artifact.official_firewall)
    citations = session.exec(
        select(Citation).where(Citation.artifact_id == artifact.id)
    ).all()
    # Swarm P2 #48 — paste-leak guard: a body with no official ref link but
    # near-identical to an official item is firewalled the same way a linked
    # artifact is (same redaction string + flags). Only checked for not-already-
    # official artifacts so we never pay for embeddings we don't need.
    if not official and _body_matches_official(session, artifact.body):
        official = True
    return {
        "target": f"artifact:{artifact.id}",
        "kind": artifact.kind,
        "title": artifact.title,
        # When firewalled, blank the summary too: the markdown/html exporters fall
        # back to ``summary`` when ``body`` is empty, and a note's summary is just
        # the first 220 chars of its body — so leaving it would re-leak the text.
        "summary": "" if official else artifact.summary,
        "body": "[Official LSAT content redacted; reopen locally in LSATLab.]" if official else artifact.body,
        "official_firewall": official,
        "redacted": official,
        "citations": [citation_payload(row) for row in citations],
    }


def _export_markdown(title: str, items: list[dict[str, Any]]) -> str:
    sections = [f"# {title}"]
    for item in items:
        sections.append(
            "\n".join(
                [
                    f"## {item['title']}",
                    f"- Target: `{item['target']}`",
                    f"- Kind: `{item['kind']}`",
                    f"- Official firewall: `{str(item['official_firewall']).lower()}`",
                    "",
                    item["body"] or item["summary"] or "",
                ]
            )
        )
    return "\n\n".join(sections).strip()


def _export_html(title: str, items: list[dict[str, Any]]) -> str:
    import html

    parts = [f"<!doctype html><meta charset=\"utf-8\"><title>{html.escape(title)}</title>", f"<h1>{html.escape(title)}</h1>"]
    for item in items:
        body = html.escape(item["body"] or item["summary"] or "").replace("\n", "<br>")
        parts.append(
            f"<section><h2>{html.escape(item['title'])}</h2>"
            f"<p><code>{html.escape(item['target'])}</code> · {html.escape(item['kind'])}</p>"
            f"<p>Official firewall: {str(item['official_firewall']).lower()}</p>"
            f"<div>{body}</div></section>"
        )
    return "\n".join(parts)


def create_note(session: Session, body: dict[str, Any]) -> NotebookNote:
    refs = body.get("citations") if isinstance(body.get("citations"), list) else []
    artifact = capture_artifact(
        session,
        {
            "workspace_id": body.get("workspace_id"),
            "kind": "note",
            "title": body.get("title") or "Untitled note",
            "body": body.get("content") or "",
            "summary": (body.get("content") or "")[:220],
            "source_kind": body.get("note_type") or "manual",
            "refs": refs,
            "tags": body.get("tags") if isinstance(body.get("tags"), list) else [],
            "provider": body.get("provider") or "local",
            "official_firewall": bool(body.get("official_firewall")),
            "cloud_allowed": bool(body.get("cloud_allowed", True)),
            "export_eligible": bool(body.get("export_eligible", True)),
            "meta": body.get("meta") if isinstance(body.get("meta"), dict) else {},
            "origin": "note",
        },
        commit=False,
    )
    row = NotebookNote(
        workspace_id=artifact.workspace_id,
        artifact_id=artifact.id,
        note_type=str(body.get("note_type") or "manual"),
        title=artifact.title,
        content=artifact.body,
        citations_json=refs,
    )
    session.add(row)
    session.flush()
    _activity(
        session,
        kind="note",
        status="done",
        title=f"Note saved: {row.title}",
        entity="note",
        entity_id=row.id,
    )
    session.commit()
    session.refresh(row)
    return row


def update_note(session: Session, note_id: int, body: dict[str, Any]) -> NotebookNote:
    row = session.get(NotebookNote, note_id)
    if not row:
        raise ValueError("note_not_found")
    refs_provided = "citations" in body
    refs = body.get("citations") if isinstance(body.get("citations"), list) else row.citations_json or []
    artifact_body: dict[str, Any] = {
        "reason": str(body.get("reason") or "note_update"),
        "refs": refs,
    }
    if "title" in body and body.get("title") is not None:
        row.title = str(body.get("title") or row.title)[:240]
        artifact_body["title"] = row.title
    if "content" in body:
        row.content = str(body.get("content") or "")
        artifact_body["body"] = row.content
        artifact_body["summary"] = row.content[:220]
    if "note_type" in body and body.get("note_type") is not None:
        row.note_type = str(body.get("note_type") or row.note_type)
        artifact_body["source_kind"] = row.note_type
    if refs_provided:
        row.citations_json = refs
    row.updated_at = utcnow()
    if row.artifact_id:
        update_artifact(session, row.artifact_id, artifact_body, commit=False)
    session.commit()
    session.refresh(row)
    return row


def note_payload(row: NotebookNote) -> dict[str, Any]:
    return {
        "id": row.id,
        "workspace_id": row.workspace_id,
        "artifact_id": row.artifact_id,
        "note_type": row.note_type,
        "title": row.title,
        "content": row.content,
        "citations": row.citations_json or [],
        "created_at": _iso(row.created_at),
        "updated_at": _iso(row.updated_at),
    }


def list_notes(session: Session) -> list[dict[str, Any]]:
    rows = session.exec(select(NotebookNote).order_by(NotebookNote.updated_at.desc()).limit(200)).all()
    return [note_payload(row) for row in rows]


def explanation_context_for_question(
    session: Session,
    question: Question,
    *,
    passage_id: int | None = None,
    limit: int = 6,
) -> dict[str, Any]:
    """Safe Notebook OS snippets for the realtime explanation prompt.

    Only non-official-firewalled artifact text is eligible. Officially
    firewalled artifacts can exist in the local graph, but this resolver omits
    their body and provenance so prompt context never bypasses the firewall.
    """
    max_items = max(1, min(limit, 8))
    seen: set[int] = set()
    items: list[dict[str, Any]] = []

    def add_artifact(row: StudyArtifact, reason: str) -> None:
        if (
            row.id is None
            or row.id in seen
            or row.official_firewall
            or _question_official(session, row.question_id)
            or _passage_official(session, row.passage_id)
        ):
            return
        seen.add(row.id)
        snippet = row.summary or row.body or row.title
        items.append({
            "kind": row.kind,
            "id": row.id,
            "title": row.title,
            "snippet": _clip(snippet, 360),
            "reason": reason,
        })

    direct_stmt = (
        select(StudyArtifact)
        .where(StudyArtifact.official_firewall == False)  # noqa: E712
        .where(StudyArtifact.question_id == question.id)
        .order_by(StudyArtifact.updated_at.desc())
        .limit(max_items)
    )
    for artifact in session.exec(direct_stmt).all():
        add_artifact(artifact, "question")

    if passage_id and len(items) < max_items:
        passage_stmt = (
            select(StudyArtifact)
            .where(StudyArtifact.official_firewall == False)  # noqa: E712
            .where(StudyArtifact.passage_id == passage_id)
            .order_by(StudyArtifact.updated_at.desc())
            .limit(max_items)
        )
        for artifact in session.exec(passage_stmt).all():
            add_artifact(artifact, "passage")
            if len(items) >= max_items:
                break

    if len(items) < max_items and question.q_type:
        # Safe FTS/type fallback: search excludes official-firewalled bodies.
        try:
            for artifact in search(session, question.q_type, limit=max_items).get("artifacts", []):
                artifact_id = artifact.get("id")
                if not artifact_id:
                    continue
                row = session.get(StudyArtifact, int(artifact_id))
                if row is not None:
                    add_artifact(row, "q_type")
                if len(items) >= max_items:
                    break
        except Exception:
            log.debug("notebook explanation context search failed", exc_info=True)

    artifact_ids = [item["id"] for item in items]
    if artifact_ids and len(items) < max_items:
        notes = session.exec(
            select(NotebookNote)
            .where(NotebookNote.artifact_id.in_(artifact_ids))
            .order_by(NotebookNote.updated_at.desc())
            .limit(max_items)
        ).all()
        for note in notes:
            if len(items) >= max_items:
                break
            content = (note.content or note.title or "").strip()
            if not content:
                continue
            items.append({
                "kind": "note",
                "id": note.id,
                "title": note.title,
                "snippet": _clip(content, 360),
                "reason": "artifact_note",
            })

    notes = [
        f"{item['title']}: {item['snippet']}"
        for item in items
        if item.get("snippet")
    ]
    return {
        "notes": notes,
        "items": [
            {
                "kind": item["kind"],
                "id": item["id"],
                "title": item["title"],
                "reason": item["reason"],
            }
            for item in items
        ],
    }


def study_context_for_targets(
    session: Session,
    *,
    question_ids: list[int] | None = None,
    q_types: list[str] | None = None,
    labels: list[str] | None = None,
    limit: int = 6,
) -> dict[str, Any]:
    """Safe Notebook OS context for plans, coach summaries, and tutor turns.

    This intentionally mirrors the explanation context firewall: official
    artifacts and artifacts tied to official questions/passages are skipped.
    Returned notes are clipped so downstream prompts/UI get context cues, not a
    new path for leaking protected bodies.
    """
    max_items = max(1, min(limit, 8))
    seen: set[int] = set()
    items: list[dict[str, Any]] = []
    question_ids = [int(qid) for qid in (question_ids or []) if qid]
    q_types = [str(qt).strip() for qt in (q_types or []) if str(qt).strip()]
    labels = [str(label).strip() for label in (labels or []) if str(label).strip()]

    def add_artifact(row: StudyArtifact, reason: str) -> None:
        if (
            row.id is None
            or row.id in seen
            or row.official_firewall
            or _question_official(session, row.question_id)
            or _passage_official(session, row.passage_id)
        ):
            return
        seen.add(row.id)
        snippet = row.summary or row.body or row.title
        items.append({
            "kind": row.kind,
            "id": row.id,
            "title": row.title,
            "snippet": _clip(snippet, 280),
            "reason": reason,
            "q_type": row.q_type,
            "question_id": row.question_id,
        })

    for qid in question_ids:
        if len(items) >= max_items:
            break
        q = session.get(Question, qid)
        if q is None:
            continue
        ctx = explanation_context_for_question(session, q, passage_id=q.passage_id, limit=max_items)
        for item in ctx.get("items") or []:
            row = session.get(StudyArtifact, int(item["id"]))
            if row is not None:
                add_artifact(row, str(item.get("reason") or "question"))
            if len(items) >= max_items:
                break

    for q_type in q_types:
        if len(items) >= max_items:
            break
        rows = session.exec(
            select(StudyArtifact)
            .where(StudyArtifact.official_firewall == False)  # noqa: E712
            .where(StudyArtifact.q_type == q_type)
            .order_by(StudyArtifact.updated_at.desc())
            .limit(max_items)
        ).all()
        for row in rows:
            add_artifact(row, "q_type")
            if len(items) >= max_items:
                break

    for label in labels:
        if len(items) >= max_items:
            break
        try:
            for artifact in search(session, label, limit=max_items).get("artifacts", []):
                artifact_id = artifact.get("id")
                if not artifact_id:
                    continue
                row = session.get(StudyArtifact, int(artifact_id))
                if row is not None:
                    add_artifact(row, "label")
                if len(items) >= max_items:
                    break
        except Exception:
            log.debug("notebook study context search failed", exc_info=True)

    artifact_ids = [item["id"] for item in items]
    note_items: list[dict[str, Any]] = []
    if artifact_ids:
        notes = session.exec(
            select(NotebookNote)
            .where(NotebookNote.artifact_id.in_(artifact_ids))
            .order_by(NotebookNote.updated_at.desc())
            .limit(max_items)
        ).all()
        for note in notes:
            content = (note.content or note.title or "").strip()
            if not content:
                continue
            note_items.append({
                "kind": "note",
                "id": note.id,
                "title": note.title,
                "snippet": _clip(content, 280),
                "reason": "artifact_note",
                "artifact_id": note.artifact_id,
            })

    merged = items + note_items
    notes_text = [
        f"{item['title']}: {item['snippet']}"
        for item in merged
        if item.get("snippet")
    ]
    refs = [
        {
            "kind": item["kind"],
            "id": item["id"],
            "title": item["title"],
            "reason": item["reason"],
        }
        for item in merged
    ]
    return {
        "count": len(merged),
        "notes": notes_text[:max_items],
        "items": refs[:max_items],
        "refs": refs[:max_items],
    }


def search(session: Session, q: str, limit: int = 25) -> dict[str, Any]:
    artifacts, artifact_search = _search_artifacts_fts_with_meta(session, q, limit=limit)
    if not artifacts:
        artifacts = list_artifacts(session, q=q, limit=limit)
        artifact_search = {
            **artifact_search,
            "mode": "like_fallback",
            "fallback_used": True,
            "fallback_count": len(artifacts),
        }
    notes = session.exec(
        select(NotebookNote)
        .join(StudyArtifact, NotebookNote.artifact_id == StudyArtifact.id, isouter=True)
        .where(or_(NotebookNote.title.like(f"%{q}%"), NotebookNote.content.like(f"%{q}%")))
        .where(or_(StudyArtifact.id == None, StudyArtifact.official_firewall == False, NotebookNote.title.like(f"%{q}%")))  # noqa: E711,E712
        .order_by(NotebookNote.updated_at.desc())
        .limit(limit)
    ).all()
    source_rows = session.exec(
        select(NotebookSource).order_by(NotebookSource.updated_at.desc()).limit(limit * 4)
    ).all()
    q_lower = q.lower()
    sources = []
    for row in source_rows:
        artifact = session.get(StudyArtifact, row.artifact_id) if row.artifact_id else None
        artifact_body = "" if artifact and artifact.official_firewall else artifact.body if artifact else ""
        haystack = " ".join([row.title, artifact_body, artifact.summary if artifact else ""]).lower()
        if q_lower in haystack:
            sources.append(row)
        if len(sources) >= limit:
            break
    return {
        "query": q,
        "artifacts": [artifact_payload(session, row, include_edges=False) for row in artifacts],
        "notes": [note_payload(row) for row in notes],
        "sources": [source_payload(row) for row in sources],
        "artifact_search": artifact_search,
    }


def _search_artifacts_fts(session: Session, q: str, limit: int = 25) -> list[StudyArtifact]:
    rows, _ = _search_artifacts_fts_with_meta(session, q, limit=limit)
    return rows


def _search_artifacts_fts_with_meta(
    session: Session,
    q: str,
    limit: int = 25,
) -> tuple[list[StudyArtifact], dict[str, Any]]:
    match = _fts_query(q)
    if not match:
        return [], {
            "mode": "none",
            "fallback_used": False,
            "fallback_reason": "empty_query",
            "fts_count": 0,
        }
    try:
        rows = session.execute(
            text(
                "SELECT entity_id FROM knowledge_fts "
                "WHERE knowledge_fts MATCH :match AND entity = 'artifact' "
                "ORDER BY rank LIMIT :limit"
            ),
            {"match": match, "limit": max(1, min(limit, 100))},
        ).all()
    except Exception as exc:
        log.warning("knowledge FTS search failed", exc_info=True)
        return [], {
            "mode": "like_fallback",
            "fallback_used": True,
            "fallback_reason": str(exc)[:300],
            "fts_count": 0,
        }
    ids = [int(row[0]) for row in rows]
    if not ids:
        return [], {
            "mode": "fts",
            "fallback_used": False,
            "fallback_reason": "",
            "fts_count": 0,
        }
    artifact_map = {
        row.id: row
        for row in session.exec(
            select(StudyArtifact).where(StudyArtifact.id.in_(ids))
        ).all()
    }
    ordered = [artifact_map[item] for item in ids if item in artifact_map]
    return ordered, {
        "mode": "fts",
        "fallback_used": False,
        "fallback_reason": "",
        "fts_count": len(ordered),
    }


def default_context_presets(session: Session) -> list[dict[str, Any]]:
    ws = default_workspace(session)
    existing = session.exec(
        select(ContextPreset).where(ContextPreset.workspace_id == ws.id)
    ).all()
    if existing:
        return [context_preset_payload(row) for row in existing]
    presets = [
        ("Off", {"mode": "off"}, {"retrieval": "disabled", "answer_key": "hidden"}),
        ("Summary", {"mode": "summary"}, {"retrieval": "summaries", "answer_key": "hidden"}),
        ("Full", {"mode": "full"}, {"retrieval": "full_local", "answer_key": "hidden"}),
        ("Answer-key locked", {"mode": "answer_key_locked"}, {"answer_key": "never_before_reveal"}),
        ("After-reveal only", {"mode": "after_reveal"}, {"answer_key": "after_reveal"}),
        ("Official-firewalled", {"mode": "official_firewalled"}, {"cloud": "deny_official"}),
    ]
    for name, modes, policy in presets:
        session.add(ContextPreset(workspace_id=ws.id, name=name, modes_json=modes, policy_json=policy))
    session.commit()
    rows = session.exec(select(ContextPreset).where(ContextPreset.workspace_id == ws.id)).all()
    return [context_preset_payload(row) for row in rows]


def create_context_preset(session: Session, body: dict[str, Any]) -> ContextPreset:
    ws = session.get(NotebookWorkspace, body.get("workspace_id")) if body.get("workspace_id") else default_workspace(session)
    row = ContextPreset(
        workspace_id=ws.id,
        name=str(body.get("name") or "Custom preset"),
        modes_json=body.get("modes") if isinstance(body.get("modes"), dict) else {},
        policy_json=body.get("policy") if isinstance(body.get("policy"), dict) else {},
    )
    session.add(row)
    _activity(session, kind="context", status="done", title=f"Context preset saved: {row.name}", entity="context")
    session.commit()
    session.refresh(row)
    return row


def context_preset_payload(row: ContextPreset) -> dict[str, Any]:
    return {
        "id": row.id,
        "workspace_id": row.workspace_id,
        "name": row.name,
        "modes": row.modes_json or {},
        "policy": row.policy_json or {},
        "created_at": _iso(row.created_at),
        "updated_at": _iso(row.updated_at),
    }


def create_chat_session(session: Session, body: dict[str, Any]) -> NotebookChatSession:
    ws = session.get(NotebookWorkspace, body.get("workspace_id")) if body.get("workspace_id") else default_workspace(session)
    row = NotebookChatSession(
        workspace_id=ws.id,
        title=str(body.get("title") or "Notebook tutor"),
        mode=str(body.get("mode") or "summary"),
        model=str(body.get("model") or "local"),
        context_json=body.get("context") if isinstance(body.get("context"), dict) else {},
    )
    session.add(row)
    _activity(session, kind="chat", status="done", title=f"Notebook chat opened: {row.title}", entity="chat")
    session.commit()
    session.refresh(row)
    return row


def chat_session_payload(row: NotebookChatSession) -> dict[str, Any]:
    return {
        "id": row.id,
        "workspace_id": row.workspace_id,
        "title": row.title,
        "mode": row.mode,
        "model": row.model,
        "context": row.context_json or {},
        "created_at": _iso(row.created_at),
        "updated_at": _iso(row.updated_at),
    }


def list_chat_sessions(session: Session) -> list[dict[str, Any]]:
    rows = session.exec(
        select(NotebookChatSession).order_by(NotebookChatSession.updated_at.desc()).limit(100)
    ).all()
    return [chat_session_payload(row) for row in rows]


def message_payload(row: NotebookChatMessage) -> dict[str, Any]:
    return {
        "id": row.id,
        "session_id": row.session_id,
        "role": row.role,
        "content": row.content,
        "citations": row.citations_json or [],
        "meta": row.meta_json or {},
        "created_at": _iso(row.created_at),
    }


def list_chat_messages(session: Session, session_id: int) -> list[dict[str, Any]]:
    rows = session.exec(
        select(NotebookChatMessage)
        .where(NotebookChatMessage.session_id == session_id)
        .order_by(NotebookChatMessage.created_at)
    ).all()
    return [message_payload(row) for row in rows]


def _refs_for_context_mode(
    refs: list[str | dict[str, Any]],
    mode: str,
) -> tuple[list[str | dict[str, Any]], dict[str, Any]]:
    if mode == "off":
        return [], {
            "retrieval": "disabled",
            "filtered_count": len(refs),
            "reason": "context_off",
        }
    if mode == "after_reveal":
        allowed_states = {"revealed", "after_reveal", "review", "reviewed"}
        kept: list[str | dict[str, Any]] = []
        for raw_ref in refs:
            state = str(_as_ref(raw_ref).get("reveal_state") or "safe").lower()
            if state in allowed_states:
                kept.append(raw_ref)
        return kept, {
            "retrieval": "after_reveal_only",
            "filtered_count": len(refs) - len(kept),
            "reason": "requires_revealed_refs",
        }
    return refs, {
        "retrieval": "enabled",
        "filtered_count": 0,
        "reason": mode,
    }


def _clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def _clip(value: str, limit: int = 420) -> str:
    text = _clean_text(value)
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)].rstrip() + "..."


def _model_assisted_text(
    *,
    provider: str,
    model: str | None,
    default_model: str,
    task: str,
    system: str,
    prompt: str,
    fallback: str,
) -> tuple[str, dict[str, Any]]:
    """Use a local model when explicitly requested, otherwise keep deterministic fallback."""
    provider_key = (provider or "local").strip().lower()
    requested_model = (model or "").strip()
    explicit_model = bool(requested_model) and requested_model.lower() not in {
        "local",
        "deterministic",
        "ollama",
        "lmstudio",
    }
    explicit_provider = provider_key in {"ollama", "lmstudio"}
    if not explicit_provider and not explicit_model:
        return fallback, {
            "mode": "template",
            "provider": provider_key,
            "model": requested_model or "deterministic",
            "reason": "local_template_default",
        }
    if explicit_provider and provider_key != config.LOCAL_PROVIDER:
        return fallback, {
            "mode": "template_fallback",
            "provider": provider_key,
            "configured_provider": config.LOCAL_PROVIDER,
            "model": requested_model or default_model,
            "reason": "provider_not_active",
        }
    target_model = requested_model if explicit_model else default_model
    try:
        raw = llm.local_provider().generate(
            target_model,
            prompt,
            system=system,
            timeout=min(float(config.EXPLAIN_REQUEST_TIMEOUT_S), 45.0),
        )
        text = strip_think(str(raw))
        if not text:
            return fallback, {
                "mode": "template_fallback",
                "provider": config.LOCAL_PROVIDER,
                "model": target_model,
                "reason": "empty_model_output",
            }
        return text, {
            "mode": "model",
            "provider": config.LOCAL_PROVIDER,
            "model": target_model,
            "task": task,
        }
    except Exception as exc:  # noqa: BLE001
        log.warning("notebook model generation failed task=%s model=%s", task, target_model, exc_info=True)
        return fallback, {
            "mode": "template_fallback",
            "provider": config.LOCAL_PROVIDER,
            "model": target_model,
            "task": task,
            "reason": str(exc)[:500],
        }


def _sentences(value: str, limit: int = 3) -> list[str]:
    text = _clean_text(value)
    if not text:
        return []
    parts = [part.strip() for part in re.split(r"(?<=[.!?])\s+", text) if part.strip()]
    return [_clip(part, 220) for part in (parts or [text])[:limit]]


def _artifact_for_ref(session: Session, kind: str, entity_id: int | None) -> StudyArtifact | None:
    if entity_id is None:
        return None
    if kind == "artifact":
        return session.get(StudyArtifact, entity_id)
    if kind == "source":
        source = session.get(NotebookSource, entity_id)
        return session.get(StudyArtifact, source.artifact_id) if source and source.artifact_id else None
    if kind == "note":
        note = session.get(NotebookNote, entity_id)
        return session.get(StudyArtifact, note.artifact_id) if note and note.artifact_id else None
    return None


def _evidence_snapshot(session: Session, raw_ref: str | dict[str, Any]) -> dict[str, Any] | None:
    ref = _as_ref(raw_ref)
    target = ref["target"]
    resolved = resolve_target(session, target)
    kind = resolved["kind"]
    try:
        entity_id = int(resolved["entity_id"])
    except (TypeError, ValueError):
        entity_id = None
    official = bool(resolved["official_firewall"])
    body = ""
    summary = resolved.get("snippet") or ""
    meta: dict[str, Any] = {}

    artifact = _artifact_for_ref(session, kind, entity_id)
    if artifact:
        official = official or artifact.official_firewall
        summary = artifact.summary or summary
        if not official:
            body = artifact.body or artifact.summary
        meta = {
            "artifact_id": artifact.id,
            "source_kind": artifact.source_kind,
            "tags": artifact.tags_json or [],
        }
    elif kind == "page" and entity_id is not None:
        page = session.get(NotebookPage, entity_id)
        if page:
            summary = page.summary
            body = page.body
            meta = {"tags": page.tags_json or []}
    elif kind == "question" and entity_id is not None:
        question = session.get(Question, entity_id)
        if question:
            summary = f"{question.q_type} question · difficulty {question.difficulty}"
            if not official:
                choices = session.exec(
                    select(AnswerChoice)
                    .where(AnswerChoice.question_id == question.id)
                    .order_by(AnswerChoice.label)
                ).all()
                choice_lines = "\n".join(f"{choice.label}. {choice.text}" for choice in choices)
                body = "\n\n".join(part for part in [question.stem, question.prompt, choice_lines] if part)
            meta = {"q_type": question.q_type, "difficulty": question.difficulty}
    elif kind == "passage" and entity_id is not None:
        passage = session.get(Passage, entity_id)
        if passage:
            summary = passage.topic or f"Passage {passage.id}"
            if not official:
                body = passage.text
    elif kind == "rationale" and entity_id is not None:
        rationale = session.get(AttemptRationale, entity_id)
        if rationale:
            summary = f"{rationale.stage} rationale"
            if not official:
                body = rationale.rationale_text
            meta = {"stage": rationale.stage, "question_id": rationale.question_id}
    elif kind == "attempt" and entity_id is not None:
        attempt = session.get(Attempt, entity_id)
        if attempt:
            summary = f"Attempt {attempt.id} · answer {attempt.chosen_answer or 'blank'} · {attempt.time_ms} ms"
            if not official:
                body = summary
            meta = {
                "question_id": attempt.question_id,
                "confidence": getattr(attempt.confidence, "value", attempt.confidence),
                "flagged": attempt.flagged,
            }

    explicit_quote = _clean_text(str(ref.get("quote") or ""))
    quote = "" if official else explicit_quote
    excerpt_source = quote or body or summary
    if official:
        excerpt = "Official LSAT content is in scope locally, but its text and answer key stay locked in this response."
    else:
        excerpt = _clip(excerpt_source, 520)
    return {
        "target": target,
        "kind": kind,
        "label": resolved["label"],
        "summary": _clip(summary, 240),
        "excerpt": excerpt,
        "official_firewall": official,
        "export_eligible": not official,
        "meta": meta,
        "sentences": _sentences(excerpt_source, limit=3) if not official else [],
    }


def _evidence_snapshots(
    session: Session,
    refs: list[str | dict[str, Any]],
    *,
    query: str = "",
    limit: int = 6,
    allow_auto_search: bool = True,
) -> list[dict[str, Any]]:
    snapshots: list[dict[str, Any]] = []
    if refs:
        for ref in refs:
            snapshot = _evidence_snapshot(session, ref)
            if snapshot:
                snapshots.append(snapshot)
    elif allow_auto_search:
        candidates = _search_artifacts_fts(session, query, limit=limit) if query else []
        if not candidates:
            candidates = list_artifacts(session, limit=limit)
        for artifact in candidates:
            snapshot = _evidence_snapshot(session, f"artifact:{artifact.id}")
            if snapshot:
                snapshots.append(snapshot)

    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for snapshot in snapshots:
        if snapshot["target"] in seen:
            continue
        seen.add(snapshot["target"])
        deduped.append(snapshot)
        if len(deduped) >= limit:
            break
    return deduped


def _evidence_line(snapshot: dict[str, Any], index: int) -> str:
    return (
        f"{index}. {snapshot['label']} (`{snapshot['target']}`): "
        f"{snapshot['excerpt'] or snapshot['summary']}"
    )


def _evidence_digest(snapshots: list[dict[str, Any]]) -> str:
    if not snapshots:
        return "No local evidence was selected or retrieved."
    return "\n".join(_evidence_line(snapshot, idx) for idx, snapshot in enumerate(snapshots, start=1))


def _build_chat_answer(
    *,
    user_message: str,
    snapshots: list[dict[str, Any]],
    context_mode: str,
    decision: dict[str, Any],
) -> str:
    digest = _evidence_digest(snapshots)
    redacted = sum(1 for item in snapshots if item["official_firewall"])
    if context_mode == "off":
        observation = "Retrieval context is off for this turn, so use this as a process checkpoint instead of an evidence diagnosis."
    elif context_mode == "after_reveal" and not snapshots:
        observation = "After-reveal mode found no revealed evidence refs; mark the cited target as revealed before asking for contrast."
    elif snapshots:
        first_sentences = [
            sentence
            for snapshot in snapshots
            for sentence in snapshot.get("sentences", [])[:1]
        ][:3]
        observation = " ".join(first_sentences) if first_sentences else "The selected evidence is available as local citation scope."
    else:
        observation = "No evidence was selected, so the safest next step is to capture a source, note, rationale, or question before asking for diagnosis."

    policy = (
        "Answer-key policy: hidden before reveal. "
        "Official references stay local-only and are not quoted here."
        if decision.get("official_firewall")
        else "Answer-key policy: hidden before reveal; this turn uses local, export-eligible evidence."
    )
    if redacted:
        policy += f" Redacted local-only refs in this response: {redacted}."

    return "\n\n".join(
        [
            "Evidence-grounded tutor turn",
            policy,
            f"Student ask: {_clip(user_message, 300)}",
            f"Context mode: {context_mode}",
            "Cited evidence:\n" + digest,
            "Socratic next step:\n"
            f"- Prediction: state what you expected before checking the answer.\n"
            f"- Rationale check: compare your reason against this evidence signal: {observation}\n"
            "- Trap check: name the tempting answer pattern, then identify the exact word or role that made it tempting.\n"
            "- Revision: write one sentence that would make your revised answer choice unavoidable before any answer key is revealed.",
        ]
    )


def _keyword_lines(snapshots: list[dict[str, Any]], words: tuple[str, ...], fallback: str) -> list[str]:
    lines: list[str] = []
    for snapshot in snapshots:
        haystack = " ".join(snapshot.get("sentences", []) or [snapshot.get("excerpt", "")])
        matches = [word for word in words if word in haystack.lower()]
        if matches:
            lines.append(f"- {snapshot['label']}: {_clip(haystack, 220)}")
    return lines or [fallback]


def _build_transformation_body(
    *,
    template: str,
    title: str,
    snapshots: list[dict[str, Any]],
    decision: dict[str, Any],
) -> str:
    digest = _evidence_digest(snapshots)
    redacted = sum(1 for item in snapshots if item["official_firewall"])
    policy = (
        f"Firewall: official local-only refs={redacted}; cloud_allowed={str(decision.get('cloud_allowed')).lower()}."
    )

    if template == "extract_rules":
        body_lines = _keyword_lines(
            snapshots,
            ("if", "unless", "only if", "must", "because", "therefore", "principle"),
            "- No explicit rule language found; convert the evidence into a conditional only after manual review.",
        )
        section = "Rule Candidates\n" + "\n".join(body_lines)
    elif template == "generate_flaw_patterns":
        body_lines = _keyword_lines(
            snapshots,
            ("causal", "scope", "assume", "equivocation", "comparison", "necessary", "sufficient", "reversal"),
            "- No named flaw term found; review for scope shifts, causal reversal, and premise/conclusion mismatch.",
        )
        section = "Trap And Flaw Patterns\n" + "\n".join(body_lines)
    elif template == "make_rc_structure_notes":
        body_lines = []
        for snapshot in snapshots:
            sentences = snapshot.get("sentences", [])
            if sentences:
                body_lines.append(f"- {snapshot['label']}: role map starts with {_clip(sentences[0], 180)}")
        section = "RC Structure Notes\n" + "\n".join(body_lines or ["- No passage-like evidence found; capture a passage or paragraph role first."])
    elif template == "create_srs_cards":
        cards = []
        for idx, snapshot in enumerate(snapshots, start=1):
            clue = snapshot.get("sentences", [snapshot.get("excerpt", "")])[0] if (snapshot.get("sentences") or snapshot.get("excerpt")) else snapshot["label"]
            cards.append(
                f"- Front: In `{snapshot['target']}`, what concept or trap should this evidence trigger?\n"
                f"  Back: {_clip(clue, 180)}"
            )
            if idx >= 6:
                break
        section = "Concept-Gap SRS Drafts\n" + "\n".join(cards or ["- Add evidence before generating cards."])
    elif template == "wrong_answer_packet":
        section = (
            "Wrong-Answer Packet\n"
            "- Reconstruct prediction before answer choice review.\n"
            "- Mark the trap feature that attracted the first answer.\n"
            "- Cite the exact local evidence that forced revision.\n"
            "- Convert the mistake into one SRS card or one timed redo."
        )
    elif template == "weekly_study_sheet":
        section = (
            "Weekly Study Sheet\n"
            "- Start with the cited weakest pattern.\n"
            "- Do one short review block, one timed official block, and one Blind Review rationale block.\n"
            "- End each session by saving a note linked to the evidence target."
        )
    else:
        section = (
            "Evidence Summary\n"
            + "\n".join(
                f"- {snapshot['label']}: {_clip(snapshot.get('excerpt', ''), 240)}"
                for snapshot in snapshots
            )
            if snapshots
            else "Evidence Summary\n- Add local sources, notes, rationales, or questions to generate a stronger synthesis."
        )

    return "\n\n".join(
        [
            f"# {title}",
            f"Template: {template}",
            policy,
            "Evidence Scope\n" + digest,
            section,
            "Next Study Action\nSave this artifact as a note, make SRS drafts, or attach it to the next Blind Review worksheet.",
        ]
    )


def _build_podcast_transcript(
    *,
    title: str,
    episode_type: str,
    snapshots: list[dict[str, Any]],
    decision: dict[str, Any],
) -> str:
    digest_items = snapshots[:5]
    evidence_lines = "\n".join(
        f"- {item['label']}: {item['excerpt']}" for item in digest_items
    ) or "- No evidence selected yet."
    redacted = sum(1 for item in snapshots if item["official_firewall"])
    return "\n\n".join(
        [
            title,
            f"Episode type: {episode_type}",
            "Privacy note: this briefing is generated locally. "
            f"Official local-only references redacted from transcript body: {redacted}.",
            "Opening: Today we turn the notebook into a study loop: evidence, prediction, trap check, revision.",
            "Evidence rundown:\n" + evidence_lines,
            "Study prompt: pause after each item, say the trap in one sentence, then state the correction rule.",
            "Close: choose one cited target and save a follow-up note before the next timed block.",
            f"Cloud allowed for this source set: {str(decision.get('cloud_allowed')).lower()}",
        ]
    )


def _slug(value: str, *, fallback: str = "briefing") -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip()).strip("-._")
    return (slug or fallback)[:80]


def _podcast_audio_dir() -> Path:
    path = config.EXPORT_DIR / "podcasts"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _synthesize_podcast_audio(
    *,
    episode_id: int,
    title: str,
    transcript: str,
) -> tuple[str | None, dict[str, Any]]:
    """Create a local WAV briefing with Windows SAPI when available.

    This is intentionally cloud-free. If the local TTS surface is unavailable we
    keep the transcript and expose the reason in metadata instead of failing the
    study flow.
    """
    exe = shutil.which("powershell.exe") or shutil.which("powershell") or shutil.which("pwsh")
    if not exe:
        return None, {"status": "unavailable", "reason": "powershell_not_found"}

    audio_dir = _podcast_audio_dir()
    out_path = audio_dir / f"{episode_id:06d}-{_slug(title)}.wav"
    spoken_text = transcript[:12_000]
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".txt", delete=False) as tmp:
        tmp.write(spoken_text)
        input_path = tmp.name

    script = (
        "& { param($InputPath, $OutputPath) "
        "Add-Type -AssemblyName System.Speech; "
        "$text = Get-Content -LiteralPath $InputPath -Raw; "
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        "$s.Rate = -1; $s.Volume = 100; "
        "$s.SetOutputToWaveFile($OutputPath); "
        "$s.Speak($text); "
        "$s.Dispose(); "
        "}"
    )
    try:
        result = subprocess.run(
            [
                exe,
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
                input_path,
                str(out_path),
            ],
            capture_output=True,
            text=True,
            timeout=90,
            check=False,
        )
    finally:
        try:
            Path(input_path).unlink(missing_ok=True)
        except OSError:
            pass

    if result.returncode != 0 or not out_path.exists() or out_path.stat().st_size == 0:
        return None, {
            "status": "failed",
            "reason": (result.stderr or result.stdout or "tts_failed").strip()[:500],
        }
    return str(out_path), {
        "status": "audio_ready",
        "format": "wav",
        "bytes": out_path.stat().st_size,
        "chars_spoken": len(spoken_text),
        "truncated": len(spoken_text) < len(transcript),
        "provider": "windows_sapi",
    }


def add_chat_turn(session: Session, session_id: int, body: dict[str, Any]) -> dict[str, Any]:
    chat = session.get(NotebookChatSession, session_id)
    if not chat:
        raise ValueError("chat_not_found")
    refs = body.get("refs") if isinstance(body.get("refs"), list) else []
    context_refs = (chat.context_json or {}).get("refs", [])
    if isinstance(context_refs, list):
        refs = [*context_refs, *refs]
    mode = _context_mode(str(body.get("mode") or chat.mode))
    chat.mode = mode
    retrieval_refs, retrieval_meta = _refs_for_context_mode(refs, mode)
    snapshots = _evidence_snapshots(
        session,
        retrieval_refs,
        query=str(body.get("content") or ""),
        limit=6,
        allow_auto_search=mode not in {"off", "after_reveal"},
    )
    decision = _firewall_decision_for_scope(
        session,
        refs,
        provider=chat.model,
        snapshots=snapshots,
    )
    if decision["blocked"]:
        raise ValueError("official_firewall_block")
    citation_refs = retrieval_refs or [snapshot["target"] for snapshot in snapshots]
    citations = [resolve_target(session, (_as_ref(ref))["target"]) for ref in citation_refs]
    user = NotebookChatMessage(
        session_id=session_id,
        role=str(body.get("role") or "user"),
        content=str(body.get("content") or ""),
        citations_json=refs,
        meta_json={"context_mode": mode, "retrieval": retrieval_meta},
    )
    session.add(user)
    session.flush()
    fallback_answer = _build_chat_answer(
        user_message=str(body.get("content") or ""),
        snapshots=snapshots,
        context_mode=mode,
        decision=decision,
    )
    answer, generation_meta = _model_assisted_text(
        provider=chat.model,
        model=chat.model,
        default_model=config.EXPLAIN_MODEL,
        task="notebook_chat",
        system=(
            "You are LSATLab's local Socratic Notebook tutor. Use only the provided "
            "local evidence digest, keep answer keys hidden before reveal, cite target "
            "ids plainly, and never quote official LSAT text."
        ),
        prompt="\n\n".join(
            [
                f"Context mode: {mode}",
                f"Firewall decision: {decision}",
                "Evidence digest:\n" + _evidence_digest(snapshots),
                f"Student ask:\n{str(body.get('content') or '')}",
                "Write a concise Socratic response with prediction, rationale check, trap check, and revision step.",
            ]
        ),
        fallback=fallback_answer,
    )
    assistant_artifact = StudyArtifact(
        workspace_id=chat.workspace_id,
        kind="tutor_turn",
        title=f"Notebook tutor turn · {chat.title}",
        body=answer,
        summary=answer[:220],
        source_kind="notebook_chat",
        official_firewall=decision["official_firewall"],
        cloud_allowed=False if decision["official_firewall"] else True,
        export_eligible=False if decision["official_firewall"] else True,
        meta_json={
            "chat_session_id": session_id,
            "context_mode": mode,
            "answer_key_policy": "hidden_before_reveal",
            "evidence_count": len(snapshots),
            "redacted_count": sum(1 for item in snapshots if item["official_firewall"]),
            "retrieval": retrieval_meta,
            "generation": generation_meta,
        },
    )
    session.add(assistant_artifact)
    session.flush()
    _create_edges(session, assistant_artifact, citation_refs)
    _artifact_version(session, assistant_artifact, reason="chat_turn")
    _index_artifact(session, assistant_artifact)
    session.add(
        KnowledgeInboxItem(
            artifact_id=assistant_artifact.id,
            origin="notebook_chat",
            priority=1,
            reason="Tutor answer saved as cited evidence",
        )
    )
    assistant = NotebookChatMessage(
        session_id=session_id,
        role="assistant",
        content=answer,
        citations_json=[{"target": c["target"], "label": c["label"], "official_firewall": c["official_firewall"]} for c in citations],
        meta_json={
            "artifact_id": assistant_artifact.id,
            "firewall_decision": decision,
            "answer_key_policy": "hidden_before_reveal",
            "context_mode": mode,
            "evidence_count": len(snapshots),
            "redacted_count": sum(1 for item in snapshots if item["official_firewall"]),
            "retrieval": retrieval_meta,
            "generation": generation_meta,
        },
    )
    chat.updated_at = utcnow()
    session.add(assistant)
    _activity(
        session,
        kind="chat",
        status="done",
        title="Notebook tutor turn saved",
        detail={
            "session_id": session_id,
            "citation_count": len(citations),
            "evidence_count": len(snapshots),
        },
        entity="chat",
        entity_id=session_id,
    )
    session.commit()
    session.refresh(assistant)
    return {
        "user": message_payload(user),
        "assistant": message_payload(assistant),
        "firewall_decision": decision,
    }


def run_transformation(session: Session, body: dict[str, Any]) -> TransformationRun:
    refs = body.get("input_refs") if isinstance(body.get("input_refs"), list) else []
    provider = str(body.get("provider") or "local")
    template = str(body.get("template_key") or "summarize")
    title = str(body.get("title") or template.replace("_", " ").title())
    snapshots = _evidence_snapshots(
        session,
        refs,
        query=" ".join(str(part) for part in [body.get("prompt"), template, title] if part),
        limit=8,
    )
    decision = _firewall_decision_for_scope(
        session,
        refs,
        provider=provider,
        snapshots=snapshots,
    )
    if decision["blocked"]:
        raise ValueError("official_firewall_block")
    citation_refs = refs or [snapshot["target"] for snapshot in snapshots]
    fallback_body = _build_transformation_body(
        template=template,
        title=title,
        snapshots=snapshots,
        decision=decision,
    )
    output_body, generation_meta = _model_assisted_text(
        provider=provider,
        model=str(body.get("model") or ""),
        default_model=config.GEN_MODEL,
        task=f"notebook_transformation:{template}",
        system=(
            "You are LSATLab's local Notebook transformation engine. Produce a "
            "study artifact from the local evidence digest. Keep official LSAT text "
            "redacted, preserve citation target ids, and do not introduce answer keys."
        ),
        prompt="\n\n".join(
            [
                f"Title: {title}",
                f"Template: {template}",
                f"Prompt: {str(body.get('prompt') or '')}",
                f"Firewall decision: {decision}",
                "Evidence digest:\n" + _evidence_digest(snapshots),
                "Return a polished study artifact in Markdown.",
            ]
        ),
        fallback=fallback_body,
    )
    output = capture_artifact(
        session,
        {
            "workspace_id": body.get("workspace_id"),
            "kind": "transformation",
            "title": title,
            "body": output_body,
            "source_kind": "transformation",
            "refs": citation_refs,
            "origin": "transformation",
            "official_firewall": decision["official_firewall"],
            "cloud_allowed": decision["cloud_allowed"],
            "export_eligible": decision["export_eligible"],
            "meta": {
                "evidence_count": len(snapshots),
                "redacted_count": sum(1 for item in snapshots if item["official_firewall"]),
                "template": template,
                "generation": generation_meta,
            },
        },
        commit=False,
    )
    ws = session.get(NotebookWorkspace, body.get("workspace_id")) if body.get("workspace_id") else default_workspace(session)
    row = TransformationRun(
        workspace_id=ws.id,
        template_key=template,
        status="done",
        prompt=str(body.get("prompt") or f"Run {template} over selected local evidence."),
        input_refs_json=citation_refs,
        output_artifact_id=output.id,
        provider=provider,
        model=str(body.get("model") or provider),
        firewall_decision_json=decision,
        metrics_json={
            "input_count": len(refs),
            "evidence_count": len(snapshots),
            "redacted_count": sum(1 for item in snapshots if item["official_firewall"]),
            "output_chars": len(output.body),
            "generation": generation_meta,
        },
    )
    session.add(row)
    session.flush()
    _activity(
        session,
        kind="transformation",
        status="done",
        title=f"Transformation complete: {template}",
        detail={
            "output_artifact_id": output.id,
            "official_firewall": decision["official_firewall"],
            "evidence_count": len(snapshots),
        },
        entity="transformation",
        entity_id=row.id,
    )
    session.commit()
    session.refresh(row)
    return row


def transformation_payload(row: TransformationRun) -> dict[str, Any]:
    return {
        "id": row.id,
        "workspace_id": row.workspace_id,
        "template_key": row.template_key,
        "status": row.status,
        "prompt": row.prompt,
        "input_refs": row.input_refs_json or [],
        "output_artifact_id": row.output_artifact_id,
        "provider": row.provider,
        "model": row.model,
        "firewall_decision": row.firewall_decision_json or {},
        "metrics": row.metrics_json or {},
        "created_at": _iso(row.created_at),
        "updated_at": _iso(row.updated_at),
    }


def list_transformations(session: Session) -> list[dict[str, Any]]:
    rows = session.exec(select(TransformationRun).order_by(TransformationRun.created_at.desc()).limit(100)).all()
    return [transformation_payload(row) for row in rows]


def create_podcast(session: Session, body: dict[str, Any]) -> PodcastEpisode:
    refs = body.get("source_refs") if isinstance(body.get("source_refs"), list) else []
    provider = str(body.get("provider") or "local")
    ws = session.get(NotebookWorkspace, body.get("workspace_id")) if body.get("workspace_id") else default_workspace(session)
    title = str(body.get("title") or "Notebook study briefing")
    episode_type = str(body.get("episode_type") or "weekly_briefing")
    snapshots = _evidence_snapshots(session, refs, query=f"{title} {episode_type}", limit=8)
    decision = _firewall_decision_for_scope(
        session,
        refs,
        provider=provider,
        snapshots=snapshots,
    )
    if decision["blocked"]:
        raise ValueError("official_firewall_block")
    citation_refs = refs or [snapshot["target"] for snapshot in snapshots]
    fallback_transcript = _build_podcast_transcript(
        title=title,
        episode_type=episode_type,
        snapshots=snapshots,
        decision=decision,
    )
    if body.get("transcript"):
        transcript = str(body.get("transcript") or "")
        generation_meta = {
            "mode": "provided_transcript",
            "provider": provider,
            "model": str(body.get("model") or provider),
        }
    else:
        transcript, generation_meta = _model_assisted_text(
            provider=provider,
            model=str(body.get("model") or ""),
            default_model=config.GEN_MODEL,
            task=f"notebook_podcast:{episode_type}",
            system=(
                "You are LSATLab's local study briefing writer. Produce an audio-friendly "
                "transcript from the local evidence digest. Keep official LSAT text redacted "
                "and preserve citation target ids when useful."
            ),
            prompt="\n\n".join(
                [
                    f"Title: {title}",
                    f"Episode type: {episode_type}",
                    f"Firewall decision: {decision}",
                    "Evidence digest:\n" + _evidence_digest(snapshots),
                    "Return a concise spoken transcript.",
                ]
            ),
            fallback=fallback_transcript,
        )
    firewall_meta = {**dict(decision), "generation": generation_meta}
    row = PodcastEpisode(
        workspace_id=ws.id,
        title=title,
        episode_type=episode_type,
        status="transcript_ready",
        transcript=transcript,
        source_refs_json=citation_refs,
        provider=provider,
        firewall_decision_json=firewall_meta,
        duration_sec=max(30, len(transcript) // 14),
    )
    session.add(row)
    session.flush()
    tts_detail: dict[str, Any] = {"status": "not_requested"}
    if bool(body.get("generate_audio")):
        audio_path, tts_detail = _synthesize_podcast_audio(
            episode_id=int(row.id or 0),
            title=title,
            transcript=transcript,
        )
        if audio_path:
            row.audio_path = audio_path
            row.status = "audio_ready"
        firewall_meta = {**firewall_meta, "local_tts": tts_detail}
        row.firewall_decision_json = firewall_meta
        row.updated_at = utcnow()
        session.add(row)
    _activity(
        session,
        kind="podcast",
        status="done",
        title=(
            f"Briefing audio created: {title}"
            if row.status == "audio_ready" else f"Briefing transcript created: {title}"
        ),
        detail={
            "episode_type": episode_type,
            "official_firewall": decision["official_firewall"],
            "evidence_count": len(snapshots),
            "redacted_count": sum(1 for item in snapshots if item["official_firewall"]),
            "audio_status": row.status,
            "tts": tts_detail,
            "generation": generation_meta,
        },
        entity="podcast",
        entity_id=row.id,
    )
    session.commit()
    session.refresh(row)
    return row


def podcast_audio_file(session: Session, episode_id: int) -> Path:
    row = session.get(PodcastEpisode, episode_id)
    if not row or not row.audio_path:
        raise ValueError("audio_not_found")
    root = _podcast_audio_dir().resolve()
    path = Path(row.audio_path)
    if not path.is_absolute():
        path = root / path
    resolved = path.resolve()
    if root != resolved and root not in resolved.parents:
        raise ValueError("audio_not_found")
    if not resolved.exists() or not resolved.is_file():
        raise ValueError("audio_not_found")
    return resolved


def podcast_payload(row: PodcastEpisode) -> dict[str, Any]:
    return {
        "id": row.id,
        "workspace_id": row.workspace_id,
        "title": row.title,
        "episode_type": row.episode_type,
        "status": row.status,
        "transcript": row.transcript,
        "audio_path": row.audio_path,
        "source_refs": row.source_refs_json or [],
        "provider": row.provider,
        "firewall_decision": row.firewall_decision_json or {},
        "duration_sec": row.duration_sec,
        "created_at": _iso(row.created_at),
        "updated_at": _iso(row.updated_at),
    }


def list_podcasts(session: Session) -> list[dict[str, Any]]:
    rows = session.exec(select(PodcastEpisode).order_by(PodcastEpisode.created_at.desc()).limit(100)).all()
    return [podcast_payload(row) for row in rows]


def activity_feed(session: Session, limit: int = 100) -> list[dict[str, Any]]:
    rows = session.exec(select(ActivityEvent).order_by(ActivityEvent.created_at.desc()).limit(limit)).all()
    return [
        {
            "id": row.id,
            "kind": row.kind,
            "status": row.status,
            "title": row.title,
            "detail": row.detail_json or {},
            "entity": row.entity,
            "entity_id": row.entity_id,
            "progress_pct": row.progress_pct,
            "created_at": _iso(row.created_at),
            "updated_at": _iso(row.updated_at),
        }
        for row in rows
    ]
