"""FastAPI app for LSAT Lab backend. All routes mounted under /api."""
from __future__ import annotations

import re
import threading
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from sqlmodel import Session, select

from . import audit, backup, coach, config, jobs, observability, settings_store
from .db import engine, init_db
from .routers import (
    ai_routes,
    analytics_routes,
    annotation_routes,
    adaptivity_routes,
    backup_routes,
    content,
    content_health_routes,
    dataset_routes,
    search_routes,
    drills,
    error_log,
    exam_routes,
    generation_routes,
    import_routes,
    notebook_os_routes,
    notebook_routes,
    observability_routes,
    playlist_routes,
    rc_routes,
    sessions,
    settings_routes,
    srs_routes,
    study_routes,
    trust_routes,
)


def _run_coach_refresh_safely(eng) -> None:
    """Background coach refresh target used by the worker idle hook."""
    try:
        coach.maybe_refresh(eng)
    except Exception:
        observability.get_logger("lsatlab").exception(
            "idle hook: coach.maybe_refresh failed"
        )


def make_idle_hook(eng, *, calibration_interval_s: float | None = None):
    """Build the worker's idle-tick callback.

    Runs three throttled maintenance tasks on idle ticks:
      * ``coach.maybe_refresh`` — refresh the cached diagnosis when stale,
        B36: fired in a daemon thread so it never blocks the job worker,
      * ``backup.maybe_backup`` — daily local DB snapshot,
      * ``audit.calibrate_difficulty`` — recompute empirical difficulty so it
        stays fresh, throttled like the daily backup (its own monotonic gate,
        since calibration has no natural last-run marker).
      * ``observability.cleanup_old_metrics`` — B38: prune MetricSample rows
        older than 30 days to prevent unbounded table growth.

    Factored out (and parameterised) so it can be unit-tested by calling it
    directly rather than starting the worker thread. Each task is individually
    guarded so one failing never starves the others (and the worker's own
    try/except is a backstop)."""
    interval = (
        calibration_interval_s if calibration_interval_s is not None
        else config.CALIBRATION_INTERVAL_S
    )
    state = {"last_calibration": 0.0}
    log = observability.get_logger("lsatlab")

    def _idle() -> None:
        # B36: fire coach.maybe_refresh in a daemon thread so LLM call time
        # does not block the job-worker loop (which also drains generation jobs).
        if config.JOBS_WORKER_ENABLED:
            try:
                threading.Thread(
                    target=_run_coach_refresh_safely,
                    args=(eng,),
                    daemon=True,
                    name="lsatlab-coach-refresh",
                ).start()
            except Exception:
                log.exception("idle hook: coach.maybe_refresh spawn failed")
        try:
            backup.maybe_backup()
        except Exception:
            log.exception("idle hook: backup.maybe_backup failed")
        # B38: prune old metrics on every idle tick; the function is cheap
        # (guarded internally) and avoids unbounded MetricSample growth.
        try:
            observability.cleanup_old_metrics(days=30)
        except Exception:
            log.exception("idle hook: cleanup_old_metrics failed")
        # Throttled empirical-difficulty calibration.
        now = time.monotonic()
        if not state["last_calibration"] or now - state["last_calibration"] >= interval:
            state["last_calibration"] = now
            try:
                with Session(eng) as s:
                    audit.calibrate_difficulty(s)
            except Exception:
                log.exception("idle hook: calibrate_difficulty failed")

    return _idle


_ANTHROPIC_MODEL_RE = re.compile(r"^claude-[a-z0-9-]+$")


@asynccontextmanager
async def lifespan(app: FastAPI):
    observability.setup_logging()
    log = observability.get_logger("lsatlab")
    # B20: warn if cloud generation is enabled with an unrecognised model slug.
    if config.GEN_PROVIDER == "cloud" and config.CLOUD_API_KEY:
        if not _ANTHROPIC_MODEL_RE.match(config.CLOUD_GEN_MODEL):
            log.warning(
                "CLOUD_GEN_MODEL=%r does not match the Anthropic model pattern "
                "(^claude-[a-z0-9-]+); cloud generation may fail at runtime",
                config.CLOUD_GEN_MODEL,
            )
    # D4: if a DB file already exists, verify integrity BEFORE migrating it — a
    # corrupt/locked DB should surface loudly with a restore hint rather than crash
    # mid-migration with a raw traceback (a local file has no cloud fallback).
    db_degraded = False
    if config.DB_PATH.exists():
        integrity = backup.integrity_check()
        if integrity != "ok":
            db_degraded = True
            log.error(
                "db integrity_check FAILED result=%s — database may be corrupt; "
                "restore the latest snapshot from %s before continuing. Running in "
                "DEGRADED mode: the background job worker is DISABLED so generation "
                "cannot write to a possibly-corrupt DB.",
                integrity, config.BACKUP_DIR,
            )
    init_db()
    # First-run convenience (opt-in via LSATLAB_SEED_ON_EMPTY): seed the bundled
    # sample content when the DB has no questions yet. Off by default; skipped on a
    # degraded DB so we never write into a corrupt file.
    if config.SEED_ON_EMPTY and not db_degraded:
        try:
            from .models import Question
            with Session(engine) as s:
                has_questions = s.exec(select(Question).limit(1)).first() is not None
            if not has_questions:
                from . import seed as _seed
                seeded = _seed.seed(reset=False)
                log.info("SEED_ON_EMPTY: seeded %s sample questions into empty DB", seeded)
        except Exception:
            log.exception("SEED_ON_EMPTY seeding failed")
    try:
        if backup.backup_status()["status"] == "missing":
            backup.create_backup(label="startup")
    except Exception:
        log.exception("startup backup creation failed")
    with Session(engine) as s:
        settings_store.apply_saved_settings(s)
        jobs.ensure_default_schedules(s)
    n = jobs.reconcile_orphans()
    if n:
        log.info("reconciled interrupted generation jobs n=%s", n)
    worker_started = False
    if config.JOBS_WORKER_ENABLED and not db_degraded:
        worker = jobs.get_worker()
        # On idle ticks: refresh the coach snapshot, take a throttled (daily)
        # local DB snapshot, and recompute empirical difficulty (throttled).
        worker.idle_hook = make_idle_hook(engine)
        worker.start()
        worker_started = True
    log.info(
        "startup db=%s worker=%s degraded=%s",
        config.DB_URL, worker_started, db_degraded,
    )
    yield
    if worker_started:
        jobs.get_worker().stop()


