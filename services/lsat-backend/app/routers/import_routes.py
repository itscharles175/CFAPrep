"""PDF import wizard endpoints: parse (no commit) -> verify -> reconcile -> commit.

Parses are persisted in the ``ParseJob`` table (not an in-memory dict) so the
human-verify step and answer-key reconcile survive a restart.
"""
from __future__ import annotations

import hashlib
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm.attributes import flag_modified
from sqlmodel import Session, select

from .. import config, import_pdf
from ..db import get_session
from ..models import ImportRun, ImportRunStatus, ParseJob, utcnow

router = APIRouter(prefix="/import")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _count_parsed(parsed: dict) -> dict[str, int]:
    sections = parsed.get("sections", []) or []
    passages = sum(len(sec.get("passages", []) or []) for sec in sections)
    questions = sum(len(sec.get("questions", []) or []) for sec in sections)
    choices = sum(
        len(q.get("choices", []) or [])
        for sec in sections
        for q in (sec.get("questions", []) or [])
    )
    return {
        "sections": len(sections),
        "passages": passages,
        "questions": questions,
        "answer_choices": choices,
    }


def _serialize_import_run(run: ImportRun) -> dict[str, Any]:
    status = run.status.value if hasattr(run.status, "value") else str(run.status)
    return {
        "id": run.id,
        "source": run.source,
        "license": run.license,
        "file_hash": run.file_hash,
        "row_counts": run.row_counts_json,
        "warnings": run.warnings_json,
        "dedup": run.dedup_json,
        "status": status,
        "preptest_id": run.preptest_id,
        "error": run.error,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
    }


