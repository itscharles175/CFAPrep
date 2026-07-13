"""Tutor OS trust, diagnostics, scheduler, and benchmark surfaces."""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
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


# --- typed response models (wave 2 API-contract coverage) --------------------
# Every model mirrors the wire JSON its handler already returns — no key is
# added, dropped, or renamed. All models allow (and serialize) extra keys so
# additive fields never require a schema edit, and routes attach them with
# ``response_model_exclude_unset=True`` so conditionally-absent keys stay off
# the wire instead of serializing as null.


class TrustCheckOut(BaseModel):
    """One entry of the trust manifest's ``checks`` map (``trust._check``).

    ``detail`` is heterogeneous per check type and stays ``dict[str, Any]``."""

    model_config = ConfigDict(extra="allow")

    status: str
    summary: str
    detail: dict[str, Any]
    action: str | None = None


class TrustIssueOut(BaseModel):
    """One ``blockers``/``warnings`` item (``trust._messages``)."""

    model_config = ConfigDict(extra="allow")

    check: str
    summary: str | None = None
    action: str | None = None


class TrustEnvironmentOut(BaseModel):
    """The manifest's fixed ``environment`` block."""

    model_config = ConfigDict(extra="allow")

    platform: str
    python: str
    data_dir: str
    db_path: str
    local_provider: str
    offline_generation_provider: str


class TrustManifestOut(BaseModel):
    """``trust.build_release_trust_manifest`` payload, shared by
    ``GET /api/observability/trust`` and ``GET /api/release/trust``.

    ``schema`` shadows a deprecated ``BaseModel`` attribute, hence the alias.
    ``snapshot_id`` (only with ``?persist=true``) and ``written_to`` (only with
    ``?write=true``) are conditionally present — ``exclude_unset`` keeps them
    off the wire when the handler did not set them."""

    model_config = ConfigDict(extra="allow")

    schema_: str = Field(alias="schema")
    tier: str
    status: str
    score: int
    generated_at: str
    app_version: str
    environment: TrustEnvironmentOut
    checks: dict[str, TrustCheckOut]
    blockers: list[TrustIssueOut]
    warnings: list[TrustIssueOut]
    next_actions: list[str]
    snapshot_id: int | None = None
    written_to: str | None = None


class ScheduledTaskOut(BaseModel):
    """``jobs.scheduled_task_payload`` — reused by the list envelope, the
    upsert response, and nested inside run results. ``payload`` is
    user-supplied opaque JSON."""

    model_config = ConfigDict(extra="allow")

    id: int | None = None
    key: str
    label: str
    task_type: str
    cadence_s: int
    status: str
    enabled: bool
    last_run_at: str | None = None
    next_run_at: str | None = None
    payload: dict[str, Any]
    updated_at: str


class ScheduledTaskListOut(BaseModel):
    """Envelope of ``GET /api/observability/scheduled-tasks``."""

    model_config = ConfigDict(extra="allow")

    count: int
    tasks: list[ScheduledTaskOut]


class ScheduledDefaultsOut(BaseModel):
    """``jobs.ensure_default_schedules`` result."""

    model_config = ConfigDict(extra="allow")

    scheduled_tasks: int
    keys: list[str]


class ScheduledTaskRunOut(BaseModel):
    """One ``jobs.run_scheduled_task`` run result. ``result`` is polymorphic
    per task_type (backup/calibration/embedding/content_audit/...) and stays
    ``dict[str, Any]``. The ``{ok: False, reason: 'task_not_found'}`` variant
    never reaches the wire (converted to HTTPException 404)."""

    model_config = ConfigDict(extra="allow")

    ok: bool
    run_id: int | None = None
    task: ScheduledTaskOut
    duration_ms: float
    result: dict[str, Any]
    error: str | None = None


class ScheduledTaskRunDueOut(BaseModel):
    """Envelope of ``POST /api/observability/scheduled-tasks/run-due``."""

    model_config = ConfigDict(extra="allow")

    ran: int
    results: list[ScheduledTaskRunOut]


