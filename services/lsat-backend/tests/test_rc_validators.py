"""LSAT-5 — RC SEMANTIC validators (MainPoint coherence / Detail-basis /
Inference-support).

These complement the per-type RC GROUNDING validators (test_generation_rc.py,
test_rc_validator_scope.py): each runs the cheap scope-anchor grounding check
first, then asks the critic for a family-specific soundness verdict. The tests
use deterministic critic stubs only — no model calls.
"""
from __future__ import annotations

import json

from app import gen_validators


# A passage with enough body that ``missing_rc_passage`` never fires and the
# scope-anchor grounding check has real text to reason over.
_PASSAGE = (
    "Historians once attributed the medieval commercial revolution almost "
    "entirely to the revival of long-distance trade. More recent scholarship "
    "complicates that account. It argues that local credit instruments, the "
    "spread of notarial record-keeping, and the gradual standardization of "
    "weights and measures mattered at least as much as the famous fairs of "
    "Champagne. The author surveys this newer literature and, while broadly "
    "sympathetic, cautions that its enthusiasts sometimes understate how much "
    "regional variation resists any single explanation."
)


def _candidate(prompt: str, *, correct: str = "B") -> dict:
    return {
        "passage": _PASSAGE,
        "stem": "",
        "prompt": prompt,
        "difficulty": 3,
        "correct_answer": correct,
        "choices": [
            {"label": "A", "text": "A tempting but unsupported overreach.", "trap_type": "too_strong"},
            {"label": "B", "text": "The supported reading of the passage.", "trap_type": "none"},
            {"label": "C", "text": "A claim that reverses the passage.", "trap_type": "opposite"},
            {"label": "D", "text": "A claim that is too narrow.", "trap_type": "degree"},
            {"label": "E", "text": "An irrelevant comparison.", "trap_type": "irrelevant_comparison"},
        ],
    }


# --- registry wiring --------------------------------------------------------
def test_semantic_validators_registered_without_clobbering_grounding():
    # The base grounding validators stay registered under their plain q_type keys.
    assert "MainPoint" in gen_validators._RC_VALIDATORS
    assert "Detail" in gen_validators._RC_VALIDATORS
    assert "Inference" in gen_validators._RC_VALIDATORS
    # The semantic validators live under composite keys, additive.
    assert "MainPoint:coherence" in gen_validators._RC_VALIDATORS
    assert "Detail:basis" in gen_validators._RC_VALIDATORS
    assert "Inference:support" in gen_validators._RC_VALIDATORS
    assert gen_validators._RC_VALIDATORS["MainPoint"] is not gen_validators._RC_VALIDATORS["MainPoint:coherence"]


def test_validate_rc_semantic_noop_for_type_without_semantic_check():
    def boom(_prompt: str) -> str:
        raise AssertionError("no critic call expected for an unmapped RC type")

    verdict = gen_validators.validate_rc_semantic(
        "Attitude", _candidate("What is the author's attitude toward the newer scholarship?"), boom
    )
    assert verdict["ok"] is True
    assert verdict["check"] == "rc_semantic_none"


# --- MainPoint coherence ----------------------------------------------------
_MAIN_PROMPT = "Which one of the following most accurately states the main point of the passage?"


def test_main_point_coherence_passes_when_critic_confirms():
    def critic(prompt: str) -> str:
        assert "MAIN POINT" in prompt
        return json.dumps({
            "coheres_with_whole_passage": True,
            "credited_supported_by_passage": True,
            "single_best_answer": True,
        })

    verdict = gen_validators.validate_rc_semantic("MainPoint", _candidate(_MAIN_PROMPT), critic)
    assert verdict["ok"] is True
    assert verdict["check"] == "main_point_coherence"


