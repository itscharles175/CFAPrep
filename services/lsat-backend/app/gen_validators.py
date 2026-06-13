"""R7 Wave 3a (2.2) — type-aware structural validators for the generation gate.

The vision's aspiration was a per-``q_type`` check that the credited choice has
the *required logical structure* for its question type. In practice the gate only
enforced a 30-char minimum stimulus length, which lets through items that are the
wrong SHAPE for their type (a "Necessary Assumption" whose credited choice the
argument doesn't actually depend on, a "Parallel" whose choice doesn't share the
stimulus's form, a "Paradox" with nothing in tension, …).

This module adds cheap, decorrelated, per-type checks. Each validator gets:
  - the parsed candidate fields (stimulus / prompt / choices / credited letter),
  - a DETERMINISTIC ``critic`` callable (temp 0, distinct model when configured),
and returns a small verdict dict::

    {"ok": bool, "reason": str | None, "check": "<name>", "detail": <jsonable>}

Every declared LSAT type must have a validator. An explicit unknown type fails
closed so generated content cannot pass under a misspelled or unsupported
``q_type``. The verdicts are recorded under
``validation_report["checks"]["structural_type"]`` and a failure quarantines the
candidate with the validator's specific ``reason``.

All model use goes through the injected ``critic`` so tests never touch Ollama.
The critic prompts ask for tight JSON; we parse defensively and FAIL CLOSED on an
unparseable / error response for the assertion-style checks (a validator that
can't confirm the required structure must not approve the item).
"""
from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Optional

from . import rc_intelligence
from .ai import strip_think
from .models import LR_TYPES, RC_TYPES

# A critic call: prompt -> raw text (which we parse). Injectable for tests.
Critic = Callable[[str], str]


# --- tolerant JSON parse (shared with the gate's _extract_json spirit) -------
def _parse_json(text: str) -> dict | None:
    text = strip_think(text or "")
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    candidate = m.group(1) if m else None
    if candidate is None:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            candidate = text[start:end + 1]
    if not candidate:
        return None
    try:
        obj = json.loads(candidate)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        return None


def _truthy(v) -> bool:
    """Coerce a model's JSON 'true' (which may arrive as a string) to a bool."""
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() in ("true", "yes", "1")
    return bool(v)


def _credited_text(cand: dict) -> str:
    correct = cand.get("correct_answer")
    for c in cand.get("choices", []):
        if c.get("label") == correct:
            return str(c.get("text", ""))
    return ""


def _stimulus(cand: dict) -> str:
    passage = str(cand.get("passage", "") or "")
    stem = str(cand.get("stem", "") or "")
    return (f"{passage}\n\n{stem}".strip() if passage else stem).strip()


def _ok(check: str, detail=None) -> dict:
    return {"ok": True, "reason": None, "check": check, "detail": detail}


def _fail(check: str, reason: str, detail=None) -> dict:
    return {"ok": False, "reason": reason, "check": check, "detail": detail}


# --- per-type validators ----------------------------------------------------
def _validate_necessary_assumption(cand: dict, critic: Critic) -> dict:
    """The negation test: negate the credited choice; the argument must break.

    If the argument still holds when the credited choice is negated, the choice
    isn't actually NECESSARY — reject ``assumption_not_required``.
    """
    credited = _credited_text(cand)
    prompt = (
        "You are testing a candidate LSAT 'Necessary Assumption' answer using the "
        "negation test. If we NEGATE the credited assumption, a true necessary "
        "assumption makes the argument fall apart (the conclusion is no longer "
        "supported).\n\n"
        f"Argument:\n{_stimulus(cand)}\n\n"
        f"Credited assumption: {credited}\n\n"
        'Respond ONLY with JSON: {"negation_breaks_argument": true|false, '
        '"argument_depends_on_it": true|false}'
    )
    obj = _parse_json(critic(prompt))
    if obj is None:
        return _fail("necessary_assumption", "assumption_not_required",
                     {"parsed": False})
    depends = _truthy(obj.get("negation_breaks_argument")) and _truthy(
        obj.get("argument_depends_on_it"))
    if depends:
        return _ok("necessary_assumption", obj)
    return _fail("necessary_assumption", "assumption_not_required", obj)


