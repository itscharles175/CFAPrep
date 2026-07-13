"""Tutor OS trust, diagnostics, scheduler, and benchmark surfaces."""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from .. import backup, content_health, jobs, trust
from ..db import engine, get_session
from ..migrations import migration_preview
from ..models import BenchmarkRun, ScheduledTask, SchedulerRun

router = APIRouter()


class ScheduleBody(BaseModel):
    key: str = Field(min_length=1, max_length=80)
    label: str = Field(min_length=1, max_length=160)
    task_type: str = Field(min_length=1, max_length=80)
    cadence_s: int = Field(default=86400, ge=60)
    enabled: bool = True
    payload: dict[str, Any] | None = None


class BenchmarkBody(BaseModel):
    kind: str = Field(min_length=1, max_length=80)
    status: str = Field(default="recorded", max_length=40)
    metrics: dict[str, Any] = Field(default_factory=dict)
    environment: dict[str, Any] = Field(default_factory=dict)
    notes: str | None = Field(default=None, max_length=1000)


@router.get("/observability/trust")
def observability_trust(
    tier: Literal["dev", "release", "packaged"] = Query(default="dev"),
    persist: bool = Query(default=False),
    write: bool = Query(default=False),
    session: Session = Depends(get_session),
):
    write_path = None
    if write:
        from .. import config

        write_path = config.DATA_DIR / "release_trust.json"
    return trust.build_release_trust_manifest(
        session,
        tier=tier,
        persist=persist,
        write_path=write_path,
    )


@router.get("/release/trust")
def release_trust(
    tier: Literal["dev", "release", "packaged"] = Query(default="release"),
    persist: bool = Query(default=False),
    write: bool = Query(default=False),
    session: Session = Depends(get_session),
):
    return observability_trust(
        tier=tier,
        persist=persist,
        write=write,
        session=session,
    )


@router.get("/observability/diagnostics")
def diagnostics(
    tier: Literal["dev", "release", "packaged"] = Query(default="dev"),
    session: Session = Depends(get_session),
):
    """Expanded local diagnostics for the Trust OS cockpit."""
    return {
        "trust": trust.build_release_trust_manifest(session, tier=tier),
        "integrity": backup.integrity_report(),
        "content": content_health.health_report(session),
        "queue": jobs.queue_summary(session),
        "migrations": migration_preview(engine),
        "scheduled_tasks": [_schedule_payload(row) for row in _scheduled(session)],
        "scheduler_runs": [
            jobs.scheduler_run_payload(row)
            for row in _scheduler_runs(session, limit=20)
        ],
        "benchmarks": [_benchmark_payload(row) for row in _benchmarks(session)],
    }


@router.get("/observability/scheduled-tasks")
def scheduled_tasks(session: Session = Depends(get_session)):
    rows = _scheduled(session)
    return {"count": len(rows), "tasks": [_schedule_payload(row) for row in rows]}


@router.post("/observability/scheduled-tasks")
def upsert_scheduled_task(body: ScheduleBody, session: Session = Depends(get_session)):
    try:
        row = jobs.upsert_scheduled_task(
            session,
            key=body.key,
            label=body.label,
            task_type=body.task_type,
            cadence_s=body.cadence_s,
            enabled=body.enabled,
            payload=body.payload,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return _schedule_payload(row)


@router.post("/observability/scheduled-tasks/defaults")
def ensure_scheduled_defaults(session: Session = Depends(get_session)):
    return jobs.ensure_default_schedules(session)


@router.post("/observability/scheduled-tasks/run-due")
def run_due_scheduled_tasks(session: Session = Depends(get_session)):
    return jobs.run_due_scheduled_tasks(session)


@router.post("/observability/scheduled-tasks/{key}/run")
def run_scheduled_task(key: str, session: Session = Depends(get_session)):
    result = jobs.run_scheduled_task(session, key)
    if not result.get("ok") and result.get("reason") == "task_not_found":
        raise HTTPException(404, "Scheduled task not found")
    return result


@router.get("/observability/scheduler-runs")
def scheduler_runs(session: Session = Depends(get_session)):
    rows = _scheduler_runs(session, limit=100)
    return {"count": len(rows), "runs": [jobs.scheduler_run_payload(row) for row in rows]}


@router.get("/observability/migrations/dry-run")
def migrations_dry_run():
    return migration_preview(engine)


@router.post("/observability/migrations/pre-upgrade-backup")
def pre_upgrade_backup():
    path = backup.create_backup(label="pre-upgrade")
    return {"ok": True, "path": str(path), "name": path.name, "status": backup.backup_status()}


@router.get("/observability/benchmarks")
def benchmark_runs(session: Session = Depends(get_session)):
    rows = _benchmarks(session, limit=50)
    return {"count": len(rows), "runs": [_benchmark_payload(row) for row in rows]}


@router.post("/observability/benchmarks")
def record_benchmark(body: BenchmarkBody, session: Session = Depends(get_session)):
    row = BenchmarkRun(
        kind=body.kind,
        status=body.status,
        metrics_json=body.metrics,
        environment_json=body.environment,
        notes=body.notes,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return _benchmark_payload(row)


@router.post("/observability/benchmarks/smoke")
def benchmark_smoke(session: Session = Depends(get_session)):
    return jobs.run_benchmark_smoke(session, notes="manual")


def _scheduled(session: Session) -> list[ScheduledTask]:
    return session.exec(select(ScheduledTask).order_by(ScheduledTask.key)).all()


def _scheduler_runs(session: Session, *, limit: int = 20) -> list[SchedulerRun]:
    return session.exec(
        select(SchedulerRun).order_by(SchedulerRun.id.desc()).limit(limit)
    ).all()


def _benchmarks(session: Session, *, limit: int = 10) -> list[BenchmarkRun]:
    return session.exec(
        select(BenchmarkRun).order_by(BenchmarkRun.id.desc()).limit(limit)
    ).all()


def _schedule_payload(row: ScheduledTask) -> dict[str, Any]:
    return jobs.scheduled_task_payload(row)


def _benchmark_payload(row: BenchmarkRun) -> dict[str, Any]:
    return {
        "id": row.id,
        "kind": row.kind,
        "status": row.status,
        "metrics": row.metrics_json or {},
        "environment": row.environment_json or {},
        "notes": row.notes,
        "created_at": row.created_at.isoformat(),
    }
