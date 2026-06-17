"""DATA-5 — unified {host, lsat} export/backup.

Covers:
  - migration 28 records ``export_history`` in ``schema_migrations`` and bumps
    ``PRAGMA user_version`` to >= 28 (PRAGMA-guarded, idempotent), and creates the
    UNIQUE ``ux_exporthistory_export_id`` index.
  - round-trip: build a unified envelope, import it back, and confirm the import
    is idempotent (re-importing the same envelope adds no duplicate questions).
  - the provenance firewall: an envelope whose LSAT payload carries OFFICIAL
    content is rejected by both validate_envelope and the /import route (400).
  - an ExportHistory row is written on build, and restore_count increments on each
    import of the same exportId.
  - OpenAPI exposes the /api/export/* routes.
"""
from __future__ import annotations

from sqlmodel import Session, select


# --- migration 28 -----------------------------------------------------------
def test_migration_28_recorded_and_user_version(db_session):
    from app.db import engine

    with engine.begin() as conn:
        rows = conn.exec_driver_sql(
            "SELECT name FROM schema_migrations WHERE version = 28"
        ).fetchall()
        assert rows and rows[0][0] == "export_history"
        user_version = conn.exec_driver_sql("PRAGMA user_version").fetchone()[0]
        assert int(user_version) >= 28


def test_migration_28_creates_unique_index(db_session):
    from app.db import engine

    with engine.begin() as conn:
        rows = conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='index'"
        ).fetchall()
    names = {r[0] for r in rows}
    assert "ux_exporthistory_export_id" in names


def test_migration_28_is_idempotent(db_session):
    from app import migrations
    from app.db import engine

    # Re-running the whole ledger applies nothing new (28 already recorded).
    applied = migrations.run_migrations(engine)
    assert applied == 0
    # Re-running just the m028 fn by hand is also a clean no-op (IF NOT EXISTS).
    with engine.begin() as conn:
        migrations._m028_export_history(conn)
        rows = conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='index' "
            "AND name='ux_exporthistory_export_id'"
        ).fetchall()
    assert rows


# --- build / round-trip -----------------------------------------------------
def test_build_unified_export_envelope_shape(db_session):
    from app import export_backup

    env = export_backup.build_unified_export(db_session)
    for key in ("exportId", "exportedAt", "schemaVersion", "format",
                "sourceHost", "rowCounts", "checksum", "data"):
        assert key in env, f"missing envelope field {key}"
    assert env["format"] == export_backup.FORMAT
    assert env["schemaVersion"] == export_backup.SCHEMA_VERSION
    assert env["sourceHost"] is True
    assert isinstance(env["data"], dict)
    # The checksum must verify against the canonical payload.
    assert export_backup.compute_checksum(env) == env["checksum"]


def test_build_includes_host_data_and_host_schema_version(db_session):
    from app import export_backup

    host = {"app": "QuantVault", "schemaVersion": 11, "stores": {"x": [1]}}
    env = export_backup.build_unified_export(db_session, host_data=host)
    assert env["hostData"] == host
    assert env["hostSchemaVersion"] == 11
    assert env["rowCounts"].get("host_present") == 1
    assert export_backup.compute_checksum(env) == env["checksum"]


def test_validate_envelope_ok(db_session):
    from app import export_backup

    env = export_backup.build_unified_export(db_session)
    result = export_backup.validate_envelope(env)
    assert result["ok"] is True
    assert result["errors"] == []


def test_validate_envelope_detects_checksum_mismatch(db_session):
    from app import export_backup

    env = export_backup.build_unified_export(db_session)
    env["checksum"] = "sha256:deadbeef"
    result = export_backup.validate_envelope(env)
    assert result["ok"] is False
    assert any("checksum" in e for e in result["errors"])


def test_validate_envelope_rejects_newer_schema(db_session):
    from app import export_backup

    env = export_backup.build_unified_export(db_session)
    env["schemaVersion"] = export_backup.SCHEMA_VERSION + 5
    env["checksum"] = export_backup.compute_checksum(env)  # keep checksum valid
    result = export_backup.validate_envelope(env)
    assert result["ok"] is False
    assert any("newer" in e for e in result["errors"])


def test_round_trip_import_is_idempotent(db_session):
    """A KEYED question (stable external_id + content_hash) survives the unified
    round-trip without duplicating — import_bank dedups by those keys (seed rows
    without keys are re-created, which is the documented bank_export behavior, so
    we measure idempotency on a row we control)."""
    from app import export_backup
    from app.models import Question, QuestionSource

    db_session.add(Question(
        stem="DATA5 keyed stem", prompt="p", correct_answer="A", difficulty=3,
        q_type="Inference", source=QuestionSource.sample,
        external_id="data5:keyed-1", content_hash="data5-keyed-hash-1",
    ))
    db_session.commit()

    def _keyed_count() -> int:
        return len(db_session.exec(
            select(Question).where(Question.external_id == "data5:keyed-1")
        ).all())

    assert _keyed_count() == 1

    env = export_backup.build_unified_export(db_session)
    r1 = export_backup.import_unified_export(db_session, env)
    assert r1["ok"] is True
    assert _keyed_count() == 1  # re-anchored, not duplicated

    r2 = export_backup.import_unified_export(db_session, env)
    assert _keyed_count() == 1  # still exactly one after a second import
    # restore_count climbs on every import of the same exportId.
    assert r2["restore_count"] == r1["restore_count"] + 1


