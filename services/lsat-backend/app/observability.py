"""Local-only structured logging + request correlation.

Why this exists
---------------
The backend ran with zero logging. When something failed in the field — a model
timeout, a bad PDF parse, a generation job that stuck in ``running`` — there was
no record to look at afterwards. Because LSAT Lab is a *private, offline* app we
deliberately do NOT ship logs to any cloud service (Sentry, Datadog, …); that
would break the privacy promise in docs/00-vision.md. Instead we write structured
records to a rotating file in the app data dir and (optionally) the console.

Design notes
------------
- One rotating file handler (5 x 2 MB) so logs never grow unbounded on a laptop.
- ``key=value`` style records: greppable by a human, no JSON-parsing tax.
- ``setup_logging`` is idempotent — safe to call from the app lifespan and from
  tests without piling up duplicate handlers.
- A ``request_id`` ContextVar is bound per HTTP request by the middleware so any
  log line emitted while handling a request can be correlated to it.
- ``time_llm_call`` is the single seam every model call goes through, so we get
  uniform timing/success telemetry for Ollama and any cloud provider.
"""
from __future__ import annotations

import contextlib
import logging
import logging.handlers
import os
import re
import threading
import time
import uuid
from collections import deque
from collections.abc import Iterator
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from . import config

# Per-request correlation id. "-" when outside a request (CLI, jobs, tests).
request_id_var: ContextVar[str] = ContextVar("request_id", default="-")

_CONFIGURED = False

# Rolling per-task LLM latencies (ms) for the observability status endpoint.
_LATENCY: dict[str, deque] = {}

# W2-6 — cumulative cloud token usage (input + output) for spend visibility.
_CLOUD_INPUT_TOKENS = 0
_CLOUD_OUTPUT_TOKENS = 0

# BC4 — cumulative SQLITE_BUSY/LOCKED contention count (RAM-only, resets on
# restart, like the latency ring above). The engine's handle_error listener in
# db.py feeds this; the sqlite-health endpoint reads it. Guarded by a lock
# because db writes happen on FastAPI request threads AND the job worker thread.
_SQLITE_BUSY_RETRIES = 0
_SQLITE_BUSY_LOCK = threading.Lock()

_LOG_LEVEL_RE = re.compile(r"\b(DEBUG|INFO|WARNING|ERROR|CRITICAL)\b")
_REQ_RE = re.compile(r"\breq=([^\s]+)")
_STATUS_RE = re.compile(r"\bstatus=(\d{3})\b")
_PATH_RE = re.compile(r"\bpath=([^\s]+)")


def record_latency(task: str, ms: float) -> None:
    _LATENCY.setdefault(task, deque(maxlen=200)).append(ms)


