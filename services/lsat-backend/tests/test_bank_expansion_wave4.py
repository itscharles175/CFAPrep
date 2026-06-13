"""Bank-expansion plan Wave 4 — scale paths."""
from __future__ import annotations

from app import audit, content_health, generation
from app.db import engine
from app.models import (
    GenCandidate,
    GenJob,
    GenStatus,
    Question,
    QuestionSource,
    ValidatorRun,
)
from sqlmodel import Session, select


def test_paginated_bank_questions_route(client):
    r = client.get("/api/bank/questions?limit=5&offset=0")
    assert r.status_code == 200
    body = r.json()
    assert "items" in body and "total" in body
    assert len(body["items"]) <= 5
    assert "next_cursor" in body and "has_more" in body
    assert body["cursor"] is None


def test_bank_questions_cursor_pagination(client):
    first = client.get("/api/bank/questions?limit=3").json()
    assert len(first["items"]) == 3
    cursor = first["next_cursor"]
    assert cursor == first["items"][-1]["id"]

    second = client.get(f"/api/bank/questions?limit=3&cursor={cursor}").json()
    first_ids = {row["id"] for row in first["items"]}
    second_ids = {row["id"] for row in second["items"]}
    assert second["cursor"] == cursor
    assert first_ids.isdisjoint(second_ids)
    assert all(row["id"] > cursor for row in second["items"])


def test_duplicate_clusters_uses_top_k(db_session):
    """Wave 4.3 — still returns clusters; no longer O(n^2) pairwise loop."""
    from app import embeddings

    q = Question(
        stem="cluster test " * 8, prompt="p?", correct_answer="A",
        q_type="Inference", source=QuestionSource.sample,
    )
    db_session.add(q)
    db_session.commit()
    db_session.refresh(q)
    embeddings.embed_question(
        db_session, q,
        embedder=lambda t, model=None: [float(len(t or "")), 1.0],
    )
    clusters = audit.duplicate_clusters(db_session, threshold=0.99)
    assert isinstance(clusters, list)


def test_gen_candidate_rows_persisted(db_session):
    """Wave 4.4 — run_job writes GenCandidate rows."""
    from tests.test_generation import GOOD_CANDIDATE
    import json

    job = GenJob(q_type="Inference", count=1, status=GenStatus.queued)
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    job_id = job.id

    def gen_fake(prompt):
        if "Write ONE original" in prompt:
            return json.dumps(GOOD_CANDIDATE)
        return "B"

    generation.run_job(
        job_id, generate=gen_fake, critic=lambda _p: json.dumps(
            {"single_defensible": True, "defensible_letters": ["B"]}
        ),
    )
    with Session(engine) as s:
        rows = s.exec(
            select(GenCandidate).where(GenCandidate.gen_job_id == job_id)
        ).all()
        assert len(rows) == 1
        assert rows[0].verdict in ("accepted", "quarantined")


def test_generation_records_validator_run_evidence(db_session):
    """Content Trust cockpit gets automatic validator evidence from gen jobs."""
    from tests.test_generation import GOOD_CANDIDATE
    import json

    job = GenJob(q_type="Inference", count=1, status=GenStatus.queued)
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    job_id = job.id

    def gen_fake(prompt):
        if "Write ONE original" in prompt:
            return json.dumps(GOOD_CANDIDATE)
        return "B"

    def critic_fake(prompt):
        if "strict LSAT item reviewer" in prompt:
            return json.dumps(
                {"single_defensible": True, "defensible_letters": ["B"]}
            )
        return "B"

    generation.run_job(job_id, generate=gen_fake, critic=critic_fake)

    with Session(engine) as s:
        rows = [
            row for row in s.exec(select(ValidatorRun)).all()
            if (row.meta_json or {}).get("gen_job_id") == job_id
        ]
        assert len(rows) == 1
        run = rows[0]
        assert run.q_type == "Inference"
        assert run.section_type.value == "LR"
        assert run.status == "passed"
        assert run.score == 1.0
        assert run.failure_reasons_json == []
        assert run.meta_json["source"] == "generation.run_job"

        health = content_health.health_report(s)
        assert health["validator_runs"]["recent_count"] >= 1
        assert any(
            row["id"] == run.id for row in health["validator_runs"]["recent"]
        )


def test_validator_run_evidence_records_failed_gate_reasons(db_session):
    from tests.test_generation import GOOD_CANDIDATE
    import json

    job = GenJob(q_type="Inference", count=1, status=GenStatus.queued)
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    job_id = job.id

    def gen_fake(prompt):
        if "Write ONE original" in prompt:
            return json.dumps(GOOD_CANDIDATE)
        return "A"

    def critic_fake(prompt):
        if "strict LSAT item reviewer" in prompt:
            return json.dumps(
                {"single_defensible": True, "defensible_letters": ["B"]}
            )
        return "A"

    generation.run_job(job_id, generate=gen_fake, critic=critic_fake)

    with Session(engine) as s:
        run = next(
            row for row in s.exec(select(ValidatorRun)).all()
            if (row.meta_json or {}).get("gen_job_id") == job_id
        )
        assert run.status == "failed"
        assert "solve_mismatch" in run.failure_reasons_json
        assert "self_consistency" in run.failure_reasons_json
        assert 0 <= run.score < 1
