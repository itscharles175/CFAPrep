"""Tier-B RC generation + stronger gate (min stimulus, passage-aware solving)."""
from __future__ import annotations

import json

from sqlmodel import Session, select

from app import gen_validators, generation
from app.db import engine
from app.models import (
    AnswerChoice, GenJob, GenStatus, Passage, PrepTest, Question,
    QuestionSource, Section, SectionType, ValidatorRun,
)

# A long-enough passage to clear the Wave 2.3 hard RC gate: roughly 290
# words across a dozen sentences with deliberately varied lengths so the
# sentence-stdev check is comfortably satisfied. Topic: urban heat islands.
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

RC_CANDIDATE = {
    "passage": _PASSAGE,
    "stem": "",
    "prompt": "Which one of the following most accurately states the main point of the passage?",
    "difficulty": 3,
    "correct_answer": "B",
    # Lengths are balanced so the correct answer (B) is neither longest (A) nor
    # shortest (C) — avoids tripping the no-length-tell guard.
    "choices": [
        {"label": "A", "text": "Urban heat islands are produced exclusively by impervious paved surfaces, with no other contributing factor at all.", "trap_type": "too_strong"},
        {"label": "B", "text": "Scholarship has shifted from describing heat islands to modeling their causes.", "trap_type": "none"},
        {"label": "C", "text": "Vegetation has no effect on city temperatures.", "trap_type": "opposite"},
        {"label": "D", "text": "Nighttime effects are the only outcome these newer climate models capture.", "trap_type": "degree"},
        {"label": "E", "text": "Critics have come to reject all computational modeling of urban heat.", "trap_type": "out_of_scope"},
    ],
}


def _distractor_flaws(clear: bool = True) -> list[dict]:
    return [
        {"label": "A", "flaw": "too strong relative to the passage", "clear": clear},
        {"label": "C", "flaw": "contradicts the passage", "clear": clear},
        {"label": "D", "flaw": "overstates a limited claim", "clear": clear},
        {"label": "E", "flaw": "unsupported by the passage", "clear": clear},
    ]


def _rc_stub(prompt: str) -> str:
    if "Write ONE original" in prompt:
        return json.dumps(RC_CANDIDATE)
    if "Solve this LSAT" in prompt:
        return "B"
    if "strict LSAT item reviewer" in prompt:
        return json.dumps({"single_defensible": True, "defensible_letters": ["B"]})
    if "validating a generated LSAT Reading Comprehension item" in prompt:
        return json.dumps({
            "credited_supported_by_passage": True,
            "requires_outside_knowledge": False,
            "single_best_answer": True,
            "distractor_flaws": _distractor_flaws(),
        })
    return "B"


def test_min_stimulus_rejects_tiny_lr_candidate():
    tiny = {
        "stem": "Too short.",  # < 30 chars, no passage
        "prompt": "Which one of the following is most accurate?",
        "correct_answer": "B",
        "choices": [{"label": l, "text": f"opt {l}"} for l in "ABCDE"],
    }
    report = generation.validate_candidate(tiny, runs=2)
    assert report["passed"] is False
    assert report["reason"] == "structural"


def test_rc_candidate_passes_with_passage():
    report = generation.validate_candidate(
        RC_CANDIDATE, runs=3,
        solver=lambda p: "B",
        critic=lambda p: json.dumps({"single_defensible": True, "defensible_letters": ["B"]}),
    )
    assert report["checks"]["structural"] is True
    assert report["passed"] is True


def test_rc_structural_validator_requires_passage_grounding():
    def critic(prompt: str) -> str:
        assert "Use ONLY the passage" in prompt
        return json.dumps({
            "credited_supported_by_passage": True,
            "requires_outside_knowledge": False,
            "single_best_answer": True,
            "distractor_flaws": _distractor_flaws(),
        })

    verdict = gen_validators.validate_structure("MainPoint", RC_CANDIDATE, critic)
    assert verdict["ok"] is True
    assert verdict["check"] == "main_point"
    assert verdict["detail"]["single_best_answer"] is True
    assert verdict["detail"]["distractor_flaw_count"] == 4


def test_rc_structural_validator_rejects_outside_knowledge():
    def critic(_prompt: str) -> str:
        return json.dumps({
            "credited_supported_by_passage": True,
            "requires_outside_knowledge": True,
            "single_best_answer": True,
            "distractor_flaws": _distractor_flaws(),
        })

    verdict = gen_validators.validate_structure("MainPoint", RC_CANDIDATE, critic)
    assert verdict["ok"] is False
    assert verdict["reason"] == "rc_requires_outside_knowledge"


def test_rc_structural_validator_fails_closed_without_json():
    verdict = gen_validators.validate_structure(
        "MainPoint", RC_CANDIDATE, lambda _prompt: "not json"
    )
    assert verdict["ok"] is False
    assert verdict["reason"] == "rc_semantic_unverified"


def test_generation_gate_rejects_rc_job_without_passage():
    cand = {
        **RC_CANDIDATE,
        "passage": "",
        # Long stem proves this is not merely the generic structural length gate.
        "stem": "This generated RC item forgot its passage but kept enough text " * 4,
    }

    report = generation.validate_candidate(
        cand,
        runs=1,
        solver=lambda _p: "B",
        critic=lambda _p: "B",
        q_type="MainPoint",
        section_type="RC",
    )
    assert report["passed"] is False
    assert report["reason"] == "rc_missing_passage"
    assert report["checks"]["rc_requires_passage"] is False


