"""Tier B drill generation with a validation gate.

A background job calls the gen model (qwen3:14b) to produce drill variations of a
weak q_type, modeled on a real parent question. Every candidate must pass:

  (a) decorrelated solve - a SEPARATE critic model solves the item once,
      deterministically (temp 0); its answer must equal the credited answer. This
      is the AUTHORITATIVE correctness signal. A secondary self-consistency probe
      re-samples the solver N times (default 3) and must be stable.
  (b) single defensible - a critique pass finds no second defensible answer.
  (c) no length tell     - the correct choice isn't systematically longest/shortest.
  (d) structural sanity  - basic shape checks for the q_type (5 choices A-E, etc.).

plus permutation-invariance, text-informativity, lexical-leak, CoVe, multi-model
agreement, RC-authenticity, and embedding-dedup layers (see ``validate_candidate``).

Accepted items get source="ai_generated", approved=True, parent_question_id set.
Failed / low-confidence items are stored quarantined (approved=False) and never
served until manually approved. The per-candidate verdicts are recorded in
GenJob.validation_report.

Counts are small/fast-configurable so a job never hangs.
"""
from __future__ import annotations

import json
import logging
import re
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Optional, Union

from sqlmodel import Session, select

from . import config, embeddings, gen_validators, llm, rc_intelligence

log = logging.getLogger("lsatlab.generation")
from .ai import strip_think
from .db import engine
from .models import (
    LR_TYPES,
    RC_TYPES,
    AnswerChoice,
    Attempt,
    GenCandidate,
    AttemptMode,
    GenJob,
    GenStatus,
    Passage,
    PrepTest,
    Question,
    QuestionSource,
    Section,
    SectionType,
    ValidatorRun,
)

_LABELS = ["A", "B", "C", "D", "E"]
_TRAP_TYPES = (
    "reversal",
    "out_of_scope",
    "degree",
    "scope_shift",
    "half_right",
    "opposite",
    "too_strong",
    "irrelevant_comparison",
    "premise_restatement",
    "none",
)
# A real LSAT stimulus carries enough text to support the reasoning. Reject
# degenerate one-liners the model sometimes emits.
_MIN_STIMULUS_CHARS = 30
# Generated RC items live under this synthetic PrepTest so they get a real
# passage_id (and are therefore drillable like any RC question).
_AI_PREPTEST_NAME = "AI Generated (drills)"


# Bank-expansion plan Wave 1.3 — strict JSON Schema for candidate decoding.
# Ollama 0.5+ accepts a JSON Schema in the ``format`` field of /api/generate,
# which forces the model's output through a constrained decoder. That gives us
# a hard guarantee on the envelope (5 choices A-E, correct_letter is A-E, etc.)
# so the gate's downstream structural check never has to handle a missing
# ``choices`` key or an off-by-one label. The model may still produce subtly
# wrong CONTENT (that's what the rest of the gate is for), but it cannot emit
# malformed JSON or an obviously broken envelope.
_CANDIDATE_SCHEMA: dict = {
    "type": "object",
    "required": ["stem", "prompt", "choices", "correct_answer"],
    "properties": {
        # Optional: only RC candidates carry a separate passage. We tolerate
        # its absence on LR rather than rejecting the entire candidate.
        "passage": {"type": "string"},
        "stem": {"type": "string"},
        "prompt": {"type": "string"},
        "difficulty": {"type": "integer", "minimum": 1, "maximum": 5},
        "correct_answer": {"type": "string", "enum": ["A", "B", "C", "D", "E"]},
        "choices": {
            "type": "array",
            "minItems": 5,
            "maxItems": 5,
            "items": {
                "type": "object",
                "required": ["label", "text", "trap_type"],
                "properties": {
                    "label": {"type": "string", "enum": ["A", "B", "C", "D", "E"]},
                    "text": {"type": "string"},
                    "trap_type": {"type": "string", "enum": list(_TRAP_TYPES)},
                },
            },
        },
    },
}


# --- low-level model call (sync; jobs run in a background thread) ----------
def _generate(prompt: str, system: str | None = None, timeout: float | None = None) -> str:
    """Default offline generator: routes to the cloud model when configured
    (LSATLAB_GEN_PROVIDER=cloud), else the local Ollama gen model. Think tags
    (qwen3) are stripped; cloud output has none so the strip is a no-op there."""
    return strip_think(llm.offline_generate(prompt, system=system, timeout=timeout))


def _candidate_generator(prompt: str, system: str | None = None,
                         timeout: float | None = None) -> str:
    """Live CANDIDATE generator (R7 2.1 + bank-expansion Wave 1.3): asks the
    provider for guaranteed JSON. When ``GEN_STRUCTURED_SCHEMA`` is on (the
    default), Ollama's structured-output mode constrains the response to
    ``_CANDIDATE_SCHEMA`` — a 5-choice A-E candidate envelope — so a malformed
    candidate cannot make it past the decoder. With only ``GEN_STRUCTURED_OUTPUT``
    on we fall back to free-shape JSON (older Ollama / non-Ollama providers).
    ``_extract_json`` stays as a last-resort fallback either way.
    """
    fmt: Optional[Union[str, dict]] = None
    if config.GEN_STRUCTURED_SCHEMA:
        fmt = _CANDIDATE_SCHEMA
    elif config.GEN_STRUCTURED_OUTPUT:
        fmt = "json"
    return strip_think(llm.offline_generate(
        prompt, system=system, timeout=timeout,
        temperature=config.GEN_CANDIDATE_TEMPERATURE,
        format=fmt,
    ))


def _gate_critic(prompt: str, system: str | None = None,
                 timeout: float | None = None) -> str:
    """Live gate SOLVE/CRITIQUE critic (R7 2.1/2.3): a model DISTINCT from the
    generator (``critic_model``) run DETERMINISTICALLY (temp 0 + fixed seed) so
    the gate measures item soundness, not sampling luck, and a model can't
    rubber-stamp its own flawed output (correlated errors)."""
    return strip_think(llm.critic_generate(
        prompt, system=system, timeout=timeout,
        temperature=config.GEN_GATE_TEMPERATURE, seed=config.GEN_GATE_SEED,
    ))


def _candidate_embedder(text: str) -> list[float]:
    """Live embedder for the generation-time dedup gate (always local)."""
    return llm.embed_sync(text)


def _extract_json(text: str) -> dict | None:
    """Pull the first JSON object out of a model response."""
    text = strip_think(text)
    # try fenced block first
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
        return json.loads(candidate)
    except json.JSONDecodeError:
        return None


# --- prompts ----------------------------------------------------------------
_TRAP_HELP = (
    "trap_type must be one of: "
    + ", ".join(_TRAP_TYPES)
    + ". The correct choice uses trap_type 'none'."
)


def _coaching_note(session: Session, q_type: str) -> str:
    """W2-2 — fold the most common recent gate failure into the next prompt."""
    quality = generation_quality(session)
    reasons: dict[str, int] = quality.get("fail_reasons") or {}
    if not reasons:
        return ""
    reason, _ = max(reasons.items(), key=lambda kv: kv[1])
    by_type = (quality.get("by_type") or {}).get(q_type, {})
    if by_type.get("failed", 0) < 1:
        return ""
    return (
        f"\nRecent generation attempts for '{q_type}' often failed because: "
        f"{reason}. Avoid repeating that failure mode.\n"
    )


def _clip_for_prompt(value: Any, limit: int = 220) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit]


def _rc_generation_context(
    session: Session,
    parent: Question | None,
    q_type: str,
) -> dict[str, Any]:
    if parent is None or parent.passage_id is None:
        return {}
    try:
        passage_map = rc_intelligence.analyze_passage(
            session, parent.passage_id, persist=False
        )
    except Exception as exc:  # noqa: BLE001
        log.debug(
            "RC generation context unavailable for passage_id=%s: %s",
            parent.passage_id,
            exc,
        )
        return {}

    structure = passage_map.get("structure") or {}
    question_tags = passage_map.get("question_tags") or []
    matching_tags = [
        row for row in question_tags
        if str(row.get("q_type") or "") == q_type
    ]
    target_tag = (
        matching_tags[0]
        if matching_tags
        else rc_intelligence.guidance_for_q_type(q_type)
    )
    paragraph_roles = []
    for row in (passage_map.get("paragraph_roles") or [])[:4]:
        paragraph_roles.append({
            "index": row.get("index"),
            "line_ref": row.get("line_ref"),
            "role": row.get("role"),
            "attitude": row.get("author_attitude"),
            "claim_density": row.get("claim_density"),
            "viewpoint": row.get("viewpoint") or {},
            "evidence_markers": list(row.get("evidence_markers") or []),
        })

    return {
        "parent_passage_id": parent.passage_id,
        "generated_by": passage_map.get("generated_by"),
        "passage_type": structure.get("passage_type"),
        "paragraph_count": structure.get("paragraph_count"),
        "dominant_viewpoint": structure.get("dominant_viewpoint"),
        "evidence_anchor_count": structure.get("evidence_anchor_count"),
        "main_point_hint": _clip_for_prompt(structure.get("main_point_hint")),
        "question_mix": structure.get("question_mix") or {},
        "line_reference_density": structure.get("line_reference_density"),
        "tag_coverage": structure.get("tag_coverage") or {},
        "target_scope": target_tag.get("scope"),
        "target_anchor_ref": target_tag.get("anchor_ref"),
        "target_requires_evidence": target_tag.get("requires_evidence"),
        "target_tags": list(target_tag.get("tags") or []),
        "target_tag_confidence": target_tag.get("tag_confidence"),
        "paragraph_roles": paragraph_roles,
        "evidence_refs": [
            {
                "line_ref": row.get("line_ref"),
                "marker": row.get("marker"),
                "evidence_type": row.get("evidence_type"),
                "text_preview": _clip_for_prompt(row.get("text_preview"), 160),
            }
            for row in (passage_map.get("evidence_refs") or [])[:3]
        ],
    }


