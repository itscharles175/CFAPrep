"""Generation scaling + the end-to-end bank-bootstrap orchestrator."""
from __future__ import annotations

import json
from pathlib import Path

from sqlmodel import Session, select

from app import bank_bootstrap, generation, import_dataset
from app.db import engine
from app.import_dataset import import_dataset as run_import, read_jsonl
from app.models import (
    AnswerChoice,
    GenJob,
    GenStatus,
    Question,
    QuestionSource,
)

FIXTURES = Path(__file__).parent / "fixtures"


GOOD_CANDIDATE = {
    "stem": (
        "Consultant: After a company introduced a new training program, its "
        "reported productivity rose by 18 percent. Therefore, the program "
        "probably caused the improvement."
    ),
    "prompt": "Which one of the following would be most useful to know in order to evaluate the consultant's argument?",
    "difficulty": 2,
    "correct_answer": "B",
    "choices": [
        {"label": "A", "text": "Whether the program was popular with employees who completed it.", "trap_type": "out_of_scope"},
        {"label": "B", "text": "Whether productivity was measured the same way before and after the program.", "trap_type": "none"},
        {"label": "C", "text": "Whether the company plans to offer the same program again next year.", "trap_type": "out_of_scope"},
        {"label": "D", "text": "Whether any other companies have used training programs for managers in unrelated industries.", "trap_type": "irrelevant_comparison"},
        {"label": "E", "text": "Whether productivity can ever rise for reasons unrelated to training.", "trap_type": "too_strong"},
    ],
}


def _stub_model(prompt: str) -> str:
    if "Write ONE original" in prompt:
        return json.dumps(GOOD_CANDIDATE)
    if "Solve this LSAT" in prompt:
        return "B"
    if "strict LSAT item reviewer" in prompt:
        return json.dumps({"single_defensible": True, "defensible_letters": ["B"]})
    return "B"


def test_run_job_rotates_through_eligible_parents(db_session):
    """When the job has no pinned parent, each variation should anchor to a
    different real parent of the same q_type.

    Uses q_type="Evaluate" so the seed bank does not contribute extra parents
    and the rotation distribution is exact.
    """
    parents: list[Question] = []
    for i in range(2):
        q = Question(
            stem=f"stem {i}", prompt="prompt", correct_answer="A",
            q_type="Evaluate", source=QuestionSource.research,
        )
        db_session.add(q)
        db_session.commit()
        db_session.refresh(q)
        for lbl in "ABCDE":
            db_session.add(AnswerChoice(
                question_id=q.id, label=lbl, text=f"opt {lbl}",
                is_correct=(lbl == "A"),
            ))
        db_session.commit()
        parents.append(q)

    job = GenJob(q_type="Evaluate", count=4, status=GenStatus.queued)
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    job_id = job.id

    generation.run_job(job_id, generate=_stub_model)

    # Round-robin gives a 2-2 split across the two parents.
    with Session(engine) as s:
        finished = s.get(GenJob, job_id)
        assert finished.status == GenStatus.done
        assert finished.accepted == 4
        report = finished.validation_report or {}
        cands = report.get("candidates") or []
        parent_ids = [c.get("parent_question_id") for c in cands]
        assert parent_ids.count(parents[0].id) == 2
        assert parent_ids.count(parents[1].id) == 2


def test_run_job_respects_pinned_parent(db_session):
    p1 = Question(stem="A", prompt="p", correct_answer="A", q_type="Evaluate",
                  source=QuestionSource.research)
    p2 = Question(stem="B", prompt="p", correct_answer="A", q_type="Evaluate",
                  source=QuestionSource.research)
    db_session.add(p1)
    db_session.add(p2)
    db_session.commit()
    db_session.refresh(p1)
    db_session.refresh(p2)

    job = GenJob(q_type="Evaluate", count=3, status=GenStatus.queued,
                 parent_question_id=p1.id)
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    job_id = job.id

    generation.run_job(job_id, generate=_stub_model)

    with Session(engine) as s:
        cands = (s.get(GenJob, job_id).validation_report or {}).get("candidates") or []
        assert all(c.get("parent_question_id") == p1.id for c in cands)


def test_plan_generation_jobs_distributes_by_sqrt_weight(db_session):
    """A type with 4 anchors should get roughly 2x the share of one with 1."""
    base_total = bank_bootstrap.bank_stats(db_session).total

    # Use q_types not seeded so we can compare cleanly. 4 Evaluate anchors,
    # 1 Method anchor.
    for i in range(4):
        db_session.add(Question(
            stem=f"e{i}", prompt="p", correct_answer="A", q_type="Evaluate",
            source=QuestionSource.research,
        ))
    db_session.add(Question(
        stem="m0", prompt="p", correct_answer="A", q_type="Method",
        source=QuestionSource.research,
    ))
    db_session.commit()

    plan = bank_bootstrap.plan_generation_jobs(
        db_session,
        # Large deficit so the per-type cap doesn't truncate either bucket.
        target_total=base_total + 500,
        per_type_cap=100,
        min_anchors=1,
    )
    by_type = dict(plan)
    assert "Evaluate" in by_type and "Method" in by_type
    # sqrt(4)/sqrt(1) == 2: Evaluate should be ~2x Method (1 unit slack for rounding).
    assert by_type["Evaluate"] >= by_type["Method"] * 2 - 1
    assert by_type["Evaluate"] <= by_type["Method"] * 2 + 1


def test_plan_skips_types_below_min_anchors(db_session):
    # Use "Evaluate" — not present in the seed bank — so we can guarantee a
    # single anchor and verify the min_anchors threshold filters it out.
    db_session.add(Question(
        stem="s", prompt="p", correct_answer="A", q_type="Evaluate",
        source=QuestionSource.research,
    ))
    db_session.commit()
    plan = bank_bootstrap.plan_generation_jobs(
        db_session,
        target_total=bank_bootstrap.bank_stats(db_session).total + 10,
        min_anchors=2,
    )
    assert all(qt != "Evaluate" for qt, _ in plan)


def test_bank_stats_groups_by_source_and_type(db_session):
    # Seed already loaded 13 sample questions. Add a research one.
    db_session.add(Question(
        stem="r", prompt="p", correct_answer="A", q_type="Inference",
        source=QuestionSource.research,
    ))
    db_session.commit()

    stats = bank_bootstrap.bank_stats(db_session)
    assert stats.total >= 14
    assert stats.by_source.get("research", 0) >= 1
    assert stats.by_source.get("sample", 0) >= 13
    assert "Inference" in stats.by_q_type


def test_bootstrap_pipeline_with_fixtures_and_stubbed_runner(db_session):
    """End-to-end: import fixture, tag, queue generation against a stub runner."""

    called: list[int] = []

    def fake_runner(job_id: int) -> None:
        # Mark the job done without touching the model.
        with Session(engine) as s:
            job = s.get(GenJob, job_id)
            job.status = GenStatus.done
            job.accepted = 1
            job.produced = 1
            s.add(job)
            s.commit()
        called.append(job_id)

    result = bank_bootstrap.bootstrap(
        db_session,
        target_total=bank_bootstrap.bank_stats(db_session).total + 30,
        fixtures_dir=str(FIXTURES),
        tag_limit=100,
        per_type_cap=10,
        runner=fake_runner,
    )

    # Research rows from all three fixture files were committed.
    assert result.inserted_research > 0
    # Tagging touched the imported items.
    assert result.tagged > 0
    # The orchestrator queued at least one generation job.
    assert len(result.job_ids) > 0
    # And our stub runner was invoked for each queued job.
    assert called == result.job_ids
