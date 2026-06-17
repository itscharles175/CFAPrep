"""LSAT-5 — passage-first RC generation endpoints.

Mounted under ``/api`` (so the full prefix is ``/api/generation``), distinct from
the gen-job CRUD on ``generation_routes`` (``/api/gen/...``). Three endpoints:

  * ``POST /api/generation/passages`` — start a passage-first job: generate ONE
    coherent RC passage and attach several varied questions to it.
  * ``GET  /api/generation/passages/{passage_id}/questions`` — the questions the
    pipeline attached to a given passage (review-mode shape, with the answer key).
  * ``GET  /api/generation/passages/{job_id}/progress`` — progress for a
    passage-first job (same shape as the gen-job progress endpoint).

The job is enqueued through the durable worker exactly like a normal gen job; the
only difference is the ``passage_first`` flag, which routes ``generation.run_job``
to ``passage_generator.run_passage_first_job``. Additive: existing generation
endpoints are untouched.
"""
from __future__ import annotations

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, StringConstraints
from sqlmodel import Session, select

from .. import jobs, serializers
from ..db import get_session
from ..models import GenJob, GenStatus, Passage, Question

router = APIRouter(prefix="/generation")

QType = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)
]


class PassageJobBody(BaseModel):
    """Start a passage-first RC generation job.

    ``q_type`` is the LEAD RC question type (the one the coach asked to backfill);
    the runner fills out a varied 3-4 question set around it. ``count`` caps the
    number of questions attached to the single generated passage.
    """

    q_type: QType = Field(default="MainPoint")
    count: int = Field(default=4, ge=1, le=8)
    priority: int = Field(default=0, ge=-100, le=100)
    max_retries: int = Field(default=0, ge=0, le=5)


@router.post("/passages")
def create_passage_job(body: PassageJobBody, session: Session = Depends(get_session)):
    """Queue a passage-first RC job. The durable worker drains it; returns at once.

    Enqueues a normal gen job and flips its ``passage_first`` flag so
    ``generation.run_job`` dispatches to the passage-first orchestrator (generate
    ONE passage, then attach a varied question set). The flag is set on the row
    after enqueue so the existing ``jobs.enqueue`` signature is untouched.
    """
    jid = jobs.enqueue(
        session,
        body.q_type,
        body.count,
        priority=body.priority,
        max_retries=body.max_retries,
    )
    job = session.get(GenJob, jid)
    if job is not None:
        job.passage_first = True
        session.add(job)
        session.commit()
    return {
        "job_id": jid,
        "status": GenStatus.queued.value,
        "passage_first": True,
        "q_type": body.q_type,
        "count": body.count,
    }


@router.get("/passages/{passage_id}/questions")
def passage_questions(passage_id: int, session: Session = Depends(get_session)):
    """The questions the pipeline attached to one generated passage.

    Returns the passage text + topic and every (non-soft-deleted) question that
    shares this ``passage_id``, in review-mode shape (full answer key) so the
    generation-review UI can show the credited answer and trap labels. 404 when
    the passage does not exist.
    """
    passage = session.get(Passage, passage_id)
    if passage is None:
        raise HTTPException(404, "Passage not found")
    rows = session.exec(
        select(Question)
        .where(Question.passage_id == passage_id)
        .where(Question.deleted_at == None)  # noqa: E711
        .order_by(Question.id)
    ).all()
    return {
        "passage_id": passage_id,
        "passage": passage.text,
        "topic": passage.topic,
        "type": passage.type,
        "questions": [serializers.question_review_mode(session, q) for q in rows],
        "count": len(rows),
    }


@router.get("/passages/{job_id}/progress")
def passage_job_progress(job_id: int, session: Session = Depends(get_session)):
    """Progress for a passage-first job (same shape as the gen-job progress).

    ``job_id`` here is a ``GenJob`` id (the value returned by ``POST
    /api/generation/passages``), NOT a passage id; the path is distinguished from
    ``/questions`` by its suffix. 404 when the job does not exist.
    """
    job = session.get(GenJob, job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    payload = jobs.progress_payload(job)
    payload["passage_first"] = bool(getattr(job, "passage_first", False))
    return payload
