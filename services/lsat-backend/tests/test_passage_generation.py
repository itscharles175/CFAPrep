"""LSAT-5 — passage-first RC generation end-to-end + migration 26.

Covers:
  * migration 26 adds the ``genjob.passage_first`` column,
  * the legacy single-candidate path is UNCHANGED when ``passage_first`` is False
    (an LR job still emits one item per loop iteration),
  * the passage-first path generates ONE passage, analyzes it, and attaches a
    varied set of questions all sharing that passage_id,
  * atomicity: a failed passage fails the whole job and writes NO questions,
  * the route layer (POST start / GET questions / GET progress).

All model calls are deterministic stubs; no Ollama/LM Studio is touched.
"""
from __future__ import annotations

import json

import pytest
from sqlmodel import Session, select

from app import generation, passage_generator
from app.db import engine
from app.models import (
    AnswerChoice, GenCandidate, GenJob, GenStatus, Passage, Question,
    QuestionSource, RCPassageAnalysis,
)


@pytest.fixture(autouse=True)
def _ensure_passage_router_mounted():
    """Mount the passage-first router on the app for the route tests.

    The production wiring lives in ``app/main.py`` (registered by the wave's wire
    step). This fixture mounts it idempotently so these tests pass standalone too;
    once main.py includes it, the guard makes this a no-op (no duplicate routes).
    """
    from app.main import app
    from app.routers import passage_routes

    already = any(
        getattr(r, "path", "") == "/api/generation/passages"
        for r in app.router.routes
    )
    if not already:
        app.include_router(passage_routes.router, prefix="/api")
        app.openapi_schema = None  # force regen so the new routes are reachable
    yield


# A long, varied RC passage (~290 words) that comfortably clears the Wave 2.3
# hard RC gate (>= 250 words, varied sentence lengths, FKGL in band).
_PASSAGE = (
    "Recent scholarship on urban heat islands has shifted from merely "
    "describing the phenomenon to modeling its causes. Earlier work, much of "
    "it conducted in the late twentieth century, emphasized impervious paved "
    "surfaces — asphalt streets, dark rooftops, and the unbroken concrete "
    "expanses of downtowns — as the principal driver of nighttime temperature "
    "anomalies. Newer studies, however, foreground a more complex picture in "
    "which two additional forcings dominate. The first is anthropogenic heat: "
    "the cumulative thermal output of buildings, vehicles, and especially the "
    "ubiquitous air conditioners whose operation, paradoxically, exacerbates "
    "the very condition they ease indoors. The second is the loss of "
    "evapotranspiration from vegetation, a cooling pathway that effectively "
    "vanishes as tree canopy is replaced by hard surface. Together these "
    "factors can account for nighttime temperature differentials of three to "
    "five degrees Celsius relative to surrounding rural land. Critics counter "
    "that such models still understate localized nighttime effects, partly "
    "because they treat anthropogenic heat as a smooth diurnal average rather "
    "than as the spiky, building-scale phenomenon it is. They note, too, that "
    "regional climate, prevailing winds, and street geometry interact in ways "
    "that resist simple parameterization. Even supporters concede that "
    "downscaled climate projections inherit considerable uncertainty when "
    "applied at the city block. What is no longer in dispute is that the heat "
    "island is not a single mechanism but a layered system. Public-health "
    "planners, who once treated the problem as one of paving choices alone, "
    "now appeal for greener corridors, lighter roofing, and tighter building "
    "envelopes — interventions that target each of the three principal "
    "forcings simultaneously rather than serially."
)


def _question_candidate(prompt: str, *, correct: str = "B") -> dict:
    # Choice lengths balanced so the correct answer (B) is neither uniquely
    # longest (A) nor uniquely shortest (C): avoids the no-length-tell guard.
    return {
        "stem": "",
        "prompt": prompt,
        "difficulty": 3,
        "correct_answer": correct,
        "choices": [
            {"label": "A", "text": "Urban heat islands arise exclusively from impervious paved surfaces and from no other contributing factor whatsoever.", "trap_type": "too_strong"},
            {"label": "B", "text": "Scholarship has shifted from describing heat islands to modeling their layered causes.", "trap_type": "none"},
            {"label": "C", "text": "Vegetation has no effect on city temperatures.", "trap_type": "opposite"},
            {"label": "D", "text": "Nighttime effects are the only outcome these newer models capture.", "trap_type": "degree"},
            {"label": "E", "text": "Critics have come to reject all computational modeling of urban heat.", "trap_type": "out_of_scope"},
        ],
    }


def _passage_obj() -> dict:
    return {"passage": _PASSAGE, "topic": "urban heat islands", "type": "single"}


