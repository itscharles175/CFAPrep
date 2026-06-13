"""Tier-A auto-tagging: assign q_type, difficulty, and per-choice trap_type.

Why this exists
---------------
Research-dataset imports come in without LSAT-Lab's structured ``q_type`` or
``trap_type`` labels. Without those, drills can't filter ("Weaken only") and
trap analytics aren't meaningful. This module runs the explain model
(``qwen3:8b``) over each untagged question and asks for structured JSON.

Design notes
------------
- One question per call. Batching inside Ollama is awkward and a single
  question keeps the prompt short enough that the small model stays accurate.
- Heuristic prompt-keyword classification runs first; the model is only invoked
  when the heuristic is unsure. Cheap heuristics catch ~60-70% of LR prompts.
- The model returns JSON. Anything that doesn't parse cleanly falls back to the
  heuristic (or "Inference"/"Detail") so the loop never blocks.
- The ``tag`` function is injectable so tests can monkeypatch the model call.
"""
from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Optional

from sqlmodel import Session, select

from . import config, llm
from .ai import strip_think
from .models import (
    LR_TYPES,
    RC_TYPES,
    TRAP_TYPES,
    AnswerChoice,
    Question,
    QuestionSource,
    SectionType,
)

# --- canonical taxonomies --------------------------------------------------
# Lowercased canonical names for fast lookup.
_LR_LOOKUP = {t.lower(): t for t in LR_TYPES}
_RC_LOOKUP = {t.lower(): t for t in RC_TYPES}
_TRAP_LOOKUP = {t.lower(): t for t in TRAP_TYPES}


# --- heuristic prompt-based classifier ------------------------------------
# Ordered: first match wins. Keys are regexes against the question prompt.
_LR_PROMPT_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"most\s+strengthens?", "Strengthen"),
    (r"most\s+weakens?", "Weaken"),
    (r"flaw\b|vulnerable\s+to\s+criticism|reasoning.*flaw", "Flaw"),
    (r"assumption.*sufficient|sufficient.*assumption", "SufficientAssumption"),
    (r"assumption\b|depends\s+on|argument\s+presupposes", "NecessaryAssumption"),
    (r"main\s+(point|conclusion|idea)", "MainPoint"),
    (r"role|plays\s+which.*role|function", "Role"),
    (r"method\s+of\s+reasoning|argumentative\s+strategy", "Method"),
    (r"parallel\s+in\s+(its\s+)?(flawed\s+)?reasoning.*flaw", "ParallelFlaw"),
    (r"parallel\s+in\s+(its\s+)?reasoning|most\s+similar.*reasoning", "Parallel"),
    (r"principle.*illustrate|principle.*conform|conform.*principle", "PrincipleApply"),
    (r"principle.*support|principle.*underlies", "PrincipleIdentify"),
    (r"point\s+at\s+issue|disagree|conflict", "PointAtIssue"),
    (r"paradox|discrepanc|resolves?|explains?", "Paradox"),
    (r"most\s+useful\s+to\s+know|in\s+evaluating", "Evaluate"),
    (r"most\s+strongly\s+supported", "MostStronglySupported"),
    (r"must\s+(?:also\s+)?be\s+true|properly\s+inferred|properly\s+drawn", "Inference"),
)

_RC_PROMPT_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"main\s+(point|idea|purpose)", "MainPoint"),
    (r"author'?s?\s+attitude|tone|primarily\s+concerned", "Attitude"),
    (r"according\s+to\s+the\s+passage|passage\s+state[ds]|passage\s+explicitly", "Detail"),
    (r"function|in\s+order\s+to|primary\s+purpose\s+of", "Function"),
    (r"organi[sz]ed|structure|sequence", "Structure"),
    (r"analog|most\s+similar.*situation|application", "Application"),
    (r"strengthens?|weakens?", "StrengthenWeaken"),
    (r"comparative|both\s+passages|passage\s+a.*passage\s+b", "Comparative"),
    (r"infer|imply|suggest", "Inference"),
)


def _heuristic_q_type(section_type: str, prompt: str) -> Optional[str]:
    p = (prompt or "").lower()
    patterns = _LR_PROMPT_PATTERNS if section_type == "LR" else _RC_PROMPT_PATTERNS
    for pat, q_type in patterns:
        if re.search(pat, p):
            return q_type
    return None


