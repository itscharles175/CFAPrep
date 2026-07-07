"""Offline prompt-regression floor for LSAT backend LLM prompt builders."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

from . import ai, generation
from .models import AnswerChoice, Question


REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_FIXTURE = REPO_ROOT / "tests" / "prompt-fixtures" / "prompt-regression.json"
SCHEMA = "studyvault.backend-prompt-regression.v1"


def _choices_dict() -> list[dict[str, str]]:
    return [
        {"label": "A", "text": "It mistakes a sufficient condition for a required one.", "trap_type": "reversal"},
        {"label": "B", "text": "It identifies an assumption needed to connect the evidence to the conclusion.", "trap_type": "none"},
        {"label": "C", "text": "It introduces a comparison that the argument never makes.", "trap_type": "out_of_scope"},
        {"label": "D", "text": "It weakens a premise that the author does not rely on.", "trap_type": "irrelevant_comparison"},
        {"label": "E", "text": "It restates a premise without addressing the conclusion.", "trap_type": "premise_restatement"},
    ]


def _parent_question() -> Question:
    return Question(
        id=101,
        section_id=7,
        passage_id=33,
        stem=(
            "A city found that bus ridership rose after it added express routes. "
            "The mayor concludes that every neighborhood should receive an express route."
        ),
        prompt="Which one of the following is an assumption required by the argument?",
        correct_answer="B",
        difficulty=3,
        q_type="NecessaryAssumption",
    )


def _parent_choices() -> list[AnswerChoice]:
    return [
        AnswerChoice(question_id=101, label=row["label"], text=row["text"], is_correct=row["label"] == "B")
        for row in _choices_dict()
    ]


def _rc_context() -> dict[str, Any]:
    return {
        "passage_type": "single",
        "paragraph_count": 3,
        "dominant_viewpoint": "author",
        "main_point_hint": "The author defends targeted transit investment against a broad mandate.",
        "question_mix": {"MainPoint": 1, "Detail": 1},
        "line_reference_density": 0.42,
        "tag_coverage": {"tagged_questions": 2, "total_questions": 3, "low_confidence": 0},
        "target_scope": "global",
        "target_anchor_ref": "whole_passage",
        "target_requires_evidence": True,
        "target_tags": ["global", "main_point"],
        "paragraph_roles": [
            {"index": 1, "line_ref": "P1", "role": "background", "viewpoint": {"label": "planner"}},
            {"index": 2, "line_ref": "P2", "role": "counterargument", "viewpoint": {"label": "critic"}},
            {"index": 3, "line_ref": "P3", "role": "author_response", "viewpoint": {"label": "author"}},
        ],
        "evidence_refs": [
            {"line_ref": "P2", "evidence_type": "contrast", "marker": "however"},
            {"line_ref": "P3", "evidence_type": "claim", "marker": "therefore"},
        ],
    }


def render_backend_prompt_contracts() -> list[dict[str, Any]]:
    choices = _choices_dict()
    parent = _parent_question()
    parent_choices = _parent_choices()
    passage = (
        "Urban transit planners often distinguish between evidence that a route works "
        "in one corridor and evidence that it should be copied everywhere."
    )
    return [
        {
            "id": "lsat.explain.personalized",
            "value": ai._explain_prompt(
                parent.stem,
                parent.prompt,
                choices,
                "B",
                "A",
                context_notes=["I keep reversing necessary and sufficient conditions."],
                exemplar={"explanation": "The credited answer supplies the bridge between evidence and conclusion."},
                socratic_context={
                    "timed_answer": "A",
                    "blind_review_answer": "B",
                    "rationale": {
                        "answer": "A",
                        "trap_guess": "reversal",
                        "text": "I treated the express route as sufficient for every neighborhood.",
                    },
                    "recent_turns": [{"role": "student", "content": "I focused on the first sentence."}],
                },
                trap_misses=[
                    {
                        "question_id": 14,
                        "trap_type": "reversal",
                        "chosen_answer": "A",
                        "note_excerpt": "I swapped the condition.",
                    }
                ],
            ),
        },
        {
            "id": "lsat.explain.rc_followup",
            "value": ai._explain_prompt(
                "The passage discusses targeted transit investments.",
                "The author's main point is best described as which one of the following?",
                choices,
                "B",
                "A",
                user_message="Why is choice A too broad?",
                focus_choice="A",
                passage_text=passage,
                passage_topic="Transit policy",
            ),
        },
        {
            "id": "lsat.hint.socratic",
            "value": ai._hint_prompt(parent.stem, parent.prompt, choices),
        },
        {
            "id": "lsat.coach.chat",
            "value": ai._coach_chat_messages(
                "Weakest types: NecessaryAssumption. Recent misses: Q14. Blind-review gap: 2.",
                "What should I drill next?",
                history=[
                    {"role": "system", "content": "ignored"},
                    {"role": "user", "content": "I missed Q14."},
                    {"role": "assistant", "content": "Review the bridge assumption."},
                ],
            ),
        },
        {
            "id": "lsat.generation.lr",
            "value": generation._gen_prompt("NecessaryAssumption", parent, parent_choices),
        },
        {
            "id": "lsat.generation.rc_passage_first",
            "value": generation._gen_prompt(
                "MainPoint",
                parent,
                parent_choices,
                section_type="RC",
                parent_passage=passage,
                rc_context=_rc_context(),
                passage_first=True,
            ),
        },
        {
            "id": "lsat.generation.rc_question",
            "value": generation._question_prompt(
                "MainPoint",
                passage,
                rc_context=_rc_context(),
                other_prompts=["What is the purpose of paragraph 2?"],
            ),
        },
        {
            "id": "lsat.review.solve",
            "value": generation._solve_prompt(parent.stem, parent.prompt, choices),
        },
        {
            "id": "lsat.review.critique",
            "value": generation._critique_prompt(parent.stem, parent.prompt, choices),
        },
        {
            "id": "lsat.review.distractor_quality",
            "value": generation._distractor_quality_prompt(parent.stem, parent.prompt, choices, "B"),
        },
        {
            "id": "lsat.review.informativity",
            "value": generation._informativity_prompt("[removed]", parent.prompt, choices),
        },
    ]


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _display(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2)


def _sha256(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _load_fixture(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def run_prompt_contract_floor(fixture_path: Path = DEFAULT_FIXTURE) -> dict[str, Any]:
    fixture = _load_fixture(fixture_path)
    expected = {
        row["id"]: row
        for row in (fixture.get("backend") or {}).get("prompts", [])
    }
    cases = []
    for rendered in render_backend_prompt_contracts():
        prompt_id = rendered["id"]
        value = rendered["value"]
        exp = expected.get(prompt_id)
        actual_hash = _sha256(value)
        haystack = _display(value)
        missing_required = [
            token for token in (exp or {}).get("required", [])
            if token not in haystack
        ]
        ok = bool(exp) and actual_hash == exp.get("sha256") and not missing_required
        cases.append(
            {
                "id": prompt_id,
                "ok": ok,
                "sha256": actual_hash,
                "expected_sha256": (exp or {}).get("sha256"),
                "missing_fixture": exp is None,
                "missing_required": missing_required,
            }
        )
    missing_renderers = sorted(set(expected) - {case["id"] for case in cases})
    for prompt_id in missing_renderers:
        cases.append(
            {
                "id": prompt_id,
                "ok": False,
                "sha256": None,
                "expected_sha256": expected[prompt_id].get("sha256"),
                "missing_renderer": True,
                "missing_required": [],
            }
        )
    return {
        "schema": SCHEMA,
        "pass": all(case["ok"] for case in cases),
        "fixture": str(fixture_path),
        "cases": cases,
    }


def _dump_current() -> dict[str, Any]:
    return {
        "schema": SCHEMA,
        "prompts": [
            {"id": row["id"], "sha256": _sha256(row["value"])}
            for row in render_backend_prompt_contracts()
        ],
    }


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--dump", action="store_true")
    parser.add_argument("--check", action="store_true", help="Compatibility no-op; checking is the default.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    payload = _dump_current() if args.dump else run_prompt_contract_floor(args.fixture)
    if args.json or args.dump:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
    elif payload.get("pass"):
        print(f"backend prompt-regression fixture floor: PASS ({len(payload['cases'])} cases)")
    else:
        print("backend prompt-regression fixture floor: FAIL", file=sys.stderr)
        for case in payload.get("cases", []):
            if not case.get("ok"):
                print(f"  {case['id']}", file=sys.stderr)
    return 0 if payload.get("pass", True) else 1


if __name__ == "__main__":
    raise SystemExit(main())
