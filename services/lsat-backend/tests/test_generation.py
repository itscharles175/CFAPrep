"""Tier B generation validation gate with a mocked model."""
from __future__ import annotations

import json

from app import generation


GOOD_CANDIDATE = {
    "stem": "All cats are mammals. Felix is a cat.",
    "prompt": "Which one of the following must be true?",
    "difficulty": 2,
    "correct_answer": "B",
    "choices": [
        {"label": "A", "text": "Felix is a reptile.", "trap_type": "opposite"},
        {"label": "B", "text": "Felix is a mammal okay.", "trap_type": "none"},
        {"label": "C", "text": "All mammals are cats here.", "trap_type": "reversal"},
        {"label": "D", "text": "Felix is not an animal!", "trap_type": "out_of_scope"},
        {"label": "E", "text": "Some cats are not mammals.", "trap_type": "degree"},
    ],
}


def test_validate_passes_good_candidate():
    def solver(prompt):
        return "The answer is B"

    def critic(prompt):
        return json.dumps({"single_defensible": True, "defensible_letters": ["B"]})

    # Permutation + informativity gates are disabled in the test suite via
    # conftest env (they need a real solver). Smarter stubs exercise them
    # in dedicated tests.
    report = generation.validate_candidate(GOOD_CANDIDATE, runs=3,
                                           solver=solver, critic=critic)
    assert report["passed"] is True
    assert report["checks"]["self_consistency"] == "3/3"
    assert report["checks"]["trap_metadata"]["ok"] is True


def test_validate_rejects_bad_trap_metadata_without_model_call():
    bad = {**GOOD_CANDIDATE, "choices": [dict(c) for c in GOOD_CANDIDATE["choices"]]}
    bad["choices"][0].pop("trap_type")

    def boom(_prompt: str) -> str:
        raise AssertionError("trap metadata failure must not call the model")

    report = generation.validate_candidate(bad, runs=3, solver=boom, critic=boom)

    assert report["passed"] is False
    assert report["reason"] == "trap_metadata"
    assert report["checks"]["trap_metadata"]["ok"] is False
    assert report["checks"]["trap_metadata"]["problems"] == [
        {"label": "A", "reason": "missing_trap_type"}
    ]
    assert "deterministic_solve" not in report["checks"]


def test_validate_fails_self_consistency():
    answers = iter(["A", "B", "C"])

    def solver(prompt):
        return next(answers)

    def critic(prompt):
        return json.dumps({"single_defensible": True, "defensible_letters": ["B"]})

    report = generation.validate_candidate(GOOD_CANDIDATE, runs=3,
                                           solver=solver, critic=critic)
    assert report["passed"] is False
    assert report["reason"] == "self_consistency"


def test_validate_fails_single_defensible_wrong_letter():
    def solver(prompt):
        return "The answer is B"

    def critic(prompt):
        if "strict LSAT item reviewer" not in prompt:
            return "The answer is B"
        return json.dumps({"single_defensible": True, "defensible_letters": ["C"]})

    report = generation.validate_candidate(
        GOOD_CANDIDATE, runs=3, solver=solver, critic=critic
    )
    assert report["passed"] is False
    assert report["reason"] == "ambiguous_answer"
    assert report["checks"]["single_defensible"] is False
    assert report["checks"]["single_defensible_detail"] == {
        "defensible_letters": ["C"],
        "credited": "B",
    }


def test_validate_passes_with_distractor_quality_gate(monkeypatch):
    from app import config

    monkeypatch.setattr(config, "GEN_DISTRACTOR_QUALITY_CHECK", True)

    def solver(prompt):
        return "The answer is B"

    def critic(prompt):
        if "distractor-quality reviewer" in prompt:
            return json.dumps({
                "distractors_plausible": True,
                "plausible_labels": ["A", "C", "D", "E"],
                "weak_distractors": [],
            })
        return json.dumps({"single_defensible": True, "defensible_letters": ["B"]})

    report = generation.validate_candidate(
        GOOD_CANDIDATE, runs=3, solver=solver, critic=critic
    )

    assert report["passed"] is True
    assert report["checks"]["distractor_quality"] == {
        "ok": True,
        "skipped": False,
        "reason": None,
        "expected_labels": ["A", "C", "D", "E"],
        "plausible_labels": ["A", "C", "D", "E"],
        "weak_distractors": [],
        "covers_all": True,
    }


def test_validate_rejects_weak_distractors(monkeypatch):
    from app import config

    monkeypatch.setattr(config, "GEN_DISTRACTOR_QUALITY_CHECK", True)

    def solver(prompt):
        return "The answer is B"

    def critic(prompt):
        if "distractor-quality reviewer" in prompt:
            return json.dumps({
                "distractors_plausible": False,
                "plausible_labels": ["A", "C", "E"],
                "weak_distractors": [
                    {"label": "D", "reason": "irrelevant throwaway"}
                ],
            })
        return json.dumps({"single_defensible": True, "defensible_letters": ["B"]})

    report = generation.validate_candidate(
        GOOD_CANDIDATE, runs=3, solver=solver, critic=critic
    )

    assert report["passed"] is False
    assert report["reason"] == "weak_distractors"
    assert report["checks"]["distractor_quality"]["ok"] is False
    assert report["checks"]["distractor_quality"]["covers_all"] is False


