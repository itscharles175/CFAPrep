"""T2 — golden-set regression for the riskiest logic.

Pins exact outputs so a refactor can't silently change:
- the raw->scaled score curve (score prediction is the product's headline number),
- the four-part generation validation gate (what content is allowed into the bank),
- the D2 provenance trigger (source immutability — the legal + scoring boundary).

All model calls are injected fakes; nothing here touches Ollama.
"""
from __future__ import annotations

import pytest

from app import generation, scoring


# --- scoring curve ----------------------------------------------------------
def test_scoring_anchor_points_are_pinned():
    # Exact anchors from the published-style curve (scoring.py).
    assert scoring.percent_to_scaled(0) == 120
    assert scoring.percent_to_scaled(10) == 120
    assert scoring.percent_to_scaled(50) == 145
    assert scoring.percent_to_scaled(80) == 164
    assert scoring.percent_to_scaled(100) == 180
    # Linear interpolation between anchors.
    assert scoring.percent_to_scaled(75) == 161   # midway 70(158)->80(164)
    assert scoring.percent_to_scaled(95) == 175   # midway 90(170)->100(180)


def test_predict_scaled_from_raw():
    assert scoring.predict_scaled(0, 0) is None
    assert scoring.predict_scaled(76, 76) == 180
    assert scoring.predict_scaled(0, 76) == 120
    assert scoring.predict_scaled(38, 76) == 145   # 50%
    # clamps out-of-range gracefully
    assert 120 <= scoring.predict_scaled(1, 1) <= 180


# --- validation gate --------------------------------------------------------
def _cand(correct="B", *, n=5, equal_len=True):
    if equal_len:
        texts = {l: "A choice of fairly even length here." for l in "ABCDE"}
    else:
        texts = {l: "short" for l in "ABCDE"}
    traps = {
        "A": "opposite",
        "B": "none",
        "C": "reversal",
        "D": "out_of_scope",
        "E": "degree",
    }
    return {
        "stem": ("A sufficiently long stimulus presenting an argument with enough "
                 "words to clear the minimum-length structural check easily."),
        "prompt": "Which one of the following most weakens the argument?",
        "correct_answer": correct,
        "choices": [
            {
                "label": l,
                "text": texts[l],
                "trap_type": "none" if l == correct else traps[l],
            }
            for l in "ABCDE"[:n]
        ],
    }


def _solver_const(letter):
    return lambda _prompt: f"The answer is {letter}."


def _critic_single(letter):
    return lambda _prompt: (
        '{"single_defensible": true, "defensible_letters": ["%s"]}' % letter
    )


def test_gate_accepts_clean_item():
    report = generation.validate_candidate(
        _cand("B"), runs=3, solver=_solver_const("B"), critic=_critic_single("B")
    )
    assert report["passed"] is True
    assert report["checks"]["structural"] is True
    assert report["checks"]["no_length_tell"] is True
    assert report["self_consistency_pass"] is True
    assert report["checks"]["single_defensible"] is True


def test_gate_rejects_structural():
    report = generation.validate_candidate(
        _cand("B", n=4), runs=3, solver=_solver_const("B"), critic=_critic_single("B")
    )
    assert report["passed"] is False
    assert report["reason"] == "structural"


def test_gate_rejects_length_tell():
    cand = _cand("B", equal_len=False)
    cand["choices"][1]["text"] = "this is a uniquely much much much longer correct choice"
    report = generation.validate_candidate(
        cand, runs=3, solver=_solver_const("B"), critic=_critic_single("B")
    )
    assert report["passed"] is False
    assert report["reason"] == "length_tell"
    assert report["checks"]["no_length_tell"] is False


def test_gate_rejects_self_inconsistent():
    seq = iter(["B", "C", "B"])
    report = generation.validate_candidate(
        _cand("B"), runs=3, solver=lambda _p: next(seq), critic=_critic_single("B")
    )
    assert report["passed"] is False
    assert report["reason"] == "self_consistency"
    assert report["self_consistency_pass"] is False


def test_gate_rejects_ambiguous():
    report = generation.validate_candidate(
        _cand("B"), runs=3, solver=_solver_const("B"),
        critic=lambda _p: '{"single_defensible": false, "defensible_letters": ["B","C"]}',
    )
    assert report["passed"] is False
    assert report["reason"] == "ambiguous_answer"


# --- D2 provenance immutability (trigger) -----------------------------------
def test_question_source_is_immutable(db_session):
    from app.models import Question, QuestionSource

    q = Question(
        stem="x" * 40, prompt="p?", correct_answer="A", q_type="Weaken",
        source=QuestionSource.official,
    )
    db_session.add(q)
    db_session.commit()
    db_session.refresh(q)

    q.source = QuestionSource.ai_generated
    db_session.add(q)
    with pytest.raises(Exception):
        db_session.commit()
    db_session.rollback()

    fresh = db_session.get(Question, q.id)
    db_session.refresh(fresh)
    assert fresh.source == QuestionSource.official


def test_non_source_updates_still_work(db_session):
    from app.models import Question, QuestionSource

    q = Question(
        stem="y" * 40, prompt="p?", correct_answer="A", q_type="Weaken",
        source=QuestionSource.official, difficulty=2,
    )
    db_session.add(q)
    db_session.commit()
    db_session.refresh(q)

    q.difficulty = 5
    q.q_type = "Flaw"
    db_session.add(q)
    db_session.commit()  # must NOT trigger the source guard
    db_session.refresh(q)
    assert q.difficulty == 5 and q.q_type == "Flaw"
