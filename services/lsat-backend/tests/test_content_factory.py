"""CONTENT-8 — coverage-driven content factory (gated, flag-gated, reversible).

The factory turns coverage deficits + weak-topic analytics into GATED Tier-B
generation jobs. These tests assert:
  * the PLAN is pure (no writes) and ranks deficits with real anchors only,
  * enqueue is fail-closed on the flag (OFF -> previews, never enqueues),
  * enqueue (flag ON) schedules normal GenJobs WITHOUT bypassing the gate, and
  * ROLLBACK cancels pending jobs and soft-deletes any produced questions,
    idempotently.

The generation worker is disabled under pytest (conftest sets
LSATLAB_JOBS_WORKER=0), so enqueued jobs sit ``queued`` — exactly the offline
no-model path. We never invoke a model here.
"""
from __future__ import annotations

import pytest
from sqlmodel import Session, select

from app import config, content_factory
from app.db import engine
from app.models import (
    ActivityEvent,
    GenCandidate,
    GenJob,
    GenStatus,
    Question,
    QuestionSource,
)


@pytest.fixture()
def factory_on(monkeypatch):
    monkeypatch.setattr(config, "CONTENT_FACTORY_ENABLED", True)
    return True


# --- plan (pure, no write) --------------------------------------------------


def test_plan_is_pure_and_targets_deficits_with_anchors(db_session):
    before_jobs = len(db_session.exec(select(GenJob)).all())
    before_events = len(db_session.exec(select(ActivityEvent)).all())

    plan = content_factory.plan_factory(db_session, coverage_floor=12)

    assert plan["domain"] == "lsat"
    assert plan["provenance"] == content_factory.PROVENANCE_TAG
    assert plan["gate"] == "validate_candidate"
    assert plan["gate_bypassed"] is False
    # The seeded sample bank is thin (< 12 per type) but HAS real anchors, so
    # there should be at least one target.
    assert plan["target_count"] >= 1
    for t in plan["targets"]:
        assert t["anchors"] >= 1            # never model AI on AI
        assert t["deficit"] > 0
        assert 1 <= t["count"] <= config.CONTENT_FACTORY_MAX_PER_TYPE
        assert t["citations"]               # provenance/citations present
    # Pure: nothing written.
    assert len(db_session.exec(select(GenJob)).all()) == before_jobs
    assert len(db_session.exec(select(ActivityEvent)).all()) == before_events


def test_plan_skips_types_without_real_anchors(db_session):
    # An AI-only, quarantined type has a deficit but NO real anchors -> skipped.
    db_session.add(Question(
        stem="A purely AI-origin orphan stem with sufficient length to be a stimulus.",
        prompt="Which one?", correct_answer="A", difficulty=3,
        q_type="ZZZOrphanType", source=QuestionSource.ai_generated,
        quarantined=True, approved=False,
    ))
    db_session.commit()
    plan = content_factory.plan_factory(db_session, coverage_floor=12)
    target_types = {t["q_type"] for t in plan["targets"]}
    assert "ZZZOrphanType" not in target_types
    skipped_types = {s["q_type"] for s in plan["skipped"]}
    assert "ZZZOrphanType" in skipped_types


def test_plan_respects_caps(db_session):
    plan = content_factory.plan_factory(
        db_session, coverage_floor=12, max_per_type=2, max_types=1,
    )
    assert plan["target_count"] <= 1
    for t in plan["targets"]:
        assert t["count"] <= 2


# --- enqueue: fail-closed on the flag ---------------------------------------


def test_run_factory_disabled_does_not_enqueue(db_session):
    # Flag OFF by default in config -> preview, never enqueue.
    assert config.CONTENT_FACTORY_ENABLED is False
    before = len(db_session.exec(select(GenJob)).all())
    result = content_factory.run_factory(db_session, coverage_floor=12)
    assert result["enqueued"] is False
    assert result["reason"] == "content_factory_disabled"
    assert result["batch_id"] is None
    assert len(db_session.exec(select(GenJob)).all()) == before


def test_run_factory_enqueues_gated_jobs(db_session, factory_on):
    result = content_factory.run_factory(db_session, coverage_floor=12, max_types=3)
    assert result["enqueued"] is True
    assert result["batch_id"] is not None
    assert result["gate_bypassed"] is False
    assert len(result["jobs"]) >= 1

    # Every enqueued job is a normal queued GenJob (the worker will run the gate).
    for jrow in result["jobs"]:
        job = db_session.get(GenJob, jrow["job_id"])
        assert job is not None
        assert job.status == GenStatus.queued       # gate runs when worker drains
        assert job.produced == 0                    # no model ran (worker off)
        assert job.priority == -10                  # low priority: never starves user jobs

    # A provenance batch row records the run + job ids for audit + rollback.
    batch = db_session.get(ActivityEvent, result["batch_id"])
    assert batch is not None
    assert batch.kind == content_factory.FACTORY_BATCH_KIND
    assert batch.detail_json["gate_bypassed"] is False
    assert batch.detail_json["provenance"] == content_factory.PROVENANCE_TAG
    assert set(batch.detail_json["job_ids"]) == {j["job_id"] for j in result["jobs"]}


