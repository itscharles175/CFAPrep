"""Database engine + session helpers."""
from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from sqlalchemy import event
from sqlmodel import Session, SQLModel, create_engine

from . import config

# check_same_thread=False so the engine works across FastAPI's threadpool.
engine = create_engine(
    config.DB_URL,
    echo=False,
    connect_args={"check_same_thread": False},
)


# --- BC4: SQLITE_BUSY contention counter ------------------------------------
# busy_timeout (set in the connection PRAGMAs below) makes writer-writer
# collisions wait-and-retry inside SQLite instead of erroring out. That retry is
# invisible from the app — a request just gets slightly slower — so a rising
# contention rate (the precursor to an eventual SQLITE_BUSY *failure* once the
# timeout is exhausted) would otherwise go unobserved on a laptop with no APM.
# We hook SQLAlchemy's ``handle_error`` event: it fires for every DBAPI error,
# and we count only the ones whose underlying SQLite code is BUSY/LOCKED. The
# count is a cheap RAM-only gauge (resets on restart, like the latency ring in
# observability.py) surfaced via /observability/sqlite-health.
_busy_lock = threading.Lock()
_busy_retries = 0


def _is_sqlite_busy(error: BaseException | None) -> bool:
    """True when ``error`` (or its chain) is a SQLite BUSY/LOCKED condition."""
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, sqlite3.OperationalError):
            text = str(current).lower()
            if "database is locked" in text or "database table is locked" in text:
                return True
        sqlite_code = getattr(current, "sqlite_errorname", None)
        if isinstance(sqlite_code, str) and sqlite_code.upper() in {
            "SQLITE_BUSY",
            "SQLITE_LOCKED",
        }:
            return True
        current = current.__cause__ or current.__context__
    return False


def _record_busy_error(exception_context: Any) -> None:
    """``handle_error`` listener: bump the BUSY counter on a contention error."""
    global _busy_retries
    if _is_sqlite_busy(getattr(exception_context, "original_exception", None)):
        with _busy_lock:
            _busy_retries += 1
        try:
            from . import observability

            observability.record_sqlite_busy()
        except Exception:  # pragma: no cover - telemetry must never break a query
            pass


def sqlite_busy_retries() -> int:
    """Current process-local count of observed SQLITE_BUSY/LOCKED errors."""
    with _busy_lock:
        return _busy_retries


def current_pragmas() -> dict[str, Any]:
    """Read the live connection PRAGMA values for the observability surface.

    Opens a short-lived connection off the shared engine so the reported values
    reflect what ``_set_connection_pragmas`` actually applied (busy_timeout and
    synchronous are per-connection and not visible in the DB file header).
    """
    keys = ("journal_mode", "busy_timeout", "synchronous", "foreign_keys")
    pragmas: dict[str, Any] = {}
    try:
        raw = engine.raw_connection()
        try:
            cur = raw.cursor()
            try:
                for key in keys:
                    row = cur.execute(f"PRAGMA {key}").fetchone()
                    pragmas[key] = row[0] if row else None
            finally:
                cur.close()
        finally:
            raw.close()
    except Exception:  # pragma: no cover - diagnostics must degrade softly
        return {"available": False, **pragmas}
    pragmas["available"] = True
    return pragmas


event.listen(engine, "handle_error", _record_busy_error)


# --- connection PRAGMAs (applied on every new connection) -------------------
# Two writers share this file: FastAPI request threads AND the background job
# worker thread. With the default rollback journal + busy_timeout=0, the instant
# their writes overlap SQLite raises SQLITE_BUSY *immediately* (surfacing as a 500
# mid-study). WAL lets a reader and a writer proceed concurrently; busy_timeout
# makes the remaining writer-writer collisions wait-and-retry instead of erroring;
# synchronous=NORMAL is the safe, fast durability pairing for WAL. Foreign-key
# enforcement is part of the vNext trust gate and defaults on outside tests.
def _set_connection_pragmas(dbapi_connection, _connection_record) -> None:
    cur = dbapi_connection.cursor()
    try:
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute(f"PRAGMA busy_timeout={max(0, int(config.SQLITE_BUSY_TIMEOUT_MS))}")
        cur.execute("PRAGMA synchronous=NORMAL")
        if config.SQLITE_FK_ENFORCE:
            cur.execute("PRAGMA foreign_keys=ON")
    finally:
        cur.close()


