"""Bank growth: dataset import, auto-tagging, bootstrap orchestration, stats.

All endpoints under ``/api/bank/*``. They mirror the CLI tools so the same
behavior is reachable from the UI and from scripts.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlmodel import Session, func, select

from .. import (
    audit,
    bank_bootstrap,
    bank_export,
    embeddings,
    import_dataset,
    jobs,
    serializers,
    tagging,
)
from ..db import get_session
from ..models import ImportRun, ImportRunStatus, Question, QuestionSource, utcnow
from ..pagination import LimitQuery, OffsetQuery, paginate
from ..schemas import BankStats, DatasetSource

router = APIRouter(prefix="/bank")


def _hash_path(path: str | None) -> str | None:
    if not path:
        return None
    p = Path(path)
    if not p.exists() or not p.is_file():
        return None
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _hash_json(payload: dict) -> str:
    body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(body).hexdigest()


def _finish_import_run(
    session: Session,
    run: ImportRun,
    *,
    status: ImportRunStatus,
    error: str | None = None,
) -> None:
    run.status = status
    run.error = error
    run.finished_at = utcnow()
    session.add(run)
    session.commit()


# --- read endpoints --------------------------------------------------------
@router.get("/questions")
def list_questions(
    session: Session = Depends(get_session),
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    cursor: Optional[int] = Query(None, ge=0),
    q_type: Optional[str] = None,
    q: Optional[str] = None,
    source: Optional[str] = None,
    training_eligible: Optional[bool] = None,
):
    """Wave 4.2 — paginated slim rows for bank browse (not full export)."""
    stmt = select(Question).where(Question.deleted_at.is_(None))
    if q_type:
        stmt = stmt.where(Question.q_type == q_type)
    if source:
        try:
            stmt = stmt.where(Question.source == QuestionSource(source))
        except ValueError:
            pass
    if training_eligible is True:
        stmt = stmt.where(Question.training_eligible == True)  # noqa: E712
    if q:
        stmt = stmt.where(
            (Question.stem.contains(q)) | (Question.prompt.contains(q))
        )
    # swarm #49: count in the DB instead of materializing every matching row.
    total = session.exec(
        select(func.count()).select_from(stmt.subquery())
    ).one()
    page_stmt = stmt.order_by(Question.id)
    if cursor is not None:
        page_stmt = page_stmt.where(Question.id > cursor)
    else:
        page_stmt = page_stmt.offset(offset)
    rows = session.exec(page_stmt.limit(limit)).all()
    items = [
        {
            "id": row.id,
            "q_type": row.q_type,
            "difficulty": row.difficulty,
            "source": row.source.value if hasattr(row.source, "value") else str(row.source),
            "stem_preview": (row.stem or "")[:120],
            "prompt_preview": (row.prompt or "")[:80],
            "created_at": row.created_at.isoformat() if row.created_at else None,
            "quarantined": bool(row.quarantined),
            "approved": bool(row.approved),
            "training_eligible": bool(row.training_eligible),
            "training_notes": row.training_notes,
        }
        for row in rows
    ]
    next_cursor = rows[-1].id if len(rows) == limit and rows[-1].id is not None else None
    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "cursor": cursor,
        "next_cursor": next_cursor,
        "has_more": next_cursor is not None,
        "items": items,
    }


@router.get("/stats", response_model=BankStats)
def stats(session: Session = Depends(get_session)):
    """Counts by source and q_type; the Bank UI uses this for the headline."""
    s = bank_bootstrap.bank_stats(session)
    return {
        "total": s.total,
        "by_source": s.by_source,
        "by_q_type": s.by_q_type,
        "available_sources": list(import_dataset.DATASETS.keys()),
    }


@router.get("/sources", response_model=list[DatasetSource])
def sources(
    limit: int | None = LimitQuery,
    offset: int | None = OffsetQuery,
):
    """Registry of supported research datasets (key, HF id, expected section).

    BC2: optional limit/offset slice the (small, fixed) registry in Python; omit
    both for the full registry exactly as before.
    """
    rows = [
        {
            "key": spec.key,
            "hf_dataset": spec.hf_dataset,
            "hf_split": spec.hf_split,
            "section_type": spec.section_type,
            "preptest_name": spec.preptest_name,
            "license": spec.license,
            "expected_fields": list(spec.expected_fields),
            "question_source": spec.question_source.value,
            "requires_local_path": spec.requires_local_path,
            "requires_nc_acknowledgement": spec.requires_nc_acknowledgement,
        }
        for spec in import_dataset.DATASETS.values()
    ]
    return paginate(rows, limit=limit, offset=offset)


# --- import ---------------------------------------------------------------
class ImportBody(BaseModel):
    sources: Optional[list[str]] = None
    limit: Optional[int] = None
    # ReClor requires this be True before the importer touches the local zip;
    # the Bank UI surfaces a one-time non-commercial acknowledgement checkbox.
    nc_acknowledged: bool = False
    # Per-source local file paths. Currently only ``reclor`` (a zip downloaded
    # by the user) consumes this. Keys are dataset keys, values are absolute
    # paths on the user's machine; the path never leaves the device.
    local_paths: Optional[dict[str, str]] = None
    # Bank-expansion plan Wave 1.6 — mark the imported rows as training-corpus
    # material. Defaults to False so research datasets aren't auto-promoted.
    training_eligible: bool = False
    training_role: Optional[str] = None  # "anchor" | "distill" | "both"
    training_notes: Optional[str] = None


@router.post("/import")
def import_research(body: ImportBody, session: Session = Depends(get_session)):
    """Pull rows from the given dataset keys (or all) and commit them.

    Synchronous: each dataset is small (510-4,500 rows) and the importer
    streams pages so memory stays flat. Caller gets per-source results.
    """
    keys = body.sources or list(import_dataset.DATASETS.keys())
    unknown = [k for k in keys if k not in import_dataset.DATASETS]
    if unknown:
        raise HTTPException(400, f"Unknown dataset keys: {unknown}")
    local_paths = body.local_paths or {}
    out = []
    for key in keys:
        spec = import_dataset.DATASETS[key]
        run = ImportRun(
            source=key,
            license=spec.license,
            file_hash=_hash_path(local_paths.get(key)),
            status=ImportRunStatus.validating,
            warnings_json=[],
        )
        session.add(run)
        session.commit()
        session.refresh(run)
        if spec.requires_local_path and not local_paths.get(key):
            _finish_import_run(
                session,
                run,
                status=ImportRunStatus.failed,
                error=f"'{key}' requires a local file path (no auto-fetch).",
            )
            out.append({
                "dataset": key,
                "import_run_id": run.id,
                "error": f"'{key}' requires a local file path (no auto-fetch).",
            })
            continue
        if spec.requires_nc_acknowledgement and not body.nc_acknowledged:
            _finish_import_run(
                session,
                run,
                status=ImportRunStatus.failed,
                error=f"'{key}' requires nc_acknowledged=true (non-commercial).",
            )
            out.append({
                "dataset": key,
                "import_run_id": run.id,
                "error": f"'{key}' requires nc_acknowledged=true (non-commercial).",
            })
            continue
        run.status = ImportRunStatus.committing
        session.add(run)
        session.commit()
        try:
            res = import_dataset.import_dataset(
                session,
                key,
                limit=body.limit,
                local_path=local_paths.get(key),
                nc_acknowledged=body.nc_acknowledged,
                training_eligible=body.training_eligible,
                training_role=body.training_role,
                training_notes=body.training_notes,
            )
        except Exception as exc:  # network errors etc.
            _finish_import_run(
                session,
                run,
                status=ImportRunStatus.rolled_back,
                error=str(exc),
            )
            out.append({"dataset": key, "import_run_id": run.id, "error": str(exc)})
            continue
        run.row_counts_json = {
            "rows_seen": res.rows_seen,
            "inserted": res.inserted,
        }
        run.dedup_json = {"skipped_duplicate": res.skipped_duplicate}
        run.warnings_json = res.warnings
        run.preptest_id = res.preptest_id
        _finish_import_run(session, run, status=ImportRunStatus.done)
        out.append({
            "dataset": res.dataset,
            "import_run_id": run.id,
            "preptest_id": res.preptest_id,
            "inserted": res.inserted,
            "skipped_duplicate": res.skipped_duplicate,
            "rows_seen": res.rows_seen,
        })
    return {"results": out}


# --- tagging --------------------------------------------------------------
class TagBody(BaseModel):
    limit: int = 200
    only_research: bool = True


@router.post("/tag")
def tag_pass(body: TagBody, session: Session = Depends(get_session)):
    """Run a Tier-A tagging batch. Returns counts; safe to call repeatedly."""
    res = tagging.batch_tag(
        session,
        limit=max(1, min(body.limit, 5000)),
        only_research=body.only_research,
    )
    return {
        "scanned": res.scanned,
        "updated": res.updated,
        "via_heuristic": res.via_heuristic,
        "via_model": res.via_model,
        "via_fallback": res.via_fallback,
    }


@router.get("/tag-review")
def tag_review(limit: int = 50, session: Session = Depends(get_session)):
    """Questions whose auto-tags need a human look (low-confidence / placeholder)."""
    qs = tagging.low_confidence_questions(session, limit=max(1, min(limit, 500)))
    return [serializers.question_review_mode(session, q) for q in qs]


class BulkTagBody(BaseModel):
    question_ids: list[int] = Field(min_length=1, max_length=5000)
    q_type: Optional[str] = Field(default=None, max_length=80)
    difficulty: Optional[int] = Field(default=None, ge=1, le=5)


@router.post("/bulk-tag")
def bulk_tag(body: BulkTagBody, session: Session = Depends(get_session)):
    """F2: set q_type/difficulty on many questions at once (human-confirmed tags).

    5.4: every q_type/difficulty change is recorded in the AuditLog (and bumps
    Question.updated_at) so manual tag edits have a reviewable history."""
    if not body.q_type and body.difficulty is None:
        raise HTTPException(400, "Provide q_type and/or difficulty to apply")

    updated = 0
    missing = 0
    unchanged = 0
    for qid in dict.fromkeys(body.question_ids):
        q = session.get(Question, qid)
        if q is None:
            missing += 1
            continue
        changed = False
        if body.q_type and body.q_type != q.q_type:
            audit.record_edit(session, entity="question", entity_id=q.id,
                              field="q_type", old_value=q.q_type,
                              new_value=body.q_type)
            q.q_type = body.q_type
            changed = True
        if body.difficulty is not None:
            new_diff = max(1, min(5, body.difficulty))
            if new_diff != q.difficulty:
                audit.record_edit(session, entity="question", entity_id=q.id,
                                  field="difficulty", old_value=q.difficulty,
                                  new_value=new_diff)
                q.difficulty = new_diff
                changed = True
        if changed:
            q.tag_confidence = "high"   # set by a human
            session.add(q)
            updated += 1
        else:
            unchanged += 1
    session.commit()
    return {
        "updated": updated,
        "requested": len(body.question_ids),
        "missing": missing,
        "unchanged": unchanged,
    }


# --- bootstrap (plan-only by default) -------------------------------------
class BootstrapBody(BaseModel):
    target_total: int = 5000
    per_type_cap: int = 50
    tag_limit: int = 500
    # Run actual generation jobs? Default false so the UI can preview the plan
    # without burning GPU time.
    run_generation: bool = False
    no_import: bool = False


@router.post("/bootstrap")
def bootstrap(body: BootstrapBody, session: Session = Depends(get_session)):
    """End-to-end pipeline. Returns the plan; generation runs on the durable worker.

    Jobs are always recorded as a ``planned`` preview first. When
    ``run_generation`` is set we activate them (planned -> queued) so the
    background worker drains them; the request itself never blocks on the model.
    """
    result = bank_bootstrap.bootstrap(
        session,
        target_total=body.target_total,
        tag_limit=body.tag_limit,
        per_type_cap=body.per_type_cap,
        run_generation=False,  # never run inline inside a request
        import_sources=[] if body.no_import else None,
    )
    dispatched = False
    if body.run_generation and result.job_ids:
        dispatched = jobs.activate_jobs(session, result.job_ids) > 0
    return {
        "starting_total": result.starting_total,
        "final_total_after_import_and_tag": result.final_total,
        "inserted_research": result.inserted_research,
        "tagged": result.tagged,
        "job_ids": result.job_ids,
        "generation_dispatched": dispatched,
    }


# --- export / import (backup) ---------------------------------------------
@router.get("/export")
def export_bank(include_history: bool = True,
                session: Session = Depends(get_session)):
    """Portable question-bank snapshot for backup/sharing.

    Copyrighted ``official`` PrepTest content is always excluded (provenance
    firewall) — there is deliberately no parameter to include it over the wire.
    To preserve official content on this machine, use the local SQLite backup.
    """
    return bank_export.export_bank(
        session, include_history=include_history, include_official=False
    )


class ImportBackupBody(BaseModel):
    payload: dict


@router.post("/import-backup")
def import_backup(body: ImportBackupBody,
                  session: Session = Depends(get_session)):
    """Apply a previously-exported bank snapshot. Idempotent on PrepTest name +
    Question external_id/content_hash (and natural keys for the 5.5 user-data
    tables). Returns insertion counts plus a post-import verify-restore report."""
    run = ImportRun(
        source="portable_json_export",
        license="sanitized_local_export",
        file_hash=_hash_json(body.payload),
        status=ImportRunStatus.committing,
    )
    session.add(run)
    session.commit()
    session.refresh(run)
    try:
        counts = bank_export.import_bank(session, body.payload)
    except ValueError as exc:
        # Schema-version / shape rejection: caller error -> 400, run rolled back.
        _finish_import_run(
            session,
            run,
            status=ImportRunStatus.rolled_back,
            error=str(exc),
        )
        raise HTTPException(400, str(exc))
    except Exception as exc:  # noqa: BLE001
        # B4a (Codex #3): a malformed LATER record (or any unexpected failure)
        # now rolls back the WHOLE import atomically inside import_bank (it leaves
        # the session clean before re-raising). Mark the run failed with the error
        # instead of leaving it stuck in 'committing'.
        _finish_import_run(
            session,
            run,
            status=ImportRunStatus.failed,
            error=str(exc),
        )
        raise HTTPException(500, str(exc))
    # 5.5: additive — existing count keys are preserved; ``verify`` is new.
    counts["verify"] = bank_export.verify_restore(session, body.payload)
    run.row_counts_json = {
        key: value for key, value in counts.items()
        if isinstance(value, int | float | str | bool) or value is None
    }
    _finish_import_run(session, run, status=ImportRunStatus.done)
    counts["import_run_id"] = run.id
    return counts


# --- embeddings / semantic search -----------------------------------------
class EmbedBody(BaseModel):
    limit: int = 200


@router.post("/embed")
def embed_bank(body: EmbedBody, session: Session = Depends(get_session)):
    """Backfill question embeddings (local embed model) for semantic search + RAG.

    Idempotent: only embeds questions that don't have an embedding yet.
    """
    return embeddings.backfill_question_embeddings(
        session, limit=max(1, min(body.limit, 5000)),
    )


@router.get("/similar/{question_id}")
def similar_questions(question_id: int, k: int = 5,
                      session: Session = Depends(get_session)):
    """Semantically nearest questions to ``question_id`` (drill / 'similar miss')."""
    return embeddings.similar_questions(session, question_id, k=max(1, min(k, 25)))


# --- quality audit ---------------------------------------------------------
@router.get("/audit")
def quality_audit(session: Session = Depends(get_session)):
    """Bank quality issues: missing tags, placeholders, length tells, dups coverage."""
    return audit.quality_report(session)


@router.get("/audit-log")
def audit_log(entity: Optional[str] = None, entity_id: Optional[int] = None,
              limit: int = 100, session: Session = Depends(get_session)):
    """5.4 — recent content edits (tag/difficulty/approval/quarantine/explanation),
    newest first. Filter by ``entity`` (question|explanation) and/or ``entity_id``
    to see one item's edit history."""
    return {"edits": audit.recent_edits(
        session, entity=entity, entity_id=entity_id, limit=limit,
    )}


@router.get("/duplicates")
def duplicates(threshold: float = 0.95, session: Session = Depends(get_session)):
    """Near-duplicate clusters (embedding cosine >= threshold). Run /bank/embed first."""
    return audit.duplicate_clusters(session, threshold=max(0.5, min(threshold, 1.0)))
