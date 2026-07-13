"""DATA-2 + DATA-3 — cross-domain canonical serializers + schema-version handshake.

Covers:
  - migration 22 records ``cross_domain_schema_version`` in ``schema_meta`` and
    bumps ``PRAGMA user_version`` to 22 (PRAGMA-guarded, idempotent).
  - ``read_cross_domain_schema_version`` returns the recorded value and degrades
    to the code default when the row/table is absent.
  - GET /api/observability/schema-versions reports the contract version + db
    user_version + latest migration + host_min_supported.
  - serializers.cross_domain_review_card / cross_domain_attempt project the
    LSAT-native SRSCard / Attempt onto the canonical cross-domain shapes pinned
    by docs/DATA-DICTIONARY.md (namespaced identity, bucketed difficulty,
    time_ms -> elapsedSeconds).
"""
from __future__ import annotations

from sqlmodel import Session, select

from app import serializers
from app.models import Attempt, Question, SRSCard


# --- migration 22 -----------------------------------------------------------
def test_migration_22_recorded_and_user_version(db_session):
    from app.db import engine

    with engine.begin() as conn:
        rows = conn.exec_driver_sql(
            "SELECT name FROM schema_migrations WHERE version = 22"
        ).fetchall()
        assert rows and rows[0][0] == "cross_domain_schema_version"
        user_version = conn.exec_driver_sql("PRAGMA user_version").fetchone()[0]
        assert int(user_version) >= 22


def test_schema_meta_records_cross_domain_version(db_session):
    from app import migrations
    from app.db import engine

    with engine.begin() as conn:
        version = migrations.read_cross_domain_schema_version(conn)
    assert version == migrations.CROSS_DOMAIN_SCHEMA_VERSION


def test_migration_22_is_idempotent(db_session):
    from app import migrations
    from app.db import engine

    # Re-running the whole ledger applies nothing new (22 already recorded).
    applied = migrations.run_migrations(engine)
    assert applied == 0
    # Re-running just the m022 fn by hand is also a clean no-op (upsert).
    with engine.begin() as conn:
        migrations._m022_cross_domain_schema_version(conn)
        version = migrations.read_cross_domain_schema_version(conn)
    assert version == migrations.CROSS_DOMAIN_SCHEMA_VERSION


def test_read_cross_domain_version_defaults_when_table_missing(db_session):
    from app import migrations
    from app.db import engine

    with engine.begin() as conn:
        conn.exec_driver_sql("DROP TABLE IF EXISTS schema_meta")
        version = migrations.read_cross_domain_schema_version(conn)
    assert version == migrations.CROSS_DOMAIN_SCHEMA_VERSION


# --- GET /api/observability/schema-versions ---------------------------------
def test_schema_versions_endpoint(client):
    from app import migrations

    r = client.get("/api/observability/schema-versions")
    assert r.status_code == 200
    body = r.json()
    assert body["cross_domain_schema_version"] == migrations.CROSS_DOMAIN_SCHEMA_VERSION
    assert body["db_user_version"] >= 22
    assert body["latest_migration_version"] == max(m[0] for m in migrations.MIGRATIONS)
    assert body["host_min_supported"] == migrations.CROSS_DOMAIN_HOST_MIN_SUPPORTED
    assert "generated_at" in body


def test_schema_versions_route_has_openapi_schema(client):
    spec = client.get("/openapi.json").json()
    op = spec["paths"]["/api/observability/schema-versions"]["get"]
    assert op["responses"]["200"]["content"]["application/json"].get("schema")
    assert "422" in op["responses"]


# --- DATA-2 canonical serializers -------------------------------------------
def test_cross_domain_review_card_shape(db_session):
    # Seed data has questions + SRS cards. Grab one card + its question.
    card = db_session.exec(select(SRSCard)).first()
    assert card is not None
    q = db_session.get(Question, card.question_id)

    out = serializers.cross_domain_review_card(db_session, card, q)
    assert out["crossId"] == f"lsat:review:{card.id}"
    assert out["questionCrossId"] == f"lsat:question:{card.question_id}"
    assert out["domain"] == "lsat"
    assert out["difficulty"] in {"foundation", "intermediate", "advanced"}
    assert out["itemType"] == q.q_type
    assert "title" in out and out["title"]


def test_cross_domain_review_card_looks_up_question_when_omitted(db_session):
    card = db_session.exec(select(SRSCard)).first()
    assert card is not None
    out = serializers.cross_domain_review_card(db_session, card)  # q omitted
    assert out["questionCrossId"] == f"lsat:question:{card.question_id}"


def test_difficulty_bucketing_matches_dictionary():
    # docs/DATA-DICTIONARY.md §2: 1-2 foundation, 3 intermediate, 4-5 advanced.
    assert serializers.lsat_difficulty_to_host(1) == "foundation"
    assert serializers.lsat_difficulty_to_host(2) == "foundation"
    assert serializers.lsat_difficulty_to_host(3) == "intermediate"
    assert serializers.lsat_difficulty_to_host(4) == "advanced"
    assert serializers.lsat_difficulty_to_host(5) == "advanced"
    # Out of range clamps; non-numeric -> neutral middle.
    assert serializers.lsat_difficulty_to_host(99) == "advanced"
    assert serializers.lsat_difficulty_to_host(0) == "foundation"
    assert serializers.lsat_difficulty_to_host(None) == "intermediate"
    assert serializers.lsat_difficulty_to_host("nope") == "intermediate"


def test_cross_domain_attempt_shape(db_session):
    q = db_session.exec(select(Question)).first()
    assert q is not None
    # A standalone Attempt (no session needed for serialization).
    attempt = Attempt(
        question_id=q.id,
        session_id=1,
        chosen_answer="B",
        is_correct=False,
        time_ms=42000,
    )
    db_session.add(attempt)
    db_session.commit()
    db_session.refresh(attempt)

    out = serializers.cross_domain_attempt(attempt)
    assert out["crossId"] == f"lsat:attempt:{attempt.id}"
    assert out["questionCrossId"] == f"lsat:question:{q.id}"
    assert out["domain"] == "lsat"
    assert out["correct"] is False
    assert out["chosenAnswer"] == "B"
    assert out["elapsedSeconds"] == 42  # time_ms -> seconds (§4)


def test_cross_domain_attempt_no_time_yields_none(db_session):
    q = db_session.exec(select(Question)).first()
    attempt = Attempt(question_id=q.id, session_id=1, time_ms=0)
    db_session.add(attempt)
    db_session.commit()
    db_session.refresh(attempt)
    out = serializers.cross_domain_attempt(attempt)
    assert out["elapsedSeconds"] is None