def _format_rc_generation_context(context: dict[str, Any]) -> str:
    if not context:
        return ""
    roles = ", ".join(
        f"{row.get('line_ref') or ('P' + str(row.get('index')))}={row.get('role')}"
        for row in context.get("paragraph_roles", [])
        if row.get("index") and row.get("role")
    )
    viewpoints = ", ".join(
        f"{row.get('line_ref') or ('P' + str(row.get('index')))}="
        f"{((row.get('viewpoint') or {}).get('label') or 'viewpoint')}"
        for row in context.get("paragraph_roles", [])
        if row.get("index") and row.get("viewpoint")
    )
    evidence_refs = "; ".join(
        f"{row.get('line_ref')}: {row.get('evidence_type')} via {row.get('marker')}"
        for row in context.get("evidence_refs", [])
        if row.get("line_ref") and row.get("marker")
    )
    tags = ", ".join(context.get("target_tags") or [])
    mix = ", ".join(
        f"{name}:{count}"
        for name, count in sorted((context.get("question_mix") or {}).items())
    )
    coverage = context.get("tag_coverage") or {}
    lines = [
        "\nRC passage map guidance:",
        "- Use this as structure guidance only; write a new passage and do not copy the parent.",
        (
            f"- Passage shape: {context.get('passage_type') or 'single'}; "
            f"paragraphs: {context.get('paragraph_count') or 'unknown'}."
        ),
    ]
    if roles:
        lines.append(f"- Paragraph role pattern: {roles}.")
    if viewpoints:
        lines.append(
            f"- Viewpoint pattern: {viewpoints}; dominant="
            f"{context.get('dominant_viewpoint') or 'not_clear'}."
        )
    if evidence_refs:
        lines.append(f"- Evidence anchors to imitate structurally, not copy: {evidence_refs}.")
    if context.get("main_point_hint"):
        lines.append(f"- Parent main-point hint to abstract away from: {context['main_point_hint']}.")
    if mix:
        lines.append(f"- Parent question mix: {mix}.")
    if tags or context.get("target_scope"):
        lines.append(
            "- Target question focus: "
            f"scope={context.get('target_scope') or 'type_inferred'}; "
            f"anchor={context.get('target_anchor_ref') or 'type_inferred'}; "
            f"tags={tags or 'type_inferred'}."
        )
    if context.get("target_requires_evidence"):
        lines.append(
            "- Require the credited answer and every tempting wrong answer to be grounded "
            "in a specific passage role or local evidence anchor."
        )
    if coverage:
        lines.append(
            "- Tag coverage evidence: "
            f"{coverage.get('tagged_questions', 0)}/"
            f"{coverage.get('total_questions', 0)} tagged; "
            f"low_confidence={coverage.get('low_confidence', 0)}."
        )
    if context.get("line_reference_density"):
        lines.append(
            "- If writing a line/paragraph-local item, make the cited text explicit enough "
            "for the credited answer to be passage-grounded."
        )
    return "\n".join(lines) + "\n"


def _gen_prompt(q_type: str, parent: Question | None,
                parent_choices: list[AnswerChoice], *,
                section_type: str = "LR", parent_passage: str = "",
                coaching_note: str = "",
                rc_context: dict[str, Any] | None = None) -> str:
    ch = ""
    if parent:
        ch = "\n".join(f"({c.label}) {c.text}" for c in parent_choices)

    if section_type == "RC":
        example = ""
        if parent:
            ptxt = (parent_passage or parent.stem or "")[:1200]
            example = (
                f"\nModel it loosely on this real {q_type} item (do NOT copy it):\n"
                f"Passage: {ptxt}\nPrompt: {parent.prompt}\nChoices:\n{ch}\n"
            )
        steering = _format_rc_generation_context(rc_context or {})
        return (
            "Write ONE original LSAT-style Reading Comprehension passage (about "
            "three short paragraphs on an academic topic) and ONE question of type "
            f"'{q_type}' about it, with exactly five answer choices A-E and exactly "
            f"one correct answer.{example}{steering}{coaching_note}\n\n"
            "Respond with ONLY a JSON object of this shape:\n"
            '{"passage": "...", "stem": "", "prompt": "...", "difficulty": 3, '
            '"choices": [{"label":"A","text":"...","trap_type":"out_of_scope"}, ...], '
            '"correct_answer": "B"}\n' + _TRAP_HELP
        )

    example = ""
    if parent:
        example = (
            f"\nModel it loosely on this real {q_type} question (do NOT copy it):\n"
            f"Stimulus: {parent.stem}\nPrompt: {parent.prompt}\nChoices:\n{ch}\n"
        )
    return (
        f"Write ONE original LSAT-style Logical Reasoning question of type "
        f"'{q_type}'. It must have a stimulus, a prompt, and exactly five answer "
        f"choices A-E with exactly one correct answer.{example}{coaching_note}\n\n"
        "Respond with ONLY a JSON object of this shape:\n"
        '{"stem": "...", "prompt": "...", "difficulty": 3, '
        '"choices": [{"label":"A","text":"...","trap_type":"out_of_scope"}, ...], '
        '"correct_answer": "B"}\n' + _TRAP_HELP
    )


def _solve_prompt(stem: str, prompt: str, choices: list[dict]) -> str:
    ch = "\n".join(f"({c['label']}) {c['text']}" for c in choices)
    return (
        f"Solve this LSAT question. Stimulus:\n{stem}\n\nPrompt: {prompt}\n\n"
        f"Choices:\n{ch}\n\nRespond with ONLY the single letter of the best answer."
    )


def _critique_prompt(stem: str, prompt: str, choices: list[dict]) -> str:
    ch = "\n".join(f"({c['label']}) {c['text']}" for c in choices)
    return (
        f"You are a strict LSAT item reviewer. For this question, decide whether "
        f"exactly ONE answer is defensibly correct.\n\nStimulus:\n{stem}\n\n"
        f"Prompt: {prompt}\n\nChoices:\n{ch}\n\n"
        'Respond with ONLY JSON: {"single_defensible": true|false, '
        '"defensible_letters": ["A"]}'
    )


def _distractor_quality_prompt(
    stem: str, prompt: str, choices: list[dict], correct: str
) -> str:
    distractors = [c for c in choices if c.get("label") != correct]
    ch = "\n".join(
        f"({c['label']}) {c['text']} [claimed_trap={c.get('trap_type') or 'unknown'}]"
        for c in distractors
    )
    return (
        "You are a strict LSAT distractor-quality reviewer. Wrong answer choices "
        "must be tempting but clearly wrong for a recognizable LSAT reason. "
        "Reject throwaways, duplicates of the credited answer, joke answers, "
        "choices that are obviously irrelevant, and choices whose flaw cannot be "
        "explained from the stimulus.\n\n"
        f"Stimulus:\n{stem}\n\nPrompt: {prompt}\n\n"
        f"Credited answer: {correct}\n\nDistractors:\n{ch}\n\n"
        'Respond with ONLY JSON: {"distractors_plausible": true|false, '
        '"plausible_labels": ["A","C","D","E"], '
        '"weak_distractors": [{"label":"A","reason":"why it is weak"}]}.'
    )


def _distractor_quality(
    stem: str, prompt: str, choices: list[dict], correct: str, critic,
    *, enabled: Optional[bool] = None,
) -> dict:
    """Critic-verified distractor moat for generated items.

    The model must explicitly cover every wrong label. Missing or unparseable
    evidence fails closed when the gate is enabled.
    """
    labels = sorted(str(c.get("label")) for c in choices if c.get("label") != correct)
    gate_enabled = config.GEN_DISTRACTOR_QUALITY_CHECK if enabled is None else bool(enabled)
    if not gate_enabled:
        return {"ok": True, "skipped": True, "expected_labels": labels}
    try:
        raw = critic(_distractor_quality_prompt(stem, prompt, choices, correct))
        obj = _extract_json(raw) or {}
    except Exception as exc:  # noqa: BLE001
        log.warning("B26: distractor-quality critic call failed", exc_info=True)
        return {
            "ok": False,
            "skipped": False,
            "reason": "distractor_quality_unverified",
            "expected_labels": labels,
            "critic_error": str(exc),
        }
    plausible_labels = sorted(str(label) for label in (obj.get("plausible_labels") or []))
    weak = obj.get("weak_distractors") or []
    covers_all = plausible_labels == labels
    ok = (
        obj.get("distractors_plausible") is True
        and covers_all
        and isinstance(weak, list)
        and len(weak) == 0
    )
    reason = None
    if not ok:
        reason = "weak_distractors" if weak else "distractor_quality_unverified"
    return {
        "ok": ok,
        "skipped": False,
        "reason": reason,
        "expected_labels": labels,
        "plausible_labels": plausible_labels,
        "weak_distractors": weak,
        "covers_all": covers_all,
    }


