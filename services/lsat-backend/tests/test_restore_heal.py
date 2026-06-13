"""B4b — restore safety: post-restore schema heal, restore race pause, distinct
restore status codes, and dedup-index readiness (Codex #7, #11; swarm #43, #45).

These reuse the test_backup.py patterns (raw sqlite helpers + the shared
``db_session``/``client`` fixtures)."""
from __future__ import annotations

import json
import sqlite3

import pytest

from app import backup, config


def _make_db(path, rows):
    con = sqlite3.connect(str(path))
    con.execute("CREATE TABLE t (x INTEGER)")
    con.executemany("INSERT INTO t VALUES (?)", [(r,) for r in rows])
    con.commit()
    con.close()


def _index_names(path) -> set[str]:
    con = sqlite3.connect(str(path))
    try:
        return {
            str(r[0])
            for r in con.execute(
                "SELECT name FROM sqlite_master WHERE type='index'"
            ).fetchall()
        }
    finally:
        con.close()


def _migration_versions(path) -> set[int]:
    con = sqlite3.connect(str(path))
    try:
        return {
            int(r[0])
            for r in con.execute("SELECT version FROM schema_migrations").fetchall()
        }
    finally:
        con.close()


# --- Task 1: post-restore schema heal (swarm #43 / Codex #7) ----------------
def test_restore_heals_schema_in_process(db_session):
    """Restoring an OLDER-schema snapshot re-runs init_db() so a missing,
    migration-created object is present again WITHOUT a manual restart."""
    live = config.DB_PATH
    bdir = config.BACKUP_DIR

    # A healthy current-schema snapshot of the live (reset+seeded) DB.
    snap = backup.create_backup(label="healtest")

    # Degrade the snapshot to look like it came from an older build: drop a
    # migration-created index and forget that the migration ever ran. The file
    # stays a valid SQLite DB so integrity/FK verification still passes.
    target_index = "ix_genjob_status_priority"  # created by migration 16
    assert target_index in _index_names(snap)
    con = sqlite3.connect(str(snap))
    try:
        con.execute(f"DROP INDEX IF EXISTS {target_index}")
        con.execute("DELETE FROM schema_migrations WHERE version >= 16")
        con.commit()
    finally:
        con.close()
    assert target_index not in _index_names(snap)

    backup.restore_backup(snap.name)

    # init_db() ran in-process: the dropped index is back and the migration
    # bookkeeping is repopulated on the live DB.
    assert target_index in _index_names(live)
    assert 16 in _migration_versions(live)


# --- Task 3: distinct status codes (Codex #7) -------------------------------
def test_restore_typed_exceptions(tmp_path):
    """The function raises a DISTINCT typed (ValueError-subclass) exception for
    an invalid name vs a missing snapshot vs a corrupt/integrity-failed backup."""
    db = tmp_path / "live.db"
    _make_db(db, [1])
    bdir = tmp_path / "b"
    bdir.mkdir()

    # Invalid name (path traversal).
    with pytest.raises(backup.InvalidBackupName):
        backup.restore_backup("../evil.db", db_path=db, backup_dir=bdir)

    # Missing snapshot (valid name, no file).
    with pytest.raises(backup.BackupNotFound):
        backup.restore_backup("lsatlab-missing.db", db_path=db, backup_dir=bdir)

    # Corrupt snapshot (exists but not a valid SQLite DB).
    bad = bdir / "lsatlab-corrupt.db"
    bad.write_text("not sqlite", encoding="utf-8")
    with pytest.raises(backup.BackupIntegrityError):
        backup.restore_backup(bad.name, db_path=db, backup_dir=bdir)

    # All three remain ValueError for legacy callers.
    for klass in (
        backup.InvalidBackupName,
        backup.BackupNotFound,
        backup.BackupIntegrityError,
        backup.IncompatibleBackup,
    ):
        assert issubclass(klass, ValueError)


def test_restore_route_maps_distinct_http_codes(client):
    # Invalid name -> 400.
    r = client.post("/api/backup/restore", json={"name": "../evil.db"})
    assert r.status_code == 400
    assert r.json()["code"] == "invalid_backup_name"

    # Missing snapshot (valid name) -> 404.
    r = client.post("/api/backup/restore", json={"name": "lsatlab-missing.db"})
    assert r.status_code == 404
    assert r.json()["code"] == "backup_not_found"

    # Corrupt/integrity-failed snapshot -> 409.
    bdir = config.BACKUP_DIR
    bdir.mkdir(parents=True, exist_ok=True)
    bad = bdir / "lsatlab-corrupt-route.db"
    bad.write_text("not sqlite", encoding="utf-8")
    r = client.post("/api/backup/restore", json={"name": bad.name})
    assert r.status_code == 409
    assert r.json()["code"] == "backup_integrity_failed"


