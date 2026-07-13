"""Shared pytest fixtures. Points the app at a temp SQLite DB and seeds it.

The DB env var is set BEFORE any `app.*` import so the engine in app.db binds to
the throwaway file. We reset by dropping/recreating tables on the shared engine
(rather than deleting the file) to avoid Windows file-lock issues.
"""
from __future__ import annotations

import atexit
import contextlib
import os
import shutil
import tempfile

import pytest

# Set env before app modules import config/db.
# Per-PROCESS DB + backup dir so concurrent pytest interpreters (e.g. parallel
# swarm agents, or two suites launched at once) never share the one SQLite file.
# A shared fixed path was the source of transient "no such table" / SQLITE_BUSY
# failures when two suites ran simultaneously: both bound app.db's engine to the
# same file and one's drop_all/init_db raced the other's queries. Keying on the
# pid gives each interpreter its OWN throwaway file; a single serial run is
# unchanged (one pid, one file). The seed subprocess + seeded_sidecar_db fixture
# already use their own tmp_path files, so only this engine-bound path matters.
_PID = os.getpid()
_TMP_DB = os.path.join(tempfile.gettempdir(), f"lsatlab_test_{_PID}.db")
os.environ["LSATLAB_DB"] = _TMP_DB
# Never run the background generation worker in tests: queued jobs must not
# auto-invoke the model. Tests call generation.run_job directly when needed.
os.environ["LSATLAB_JOBS_WORKER"] = "0"
# The production/dev default is strict FK enforcement. The legacy test fixtures
# still use some loose insertion/reset ordering, so tests opt out explicitly.
os.environ["LSATLAB_SQLITE_FK"] = "0"
# Don't auto-diagnose error-log saves in tests (would call the model).
os.environ["LSATLAB_ERRORLOG_AUTODIAGNOSE"] = "0"
# Keep DB snapshots out of the repo dir during tests (D4). Per-PID for the same
# concurrency-isolation reason as the DB above.
os.environ["LSATLAB_BACKUP_DIR"] = os.path.join(
    tempfile.gettempdir(), f"lsatlab_test_backups_{_PID}"
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
# Hermetic model probes. The diagnostics/trust endpoints run a LIVE provider probe
# (doctor.build_report -> ai.health -> provider.list_models). On a dev machine
# where Ollama/LM Studio is actually running, that probe connects to the real
# server and can BLOCK the request thread for tens of seconds, hanging the whole
# suite (e.g. test_release_trust_manifest_and_diagnostics). Point both local
# providers at a closed port and drop retry/backoff so the probe fails FAST with
# connection-refused — identical to CI, where no provider runs. setdefault so the
# few opt-in real-provider tests (which set these explicitly) still win.
os.environ.setdefault("LSATLAB_OLLAMA_URL", "http://127.0.0.1:1")
os.environ.setdefault("LSATLAB_LMSTUDIO_URL", "http://127.0.0.1:1/v1")
os.environ.setdefault("LSATLAB_LLM_RETRIES", "0")


@atexit.register
def _cleanup_tmp_db() -> None:
    """Best-effort removal of this process's throwaway DB + backup dir at exit.

    Per-PID paths would otherwise accumulate in the temp dir across many runs.
    Never raises (the interpreter is already exiting); the engine still holds the
    file on Windows in rare cases, so missing/locked files are ignored."""
    for suffix in ("", "-wal", "-shm"):
        with contextlib.suppress(OSError):
            os.remove(_TMP_DB + suffix)
    shutil.rmtree(os.environ.get("LSATLAB_BACKUP_DIR", ""), ignore_errors=True)


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


class _QueryCounter:
    """Counts SQL statements executed on the shared engine within a ``with``
    block. BC3 query-budget gate: wrap a request/call to assert it stays under a
    sane number of round-trips, so a re-introduced N+1 loop fails CI.

    Usage::

        with count_queries() as counter:
            client.get("/api/preptests")
        assert counter.count <= 6
        # counter.statements holds the captured SQL text for debugging
    """

    def __init__(self, engine):
        self._engine = engine
        self.count = 0
        self.statements: list[str] = []

    def _before_cursor_execute(self, _conn, _cursor, statement, _params,
                               _context, _executemany):
        self.count += 1
        self.statements.append(statement)

    @contextlib.contextmanager
    def measure(self):
        from sqlalchemy import event

        self.count = 0
        self.statements = []
        event.listen(self._engine, "before_cursor_execute",
                     self._before_cursor_execute)
        try:
            yield self
        finally:
            event.remove(self._engine, "before_cursor_execute",
                         self._before_cursor_execute)


@pytest.fixture()
def count_queries():
    """Pytest helper that counts SQL queries issued on the app engine per block.

    Returns a context-manager factory. Each ``with count_queries() as c:`` block
    resets and tallies every statement the shared engine executes inside it via
    SQLAlchemy's ``before_cursor_execute`` event; read ``c.count`` (and
    ``c.statements``) after the block.
    """
    from app.db import engine

    counter = _QueryCounter(engine)
    return counter.measure


def seed_test_db(db_path: str) -> dict:
    """Seed a fresh, file-backed SQLite DB at ``db_path`` exactly the way a real
    sidecar boot does, in an isolated subprocess, and return its summary.

    Reusable by both the ``seeded_sidecar_db`` fixture below and the QA-2 e2e
    harness (``scripts/e2e-integration.mjs`` shells out to a tiny equivalent). The
    seed runs in a CHILD interpreter with ``LSATLAB_DB`` pointed at ``db_path`` so
    it binds ``app.db``'s engine to the throwaway file from the start — this keeps
    the in-process shared engine (which the ``client`` / ``db_session`` fixtures
    reset and rely on) completely untouched, regardless of import order.

    The child runs ``app.seed.seed(reset=True)`` then counts the **due** SRS cards
    and the seeded PrepTest id, printing a one-line JSON summary on stdout. The
    seed creates SRS cards with ``due_date = now - 1h`` (see ``app/seed.py``), so a
    sidecar booted against the resulting file answers ``GET /api/srs/due`` with a
    non-empty queue immediately — what the Review-Inbox bridge needs to populate.

    Returns a dict ``{"path", "due_count", "preptest_id"}``. Raises with the
    child's captured output if seeding fails, so callers get an actionable error.
    """
    import json
    import subprocess
    import sys

    child = (
        "import json, os\n"
        "from datetime import datetime, timezone\n"
        "from sqlmodel import Session, select\n"
        "from app import seed as seed_mod\n"
        "from app.db import engine\n"
        "from app.models import PrepTest, SRSCard\n"
        "seed_mod.seed(reset=True)\n"
        "now = datetime.now(timezone.utc)\n"
        "due = 0\n"
        "with Session(engine) as s:\n"
        "    for c in s.exec(select(SRSCard)).all():\n"
        "        d = c.due_date\n"
        "        if d.tzinfo is None:\n"
        "            d = d.replace(tzinfo=timezone.utc)\n"
        "        if d <= now:\n"
        "            due += 1\n"
        "    pt = s.exec(select(PrepTest)).first()\n"
        "    pid = pt.id if pt is not None else None\n"
        "print(json.dumps({'due_count': due, 'preptest_id': pid}))\n"
    )
    env = dict(os.environ)
    env["LSATLAB_DB"] = db_path
    # Mirror the hermetic test env: never start the worker / auto-diagnose, and
    # keep model probes pointed at a closed port so the child never blocks.
    env.setdefault("LSATLAB_JOBS_WORKER", "0")
    env.setdefault("LSATLAB_ERRORLOG_AUTODIAGNOSE", "0")
    env.setdefault("LSATLAB_OLLAMA_URL", "http://127.0.0.1:1")
    env.setdefault("LSATLAB_LMSTUDIO_URL", "http://127.0.0.1:1/v1")
    env.setdefault("LSATLAB_LLM_RETRIES", "0")
    # Run from the backend root (parent of this tests/ dir) so ``app`` imports.
    backend_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    proc = subprocess.run(
        [sys.executable, "-c", child],
        cwd=backend_root,
        env=env,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"seed_test_db: seeding subprocess failed (exit {proc.returncode}).\n"
            f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}"
        )
    line = (proc.stdout.strip().splitlines() or [""])[-1]
    try:
        summary = json.loads(line)
    except json.JSONDecodeError as exc:  # pragma: no cover - defensive
        raise RuntimeError(
            f"seed_test_db: could not parse seed summary from child stdout: {line!r}\n"
            f"--- full stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}"
        ) from exc
    return {"path": db_path, **summary}


@pytest.fixture()
def seeded_sidecar_db(tmp_path_factory):
    """QA-2 — a freestanding, file-backed, seeded test DB others can reuse.

    Unlike the shared-engine ``client`` / ``db_session`` fixtures (which reset the
    *one* process-global engine bound to ``LSATLAB_DB``), this hands back a
    throwaway SQLite *file* on disk that has been migrated + seeded the same way a
    real sidecar boot would — without disturbing the shared engine the rest of the
    suite uses (the seed runs in a child interpreter; see ``seed_test_db``).

    Yields a dict with:
      * ``path``        — absolute path to the seeded SQLite file (str),
      * ``due_count``   — number of due SRS cards seeded (int, >= 1),
      * ``preptest_id`` — the seeded sample PrepTest id (int).

    Intended for the cross-domain e2e + integration harness (QA-2) and any future
    test that needs to launch the actual sidecar process against a known DB with a
    non-empty ``GET /api/srs/due`` queue.
    """
    db_file = tmp_path_factory.mktemp("seeded-sidecar") / "lsatlab_e2e.db"
    return seed_test_db(str(db_file))


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
