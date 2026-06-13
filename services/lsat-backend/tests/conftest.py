"""Shared pytest fixtures. Points the app at a temp SQLite DB and seeds it.

The DB env var is set BEFORE any `app.*` import so the engine in app.db binds to
the throwaway file. We reset by dropping/recreating tables on the shared engine
(rather than deleting the file) to avoid Windows file-lock issues.
"""
from __future__ import annotations

import os
import tempfile

import pytest

# Set env before app modules import config/db.
_TMP_DB = os.path.join(tempfile.gettempdir(), "lsatlab_test.db")
os.environ["LSATLAB_DB"] = _TMP_DB
# Never run the background generation worker in tests: queued jobs must not
# auto-invoke the model. Tests call generation.run_job directly when needed.
os.environ["LSATLAB_JOBS_WORKER"] = "0"
# The production/dev default is strict FK enforcement. The legacy test fixtures
# still use some loose insertion/reset ordering, so tests opt out explicitly.
os.environ["LSATLAB_SQLITE_FK"] = "0"
# Don't auto-diagnose error-log saves in tests (would call the model).
os.environ["LSATLAB_ERRORLOG_AUTODIAGNOSE"] = "0"
# Keep DB snapshots out of the repo dir during tests (D4).
os.environ["LSATLAB_BACKUP_DIR"] = os.path.join(
    tempfile.gettempdir(), "lsatlab_test_backups"
)
# Bank-expansion plan Wave 2.1 / 2.2 — the permutation-invariant SC and
# Säuberli-style informativity gates require a real solver. Most unit tests
# use dumb "return-credited-letter" stubs that would be falsely flagged as
# positionally biased. Default both gates OFF in the test suite; specific
# tests that exercise them flip the config flags via monkeypatch.
os.environ.setdefault("LSATLAB_GEN_PERMUTATION_SC", "0")
os.environ.setdefault("LSATLAB_GEN_INFORMATIVITY_CHECK", "0")
os.environ.setdefault("LSATLAB_GEN_DISTRACTOR_QUALITY_CHECK", "0")
os.environ.setdefault("LSATLAB_GEN_MULTI_MODEL_AGREEMENT", "0")
os.environ.setdefault("LSATLAB_IMPORT_EMBED_ON_COMMIT", "0")


def _reset_and_seed():
    from sqlmodel import SQLModel

    from app import embeddings
    from app import seed as seed_mod
    from app.db import engine, init_db
    from app import models  # noqa: F401  (register tables)

    SQLModel.metadata.drop_all(engine)
    # Drop bookkeeping tables that SQLModel.metadata doesn't know about, so a
    # reset is truly fresh: otherwise recorded migrations skip re-creating the
    # indexes/objects that drop_all just removed.
    with engine.begin() as conn:
        conn.exec_driver_sql("DROP TABLE IF EXISTS schema_migrations")
    init_db()
    embeddings.reset_cache()  # P3: drop the process-global vector cache on reset
    seed_mod.seed(reset=False)


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    _reset_and_seed()
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def db_session():
    from sqlmodel import Session

    from app.db import engine

    _reset_and_seed()
    with Session(engine) as s:
        yield s


@pytest.fixture(autouse=True)
def _restore_config():
    """Snapshot/restore the process-global ``config`` attributes that the settings
    store mutates LIVE (the ``_OVERRIDABLE`` targets), around every test.

    ``monkeypatch`` already auto-restores monkeypatched config, but the HTTP-route
    settings tests change config via ``PUT /api/settings`` -> ``setattr(config, …)``
    and restore by hand; a mid-test failure (or a forgotten restore) would then
    leak a mutated model / provider / retention into later tests. This is the
    safety net so isolation never rests on per-test discipline.
    """
    from app import config
    from app.settings_store import _OVERRIDABLE

    saved = {attr: getattr(config, attr) for attr in set(_OVERRIDABLE.values())}
    try:
        yield
    finally:
        for attr, val in saved.items():
            setattr(config, attr, val)