class SchedulerRunOut(BaseModel):
    """``jobs.scheduler_run_payload`` — one persisted scheduler run.
    ``result`` mirrors the polymorphic stored ``result_json``."""

    model_config = ConfigDict(extra="allow")

    id: int | None = None
    task_key: str
    task_type: str
    status: str
    duration_ms: float
    result: dict[str, Any]
    error: str | None = None
    created_at: str


class SchedulerRunListOut(BaseModel):
    """Envelope of ``GET /api/observability/scheduler-runs``."""

    model_config = ConfigDict(extra="allow")

    count: int
    runs: list[SchedulerRunOut]


class MigrationItemOut(BaseModel):
    """One ``migration_preview`` item. The additive ``error`` key appears only
    on ``failed`` items — one model covers all four lists via
    ``exclude_unset``."""

    model_config = ConfigDict(extra="allow")

    version: int
    name: str
    checksum: str
    recorded_checksum: str | None = None
    status: str | None = None
    error: str | None = None


class MigrationDryRunOut(BaseModel):
    """``migrations.migration_preview`` payload
    (``GET /api/observability/migrations/dry-run``)."""

    model_config = ConfigDict(extra="allow")

    latest_expected_version: int
    pragma_user_version: int
    applied_count: int
    pending_count: int
    applied: list[MigrationItemOut]
    pending: list[MigrationItemOut]
    failed: list[MigrationItemOut]
    checksum_mismatches: list[MigrationItemOut]
    pre_migration_backup_required: bool
    restore_after_upgrade_smoke_required: bool


class BackupNewestOut(BaseModel):
    """The ``newest`` snapshot block of ``backup.backup_status``."""

    model_config = ConfigDict(extra="allow")

    name: str
    size_bytes: int
    created_at: str


class BackupStatusOut(BaseModel):
    """``backup.backup_status`` — ``newest``/``newest_age_seconds`` are null on
    the missing/unavailable branches; ``error`` appears only on the
    ``unavailable`` OSError branch."""

    model_config = ConfigDict(extra="allow")

    status: str
    ok: bool
    backup_dir: str
    count: int
    newest: BackupNewestOut | None = None
    newest_age_seconds: int | None = None
    fresh_within_seconds: int
    error: str | None = None


class PreUpgradeBackupOut(BaseModel):
    """``POST /api/observability/migrations/pre-upgrade-backup`` response."""

    model_config = ConfigDict(extra="allow")

    ok: bool
    path: str
    name: str
    status: BackupStatusOut


class BenchmarkRunOut(BaseModel):
    """``_benchmark_payload`` — one stored ``BenchmarkRun`` row.
    ``metrics``/``environment`` are caller-supplied arbitrary JSON."""

    model_config = ConfigDict(extra="allow")

    id: int | None = None
    kind: str
    status: str
    metrics: dict[str, Any]
    environment: dict[str, Any]
    notes: str | None = None
    created_at: str


class BenchmarkRunListOut(BaseModel):
    """Envelope of ``GET /api/observability/benchmarks``."""

    model_config = ConfigDict(extra="allow")

    count: int
    runs: list[BenchmarkRunOut]


class BenchmarkSmokeOut(BaseModel):
    """``jobs.run_benchmark_smoke`` — deliberately NOT ``BenchmarkRunOut``:
    the smoke run carries ``evidence`` instead of ``environment``/``notes``,
    and its ``metrics`` values are always floats (timing + quality gauges)."""

    model_config = ConfigDict(extra="allow")

    id: int | None = None
    kind: str
    status: str
    metrics: dict[str, float]
    evidence: dict[str, Any]
    created_at: str