# --- firewall ---------------------------------------------------------------
def _official_envelope(export_backup):
    """A hand-crafted envelope smuggling an official question, checksum valid."""
    env = {
        "exportId": "sv-evil-1",
        "exportedAt": "2026-06-17T00:00:00+00:00",
        "schemaVersion": export_backup.SCHEMA_VERSION,
        "format": export_backup.FORMAT,
        "sourceHost": False,
        "rowCounts": {},
        "data": {
            "schema_version": 2,
            "preptests": [
                {
                    "name": "Smuggled Official PT",
                    "is_official": False,
                    "sections": [
                        {
                            "type": "LR",
                            "order": 0,
                            "passages": [],
                            "questions": [
                                {
                                    "stem": "official stem",
                                    "prompt": "official prompt",
                                    "correct_answer": "A",
                                    "difficulty": 3,
                                    "q_type": "Inference",
                                    "source": "official",
                                    "choices": [],
                                }
                            ],
                        }
                    ],
                }
            ],
        },
    }
    env["checksum"] = export_backup.compute_checksum(env)
    return env


def test_validate_rejects_official_content(db_session):
    from app import export_backup

    env = _official_envelope(export_backup)
    result = export_backup.validate_envelope(env)
    assert result["ok"] is False
    assert any("official" in e for e in result["errors"])


def test_import_official_content_raises(db_session):
    import pytest

    from app import export_backup

    env = _official_envelope(export_backup)
    with pytest.raises(ValueError):
        export_backup.import_unified_export(db_session, env)


def test_export_never_emits_official_content(db_session):
    """End-to-end firewall: even with an official PrepTest seeded, the unified
    envelope must carry no official content."""
    from app import export_backup
    from app.models import PrepTest, QuestionSource, Question, Section, SectionType

    # Seed an official PrepTest + an official question on it.
    pt = PrepTest(name="OfficialPT-DATA5", source="official", is_official=True)
    db_session.add(pt)
    db_session.flush()
    sec = Section(preptest_id=pt.id, type=SectionType.LR, order=0,
                  time_limit_sec=2100)
    db_session.add(sec)
    db_session.flush()
    q = Question(
        section_id=sec.id, stem="OFFICIAL SECRET STEM", prompt="p",
        correct_answer="A", difficulty=3, q_type="Inference",
        source=QuestionSource.official, external_id="off-data5-1",
    )
    db_session.add(q)
    db_session.commit()

    env = export_backup.build_unified_export(db_session)
    assert export_backup._bank_carries_official(env["data"]) is False
    # The secret stem text must not appear anywhere in the artifact.
    import json as _json
    assert "OFFICIAL SECRET STEM" not in _json.dumps(env)


# --- ExportHistory provenance ----------------------------------------------
def test_build_writes_export_history_row(db_session):
    from app import export_backup
    from app.models import ExportHistory

    env = export_backup.build_unified_export(db_session)
    row = db_session.exec(
        select(ExportHistory).where(ExportHistory.export_id == env["exportId"])
    ).first()
    assert row is not None
    assert row.source_host is True
    assert row.checksum == env["checksum"]
    assert row.restore_count == 0
    assert row.last_restored is None


def test_restore_count_increments_on_import(db_session):
    from app import export_backup
    from app.models import ExportHistory

    env = export_backup.build_unified_export(db_session)
    export_backup.import_unified_export(db_session, env)
    export_backup.import_unified_export(db_session, env)

    db_session.expire_all()
    row = db_session.exec(
        select(ExportHistory).where(ExportHistory.export_id == env["exportId"])
    ).first()
    assert row is not None
    assert row.restore_count == 2
    assert row.last_restored is not None


# --- HTTP routes + OpenAPI --------------------------------------------------
def test_export_routes_round_trip_via_http(client):
    # Build
    r = client.post("/api/export/backup", json={"include_history": True})
    assert r.status_code == 200, r.text
    env = r.json()
    export_id = env["exportId"]

    # Validate
    rv = client.post("/api/export/validate", json={"envelope": env})
    assert rv.status_code == 200
    assert rv.json()["ok"] is True

    # Import
    ri = client.post("/api/export/import", json={"envelope": env})
    assert ri.status_code == 200, ri.text
    assert ri.json()["ok"] is True
    assert ri.json()["restore_count"] >= 1

    # History detail
    rh = client.get(f"/api/export/history?export_id={export_id}")
    assert rh.status_code == 200
    assert rh.json()["export_id"] == export_id

    # List
    rl = client.get("/api/export/list")
    assert rl.status_code == 200
    body = rl.json()
    assert body["total"] >= 1
    assert any(it["export_id"] == export_id for it in body["items"])


def test_import_official_via_http_is_400(client):
    from app import export_backup

    env = _official_envelope(export_backup)
    r = client.post("/api/export/import", json={"envelope": env})
    assert r.status_code == 400
    assert r.json()["code"] == "invalid_export_envelope"


def test_export_history_unknown_id_is_404(client):
    r = client.get("/api/export/history?export_id=does-not-exist")
    assert r.status_code == 404


def test_export_routes_in_openapi(client):
    spec = client.get("/openapi.json").json()
    paths = spec["paths"]
    for route in ("/api/export/backup", "/api/export/import",
                  "/api/export/validate", "/api/export/list",
                  "/api/export/history"):
        assert route in paths, f"{route} missing from OpenAPI schema"
    op = paths["/api/export/backup"]["post"]
    assert op["responses"]["200"]["content"]["application/json"].get("schema")
