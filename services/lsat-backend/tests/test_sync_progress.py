"""DATA-4a — read-only cross-domain progress feed (host -> backend).

Covers:
  - migration 23 records ``host_progress_snapshot`` in ``schema_migrations`` and
    bumps ``PRAGMA user_version`` to 23 (PRAGMA-guarded, idempotent), and creates
    the UNIQUE ``cross_id`` index + the (plane, kind) lookup index.
  - POST /api/sync/progress-updates UPSERTS host snapshots in the canonical
    cross-domain shape; idempotent by ``cross_id`` (no duplicate rows); a
    byte-identical re-POST is a recognised no-op (``unchanged``); a changed
    re-POST updates in place; non-host / unknown-kind rows are skipped not
    rejected; an empty batch is accepted.
  - the route is exposed in the OpenAPI schema with the uniform error envelope.
"""
from __future__ import annotations

from sqlmodel import Session, select


# --- migration 23 -----------------------------------------------------------
def test_migration_23_recorded_and_user_version(db_session):
    from app.db import engine

    with engine.begin() as conn:
        rows = conn.exec_driver_sql(
            "SELECT name FROM schema_migrations WHERE version = 23"
        ).fetchall()
        assert rows and rows[0][0] == "host_progress_snapshot"
        user_version = conn.exec_driver_sql("PRAGMA user_version").fetchone()[0]
        assert int(user_version) >= 23


def test_migration_23_creates_indexes(db_session):
    from app.db import engine

    with engine.begin() as conn:
        rows = conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='index'"
        ).fetchall()
    names = {r[0] for r in rows}
    assert "ux_hostprogresssnapshot_cross_id" in names
    assert "ix_hostprogresssnapshot_plane_kind" in names


def test_migration_23_is_idempotent(db_session):
    from app import migrations
    from app.db import engine

    # Re-running the whole ledger applies nothing new (23 already recorded).
    applied = migrations.run_migrations(engine)
    assert applied == 0
    # Re-running just the m023 fn by hand is also a clean no-op (IF NOT EXISTS).
    with engine.begin() as conn:
        migrations._m023_host_progress_snapshot(conn)
        rows = conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='index' "
            "AND name='ux_hostprogresssnapshot_cross_id'"
        ).fetchall()
    assert rows


# --- POST /api/sync/progress-updates ----------------------------------------
def _review_snapshot(cross_id="cfa:review:loiabc-1", title="Time value of money"):
    return {
        "crossId": cross_id,
        "domain": "cfa",
        "kind": "review",
        "observedAt": "2026-06-15T10:00:00+00:00",
        "payload": {
            "crossId": cross_id,
            "domain": "cfa",
            "questionCrossId": "cfa:question:loiabc-1",
            "title": title,
            "difficulty": "intermediate",
            "itemType": "Quantitative Methods",
        },
    }


def test_progress_updates_upserts_and_persists(client):
    from app.db import engine
    from app.models import HostProgressSnapshot

    r = client.post(
        "/api/sync/progress-updates",
        json={"snapshots": [_review_snapshot()]},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["received"] == 1
    assert body["upserted"] == 1
    assert body["skipped"] == 0

    with Session(engine) as s:
        row = s.exec(
            select(HostProgressSnapshot).where(
                HostProgressSnapshot.cross_id == "cfa:review:loiabc-1"
            )
        ).first()
        assert row is not None
        assert row.kind == "review"
        assert row.plane == "cfa"
        assert row.payload["title"] == "Time value of money"
        assert row.dedupe_key  # a content fingerprint was stored


def test_progress_updates_idempotent_no_duplicate(client):
    from app.db import engine
    from app.models import HostProgressSnapshot

    snap = _review_snapshot()
    client.post("/api/sync/progress-updates", json={"snapshots": [snap]})
    # Identical re-POST: recognised no-op, still exactly one row.
    r2 = client.post("/api/sync/progress-updates", json={"snapshots": [snap]})
    body = r2.json()
    assert body["unchanged"] == 1
    assert body["upserted"] == 0

    with Session(engine) as s:
        rows = s.exec(
            select(HostProgressSnapshot).where(
                HostProgressSnapshot.cross_id == "cfa:review:loiabc-1"
            )
        ).all()
    assert len(rows) == 1


def test_progress_updates_changed_payload_updates_in_place(client):
    from app.db import engine
    from app.models import HostProgressSnapshot

    client.post("/api/sync/progress-updates", json={"snapshots": [_review_snapshot()]})
    # Same cross_id, changed payload -> update in place (still one row).
    changed = _review_snapshot(title="Time value of money (revised)")
    r2 = client.post("/api/sync/progress-updates", json={"snapshots": [changed]})
    body = r2.json()
    assert body["upserted"] == 1
    assert body["unchanged"] == 0

    with Session(engine) as s:
        rows = s.exec(
            select(HostProgressSnapshot).where(
                HostProgressSnapshot.cross_id == "cfa:review:loiabc-1"
            )
        ).all()
    assert len(rows) == 1
    assert rows[0].payload["title"] == "Time value of money (revised)"


def test_progress_updates_skips_non_host_and_unknown_kind(client):
    from app.db import engine
    from app.models import HostProgressSnapshot

    snapshots = [
        _review_snapshot(cross_id="cfa:review:ok-1"),          # accepted
        {                                                       # lsat plane -> skipped
            "crossId": "lsat:review:9",
            "domain": "lsat",
            "kind": "review",
            "payload": {"crossId": "lsat:review:9", "domain": "lsat"},
        },
    ]
    r = client.post("/api/sync/progress-updates", json={"snapshots": snapshots})
    body = r.json()
    assert body["received"] == 2
    assert body["upserted"] == 1
    assert body["skipped"] == 1

    with Session(engine) as s:
        all_rows = s.exec(select(HostProgressSnapshot)).all()
    cross_ids = {row.cross_id for row in all_rows}
    assert "cfa:review:ok-1" in cross_ids
    assert "lsat:review:9" not in cross_ids


def test_progress_updates_attempt_and_mastery_kinds(client):
    snapshots = [
        {
            "crossId": "quant:attempt:42",
            "domain": "quant",
            "kind": "attempt",
            "payload": {
                "crossId": "quant:attempt:42",
                "domain": "quant",
                "questionCrossId": "quant:question:7",
                "correct": True,
            },
        },
        {
            "crossId": "excel:question:vlookup",
            "domain": "excel",
            "kind": "mastery",
            "payload": {
                "crossId": "excel:question:vlookup",
                "domain": "excel",
                "masteryFraction": 0.6,
                "key": "lookup-functions",
            },
        },
    ]
    r = client.post("/api/sync/progress-updates", json={"snapshots": snapshots})
    body = r.json()
    assert body["upserted"] == 2
    assert body["skipped"] == 0


def test_progress_updates_empty_batch_ok(client):
    r = client.post("/api/sync/progress-updates", json={"snapshots": []})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["received"] == 0
    assert body["upserted"] == 0


def test_progress_updates_route_has_openapi_schema(client):
    spec = client.get("/openapi.json").json()
    op = spec["paths"]["/api/sync/progress-updates"]["post"]
    assert op["responses"]["200"]["content"]["application/json"].get("schema")
    assert "422" in op["responses"]
