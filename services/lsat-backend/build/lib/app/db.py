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


# Additive columns SQLModel.create_all() will NOT add to a pre-existing table.
# Kept as raw ALTER TABLE so we don't have to introduce Alembic for a single-user
# local DB. Each entry: (table, column_name, column_def_after_ADD_COLUMN).
_ADDITIVE_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("question", "external_id", "external_id VARCHAR"),
    ("question", "content_hash", "content_hash VARCHAR"),
    ("question", "tag_confidence", "tag_confidence VARCHAR"),
    ("question", "deleted_at", "deleted_at DATETIME"),  # D5 soft-delete
    ("genjob", "parent_question_id", "parent_question_id INTEGER"),
    # --- R7 additive columns (every new column on a PRE-EXISTING table must be
    # listed here, or an upgraded real DB will lack it even though tests pass via
    # create_all). New *tables* need no entry — create_all handles them. ---
    ("preptest", "scale_table_json", "scale_table_json TEXT"),          # 3.5
    ("question", "updated_at", "updated_at DATETIME"),                  # 5.4
    ("question", "empirical_difficulty", "empirical_difficulty FLOAT"),  # 2.8
    ("genjob", "priority", "priority INTEGER DEFAULT 0"),               # Tutor OS scheduler
    ("genjob", "progress_pct", "progress_pct FLOAT DEFAULT 0"),         # Tutor OS scheduler
    ("genjob", "retry_count", "retry_count INTEGER DEFAULT 0"),         # Tutor OS scheduler
    ("genjob", "max_retries", "max_retries INTEGER DEFAULT 0"),         # Tutor OS scheduler
    ("genjob", "updated_at", "updated_at DATETIME"),                    # Tutor OS scheduler
    ("genjob", "cancelled_at", "cancelled_at DATETIME"),                # Tutor OS scheduler
    ("explanation", "model_used", "model_used VARCHAR"),               # 2.6
    ("explanation", "confidence", "confidence VARCHAR"),               # 2.6
    ("explanation", "answer_checked", "answer_checked BOOLEAN DEFAULT 0"),  # 2.6
    ("attempt", "client_attempt_id", "client_attempt_id VARCHAR"),     # 5.2
    ("srscard", "origin", "origin VARCHAR"),                           # 1.1
    ("srscard", "leech", "leech BOOLEAN DEFAULT 0"),                   # 3.2
    ("srscard", "last_reviewed", "last_reviewed DATETIME"),            # 3.2
    ("parsejob", "import_run_id", "import_run_id INTEGER"),            # P1 ledger
)

# Indexes we want even for pre-existing databases.
_ADDITIVE_INDEXES: tuple[tuple[str, str, str], ...] = (
    ("ix_question_external_id", "question", "external_id"),
    ("ix_question_content_hash", "question", "content_hash"),
)


def _apply_additive_migrations() -> None:
    with engine.begin() as conn:
        for table, column, ddl in _ADDITIVE_COLUMNS:
            existing = {
                row[1]
                for row in conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
            }
            if column not in existing:
                conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {ddl}")
        for index_name, table, column in _ADDITIVE_INDEXES:
            conn.exec_driver_sql(
                f"CREATE INDEX IF NOT EXISTS {index_name} ON {table} ({column})"
            )


def _check_additive_coverage() -> None:
    """B8: in dev mode, warn if any _ADDITIVE_COLUMNS entry lacks a migration.

    This is a soft assertion only — it never raises — so it can't break startup.
    The two lists (_ADDITIVE_COLUMNS and MIGRATIONS) serve different concerns:
    _ADDITIVE_COLUMNS handles ALTER TABLE for live upgrades of pre-existing DBs;
    MIGRATIONS handles non-additive DDL (indexes, backfills, triggers).
    TODO(B8): consolidate the two lists in 1.0 by migrating all additive columns
    into recorded migrations so init_db only calls run_migrations.
    """
    import logging as _lg
    import os

    if os.environ.get("LSATLAB_DEV", "0") not in ("1", "true", "True"):
        return
    from .migrations import MIGRATIONS

    migration_sql = " ".join(
        fn.__doc__ or "" for _, _, fn in MIGRATIONS
    ).lower()
    log = _lg.getLogger("lsatlab.db")
    for table, column, _ddl in _ADDITIVE_COLUMNS:
        if column not in migration_sql:
            log.warning(
                "B8: additive column %s.%s has no corresponding migration entry",
                table, column,
            )


def init_db() -> None:
    """Create all tables. Importing models registers them on SQLModel.metadata."""
    from . import models  # noqa: F401  (ensures tables are registered)
    from .migrations import run_migrations

    SQLModel.metadata.create_all(engine)
    _apply_additive_migrations()
    # Ordered, recorded migrations for non-additive changes (indexes, backfills).
    run_migrations(engine)
    _check_additive_coverage()


def get_session() -> Iterator[Session]:
    """FastAPI dependency yielding a DB session."""
    with Session(engine) as session:
        yield session