def _trap_metadata_integrity(choices: list[dict], correct: str) -> dict:
    """Deterministic guard for per-choice trap taxonomy metadata.

    The critic judges whether distractors are plausible. This cheaper check
    verifies the generated item's labels are usable downstream by analytics,
    trap-RAG, and remediation playlists before any model calls happen.
    """
    allowed = set(_TRAP_TYPES)
    trap_by_label: dict[str, str | None] = {}
    problems: list[dict[str, str]] = []
    for choice in choices:
        label = str(choice.get("label") or "").strip()
        raw = choice.get("trap_type")
        trap = str(raw).strip() if raw is not None else ""
        trap_by_label[label] = trap or None
        if not trap:
            problems.append({"label": label, "reason": "missing_trap_type"})
            continue
        if trap not in allowed:
            problems.append({
                "label": label,
                "trap_type": trap,
                "reason": "unsupported_trap_type",
            })
            continue
        if label == correct and trap != "none":
            problems.append({
                "label": label,
                "trap_type": trap,
                "reason": "correct_choice_must_use_none",
            })
        elif label != correct and trap == "none":
            problems.append({
                "label": label,
                "trap_type": trap,
                "reason": "distractor_must_use_trap",
            })
    ok = len(problems) == 0
    return {
        "ok": ok,
        "reason": None if ok else "trap_metadata",
        "allowed": list(_TRAP_TYPES),
        "trap_types": trap_by_label,
        "problems": problems,
    }


def _multi_model_agreement(
    stimulus: str,
    prompt: str,
    choices: list[dict],
    correct: str,
    *,
    model_solver=None,
) -> dict:
    """Bank-expansion plan Wave 3.2 — 2-of-3 local solver agreement.

    Each configured model solves the item on the identity permutation. Accept
    when at least two models pick the same letter AND that letter equals the
    credited answer. Short-circuits after the first two models agree with each
    other (skips the slower thinking-mode model when configured third).
    """
    # De-duplicate solver ids: a misconfigured GEN_SOLVER_MODELS that repeats a
    # model would otherwise let ONE model "vote" twice and pass 2-of-3 agreement
    # on a single voter, defeating the decorrelation. Order-preserving.
    models = list(dict.fromkeys(config.GEN_SOLVER_MODELS))[:3]
    if not config.GEN_MULTI_MODEL_AGREEMENT or len(models) < 2:
        return {"ok": True, "skipped": True}

    def _default_solver(model: str, sp: str) -> str | None:
        try:
            raw = llm.offline_generate(
                sp, temperature=0, seed=7, model=model, task="multi_model_solve",
            )
            return _extract_letter(raw)
        except Exception:  # noqa: BLE001
            return None

    solve_one = model_solver or _default_solver
    sp = _solve_prompt(stimulus, prompt, choices)
    picks: dict[str, str | None] = {}
    for idx, model in enumerate(models):
        if idx == 2 and len(picks) >= 2:
            first_two = list(picks.values())[:2]
            if first_two[0] and first_two[0] == first_two[1]:
                break  # short-circuit: skip slow third model
        picks[model] = solve_one(model, sp)

    letters = [v for v in picks.values() if v]
    if len(letters) < 2:
        return {"ok": False, "skipped": False, "picks": picks, "reason": "insufficient_models"}
    from collections import Counter
    top_letter, top_count = Counter(letters).most_common(1)[0]
    agree_ok = top_count >= 2 and top_letter == correct
    return {"ok": agree_ok, "skipped": False, "picks": picks, "modal": top_letter}


def _cove_verify_prompt(stem: str, prompt: str, choices: list[dict]) -> str:
    """Bank-expansion plan Wave 3.1 — Chain-of-Verification isolated solve.

    The verifier sees stimulus + prompt + choices only (no credited letter).
    A pick that disagrees with the generator's claimed answer means the item
    is unsound under an independent read — the old adversarial pass (which
    was told the credited letter) is replaced by this isolation pattern.
    """
    return _solve_prompt(stem, prompt, choices)


# Bank-expansion plan Wave 2.1 — permutation-invariant self-consistency. A
# robust LSAT solver must pick the same underlying choice regardless of which
# letter that choice currently wears. Three permutations probe positional bias:
# the identity, a one-step rotation, and the inverse-by-text shuffle. Three
# perms is the sweet spot: enough to detect bias, cheap enough for the gate.
_PERM_SHUFFLES: list[list[int]] = [
    [0, 1, 2, 3, 4],
    [1, 2, 3, 4, 0],
    [4, 3, 2, 1, 0],
]


def _permute_choices(choices: list[dict], order: list[int]) -> tuple[list[dict], dict[str, str]]:
    """Return (permuted_choices, new_label_for_old_label).

    ``order`` is a list of indices into ``choices`` (sorted by original label).
    The permuted choices wear labels A-E in their new position; the mapping
    tells callers which NEW label is now occupied by each ORIGINAL label, so
    the solver's answer can be translated back to "which original choice".
    """
    sorted_orig = sorted(choices, key=lambda c: c.get("label", ""))
    new_choices: list[dict] = []
    new_label_for_old: dict[str, str] = {}
    for new_idx, old_idx in enumerate(order):
        old_label = _LABELS[old_idx]
        new_label = _LABELS[new_idx]
        text = next(
            (c.get("text", "") for c in sorted_orig if c.get("label") == old_label),
            "",
        )
        trap = next(
            (c.get("trap_type") for c in sorted_orig if c.get("label") == old_label),
            None,
        )
        new_choices.append({"label": new_label, "text": text, "trap_type": trap})
        new_label_for_old[old_label] = new_label
    return new_choices, new_label_for_old


def _informativity_prompt(stem_replacement: str, prompt: str,
                          choices: list[dict]) -> str:
    """Bank-expansion plan Wave 2.2 — Säuberli-style informativity probe.

    Show the solver the choices + prompt but REPLACE the stimulus with a
    generic placeholder. A well-constructed LSAT item must require the
    stimulus: if the solver picks the credited letter from choices alone the
    item is uninformative (the answer "tells" via choice content).
    """
    ch = "\n".join(f"({c['label']}) {c['text']}" for c in choices)
    return (
        "Solve this LSAT question. You do NOT have the stimulus — pick the "
        "answer that seems best based only on the prompt and the answer "
        "choices, as if guessing on the test.\n\n"
        f"Stimulus: {stem_replacement}\n\nPrompt: {prompt}\n\nChoices:\n{ch}\n\n"
        "Respond with ONLY the single letter of your best guess."
    )


# --- validation gate --------------------------------------------------------
def _extract_letter(text: str) -> str | None:
    m = re.search(r"\b([A-E])\b", strip_think(text))
    return m.group(1) if m else None


def _tfidf_overlap(target_text: str, choice_text: str,
                   distractor_texts: list[str]) -> float:
    """Tf-idf-style overlap score between ``choice_text`` and ``target_text``.

    Pure-Python: tokenize on word boundaries, lowercase, drop stop-word-ish
    tokens (length <= 2), then sum per-token weights where df is computed
    across the choice + each distractor (5 documents total). High score =
    the choice shares many distinctive words with the stimulus + prompt.

    Lives in this module rather than ``tagging`` because the gate must stay
    free of heavy imports (scikit-learn is optional / not always installed).
    """
    import math

    def _tokens(text: str) -> list[str]:
        return [w for w in re.findall(r"[A-Za-z]+", text.lower()) if len(w) > 2]

    target_tokens = set(_tokens(target_text))
    if not target_tokens:
        return 0.0
    docs = [_tokens(choice_text)] + [_tokens(d) for d in distractor_texts]
    df: dict[str, int] = {}
    for d in docs:
        for w in set(d):
            df[w] = df.get(w, 0) + 1
    n_docs = max(1, len(docs))
    choice_tokens = docs[0]
    if not choice_tokens:
        return 0.0
    score = 0.0
    seen = set()
    for w in choice_tokens:
        if w in seen or w not in target_tokens:
            continue
        seen.add(w)
        idf = math.log((1 + n_docs) / (1 + df.get(w, 0))) + 1.0
        score += idf
    return score


# q_types where the lexical-leak check IS meaningful: the correct answer is
# supposed to be argument-extension or structural commentary, not a paraphrase
# of the stimulus, so heavy vocab overlap with the stem is a real "tell" signal.
# All other q_types skip the check because paraphrase / quoting is normal there
# (Inference, Main Point, Detail, Assumption families, Paradox, Evaluate, …).
_LEAK_CHECKED_Q_TYPES = frozenset({
    "Strengthen",
    "Weaken",
    "Flaw",
    "Parallel",
    "ParallelReasoning",
    "Parallel Reasoning",
    "ParallelFlaw",
    "Parallel Flaw",
    "Method",
    "MethodOfReasoning",
    "Method of Reasoning",
    "Principle",
})