app = FastAPI(title="LSAT Lab Backend", version=config.APP_VERSION, lifespan=lifespan)

# Request-correlation + one-line-per-request logging.
app.middleware("http")(observability.request_logging_middleware)


def _error_code(status_code: int, detail: Any) -> str:
    if isinstance(detail, dict) and detail.get("error"):
        return str(detail["error"])
    if status_code == 422:
        return "validation_error"
    if status_code == 404:
        return "not_found"
    if status_code == 403:
        return "forbidden"
    if status_code == 400:
        return "bad_request"
    return f"http_{status_code}"


def _error_message(status_code: int, detail: Any) -> str:
    if isinstance(detail, dict):
        if detail.get("message"):
            return str(detail["message"])
        if detail.get("error"):
            return str(detail["error"]).replace("_", " ")
    if isinstance(detail, str):
        return detail
    return "Request failed" if status_code < 500 else "Internal server error"


def _error_response(
    *,
    status_code: int,
    code: str,
    message: str,
    detail: Any,
    retryable: bool,
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "code": code,
            "message": message,
            "detail": detail,
            "request_id": observability.request_id_var.get(),
            "retryable": retryable,
        },
    )


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(_request, exc: StarletteHTTPException):
    detail = exc.detail
    status_code = int(exc.status_code)
    return _error_response(
        status_code=status_code,
        code=_error_code(status_code, detail),
        message=_error_message(status_code, detail),
        detail=detail,
        retryable=status_code in {408, 429, 502, 503, 504},
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(_request, exc: RequestValidationError):
    # jsonable_encoder is required: a field_validator that raises ValueError puts
    # the (non-JSON-serializable) exception object in each error's ``ctx``, which
    # would otherwise make JSONResponse raise and turn a 422 into a 500.
    return _error_response(
        status_code=422,
        code="validation_error",
        message="Validation error",
        detail=jsonable_encoder(exc.errors()),
        retryable=False,
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(_request, exc: Exception):
    observability.get_logger("lsatlab").exception("unhandled request error")
    return _error_response(
        status_code=500,
        code="internal_error",
        message="Internal server error",
        detail={"hint": "see server logs"},
        retryable=True,
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Each router's internal prefixes (e.g. /ai, /analytics) compose with /api.
for r in (
    content.router,
    sessions.router,
    ai_routes.router,
    analytics_routes.router,
    srs_routes.router,
    drills.router,
    generation_routes.router,
    import_routes.router,
    dataset_routes.router,
    error_log.router,
    exam_routes.router,
    study_routes.router,
    settings_routes.router,
    annotation_routes.router,
    observability_routes.router,
    backup_routes.router,
    playlist_routes.router,
    search_routes.router,
    adaptivity_routes.router,
    content_health_routes.router,
    notebook_os_routes.router,
    notebook_routes.router,
    rc_routes.router,
    trust_routes.router,
):
    app.include_router(r, prefix="/api")


def custom_openapi() -> dict[str, Any]:
    if app.openapi_schema:
        return app.openapi_schema
    schema = get_openapi(
        title=app.title,
        version=app.version,
        routes=app.routes,
    )
    components = schema.setdefault("components", {}).setdefault("schemas", {})
    components["ErrorEnvelope"] = {
        "type": "object",
        "required": ["code", "message", "detail", "request_id", "retryable"],
        "properties": {
            "code": {"type": "string"},
            "message": {"type": "string"},
            "detail": {},
            "request_id": {"type": "string"},
            "retryable": {"type": "boolean"},
        },
    }
    components["LegacySuccessResponse"] = {
        "title": "LegacySuccessResponse",
        "description": (
            "JSON success response for legacy routes that do not yet have a "
            "narrow typed response_model. Route tests lock behavior while "
            "typed models are added incrementally."
        ),
        "anyOf": [
            {"type": "object"},
            {"type": "array"},
            {"type": "string"},
            {"type": "number"},
            {"type": "integer"},
            {"type": "boolean"},
            {"type": "null"},
        ],
    }
    error_ref = {
        "description": "Uniform backend error envelope",
        "content": {
            "application/json": {
                "schema": {"$ref": "#/components/schemas/ErrorEnvelope"}
            }
        },
    }
    for path, methods in schema.get("paths", {}).items():
        if not path.startswith("/api/"):
            continue
        for op in methods.values():
            responses = op.setdefault("responses", {})
            ok_response = responses.get("200")
            if ok_response is not None:
                content = ok_response.setdefault("content", {}).setdefault(
                    "application/json", {}
                )
                if not content.get("schema"):
                    content["schema"] = {
                        "$ref": "#/components/schemas/LegacySuccessResponse"
                    }
            responses.setdefault("400", error_ref)
            responses.setdefault("404", error_ref)
            responses.setdefault("422", error_ref)
            responses.setdefault("500", error_ref)
    app.openapi_schema = schema
    return app.openapi_schema


app.openapi = custom_openapi