def test_main_point_coherence_rejects_incoherent_thesis():
    def critic(_prompt: str) -> str:
        return json.dumps({
            "coheres_with_whole_passage": False,
            "credited_supported_by_passage": True,
            "single_best_answer": True,
        })

    verdict = gen_validators.validate_rc_semantic("MainPoint", _candidate(_MAIN_PROMPT), critic)
    assert verdict["ok"] is False
    assert verdict["reason"] == "rc_main_point_incoherent"


# --- Detail basis -----------------------------------------------------------
_DETAIL_PROMPT = "According to the passage, which of the following did recent scholarship emphasize?"


def test_detail_basis_passes_with_explicit_textual_basis():
    def critic(prompt: str) -> str:
        assert "EXPLICIT textual basis" in prompt
        return json.dumps({
            "has_explicit_textual_basis": True,
            "credited_supported_by_passage": True,
            "single_best_answer": True,
        })

    verdict = gen_validators.validate_rc_semantic("Detail", _candidate(_DETAIL_PROMPT), critic)
    assert verdict["ok"] is True
    assert verdict["check"] == "detail_basis"


def test_detail_basis_rejects_when_no_textual_basis():
    def critic(_prompt: str) -> str:
        return json.dumps({
            "has_explicit_textual_basis": False,
            "credited_supported_by_passage": True,
            "single_best_answer": True,
        })

    verdict = gen_validators.validate_rc_semantic("Detail", _candidate(_DETAIL_PROMPT), critic)
    assert verdict["ok"] is False
    assert verdict["reason"] == "rc_detail_no_textual_basis"


# --- Inference support ------------------------------------------------------
_INFER_PROMPT = "The passage suggests which one of the following can be inferred about newer scholarship?"


def test_inference_support_passes_when_inference_follows():
    def critic(prompt: str) -> str:
        assert "valid INFERENCE" in prompt
        return json.dumps({
            "follows_from_passage": True,
            "credited_supported_by_passage": True,
            "single_best_answer": True,
        })

    verdict = gen_validators.validate_rc_semantic("Inference", _candidate(_INFER_PROMPT), critic)
    assert verdict["ok"] is True
    assert verdict["check"] == "inference_support"


def test_inference_support_rejects_unwarranted_leap():
    def critic(_prompt: str) -> str:
        return json.dumps({
            "follows_from_passage": False,
            "credited_supported_by_passage": True,
            "single_best_answer": True,
        })

    verdict = gen_validators.validate_rc_semantic("Inference", _candidate(_INFER_PROMPT), critic)
    assert verdict["ok"] is False
    assert verdict["reason"] == "rc_inference_unsupported"


# --- fail-closed + grounding short-circuit ----------------------------------
def test_semantic_validator_fails_closed_on_unparseable_critic():
    verdict = gen_validators.validate_rc_semantic(
        "MainPoint", _candidate(_MAIN_PROMPT), lambda _p: "not json at all"
    )
    assert verdict["ok"] is False
    assert verdict["reason"] == "rc_semantic_unverified"


def test_semantic_validator_short_circuits_on_scope_mismatch():
    # A MainPoint question phrased as a line-local detail must fail the scope
    # check BEFORE any semantic critic call.
    def boom(_prompt: str) -> str:
        raise AssertionError("scope mismatch should fail before the critic call")

    verdict = gen_validators.validate_rc_semantic(
        "MainPoint",
        _candidate("The phrase in line 7 primarily supports which main point?"),
        boom,
    )
    assert verdict["ok"] is False
    assert verdict["reason"] == "rc_scope_mismatch"


def test_semantic_validator_rejects_missing_passage():
    cand = _candidate(_MAIN_PROMPT)
    cand["passage"] = ""

    def boom(_prompt: str) -> str:
        raise AssertionError("no critic call expected when the passage is missing")

    # Prompt-shape passes, but the empty passage trips the explicit guard.
    verdict = gen_validators.validate_rc_semantic("MainPoint", cand, boom)
    assert verdict["ok"] is False
    assert verdict["reason"] == "missing_rc_passage"
