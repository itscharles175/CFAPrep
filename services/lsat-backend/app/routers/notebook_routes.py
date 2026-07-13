"""Tutor OS notebook/wiki endpoints."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, StringConstraints
from sqlmodel import Session

from .. import notebook
from ..db import get_session

router = APIRouter(prefix="/notebook")

ShortTitle = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]


class PageBody(BaseModel):
    title: ShortTitle
    body: str = Field(default="", max_length=40000)
    tags: list[str] = Field(default_factory=list, max_length=20)


class PagePatch(BaseModel):
    title: ShortTitle | None = None
    body: str | None = Field(default=None, max_length=40000)
    tags: list[str] | None = Field(default=None, max_length=20)


class LinkBody(BaseModel):
    question_id: int = Field(gt=0)
    attempt_id: int | None = Field(default=None, gt=0)
    label: str = Field(default="", max_length=120)
    note: str = Field(default="", max_length=2000)


@router.get("/pages")
def list_pages(
    q: str | None = Query(default=None, max_length=120),
    tag: str | None = Query(default=None, max_length=40),
    session: Session = Depends(get_session),
):
    return [notebook.page_payload(session, row, include_links=False) for row in notebook.search_pages(session, q, tag)]


@router.post("/pages")
def create_page(body: PageBody, session: Session = Depends(get_session)):
    return notebook.page_payload(
        session,
        notebook.create_page(session, title=body.title, body=body.body, tags=body.tags),
    )


@router.get("/pages/{page_id}")
def get_page(page_id: int, session: Session = Depends(get_session)):
    page = session.get(notebook.NotebookPage, page_id)
    if page is None:
        raise HTTPException(404, "Notebook page not found")
    return notebook.page_payload(session, page)


@router.patch("/pages/{page_id}")
def update_page(page_id: int, body: PagePatch, session: Session = Depends(get_session)):
    try:
        page = notebook.update_page(
            session,
            page_id,
            title=body.title,
            body=body.body,
            tags=body.tags,
        )
    except ValueError as exc:
        if str(exc) == "page_not_found":
            raise HTTPException(404, "Notebook page not found") from exc
        raise
    return notebook.page_payload(session, page)


@router.post("/pages/{page_id}/links")
def link_question(page_id: int, body: LinkBody, session: Session = Depends(get_session)):
    try:
        row = notebook.link_question(
            session,
            page_id=page_id,
            question_id=body.question_id,
            attempt_id=body.attempt_id,
            label=body.label,
            note=body.note,
        )
    except ValueError as exc:
        mapping = {
            "page_not_found": "Notebook page not found",
            "question_not_found": "Question not found",
            "attempt_not_found": "Attempt not found",
        }
        if str(exc) in mapping:
            raise HTTPException(404, mapping[str(exc)]) from exc
        raise
    return {
        "id": row.id,
        "page_id": row.page_id,
        "question_id": row.question_id,
        "attempt_id": row.attempt_id,
        "label": row.label,
        "note": row.note,
        "created_at": row.created_at.isoformat(),
    }


@router.get("/pages/{page_id}/study-sheet")
def study_sheet(page_id: int, session: Session = Depends(get_session)):
    try:
        return notebook.study_sheet(session, page_id)
    except ValueError as exc:
        if str(exc) == "page_not_found":
            raise HTTPException(404, "Notebook page not found") from exc
        raise
