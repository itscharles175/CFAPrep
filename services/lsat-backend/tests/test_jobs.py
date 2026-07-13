"""Durable job queue: enqueue, worker drain, orphan reconcile, plan activation."""
from __future__ import annotations

import time

from sqlmodel import Session

from app import jobs
from app.db import engine
from app.models import GenJob, GenStatus


def test_enqueue_and_activate(db_session):
    # planned jobs are ignored by the worker until activated.
    jid = jobs.enqueue(db_session, "Flaw", 2, status=GenStatus.planned)
    assert db_session.get(GenJob, jid).status == GenStatus.planned

    n = jobs.activate_jobs(db_session, [jid])
    assert n == 1
    assert db_session.get(GenJob, jid).status == GenStatus.queued

    # activating an already-queued job is a no-op.
    assert jobs.activate_jobs(db_session, [jid]) == 0


def test_reconcile_orphans_marks_running_failed(db_session):
    jid = jobs.enqueue(db_session, "Weaken", 1, status=GenStatus.running)
    n = jobs.reconcile_orphans(engine)
    assert n >= 1
    refreshed = db_session.get(GenJob, jid)
    db_session.refresh(refreshed)
    assert refreshed.status == GenStatus.failed
    assert (refreshed.validation_report or {}).get("interrupted") is True


def test_worker_drains_queued_jobs(db_session):
    ran: list[int] = []

    def fake_runner(job_id: int) -> None:
        with Session(engine) as s:
            job = s.get(GenJob, job_id)
            job.status = GenStatus.done
            job.accepted = 1
            s.add(job)
            s.commit()
        ran.append(job_id)

    jid = jobs.enqueue(db_session, "Inference", 1, status=GenStatus.queued)

    worker = jobs.JobWorker(engine, runner=fake_runner, poll_interval=0.05)
    worker.start()
    try:
        deadline = time.time() + 5
        while time.time() < deadline:
            with Session(engine) as s:
                if s.get(GenJob, jid).status == GenStatus.done:
                    break
            time.sleep(0.05)
    finally:
        worker.stop()

    assert ran == [jid]
    with Session(engine) as s:
        assert s.get(GenJob, jid).status == GenStatus.done


def test_worker_retries_zero_output_failed_job(db_session):
    calls: list[str] = []

    def flaky_runner(job_id: int) -> None:
        with Session(engine) as s:
            job = s.get(GenJob, job_id)
            if not calls:
                calls.append("failed")
                job.status = GenStatus.failed
                job.validation_report = {"error": "temporary model outage"}
            else:
                calls.append("done")
                job.status = GenStatus.done
                job.accepted = 1
                job.progress_pct = 100.0
            s.add(job)
            s.commit()

    jid = jobs.enqueue(db_session, "Inference", 1, status=GenStatus.queued, max_retries=1)

    worker = jobs.JobWorker(engine, runner=flaky_runner, poll_interval=0.05)
    worker.start()
    try:
        deadline = time.time() + 5
        while time.time() < deadline:
            with Session(engine) as s:
                row = s.get(GenJob, jid)
                if row.status == GenStatus.done and len(calls) == 2:
                    break
            time.sleep(0.05)
    finally:
        worker.stop()

    assert calls == ["failed", "done"]
    with Session(engine) as s:
        row = s.get(GenJob, jid)
        assert row.status == GenStatus.done
        assert row.retry_count == 1


def test_retry_failed_job_blocks_partial_output(db_session):
    jid = jobs.enqueue(db_session, "Flaw", 2, status=GenStatus.queued, max_retries=1)
    job = db_session.get(GenJob, jid)
    job.status = GenStatus.failed
    job.produced = 1
    job.validation_report = {"error": "failed after persisting one candidate"}
    db_session.add(job)
    db_session.commit()

    result = jobs.retry_failed_job(db_session, jid)

    assert result == {"ok": False, "reason": "partial_outputs_present"}
    refreshed = db_session.get(GenJob, jid)
    assert refreshed.status == GenStatus.failed
    assert (refreshed.validation_report or {}).get("retry_blocked") == "partial_outputs_present"


def test_worker_ignores_planned_jobs(db_session):
    ran: list[int] = []
    jid = jobs.enqueue(db_session, "Flaw", 1, status=GenStatus.planned)

    worker = jobs.JobWorker(engine, runner=lambda j: ran.append(j), poll_interval=0.05)
    worker.start()
    time.sleep(0.3)
    worker.stop()

    assert ran == []
    assert db_session.get(GenJob, jid).status == GenStatus.planned


def test_create_job_endpoint_enqueues_without_running(client):
    r = client.post("/api/gen/jobs", json={"q_type": "Flaw", "count": 2})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "queued"
    jid = body["job_id"]

    # listed in the queue, still queued (worker disabled in tests).
    listed = client.get("/api/gen/jobs").json()
    row = next(j for j in listed if j["id"] == jid)
    assert row["status"] == "queued"
    assert row["q_type"] == "Flaw"
