from __future__ import annotations

import json

from app import gen_validators


def _candidate(prompt: str, *, passage: str | None = None) -> dict:
    return {
        "passage": passage or (
            "The passage describes a historian's account of urban reform. "
            "It contrasts older explanations with newer evidence and then "
            "qualifies both views in light of institutional constraints."
        ),
        "stem": "",
        "prompt": prompt,
        "difficulty": 3,
        "correct_answer": "B",
        "choices": [
            {"label": "A", "text": "A tempting but unsupported reading."},
            {"label": "B", "text": "The passage supports this answer."},
            {"label": "C", "text": "A statement that reverses the passage."},
            {"label": "D", "text": "A claim that is too broad."},
            {"label": "E", "text": "An irrelevant comparison."},
        ],
    }


def _critic_ok(_prompt: str) -> str:
    return json.dumps({
        "credited_supported_by_passage": True,
        "requires_outside_knowledge": False,
        "single_best_answer": True,
        "distractor_flaws": [
            {"label": "A", "flaw": "unsupported by passage", "clear": True},
            {"label": "C", "flaw": "contradicts the passage", "clear": True},
            {"label": "D", "flaw": "too broad for the passage", "clear": True},
            {"label": "E", "flaw": "irrelevant to the passage", "clear": True},
        ],
    })


def _critic_unexpected(_prompt: str) -> str:
    raise AssertionError("scope mismatch should fail before the critic call")


def test_rc_comparative_requires_comparative_anchor():
    verdict = gen_validators.validate_structure(
        "Comparative",
        _candidate("Which comparison is best supported by the passage?"),
        _critic_unexpected,
        section_type="RC",
    )

    assert verdict["ok"] is False
    assert verdict["reason"] == "rc_scope_mismatch"
    assert verdict["detail"]["expected_scope"] == "comparative"


def test_rc_main_point_rejects_line_local_scope():
    verdict = gen_validators.validate_structure(
        "MainPoint",
        _candidate("The phrase in line 12 primarily supports which main point?"),
        _critic_unexpected,
        section_type="RC",
    )

    assert verdict["ok"] is False
    assert verdict["reason"] == "rc_scope_mismatch"
    assert verdict["detail"]["scope"] == "line_reference"


def test_rc_function_requires_local_anchor():
    verdict = gen_validators.validate_structure(
        "Function",
        _candidate("What is the function of the passage as a whole?"),
        _critic_unexpected,
        section_type="RC",
    )

    assert verdict["ok"] is False
    assert verdict["reason"] == "rc_scope_mismatch"
    assert verdict["detail"]["expected_scope"] == "local_text"


def test_rc_detail_anchor_allows_semantic_critic():
    verdict = gen_validators.validate_structure(
        "Detail",
        _candidate("According to the passage, which point does the historian mention?"),
        _critic_ok,
        section_type="RC",
    )

    assert verdict["ok"] is True
    assert verdict["detail"]["scope"] == "local_text"
    assert verdict["detail"]["anchor_ref"] == "local_text"
    assert verdict["detail"]["requires_evidence"] is True
    assert "text_lookup" in verdict["detail"]["tags"]
    assert verdict["detail"]["distractor_flaw_count"] == 4