# --- model-based tagger ----------------------------------------------------
@dataclass
class TagResult:
    q_type: str
    difficulty: int = 3
    trap_types: list[str] = field(default_factory=list)
    via: str = "heuristic"  # "heuristic" | "model" | "fallback"


def _canonical_q_type(value: str, section_type: str) -> Optional[str]:
    if not value:
        return None
    lookup = _LR_LOOKUP if section_type == "LR" else _RC_LOOKUP
    return lookup.get(value.strip().lower())


def _canonical_trap(value: str) -> Optional[str]:
    if not value:
        return None
    return _TRAP_LOOKUP.get(value.strip().lower())


def _tag_prompt(section_type: str, stem: str, prompt: str,
                choices: list[AnswerChoice], correct: str) -> str:
    choices_block = "\n".join(f"({c.label}) {c.text}" for c in sorted(choices, key=lambda c: c.label))
    taxonomy = LR_TYPES if section_type == "LR" else RC_TYPES
    return (
        "You are tagging an LSAT question for analytics. Return ONLY JSON, no prose. "
        f"Section: {section_type}. Pick q_type from this list: {taxonomy}. "
        f"Pick each wrong-choice trap_type from: {TRAP_TYPES}. "
        "difficulty is 1-5.\n\n"
        f"Stimulus:\n{stem}\n\nPrompt: {prompt}\n\nChoices:\n{choices_block}\n\n"
        f"Correct: ({correct}).\n\n"
        'Respond with: {"q_type":"...", "difficulty":3, "traps":'
        '{"A":"out_of_scope","B":"none","C":"too_strong","D":"reversal","E":"half_right"}}'
    )


def _extract_json(text: str) -> Optional[dict]:
    text = strip_think(text)
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


def _model_call(prompt: str, *, timeout: Optional[float] = None) -> str:
    """Tagging is Tier-A (local only), routed through the resilient provider (retry
    on connect, GPU concurrency cap). Uses ``TAG_MODEL`` when set — tagging only
    needs short structured JSON, so a smaller/faster model frees the explainer —
    else the explain model (no behaviour change by default)."""
    raw = llm.local_provider().generate(
        config.TAG_MODEL or config.EXPLAIN_MODEL, prompt,
        timeout=timeout or config.EXPLAIN_REQUEST_TIMEOUT_S,
    )
    return strip_think(raw)


def tag_question(section_type: str, stem: str, prompt: str,
                 choices: list[AnswerChoice], correct: str, *,
                 model_call: Callable[[str], str] = _model_call) -> TagResult:
    """Return a best-effort tag for one question.

    Strategy: heuristic first (free + good on prompts), model second, structural
    fallback last. The result is always usable.
    """
    heuristic = _heuristic_q_type(section_type, prompt)
    if heuristic is not None:
        # LSAT prompt phrasing is tightly conventional; when a heuristic matches
        # it is almost always right. Skipping the model here cuts the bulk-tag
        # runtime from hours to minutes on a 3k bank. Trap classification (which
        # the heuristic can't produce) is a separate, optional pass.
        return TagResult(q_type=heuristic, difficulty=3, trap_types=[], via="heuristic")

    try:
        raw = model_call(_tag_prompt(section_type, stem, prompt, choices, correct))
    except Exception:
        raw = ""
    obj = _extract_json(raw) if raw else None

    if obj:
        q_type = _canonical_q_type(str(obj.get("q_type", "")), section_type)
        difficulty = obj.get("difficulty", 3)
        try:
            difficulty_i = max(1, min(5, int(difficulty)))
        except (TypeError, ValueError):
            difficulty_i = 3
        traps_obj = obj.get("traps") or {}
        traps_by_label: dict[str, str] = {}
        if isinstance(traps_obj, dict):
            for label, val in traps_obj.items():
                canon = _canonical_trap(str(val))
                if canon and label in ("A", "B", "C", "D", "E"):
                    traps_by_label[label] = canon
        traps = [traps_by_label.get(c.label, "none") for c in
                 sorted(choices, key=lambda c: c.label)]
        if q_type:
            return TagResult(q_type=q_type, difficulty=difficulty_i,
                             trap_types=traps, via="model")

    if heuristic is not None:
        return TagResult(q_type=heuristic, difficulty=3, trap_types=[], via="heuristic")
    return TagResult(
        q_type="Inference" if section_type == "LR" else "Detail",
        difficulty=3, trap_types=[], via="fallback",
    )


