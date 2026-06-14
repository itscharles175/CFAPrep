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