event.listen(engine, "connect", _set_connection_pragmas)


# BC1: single migration ledger. The former ``_ADDITIVE_COLUMNS`` /
# ``_ADDITIVE_INDEXES`` lists and their ``_apply_additive_migrations`` step have
# been folded into the ordered, recorded migrations (see ``migrations.py``,
# migration 20 ``fold_additive_columns``). ``init_db`` now performs schema setup
# through exactly two steps — ``create_all`` for new tables, then
# ``run_migrations`` for every recorded change, additive columns included — so
# the two-list split-brain (which passed tests via ``create_all`` but skipped
# pre-existing tables in prod) no longer exists.


def init_db() -> None:
    """Create all tables. Importing models registers them on SQLModel.metadata."""
    from . import models  # noqa: F401  (ensures tables are registered)
    from .migrations import run_migrations

    SQLModel.metadata.create_all(engine)
    # Ordered, recorded migrations for every non-create_all change: additive
    # columns (folded in BC1), indexes, backfills, triggers.
    run_migrations(engine)


def get_session() -> Iterator[Session]:
    """FastAPI dependency yielding a DB session."""
    with Session(engine) as session:
        yield session


# --- BACK-5: periodic SQLite maintenance ------------------------------------
def _db_file_size_bytes() -> int:
    """On-disk size of the SQLite main DB file (0 when unknown / in-memory)."""
    import os

    try:
        path = config.DB_PATH
        return os.path.getsize(path) if os.path.exists(path) else 0
    except Exception:  # pragma: no cover - diagnostics must never raise
        return 0


