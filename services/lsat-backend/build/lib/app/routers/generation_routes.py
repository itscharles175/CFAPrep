"""Tier B generation endpoints: jobs, status, quarantine review."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, StringConstraints
from sqlmodel import Session, select

from .. import audit, generation, jobs, serializers
from ..db import get_session
from ..models import GenJob, GenStatus, Question, QuestionSource

router = APIRouter(prefix="/gen")

QType = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)
]


class JobBody(BaseModel):
    q_type: QType
    count: int = Field(default=3, ge=1, le=50)
    # Optional: pin generation to one parent so the orchestrator can target
    # specific weak items rather than rotating across the whole bank.
    parent_question_id: int | None = Field(default=None, gt=0)
    priority: int = Field(default=0, ge=-100, le=100)
    max_retries: int = Field(default=0, ge=0, le=5)


class PriorityBody(BaseModel):
    priority: int = Field(ge=-100, le=100)


@router.post("/jobs")
def create_job(body: JobBody, session: Session = Depends(get_session)):
    """Queue a generation job. The durable worker drains it; this returns at once."""
    jid = jobs.enqueue(
        session,
        body.q_type,
        body.count,
        parent_question_id=body.parent_question_id,
        priority=body.priority,
        max_retries=body.max_retries,
    )
    return {"job_id": jid, "status": GenStatus.queued.value}


@router.get("/jobs")
def list_jobs(
    limit: int = Query(default=50, ge=1, le=200),
    session: Session = Depends(get_session),
):
    """Recent jobs (newest first) so the UI can show the generation queue."""
    rows = session.exec(
        select(GenJob).order_by(GenJob.id.desc()).limit(limit)
    ).all()
    payloads = []
    for j in rows:
        progress = jobs.progress_payload(j)
        payloads.append({
            "id": j.id,
            "status": j.status.value,
            "q_type": j.q_type,
            "count": j.count,
            "produced": j.produced,
            "accepted": j.accepted,
            "quarantined": j.quarantined,
            "priority": j.priority,
            "progress_pct": progress["progress_pct"],
            "retry_count": j.retry_count,
            "max_retries": j.max_retries,
            "retry_pending": progress["retry_pending"],
            "retry_exhausted": progress["retry_exhausted"],
            "created_at": j.created_at.isoformat(),
            "updated_at": j.updated_at.isoformat() if j.updated_at else None,
            "cancelled_at": j.cancelled_at.isoformat() if j.cancelled_at else None,
        })
    return payloads


@router.get("/jobs/{job_id}")
def get_job(job_id: int, session: Session = Depends(get_session)):
    job = session.get(GenJob, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    progress = jobs.progress_payload(job)
    return {
        "id": job.id,
        "status": job.status.value,
        "produced": job.produced,
        "accepted": job.accepted,
        "quarantined": job.quarantined,
        "priority": job.priority,
        "progress_pct": progress["progress_pct"],
        "retry_count": job.retry_count,
        "max_retries": job.max_retries,
        "retry_pending": progress["retry_pending"],
        "retry_exhausted": progress["retry_exhausted"],
        "validation_report": job.validation_report,
    }


@router.get("/jobs/{job_id}/progress")
def get_job_progress(job_id: int, session: Session = Depends(get_session)):
    job = session.get(GenJob, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return jobs.progress_payload(job)


@router.patch("/jobs/{job_id}/cancel")
def cancel_job(job_id: int, session: Session = Depends(get_session)):
    result = jobs.cancel_job(session, job_id)
    if not result["ok"] and result.get("reason") == "job_not_found":
        raise HTTPException(404, "Job not found")
    return result


@router.patch("/jobs/{job_id}/retry")
def retry_job(job_id: int, session: Session = Depends(get_session)):
    result = jobs.retry_failed_job(session, job_id, reason="manual_retry")
    if not result["ok"] and result.get("reason") == "job_not_found":
        raise HTTPException(404, "Job not found")
    if not result["ok"]:
        raise HTTPException(409, result["reason"])
    return result


@router.patch("/jobs/{job_id}/priority")
def update_priority(job_id: int, body: PriorityBody,
                    session: Session = Depends(get_session)):
    result = jobs.set_priority(session, job_id, body.priority)
    if not result["ok"] and result.get("reason") == "job_not_found":
        raise HTTPException(404, "Job not found")
    if not result["ok"]:
        raise HTTPException(409, result["reason"])
    return result


class ForTypeBody(BaseModel):
    q_type: QType
    count: int = Field(default=5, ge=1, le=50)
    # True: queue for the durable worker now. False: record a 'planned' preview.
    activate: bool = True


@router.post("/for-type")
def generate_for_type(body: ForTypeBody, session: Session = Depends(get_session)):
    """Close the loop: backfill a (usually weak) q_type with Tier-B generation.

    Anchors on the real questions of that type and refuses if there are none —
    we never model AI on AI (docs/00-vision.md). This is what the coach's
    "drill X" recommendation calls when the real bank is too thin.
    """
    parents = generation._eligible_parents(session, body.q_type)
    if not parents:
        return {"enqueued": False,
                "reason": "no real anchor questions for this type"}
    status = GenStatus.queued if body.activate else GenStatus.planned
    jid = jobs.enqueue(session, body.q_type, body.count, status=status)
    return {
        "enqueued": True,
        "job_id": jid,
        "status": status.value,
        "anchors": len(parents),
        "servable_now": generation.servable_count(session, body.q_type),
    }


@router.get("/coverage")
def coverage(session: Session = Depends(get_session)):
    """Per q_type bank coverage so the UI/coach can spot thin types."""
    return generation.coverage(session)


@router.get("/quality")
def generation_quality(session: Session = Depends(get_session)):
    """Q2: pass rate + failure-reason histogram across generation jobs."""
    return generation.generation_quality(session)


class CalibrateBody(BaseModel):
    # Minimum non-blind-review attempts before a question is recalibrated. None
    # uses the configured default (LSATLAB_CALIBRATION_MIN_ATTEMPTS).
    min_attempts: int | None = Field(default=None, ge=1, le=10_000)


@router.post("/calibrate-difficulty")
def calibrate_difficulty(body: CalibrateBody | None = None,
                         session: Session = Depends(get_session)):
    """2.8 — recompute every question's ``empirical_difficulty`` from observed
    live accuracy (lower accuracy -> higher difficulty, 1-5). Leaves the
    model-asserted ``difficulty`` intact. AI items are included (empirical
    difficulty never feeds score prediction)."""
    min_attempts = body.min_attempts if body else None
    return audit.calibrate_difficulty(session, min_attempts=min_attempts)


@router.get("/quarantine")
def list_quarantine(session: Session = Depends(get_session)):
    qs = session.exec(
        select(Question)
        .where(Question.source == QuestionSource.ai_generated)
        .where(Question.quarantined == True)  # noqa: E712
    ).all()
    return [serializers.question_review_mode(session, q) for q in qs]


@router.get("/quarantine/{question_id}/triage")
def quarantine_triage(question_id: int, session: Session = Depends(get_session)):
    """Validation checks + a suggested verdict for a generated question."""
    q = session.get(Question, question_id)
    if not q:
        raise HTTPException(404, "Question not found")
    return {"question_id": question_id, **generation.triage_for_question(session, question_id)}


@router.post("/quarantine/{question_id}/approve")
def approve_quarantine(question_id: int, session: Session = Depends(get_session)):
    q = session.get(Question, question_id)
    if not q:
        raise HTTPException(404, "Question not found")
    q.quarantined = False
    q.approved = True
    session.add(q)
    session.commit()
    return {"ok": True}


@router.get("/drift")
def ai_drift(
    min_attempts: int = Query(default=4, ge=1, le=10_000),
    floor: float = Query(default=0.4, ge=0.0, le=1.0),
    session: Session = Depends(get_session),
):
    """Q5: approved AI items whose live accuracy has drifted below ``floor``."""
    return generation.ai_drift_report(
        session, min_attempts=min_attempts, floor=floor,
    )


@router.post("/quarantine/{question_id}/requarantine")
def requarantine(question_id: int, session: Session = Depends(get_session)):
    """Q5: send a drifting/approved AI item back to quarantine (only AI items)."""
    q = session.get(Question, question_id)
    if not q:
        raise HTTPException(404, "Question not found")
    if q.source != QuestionSource.ai_generated:
        raise HTTPException(400, "Only AI-generated items can be quarantined")
    q.quarantined = True
    q.approved = False
    session.add(q)
    session.commit()
    return {"ok": True}
