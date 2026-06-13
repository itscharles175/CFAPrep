"""D4 — local DB snapshots + integrity check + restore."""
from __future__ import annotations

import sqlite3

import pytest

from app import backup


def _make_db(path, rows):
    con = sqlite3.connect(str(path))
    con.execute("CREATE TABLE t (x INTEGER)")
    con.executemany("INSERT INTO t VALUES (?)", [(r,) for r in rows])
    con.commit()
    con.close()


def _count(path) -> int:
    con = sqlite3.connect(str(path))
    try:
        return con.execute("SELECT count(*) FROM t").fetchone()[0]
    finally:
        con.close()


def test_create_list_integrity(tmp_path):
    db = tmp_path / "live.db"
    _make_db(db, [1, 2, 3])
    bdir = tmp_path / "b"
    snap = backup.create_backup(db_path=db, backup_dir=bdir)
    assert snap.exists()
    manifest = backup.read_backup_manifest(snap)
    assert manifest is not None
    assert manifest["manifest_version"] == 1
    assert manifest["snapshot"]["name"] == snap.name
    assert manifest["snapshot"]["sha256"]
    assert manifest["row_counts"] == {"t": 3}
    assert manifest["official_content_policy"]["snapshot_type"] == "full_local_sqlite_backup"
    assert manifest["official_content_policy"]["official_content_may_leave_machine"] is False
    assert backup.integrity_check(db) == "ok"
    listed = backup.list_backups(bdir)
    assert len(listed) == 1
    assert listed[0]["name"] == snap.name
    assert listed[0]["size_bytes"] > 0
    assert listed[0]["manifest"]["snapshot"]["name"] == snap.name


def test_foreign_key_check_reports_violations(tmp_path):
    db = tmp_path / "fk.db"
    con = sqlite3.connect(str(db))
    try:
        con.execute("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
        con.execute(
            "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER "
            "REFERENCES parent(id))"
        )
        con.execute("INSERT INTO child (id, parent_id) VALUES (1, 404)")
        con.commit()
    finally:
        con.close()

    report = backup.foreign_key_check(db)
    assert report["available"] is True
    assert report["ok"] is False
    assert report["violations"] == 1
    assert report["sample"][0]["table"] == "child"
    assert report["sample"][0]["parent"] == "parent"


def test_restore_rolls_back_and_keeps_safety_copy(tmp_path):
    db = tmp_path / "live.db"
    _make_db(db, [1, 2, 3])
    bdir = tmp_path / "b"
    snap = backup.create_backup(db_path=db, backup_dir=bdir)

    con = sqlite3.connect(str(db))
    con.execute("INSERT INTO t VALUES (99)")
    con.commit()
    con.close()
    assert _count(db) == 4

    backup.restore_backup(snap.name, db_path=db, backup_dir=bdir)
    assert _count(db) == 3  # rolled back to the snapshot
    # a pre-restore safety snapshot of the (mutated) DB was taken first
    assert any("prerestore" in b["name"] for b in backup.list_backups(bdir))


def test_restore_rejects_traversal(tmp_path):
    db = tmp_path / "live.db"
    _make_db(db, [1])
    with pytest.raises(ValueError):
        backup.restore_backup("../evil.db", db_path=db, backup_dir=tmp_path / "b")


def test_restore_rejects_corrupt_snapshot(tmp_path):
    db = tmp_path / "live.db"
    _make_db(db, [1])
    bdir = tmp_path / "b"
    bdir.mkdir()
    bad = bdir / "lsatlab-corrupt.db"
    bad.write_text("not sqlite", encoding="utf-8")

    with pytest.raises(ValueError, match="integrity"):
        backup.restore_backup(bad.name, db_path=db, backup_dir=bdir)


def test_prune_keeps_newest(tmp_path):
    db = tmp_path / "live.db"
    _make_db(db, [1])
    bdir = tmp_path / "b"
    for _ in range(8):
        backup.create_backup(db_path=db, backup_dir=bdir, keep=3)
    assert len(backup.list_backups(bdir)) <= 3


def test_orphan_report_covers_generation_and_learning_edges(db_session):
    from app.models import (
        ExplanationFeedback,
        GenCandidate,
        GenJob,
        GenStatus,
        Question,
        QuestionSource,
        Reflection,
    )

    db_session.add(Question(
        stem="child",
        prompt="p",
        correct_answer="A",
        q_type="Inference",
        source=QuestionSource.sample,
        parent_question_id=999_001,
    ))
    db_session.add(GenJob(
        status=GenStatus.queued,
        q_type="Flaw",
        count=1,
        parent_question_id=999_002,
    ))
    db_session.add(GenCandidate(
        gen_job_id=999_003,
        question_id=999_004,
        candidate_index=0,
        verdict="quarantined",
    ))
    db_session.add(Reflection(session_id=999_005, text="dangling"))
    db_session.add(ExplanationFeedback(question_id=999_006, helpful=False))
    db_session.commit()

    rel = backup.orphan_report()["by_relationship"]
    assert rel["question_parent"] == 1
    assert rel["genjob_parent_question"] == 1
    assert rel["gencandidate_gen_job"] == 1
    assert rel["gencandidate_question"] == 1
    assert rel["reflection_session"] == 1
    assert rel["explanationfeedback_question"] == 1


def test_integrity_report_includes_catalog_and_backup_status(db_session):
    snap = backup.create_backup(label="readiness")

    report = backup.integrity_report()
    assert report["integrity_check"] == {"result": "ok", "ok": True}
    assert report["foreign_key_check"]["ok"] is True
    assert report["orphans"]["total"] == 0
    assert report["schema"]["ok"] is True
    assert report["migrations"]["ok"] is True
    assert report["indexes"]["ok"] is True
    assert "ix_genjob_status" in report["indexes"]["present"]
    assert report["triggers"]["ok"] is True
    assert "trg_question_source_immutable" in report["triggers"]["present"]
    assert report["pragmas"]["ok"] is True
    assert "foreign_keys" in report["pragmas"]["actual"]
    assert report["backup"]["status"] == "fresh"
    assert report["backup"]["newest"]["name"] == snap.name
    assert report["db"]["exists"] is True
    assert report["db"]["connectable"] is True
    assert report["ready"] is True


def test_backup_endpoints(client):
    r = client.post("/api/backup/now")
    assert r.status_code == 200 and r.json()["created"]
    r = client.get("/api/backup/list")
    assert r.status_code == 200 and len(r.json()["backups"]) >= 1
    r = client.get("/api/backup/integrity")
    body = r.json()
    assert body["result"] == "ok"
    assert body["foreign_key_check"]["ok"] is True
    assert body["schema"]["ok"] is True
    assert body["migrations"]["ok"] is True
    assert body["indexes"]["ok"] is True
    assert body["triggers"]["ok"] is True
    assert body["pragmas"]["ok"] is True
    assert body["ready"] is True
    assert body["report"]["backup"]["status"] == "fresh"
    r = client.post("/api/backup/restore", json={"name": "does-not-exist.db"})
    assert r.status_code == 404