def _make_stub(*, prompts: list[str] | None = None):
    """A deterministic generator+critic stub for the passage-first gate.

    Recognizes the passage-only prompt, the per-question prompt, the solve
    prompts, and every critic prompt (single-defensible, RC grounding, RC
    semantic) and answers each so a clean candidate PASSES the full gate.
    """

    def stub(prompt: str) -> str:
        if prompts is not None:
            prompts.append(prompt)
        # Passage-only first pass.
        if "Do NOT write any questions yet" in prompt:
            return json.dumps(_passage_obj())
        # Per-question second pass: pick a prompt that matches the q_type asked.
        if "Write ONE original question of type" in prompt:
            if "'Inference'" in prompt:
                return json.dumps(_question_candidate(
                    "The passage suggests which one of the following about newer models?"))
            if "'Detail'" in prompt:
                return json.dumps(_question_candidate(
                    "According to the passage, which factor did newer studies foreground?"))
            if "'Function'" in prompt:
                return json.dumps(_question_candidate(
                    "The phrase about air conditioners in the passage functions primarily to do which of the following?"))
            if "'Attitude'" in prompt:
                return json.dumps(_question_candidate(
                    "The author's attitude toward the newer models is best described as which of the following?"))
            # default / MainPoint
            return json.dumps(_question_candidate(
                "Which one of the following most accurately states the main point of the passage?"))
        # Gate critic prompts.
        if "strict LSAT item reviewer" in prompt:
            return json.dumps({"single_defensible": True, "defensible_letters": ["B"]})
        if "validating a generated LSAT Reading Comprehension item" in prompt:
            # Covers BOTH the grounding validator and the LSAT-5 semantic critic
            # prompts (they share this opening). Provide every key either could read.
            return json.dumps({
                "credited_supported_by_passage": True,
                "requires_outside_knowledge": False,
                "single_best_answer": True,
                "coheres_with_whole_passage": True,
                "has_explicit_textual_basis": True,
                "follows_from_passage": True,
                "distractor_flaws": [
                    {"label": "A", "flaw": "too strong", "clear": True},
                    {"label": "C", "flaw": "contradicts the passage", "clear": True},
                    {"label": "D", "flaw": "overstates", "clear": True},
                    {"label": "E", "flaw": "out of scope", "clear": True},
                ],
            })
        # Solve / CoVe / self-consistency.
        return "B"

    return stub


def _no_embed(_text: str) -> list[float]:
    return []


# --- migration 26 -----------------------------------------------------------
def test_migration_26_adds_passage_first_column(db_session):
    # Use the engine directly for PRAGMA (sqlmodel select can't express it).
    with engine.begin() as conn:
        info = conn.exec_driver_sql("PRAGMA table_info(genjob)").fetchall()
        version = conn.exec_driver_sql("PRAGMA user_version").fetchone()[0]
    names = {str(r[1]) for r in info}
    assert "passage_first" in names
    assert int(version) >= 26


def test_passage_first_defaults_false(db_session):
    job = GenJob(q_type="MainPoint", count=3, status=GenStatus.queued)
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    assert job.passage_first is False


# --- legacy single-candidate path UNCHANGED ---------------------------------
def test_legacy_single_candidate_lr_path_unchanged(db_session):
    """An LR job with passage_first=False still emits ONE item per iteration."""
    parent = Question(
        stem="A study found that office workers who took short walks reported "
             "higher afternoon focus, so the firm mandated walking breaks.",
        prompt="Which one of the following most weakens the argument?",
        correct_answer="A",
        q_type="Weaken",
        source=QuestionSource.research,
    )
    db_session.add(parent)
    db_session.commit()
    db_session.refresh(parent)
    for lbl in "ABCDE":
        db_session.add(AnswerChoice(question_id=parent.id, label=lbl, text=f"opt {lbl}",
                                    is_correct=(lbl == "A")))
    db_session.commit()

    job = GenJob(q_type="Weaken", count=1, status=GenStatus.queued,
                 parent_question_id=parent.id)
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    job_id = job.id

    def lr_stub(prompt: str) -> str:
        if "Write ONE original LSAT-style Logical Reasoning" in prompt:
            return json.dumps(_question_candidate(
                "Which one of the following most weakens the argument?"))
        if "strict LSAT item reviewer" in prompt:
            return json.dumps({"single_defensible": True, "defensible_letters": ["B"]})
        if "testing a candidate LSAT 'Weaken' answer" in prompt:
            return json.dumps({"weakens": True})
        return "B"

    generation.run_job(job_id, generate=lr_stub, embedder=_no_embed)
    with Session(engine) as s:
        finished = s.get(GenJob, job_id)
        assert finished.status == GenStatus.done
        assert finished.passage_first is False
        report = finished.validation_report
        # Legacy report shape: no passage_first marker.
        assert "passage_first" not in report
        assert len(report["candidates"]) == 1