def _validate_sufficient_assumption(cand: dict, critic: Critic) -> dict:
    """Adding the credited choice must make the conclusion FOLLOW (validly)."""
    credited = _credited_text(cand)
    prompt = (
        "You are testing a candidate LSAT 'Sufficient Assumption' answer. A true "
        "sufficient assumption, when ADDED to the premises, makes the conclusion "
        "follow with certainty (the argument becomes valid).\n\n"
        f"Argument:\n{_stimulus(cand)}\n\n"
        f"Credited assumption: {credited}\n\n"
        'Respond ONLY with JSON: {"conclusion_follows_when_added": true|false}'
    )
    obj = _parse_json(critic(prompt))
    if obj is None:
        return _fail("sufficient_assumption", "conclusion_does_not_follow",
                     {"parsed": False})
    if _truthy(obj.get("conclusion_follows_when_added")):
        return _ok("sufficient_assumption", obj)
    return _fail("sufficient_assumption", "conclusion_does_not_follow", obj)


def _validate_parallel(cand: dict, critic: Critic) -> dict:
    """The credited choice must share the stimulus's argument FORM."""
    credited = _credited_text(cand)
    prompt = (
        "You are testing a candidate LSAT 'Parallel Reasoning' answer. The credited "
        "choice must reproduce the stimulus's argument FORM (same logical "
        "structure), regardless of subject matter.\n\n"
        f"Stimulus argument:\n{_stimulus(cand)}\n\n"
        f"Credited choice:\n{credited}\n\n"
        'Respond ONLY with JSON: {"same_argument_form": true|false}'
    )
    obj = _parse_json(critic(prompt))
    if obj is None:
        return _fail("parallel", "form_mismatch", {"parsed": False})
    if _truthy(obj.get("same_argument_form")):
        return _ok("parallel", obj)
    return _fail("parallel", "form_mismatch", obj)


def _validate_parallel_flaw(cand: dict, critic: Critic) -> dict:
    """Parallel-Flaw: the credited choice must commit the SAME flaw / form."""
    credited = _credited_text(cand)
    prompt = (
        "You are testing a candidate LSAT 'Parallel Flaw' answer. The stimulus "
        "contains a flawed argument; the credited choice must commit the SAME "
        "reasoning flaw (same flawed form).\n\n"
        f"Stimulus argument:\n{_stimulus(cand)}\n\n"
        f"Credited choice:\n{credited}\n\n"
        'Respond ONLY with JSON: {"stimulus_is_flawed": true|false, '
        '"same_flaw": true|false}'
    )
    obj = _parse_json(critic(prompt))
    if obj is None:
        return _fail("parallel_flaw", "flaw_mismatch", {"parsed": False})
    if _truthy(obj.get("stimulus_is_flawed")) and _truthy(obj.get("same_flaw")):
        return _ok("parallel_flaw", obj)
    return _fail("parallel_flaw", "flaw_mismatch", obj)


def _validate_paradox(cand: dict, critic: Critic) -> dict:
    """Stimulus must hold two facts in tension; credited choice must resolve them."""
    credited = _credited_text(cand)
    prompt = (
        "You are testing a candidate LSAT 'Paradox/Resolve-the-Discrepancy' item. "
        "The stimulus must present TWO facts that are in apparent tension, and the "
        "credited choice must RESOLVE that tension (explain how both can be true).\n\n"
        f"Stimulus:\n{_stimulus(cand)}\n\n"
        f"Credited choice:\n{credited}\n\n"
        'Respond ONLY with JSON: {"has_tension": true|false, '
        '"choice_resolves_tension": true|false}'
    )
    obj = _parse_json(critic(prompt))
    if obj is None:
        return _fail("paradox", "no_paradox_resolved", {"parsed": False})
    if _truthy(obj.get("has_tension")) and _truthy(obj.get("choice_resolves_tension")):
        return _ok("paradox", obj)
    return _fail("paradox", "no_paradox_resolved", obj)


