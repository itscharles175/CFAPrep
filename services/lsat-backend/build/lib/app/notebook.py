"""Local notebook/wiki helpers for the Tutor OS."""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from sqlmodel import Session, or_, select

from .models import (
    Attempt,
    NotebookPage,
    NotebookQuestionLink,
    Question,
)


def _now():
    return datetime.now(timezone.utc)


def slugify(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return slug or "note"


def summarize(body: str, title: str = "") -> str:
    text = re.sub(r"\s+", " ", body or "").strip()
    if not text:
        return f"Notebook page for {title}".strip()
    sentences = re.split(r"(?<=[.!?])\s+", text)
    summary = " ".join(sentences[:2]).strip()
    return summary[:320]


def unique_slug(session: Session, title: str, *, page_id: int | None = None) -> str:
    base = slugify(title)
    slug = base
    i = 2
    while True:
        row = session.exec(select(NotebookPage).where(NotebookPage.slug == slug)).first()
        if row is None or row.id == page_id:
            return slug
        slug = f"{base}-{i}"
        i += 1


def create_page(
    session: Session,
    *,
    title: str,
    body: str = "",
    tags: list[str] | None = None,
) -> NotebookPage:
    now = _now()
    page = NotebookPage(
        title=title.strip(),
        slug=unique_slug(session, title),
        body=body,
        summary=summarize(body, title),
        tags_json=_clean_tags(tags or []),
        created_at=now,
        updated_at=now,
    )
    session.add(page)
    session.commit()
    session.refresh(page)
    return page


def update_page(
    session: Session,
    page_id: int,
    *,
    title: str | None = None,
    body: str | None = None,
    tags: list[str] | None = None,
) -> NotebookPage:
    page = session.get(NotebookPage, page_id)
    if page is None:
        raise ValueError("page_not_found")
    if title is not None and title.strip() and title.strip() != page.title:
        page.title = title.strip()
        page.slug = unique_slug(session, page.title, page_id=page.id)
    if body is not None:
        page.body = body
        page.summary = summarize(body, page.title)
    if tags is not None:
        page.tags_json = _clean_tags(tags)
    page.updated_at = _now()
    session.add(page)
    session.commit()
    session.refresh(page)
    return page


def search_pages(session: Session, query: str | None = None, tag: str | None = None) -> list[NotebookPage]:
    stmt = select(NotebookPage).order_by(NotebookPage.updated_at.desc())
    if query:
        like = f"%{query.strip()}%"
        stmt = stmt.where(
            or_(
                NotebookPage.title.like(like),
                NotebookPage.body.like(like),
                NotebookPage.summary.like(like),
            )
        )
    rows = session.exec(stmt.limit(100)).all()
    if tag:
        needle = tag.strip().lower()
        rows = [p for p in rows if needle in {str(t).lower() for t in (p.tags_json or [])}]
    return rows


def link_question(
    session: Session,
    *,
    page_id: int,
    question_id: int,
    attempt_id: int | None = None,
    label: str = "",
    note: str = "",
) -> NotebookQuestionLink:
    if session.get(NotebookPage, page_id) is None:
        raise ValueError("page_not_found")
    if session.get(Question, question_id) is None:
        raise ValueError("question_not_found")
    if attempt_id is not None and session.get(Attempt, attempt_id) is None:
        raise ValueError("attempt_not_found")
    row = session.exec(
        select(NotebookQuestionLink)
        .where(NotebookQuestionLink.page_id == page_id)
        .where(NotebookQuestionLink.question_id == question_id)
        .where(NotebookQuestionLink.attempt_id == attempt_id)
    ).first()
    if row is None:
        row = NotebookQuestionLink(
            page_id=page_id,
            question_id=question_id,
            attempt_id=attempt_id,
        )
    row.label = label
    row.note = note
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def page_payload(session: Session, page: NotebookPage, *, include_links: bool = True) -> dict[str, Any]:
    links: list[dict[str, Any]] = []
    if include_links and page.id is not None:
        rows = session.exec(
            select(NotebookQuestionLink)
            .where(NotebookQuestionLink.page_id == page.id)
            .order_by(NotebookQuestionLink.id)
        ).all()
        for row in rows:
            q = session.get(Question, row.question_id)
            links.append(
                {
                    "id": row.id,
                    "question_id": row.question_id,
                    "attempt_id": row.attempt_id,
                    "label": row.label,
                    "note": row.note,
                    "q_type": q.q_type if q else None,
                    "source": q.source.value if q and hasattr(q.source, "value") else (str(q.source) if q else None),
                    "created_at": row.created_at.isoformat(),
                }
            )
    return {
        "id": page.id,
        "title": page.title,
        "slug": page.slug,
        "body": page.body,
        "summary": page.summary,
        "tags": page.tags_json or [],
        "links": links,
        "created_at": page.created_at.isoformat(),
        "updated_at": page.updated_at.isoformat(),
    }


def study_sheet(session: Session, page_id: int) -> dict[str, Any]:
    page = session.get(NotebookPage, page_id)
    if page is None:
        raise ValueError("page_not_found")
    payload = page_payload(session, page)
    linked_types = sorted({str(link.get("q_type")) for link in payload["links"] if link.get("q_type")})
    html = (
        "<article>"
        f"<h1>{_escape(page.title)}</h1>"
        f"<p>{_escape(page.summary)}</p>"
        f"<div>{_escape(page.body).replace(chr(10), '<br>')}</div>"
        f"<p><strong>Linked types:</strong> {', '.join(linked_types) or 'None yet'}</p>"
        "</article>"
    )
    return {"page": payload, "linked_types": linked_types, "html": html}


def _clean_tags(tags: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for tag in tags:
        cleaned = re.sub(r"\s+", " ", str(tag)).strip()
        if not cleaned:
            continue
        key = cleaned.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(cleaned[:40])
    return out[:20]


def _escape(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