def test_generation_gate_rejects_rc_without_defensible_distractors():
    def critic(prompt: str) -> str:
        if "strict LSAT item reviewer" in prompt:
            return json.dumps({"single_defensible": True, "defensible_letters": ["B"]})
        if "validating a generated LSAT Reading Comprehension item" in prompt:
            return json.dumps({
                "credited_supported_by_passage": True,
                "requires_outside_knowledge": False,
                "single_best_answer": True,
                "distractor_flaws": _distractor_flaws(clear=False),
            })
        return "B"

    report = generation.validate_candidate(
        RC_CANDIDATE,
        runs=1,
        solver=lambda _p: "B",
        critic=critic,
        q_type="MainPoint",
    )
    assert report["passed"] is False
    assert report["reason"] == "rc_distractors_not_defensible"
    assert report["checks"]["structural_type"]["ok"] is False


def test_run_job_generates_rc_with_passage(db_session):
    # An RC parent: PrepTest -> RC Section -> Passage -> Question(passage_id set).
    pt = PrepTest(name="RC parent test", source="research", is_official=False)
    db_session.add(pt)
    db_session.commit()
    db_session.refresh(pt)
    sec = Section(preptest_id=pt.id, type=SectionType.RC, order=0)
    db_session.add(sec)
    db_session.commit()
    db_session.refresh(sec)
    pas = Passage(section_id=sec.id, text=_PASSAGE, type="single")
    db_session.add(pas)
    db_session.commit()
    db_session.refresh(pas)
    parent = Question(
        section_id=sec.id,
        passage_id=pas.id,
        stem="",
        prompt="Which one of the following states the main point of the passage?",
        correct_answer="A",
        q_type="MainPoint",
        source=QuestionSource.research,
    )
    db_session.add(parent)
    db_session.commit()
    db_session.refresh(parent)
    for lbl in "ABCDE":
        db_session.add(AnswerChoice(question_id=parent.id, label=lbl, text=f"o {lbl}",
                                    is_correct=(lbl == "A")))
    db_session.commit()

    job = GenJob(
        q_type="MainPoint",
        count=1,
        status=GenStatus.queued,
        parent_question_id=parent.id,
    )
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    job_id = job.id

    prompts: list[str] = []

    def capturing_stub(prompt: str) -> str:
        prompts.append(prompt)
        return _rc_stub(prompt)

    generation.run_job(job_id, generate=capturing_stub)

    with Session(engine) as s:
        finished = s.get(GenJob, job_id)
        assert finished.status == GenStatus.done
        assert finished.accepted == 1
        write_prompt = next(prompt for prompt in prompts if "Write ONE original" in prompt)
        assert "RC passage map guidance" in write_prompt
        assert "Paragraph role pattern" in write_prompt
        assert "Viewpoint pattern" in write_prompt
        assert "Evidence anchors to imitate structurally" in write_prompt
        assert "Target question focus: scope=global; anchor=whole_passage; tags=global, main_point" in write_prompt
        assert "Tag coverage evidence: 1/1 tagged" in write_prompt
        cand_report = finished.validation_report["candidates"][0]
        rc_context = cand_report["rc_generation_context"]
        assert rc_context["parent_passage_id"] == pas.id
        assert rc_context["target_scope"] == "global"
        assert rc_context["target_anchor_ref"] == "whole_passage"
        assert rc_context["dominant_viewpoint"]
        assert rc_context["evidence_refs"]
        assert "main_point" in rc_context["target_tags"]
        assert rc_context["paragraph_roles"]
        gen_q = s.exec(
            select(Question)
            .where(Question.source == QuestionSource.ai_generated)
            .where(Question.q_type == "MainPoint")
        ).first()
        assert gen_q is not None
        # The generated RC item carries a real passage -> it is drillable as RC.
        assert gen_q.passage_id is not None
        pas2 = s.get(Passage, gen_q.passage_id)
        assert pas2 is not None and "heat island" in pas2.text
        run = s.exec(
            select(ValidatorRun).where(ValidatorRun.q_type == "MainPoint")
        ).first()
        assert run is not None
        assert run.meta_json["rc_generation_context"]["parent_passage_id"] == pas.id


def test_rc_generation_context_uses_type_guidance_without_matching_tag(db_session):
    pt = PrepTest(name="RC guidance fallback", source="research", is_official=False)
    db_session.add(pt)
    db_session.commit()
    db_session.refresh(pt)
    sec = Section(preptest_id=pt.id, type=SectionType.RC, order=0)
    db_session.add(sec)
    db_session.commit()
    db_session.refresh(sec)
    pas = Passage(section_id=sec.id, text=_PASSAGE, type="single")
    db_session.add(pas)
    db_session.commit()
    db_session.refresh(pas)
    parent = Question(
        section_id=sec.id,
        passage_id=pas.id,
        stem="",
        prompt="Which one of the following states the main point of the passage?",
        correct_answer="A",
        q_type="MainPoint",
        source=QuestionSource.research,
    )
    db_session.add(parent)
    db_session.commit()
    db_session.refresh(parent)

    context = generation._rc_generation_context(db_session, parent, "Function")
    steering = generation._format_rc_generation_context(context)

    assert context["target_scope"] == "local_text"
    assert context["target_anchor_ref"] == "local_text"
    assert context["target_requires_evidence"] is True
    assert context["target_tags"] == ["structure", "role", "local_text"]
    assert (
        "Target question focus: scope=local_text; anchor=local_text; "
        "tags=structure, role, local_text"
    ) in steering
    assert "specific passage role or local evidence anchor" in steering
