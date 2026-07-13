"""DATA-4b — cross-domain FSRS write-back + conflict ledger (host -> backend).

Covers:
  - migration 27 records ``cross_domain_sync_log`` in ``schema_migrations`` and
    bumps ``PRAGMA user_version`` to 27 (PRAGMA-guarded, idempotent); creates the
    UNIQUE ``write_id`` index + the ``cross_id`` lookup index; adds the
    ``hostprogresssnapshot`` write-back bookkeeping columns.
  - POST /api/sync/fsrs-write-back merges a write into the DATA-4a mirror under
    last-write-wins, bumping ``sync_revision`` and storing ``payload.fsrsState``;
    logs every write to ``CrossDomainSyncLog``.
  - idempotent by ``write_id`` (a replay is a recognised no-op, never a
    double-apply); last-write-wins keeps a newer stored state against a stale
    out-of-order write; a write for an un-fed card is ``no_target`` (no snapshot
    created); the reconcile response carries the authoritative state per card.
  - LSAT-native ``SRSCard`` scheduling is never touched by a write-back.
  - GET /api/sync/fsrs-write-back/log reads the ledger; the route is exposed in
    the OpenAPI schema with the uniform error envelope.
"""
from __future__ import annotations

from sqlmodel import Session, select


def _seed_review(client, cross_id, *, observed_at="2026-06-15T10:00:00+00:00", title="Card"):
    """Feed one host review snapshot via the DATA-4a read-only feed so a
    write-back has a card to land on (write-back never creates snapshots)."""
    r = client.post(
        "/api/sync/progress-updates",
        json={
            "snapshots": [
                {
                    "crossId": cross_id,
                    "domain": cross_id.split(":", 1)[0],
                    "kind": "review",
                    "observedAt": observed_at,
                    "payload": {"crossId": cross_id, "domain": cross_id.split(":", 1)[0], "title": title},
                }
            ]
        },
    )
    assert r.status_code == 200


# --- migration 27 -----------------------------------------------------------
def test_migration_27_recorded_and_user_version(db_session):
    from app.db import engine

    with engine.begin() as conn:
        rows = conn.exec_driver_sql(
            "SELECT name FROM schema_migrations WHERE version = 27"
        ).fetchall()
        assert rows and rows[0][0] == "cross_domain_sync_log"
        user_version = conn.exec_driver_sql("PRAGMA user_version").fetchone()[0]
        assert int(user_version) >= 27


def test_migration_27_creates_indexes_and_columns(db_session):
    from app.db import engine

    with engine.begin() as conn:
        idx = {
            r[0]
            for r in conn.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE type='index'"
            ).fetchall()
        }
        cols = {
            r[1]
            for r in conn.exec_driver_sql(
                "PRAGMA table_info(hostprogresssnapshot)"
            ).fetchall()
        }
    assert "ux_crossdomainsynclog_write_id" in idx
    assert "ix_crossdomainsynclog_cross_id" in idx
    assert "sync_revision" in cols
    assert "last_write_back_at" in cols


def test_migration_27_is_idempotent(db_session):
    from app import migrations
    from app.db import engine

    applied = migrations.run_migrations(engine)
    assert applied == 0
    with engine.begin() as conn:
        migrations._m027_cross_domain_sync_log(conn)
        rows = conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='index' "
            "AND name='ux_crossdomainsynclog_write_id'"
        ).fetchall()
    assert rows