def lexical_leak_ok(cand: dict, *, ratio: float | None = None,
                    q_type: str | None = None) -> dict:
    """Bank-expansion plan Wave 1.4 — reject candidates where the credited
    answer "tells" by sharing distinctive vocabulary with the stimulus.

    Compute a tf-idf overlap score between (stimulus + prompt) and each
    choice's text. The check fails when the credited choice's overlap is more
    than ``ratio`` (default ``config.GEN_LEAK_RATIO``) times the median
    distractor's. ``ratio <= 0`` disables the gate entirely.

    Scope:
      - RC items always skip (passage paraphrase is intrinsic).
      - LR ``q_type`` in ``_LEAK_EXEMPT_Q_TYPES`` skips (inference/main-point
        answers restate the stimulus by design).
      - Other LR q_types (Strengthen/Weaken/Flaw/Parallel/Method/Principle/
        Assumption families/etc.) are subject to the check.
    """
    threshold = ratio if ratio is not None else config.GEN_LEAK_RATIO
    choices = cand.get("choices") or []
    correct = cand.get("correct_answer")
    if threshold <= 0 or not choices or correct not in _LABELS:
        return {"ok": True, "skipped": True}
    if (cand.get("passage") or "").strip():
        return {"ok": True, "skipped": True, "reason": "rc_paraphrase_exempt"}
    if not q_type or q_type not in _LEAK_CHECKED_Q_TYPES:
        # Only run the check on q_types where paraphrase is suspicious. For
        # Inference / MainPoint / Detail / Assumption families / etc. a
        # vocab-sharing answer is normal and the heuristic would false-fire.
        return {"ok": True, "skipped": True, "reason": "qtype_not_leak_checked"}
    target = " ".join((cand.get("stem") or "", cand.get("prompt") or "")).strip()
    if not target:
        return {"ok": True, "skipped": True}

    overlaps: dict[str, float] = {}
    for c in choices:
        label = c.get("label")
        text = str(c.get("text") or "")
        if label not in _LABELS:
            continue
        # Use the OTHER 4 choices as the dataframe for df-weighting.
        others = [str(o.get("text") or "") for o in choices if o is not c]
        overlaps[label] = _tfidf_overlap(target, text, others)

    correct_score = overlaps.get(correct, 0.0)
    distractor_scores = sorted(
        v for k, v in overlaps.items() if k != correct
    )
    if not distractor_scores:
        return {"ok": True, "skipped": True}
    mid = distractor_scores[len(distractor_scores) // 2]
    # If the median distractor scored zero, fall back to mean so we don't
    # divide by zero — a single non-zero distractor still anchors the ratio.
    denom = mid if mid > 0 else (
        sum(distractor_scores) / len(distractor_scores) if distractor_scores else 0.0
    )
    ratio_val = (correct_score / denom) if denom > 0 else 0.0
    leak = denom > 0 and ratio_val > threshold
    return {
        "ok": not leak,
        "correct_score": round(correct_score, 3),
        "median_distractor": round(mid, 3),
        "ratio": round(ratio_val, 3),
        "threshold": threshold,
    }


# Bank-expansion plan Wave 2.3 — RC authenticity bounds. Real LSAT RC passages
# (post-2007) sit in a narrow band by Flesch-Kincaid Grade Level — academic but
# not impenetrable. Sentence-length stdev is the cheapest "lively prose" signal
# we get without a model call: real passages mix short and long sentences;
# degenerate AI output is conspicuously uniform.
_RC_MIN_WORDS = 250
_RC_MIN_SENTENCES = 5
_RC_FKGL_MIN = 9.0
_RC_FKGL_MAX = 18.0
_RC_MIN_SENT_LEN_STDEV = 4.0  # words; real LSAT passages comfortably exceed this


def _sentence_length_stdev(text: str) -> float:
    import statistics

    sents = [s.strip() for s in re.split(r"[.!?]+", text) if s.strip()]
    if len(sents) < 2:
        return 0.0
    lens = [len(re.findall(r"\b\w+\b", s)) for s in sents]
    return statistics.pstdev(lens) if len(lens) > 1 else 0.0


def rc_authenticity(passage: str) -> dict:
    """Bank-expansion plan Wave 2.3 — readability gate for RC passages.

    Combines four cheap (no-model) signals to decide if a generated RC passage
    looks like LSAT-grade prose:

      * length (>= ``_RC_MIN_WORDS``) and sentence count
      * Flesch-Kincaid Grade Level within ``[_RC_FKGL_MIN, _RC_FKGL_MAX]``
      * sentence-length stdev >= ``_RC_MIN_SENT_LEN_STDEV`` (varied phrasing)
      * unique-word ratio not pathologically low

    ``ok`` is False when ANY flag fires; the gate consumes ``ok`` as a hard
    reject. The Q4-era ``score`` is preserved for the audit panel.
    """
    text = (passage or "").strip()
    words = re.findall(r"\b\w+\b", text)
    n_words = len(words)
    sentences = [s for s in re.split(r"[.!?]+", text) if s.strip()]
    n_sent = len(sentences)
    uniq_ratio = (len({w.lower() for w in words}) / n_words) if n_words else 0.0
    avg_sent_len = (n_words / n_sent) if n_sent else 0.0
    sent_stdev = _sentence_length_stdev(text)

    # FKGL — uses textstat when available (accurate syllable counting); falls
    # back to a simple approximation if textstat isn't installed.
    fkgl: float | None = None
    try:
        import textstat as _ts  # type: ignore

        if n_words >= 30:
            fkgl = float(_ts.flesch_kincaid_grade(text))
    except Exception:  # noqa: BLE001
        fkgl = None

    flags: list[str] = []
    if n_words < _RC_MIN_WORDS:
        flags.append("too_short")
    if n_sent < _RC_MIN_SENTENCES:
        flags.append("too_few_sentences")
    if n_words and uniq_ratio < 0.4:
        flags.append("repetitive")
    if avg_sent_len > 45:
        flags.append("run_on_sentences")
    if sent_stdev > 0 and sent_stdev < _RC_MIN_SENT_LEN_STDEV:
        flags.append("uniform_sentence_lengths")
    if fkgl is not None:
        if fkgl < _RC_FKGL_MIN:
            flags.append("readability_too_low")
        elif fkgl > _RC_FKGL_MAX:
            flags.append("readability_too_high")

    length_score = min(1.0, n_words / 450.0)
    sent_score = min(1.0, n_sent / 15.0)
    vocab_score = min(1.0, uniq_ratio / 0.55)
    score = round((length_score + sent_score + vocab_score) / 3.0, 3)
    return {
        "score": score,
        "n_words": n_words,
        "n_sentences": n_sent,
        "unique_ratio": round(uniq_ratio, 3),
        "avg_sentence_len": round(avg_sent_len, 1),
        "sentence_len_stdev": round(sent_stdev, 2),
        "fkgl": None if fkgl is None else round(fkgl, 2),
        "fkgl_band": [_RC_FKGL_MIN, _RC_FKGL_MAX],
        "flags": flags,
        "ok": not flags,
    }


def validate_candidate(cand: dict, runs: int, solver=_generate, critic=_generate,
                       *, q_type: str | None = None,
                       section_type: str | None = None,
                       permutation_invariant: Optional[bool] = None,
                       informativity: Optional[bool] = None,
                       distractor_quality_enabled: Optional[bool] = None,
                       multi_model_solver=None,
                       session: Session | None = None,
                       embedder=None) -> dict:
    """Run the decorrelated, adversarial generation gate (R7 Wave 3a).

    The gate measures ITEM SOUNDNESS, not sampling luck. Ordered checks (cheap
    first; the first failure sets ``reason`` and short-circuits the rest):

      1. structural          — 5 choices A-E, credited in A-E, min stimulus
                               length, non-empty prompt/choices.   -> "structural"
      2. trap_metadata       — correct choice is ``none`` and every distractor
                               carries a known non-``none`` trap label.
                                                                   -> "trap_metadata"
      3. no_length_tell      — credited choice not uniquely longest/shortest.
                                                                   -> "length_tell"
      4. deterministic_solve — the CRITIC (temp 0, distinct model when configured)
                               solves the item; its answer MUST equal the credited
                               answer.                             -> "solve_mismatch"
      5. self_consistency    — the SOLVER answers N times; sampling must be stable
                               (repurposed: stability, not the correctness signal).
                                                                   -> "self_consistency"
      6. single_defensible   — a critique pass finds exactly one defensible answer.
                                                                   -> "ambiguous_answer"
      7. distractor_quality  — each wrong answer is a plausible, explainable trap.
                                                                   -> "weak_distractors"
      8. cove_verify         — the SOLVER (decorrelated from the critic in step 3)
                               solves blind; must agree with the credited letter.
                                                                   -> "cove_disagreement"
      9. structural_type     — per-``q_type`` logical-structure check (negation
                               test, sufficiency, parallel form, paradox tension,
                               …). No-op pass for types without a validator.
                                                                   -> validator's reason

    ``solver``/``critic`` are injectable for tests (default to the live model
    call). The live caller (``run_job``) passes a critic routed to a DIFFERENT
    model than the generator and pinned to deterministic params, so a model that
    writes a flawed item can't rubber-stamp it (correlated errors). Each check's
    verdict is recorded under ``report["checks"]``.
    """
    report: dict = {"checks": {}}
    choices = cand.get("choices", [])
    correct = cand.get("correct_answer")
    stem = cand.get("stem", "")
    prompt = cand.get("prompt", "")
    passage = cand.get("passage", "")
    expected_section = str(section_type or "").upper()
    # The "stimulus" is what the question reasons over: an RC passage (+ any
    # stem) or an LR stem. Solve/critique run against this, not just the stem.
    stimulus = (f"{passage}\n\n{stem}".strip() if passage else stem).strip()

    # (1) structural sanity first (cheap, no model call). A real stimulus must
    # carry enough text to support the reasoning.
    labels = [c.get("label") for c in choices]
    structural_ok = (
        len(choices) == 5
        and labels == _LABELS
        and correct in _LABELS
        and len(stimulus) >= _MIN_STIMULUS_CHARS
        and bool(prompt.strip())
        and all(str(c.get("text", "")).strip() for c in choices)
    )
    report["checks"]["structural"] = structural_ok
    if not structural_ok:
        report["passed"] = False
        report["reason"] = "structural"
        return report
    if expected_section == "RC" and not str(passage or "").strip():
        report["checks"]["rc_requires_passage"] = False
        report["passed"] = False
        report["reason"] = "rc_missing_passage"
        return report

    trap_metadata = _trap_metadata_integrity(choices, str(correct))
    report["checks"]["trap_metadata"] = trap_metadata
    if not trap_metadata["ok"]:
        report["passed"] = False
        report["reason"] = "trap_metadata"
        return report

    # (2) no answer-length tell: correct choice not the longest or shortest.
    lengths = {c["label"]: len(str(c.get("text", ""))) for c in choices}
    longest = max(lengths, key=lengths.get)
    shortest = min(lengths, key=lengths.get)
    # tell only if correct is uniquely longest or uniquely shortest
    longest_unique = list(lengths.values()).count(lengths[longest]) == 1
    shortest_unique = list(lengths.values()).count(lengths[shortest]) == 1
    length_tell = (correct == longest and longest_unique) or (
        correct == shortest and shortest_unique
    )
    report["checks"]["no_length_tell"] = not length_tell

    # (2b) lexical-leak check: the credited choice must not share distinctively
    # more vocabulary with the stimulus than the typical distractor (Wave 1.4).
    # q_type is forwarded so paraphrase-typed items (Inference/MainPoint/…)
    # skip the check — their correct answer is supposed to restate the stem.
    leak_verdict = lexical_leak_ok(cand, q_type=q_type)
    report["checks"]["lexical_leak_ok"] = leak_verdict
    leak_ok = leak_verdict.get("ok", True)

    # (3) deterministic solve — the AUTHORITATIVE correctness signal. The critic
    # (temp 0, decorrelated model) solves the item once; the solved letter must
    # equal the claimed credited answer or the item is unsound.
    sp = _solve_prompt(stimulus, prompt, choices)
    try:
        solved_letter = _extract_letter(critic(sp))
    except Exception:
        log.warning("B26: deterministic solve failed", exc_info=True)
        solved_letter = None
    deterministic_solve_ok = solved_letter == correct
    report["checks"]["deterministic_solve"] = {
        "solved": solved_letter, "credited": correct, "ok": deterministic_solve_ok,
    }

    # (4) self-consistency — repurposed as sampling STABILITY of the (separate)
    # solver model. Deterministic solve above is the correctness gate; this still
    # catches items the solver answers erratically across samples.
    answers = []
    for _ in range(runs):
        try:
            answers.append(_extract_letter(solver(sp)))
        except Exception:
            log.warning("B26: self-consistency solver call failed", exc_info=True)
            answers.append(None)
    agree = answers.count(correct)
    self_consistent = agree == runs and runs > 0
    report["checks"]["self_consistency"] = f"{agree}/{runs}"
    report["self_consistency_pass"] = self_consistent

    # (4b) permutation-invariant self-consistency (Wave 2.1). Probes positional
    # bias: rotate the choice letters and re-solve; the solver's answer, mapped
    # back to the ORIGINAL labels, must equal the credited letter every time.
    perm_consistent = True
    perm_results: list[dict] = []
    perm_enabled = (
        config.GEN_PERMUTATION_SC if permutation_invariant is None
        else bool(permutation_invariant)
    )
    if perm_enabled and structural_ok:
        for order in _PERM_SHUFFLES:
            permuted, new_for_old = _permute_choices(choices, order)
            expected_new_label = new_for_old.get(correct)
            try:
                new_letter = _extract_letter(
                    solver(_solve_prompt(stimulus, prompt, permuted))
                )
            except Exception:
                log.warning("B26: permutation solver call failed", exc_info=True)
                new_letter = None
            agree_perm = new_letter == expected_new_label
            perm_results.append({
                "order": "".join(_LABELS[i] for i in order),
                "expected_new_label": expected_new_label,
                "solved_new_label": new_letter,
                "ok": agree_perm,
            })
            if not agree_perm:
                perm_consistent = False
        report["checks"]["permutation_invariant"] = {
            "ok": perm_consistent,
            "samples": perm_results,
        }
    else:
        report["checks"]["permutation_invariant"] = {"ok": True, "skipped": True}

    # (4c) Säuberli text-informativity (Wave 2.2). Solve the item WITHOUT the
    # stimulus. If the solver still picks the credited letter, the item is
    # uninformative — the answer is detectable from choices+prompt alone.
    informative = True
    info_enabled = (
        config.GEN_INFORMATIVITY_CHECK if informativity is None
        else bool(informativity)
    )
    if info_enabled and structural_ok:
        try:
            uninformed_letter = _extract_letter(
                solver(_informativity_prompt("[removed]", prompt, choices))
            )
        except Exception:
            log.warning("B26: informativity solver call failed", exc_info=True)
            uninformed_letter = None
        # "Informative" iff the solver does NOT recover the credited letter
        # from choices alone. A None answer (model refused / blank) is also
        # treated as informative.
        if uninformed_letter == correct:
            informative = False
        report["checks"]["informativity"] = {
            "ok": informative,
            "uninformed_letter": uninformed_letter,
            "credited": correct,
        }
    else:
        report["checks"]["informativity"] = {"ok": True, "skipped": True}

    # (5) single defensible answer.
    try:
        crit_raw = critic(_critique_prompt(stimulus, prompt, choices))
        crit = _extract_json(crit_raw) or {}
    except Exception:
        log.warning("B26: single-defensible critic call failed", exc_info=True)
        crit = {}
    defensible_letters = crit.get("defensible_letters")
    # A critic reporting exactly one defensible answer is not enough; the sole
    # defensible answer must be the credited answer. Otherwise a generated item
    # can pass while pointing to the wrong key.
    if defensible_letters is None:
        defensible_match = True
    else:
        defensible_match = defensible_letters == [correct]
    single_defensible = bool(crit.get("single_defensible", False)) and defensible_match
    report["checks"]["single_defensible"] = single_defensible
    report["checks"]["single_defensible_detail"] = {
        "defensible_letters": defensible_letters,
        "credited": correct,
    }

    # (5b) distractor quality — a single-best answer is necessary but not
    # sufficient. The wrong answers must be defensible LSAT traps instead of
    # throwaways that make the item easier than its claimed type/difficulty.
    distractor_quality = _distractor_quality(
        stimulus, prompt, choices, correct, critic,
        enabled=distractor_quality_enabled,
    )
    report["checks"]["distractor_quality"] = distractor_quality
    distractor_quality_ok = bool(distractor_quality.get("ok", False))

    # (6) CoVe isolated verification (Wave 3.1) — the SOLVER (not the critic
    # from step 3) performs a blind solve. Two decorrelated model reads must
    # converge on the credited letter or the item is rejected.
    cove_ok = True
    cove_letter: str | None = None
    try:
        cove_letter = _extract_letter(
            solver(_cove_verify_prompt(stimulus, prompt, choices))
        )
    except Exception:
        log.warning("B26: cove_verify solver call failed", exc_info=True)
        cove_letter = None
    cove_ok = cove_letter == correct
    report["checks"]["cove_verify"] = {
        "ok": cove_ok,
        "solver_pick": cove_letter,
        "credited": correct,
    }

    # (6b) multi-model solver agreement (Wave 3.2).
    multi = _multi_model_agreement(
        stimulus, prompt, choices, correct or "",
        model_solver=multi_model_solver,
    )
    report["checks"]["multi_model_agreement"] = multi
    multi_ok = bool(multi.get("ok", True))

    # (7) type-aware structural validator (the "required logical structure"
    # check). Explicit unknown q_types fail closed in gen_validators.
    type_verdict = {"ok": True, "reason": None, "check": "none"}
    if q_type:
        type_verdict = gen_validators.validate_structure(
            q_type, cand, critic, section_type=section_type
        )
    report["checks"]["structural_type"] = type_verdict

    # (e) RC authenticity — promoted to a HARD gate in Wave 2.3. The
    # readability/structure heuristics (FKGL, sentence-stdev, length, vocab)
    # are cheap and unambiguous on degenerate model output; failing any one
    # flag means the passage doesn't read like LSAT-grade prose.
    rc_ok = True
    rc_first_flag: str | None = None
    if passage.strip():
        rc_verdict = rc_authenticity(passage)
        report["checks"]["rc_authenticity"] = rc_verdict
        rc_ok = bool(rc_verdict.get("ok", True))
        if not rc_ok and rc_verdict.get("flags"):
            rc_first_flag = rc_verdict["flags"][0]

    base_passed = (
        structural_ok
        and not length_tell
        and leak_ok
        and deterministic_solve_ok
        and self_consistent
        and perm_consistent
        and informative
        and single_defensible
        and distractor_quality_ok
        and cove_ok
        and multi_ok
        and type_verdict.get("ok", True)
        and rc_ok
    )
    # (8) novelty / embedding dedup (Wave 3.4) — inside the gate so the verdict
    # records neighbor id + cosine. Only runs when session is provided (live
    # run_job path); unit tests omit session and skip.
    novelty_ok = True
    if session is not None and base_passed:
        sec = "RC" if (expected_section == "RC" or passage.strip()) else "LR"
        thresh = config.gen_dedup_threshold_for(q_type, section_type=sec)
        dup = _dedup_verdict(
            session, cand, embedder or embeddings._default_embedder,
            threshold=thresh,
        )
        report["checks"]["novelty"] = dup
        novelty_ok = bool(dup.get("ok", True))
    else:
        report["checks"]["novelty"] = {"ok": True, "skipped": session is None}

    passed = base_passed and novelty_ok
    report["passed"] = passed
    if not passed:
        novelty_check = report["checks"].get("novelty") or {}
        report["reason"] = (
            "near_duplicate" if (
                novelty_check.get("checked") and not novelty_check.get("ok", True)
            ) else
            "length_tell" if length_tell else
            "lexical_leak" if not leak_ok else
            "solve_mismatch" if not deterministic_solve_ok else
            "self_consistency" if not self_consistent else
            "permutation_inconsistent" if not perm_consistent else
            "uninformative_stimulus" if not informative else
            "ambiguous_answer" if not single_defensible else
            (distractor_quality.get("reason") or "weak_distractors")
            if not distractor_quality_ok else
            "cove_disagreement" if not cove_ok else
            "multi_model_disagreement" if not multi_ok else
            "rc_authenticity:" + (rc_first_flag or "unknown") if not rc_ok else
            (type_verdict.get("reason") or "structural_type")
        )
    return report


_VALIDATOR_REASON_BY_CHECK = {
    "structural": "structural",
    "rc_requires_passage": "rc_missing_passage",
    "trap_metadata": "trap_metadata",
    "no_length_tell": "length_tell",
    "lexical_leak_ok": "lexical_leak",
    "deterministic_solve": "solve_mismatch",
    "permutation_invariant": "permutation_inconsistent",
    "informativity": "uninformative_stimulus",
    "single_defensible": "ambiguous_answer",
    "distractor_quality": "weak_distractors",
    "cove_verify": "cove_disagreement",
    "multi_model_agreement": "multi_model_disagreement",
    "structural_type": "structural_type",
    "rc_authenticity": "rc_authenticity",
    "novelty": "near_duplicate",
}


def _check_passed(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, dict) and "ok" in value:
        return bool(value.get("ok"))
    return None


def _validator_failure_reasons(verdict: dict[str, Any]) -> list[str]:
    reasons: list[str] = []
    if verdict.get("cancelled"):
        reasons.append("cancelled")
    if verdict.get("error"):
        reasons.append("generation_error")
    primary = verdict.get("reason")
    if primary:
        reasons.append(str(primary))
    if verdict.get("self_consistency_pass") is False:
        reasons.append("self_consistency")
    checks = verdict.get("checks") or {}
    for check, fallback in _VALIDATOR_REASON_BY_CHECK.items():
        ok = _check_passed(checks.get(check))
        if ok is not False:
            continue
        detail = checks.get(check)
        reason = fallback
        if check == "structural_type" and isinstance(detail, dict):
            reason = str(detail.get("reason") or fallback)
        elif check == "distractor_quality" and isinstance(detail, dict):
            reason = str(detail.get("reason") or fallback)
        elif check == "rc_authenticity" and isinstance(detail, dict):
            flags = detail.get("flags") or []
            reason = f"rc_authenticity:{flags[0]}" if flags else fallback
        reasons.append(reason)
    return list(dict.fromkeys(reasons))


def _validator_score(verdict: dict[str, Any]) -> float:
    checks = verdict.get("checks") or {}
    judged = [
        ok for key in _VALIDATOR_REASON_BY_CHECK
        if (ok := _check_passed(checks.get(key))) is not None
    ]
    if verdict.get("self_consistency_pass") is not None:
        judged.append(bool(verdict.get("self_consistency_pass")))
    if not judged:
        return 1.0 if verdict.get("passed") else 0.0
    return round(sum(1 for ok in judged if ok) / len(judged), 4)


def _section_enum(value: Any) -> SectionType | None:
    raw = value.value if hasattr(value, "value") else value
    if raw in ("LR", "RC"):
        return SectionType(raw)
    return None


def _validator_run_from_verdict(
    *,
    job: GenJob,
    verdict: dict[str, Any],
    candidate_index: int,
) -> ValidatorRun:
    status = (
        "cancelled" if verdict.get("cancelled")
        else "passed" if verdict.get("passed")
        else "failed"
    )
    meta = {
        "source": "generation.run_job",
        "gen_job_id": job.id,
        "candidate_index": candidate_index,
        "question_id": verdict.get("question_id"),
        "parent_question_id": verdict.get("parent_question_id"),
        "training_anchor_id": verdict.get("training_anchor_id"),
        "verdict_reason": verdict.get("reason"),
        "solver_model": verdict.get("solver_model"),
        "critic_model": verdict.get("critic_model"),
    }
    if verdict.get("rc_generation_context"):
        meta["rc_generation_context"] = verdict.get("rc_generation_context")
    return ValidatorRun(
        q_type=job.q_type,
        section_type=_section_enum(verdict.get("section_type")),
        status=status,
        score=_validator_score(verdict),
        failure_reasons_json=_validator_failure_reasons(verdict),
        meta_json=meta,
    )


# --- job runner -------------------------------------------------------------
def _eligible_parents(session: Session, q_type: str) -> list[Question]:
    """Real (non-AI) candidates of `q_type` that can anchor new generation.

    Includes ``official``, ``sample``, and ``research`` sources. AI-generated
    items are excluded so the bank doesn't degrade by modeling AI on AI.

    Wave 2.6 weighting: items the user has flagged as training-corpus
    (``training_eligible=True``) are returned ``GEN_TRAINING_ANCHOR_WEIGHT``
    times so the round-robin parent rotation inside ``run_job`` samples them
    proportionally more often. Their stylistic fingerprint is what we want the
    Tier-B model to mimic.
    """
    base = session.exec(
        select(Question)
        .where(Question.q_type == q_type)
        .where(Question.source != QuestionSource.ai_generated)
        .order_by(Question.id)
    ).all()
    weight = max(1, int(config.GEN_TRAINING_ANCHOR_WEIGHT or 1))
    if weight == 1:
        return base
    weighted: list[Question] = []
    # Round-robin friendly interleave: walk the list in order, repeating
    # flagged parents inline. This keeps the iteration deterministic and
    # avoids long runs of the same parent in the count=N loop.
    for q in base:
        weighted.append(q)
        if bool(q.training_eligible):
            for _ in range(weight - 1):
                weighted.append(q)
    return weighted


def servable_count(session: Session, q_type: str) -> int:
    """How many questions of ``q_type`` can be drilled right now (approved,
    non-quarantined)."""
    qs = session.exec(select(Question).where(Question.q_type == q_type)).all()
    n = 0
    for q in qs:
        if q.deleted_at is not None:  # D5: soft-deleted not servable
            continue
        if q.source == QuestionSource.ai_generated and (q.quarantined or not q.approved):
            continue
        n += 1
    return n


def coverage(session: Session) -> list[dict]:
    """Per q_type bank coverage: servable, real anchors, quarantined.

    The coach uses this to decide when a weak type is too thin to drill from the
    real bank and should be backfilled with Tier-B generation.
    """
    servable: dict[str, int] = defaultdict(int)
    anchors: dict[str, int] = defaultdict(int)
    training_anchors: dict[str, int] = defaultdict(int)
    quarantined: dict[str, int] = defaultdict(int)
    for q in session.exec(select(Question)).all():
        if q.deleted_at is not None:  # D5: soft-deleted excluded from coverage
            continue
        qt = q.q_type or "Unknown"
        is_ai = q.source == QuestionSource.ai_generated
        if is_ai and (q.quarantined or not q.approved):
            quarantined[qt] += 1
            continue
        servable[qt] += 1
        if not is_ai:
            anchors[qt] += 1
            if bool(q.training_eligible):
                training_anchors[qt] += 1
    types = sorted(
        set(servable) | set(anchors) | set(quarantined) | set(training_anchors)
    )
    return [
        {
            "q_type": t,
            "servable": servable[t],
            "anchors": anchors[t],
            "training_anchor_count": training_anchors[t],
            "quarantined": quarantined[t],
        }
        for t in types
    ]


def triage_for_question(session: Session, question_id: int) -> dict:
    """A11: surface the validation verdict for a generated question + a suggested
    verdict for the human reviewer (who still decides)."""
    for job in session.exec(select(GenJob)).all():
        report = job.validation_report or {}
        for cand in report.get("candidates", []):
            if cand.get("question_id") == question_id:
                passed = bool(cand.get("passed"))
                return {
                    "found": True,
                    "suggested_verdict": "approve" if passed else "reject",
                    "reason": cand.get("reason"),
                    "checks": cand.get("checks", {}),
                    "self_consistency_pass": cand.get("self_consistency_pass"),
                    "parent_question_id": cand.get("parent_question_id"),
                    "job_id": job.id,
                }
    return {"found": False, "suggested_verdict": None, "reason": None, "checks": {}}


def generation_quality(session: Session) -> dict:
    """Q2 — aggregate why generated candidates pass/fail across every job, so
    generation quality is measurable and the worst failure modes are visible.
    The gate keeps bad items out; this surfaces *how often* and *why* it fires."""
    all_jobs = session.exec(select(GenJob)).all()
    total = passed = failed = 0
    reasons: dict[str, int] = defaultdict(int)
    by_type: dict[str, dict] = defaultdict(lambda: {"passed": 0, "failed": 0})
    for j in all_jobs:
        report = j.validation_report or {}
        for cand in report.get("candidates", []):
            if "error" in cand:
                continue
            total += 1
            if cand.get("passed"):
                passed += 1
                by_type[j.q_type]["passed"] += 1
            else:
                failed += 1
                reasons[cand.get("reason") or "unknown"] += 1
                by_type[j.q_type]["failed"] += 1
    # Q6 — the hardest-to-generate types (low local pass rate over enough
    # candidates) are where the optional cloud Tier-B provider helps most. The
    # actual routing uses the existing GEN_PROVIDER=cloud seam (offline only).
    cloud_recommended = sorted(
        t for t, v in by_type.items()
        if (v["passed"] + v["failed"]) >= 3
        and v["failed"] / (v["passed"] + v["failed"]) > 0.5
    )
    return {
        "jobs": len(all_jobs),
        "total_candidates": total,
        "passed": passed,
        "quarantined": failed,
        "pass_rate": round(passed / total, 4) if total else None,
        "fail_reasons": dict(reasons),
        "by_type": {k: v for k, v in by_type.items()},
        "cloud_recommended_types": cloud_recommended,
    }


def ai_drift_report(session: Session, *, min_attempts: int = 4,
                    floor: float = 0.4) -> dict:
    """Q5 — watch approved AI items for quality drift. Returns approved,
    non-quarantined ai_generated questions whose live accuracy has fallen below
    ``floor`` over at least ``min_attempts`` practice attempts — candidates to
    send back to quarantine. (AI items never feed score prediction, but a
    degrader pollutes the drill experience.)"""
    ai_qs = session.exec(
        select(Question)
        .where(Question.source == QuestionSource.ai_generated)
        .where(Question.approved == True)        # noqa: E712
        .where(Question.quarantined == False)    # noqa: E712
    ).all()
    ai_ids = {q.id for q in ai_qs}
    if not ai_ids:
        return {"checked": 0, "flagged": [], "min_attempts": min_attempts, "floor": floor}

    attempts = session.exec(
        select(Attempt).where(Attempt.question_id.in_(ai_ids))
    ).all()
    agg: dict[int, list[int]] = defaultdict(lambda: [0, 0])  # [correct, total]
    for a in attempts:
        if a.mode == AttemptMode.blind_review:
            continue
        agg[a.question_id][1] += 1
        if a.is_correct:
            agg[a.question_id][0] += 1

    flagged = []
    for qid, (correct, total) in agg.items():
        if total >= min_attempts and (correct / total) < floor:
            flagged.append({"question_id": qid, "attempts": total,
                            "accuracy": round(correct / total, 3)})
    flagged.sort(key=lambda r: r["accuracy"])
    return {"checked": len(ai_ids), "flagged": flagged,
            "min_attempts": min_attempts, "floor": floor}


def _candidate_dedup_text(cand: dict) -> str:
    """Text we embed for a candidate's dedup check — same shape as
    ``embeddings.question_text`` (passage + stem + prompt + choices) so the
    gate's dedup decision lines up with the post-hoc duplicate audit."""
    choices = sorted(cand.get("choices", []), key=lambda c: c.get("label", ""))
    ch = " ".join(str(c.get("text", "")) for c in choices)
    return (
        f"{cand.get('passage', '')}\n"
        f"{cand.get('stem', '')}\n"
        f"{cand.get('prompt', '')}\n"
        f"{ch}"
    ).strip()


def _dedup_verdict(session: Session, cand: dict, embedder, *,
                   threshold: float | None = None) -> dict:
    """R7 2.9 — embedding dedup gate verdict for one candidate.

    Embeds the candidate (via the injectable ``embedder``) and compares it to the
    existing bank. ``ok`` is False (reject as ``near_duplicate``) when the cosine
    similarity to the nearest stored question is >= ``threshold``. No-ops
    gracefully (``ok=True, checked=False``) when embeddings are unavailable or the
    bank has nothing to compare against.
    """
    threshold = config.GEN_DEDUP_THRESHOLD if threshold is None else threshold
    near = embeddings.nearest_existing(
        session, _candidate_dedup_text(cand), embedder=embedder)
    if not near:
        return {"ok": True, "checked": False, "threshold": threshold}
    is_dup = near["score"] >= threshold
    return {
        "ok": not is_dup,
        "checked": True,
        "score": near["score"],
        "threshold": threshold,
        "near_question_id": near["question_id"],
    }


def run_job(job_id: int, generate=None, *, critic=None, embedder=None) -> None:
    """Execute a generation job to completion. Designed to run in a thread.

    When ``job.parent_question_id`` is set we pin every variation to that
    parent. Otherwise we rotate round-robin through every eligible parent so
    a single job of count=N draws from up to N distinct parents — required for
    the bootstrap orchestrator to reach 5k+ without repetitive output.

    Injection seams (R7 Wave 3a):
      - ``generate``: the CANDIDATE generator. Defaults to the live structured
        (``format:"json"``) generator. Tests inject a single fake.
      - ``critic``: the gate's SOLVE/CRITIQUE/adversarial/type-validator model,
        DECORRELATED from the generator. Defaults to a distinct, deterministic
        critic model in the live path; falls back to ``generate`` when only a
        generator fake is injected (so existing single-fake tests keep working).
      - ``embedder``: the dedup-gate embedder. Defaults to the local embed model;
        the dedup gate no-ops gracefully when embeddings are unavailable.
    """
    # Resolve the decorrelated seams. A single injected ``generate`` fake (the
    # legacy test shape) drives solve/critique too; the live path uses a distinct
    # critic model so a flawed generator can't approve its own output.
    gen_fn = generate if generate is not None else _candidate_generator
    if critic is not None:
        critic_fn = critic
    elif generate is not None:
        critic_fn = generate
    else:
        critic_fn = _gate_critic
    embed_fn = embedder if embedder is not None else _candidate_embedder
    with Session(engine) as session:
        job = session.get(GenJob, job_id)
        if not job:
            return
        if job.status == GenStatus.cancelled:
            return
        prior_report = dict(job.validation_report or {})
        retry_history = prior_report.get("retry_history")
        if not isinstance(retry_history, list):
            retry_history = []
        job.status = GenStatus.running
        job.model = config.CLOUD_GEN_MODEL if llm.cloud_enabled() else config.GEN_MODEL
        job.progress_pct = 0.0
        job.updated_at = datetime.now(timezone.utc)
        session.add(job)
        session.commit()

        parents: list[Question] = []
        if job.parent_question_id is not None:
            pinned = session.get(Question, job.parent_question_id)
            if pinned is not None:
                parents = [pinned]
        if not parents:
            parents = _eligible_parents(session, job.q_type)

        # Pre-cache the choices (and any RC passage) per parent so the inner
        # loop never re-queries.
        choices_by_parent: dict[int, list[AnswerChoice]] = {}
        passage_by_parent: dict[int, str] = {}
        rc_context_by_parent: dict[int, dict[str, Any]] = {}
        for p in parents:
            choices_by_parent[p.id] = session.exec(
                select(AnswerChoice).where(AnswerChoice.question_id == p.id)
            ).all()
            if p.passage_id is not None:
                pas = session.get(Passage, p.passage_id)
                passage_by_parent[p.id] = pas.text if pas else ""
                rc_context_by_parent[p.id] = _rc_generation_context(
                    session, p, job.q_type
                )

        candidates_report = []
        accepted = 0
        quarantined = 0
        produced = 0

        coaching = _coaching_note(session, job.q_type)
        try:
            for i in range(max(0, job.count)):
                session.refresh(job)
                if (job.validation_report or {}).get("cancel_requested"):
                    candidates_report.append({
                        "cancelled": True,
                        "passed": False,
                        "reason": "cancelled",
                        "section_type": None,
                    })
                    job.status = GenStatus.cancelled
                    job.cancelled_at = datetime.now(timezone.utc)
                    break
                parent = parents[i % len(parents)] if parents else None
                parent_choices = choices_by_parent.get(parent.id, []) if parent else []
                section_type = _section_type_for(job.q_type, parent)
                parent_passage = passage_by_parent.get(parent.id, "") if parent else ""
                rc_context = (
                    rc_context_by_parent.get(parent.id, {})
                    if parent and section_type == "RC"
                    else {}
                )
                gen_prompt = _gen_prompt(
                    job.q_type, parent, parent_choices,
                    section_type=section_type, parent_passage=parent_passage,
                    coaching_note=coaching, rc_context=rc_context,
                )
                if config.GEN_PLAN_THEN_WRITE:
                    plan_raw = gen_fn(
                        gen_prompt.replace(
                            "Respond with ONLY a JSON object",
                            "First respond with ONLY a JSON outline (no full choices yet): "
                            '{"plan": "...", "trap_strategy": "..."}. Then stop.',
                        )
                    )
                    gen_prompt = (
                        gen_prompt
                        + f"\nFollow this outline from the planner:\n{plan_raw[:2000]}\n"
                    )
                raw = gen_fn(gen_prompt)
                cand = _extract_json(raw)
                produced += 1
                if not cand:
                    candidates_report.append({
                        "passed": False,
                        "reason": "unparseable",
                        "section_type": section_type,
                    })
                    quarantined += 1
                    continue
                # BA5: validate + persist ONE candidate inside a SAVEPOINT so a
                # single bad candidate (a validator/persist exception, an
                # IntegrityError, etc.) rolls back just its own partial rows and
                # the job continues with the next candidate instead of aborting.
                # On a clean candidate the savepoint releases and the iteration's
                # trailing ``session.commit()`` makes it durable — identical to
                # the prior per-candidate commit behavior.
                try:
                    with session.begin_nested():
                        verdict = validate_candidate(
                            cand, config.GEN_SELF_CONSISTENCY_RUNS,
                            solver=gen_fn, critic=critic_fn, q_type=job.q_type,
                            section_type=section_type,
                            session=session, embedder=embed_fn,
                        )
                        verdict["section_type"] = section_type
                        if rc_context:
                            verdict["rc_generation_context"] = rc_context
                        accepted_flag = verdict.get("passed", False)
                        q = _persist_candidate(
                            session, cand, job.q_type, parent, accepted_flag,
                            section_type=section_type,
                        )
                        verdict["question_id"] = q.id
                except Exception:  # noqa: BLE001 — one candidate must not kill the job
                    log.warning(
                        "BA5: candidate validate/persist rolled back job_id=%s",
                        job.id, exc_info=True,
                    )
                    candidates_report.append({
                        "passed": False,
                        "reason": "persist_error",
                        "section_type": section_type,
                    })
                    quarantined += 1
                    job.produced = produced
                    job.quarantined = quarantined
                    job.progress_pct = round(100 * produced / max(1, job.count), 1)
                    job.updated_at = datetime.now(timezone.utc)
                    session.add(job)
                    session.commit()
                    continue
                if parent is not None:
                    verdict["parent_question_id"] = parent.id
                    if bool(parent.training_eligible):
                        verdict["training_anchor_id"] = parent.id
                # Wave 2.4 — per-candidate gate provenance (job-level summary
                # is written after the loop; each row needs its own copy for
                # when Wave 4.4 normalizes into GenCandidate).
                try:
                    pinfo = llm.provider_info()
                except Exception:  # noqa: BLE001
                    pinfo = {}
                verdict["solver_model"] = pinfo.get("gen_model") or config.GEN_MODEL
                verdict["critic_model"] = (
                    pinfo.get("critic_model") or llm.critic_model_name()
                )
                candidates_report.append(verdict)
                if accepted_flag:
                    accepted += 1
                else:
                    quarantined += 1
                job.produced = produced
                job.accepted = accepted
                job.quarantined = quarantined
                job.progress_pct = round(100 * produced / max(1, job.count), 1)
                job.updated_at = datetime.now(timezone.utc)
                session.add(job)
                session.commit()

            if job.status != GenStatus.cancelled:
                job.status = GenStatus.done
        except Exception as exc:  # model unreachable etc.
            log.warning("B26: run_generation_job failed job_id=%s", job.id, exc_info=True)
            job.status = GenStatus.failed
            candidates_report.append({"error": str(exc)})

        job.produced = produced
        job.accepted = accepted
        job.quarantined = quarantined
        if job.status == GenStatus.done:
            job.progress_pct = 100.0
        job.updated_at = datetime.now(timezone.utc)
        # Wave 2.4 — record WHICH models actually solved/critiqued, not just the
        # candidate generator. ``job.model`` already captures the candidate
        # generator. ``solver_model`` and ``critic_model`` here surface the gate
        # provenance so a future replay (or model-swap A/B) can attribute
        # pass-rate shifts to the right pair.
        provider_info: dict = {}
        try:
            provider_info = llm.provider_info()
        except Exception:  # noqa: BLE001
            provider_info = {}
        solver_model = (
            provider_info.get("gen_model")
            or config.GEN_MODEL
        )
        critic_model = (
            provider_info.get("critic_model")
            or llm.critic_model_name()
        )
        job.validation_report = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "candidate_generator_model": job.model,
            "solver_model": solver_model,
            "critic_model": critic_model,
            "explain_model": provider_info.get("explain_model"),
            "retry_count": job.retry_count,
            "max_retries": job.max_retries,
            "retry_history": retry_history,
            "candidates": candidates_report[:50],  # Wave 4.4 — cap JSON bloat
        }
        session.add(job)
        # Wave 4.4 — normalize per-candidate verdicts into GenCandidate rows.
        for idx, verdict in enumerate(candidates_report):
            session.add(GenCandidate(
                gen_job_id=job.id,
                question_id=verdict.get("question_id"),
                candidate_index=idx,
                verdict="accepted" if verdict.get("passed") else "quarantined",
                verdict_reason=verdict.get("reason"),
                gate_scores=verdict.get("checks") or {},
                solver_model=verdict.get("solver_model"),
                critic_model=verdict.get("critic_model"),
                training_anchor_id=verdict.get("training_anchor_id"),
            ))
            session.add(_validator_run_from_verdict(
                job=job,
                verdict=verdict,
                candidate_index=idx,
            ))
        session.commit()