def latency_p50(task: str) -> Optional[float]:
    dq = _LATENCY.get(task)
    if not dq:
        return None
    ordered = sorted(dq)
    return round(ordered[len(ordered) // 2], 1)


def llm_egress_class(provider: str | None) -> str:
    """Classify model traffic without inspecting or logging prompt content."""
    name = (provider or "").strip().lower()
    if name in {"ollama", "lmstudio"}:
        return "local_loopback"
    if name in {"anthropic"}:
        return "cloud_provider"
    return "unknown"


def record_cloud_tokens(input_tokens: int, output_tokens: int) -> None:
    global _CLOUD_INPUT_TOKENS, _CLOUD_OUTPUT_TOKENS
    _CLOUD_INPUT_TOKENS += max(0, int(input_tokens))
    _CLOUD_OUTPUT_TOKENS += max(0, int(output_tokens))


def cloud_token_totals() -> dict[str, int]:
    return {
        "input_tokens": _CLOUD_INPUT_TOKENS,
        "output_tokens": _CLOUD_OUTPUT_TOKENS,
        "total_tokens": _CLOUD_INPUT_TOKENS + _CLOUD_OUTPUT_TOKENS,
    }


def record_sqlite_busy(count: int = 1) -> None:
    """BC4 — bump the SQLITE_BUSY/LOCKED contention gauge. Fed by db.py's
    ``handle_error`` engine listener; never raises (telemetry must not break a
    query)."""
    global _SQLITE_BUSY_RETRIES
    with _SQLITE_BUSY_LOCK:
        _SQLITE_BUSY_RETRIES += max(0, int(count))


def sqlite_busy_total() -> int:
    """Current process-local SQLITE_BUSY/LOCKED count (resets on restart)."""
    with _SQLITE_BUSY_LOCK:
        return _SQLITE_BUSY_RETRIES


def sqlite_health(*, include_wal: bool = True) -> dict[str, Any]:
    """BC4 — lightweight SQLite contention/PRAGMA snapshot for diagnostics.

    Returns the live connection PRAGMA values (journal_mode, busy_timeout,
    synchronous, foreign_keys), the observed BUSY/LOCKED retry count, and — only
    when cheap — an estimate of the WAL sidecar size in bytes. The WAL estimate
    is a plain ``os.stat`` of the ``-wal`` file (no checkpoint, no DB read) and
    is skipped/None whenever it would be missing or unreadable, so this endpoint
    stays O(1) and never touches the busy write path.
    """
    from .db import current_pragmas, sqlite_busy_retries

    pragmas = current_pragmas()
    return {
        "pragmas": pragmas,
        "busy_retries": sqlite_busy_retries(),
        "wal_estimate_if_cheap": _wal_estimate_bytes() if include_wal else None,
    }


def _wal_estimate_bytes() -> Optional[int]:
    """Best-effort byte size of the SQLite ``-wal`` sidecar, or ``None``.

    Only a single ``stat`` call — cheap and side-effect free. Returns ``None``
    when the file is absent (WAL checkpointed/empty) or unreadable.
    """
    try:
        wal_path = config.DB_PATH.with_name(config.DB_PATH.name + "-wal")
        if not wal_path.exists():
            return None
        return wal_path.stat().st_size
    except OSError:  # pragma: no cover - diagnostics must degrade softly
        return None


def whisper_cache_status() -> dict[str, Any]:
    """BB4 — best-effort presence check of the local Whisper/voice model cache.

    The offline voice-input model (Whisper-tiny ONNX) is downloaded and cached in
    the *browser* by transformers.js (see src/lib/voice.js), so the host is the
    authoritative source for "downloaded vs not". The backend can only report the
    configured model id, the conventional on-disk cache dir, and whether any
    cached files for that model appear to exist there — useful when transformers
    is pointed at a server-side cache (``TRANSFORMERS_CACHE``/``HF_HOME``).

    Read-only and side-effect free: a single best-effort directory walk, never
    raises. ``downloaded`` is ``True`` only when matching cache files are found on
    disk; ``None`` cache dir state degrades to ``downloaded=False`` so the UI can
    fall back to its own browser-cache probe / the always-available Web Speech
    fallback.
    """
    model_id = config.VOICE_MODEL_ID
    cache_dir = config.VOICE_MODEL_CACHE_DIR
    # HuggingFace hub layout names a snapshot dir "models--<org>--<name>"; the
    # plain "<org>/<name>" form is also matched so a custom flat cache works.
    slug = model_id.replace("/", "--")
    info: dict[str, Any] = {
        "model_id": model_id,
        "cache_dir": str(cache_dir),
        "cache_dir_exists": False,
        "downloaded": False,
        "file_count": 0,
        "size_bytes": 0,
        # Honest note: the real source of truth is the in-browser cache; the host
        # confirms/overrides this. Always-available even when not downloaded.
        "browser_cached": True,
        "note": (
            "Whisper-tiny runs in-browser via transformers.js; this on-disk "
            "check only sees a server-side transformers cache if configured."
        ),
    }
    try:
        if not cache_dir.exists():
            return info
        info["cache_dir_exists"] = True
        file_count = 0
        size_bytes = 0
        for path in cache_dir.rglob("*"):
            try:
                parts = "/".join(path.parts).lower()
                if slug.lower() not in parts and model_id.lower() not in parts:
                    continue
                if path.is_file():
                    file_count += 1
                    size_bytes += path.stat().st_size
            except OSError:  # pragma: no cover - skip unreadable entries
                continue
        info["file_count"] = file_count
        info["size_bytes"] = size_bytes
        info["downloaded"] = file_count > 0
    except OSError:  # pragma: no cover - diagnostics must degrade softly
        return info
    return info


def worker_readiness(
    *,
    gen_queued: int | None = None,
    gen_running: int | None = None,
) -> dict[str, Any]:
    """Read-only worker readiness for the observability status payload."""
    from . import jobs

    worker = jobs.get_worker()
    thread = worker._thread
    alive = thread is not None and thread.is_alive()
    enabled = bool(config.JOBS_WORKER_ENABLED)
    ready = (not enabled) or alive
    if not enabled:
        status = "disabled"
    elif alive:
        status = "alive"
    elif thread is None:
        status = "not_started"
    else:
        status = "stopped"
    return {
        "ready": ready,
        "status": status,
        "enabled": enabled,
        "alive": alive,
        "thread_started": thread is not None,
        "poll_interval_s": worker.poll_interval,
        "idle_hook_configured": worker.idle_hook is not None,
        "stop_requested": worker._stop.is_set(),
        "queue": {
            "queued": gen_queued,
            "running": gen_running,
        },
    }


def backend_readiness(
    *,
    integrity_report: dict[str, Any] | None = None,
    gen_queued: int | None = None,
    gen_running: int | None = None,
    require_worker: bool = True,
) -> dict[str, Any]:
    """Summarize DB, backup, and worker readiness for local diagnostics."""
    from . import backup

    report = integrity_report or backup.integrity_report()
    worker = worker_readiness(gen_queued=gen_queued, gen_running=gen_running)
    db = {
        "ready": bool(report["ready"]),
        "status": report["status"],
        "path": report["db"]["path"],
        "exists": report["db"]["exists"],
        "connectable": report["db"]["connectable"],
        "integrity_check": report["integrity_check"],
        "foreign_key_check": {
            "available": report["foreign_key_check"]["available"],
            "ok": report["foreign_key_check"]["ok"],
            "violations": report["foreign_key_check"]["violations"],
        },
        "orphan_total": report["orphans"]["total"],
        "schema_ok": report["schema"]["ok"],
        "migrations_ok": report["migrations"]["ok"],
        "indexes_ok": report["indexes"]["ok"],
        "triggers_ok": report["triggers"]["ok"],
        "pragmas_ok": report["pragmas"]["ok"],
        "pragmas": report["pragmas"],
        "size_bytes": report["db"]["size_bytes"],
        "modified_at": report["db"]["modified_at"],
    }
    errors = list(report["errors"])
    warnings = list(report["warnings"])
    worker["required_for_readiness"] = require_worker
    worker_ready_for_readiness = worker["ready"] or not require_worker
    if not worker["ready"] and require_worker:
        errors.append("worker_not_ready")
    elif not worker["ready"]:
        warnings.append("worker_not_observed")
    return {
        "ok": db["ready"] and worker_ready_for_readiness,
        "status": "ok" if db["ready"] and worker_ready_for_readiness and not warnings else (
            "warning" if db["ready"] and worker_ready_for_readiness else "error"
        ),
        "generated_at": report["generated_at"],
        "db": db,
        "backup": report["backup"],
        "worker": worker,
        "errors": errors,
        "warnings": warnings,
    }


def runtime_evidence_summary(
    session: Any = None,
    *,
    recent_limit: int = 20,
    recent_error_window_hours: int = 12,
    tail_bytes: int = 200_000,
) -> dict[str, Any]:
    """Best-effort local runtime evidence for the Reliability Console.

    This intentionally reads only local files and the local SQLite metrics
    tables. Missing or unreadable logs are reported as evidence gaps, not raised,
    so diagnostics can explain the problem without making the backend less
    available.
    """
    log_dir = config.LOG_DIR
    log_files = _runtime_log_files()
    file_rows = [_log_file_payload(path) for path in log_files]
    recent_events = recent_log_events(
        log_files=log_files,
        limit=recent_limit,
        tail_bytes=tail_bytes,
    )
    error_events = [
        event
        for event in recent_events
        if event["level"] in {"ERROR", "CRITICAL"} or int(event.get("status") or 0) >= 500
    ]
    error_cutoff = datetime.now(timezone.utc) - timedelta(
        hours=max(1, recent_error_window_hours)
    )
    recent_errors = [
        event
        for event in error_events
        if _event_is_after(event, error_cutoff)
    ]
    metrics = _metrics_freshness(session)
    log_dir_exists = log_dir.exists()
    writable = log_dir_exists and os.access(log_dir, os.W_OK)
    ok = log_dir_exists and bool(file_rows)
    status = "ok" if ok and not recent_errors else "warning"
    if not log_dir_exists:
        status = "missing"
    return {
        "ok": ok,
        "status": status,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "log_dir": str(log_dir),
        "log_dir_exists": log_dir_exists,
        "log_dir_writable": writable,
        "log_file_count": len(file_rows),
        "log_files": file_rows,
        "recent_error_count": len(recent_errors),
        "stale_error_count": max(0, len(error_events) - len(recent_errors)),
        "recent_error_window_hours": recent_error_window_hours,
        "recent_errors": recent_errors[:recent_limit],
        "last_request_error": _last_request_error(recent_errors),
        "metrics": metrics,
        "crash_free_window": {
            "status": "unknown",
            "summary": "frontend crash state is client-local; see Diagnostics last-crash row",
        },
    }


def recent_log_events(
    *,
    log_files: list[Any] | None = None,
    limit: int = 20,
    tail_bytes: int = 200_000,
) -> list[dict[str, Any]]:
    files = log_files if log_files is not None else _runtime_log_files()
    events: list[dict[str, Any]] = []
    for path in files:
        for line in _tail_lines(path, max_bytes=tail_bytes):
            event = _parse_log_line(line, path)
            if event is not None:
                events.append(event)
    return events[-max(1, limit):][::-1]


def _runtime_log_files() -> list[Any]:
    try:
        return sorted(
            config.LOG_DIR.glob("lsatlab.log*"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        return []


def _log_file_payload(path: Any) -> dict[str, Any]:
    try:
        stat = path.stat()
    except OSError as exc:
        return {
            "name": getattr(path, "name", str(path)),
            "path": str(path),
            "readable": False,
            "error": str(exc),
        }
    return {
        "name": path.name,
        "path": str(path),
        "readable": os.access(path, os.R_OK),
        "size_bytes": stat.st_size,
        "modified_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
    }


def _tail_lines(path: Any, *, max_bytes: int) -> list[str]:
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - max(1024, max_bytes)))
            raw = handle.read()
    except OSError:
        return []
    text = raw.decode("utf-8", errors="replace")
    return [line for line in text.splitlines() if line.strip()]


def _parse_log_line(line: str, path: Any) -> dict[str, Any] | None:
    level_match = _LOG_LEVEL_RE.search(line)
    status_match = _STATUS_RE.search(line)
    if level_match is None and status_match is None:
        return None
    status = int(status_match.group(1)) if status_match else None
    req_match = _REQ_RE.search(line)
    path_match = _PATH_RE.search(line)
    parts = line.split(maxsplit=3)
    return {
        "timestamp": parts[0] if parts else None,
        "level": level_match.group(1) if level_match else "INFO",
        "request_id": req_match.group(1) if req_match else None,
        "status": status,
        "path": path_match.group(1) if path_match else None,
        "file": getattr(path, "name", str(path)),
        "message": line[:500],
    }


def _event_is_after(event: dict[str, Any], cutoff: datetime) -> bool:
    timestamp = event.get("timestamp")
    if not timestamp:
        # Untimestamped errors are potentially current because the log parser
        # found them in the active tail; keep them visible.
        return True
    try:
        parsed = datetime.fromisoformat(str(timestamp).replace("Z", "+00:00"))
    except ValueError:
        return True
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc) >= cutoff


def _last_request_error(events: list[dict[str, Any]]) -> dict[str, Any] | None:
    for event in events:
        if event.get("request_id") or event.get("path"):
            return event
    return events[0] if events else None


def _metrics_freshness(session: Any = None) -> dict[str, Any]:
    def _read(s: Any) -> dict[str, Any]:
        from sqlmodel import select
        from .models import MetricSample

        rows = s.exec(
            select(MetricSample).order_by(MetricSample.id.desc()).limit(50)
        ).all()
        latest = rows[0] if rows else None
        by_kind: dict[str, int] = {}
        for row in rows:
            by_kind[row.kind] = by_kind.get(row.kind, 0) + 1
        return {
            "available": True,
            "recent_count": len(rows),
            "by_kind": by_kind,
            "latest": {
                "id": latest.id,
                "kind": latest.kind,
                "model": latest.model,
                "value": latest.value,
                "created_at": latest.created_at.isoformat(),
            } if latest else None,
        }

    try:
        if session is not None:
            return _read(session)
        from .db import engine
        from sqlmodel import Session

        with Session(engine) as s:
            return _read(s)
    except Exception as exc:  # pragma: no cover - diagnostics must degrade softly
        logging.getLogger("lsatlab.metrics").debug(
            "runtime metrics freshness failed", exc_info=True
        )
        return {"available": False, "error": str(exc)}


# --- 7.3 durable persistence ------------------------------------------------
# The two globals above are a fast, RAM-only view that resets on restart. These
# helpers ADD durable rows (``MetricSample`` / ``UsageLedger``) so p50 trends and
# month-to-date cloud spend survive a relaunch — and so the monthly budget can be
# *enforced* (see app/llm/__init__.py). DB writes are best-effort: a logging /
# metrics failure must never break the model call that triggered it. We import
# db/models lazily to keep this module import-cheap and circular-import-safe.
def _month_start_utc(now: Optional[datetime] = None) -> datetime:
    now = now or datetime.now(timezone.utc)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def cloud_cost_usd(input_tokens: int, output_tokens: int) -> float:
    """Price a single cloud call from the configurable per-MTok rates (7.3)."""
    in_tok = max(0, int(input_tokens))
    out_tok = max(0, int(output_tokens))
    cost = (
        in_tok * config.CLOUD_INPUT_COST_PER_MTOK
        + out_tok * config.CLOUD_OUTPUT_COST_PER_MTOK
    ) / 1_000_000.0
    return round(cost, 6)


def estimate_cloud_cost_usd(input_tokens: int, output_tokens: int) -> float:
    """Worst-case (pre-call) price estimate for a cloud call.

    Identical pricing to :func:`cloud_cost_usd` (the actual ledger costing) so the
    pre-call budget guard in app/llm/__init__.py and the post-call ledger row
    stay consistent. Kept as a distinct name to make the *intent* (a forecast
    used to refuse a call that would overshoot the cap) explicit at call sites.
    """
    return cloud_cost_usd(input_tokens, output_tokens)


def cleanup_old_metrics(days: int = 30) -> None:
    """B38: delete MetricSample rows older than ``days`` days. Best-effort.

    Called from the idle hook in main.py so it runs periodically without
    requiring a separate job or counter. A failure is logged but never raised.
    """
    try:
        from .db import engine
        from .models import MetricSample
        from sqlmodel import Session, select
        from datetime import timedelta

        cutoff = datetime.now(timezone.utc) - timedelta(days=max(1, days))
        with Session(engine) as s:
            old_rows = s.exec(
                select(MetricSample).where(MetricSample.created_at < cutoff)
            ).all()
            for row in old_rows:
                s.delete(row)
            if old_rows:
                s.commit()
    except Exception:  # pragma: no cover
        logging.getLogger("lsatlab.metrics").debug(
            "cleanup_old_metrics failed", exc_info=True
        )


def persist_latency_sample(task: str, ms: float, *, provider: str = "",
                           model: str = "") -> None:
    """Append a durable ``MetricSample(kind="llm_latency_ms")`` row. Best-effort."""
    try:
        from .db import engine
        from .models import MetricSample
        from sqlmodel import Session

        with Session(engine) as s:
            s.add(MetricSample(
                kind="llm_latency_ms",
                model=model or "",
                value=round(float(ms), 1),
                meta_json={"task": task, "provider": provider},
            ))
            s.commit()
    except Exception:  # pragma: no cover - telemetry must never break a call
        logging.getLogger("lsatlab.metrics").debug(
            "persist_latency_sample failed", exc_info=True
        )


def persist_cloud_usage(provider: str, model: str, input_tokens: int,
                        output_tokens: int) -> float:
    """Append a durable ``UsageLedger`` row priced via :func:`cloud_cost_usd`.

    Returns the cost recorded (0.0 if the write failed). Best-effort: a ledger
    write failure is logged, never raised, so it can't break a generation call.
    """
    cost = cloud_cost_usd(input_tokens, output_tokens)
    try:
        from .db import engine
        from .models import UsageLedger
        from sqlmodel import Session

        with Session(engine) as s:
            s.add(UsageLedger(
                provider=provider or "cloud",
                model=model or "",
                input_tokens=max(0, int(input_tokens)),
                output_tokens=max(0, int(output_tokens)),
                cost_usd=cost,
            ))
            s.commit()
        return cost
    except Exception:  # pragma: no cover
        logging.getLogger("lsatlab.metrics").debug(
            "persist_cloud_usage failed", exc_info=True
        )
        return 0.0


def month_to_date_spend_usd(session: Any = None,
                            now: Optional[datetime] = None, *,
                            strict: bool = False) -> float:
    """Sum ``UsageLedger.cost_usd`` for the current calendar month (UTC).

    The number the budget gauge shows AND the budget enforcement checks against.
    A ``session`` may be passed (e.g. from a request handler) to reuse a
    connection; otherwise one is opened.

    By default returns 0.0 on any read failure so the *display* gauge degrades
    softly. The budget *enforcement* path passes ``strict=True`` so a read failure
    RAISES instead — the caller then fails CLOSED (refuses the paid cloud call)
    rather than treating a metrics-store glitch as "plenty of budget left".
    """
    start = _month_start_utc(now)

    def _sum(s) -> float:
        from sqlalchemy import func
        from sqlmodel import select
        from .models import UsageLedger

        total = s.exec(
            select(func.coalesce(func.sum(UsageLedger.cost_usd), 0.0))
            .where(UsageLedger.created_at >= start)
        ).one()
        # func.sum returns the scalar directly via .one() on a scalar select.
        val = total[0] if isinstance(total, (tuple, list)) else total
        return float(val or 0.0)

    try:
        if session is not None:
            return round(_sum(session), 6)
        from .db import engine
        from sqlmodel import Session

        with Session(engine) as s:
            return round(_sum(s), 6)
    except Exception:
        if strict:
            raise
        logging.getLogger("lsatlab.metrics").debug(
            "month_to_date_spend_usd failed", exc_info=True
        )
        return 0.0


def persisted_latency_p50(task: str, *, window: int = 200,
                          session: Any = None) -> Optional[float]:
    """p50 LLM latency over the last ``window`` durable samples for ``task``.

    Mirrors :func:`latency_p50` (the RAM ring) but reads ``MetricSample`` so it
    survives a restart. ``None`` when there are no persisted samples for the task.

    B39: filters by task in SQL via json_extract so we fetch only the rows we
    need instead of over-fetching (window*4) and filtering in Python.
    """
    def _p50(s) -> Optional[float]:
        from sqlalchemy import func
        from sqlmodel import select
        from .models import MetricSample

        # B39: push the task filter into SQL using SQLite's json_extract so only
        # rows for THIS task are fetched, not window*4 rows filtered in Python.
        rows = s.exec(
            select(MetricSample)
            .where(MetricSample.kind == "llm_latency_ms")
            .where(
                func.json_extract(MetricSample.meta_json, "$.task") == task
            )
            .order_by(MetricSample.id.desc())
            .limit(max(1, window))
        ).all()
        matched = [float(r.value) for r in rows]
        if not matched:
            return None
        ordered = sorted(matched)
        return round(ordered[len(ordered) // 2], 1)

    try:
        if session is not None:
            return _p50(session)
        from .db import engine
        from sqlmodel import Session

        with Session(engine) as s:
            return _p50(s)
    except Exception:  # pragma: no cover
        logging.getLogger("lsatlab.metrics").debug(
            "persisted_latency_p50 failed", exc_info=True
        )
        return None


class _RequestIdFilter(logging.Filter):
    """Inject the current request id onto every record so the format can use it."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get()
        return True


def setup_logging() -> None:
    """Configure root logging once. Idempotent."""
    global _CONFIGURED
    if _CONFIGURED:
        return

    root = logging.getLogger()
    root.setLevel(getattr(logging, config.LOG_LEVEL, logging.INFO))

    fmt = logging.Formatter(
        "%(asctime)s %(levelname)s %(name)s req=%(request_id)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    req_filter = _RequestIdFilter()

    try:
        config.LOG_DIR.mkdir(parents=True, exist_ok=True)
        file_handler = logging.handlers.RotatingFileHandler(
            config.LOG_DIR / "lsatlab.log",
            maxBytes=2_000_000,
            backupCount=5,
            encoding="utf-8",
        )
        file_handler.setFormatter(fmt)
        file_handler.addFilter(req_filter)
        root.addHandler(file_handler)
    except OSError:
        # A read-only / unwritable data dir must never crash the app.
        pass

    if config.LOG_TO_CONSOLE:
        console = logging.StreamHandler()
        console.setFormatter(fmt)
        console.addFilter(req_filter)
        root.addHandler(console)

    # uvicorn installs its own noisy access logger; let it ride at WARNING.
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)

    _CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


async def request_logging_middleware(request: Any, call_next: Any):
    """Bind a request id, log one line per request with method/path/status/ms.

    B40: the info-level line logs the path only (no query string) so token
    values, search terms, and other PII in query params stay out of the default
    log tier. The full query string is emitted at DEBUG level for diagnostics.
    """
    rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
    token = request_id_var.set(rid)
    log = logging.getLogger("lsatlab.request")
    started = time.perf_counter()
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    finally:
        dur_ms = round((time.perf_counter() - started) * 1000, 1)
        # B40: log path only at INFO; query string only at DEBUG.
        log.info(
            "method=%s path=%s status=%s dur_ms=%s",
            request.method, request.url.path, status, dur_ms,
        )
        qs = str(request.url.query)
        if qs:
            log.debug("method=%s path=%s query=%s", request.method, request.url.path, qs)
        request_id_var.reset(token)


@contextlib.contextmanager
def time_llm_call(task: str, *, provider: str, model: str,
                  egress_class: str | None = None,
                  logger: Optional[logging.Logger] = None) -> Iterator[dict]:
    """Time a single model call and log uniform telemetry.

    Usage::

        with time_llm_call("explain", provider="ollama", model=m) as span:
            ... do the call ...
            span["tokens"] = n   # optional extra fields

    Logs ``ok=...`` and ``dur_ms=...`` on exit, even when the call raises.
    Prompt content is never logged; the explicit ``prompt_logged=false`` field is
    part of the audit contract for AI/provider routes.
    """
    log = logger or logging.getLogger("lsatlab.llm")
    span: dict[str, Any] = {}
    started = time.perf_counter()
    ok = True
    try:
        yield span
    except Exception:
        ok = False
        raise
    finally:
        dur_ms = round((time.perf_counter() - started) * 1000, 1)
        record_latency(task, dur_ms)            # RAM fast path (existing)
        persist_latency_sample(task, dur_ms, provider=provider, model=model)  # 7.3 durable
        extra = " ".join(f"{k}={v}" for k, v in span.items())
        egress = egress_class or llm_egress_class(provider)
        log.info(
            "llm task=%s provider=%s model=%s egress_class=%s ok=%s dur_ms=%s "
            "prompt_logged=false %s",
            task, provider, model, egress, ok, dur_ms, extra,
        )