@router.post("/parse")
async def parse(file: UploadFile = File(...),
                session: Session = Depends(get_session)):
    # Bounded read: pull at most the cap + 1 byte so an oversized (or scanned)
    # PDF can't exhaust the local sidecar's memory before we reject it.
    limit = config.MAX_PDF_UPLOAD_BYTES
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(
            413,
            f"PDF exceeds the {limit // (1024 * 1024)} MB import limit.",
        )
    run = ImportRun(
        source=f"pdf:{file.filename or 'upload'}",
        license="user_provided_local_only",
        file_hash=_sha256(data),
        row_counts_json={"bytes": len(data)},
        status=ImportRunStatus.validating,
    )
    session.add(run)
    session.commit()
    session.refresh(run)
    try:
        parsed, warnings = import_pdf.parse_pdf(data)
    except Exception as exc:
        run.status = ImportRunStatus.failed
        run.error = str(exc)
        run.finished_at = utcnow()
        session.add(run)
        session.commit()
        raise HTTPException(400, f"Could not parse PDF: {exc}")
    run.row_counts_json = {
        **(run.row_counts_json or {}),
        **_count_parsed(parsed),
    }
    run.warnings_json = warnings
    session.add(run)
    job = ParseJob(
        filename=file.filename,
        parsed_json=parsed,
        warnings_json=warnings,
        import_run_id=run.id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    collision = import_pdf.find_collision(session, parsed.get("name"))
    return {"job_id": job.id, "import_run_id": run.id,
            "parsed": parsed, "warnings": warnings,
            "collision": collision}


@router.get("/jobs")
def list_parse_jobs(session: Session = Depends(get_session)):
    """Pending + past parses, so an interrupted verify can be resumed."""
    rows = session.exec(select(ParseJob).order_by(ParseJob.id.desc())).all()
    return [
        {
            "job_id": j.id,
            "filename": j.filename,
            "committed": j.committed,
            "preptest_id": j.preptest_id,
            "import_run_id": j.import_run_id,
            "warnings": j.warnings_json,
            "created_at": j.created_at.isoformat(),
        }
        for j in rows
    ]


@router.get("/jobs/{job_id}")
def get_parse_job(job_id: int, session: Session = Depends(get_session)):
    job = session.get(ParseJob, job_id)
    if not job:
        raise HTTPException(404, "Parse job not found")
    return {
        "job_id": job.id,
        "filename": job.filename,
        "parsed": job.parsed_json,
        "warnings": job.warnings_json,
        "committed": job.committed,
        "preptest_id": job.preptest_id,
        "import_run_id": job.import_run_id,
        "collision": import_pdf.find_collision(session, (job.parsed_json or {}).get("name")),
    }


def _load_parsed(session: Session, job_id: Optional[int],
                 parsed: Optional[dict]) -> tuple[Optional[ParseJob], dict]:
    job = session.get(ParseJob, job_id) if job_id else None
    resolved = parsed or (job.parsed_json if job else None)
    if not resolved:
        raise HTTPException(400, "No parsed structure provided.")
    return job, resolved


class ReconcileBody(BaseModel):
    job_id: Optional[int] = None
    parsed: Optional[dict[str, Any]] = None
    answer_key: list[str]
    apply: bool = False


@router.post("/reconcile")
def reconcile(body: ReconcileBody, session: Session = Depends(get_session)):
    """Validate parsed answers against an official key; flag (and optionally
    apply) mismatches before commit."""
    job, parsed = _load_parsed(session, body.job_id, body.parsed)
    result = import_pdf.reconcile_answer_key(parsed, body.answer_key, apply=body.apply)
    if job is not None and body.apply:
        job.parsed_json = result["parsed"]
        # reconcile mutates parsed in place; force the JSON column dirty so the
        # applied corrections actually persist.
        flag_modified(job, "parsed_json")
        session.add(job)
        session.commit()
    return result


class CommitBody(BaseModel):
    job_id: Optional[int] = None
    parsed: Optional[dict[str, Any]] = None
    source: str = "official"
    replace: bool = False    # F8: replace an existing same-name PrepTest
    force: bool = False      # D1: commit despite integrity issues (explicit opt-out)
    # Bank-expansion plan Wave 1.6 — flag the whole PrepTest as training-corpus
    # material. Per-question overrides ride in the ``parsed.sections[*]
    # .questions[*].training_eligible`` slot so a noisy OCR'd item can opt out
    # individually in the verification step.
    training_eligible: bool = False
    training_role: Optional[str] = None  # "anchor" | "distill" | "both"
    training_notes: Optional[str] = None


@router.post("/commit")
def commit(body: CommitBody, session: Session = Depends(get_session)):
    job, parsed = _load_parsed(session, body.job_id, body.parsed)
    # D1: a wrong/missing answer key on official content is catastrophic for
    # score accuracy. Refuse to commit until integrity issues are resolved
    # (reconcile against the official key) unless the caller explicitly forces.
    issues = import_pdf.commit_issues(parsed)
    if issues and not body.force:
        raise HTTPException(
            409,
            detail={"error": "unresolved_integrity_issues", "issues": issues},
        )
    run = session.get(ImportRun, job.import_run_id) if job and job.import_run_id else None
    if run is None:
        run = ImportRun(
            source=f"pdf:{job.filename if job else 'inline'}",
            license="user_provided_local_only",
            row_counts_json=_count_parsed(parsed),
            status=ImportRunStatus.committing,
        )
    else:
        run.status = ImportRunStatus.committing
        run.error = None
    session.add(run)
    session.commit()
    session.refresh(run)
    try:
        preptest_id = import_pdf.commit_structure(
            session,
            parsed,
            source=body.source,
            replace=body.replace,
            training_eligible=body.training_eligible,
            training_role=body.training_role,
            training_notes=body.training_notes,
        )
    except Exception as exc:
        run = session.get(ImportRun, run.id)
        if run is not None:
            run.status = ImportRunStatus.rolled_back
            run.error = str(exc)
            run.finished_at = utcnow()
            session.add(run)
            session.commit()
        raise
    run = session.get(ImportRun, run.id)
    if run is not None:
        run.status = ImportRunStatus.done
        run.preptest_id = preptest_id
        run.row_counts_json = _count_parsed(parsed)
        run.finished_at = utcnow()
        session.add(run)
        session.commit()
    if job is not None:
        job.committed = True
        job.preptest_id = preptest_id
        job.import_run_id = run.id if run is not None else job.import_run_id
        if body.parsed:  # persist any human edits made before commit
            job.parsed_json = body.parsed
        session.add(job)
        session.commit()
    return {"preptest_id": preptest_id, "import_run_id": run.id if run else None}


@router.get("/runs")
def list_import_runs(limit: int = 50, session: Session = Depends(get_session)):
    rows = session.exec(
        select(ImportRun).order_by(ImportRun.id.desc()).limit(max(1, min(limit, 500)))
    ).all()
    return {"runs": [_serialize_import_run(row) for row in rows]}


@router.get("/runs/{run_id}")
def get_import_run(run_id: int, session: Session = Depends(get_session)):
    run = session.get(ImportRun, run_id)
    if run is None:
        raise HTTPException(404, "Import run not found")
    return _serialize_import_run(run)