# --- POST /api/sync/fsrs-write-back -----------------------------------------
def test_write_back_applies_to_mirrored_card(client):
    from app.db import engine
    from app.models import CrossDomainSyncLog, HostProgressSnapshot

    cid = "cfa:review:wb-apply"
    _seed_review(client, cid)
    r = client.post(
        "/api/sync/fsrs-write-back",
        json={
            "writes": [
                {
                    "writeId": "w-apply-1",
                    "crossId": cid,
                    "fsrsState": {"stability": 12.5, "difficulty": 6.1, "reps": 4},
                    "observedAt": "2026-06-16T09:00:00+00:00",
                }
            ]
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["received"] == 1
    assert body["applied"] == 1
    assert body["deduped"] == 0
    assert body["no_target"] == 0
    assert body["reconciled"][0]["resolution"] == "applied"
    assert body["reconciled"][0]["fsrsState"]["stability"] == 12.5
    assert body["reconciled"][0]["syncRevision"] == 1

    with Session(engine) as s:
        snap = s.exec(
            select(HostProgressSnapshot).where(HostProgressSnapshot.cross_id == cid)
        ).first()
        assert snap is not None
        assert snap.payload["fsrsState"]["stability"] == 12.5
        assert snap.sync_revision == 1
        assert snap.last_write_back_at is not None
        log = s.exec(
            select(CrossDomainSyncLog).where(CrossDomainSyncLog.write_id == "w-apply-1")
        ).first()
        assert log is not None
        assert log.resolution == "applied"
        assert log.source_plane == "cfa"
        assert log.target_plane == "lsat"


def test_write_back_idempotent_by_write_id(client):
    from app.db import engine
    from app.models import CrossDomainSyncLog, HostProgressSnapshot

    cid = "quant:review:wb-dedupe"
    _seed_review(client, cid)
    write = {
        "writeId": "w-dedupe-1",
        "crossId": cid,
        "fsrsState": {"stability": 3.0},
        "observedAt": "2026-06-16T09:00:00+00:00",
    }
    client.post("/api/sync/fsrs-write-back", json={"writes": [write]})
    # Replay the same write_id — recognised no-op, never a double-apply.
    r2 = client.post("/api/sync/fsrs-write-back", json={"writes": [write]})
    body = r2.json()
    assert body["applied"] == 0
    assert body["deduped"] == 1
    assert body["reconciled"][0]["resolution"] == "noop_dedupe"

    with Session(engine) as s:
        snap = s.exec(
            select(HostProgressSnapshot).where(HostProgressSnapshot.cross_id == cid)
        ).first()
        assert snap.sync_revision == 1  # not bumped twice
        logs = s.exec(
            select(CrossDomainSyncLog).where(CrossDomainSyncLog.write_id == "w-dedupe-1")
        ).all()
        assert len(logs) == 1


def test_write_back_last_write_wins_keeps_newer(client):
    from app.db import engine
    from app.models import HostProgressSnapshot

    cid = "excel:review:wb-lww"
    _seed_review(client, cid)
    # Apply a NEWER state first.
    client.post(
        "/api/sync/fsrs-write-back",
        json={
            "writes": [
                {
                    "writeId": "w-lww-new",
                    "crossId": cid,
                    "fsrsState": {"stability": 20.0},
                    "observedAt": "2026-06-20T12:00:00+00:00",
                }
            ]
        },
    )
    # A stale, out-of-order write (older observedAt, distinct write_id) is kept-existing.
    r2 = client.post(
        "/api/sync/fsrs-write-back",
        json={
            "writes": [
                {
                    "writeId": "w-lww-old",
                    "crossId": cid,
                    "fsrsState": {"stability": 1.0},
                    "observedAt": "2026-06-18T08:00:00+00:00",
                }
            ]
        },
    )
    body = r2.json()
    assert body["applied"] == 0
    assert body["kept_existing"] == 1
    assert body["reconciled"][0]["resolution"] == "kept_existing"
    assert body["reconciled"][0]["fsrsState"]["stability"] == 20.0

    with Session(engine) as s:
        snap = s.exec(
            select(HostProgressSnapshot).where(HostProgressSnapshot.cross_id == cid)
        ).first()
        assert snap.payload["fsrsState"]["stability"] == 20.0
        assert snap.sync_revision == 1  # only the first (newer) write applied


def test_write_back_no_target_when_card_unfed(client):
    from app.db import engine
    from app.models import CrossDomainSyncLog, HostProgressSnapshot

    cid = "cfa:review:never-fed"
    r = client.post(
        "/api/sync/fsrs-write-back",
        json={
            "writes": [
                {
                    "writeId": "w-no-target",
                    "crossId": cid,
                    "fsrsState": {"stability": 5.0},
                    "observedAt": "2026-06-16T09:00:00+00:00",
                }
            ]
        },
    )
    body = r.json()
    assert body["no_target"] == 1
    assert body["applied"] == 0
    assert body["reconciled"][0]["resolution"] == "no_target"

    with Session(engine) as s:
        # Write-back never creates a snapshot (that is DATA-4a's job).
        snap = s.exec(
            select(HostProgressSnapshot).where(HostProgressSnapshot.cross_id == cid)
        ).first()
        assert snap is None
        # The attempt is still logged for diagnostics.
        log = s.exec(
            select(CrossDomainSyncLog).where(CrossDomainSyncLog.write_id == "w-no-target")
        ).first()
        assert log is not None and log.resolution == "no_target"


def test_write_back_never_touches_lsat_srscard(client):
    from app.db import engine
    from app.models import SRSCard

    cid = "cfa:review:wb-safety"
    _seed_review(client, cid)
    with Session(engine) as s:
        before = len(s.exec(select(SRSCard)).all())
    client.post(
        "/api/sync/fsrs-write-back",
        json={
            "writes": [
                {"writeId": "w-safety", "crossId": cid, "fsrsState": {"stability": 9.0},
                 "observedAt": "2026-06-16T09:00:00+00:00"}
            ]
        },
    )
    with Session(engine) as s:
        # A host write-back must never create or mutate LSAT-native scheduling rows.
        assert len(s.exec(select(SRSCard)).all()) == before


def test_write_back_empty_batch_ok(client):
    r = client.post("/api/sync/fsrs-write-back", json={"writes": []})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["received"] == 0
    assert body["applied"] == 0


# --- GET /api/sync/fsrs-write-back/log --------------------------------------
def test_write_back_log_lists_entries(client):
    cid = "quant:review:wb-log"
    _seed_review(client, cid)
    client.post(
        "/api/sync/fsrs-write-back",
        json={
            "writes": [
                {"writeId": "w-log-1", "crossId": cid, "fsrsState": {"stability": 2.0},
                 "observedAt": "2026-06-16T09:00:00+00:00"}
            ]
        },
    )
    r = client.get("/api/sync/fsrs-write-back/log", params={"cross_id": cid})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["count"] >= 1
    assert any(e["writeId"] == "w-log-1" for e in body["entries"])
    assert body["entries"][0]["resolution"] in {"applied", "kept_existing", "noop_dedupe", "no_target"}


def test_write_back_route_has_openapi_schema(client):
    spec = client.get("/openapi.json").json()
    op = spec["paths"]["/api/sync/fsrs-write-back"]["post"]
    assert op["responses"]["200"]["content"]["application/json"].get("schema")
    assert "422" in op["responses"]