# --- Task 1 (manifest guard): reject a NEWER-schema backup ------------------
def test_restore_rejects_newer_schema_backup(client):
    """A backup whose recorded schema is newer than this build maps to 409."""
    bdir = config.BACKUP_DIR
    snap = backup.create_backup(label="future")

    # Inflate the manifest's recorded schema version beyond what we can apply.
    manifest = backup.read_backup_manifest(snap)
    assert manifest is not None
    our_version = backup._latest_expected_schema_version()
    manifest["schema_version"] = (our_version or 0) + 100
    manifest_path = snap.with_suffix(snap.suffix + ".manifest.json")
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(backup.IncompatibleBackup):
        backup.restore_backup(snap.name)

    r = client.post("/api/backup/restore", json={"name": snap.name})
    assert r.status_code == 409
    assert r.json()["code"] == "incompatible_backup"


# --- Task 4: dedup-index readiness (Codex #11) ------------------------------
def test_dedup_index_report_flags_missing_guard(db_session):
    """When the m006 dedup UNIQUE indexes are absent the readiness probe says so
    and the integrity report raises a (non-fatal) warning."""
    from app.db import engine

    # Healthy: the guards exist after a normal init_db().
    healthy = backup.dedup_index_report()
    assert healthy["ok"] is True
    assert healthy["missing"] == []

    # Simulate the m006-skipped condition by dropping the guards.
    with engine.begin() as conn:
        conn.exec_driver_sql("DROP INDEX IF EXISTS ux_question_content_hash")
        conn.exec_driver_sql("DROP INDEX IF EXISTS ux_question_external_id")

    degraded = backup.dedup_index_report()
    assert degraded["ok"] is False
    assert "ux_question_content_hash" in degraded["missing"]
    assert "ux_question_external_id" in degraded["missing"]

    report = backup.integrity_report()
    assert report["dedup_indexes"]["ok"] is False
    assert "dedup_unique_indexes_missing" in report["warnings"]
    # Missing dedup guard is a WARNING, not a hard readiness error.
    assert "dedup_unique_indexes_missing" not in report["errors"]


def test_migrations_dedup_readiness_helper(db_session):
    """migrations.dedup_unique_indexes_missing reports the absent guards."""
    from app import migrations
    from app.db import engine

    with engine.begin() as conn:
        assert migrations.dedup_unique_indexes_missing(conn) == []
        conn.exec_driver_sql("DROP INDEX IF EXISTS ux_question_content_hash")
        missing = migrations.dedup_unique_indexes_missing(conn)
    assert "ux_question_content_hash" in missing


# --- restore fail-closed: surface worker-pause + schema-heal failures --------
# Hardening (Codex prod-readiness P1): the post-copy heal and the worker pause
# were best-effort/swallowed, so a restore could report a clean success while the
# DB was left unhealed or the copy raced the worker. These lock in fail-closed
# behaviour: abort before the overwrite if the worker can't be paused, and raise
# instead of returning success if the heal fails.
def _boom_init():
    raise RuntimeError("heal exploded")


def test_restore_raises_heal_error_when_init_db_fails(db_session, monkeypatch):
    """If the post-copy schema heal (init_db) fails, restore raises
    RestoreHealError instead of reporting a clean success. A pre-restore snapshot
    is still taken first, so nothing is lost."""
    from app import db as db_mod

    snap = backup.create_backup(label="healfail")
    monkeypatch.setattr(db_mod, "init_db", _boom_init)

    with pytest.raises(backup.RestoreHealError):
        backup.restore_backup(snap.name)
    # Stays a ValueError for legacy callers, and a pre-restore safety snapshot
    # was taken before the overwrite.
    assert issubclass(backup.RestoreHealError, ValueError)
    assert any("prerestore" in s["name"] for s in backup.list_backups())


def test_restore_route_maps_heal_failure_to_500(client, monkeypatch):
    """The /api/backup/restore route surfaces a heal failure as 500 with a
    restart_required flag — not a false 200 success."""
    from app import db as db_mod

    snap = backup.create_backup(label="healfail-route")
    monkeypatch.setattr(db_mod, "init_db", _boom_init)

    r = client.post("/api/backup/restore", json={"name": snap.name})
    assert r.status_code == 500
    assert r.json()["code"] == "restore_heal_incomplete"
    assert r.json()["detail"]["restart_required"] is True


def test_restore_aborts_before_overwrite_when_worker_stuck(db_session, monkeypatch):
    """Fail CLOSED: if the background worker can't be CONFIRMED paused, restore
    aborts BEFORE overwriting the live DB (no torn copy) and raises
    WorkerPauseError."""
    from app import jobs

    snap = backup.create_backup(label="pausefail")

    class _StuckThread:
        def is_alive(self):
            return True

    class _StuckWorker:
        _thread = _StuckThread()

        def stop(self, timeout: float = 5.0):
            pass  # never actually stops -> join "times out"

    monkeypatch.setattr(jobs, "get_worker", lambda: _StuckWorker())

    # WorkerPauseError is raised from the context manager's __enter__, so the
    # overwrite (the first statement inside `with _PausedWorker()`) is never
    # reached and the live DB is left untouched (fail-closed).
    with pytest.raises(backup.WorkerPauseError):
        backup.restore_backup(snap.name)