def test_validate_rejects_unverified_distractor_quality(monkeypatch):
    from app import config

    monkeypatch.setattr(config, "GEN_DISTRACTOR_QUALITY_CHECK", True)

    def solver(prompt):
        return "The answer is B"

    def critic(prompt):
        return json.dumps({"single_defensible": True, "defensible_letters": ["B"]})

    report = generation.validate_candidate(
        GOOD_CANDIDATE, runs=3, solver=solver, critic=critic
    )

    assert report["passed"] is False
    assert report["reason"] == "distractor_quality_unverified"
    assert report["checks"]["distractor_quality"]["plausible_labels"] == []


def test_validate_fails_structural():
    bad = {"stem": "x", "prompt": "y", "correct_answer": "B",
           "choices": [{"label": "A", "text": "only one"}]}
    report = generation.validate_candidate(bad, runs=2)
    assert report["passed"] is False
    assert report["reason"] == "structural"


def test_run_job_end_to_end_mocked(db_session):
    from app.models import GenJob, GenStatus, Question, QuestionSource
    from app.db import engine
    from sqlmodel import Session, select

    # craft a fake model that returns a generate JSON, then solves, then critiques
    state = {"phase": 0}

    def fake_model(prompt):
        if "Write ONE original" in prompt:
            return json.dumps(GOOD_CANDIDATE)
        if "Solve this LSAT" in prompt:
            return "B"
        if "strict LSAT item reviewer" in prompt:
            return json.dumps({"single_defensible": True, "defensible_letters": ["B"]})
        return "B"

    with Session(engine) as s:
        job = GenJob(q_type="Inference", count=1, status=GenStatus.queued)
        s.add(job)
        s.commit()
        s.refresh(job)
        job_id = job.id

    generation.run_job(job_id, generate=fake_model)

    with Session(engine) as s:
        job = s.get(GenJob, job_id)
        assert job.status == GenStatus.done
        assert job.produced == 1
        assert job.accepted == 1
        assert job.quarantined == 0
        # accepted item is ai_generated, approved, not quarantined, has parent set
        gen_qs = s.exec(
            select(Question).where(Question.source == QuestionSource.ai_generated)
        ).all()
        assert len(gen_qs) == 1
        assert gen_qs[0].approved is True
        assert gen_qs[0].quarantined is False


def test_quarantine_endpoints(client):
    # create an ai_generated quarantined question directly
    from app.db import engine
    from app.models import AnswerChoice, Question, QuestionSource
    from sqlmodel import Session

    with Session(engine) as s:
        q = Question(stem="q", prompt="p", correct_answer="A", q_type="Flaw",
                     source=QuestionSource.ai_generated, quarantined=True,
                     approved=False)
        s.add(q)
        s.commit()
        s.refresh(q)
        for lbl in "ABCDE":
            s.add(AnswerChoice(question_id=q.id, label=lbl, text=f"choice {lbl}",
                               is_correct=(lbl == "A")))
        s.commit()
        qid = q.id

    items = client.get("/api/gen/quarantine").json()
    assert any(it["id"] == qid for it in items)

    r = client.post(f"/api/gen/quarantine/{qid}/approve")
    assert r.json() == {"ok": True}
    # after approval, no longer in quarantine
    items2 = client.get("/api/gen/quarantine").json()
    assert all(it["id"] != qid for it in items2)


def test_generation_api_rejects_invalid_counts_and_bounds(client):
    bad_posts = [
        ("/api/gen/jobs", {"q_type": "Inference", "count": 0}),
        ("/api/gen/jobs", {"q_type": "Inference", "count": 51}),
        ("/api/gen/jobs", {"q_type": " ", "count": 1}),
        ("/api/gen/jobs", {"q_type": "Inference", "parent_question_id": 0}),
        ("/api/gen/for-type", {"q_type": "Inference", "count": 0}),
        ("/api/gen/for-type", {"q_type": "Inference", "count": 51}),
        ("/api/gen/calibrate-difficulty", {"min_attempts": 0}),
    ]
    for path, payload in bad_posts:
        r = client.post(path, json=payload)
        assert r.status_code == 422

    assert client.get("/api/gen/jobs?limit=0").status_code == 422
    assert client.get("/api/gen/jobs?limit=201").status_code == 422
    assert client.get("/api/gen/drift?min_attempts=0").status_code == 422
    assert client.get("/api/gen/drift?floor=1.01").status_code == 422