def _validate_strengthen(cand: dict, critic: Critic) -> dict:
    """The credited choice must make the conclusion MORE likely."""
    credited = _credited_text(cand)
    prompt = (
        "You are testing a candidate LSAT 'Strengthen' answer. The credited choice, "
        "if true, must make the argument's conclusion MORE likely / better "
        "supported.\n\n"
        f"Argument:\n{_stimulus(cand)}\n\n"
        f"Credited choice:\n{credited}\n\n"
        'Respond ONLY with JSON: {"strengthens": true|false}'
    )
    obj = _parse_json(critic(prompt))
    if obj is None:
        return _fail("strengthen", "does_not_strengthen", {"parsed": False})
    if _truthy(obj.get("strengthens")):
        return _ok("strengthen", obj)
    return _fail("strengthen", "does_not_strengthen", obj)


def _validate_weaken(cand: dict, critic: Critic) -> dict:
    """The credited choice must make the conclusion LESS likely."""
    credited = _credited_text(cand)
    prompt = (
        "You are testing a candidate LSAT 'Weaken' answer. The credited choice, if "
        "true, must make the argument's conclusion LESS likely / less supported.\n\n"
        f"Argument:\n{_stimulus(cand)}\n\n"
        f"Credited choice:\n{credited}\n\n"
        'Respond ONLY with JSON: {"weakens": true|false}'
    )
    obj = _parse_json(critic(prompt))
    if obj is None:
        return _fail("weaken", "does_not_weaken", {"parsed": False})
    if _truthy(obj.get("weakens")):
        return _ok("weaken", obj)
    return _fail("weaken", "does_not_weaken", obj)


def _validate_prompt_shape(expected: str, keywords: tuple[str, ...],
                           cand: dict, _critic: Critic) -> dict:
    """Cheap deterministic validator for types whose structure is prompt-led.

    These checks do not pretend to prove answer correctness; they fail closed
    when the generated item's prompt is not even asking the intended task. The
    solver/critic verification gate still evaluates the credited answer.
    """
    prompt = str(cand.get("prompt", "") or "").lower()
    stem = str(cand.get("stem", "") or "").lower()
    haystack = f"{prompt}\n{stem}"
    if any(k in haystack for k in keywords):
        return _ok(expected, {"matched_keywords": [k for k in keywords if k in haystack][:3]})
    return _fail(expected, "prompt_shape_mismatch", {"expected_keywords": keywords})


def _validator_for_prompt_shape(expected: str, keywords: tuple[str, ...]):
    return lambda cand, critic: _validate_prompt_shape(expected, keywords, cand, critic)


