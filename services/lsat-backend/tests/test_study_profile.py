"""DATA-6 — shared study-profile arbiter.

Covers GET + PUT /api/study/profile:
  - GET returns the reconciled SharedStudyProfile shape (scalars + host-owned
    fields), idempotent (two GETs are byte-identical, no mutation);
  - PUT round-trips: writes scalars + host-owned fields, updates the active LSAT
    StudyPlan row, and a later GET reflects the write (last-write-wins);
  - last-write-wins: a newer PUT scalar beats an older StudyPlan scalar;
  - partial PUT keeps unsent fields;
  - migration 24 (shared_study_profile) bumps PRAGMA user_version to 24 and adds
    studyplan.updated_at + the unique profile-key index;
  - the route is published in the OpenAPI schema with a typed response_model.
"""
from __future__ import annotations

from datetime import date, timedelta

from sqlmodel import Session, select


# --- GET shape + idempotency ------------------------------------------------
def test_get_profile_returns_reconciled_shape(client):
    r = client.get("/api/study/profile")
    assert r.status_code == 200
    body = r.json()
    for key in (
        "has_plan",
        "target_score",
        "exam_date",
        "daily_minutes",
        "target_level",
        "rest_days",
        "mock_cadence_days",
        "topic_weights",
        "last_writer",
        "updated_at",
    ):
        assert key in body
    assert isinstance(body["rest_days"], list)
    assert isinstance(body["topic_weights"], dict)
    assert isinstance(body["target_score"], int)
    assert isinstance(body["daily_minutes"], int)


def test_get_profile_is_idempotent(client):
    first = client.get("/api/study/profile").json()
    second = client.get("/api/study/profile").json()
    assert first == second  # read-only: no mutation between identical GETs


# --- PUT round-trip + StudyPlan update --------------------------------------
def test_put_profile_round_trips_and_updates_studyplan(client):
    exam = (date.today() + timedelta(days=60)).isoformat()
    r = client.put(
        "/api/study/profile",
        json={
            "target_score": 172,
            "exam_date": exam,
            "daily_minutes": 75,
            "target_level": "level2",
            "rest_days": [0, 6],
            "mock_cadence_days": 10,
            "topic_weights": {"LR": 0.6, "RC": 0.4},
            "last_writer": "host",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["has_plan"] is True
    assert body["target_score"] == 172
    assert body["exam_date"] == exam
    assert body["daily_minutes"] == 75
    assert body["target_level"] == "level2"
    assert body["rest_days"] == [0, 6]
    assert body["mock_cadence_days"] == 10
    assert body["topic_weights"] == {"LR": 0.6, "RC": 0.4}
    assert body["last_writer"] == "host"
    assert body["updated_at"] is not None

    # A later GET reflects the write (reconciliation persists).
    got = client.get("/api/study/profile").json()
    assert got["target_score"] == 172
    assert got["target_level"] == "level2"
    assert got["rest_days"] == [0, 6]
    assert got["topic_weights"] == {"LR": 0.6, "RC": 0.4}

    # The active LSAT StudyPlan row carries the reconciled scalars (the PUT
    # writes through study_plan.upsert_plan, not just the profile mirror).
    plan = client.get("/api/study/plan").json()
    assert plan["has_plan"] is True
    assert plan["target_score"] == 172
    assert plan["exam_date"] == exam
    assert plan["daily_minutes"] == 75


def test_put_profile_partial_keeps_unsent_fields(client):
    client.put(
        "/api/study/profile",
        json={
            "target_score": 168,
            "target_level": "level3",
            "rest_days": [3],
            "daily_minutes": 50,
        },
    )
    # A partial PUT touching only target_score must not zero target_level/etc.
    body = client.put("/api/study/profile", json={"target_score": 169}).json()
    assert body["target_score"] == 169
    assert body["target_level"] == "level3"
    assert body["rest_days"] == [3]
    assert body["daily_minutes"] == 50


def test_put_profile_last_write_wins_over_older_studyplan(client):
    # Older write via the legacy /study/plan route (sets StudyPlan only).
    client.put("/api/study/plan", json={"target_score": 160, "daily_minutes": 40})
    # Newer write via the profile arbiter — its updated_at is more recent, so it
    # wins the shared scalars.
    client.put("/api/study/profile", json={"target_score": 175, "daily_minutes": 90})
    got = client.get("/api/study/profile").json()
    assert got["target_score"] == 175
    assert got["daily_minutes"] == 90


def test_put_profile_clamps_out_of_range_scalars(client):
    body = client.put(
        "/api/study/profile",
        json={"target_score": 999, "daily_minutes": 100000, "rest_days": [9, 2]},
    ).json()
    assert body["target_score"] <= 180
    assert body["daily_minutes"] <= 600
    # rest_days outside 0-6 are dropped.
    assert body["rest_days"] == [2]


# --- migration 24 -----------------------------------------------------------
def test_migration_24_pragma_user_version(client):
    from app.db import engine

    with engine.begin() as conn:
        uv = conn.exec_driver_sql("PRAGMA user_version").fetchone()[0]
    assert int(uv) >= 24


def test_migration_24_adds_studyplan_updated_at_and_profile_index(client):
    from app.db import engine

    with engine.begin() as conn:
        cols = {
            str(r[1])
            for r in conn.exec_driver_sql("PRAGMA table_info(studyplan)").fetchall()
        }
        idx = {
            str(r[0])
            for r in conn.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE type='index'"
            ).fetchall()
            if r[0]
        }
    assert "updated_at" in cols
    assert "ux_sharedstudyprofile_key" in idx


def test_migration_24_registered_in_ledger(client):
    from app import migrations

    versions = {m[0]: m[1] for m in migrations.MIGRATIONS}
    assert versions.get(24) == "shared_study_profile"


def test_profile_single_row_invariant(client, db_session):
    from app.models import SharedStudyProfile

    client.put("/api/study/profile", json={"target_score": 165})
    client.put("/api/study/profile", json={"target_score": 170})
    rows = db_session.exec(select(SharedStudyProfile)).all()
    # The unique profile_key index keeps a single shared row across writes.
    assert len(rows) == 1
    assert rows[0].profile_key == "default"
    assert rows[0].target_score == 170


# --- OpenAPI contract -------------------------------------------------------
def test_profile_route_has_openapi_schema(client):
    spec = client.get("/openapi.json").json()
    for method in ("get", "put"):
        op = spec["paths"]["/api/study/profile"][method]
        schema = op["responses"]["200"]["content"]["application/json"].get("schema")
        assert schema  # inline typed response_model is published