def _section_type_for(q_type: str, parent: Question | None) -> str:
    """RC vs LR for a job. The parent is authoritative (RC items have a passage);
    with no parent, only unambiguously-RC types route to RC."""
    if parent is not None:
        return "RC" if parent.passage_id is not None else "LR"
    if q_type in RC_TYPES and q_type not in LR_TYPES:
        return "RC"
    return "LR"


def _ensure_ai_section(session: Session, section_type: str) -> Section:
    """Synthetic PrepTest/Section that holds generated content so RC items can
    carry a real passage_id (and thus be drillable)."""
    pt = session.exec(
        select(PrepTest).where(PrepTest.name == _AI_PREPTEST_NAME)
    ).first()
    if pt is None:
        pt = PrepTest(name=_AI_PREPTEST_NAME, source="ai_generated", is_official=False)
        session.add(pt)
        # BA5: flush (not commit) so this stays inside the per-candidate
        # SAVEPOINT opened by run_job; the synthetic PrepTest/Section is created
        # idempotently and made durable by the iteration's trailing commit.
        session.flush()
        session.refresh(pt)
    sec = session.exec(
        select(Section)
        .where(Section.preptest_id == pt.id)
        .where(Section.type == SectionType(section_type))
    ).first()
    if sec is None:
        sec = Section(preptest_id=pt.id, type=SectionType(section_type), order=0)
        session.add(sec)
        session.flush()
        session.refresh(sec)
    return sec