# --- batch driver ----------------------------------------------------------
# How sure we are of an auto-tag, by which path produced it.
_VIA_CONFIDENCE = {"heuristic": "high", "model": "medium", "fallback": "low"}


def low_confidence_questions(session: Session, *, limit: int = 100) -> list[Question]:
    """Questions whose tags need a human look: low-confidence tags, or research
    items still on a generic placeholder type."""
    out: list[Question] = []
    for q in session.exec(select(Question)).all():
        is_generic = (
            q.q_type in {"Inference", "Detail"}
            and q.source == QuestionSource.research
        )
        if q.tag_confidence == "low" or is_generic:
            out.append(q)
        if len(out) >= limit:
            break
    return out


@dataclass
class BatchTagResult:
    scanned: int = 0
    updated: int = 0
    via_heuristic: int = 0
    via_model: int = 0
    via_fallback: int = 0


def _needs_tagging(q: Question) -> bool:
    """Generic placeholders the importer sets when no source label is known."""
    if not q.q_type:
        return True
    if q.q_type in {"Inference", "Detail"} and q.source == QuestionSource.research:
        return True
    return False


def batch_tag(session: Session, *, limit: int = 50,
              only_research: bool = True,
              model_call: Callable[[str], str] = _model_call) -> BatchTagResult:
    """Tag up to `limit` candidates. Safe to interrupt — each question commits."""
    stmt = select(Question)
    if only_research:
        stmt = stmt.where(Question.source == QuestionSource.research)
    questions = session.exec(stmt).all()

    result = BatchTagResult()
    processed = 0
    for q in questions:
        if processed >= limit:
            break
        if not _needs_tagging(q):
            continue

        # Determine the section type from the linked Section row. RC items have
        # a passage; LR items do not. This avoids loading the Section unless
        # we need to.
        section_type = "RC" if q.passage_id is not None else "LR"
        if q.section_id is not None:
            from .models import Section  # local import keeps module light
            sec = session.get(Section, q.section_id)
            if sec is not None:
                section_type = sec.type.value if isinstance(sec.type, SectionType) else str(sec.type)

        choices = session.exec(
            select(AnswerChoice).where(AnswerChoice.question_id == q.id)
        ).all()
        tag = tag_question(
            section_type, q.stem, q.prompt, choices, q.correct_answer,
            model_call=model_call,
        )
        q.q_type = tag.q_type
        q.difficulty = tag.difficulty
        q.tag_confidence = _VIA_CONFIDENCE.get(tag.via, "low")
        session.add(q)
        if tag.trap_types:
            sorted_choices = sorted(choices, key=lambda c: c.label)
            for c, trap in zip(sorted_choices, tag.trap_types):
                if c.is_correct:
                    c.trap_type = "none"
                else:
                    c.trap_type = trap
                session.add(c)
        session.commit()
        result.scanned += 1
        result.updated += 1
        if tag.via == "model":
            result.via_model += 1
        elif tag.via == "heuristic":
            result.via_heuristic += 1
        else:
            result.via_fallback += 1
        processed += 1
    return result


# --- CLI -------------------------------------------------------------------
def _main(argv: list[str] | None = None) -> int:
    import argparse
    import sys

    from .db import engine, init_db

    parser = argparse.ArgumentParser(prog="app.tagging")
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--include-non-research", action="store_true")
    args = parser.parse_args(argv or sys.argv[1:])
    init_db()
    with Session(engine) as session:
        res = batch_tag(
            session, limit=args.limit,
            only_research=not args.include_non_research,
        )
    print(
        f"scanned={res.scanned} updated={res.updated} "
        f"via_model={res.via_model} via_heuristic={res.via_heuristic} "
        f"via_fallback={res.via_fallback}"
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(_main())
