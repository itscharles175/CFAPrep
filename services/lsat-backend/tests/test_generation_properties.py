"""Property checks for the generated-content trust boundary."""
from __future__ import annotations

import string

from hypothesis import given, settings, strategies as st

from app import gen_validators, generation
from app.llm.base import LLMError


_LABELS = "ABCDE"
_KNOWN_TYPES = set(gen_validators.LR_TYPES) | set(gen_validators.RC_TYPES)


def _candidate(correct: str = "B") -> dict:
    traps = {
        "A": "opposite",
        "B": "none",
        "C": "reversal",
        "D": "out_of_scope",
        "E": "degree",
    }
    return {
        "stem": (
            "A researcher presents a careful argument about a city's transit "
            "policy, comparing ridership data, funding limits, and likely "
            "effects on several neighborhoods."
        ),
        "prompt": "Which one of the following most weakens the argument?",
        "correct_answer": correct,
        "choices": [
            {
                "label": label,
                "text": f"Choice {label} gives a balanced plausible response here.",
                "trap_type": "none" if label == correct else traps[label],
            }
            for label in _LABELS
        ],
    }


def _boom(_prompt: str) -> str:
    raise AssertionError("structural failures must not call a model")


def _assert_structural_failure(cand: dict) -> None:
    report = generation.validate_candidate(
        cand,
        runs=3,
        solver=_boom,
        critic=_boom,
        permutation_invariant=False,
        informativity=False,
    )
    assert report["passed"] is False
    assert report["reason"] == "structural"
    assert report["checks"]["structural"] is False


@given(
    n=st.one_of(st.integers(min_value=0, max_value=4),
                st.integers(min_value=6, max_value=8)),
    correct=st.sampled_from(list(_LABELS)),
)
@settings(max_examples=30, deadline=None)
def test_generation_gate_rejects_non_five_choice_counts(n: int, correct: str):
    cand = _candidate(correct)
    cand["choices"] = [
        {"label": label, "text": f"Choice {label} remains non-empty."}
        for label in string.ascii_uppercase[:n]
    ]

    _assert_structural_failure(cand)


@given(
    labels=st.lists(st.sampled_from(list(_LABELS)), min_size=5, max_size=5)
    .filter(lambda labels: labels != list(_LABELS))
)
@settings(max_examples=40, deadline=None)
def test_generation_gate_rejects_bad_label_sequences(labels: list[str]):
    cand = _candidate("B")
    cand["choices"] = [
        {"label": label, "text": f"Choice {index} remains non-empty."}
        for index, label in enumerate(labels)
    ]

    _assert_structural_failure(cand)


@given(correct=st.sampled_from(["", " ", "F", "AA", "b", "1", "None"]))
@settings(max_examples=20, deadline=None)
def test_generation_gate_rejects_invalid_correct_answer_labels(correct: str):
    cand = _candidate(correct)

    _assert_structural_failure(cand)


@given(
    stem=st.sampled_from(["", "   ", "too short"]),
    prompt=st.sampled_from(["Which one of the following most weakens?", "", "   "]),
)
@settings(max_examples=20, deadline=None)
def test_generation_gate_rejects_missing_reasoning_surface(
    stem: str, prompt: str
):
    cand = _candidate("B")
    cand["stem"] = stem
    cand["prompt"] = prompt

    _assert_structural_failure(cand)


@given(
    q_type=st.text(
        alphabet=string.ascii_letters + string.digits + "_- ",
        min_size=1,
        max_size=32,
    ).filter(lambda q_type: q_type not in _KNOWN_TYPES)
)
@settings(max_examples=40, deadline=None)
def test_unknown_generation_types_fail_closed(q_type: str):
    verdict = gen_validators.validate_structure(q_type, _candidate("B"), lambda _: "{}")

    assert verdict["ok"] is False
    assert verdict["check"] == "unknown_q_type"
    assert verdict["reason"] == "unsupported_q_type"


def test_validator_critic_outage_fails_closed():
    def unavailable(_prompt: str) -> str:
        raise LLMError("local provider unavailable")

    verdict = gen_validators.validate_structure("Weaken", _candidate("B"), unavailable)

    assert verdict["ok"] is False
    assert verdict["check"] == "Weaken"
    assert verdict["reason"] == "critic_unavailable"


@given(
    label=st.sampled_from([l for l in _LABELS if l != "B"]),
    trap=st.one_of(
        st.sampled_from(["", " ", "none", "scope-shift", "attractive"]),
        st.text(alphabet=string.ascii_letters + "-_", min_size=1, max_size=12)
        .filter(lambda value: value not in {
            "reversal",
            "out_of_scope",
            "degree",
            "scope_shift",
            "half_right",
            "opposite",
            "too_strong",
            "irrelevant_comparison",
            "premise_restatement",
        }),
    ),
)
@settings(max_examples=35, deadline=None)
def test_generation_gate_rejects_invalid_distractor_trap_metadata(
    label: str, trap: str
):
    cand = _candidate("B")
    for choice in cand["choices"]:
        if choice["label"] == label:
            if trap.strip():
                choice["trap_type"] = trap
            else:
                choice.pop("trap_type")
            break

    report = generation.validate_candidate(
        cand,
        runs=3,
        solver=_boom,
        critic=_boom,
        permutation_invariant=False,
        informativity=False,
    )

    assert report["passed"] is False
    assert report["reason"] == "trap_metadata"
    assert report["checks"]["trap_metadata"]["ok"] is False