# --- rollback ---------------------------------------------------------------


def test_rollback_cancels_pending_jobs(db_session, factory_on):
    result = content_factory.run_factory(db_session, coverage_floor=12, max_types=2)
    batch_id = result["batch_id"]
    job_ids = [j["job_id"] for j in result["jobs"]]

    rb = content_factory.rollback_factory(db_session, batch_id)
    assert rb["ok"] is True
    assert rb["jobs_cancelled"] == len(job_ids)

    for jid in job_ids:
        assert db_session.get(GenJob, jid).status == GenStatus.cancelled

    batch = db_session.get(ActivityEvent, batch_id)
    assert batch.status == "rolled_back"
    assert batch.detail_json["rolled_back"] is True


def test_rollback_soft_deletes_produced_questions(db_session, factory_on):
    result = content_factory.run_factory(db_session, coverage_floor=12, max_types=1)
    batch_id = result["batch_id"]
    job_id = result["jobs"][0]["job_id"]

    # Simulate the worker having gate-accepted ONE question into the bank for the
    # job (a GenCandidate with a question_id, the real accept path's shape).
    produced = Question(
        stem="A gate-accepted generated stem with sufficient length to be a stimulus.",
        prompt="Which one of the following?", correct_answer="B", difficulty=3,
        q_type=result["jobs"][0]["q_type"], source=QuestionSource.ai_generated,
        approved=True, quarantined=False,
    )
    db_session.add(produced)
    db_session.commit()
    db_session.refresh(produced)
    db_session.add(GenCandidate(
        gen_job_id=job_id, question_id=produced.id, candidate_index=0,
        verdict="accepted",
    ))
    db_session.commit()

    assert produced.deleted_at is None
    rb = content_factory.rollback_factory(db_session, batch_id)
    assert rb["ok"] is True
    assert rb["questions_soft_deleted"] == 1

    db_session.refresh(produced)
    assert produced.deleted_at is not None     # tombstoned -> leaves coverage


def test_rollback_is_idempotent(db_session, factory_on):
    result = content_factory.run_factory(db_session, coverage_floor=12, max_types=1)
    batch_id = result["batch_id"]
    first = content_factory.rollback_factory(db_session, batch_id)
    second = content_factory.rollback_factory(db_session, batch_id)
    assert first["ok"] is True and second["ok"] is True
    # Second pass cancels nothing new and deletes nothing new.
    assert second["jobs_cancelled"] == 0
    assert second["questions_soft_deleted"] == 0


def test_rollback_unknown_batch(db_session):
    rb = content_factory.rollback_factory(db_session, 999999)
    assert rb["ok"] is False
    assert rb["reason"] == "batch_not_found"


# --- HTTP surface -----------------------------------------------------------


def test_plan_endpoint_preview_is_pure(client):
    before = client.get("/api/content-factory/batches").json()
    r = client.post("/api/content-factory/plan", json={"activate": False})
    assert r.status_code == 200
    body = r.json()
    assert body["enqueued"] is False
    assert body["reason"] == "preview"
    assert body["gate_bypassed"] is False
    # No batch created by a preview.
    after = client.get("/api/content-factory/batches").json()
    assert len(after["batches"]) == len(before["batches"])


def test_plan_endpoint_activate_blocked_when_disabled(client):
    # Flag OFF (default) -> activate still does NOT enqueue (fail-closed).
    r = client.post("/api/content-factory/plan", json={"activate": True})
    assert r.status_code == 200
    body = r.json()
    assert body["enqueued"] is False
    assert body["reason"] == "content_factory_disabled"


def test_plan_and_rollback_endpoints_roundtrip(client, monkeypatch):
    monkeypatch.setattr(config, "CONTENT_FACTORY_ENABLED", True)
    r = client.post("/api/content-factory/plan",
                    json={"activate": True, "coverage_floor": 12, "max_types": 2})
    body = r.json()
    assert body["enqueued"] is True
    batch_id = body["batch_id"]

    # Listed for the trust cockpit.
    listed = client.get("/api/content-factory/batches").json()
    assert any(b["batch_id"] == batch_id for b in listed["batches"])
    assert listed["enabled"] is True

    rb = client.post(f"/api/content-factory/{batch_id}/rollback").json()
    assert rb["ok"] is True
    assert rb["jobs_cancelled"] >= 1

    # Rollback of an unknown batch is a 404.
    assert client.post("/api/content-factory/424242/rollback").status_code == 404