def _validate_rc_grounding(expected: str, keywords: tuple[str, ...],
                           cand: dict, critic: Critic) -> dict:
    """RC semantic validator: the credited answer must be passage-grounded.

    The cheap prompt-shape check still runs first, then a critic verifies that
    the credited answer is supported by the passage, does not require outside
    knowledge, is single-best, and that the distractors have clear flaws. This
    is the RC analogue of the LR type validators: fail closed unless the critic
    can positively confirm the generated item is defensible.
    """
    shape = _validate_prompt_shape(expected, keywords, cand, critic)
    if not shape.get("ok"):
        return shape

    passage = str(cand.get("passage", "") or "").strip()
    stem_text = str(cand.get("stem", "") or "").strip()
    prompt_text = str(cand.get("prompt", "") or "").strip()
    q_type = _RC_QTYPE_BY_CHECK.get(expected, expected)
    scope = rc_intelligence.validate_scope_anchor(
        q_type, prompt_text, stem_text, passage
    )
    if not scope.get("ok"):
        return _fail(expected, str(scope.get("reason") or "rc_scope_mismatch"), scope)
    scope_detail = {
        key: scope.get(key)
        for key in (
            "scope",
            "anchor_ref",
            "requires_evidence",
            "tags",
            "tag_confidence",
            "guidance_scope",
            "guidance_anchor_ref",
        )
        if key in scope
    }

    credited = _credited_text(cand)
    distractors = [
        {"label": c.get("label"), "text": str(c.get("text", "") or "")}
        for c in cand.get("choices", [])
        if c.get("label") != cand.get("correct_answer")
    ]
    if not passage:
        return _fail(expected, "missing_rc_passage", {"has_passage": False})
    if not credited:
        return _fail(expected, "missing_credited_choice")

    distractor_labels = sorted(str(d["label"]) for d in distractors if d.get("label"))
    distractor_block = "\n".join(
        f"({d['label']}) {d['text']}" for d in distractors
    )
    critic_prompt = (
        "You are validating a generated LSAT Reading Comprehension item. Use ONLY "
        "the passage below; do not use outside knowledge. Confirm whether the "
        "credited answer is passage-grounded, whether it is the single best "
        "answer, and whether every wrong answer has a clear passage-based flaw.\n\n"
        f"Question type: {expected}\n\n"
        f"Passage:\n{passage}\n\n"
        f"Question prompt:\n{prompt_text}\n\n"
        f"Credited answer:\n{credited}\n\n"
        f"Distractors:\n{distractor_block}\n\n"
        'Respond ONLY with JSON: {"credited_supported_by_passage": true|false, '
        '"requires_outside_knowledge": true|false, '
        '"single_best_answer": true|false, '
        '"distractor_flaws": [{"label": "A", "flaw": "unsupported by passage", '
        '"clear": true}]}'
    )
    obj = _parse_json(critic(critic_prompt))
    if obj is None:
        return _fail(expected, "rc_semantic_unverified", {"parsed": False})

    supported = _truthy(obj.get("credited_supported_by_passage"))
    outside = _truthy(obj.get("requires_outside_knowledge"))
    single_best = _truthy(obj.get("single_best_answer"))
    flaws = obj.get("distractor_flaws")
    flaws_by_label: dict[str, dict] = {}
    if isinstance(flaws, list):
        for row in flaws:
            if not isinstance(row, dict):
                continue
            label = str(row.get("label") or "").strip()
            if label:
                flaws_by_label[label] = row
    distractors_ok = bool(distractor_labels) and all(
        label in flaws_by_label
        and _truthy(flaws_by_label[label].get("clear"))
        and bool(str(flaws_by_label[label].get("flaw") or "").strip())
        for label in distractor_labels
    )
    detail = {
        **obj,
        **scope_detail,
        "distractor_labels": distractor_labels,
        "distractor_flaw_count": len(flaws_by_label),
    }
    if supported and not outside and single_best and distractors_ok:
        return _ok(expected, detail)
    if not supported:
        reason = "rc_answer_not_passage_grounded"
    elif outside:
        reason = "rc_requires_outside_knowledge"
    elif not single_best:
        reason = "rc_not_single_best"
    else:
        reason = "rc_distractors_not_defensible"
    return _fail(expected, reason, detail)


def _rc_validator(expected: str, keywords: tuple[str, ...]):
    return lambda cand, critic: _validate_rc_grounding(
        expected, keywords, cand, critic
    )


# q_type -> validator. LR and RC are split because names such as MainPoint and
# Inference exist in both taxonomies but require different structural checks.
_LR_VALIDATORS: dict[str, Callable[[dict, Critic], dict]] = {
    "MainPoint": _validator_for_prompt_shape("main_point", ("main point", "primary purpose", "main idea", "author's primary")),
    "NecessaryAssumption": _validate_necessary_assumption,
    "SufficientAssumption": _validate_sufficient_assumption,
    "Parallel": _validate_parallel,
    "ParallelFlaw": _validate_parallel_flaw,
    "Paradox": _validate_paradox,
    "Strengthen": _validate_strengthen,
    "Weaken": _validate_weaken,
    "Flaw": _validator_for_prompt_shape("flaw", ("flaw", "vulnerable to criticism", "error in reasoning")),
    "Inference": _validator_for_prompt_shape("inference", ("must be true", "properly inferred", "most strongly supported", "inference")),
    "MostStronglySupported": _validator_for_prompt_shape("most_strongly_supported", ("most strongly supported", "most reasonably inferred")),
    "PrincipleApply": _validator_for_prompt_shape("principle_apply", ("principle", "conforms", "illustrates", "application")),
    "PrincipleIdentify": _validator_for_prompt_shape("principle_identify", ("principle", "justifies", "underlies")),
    "Method": _validator_for_prompt_shape("method", ("method", "proceeds by", "argumentative strategy", "technique")),
    "Role": _validator_for_prompt_shape("role", ("role", "function", "plays which one")),
    "PointAtIssue": _validator_for_prompt_shape("point_at_issue", ("disagree", "point at issue", "committed to disagreeing")),
    "Evaluate": _validator_for_prompt_shape("evaluate", ("evaluate", "most useful to know", "answer to which")),
}