class TrustDiagnosticsOut(BaseModel):
    """``GET /api/observability/diagnostics`` — shallow envelope only. The
    trust/integrity/content/queue/migrations sub-reports contain dynamically
    keyed dicts (by_source, by_q_type, by_status, by_entity, ...) and stay
    ``dict[str, Any]``; the scheduler/benchmark lists reuse the typed rows."""

    model_config = ConfigDict(extra="allow")

    trust: dict[str, Any]
    integrity: dict[str, Any]
    content: dict[str, Any]
    queue: dict[str, Any]
    migrations: dict[str, Any]
    scheduled_tasks: list[ScheduledTaskOut]
    scheduler_runs: list[SchedulerRunOut]
    benchmarks: list[BenchmarkRunOut]


@router.get(
    "/observability/trust",
    response_model=TrustManifestOut,
    response_model_exclude_unset=True,
)
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


@router.get(
    "/release/trust",
    response_model=TrustManifestOut,
    response_model_exclude_unset=True,
)
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


@router.get(
    "/observability/diagnostics",
    response_model=TrustDiagnosticsOut,
    response_model_exclude_unset=True,
)
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


@router.get(
    "/observability/scheduled-tasks",
    response_model=ScheduledTaskListOut,
    response_model_exclude_unset=True,
)
def scheduled_tasks(session: Session = Depends(get_session)):
    rows = _scheduled(session)
    return {"count": len(rows), "tasks": [_schedule_payload(row) for row in rows]}


@router.post(
    "/observability/scheduled-tasks",
    response_model=ScheduledTaskOut,
    response_model_exclude_unset=True,
)
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


@router.post(
    "/observability/scheduled-tasks/defaults",
    response_model=ScheduledDefaultsOut,
    response_model_exclude_unset=True,
)
def ensure_scheduled_defaults(session: Session = Depends(get_session)):
    return jobs.ensure_default_schedules(session)


@router.post(
    "/observability/scheduled-tasks/run-due",
    response_model=ScheduledTaskRunDueOut,
    response_model_exclude_unset=True,
)
def run_due_scheduled_tasks(session: Session = Depends(get_session)):
    return jobs.run_due_scheduled_tasks(session)


@router.post(
    "/observability/scheduled-tasks/{key}/run",
    response_model=ScheduledTaskRunOut,
    response_model_exclude_unset=True,
)
def run_scheduled_task(key: str, session: Session = Depends(get_session)):
    result = jobs.run_scheduled_task(session, key)
    if not result.get("ok") and result.get("reason") == "task_not_found":
        raise HTTPException(404, "Scheduled task not found")
    return result


@router.get(
    "/observability/scheduler-runs",
    response_model=SchedulerRunListOut,
    response_model_exclude_unset=True,
)
def scheduler_runs(session: Session = Depends(get_session)):
    rows = _scheduler_runs(session, limit=100)
    return {"count": len(rows), "runs": [jobs.scheduler_run_payload(row) for row in rows]}


@router.get(
    "/observability/migrations/dry-run",
    response_model=MigrationDryRunOut,
    response_model_exclude_unset=True,
)
def migrations_dry_run():
    return migration_preview(engine)


@router.post(
    "/observability/migrations/pre-upgrade-backup",
    response_model=PreUpgradeBackupOut,
    response_model_exclude_unset=True,
)
def pre_upgrade_backup():
    path = backup.create_backup(label="pre-upgrade")
    return {"ok": True, "path": str(path), "name": path.name, "status": backup.backup_status()}


@router.get(
    "/observability/benchmarks",
    response_model=BenchmarkRunListOut,
    response_model_exclude_unset=True,
)
def benchmark_runs(session: Session = Depends(get_session)):
    rows = _benchmarks(session, limit=50)
    return {"count": len(rows), "runs": [_benchmark_payload(row) for row in rows]}


@router.post(
    "/observability/benchmarks",
    response_model=BenchmarkRunOut,
    response_model_exclude_unset=True,
)
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


@router.post(
    "/observability/benchmarks/smoke",
    response_model=BenchmarkSmokeOut,
    response_model_exclude_unset=True,
)
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