def _persist_candidate(session: Session, cand: dict, q_type: str,
                       parent: Question | None, accepted: bool,
                       section_type: str = "LR") -> Question:
    section_id = None
    passage_id = None
    # BA5: flush (not commit) so this persist stays inside the caller's
    # per-candidate SAVEPOINT (``run_job`` wraps each iteration in
    # ``session.begin_nested()``). flush still populates autoincrement ids for
    # the refresh below; ``run_job`` commits once at the end of the iteration so
    # a clean candidate lands identically to before, while a candidate that
    # raises mid-persist rolls its own partial rows back without aborting the job.
    # RC items with a real passage get attached to the synthetic AI section so
    # they have a passage_id and behave like any other RC question in drills.
    if section_type == "RC" and str(cand.get("passage", "")).strip():
        sec = _ensure_ai_section(session, "RC")
        passage = Passage(section_id=sec.id, text=cand["passage"], type="single")
        session.add(passage)
        session.flush()
        session.refresh(passage)
        section_id = sec.id
        passage_id = passage.id

    q = Question(
        section_id=section_id,
        passage_id=passage_id,
        stem=cand.get("stem", ""),
        prompt=cand.get("prompt", ""),
        correct_answer=cand.get("correct_answer", "A"),
        difficulty=int(cand.get("difficulty", 3) or 3),
        q_type=q_type,
        source=QuestionSource.ai_generated,
        parent_question_id=parent.id if parent else None,
        quarantined=not accepted,
        approved=accepted,
    )
    session.add(q)
    session.flush()
    session.refresh(q)
    for c in cand.get("choices", []):
        session.add(AnswerChoice(
            question_id=q.id,
            label=c.get("label", "?"),
            text=c.get("text", ""),
            is_correct=(c.get("label") == cand.get("correct_answer")),
            trap_type=c.get("trap_type"),
        ))
    session.flush()
    session.refresh(q)
    return q