def run_db_maintenance(
    *,
    eng=None,
    vacuum_freelist_ratio: float | None = None,
    vacuum_min_freelist_pages: int | None = None,
) -> dict:
    """BACK-5 — WAL TRUNCATE checkpoint + CONDITIONAL VACUUM + ANALYZE.

    Why this exists
    ---------------
    Two writers share the SQLite file (FastAPI threads + the job worker) with
    WAL on, so the ``-wal`` sidecar grows during bursts and the main file
    accumulates free pages as content is quarantined / soft-deleted / re-imported.
    Nothing reclaims that space on a desktop install. This is the registered
    maintenance task (hooked into the existing scheduler via the ``db_maintenance``
    task type) that keeps the file tidy:

      1. ``PRAGMA wal_checkpoint(TRUNCATE)`` — flush the WAL back into the main DB
         and shrink the ``-wal`` file to zero. Safe + cheap; runs every time.
      2. ``VACUUM`` — only CONDITIONALLY: a full-file rewrite is expensive, so we
         skip it unless the free-list is a meaningful fraction of the file
         (``freelist_count / page_count >= vacuum_freelist_ratio`` AND
         ``freelist_count >= vacuum_min_freelist_pages``). ``ratio <= 0`` disables
         VACUUM entirely.
      3. ``ANALYZE`` — refresh the query planner's stats after the checkpoint /
         vacuum so index selection stays good as the bank grows. Cheap.

    Records ``reclaimed_bytes`` (main-file size BEFORE minus AFTER; clamped at 0 so
    a concurrent write that grows the file doesn't report a negative reclaim) so
    the trust cockpit can show how much disk the maintenance freed. VACUUM and the
    checkpoint each run OUTSIDE a transaction (a raw autocommit connection) because
    SQLite forbids VACUUM inside one. Best-effort + isolated: any single step that
    raises is captured in the result and does not abort the others.
    """
    eng = eng or engine
    ratio = (
        config.DB_VACUUM_FREELIST_RATIO if vacuum_freelist_ratio is None
        else vacuum_freelist_ratio
    )
    min_pages = (
        config.DB_VACUUM_MIN_FREELIST_PAGES if vacuum_min_freelist_pages is None
        else vacuum_min_freelist_pages
    )

    size_before = _db_file_size_bytes()
    result: dict[str, Any] = {
        "size_before_bytes": size_before,
        "wal_checkpoint": None,
        "vacuum": {"ran": False},
        "analyze": False,
        "errors": [],
    }

    raw = eng.raw_connection()
    try:
        # The shared engine binds connections with check_same_thread=False and the
        # WAL/busy_timeout PRAGMAs; use the DBAPI connection in autocommit so
        # VACUUM (which forbids an open transaction) can run.
        try:
            raw.isolation_level = None  # autocommit (no implicit BEGIN)
        except Exception:  # pragma: no cover - some drivers ignore this
            pass
        cur = raw.cursor()
        try:
            # (1) WAL TRUNCATE checkpoint.
            try:
                row = cur.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
                # (busy, log_frames, checkpointed_frames)
                result["wal_checkpoint"] = {
                    "busy": row[0] if row else None,
                    "log_frames": row[1] if row else None,
                    "checkpointed_frames": row[2] if row else None,
                }
            except Exception as exc:  # noqa: BLE001
                result["errors"].append(f"wal_checkpoint:{exc}")

            # (2) conditional VACUUM based on the free-list ratio.
            try:
                page_count = cur.execute("PRAGMA page_count").fetchone()[0] or 0
                freelist = cur.execute("PRAGMA freelist_count").fetchone()[0] or 0
                page_count = int(page_count)
                freelist = int(freelist)
                free_ratio = (freelist / page_count) if page_count else 0.0
                should_vacuum = (
                    ratio > 0
                    and freelist >= int(min_pages)
                    and free_ratio >= ratio
                )
                result["vacuum"] = {
                    "ran": False,
                    "page_count": page_count,
                    "freelist_count": freelist,
                    "freelist_ratio": round(free_ratio, 4),
                    "threshold_ratio": ratio,
                    "min_freelist_pages": int(min_pages),
                }
                if should_vacuum:
                    cur.execute("VACUUM")
                    result["vacuum"]["ran"] = True
            except Exception as exc:  # noqa: BLE001
                result["errors"].append(f"vacuum:{exc}")

            # (3) ANALYZE — refresh planner stats (cheap, always).
            try:
                cur.execute("ANALYZE")
                result["analyze"] = True
            except Exception as exc:  # noqa: BLE001
                result["errors"].append(f"analyze:{exc}")
        finally:
            cur.close()
    finally:
        raw.close()

    size_after = _db_file_size_bytes()
    result["size_after_bytes"] = size_after
    # Clamp at 0: a concurrent write that grew the file mid-maintenance must not
    # report a negative reclaim.
    result["reclaimed_bytes"] = max(0, size_before - size_after)
    result["ok"] = not result["errors"]
    return result


@contextmanager
def atomic_batch(session: Session) -> Iterator[Session]:
    """BA5 — all-or-nothing batch write on an existing ``session``.

    Wraps a multi-row write so it commits as ONE unit: open a transaction
    (a SAVEPOINT via ``begin_nested`` so it composes with any outer
    transaction the same way ``import_dataset``/``bank_export`` do), yield the
    session for the caller's writes, then commit on a clean exit. On ANY
    exception the partial work is rolled back and the original exception is
    re-raised — so a per-row loop that used to ``commit()`` each row (leaving a
    half-written set if a later row blew up) instead lands wholly or not at all.

    Usage::

        with atomic_batch(session):
            for row in rows:
                session.add(row)
        # every row is durable here, or none of them are
    """
    try:
        with session.begin_nested():
            yield session
    except Exception:
        session.rollback()
        raise
    session.commit()