# --- passage-first happy path -----------------------------------------------
def test_passage_first_job_attaches_varied_questions(db_session):
    job = GenJob(q_type="MainPoint", count=4, status=GenStatus.queued,
                 passage_first=True)
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    job_id = job.id

    prompts: list[str] = []
    generation.run_job(job_id, generate=_make_stub(prompts=prompts), embedder=_no_embed)

    with Session(engine) as s:
        finished = s.get(GenJob, job_id)
        assert finished.status == GenStatus.done
        assert finished.passage_first is True
        report = finished.validation_report
        assert report["passage_first"] is True
        # One passage produced + 4 questions = 5 produced steps.
        assert finished.produced == 5
        assert finished.accepted == 4

        # All generated questions share ONE passage_id.
        gen_qs = s.exec(
            select(Question).where(Question.source == QuestionSource.ai_generated)
        ).all()
        assert len(gen_qs) == 4
        passage_ids = {q.passage_id for q in gen_qs}
        assert len(passage_ids) == 1
        the_passage_id = passage_ids.pop()
        assert the_passage_id is not None
        # Varied q_types (the lead MainPoint + the rotation).
        assert {q.q_type for q in gen_qs} == {"MainPoint", "Inference", "Detail", "Function"}

        # The passage was persisted and analyzed eagerly.
        pas = s.get(Passage, the_passage_id)
        assert pas is not None and "heat island" in pas.text
        analysis = s.exec(
            select(RCPassageAnalysis).where(RCPassageAnalysis.passage_id == the_passage_id)
        ).first()
        assert analysis is not None

        # The passage-only prompt was emitted (no questions in it).
        assert any("Do NOT write any questions yet" in p for p in prompts)
        # GenCandidate rows recorded for each question.
        cands = s.exec(select(GenCandidate).where(GenCandidate.gen_job_id == job_id)).all()
        assert sum(1 for c in cands if c.verdict == "accepted") == 4


def test_passage_first_question_types_helper_respects_count():
    job = GenJob(q_type="Inference", count=3, passage_first=True)
    types = passage_generator._question_types_for(job)
    assert types[0] == "Inference"
    assert len(types) == 3
    assert len(set(types)) == len(types)  # no repeats


# --- atomicity: passage failure -> whole job fails, no questions ------------
def test_passage_first_atomic_failure_writes_no_questions(db_session):
    job = GenJob(q_type="MainPoint", count=4, status=GenStatus.queued,
                 passage_first=True)
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    job_id = job.id

    def bad_passage_stub(prompt: str) -> str:
        if "Do NOT write any questions yet" in prompt:
            # A one-line "passage" that fails the RC authenticity gate (too short).
            return json.dumps({"passage": "Too short to be a real passage.", "type": "single"})
        raise AssertionError("no question should be generated when the passage fails")

    generation.run_job(job_id, generate=bad_passage_stub, embedder=_no_embed)

    with Session(engine) as s:
        finished = s.get(GenJob, job_id)
        assert finished.status == GenStatus.failed
        # No questions, no passages were written for this failed job.
        gen_qs = s.exec(
            select(Question).where(Question.source == QuestionSource.ai_generated)
        ).all()
        assert gen_qs == []
        report = finished.validation_report
        assert report["candidates"][0]["is_passage"] is True
        assert report["candidates"][0]["reason"].startswith("rc_authenticity")


def test_passage_first_unparseable_passage_fails_job(db_session):
    job = GenJob(q_type="MainPoint", count=3, status=GenStatus.queued,
                 passage_first=True)
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    job_id = job.id

    generation.run_job(job_id, generate=lambda _p: "not json", embedder=_no_embed)
    with Session(engine) as s:
        finished = s.get(GenJob, job_id)
        assert finished.status == GenStatus.failed
        assert finished.validation_report["candidates"][0]["reason"] == "passage_unparseable"


# --- route layer ------------------------------------------------------------
def test_passage_routes_start_questions_progress(client):
    # Start a passage-first job.
    resp = client.post("/api/generation/passages",
                       json={"q_type": "MainPoint", "count": 4})
    assert resp.status_code == 200
    body = resp.json()
    job_id = body["job_id"]
    assert body["passage_first"] is True
    assert body["status"] == "queued"

    # Progress endpoint resolves the job (worker is off in tests, so still queued).
    prog = client.get(f"/api/generation/passages/{job_id}/progress")
    assert prog.status_code == 200
    assert prog.json()["passage_first"] is True

    # Drive the job directly (the worker is disabled in tests).
    generation.run_job(job_id, generate=_make_stub(), embedder=_no_embed)

    with Session(engine) as s:
        gen_q = s.exec(
            select(Question).where(Question.source == QuestionSource.ai_generated)
        ).first()
        assert gen_q is not None
        passage_id = gen_q.passage_id

    # Questions endpoint returns the attached set + passage text.
    q_resp = client.get(f"/api/generation/passages/{passage_id}/questions")
    assert q_resp.status_code == 200
    q_body = q_resp.json()
    assert q_body["passage_id"] == passage_id
    assert "heat island" in q_body["passage"]
    assert q_body["count"] == 4
    assert all(q["passage_id"] == passage_id for q in q_body["questions"])
    # Review-mode shape carries the answer key.
    assert q_body["questions"][0]["correct_answer"] == "B"


def test_passage_questions_404_for_missing_passage(client):
    assert client.get("/api/generation/passages/999999/questions").status_code == 404


def test_passage_progress_404_for_missing_job(client):
    assert client.get("/api/generation/passages/999999/progress").status_code == 404
