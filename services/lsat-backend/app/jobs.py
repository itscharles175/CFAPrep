"""Durable background job queue for Tier-B generation.

Why this exists
---------------
Generation jobs used to run via FastAPI ``BackgroundTasks`` — fine until the
process died mid-run: the ``GenJob`` row was stranded in ``running`` forever and
any not-yet-started job was simply lost (BackgroundTasks don't survive a restart).
For a desktop app that runs long offline batches, that's data loss.

Design
------
- Jobs are durable because they live in SQLite. The queue *is* the ``GenJob``
  table; ``queued`` rows are work to do.
- A single in-process worker thread drains ``queued`` jobs **one at a time** —
  the local GPU saturates under parallelism, so sequential is correct (and
  matches the existing bank-bootstrap comment).
- On startup ``reconcile_orphans`` marks any ``running`` job ``failed`` (it was
  interrupted) rather than silently leaving it stuck. We do NOT auto-resume,
  because ``run_job`` is not idempotent (it creates new questions); the user can
  re-queue from the UI if they want.
- ``planned`` jobs (a previewed bootstrap plan) are ignored by the worker until
  ``activate_jobs`` promotes them to ``queued``.

No Celery/Redis: that's overkill for a single-user local app and would violate
the offline-first design.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlmodel import Session, select

from . import config, generation
from .db import engine
from .models import BenchmarkRun, GenJob, GenStatus, ScheduledTask, SchedulerRun

log = logging.getLogger("lsatlab.jobs")

DEFAULT_SCHEDULES: tuple[dict[str, object], ...] = (
    {
        "key": "daily_backup",
        "label": "Daily local database backup",
        "task_type": "backup",
        "cadence_s": 24 * 60 * 60,
    },
    {
        "key": "daily_calibration",
        "label": "Daily item calibration refresh",
        "task_type": "calibration",
        "cadence_s": 24 * 60 * 60,
    },
    {
        "key": "embedding_backfill",
        "label": "Embedding coverage backfill",
        "task_type": "embedding",
        "cadence_s": 6 * 60 * 60,
    },
    {
        "key": "content_health_audit",
        "label": "Content health audit",
        "task_type": "content_audit",
        "cadence_s": 12 * 60 * 60,
    },
    {
        "key": "content_revalidation",
        "label": "Approved AI content revalidation",
        "task_type": "content_revalidation",
        "cadence_s": 24 * 60 * 60,
        "payload": {"limit": 25, "model_gate": False, "apply_quarantine": False},
    },
    {
        "key": "generation_gate_eval",
        "label": "Generation gate eval sweep",
        "task_type": "eval",
        "cadence_s": 7 * 24 * 60 * 60,
    },
)

DEFAULT_SCHEDULE_KEYS = tuple(str(item["key"]) for item in DEFAULT_SCHEDULES)
SUPPORTED_SCHEDULED_TASK_TYPES = frozenset(
    {
        "backup",
        "calibration",
        "embedding",
        "content_audit",
        "content_revalidation",
        "eval",
    }
)


def _generation_quality_probe_candidate() -> dict:
    choices = [
        ("A", "Choice A gives a balanced plausible response to the argument today.", "opposite"),
        ("B", "Choice B gives a balanced plausible response to the argument today.", "none"),
        ("C", "Choice C gives a balanced plausible response to the argument today.", "reversal"),
        ("D", "Choice D gives a balanced plausible response to the argument today.", "out_of_scope"),
        ("E", "Choice E gives a balanced plausible response to the argument today.", "degree"),
    ]
    return {
        "stem": (
            "A city claims its new bus pilot caused ridership to rise because "
            "surveyed residents reported more transit use during the trial period."
        ),
        "prompt": "Which one of the following most weakens the argument?",
        "correct_answer": "B",
        "choices": [
            {"label": label, "text": text, "trap_type": trap}
            for label, text, trap in choices
        ],
    }


def _generation_quality_probe(session: Session) -> dict:
    """Deterministically prove the generation gate still rejects known regressions."""

    def solver(_prompt: str) -> str:
        return "The answer is B."

    def multi_model_solver(_model: str, _prompt: str) -> str:
        return "B"

    def critic(prompt: str) -> str:
        if "distractor-quality reviewer" in prompt:
            return json.dumps({
                "distractors_plausible": True,
                "plausible_labels": ["A", "C", "D", "E"],
                "weak_distractors": [],
            })
        if "strict LSAT item reviewer" in prompt:
            return json.dumps({"single_defensible": True, "defensible_letters": ["B"]})
        if "testing a candidate LSAT 'Weaken' answer" in prompt:
            return json.dumps({"weakens": True})
        return "The answer is B."

    def weak_distractor_critic(prompt: str) -> str:
        if "distractor-quality reviewer" in prompt:
            return json.dumps({
                "distractors_plausible": False,
                "plausible_labels": ["C", "D", "E"],
                "weak_distractors": [
                    {"label": "A", "reason": "throwaway not tied to the stimulus"}
                ],
            })
        return critic(prompt)

    def boom(_prompt: str) -> str:
        raise AssertionError("deterministic generation-quality probe short-circuited")

    def run_case(
        name: str,
        cand: dict,
        *,
        expected_passed: bool,
        expected_reason: str | None = None,
        case_solver=solver,
        case_critic=critic,
    ) -> dict:
        report = generation.validate_candidate(
            cand,
            runs=3,
            solver=case_solver,
            critic=case_critic,
            q_type="Weaken",
            permutation_invariant=False,
            informativity=False,
            distractor_quality_enabled=True,
            multi_model_solver=multi_model_solver,
        )
        actual_passed = bool(report.get("passed"))
        actual_reason = report.get("reason")
        ok = actual_passed == expected_passed and (
            expected_reason is None or actual_reason == expected_reason
        )
        return {
            "name": name,
            "ok": ok,
            "expected_passed": expected_passed,
            "actual_passed": actual_passed,
            "expected_reason": expected_reason,
            "actual_reason": actual_reason,
            "checked": sorted((report.get("checks") or {}).keys()),
        }

    clean = _generation_quality_probe_candidate()
    missing_trap = _generation_quality_probe_candidate()
    missing_trap["choices"][0].pop("trap_type")
    weak_distractor = _generation_quality_probe_candidate()

    cases = [
        run_case("clean_candidate_passes", clean, expected_passed=True),
        run_case(
            "missing_trap_metadata_rejected",
            missing_trap,
            expected_passed=False,
            expected_reason="trap_metadata",
            case_solver=boom,
            case_critic=boom,
        ),
        run_case(
            "weak_distractor_rejected",
            weak_distractor,
            expected_passed=False,
            expected_reason="weak_distractors",
            case_critic=weak_distractor_critic,
        ),
    ]
    failures = [case for case in cases if not case["ok"]]
    aggregate = generation.generation_quality(session)
    return {
        "ok": not failures,
        "cases": cases,
        "failures": failures,
        "aggregate": {
            "jobs": aggregate.get("jobs"),
            "total_candidates": aggregate.get("total_candidates"),
            "pass_rate": aggregate.get("pass_rate"),
            "fail_reasons": aggregate.get("fail_reasons"),
            "cloud_recommended_types": aggregate.get("cloud_recommended_types"),
        },
    }


def _generation_quality_metrics(quality: dict) -> dict[str, float]:
    def case_ok(name: str) -> float:
        return 1.0 if any(
            case["name"] == name and case["ok"] for case in quality["cases"]
        ) else 0.0

    return {
        "generation_quality_cases": float(len(quality["cases"])),
        "generation_quality_passed_cases": float(
            sum(1 for case in quality["cases"] if case["ok"])
        ),
        "generation_quality_failed_cases": float(len(quality["failures"])),
        "generation_quality_clean_pass": case_ok("clean_candidate_passes"),
        "generation_quality_trap_metadata_rejected": case_ok(
            "missing_trap_metadata_rejected"
        ),
        "generation_quality_weak_distractor_rejected": case_ok(
            "weak_distractor_rejected"
        ),
    }


# --- queue helpers ----------------------------------------------------------
def enqueue(session: Session, q_type: str, count: int,
            parent_question_id: Optional[int] = None,
            status: GenStatus = GenStatus.queued,
            priority: int = 0,
            max_retries: int = 0,
            passage_first: bool = False) -> int:
    """Insert a generation job and return its id.

    audit M8 — ``passage_first`` is set at INSERT time (atomically with the
    queued status) rather than flipped in a second commit by the caller. The
    worker selects any queued job, so a poll landing between two commits could
    pick a passage-first job while the flag was still False and run the legacy
    per-question pipeline instead of one shared RC passage."""
    job = GenJob(q_type=q_type, count=count, status=status,
                 parent_question_id=parent_question_id,
                 priority=priority,
                 max_retries=max_retries,
                 passage_first=passage_first,
                 progress_pct=0.0,
                 updated_at=datetime.now(timezone.utc))
    session.add(job)
    session.commit()
    session.refresh(job)
    return job.id


def activate_jobs(session: Session, job_ids: list[int]) -> int:
    """Promote ``planned`` jobs to ``queued`` so the worker will run them."""
    activated = 0
    for jid in job_ids:
        job = session.get(GenJob, jid)
        if job is not None and job.status == GenStatus.planned:
            job.status = GenStatus.queued
            session.add(job)
            activated += 1
    if activated:
        session.commit()
    return activated


def cancel_job(session: Session, job_id: int) -> dict:
    """Cancel a planned/queued job, or mark a running job as cancel requested."""
    job = session.get(GenJob, job_id)
    if job is None:
        return {"ok": False, "reason": "job_not_found"}
    if job.status in {GenStatus.done, GenStatus.failed, GenStatus.cancelled}:
        return {"ok": False, "reason": f"job_already_{job.status.value}"}
    now = datetime.now(timezone.utc)
    report = dict(job.validation_report or {})
    if job.status == GenStatus.running:
        report["cancel_requested"] = True
        job.validation_report = report
        job.updated_at = now
        session.add(job)
        session.commit()
        return {"ok": True, "status": job.status.value, "cancel_requested": True}
    job.status = GenStatus.cancelled
    job.cancelled_at = now
    job.updated_at = now
    job.progress_pct = 0.0
    report["cancelled"] = True
    job.validation_report = report
    session.add(job)
    session.commit()
    return {"ok": True, "status": job.status.value, "cancel_requested": False}


def set_priority(session: Session, job_id: int, priority: int) -> dict:
    """Update queue priority for a planned/queued job."""
    job = session.get(GenJob, job_id)
    if job is None:
        return {"ok": False, "reason": "job_not_found"}
    if job.status not in {GenStatus.planned, GenStatus.queued}:
        return {"ok": False, "reason": f"job_not_reorderable:{job.status.value}"}
    job.priority = max(-100, min(100, int(priority)))
    job.updated_at = datetime.now(timezone.utc)
    session.add(job)
    session.commit()
    return {"ok": True, "job_id": job.id, "priority": job.priority}


def retry_failed_job(session: Session, job_id: int, *, reason: str | None = None) -> dict:
    """Requeue a failed job when doing so cannot duplicate generated content."""
    job = session.get(GenJob, job_id)
    if job is None:
        return {"ok": False, "reason": "job_not_found"}
    if job.status != GenStatus.failed:
        return {"ok": False, "reason": f"job_not_failed:{job.status.value}"}
    if int(job.produced or 0) > 0:
        report = dict(job.validation_report or {})
        report["retry_blocked"] = "partial_outputs_present"
        job.validation_report = report
        job.updated_at = datetime.now(timezone.utc)
        session.add(job)
        session.commit()
        return {"ok": False, "reason": "partial_outputs_present"}
    if int(job.retry_count or 0) >= int(job.max_retries or 0):
        report = dict(job.validation_report or {})
        report["retry_exhausted"] = True
        job.validation_report = report
        job.updated_at = datetime.now(timezone.utc)
        session.add(job)
        session.commit()
        return {"ok": False, "reason": "retry_exhausted"}

    now = datetime.now(timezone.utc)
    report = dict(job.validation_report or {})
    history = report.get("retry_history")
    if not isinstance(history, list):
        history = []
    history.append({
        "at": now.isoformat(),
        "reason": (reason or report.get("error") or "failed_before_output"),
        "retry_count": int(job.retry_count or 0) + 1,
    })
    report["retry_history"] = history[-10:]
    report["retry_pending"] = True
    report.pop("retry_exhausted", None)
    report.pop("retry_blocked", None)

    job.retry_count = int(job.retry_count or 0) + 1
    job.status = GenStatus.queued
    job.progress_pct = 0.0
    job.produced = 0
    job.accepted = 0
    job.quarantined = 0
    job.updated_at = now
    job.validation_report = report
    session.add(job)
    session.commit()
    return {
        "ok": True,
        "job_id": job.id,
        "status": job.status.value,
        "retry_count": job.retry_count,
        "max_retries": job.max_retries,
    }


def mark_job_failed(session: Session, job_id: int, reason: str) -> dict:
    """Persist a worker-level failure for runners that fail before updating state."""
    job = session.get(GenJob, job_id)
    if job is None:
        return {"ok": False, "reason": "job_not_found"}
    if job.status in {GenStatus.done, GenStatus.failed, GenStatus.cancelled}:
        return {"ok": True, "status": job.status.value}
    report = dict(job.validation_report or {})
    report["worker_error"] = reason
    job.status = GenStatus.failed
    job.updated_at = datetime.now(timezone.utc)
    job.validation_report = report
    session.add(job)
    session.commit()
    return {"ok": True, "status": job.status.value}


def progress_payload(job: GenJob) -> dict:
    """Stable progress shape for scheduler UI and release-trust evidence."""
    count = max(0, int(job.count or 0))
    completed = max(0, int((job.accepted or 0) + (job.quarantined or 0)))
    inferred_pct = round(100 * completed / count, 1) if count else 0.0
    pct = max(float(job.progress_pct or 0.0), inferred_pct)
    if job.status == GenStatus.done:
        pct = 100.0
    if job.status in {GenStatus.failed, GenStatus.cancelled}:
        pct = min(pct, 100.0)
    return {
        "id": job.id,
        "status": job.status.value,
        "q_type": job.q_type,
        "priority": job.priority,
        "count": job.count,
        "produced": job.produced,
        "accepted": job.accepted,
        "quarantined": job.quarantined,
        "progress_pct": round(pct, 1),
        "retry_count": job.retry_count,
        "max_retries": job.max_retries,
        "cancel_requested": bool((job.validation_report or {}).get("cancel_requested")),
        "retry_pending": bool((job.validation_report or {}).get("retry_pending")),
        "retry_exhausted": bool((job.validation_report or {}).get("retry_exhausted")),
        "created_at": job.created_at.isoformat(),
        "updated_at": job.updated_at.isoformat() if job.updated_at else None,
        "cancelled_at": job.cancelled_at.isoformat() if job.cancelled_at else None,
    }


def queue_summary(session: Session) -> dict:
    rows = session.exec(select(GenJob)).all()
    by_status: dict[str, int] = {}
    for job in rows:
        by_status[job.status.value] = by_status.get(job.status.value, 0) + 1
    return {
        "total": len(rows),
        "by_status": by_status,
        "queued": by_status.get(GenStatus.queued.value, 0),
        "running": by_status.get(GenStatus.running.value, 0),
        "cancelled": by_status.get(GenStatus.cancelled.value, 0),
    }


def upsert_scheduled_task(
    session: Session,
    *,
    key: str,
    label: str,
    task_type: str,
    cadence_s: int,
    enabled: bool = True,
    payload: dict | None = None,
) -> ScheduledTask:
    """Register a local recurring task without running it."""
    if task_type not in SUPPORTED_SCHEDULED_TASK_TYPES:
        allowed = ", ".join(sorted(SUPPORTED_SCHEDULED_TASK_TYPES))
        raise ValueError(f"unsupported scheduled task type: {task_type!r}; expected one of {allowed}")
    row = session.exec(select(ScheduledTask).where(ScheduledTask.key == key)).first()
    now = datetime.now(timezone.utc)
    if row is None:
        row = ScheduledTask(key=key)
    row.label = label
    row.task_type = task_type
    row.cadence_s = max(60, int(cadence_s))
    row.enabled = bool(enabled)
    row.payload_json = payload or row.payload_json or {}
    row.next_run_at = row.next_run_at or (now + timedelta(seconds=row.cadence_s))
    row.updated_at = now
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def ensure_default_schedules(session: Session) -> dict:
    """Seed the local maintenance scheduler registry.

    This does not execute work. It gives the Tutor OS a durable, user-visible
    schedule map for backups, calibration, embeddings, evals, and content audits.
    The existing idle hooks still perform today's lightweight maintenance.
    """
    created_or_updated = []
    for item in DEFAULT_SCHEDULES:
        row = upsert_scheduled_task(session, **item)
        created_or_updated.append(row.key)
    return {"scheduled_tasks": len(created_or_updated), "keys": created_or_updated}


def due_scheduled_tasks(session: Session, *, now: datetime | None = None) -> list[ScheduledTask]:
    now = now or datetime.now(timezone.utc)
    return session.exec(
        select(ScheduledTask)
        .where(ScheduledTask.enabled == True)  # noqa: E712
        .where(ScheduledTask.next_run_at <= now)
        .order_by(ScheduledTask.next_run_at, ScheduledTask.id)
    ).all()


def run_scheduled_task(session: Session, key: str) -> dict:
    """Run one registered local maintenance task and append evidence."""
    row = session.exec(select(ScheduledTask).where(ScheduledTask.key == key)).first()
    if row is None:
        return {"ok": False, "reason": "task_not_found"}
    started = time.monotonic()
    status = "ok"
    error = None
    result: dict = {}
    try:
        result = _execute_task(session, row)
    except Exception as exc:  # noqa: BLE001
        status = "failed"
        error = str(exc)
        result = {"error": error}
        log.exception("scheduled task failed key=%s", key)
    duration_ms = round((time.monotonic() - started) * 1000, 1)
    now = datetime.now(timezone.utc)
    run = SchedulerRun(
        task_key=row.key,
        task_type=row.task_type,
        status=status,
        duration_ms=duration_ms,
        result_json=result,
        error=error,
        created_at=now,
    )
    row.status = "idle" if status == "ok" else "failed"
    row.last_run_at = now
    row.next_run_at = now + timedelta(seconds=max(60, row.cadence_s))
    row.updated_at = now
    session.add(run)
    session.add(row)
    session.commit()
    session.refresh(run)
    session.refresh(row)
    return {
        "ok": status == "ok",
        "run_id": run.id,
        "task": scheduled_task_payload(row),
        "duration_ms": duration_ms,
        "result": result,
        "error": error,
    }


def run_due_scheduled_tasks(session: Session, *, limit: int = 10) -> dict:
    rows = due_scheduled_tasks(session)[: max(1, limit)]
    return {
        "ran": len(rows),
        "results": [run_scheduled_task(session, row.key) for row in rows],
    }


def run_generation_gate_eval(session: Session, *, notes: str | None = None) -> dict:
    """Record deterministic generation-gate eval evidence for release trust."""
    start = time.monotonic()
    quality = _generation_quality_probe(session)
    metrics = _generation_quality_metrics(quality)
    metrics["generation_gate_eval_ms"] = round((time.monotonic() - start) * 1000, 1)
    status = "ok" if quality["ok"] else "failed"
    run = BenchmarkRun(
        kind="generation_gate_eval",
        status=status,
        metrics_json=metrics,
        environment_json={
            "db_url": config.DB_URL,
            "worker_enabled": config.JOBS_WORKER_ENABLED,
            "evidence": {"generation_quality": quality},
        },
        notes=notes,
    )
    session.add(run)
    session.commit()
    session.refresh(run)
    return {
        "id": run.id,
        "kind": run.kind,
        "status": run.status,
        "metrics": metrics,
        "evidence": run.environment_json.get("evidence", {}),
        "created_at": run.created_at.isoformat(),
    }


def run_benchmark_smoke(session: Session, *, notes: str | None = None) -> dict:
    """Record a deterministic local benchmark smoke run."""
    from . import adaptivity, backup, content_health

    metrics: dict[str, float] = {}
    evidence: dict[str, object] = {}

    def timed(label: str, fn):
        start = time.monotonic()
        result = fn()
        metrics[f"{label}_ms"] = round((time.monotonic() - start) * 1000, 1)
        return result

    timed("backup_status", backup.backup_status)
    timed("content_health", lambda: content_health.health_report(session))
    timed("ability", lambda: adaptivity.ability_matrix(session, days=180, persist=False))
    timed("readiness", lambda: adaptivity.readiness(session, persist=False))
    quality = timed("generation_quality", lambda: _generation_quality_probe(session))
    evidence["generation_quality"] = quality
    metrics.update(_generation_quality_metrics(quality))
    status = "ok" if quality["ok"] else "failed"
    run = BenchmarkRun(
        kind="local_smoke",
        status=status,
        metrics_json=metrics,
        environment_json={
            "db_url": config.DB_URL,
            "worker_enabled": config.JOBS_WORKER_ENABLED,
            "evidence": evidence,
        },
        notes=notes,
    )
    session.add(run)
    session.commit()
    session.refresh(run)
    return {
        "id": run.id,
        "kind": run.kind,
        "status": run.status,
        "metrics": metrics,
        "evidence": evidence,
        "created_at": run.created_at.isoformat(),
    }


def scheduled_task_payload(row: ScheduledTask) -> dict:
    return {
        "id": row.id,
        "key": row.key,
        "label": row.label,
        "task_type": row.task_type,
        "cadence_s": row.cadence_s,
        "status": row.status,
        "enabled": row.enabled,
        "last_run_at": row.last_run_at.isoformat() if row.last_run_at else None,
        "next_run_at": row.next_run_at.isoformat() if row.next_run_at else None,
        "payload": row.payload_json or {},
        "updated_at": row.updated_at.isoformat(),
    }


def scheduler_run_payload(row: SchedulerRun) -> dict:
    return {
        "id": row.id,
        "task_key": row.task_key,
        "task_type": row.task_type,
        "status": row.status,
        "duration_ms": row.duration_ms,
        "result": row.result_json or {},
        "error": row.error,
        "created_at": row.created_at.isoformat(),
    }


def _execute_task(session: Session, row: ScheduledTask) -> dict:
    from . import adaptivity, audit, backup, content_health

    if row.task_type == "backup":
        path = backup.create_backup(label=row.key)
        return {"backup": path.name, "status": backup.backup_status()}
    if row.task_type == "calibration":
        result = audit.calibrate_difficulty(session)
        adaptivity.refresh_all_item_stats(session)
        return {"calibration": result}
    if row.task_type == "embedding":
        # The actual embedding backfill stays opt-in/model-dependent. This
        # scheduled task records coverage so the trust cockpit can see drift.
        from .models import EmbeddingVector, Question
        q_count = len(session.exec(select(Question)).all())
        e_count = len(session.exec(select(EmbeddingVector)).all())
        return {"questions": q_count, "embeddings": e_count, "coverage": (e_count / q_count) if q_count else 1}
    if row.task_type == "content_audit":
        return content_health.health_report(session)
    if row.task_type == "content_revalidation":
        payload = row.payload_json or {}
        return content_health.run_revalidation(
            session,
            limit=int(payload.get("limit") or 25),
            force=bool(payload.get("force", False)),
            apply_quarantine=bool(payload.get("apply_quarantine", False)),
            model_gate=bool(payload.get("model_gate", False)),
        )
    if row.task_type == "eval":
        return {
            "benchmark": run_generation_gate_eval(
                session, notes=f"scheduled:{row.key}"
            )
        }
    allowed = ", ".join(sorted(SUPPORTED_SCHEDULED_TASK_TYPES))
    raise ValueError(f"unsupported scheduled task type: {row.task_type!r}; expected one of {allowed}")


def reconcile_orphans(eng=None) -> int:
    """Mark interrupted (``running``) jobs as ``failed``. Returns how many."""
    eng = eng or engine
    with Session(eng) as s:
        orphans = s.exec(
            select(GenJob).where(GenJob.status == GenStatus.running)
        ).all()
        for job in orphans:
            job.status = GenStatus.failed
            report = dict(job.validation_report or {})
            report["interrupted"] = True
            job.validation_report = report
            s.add(job)
        if orphans:
            s.commit()
        return len(orphans)


# Default cadence for the recurring-maintenance tick (seconds). Hourly is well
# below every seeded schedule's own cadence (6h-7d), so the per-row next_run_at
# gate — not this tick — decides when a task actually fires.
DEFAULT_SCHEDULER_TICK_SECONDS = 3600.0


def _scheduler_tick_interval_from_env() -> float:
    """How often the worker checks for due ScheduledTask rows, in seconds.

    Read inline from ``LSATLAB_SCHEDULER_TICK_SECONDS`` (config.py is owned by
    another slice) with an hourly default. A non-positive value disables the
    tick; any positive value is clamped to a 60s floor so a typo can't make the
    worker poll the scheduler on every tight loop iteration."""
    raw = os.environ.get("LSATLAB_SCHEDULER_TICK_SECONDS")
    if raw is None or raw.strip() == "":
        return DEFAULT_SCHEDULER_TICK_SECONDS
    try:
        value = float(raw)
    except ValueError:
        log.warning(
            "invalid LSATLAB_SCHEDULER_TICK_SECONDS=%r; using default %ss",
            raw, DEFAULT_SCHEDULER_TICK_SECONDS,
        )
        return DEFAULT_SCHEDULER_TICK_SECONDS
    if value <= 0:
        return 0.0  # disabled
    return max(60.0, value)


# --- worker -----------------------------------------------------------------
class JobWorker:
    """Single-threaded drain of queued GenJobs. Sequential by design."""

    def __init__(self, eng=None, *, runner: Optional[Callable[[int], None]] = None,
                 poll_interval: Optional[float] = None,
                 idle_hook: Optional[Callable[[], None]] = None,
                 idle_hook_interval: Optional[float] = None,
                 scheduler_tick_interval: Optional[float] = None) -> None:
        self.engine = eng or engine
        self.runner = runner or generation.run_job
        self.poll_interval = poll_interval or config.JOBS_POLL_INTERVAL_S
        # Optional periodic task run on idle ticks (e.g. refresh coach snapshot).
        self.idle_hook = idle_hook
        self.idle_hook_interval = (
            idle_hook_interval if idle_hook_interval is not None
            else config.DIAGNOSIS_INTERVAL_S
        )
        self._last_hook = 0.0
        # Recurring maintenance scheduler: on idle ticks, at most this often, the
        # worker fires due ScheduledTask rows (backups/calibration/revalidation).
        # Read inline from the env (config.py is owned elsewhere) with a safe
        # hourly default; clamped to a 60s floor so a misconfigured tiny value
        # can't busy-run the scheduler on every poll. <= 0 disables the tick.
        self.scheduler_tick_interval = (
            scheduler_tick_interval if scheduler_tick_interval is not None
            else _scheduler_tick_interval_from_env()
        )
        self._last_scheduler_tick = 0.0
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="lsatlab-job-worker", daemon=True,
        )
        self._thread.start()
        log.info("job worker started poll_interval=%s", self.poll_interval)

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)

    def _next_queued_id(self) -> Optional[int]:
        with Session(self.engine) as s:
            job = s.exec(
                select(GenJob)
                .where(GenJob.status == GenStatus.queued)
                .order_by(GenJob.priority.desc(), GenJob.id)
            ).first()
            return job.id if job else None

    def drain_once(self) -> bool:
        """Run the next queued job, if any. Returns True if one was run."""
        jid = self._next_queued_id()
        if jid is None:
            return False
        try:
            self.runner(jid)
        except Exception as exc:  # run_job normally records failure; custom runners may not.
            log.exception("job worker: runner failed job_id=%s", jid)
            with Session(self.engine) as s:
                mark_job_failed(s, jid, str(exc))
                retry_failed_job(s, jid, reason=str(exc))
            return True
        with Session(self.engine) as s:
            retry_failed_job(s, jid)
        return True

    def _run_idle_hook(self) -> None:
        if self.idle_hook is None:
            return
        now = time.monotonic()
        if self._last_hook and now - self._last_hook < self.idle_hook_interval:
            return
        self._last_hook = now
        try:
            self.idle_hook()
        except Exception:
            log.exception("job worker: idle hook failed")

    def _run_scheduler_tick(self) -> None:
        """Fire due recurring-maintenance tasks, throttled to the tick interval.

        Without this, the seeded ScheduledTask rows (backups/calibration/
        revalidation/…) never run on cadence: their next_run_at is set but
        nothing polls them. We only check at most once per ``scheduler_tick_
        interval``; the per-row next_run_at gate inside ``run_due_scheduled_tasks``
        still decides which (if any) actually run. Wrapped in try/except so a
        single failing scheduled task can never kill the worker loop."""
        if self.scheduler_tick_interval <= 0:
            return  # disabled
        now = time.monotonic()
        if (self._last_scheduler_tick
                and now - self._last_scheduler_tick < self.scheduler_tick_interval):
            return
        self._last_scheduler_tick = now
        try:
            with Session(self.engine) as s:
                result = run_due_scheduled_tasks(s)
            if result.get("ran"):
                log.info("scheduler tick ran %s due task(s)", result["ran"])
        except Exception:
            log.exception("job worker: scheduler tick failed")

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                if self.drain_once():
                    continue
                self._run_idle_hook()
                self._run_scheduler_tick()
                self._stop.wait(self.poll_interval)
            except Exception:
                log.exception("job worker loop error")
                self._stop.wait(self.poll_interval)


_worker: Optional[JobWorker] = None


def get_worker() -> JobWorker:
    """Process-wide worker singleton."""
    global _worker
    if _worker is None:
        _worker = JobWorker()
    return _worker