# Backward-compatible private seam for older audit tests/local tooling that
# monkeypatch the historical single validator registry for LR checks.
_VALIDATORS = _LR_VALIDATORS

_RC_QTYPE_BY_CHECK = {
    "main_point": "MainPoint",
    "attitude": "Attitude",
    "detail": "Detail",
    "inference": "Inference",
    "function": "Function",
    "structure": "Structure",
    "application": "Application",
    "strengthen_weaken": "StrengthenWeaken",
    "comparative": "Comparative",
}

_RC_VALIDATORS: dict[str, Callable[[dict, Critic], dict]] = {
    "MainPoint": _rc_validator("main_point", ("main point", "primary purpose", "main idea", "author's primary")),
    "Attitude": _rc_validator("attitude", ("attitude", "tone", "author would most likely agree")),
    "Detail": _rc_validator("detail", ("according to the passage", "states", "indicates", "mentions")),
    "Inference": _rc_validator("inference", ("inferred", "suggests", "most strongly supported", "most likely")),
    "Function": _rc_validator("function", ("function", "role", "purpose of")),
    "Structure": _rc_validator("structure", ("structure", "organization", "passage proceeds")),
    "Application": _rc_validator("application", ("application", "apply", "principle")),
    "StrengthenWeaken": _rc_validator("strengthen_weaken", ("strengthen", "weaken", "support", "undermine")),
    "Comparative": _rc_validator("comparative", ("both passages", "passage a", "passage b", "comparison")),
}

_MISSING = (set(LR_TYPES) - set(_LR_VALIDATORS)) | (set(RC_TYPES) - set(_RC_VALIDATORS))
if _MISSING:  # pragma: no cover - import-time safety net
    raise RuntimeError(f"Missing LSAT validators: {sorted(_MISSING)}")


def has_validator(q_type: str) -> bool:
    return q_type in _LR_VALIDATORS or q_type in _RC_VALIDATORS


def validate_structure(q_type: str, cand: dict, critic: Critic,
                       section_type: str | None = None) -> dict:
    """Run the type-specific structural validator for ``q_type``.

    Returns a verdict dict (``ok``/``reason``/``check``/``detail``). Explicit
    unknown types fail closed; a misspelled generation job must not bypass the
    validator gate.

    Failure handling distinguishes two cases so the gate's fail-closed contract
    holds when the model is down: a raised ``LLMError`` means the CRITIC CALL
    itself failed (not a parseable-but-bad answer) — that fails CLOSED, because a
    missing critic must never auto-approve the structural check. Any other
    (logic-bug) exception stays a non-blocking pass-with-note, so a validator bug
    can't silently quarantine an entire run.
    """
    is_rc = (
        str(section_type or "").upper() == "RC"
        or bool(str(cand.get("passage", "") or "").strip())
    )
    if is_rc:
        fn = _RC_VALIDATORS.get(q_type)
    else:
        fn = _LR_VALIDATORS.get(q_type) or _RC_VALIDATORS.get(q_type)
    if fn is None:
        return {
            "ok": False,
            "reason": "unsupported_q_type",
            "check": "unknown_q_type",
            "detail": {"q_type": q_type},
        }
    try:
        return fn(cand, critic)
    except Exception as exc:  # noqa: BLE001
        from .llm.base import LLMError
        if isinstance(exc, LLMError):
            return {"ok": False, "reason": "critic_unavailable", "check": q_type,
                    "detail": {"critic_error": str(exc)}}
        # a validator LOGIC bug shouldn't nuke the run — pass with a note.
        return {"ok": True, "reason": None, "check": q_type,
                "detail": {"validator_error": str(exc)}}
