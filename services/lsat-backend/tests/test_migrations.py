"""Migration runner: ordering, idempotency, recorded versions, real indexes."""
from __future__ import annotations


def test_run_migrations_applies_in_order_and_records(db_session):
    from app import migrations
    from app.db import engine

    # Use throwaway high version numbers that won't collide with real ones.
    with engine.begin() as conn:
        conn.exec_driver_sql("DELETE FROM schema_migrations WHERE version IN (9001, 9002)")

    order: list[str] = []
    test_migs = [
        (9002, "second", lambda c: order.append("second")),
        (9001, "first", lambda c: order.append("first")),
    ]

    applied = migrations.run_migrations(engine, test_migs)
    assert applied == 2
    assert order == ["first", "second"]  # ascending version order

    # Idempotent: a second run applies nothing.
    order.clear()
    applied2 = migrations.run_migrations(engine, test_migs)
    assert applied2 == 0
    assert order == []

    with engine.begin() as conn:
        conn.exec_driver_sql("DELETE FROM schema_migrations WHERE version IN (9001, 9002)")


def test_real_migration_records_version_1(db_session):
    from app.db import engine

    with engine.begin() as conn:
        rows = conn.exec_driver_sql(
            "SELECT version, name FROM schema_migrations WHERE version = 1"
        ).fetchall()
    assert rows and rows[0][1] == "hot_path_indexes"


def test_hot_path_indexes_exist(db_session):
    from app.db import engine

    with engine.begin() as conn:
        rows = conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='index'"
        ).fetchall()
    names = {r[0] for r in rows}
    assert "ix_question_qtype_difficulty" in names
    assert "ix_attempt_session_mode" in names
    assert "ix_question_qtype_source" in names
