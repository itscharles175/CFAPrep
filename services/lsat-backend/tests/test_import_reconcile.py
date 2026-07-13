"""Answer-key reconcile + persisted parse jobs (survive-restart import).

These insert a ParseJob directly rather than POSTing /import/parse, which would
hit the live structuring model — slow and nondeterministic when Ollama is up.
"""
from __future__ import annotations

from sqlmodel import Session, select
import pytest

from app import import_pdf
from app.db import engine
from app.models import ParseJob, PrepTest


def _seed_parse_job(correct: str = "B") -> int:
    parsed = {
        "name": "Reconcile Test",
        "sections": [{
            "type": "LR", "passages": [],
            "questions": [{
                "stem": "stim", "prompt": "q", "q_type": "Weaken",
                "difficulty": 3, "correct_answer": correct,
                "choices": [{"label": x, "text": f"opt {x}"} for x in "ABCDE"],
            }],
        }],
    }
    with Session(engine) as s:
        job = ParseJob(filename="t.pdf", parsed_json=parsed, warnings_json=[])
        s.add(job)
        s.commit()
        s.refresh(job)
        return job.id


def test_reconcile_flags_and_applies():
    parsed = {
        "name": "T",
        "sections": [{
            "type": "LR", "passages": [],
            "questions": [
                {"prompt": "q1", "correct_answer": "A",
                 "choices": [{"label": x, "text": x} for x in "ABCDE"]},
                {"prompt": "q2", "correct_answer": "B",
                 "choices": [{"label": x, "text": x} for x in "ABCDE"]},
            ],
        }],
    }
    key = ["A", "C"]  # q2 disagrees (parsed B vs key C)

    flagged = import_pdf.reconcile_answer_key(parsed, key, apply=False)
    assert flagged["total_questions"] == 2
    assert len(flagged["mismatches"]) == 1
    assert flagged["mismatches"][0]["index"] == 1
    assert flagged["mismatches"][0]["parsed"] == "B"
    assert flagged["mismatches"][0]["key"] == "C"
    # not applied yet
    assert parsed["sections"][0]["questions"][1]["correct_answer"] == "B"

    applied = import_pdf.reconcile_answer_key(parsed, key, apply=True)
    assert applied["applied"] is True
    assert parsed["sections"][0]["questions"][1]["correct_answer"] == "C"


def test_parse_persists_as_job_and_resumes(client):
    job_id = _seed_parse_job()
    # Simulate resuming after a restart: the parse is fetchable by id.
    j = client.get(f"/api/import/jobs/{job_id}").json()
    assert j["job_id"] == job_id
    assert j["committed"] is False
    assert j["parsed"]["sections"]

    listed = client.get("/api/import/jobs").json()
    assert any(row["job_id"] == job_id for row in listed)


def test_commit_from_job_id_only(client):
    job_id = _seed_parse_job()
    # Commit using only the job id (parsed loaded from the persisted job).
    r = client.post("/api/import/commit", json={"job_id": job_id, "source": "sample"})
    assert r.status_code == 200
    pid = r.json()["preptest_id"]
    assert pid

    j = client.get(f"/api/import/jobs/{job_id}").json()
    assert j["committed"] is True
    assert j["preptest_id"] == pid
    assert j["import_run_id"] == r.json()["import_run_id"]


def test_import_runs_history_endpoint(client):
    job_id = _seed_parse_job()
    r = client.post("/api/import/commit", json={"job_id": job_id, "source": "sample"})
    assert r.status_code == 200
    run_id = r.json()["import_run_id"]

    listed = client.get("/api/import/runs").json()["runs"]
    assert any(row["id"] == run_id and row["status"] == "done" for row in listed)


def test_commit_structure_rolls_back_failed_section(db_session):
    parsed = {
        "name": "Atomic Commit PT",
        "sections": [
            {
                "type": "LR",
                "passages": [],
                "questions": [{
                    "stem": "s1",
                    "prompt": "p",
                    "q_type": "Weaken",
                    "difficulty": 3,
                    "correct_answer": "A",
                    "choices": [{"label": x, "text": x} for x in "ABCDE"],
                }],
            },
            {"type": "NOPE", "passages": [], "questions": []},
        ],
    }

    with pytest.raises(ValueError):
        import_pdf.commit_structure(db_session, parsed, source="sample")

    pts = db_session.exec(
        select(PrepTest).where(PrepTest.name == "Atomic Commit PT")
    ).all()
    assert pts == []


def test_reconcile_endpoint_with_job(client):
    job_id = _seed_parse_job(correct="B")
    # parsed answer is "B"; assert official key "D" is flagged and applied.
    r = client.post("/api/import/reconcile",
                    json={"job_id": job_id, "answer_key": ["D"], "apply": True})
    assert r.status_code == 200
    body = r.json()
    assert body["mismatches"] and body["mismatches"][0]["key"] == "D"

    # The applied correction persisted to the job.
    j = client.get(f"/api/import/jobs/{job_id}").json()
    assert j["parsed"]["sections"][0]["questions"][0]["correct_answer"] == "D"
