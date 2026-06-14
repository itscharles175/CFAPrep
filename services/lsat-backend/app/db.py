"""Database engine + session helpers."""
from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import event
from sqlmodel import Session, SQLModel, create_engine

from . import config

# check_same_thread=False so the engine works across FastAPI's threadpool.
engine = create_engine(
    config.DB_URL,
    echo=False,
    connect_args={"check_same_thread": False},
)


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
