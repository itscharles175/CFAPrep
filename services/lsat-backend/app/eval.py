"""Offline LLM-as-judge eval harness for Tier-A explanation quality (R7 2.4).

Why this exists
---------------
The generation gate keeps bad *questions* out, and explanation feedback (Q1)
measures whether *users* found an explanation helpful. Neither measures whether
the explainer's output is actually CORRECT and complete on our REAL questions —
the quality anchor. This harness runs the explainer over a fixed set of seeded
official/sample questions and scores each output against a rubric, judged by a
(local, injectable) model. It's a measurement tool for Tier-A quality, run
offline / on demand — it is deliberately NOT wired into the realtime study loop.

Rubric (per explanation), each 0..1, judged on the stimulus + choices + the TRUE
answer the harness already knows:
- ``asserts_correct``: does the explanation assert the correct letter? (This one
  is checked DETERMINISTICALLY via :func:`ai.asserted_letter`, not by the model —
  it's ground truth, so we don't pay a judge call or risk a judge error for it.)
- ``addresses_each_choice``: does it say something about every choice A-E (per the
  rubric, the per-choice trap accuracy / coverage signal)?
- ``no_hallucination``: does it avoid asserting facts not supported by the
  stimulus?

The last two are scored by an injectable ``judge`` callable so tests never touch
Ollama. The default judge routes to the local explain model. Scores aggregate to
a 0..1 ``overall`` per item and a mean across the set.

Golden set
----------
:data:`GOLDEN_SET` is a small fixture of (q_type, expected-explanation-traits):
the letter that MUST be asserted and minimum coverage/quality bars. It anchors
the harness to known-good expectations; :func:`check_golden` verifies a produced
explanation meets its question's golden traits.

Run
---
``uv run python -m app.eval`` runs the harness over the seeded bank with the real
(local) explainer + judge and prints an aggregate report. In code / tests, call
:func:`run_eval` with injected ``explainer=`` and ``judge=`` fakes.
"""
from __future__ import annotations

import argparse
import inspect
import json
import re
from collections.abc import Callable
from typing import Optional

from sqlmodel import Session, select

from . import ai, config, llm
from .models import AnswerChoice, Passage, Question, QuestionSource

# An explainer takes (stem, prompt, choices, correct) and returns the body text.
Explainer = Callable[..., str]
# A judge takes a single rubric prompt and returns the model's raw text.
Judge = Callable[[str], str]

# Per-choice coverage: a choice is "addressed" if its label appears as an
# 'A: ...' style note OR is named like "(A)"/"choice A" in the prose.
_CHOICE_NOTE_RE = re.compile(r"^\s*\(?([A-E])\)?\s*[:.\)-]\s+", re.MULTILINE)


# --- golden set -------------------------------------------------------------
# Expected explanation traits keyed by q_type. ``min_choice_coverage`` is the
# fraction of choices an explanation must address; ``must_assert_correct`` means
# the explanation must name the true answer letter. These are deliberately modest
# bars: the point is to catch regressions (an explainer that stops naming the
# answer, or stops covering choices), not to grade prose.
GOLDEN_SET: list[dict] = [
    {"q_type": "Weaken", "must_assert_correct": True, "min_choice_coverage": 0.8},
    {"q_type": "NecessaryAssumption", "must_assert_correct": True, "min_choice_coverage": 0.8},
    {"q_type": "Flaw", "must_assert_correct": True, "min_choice_coverage": 0.8},
    {"q_type": "Strengthen", "must_assert_correct": True, "min_choice_coverage": 0.8},
    {"q_type": "Inference", "must_assert_correct": True, "min_choice_coverage": 0.8},
    {"q_type": "Paradox", "must_assert_correct": True, "min_choice_coverage": 0.8},
    {"q_type": "MainPoint", "must_assert_correct": True, "min_choice_coverage": 0.8},
]


def golden_traits_for(q_type: str) -> Optional[dict]:
    """The golden traits a ``q_type``'s explanation is expected to satisfy."""
    for g in GOLDEN_SET:
        if g["q_type"] == q_type:
            return g
    return None


# --- deterministic rubric pieces -------------------------------------------
def choice_coverage(body: str, labels: list[str]) -> float:
    """Fraction of ``labels`` the explanation addresses (0..1). Deterministic."""
    if not labels:
        return 0.0
    addressed = {m.group(1) for m in _CHOICE_NOTE_RE.finditer(body or "")}
    # Also count "(A)"/"choice A"/"answer A" mentions in prose.
    for lbl in labels:
        if re.search(rf"(?:\(|choice\s+|answer\s+|option\s+){lbl}\b", body or "",
                     re.IGNORECASE):
            addressed.add(lbl)
    hit = sum(1 for lbl in labels if lbl in addressed)
    return round(hit / len(labels), 4)


def check_golden(body: str, q_type: str, correct: str, labels: list[str]) -> dict:
    """Does ``body`` meet the golden traits for ``q_type``? Deterministic.

    Returns ``{"q_type", "passed", "asserts_correct", "choice_coverage",
    "reasons"}``. ``passed`` is False (with reasons) when a required trait is
    missing; if there is no golden entry for the type, ``passed`` is None.
    """
    g = golden_traits_for(q_type)
    asserts = ai.asserted_letter(body) == (correct or "").upper()
    cov = choice_coverage(body, labels)
    if g is None:
        return {"q_type": q_type, "passed": None, "asserts_correct": asserts,
                "choice_coverage": cov, "reasons": ["no_golden_entry"]}
    reasons: list[str] = []
    if g.get("must_assert_correct") and not asserts:
        reasons.append("does_not_assert_correct")
    if cov < g.get("min_choice_coverage", 0.0):
        reasons.append(f"choice_coverage {cov} < {g['min_choice_coverage']}")
    return {"q_type": q_type, "passed": not reasons, "asserts_correct": asserts,
            "choice_coverage": cov, "reasons": reasons}


# --- the judge --------------------------------------------------------------
_JUDGE_SYS = (
    "You are a strict grader of LSAT explanations. You are given a question (with "
    "its TRUE correct answer), and an explanation to grade. Score ONLY these two "
    "criteria, each 0.0-1.0, and reply with STRICT JSON and nothing else:\n"
    '{"addresses_each_choice": <0..1>, "no_hallucination": <0..1>, '
    '"notes": "<one short sentence>"}\n'
    "- addresses_each_choice: how completely the explanation addresses EVERY answer "
    "choice (A-E) and identifies the wrong ones' traps. 1.0 = all five handled.\n"
    "- no_hallucination: 1.0 if every factual claim is supported by the stimulus; "
    "lower it for invented facts, misquotes, or outside knowledge."
)


def _default_judge(prompt: str) -> str:
    """Route the rubric prompt to the local explain model (always local/offline)."""
    full = f"{_JUDGE_SYS}\n\n{prompt}"
    raw = llm.local_provider().generate(config.EXPLAIN_MODEL, full,
                                        timeout=config.EXPLAIN_REQUEST_TIMEOUT_S)
    return ai.strip_think(raw)


def _judge_prompt(stem: str, prompt: str, choices: list[dict], correct: str,
                  body: str, passage_text: Optional[str] = None) -> str:
    choice_lines = "\n".join(f"({c['label']}) {c['text']}" for c in choices)
    passage_block = ""
    if passage_text:
        passage_block = f"Passage:\n{ai._trim_passage_for_prompt(passage_text)}\n\n"
    return (
        f"{passage_block}Stimulus:\n{stem}\n\nPrompt: {prompt}\n\n"
        f"Answer choices:\n{choice_lines}\n\n"
        f"TRUE correct answer: ({correct}).\n\nExplanation to grade:\n{body}\n"
    )


def _parse_judge(raw: str) -> dict:
    """Pull the two rubric scores from the judge's reply. Robust to extra prose:
    finds the first JSON object, clamps to [0,1], and defaults missing keys to 0.5
    (a neutral score, so a malformed judge reply neither passes nor fails hard)."""
    obj: dict = {}
    m = re.search(r"\{.*\}", raw or "", re.DOTALL)
    if m:
        try:
            obj = json.loads(m.group(0))
        except (json.JSONDecodeError, ValueError):
            obj = {}

    def _score(key: str) -> float:
        v = obj.get(key, 0.5)
        try:
            return max(0.0, min(1.0, float(v)))
        except (TypeError, ValueError):
            return 0.5

    return {
        "addresses_each_choice": _score("addresses_each_choice"),
        "no_hallucination": _score("no_hallucination"),
        "notes": str(obj.get("notes", ""))[:200],
    }


# Weights for the aggregate item score. Asserting the correct answer is the
# heaviest (it's the whole point); coverage + hallucination split the rest.
_WEIGHTS = {"asserts_correct": 0.5, "addresses_each_choice": 0.3, "no_hallucination": 0.2}


def score_explanation(stem: str, prompt: str, choices: list[dict], correct: str,
                      body: str, *, judge: Optional[Judge] = None,
                      passage_text: Optional[str] = None) -> dict:
    """Score ONE explanation on the rubric. ``asserts_correct`` is deterministic;
    coverage + hallucination come from the (injectable) judge. Returns the rubric
    scores plus a weighted ``overall`` in 0..1."""
    judge = judge or _default_judge
    asserts = 1.0 if ai.asserted_letter(body) == (correct or "").upper() else 0.0
    try:
        graded = _parse_judge(
            judge(_judge_prompt(stem, prompt, choices, correct, body, passage_text))
        )
    except Exception:
        # A judge failure must not crash the harness: score neutral on its axes.
        graded = {"addresses_each_choice": 0.5, "no_hallucination": 0.5,
                  "notes": "judge_error"}
    scores = {
        "asserts_correct": asserts,
        "addresses_each_choice": graded["addresses_each_choice"],
        "no_hallucination": graded["no_hallucination"],
    }
    overall = round(sum(scores[k] * w for k, w in _WEIGHTS.items()), 4)
    return {**scores, "overall": overall, "judge_notes": graded.get("notes", "")}


# --- the harness ------------------------------------------------------------
def _accepts_kw(fn: Explainer, name: str) -> bool:
    params = inspect.signature(fn).parameters
    return name in params or any(
        p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()
    )


def _eval_questions(session: Session, *, q_types: Optional[list[str]] = None,
                    limit: int = 12) -> list[Question]:
    """The fixed set the harness runs over: REAL (official/sample) questions, one
    per golden q_type by default, so the run is stable and meaningful."""
    wanted = q_types or [g["q_type"] for g in GOLDEN_SET]
    rows = session.exec(
        select(Question).where(Question.source.in_(
            [QuestionSource.official, QuestionSource.sample]
        ))
    ).all()
    picked: list[Question] = []
    seen: set[str] = set()
    for q in rows:
        if q.q_type in wanted and q.q_type not in seen:
            picked.append(q)
            seen.add(q.q_type)
        if len(picked) >= limit:
            break
    # Top up with any remaining real questions if the golden types weren't all
    # present, so the harness still has something to measure.
    if not picked:
        picked = rows[:limit]
    return picked


def run_eval(session: Session, *, explainer: Optional[Explainer] = None,
             judge: Optional[Judge] = None, limit: int = 12,
             q_types: Optional[list[str]] = None) -> dict:
    """Run the explainer over the fixed real-question set and score each output.

    ``explainer(stem, prompt, choices, correct) -> body`` and ``judge(prompt) ->
    raw`` are both injectable so tests use fakes (NEVER real Ollama). Defaults are
    the local explain model + local judge.

    Returns an aggregate report:
    ``{"n", "mean_overall", "mean_asserts_correct", "mean_addresses_each_choice",
    "mean_no_hallucination", "golden_pass_rate", "golden_passed", "golden_total",
    "items": [per-question detail]}``.
    """
    explainer = explainer or ai.explain_sync
    questions = _eval_questions(session, q_types=q_types, limit=limit)

    items: list[dict] = []
    for q in questions:
        choices = sorted(
            session.exec(select(AnswerChoice).where(AnswerChoice.question_id == q.id)).all(),
            key=lambda c: c.label,
        )
        choice_dicts = [{"label": c.label, "text": c.text} for c in choices]
        labels = [c.label for c in choices]
        passage_text = None
        passage_topic = None
        if q.passage_id is not None:
            passage = session.get(Passage, q.passage_id)
            if passage is not None:
                passage_text = passage.text
                passage_topic = passage.topic
        kwargs = {}
        if _accepts_kw(explainer, "passage_text"):
            kwargs["passage_text"] = passage_text
        if _accepts_kw(explainer, "passage_topic"):
            kwargs["passage_topic"] = passage_topic
        try:
            body = explainer(q.stem, q.prompt, choice_dicts, q.correct_answer,
                             **kwargs)
        except Exception as exc:  # noqa: BLE001
            items.append({"question_id": q.id, "q_type": q.q_type,
                          "error": str(exc), "overall": 0.0})
            continue
        scored = score_explanation(q.stem, q.prompt, choice_dicts,
                                   q.correct_answer, body, judge=judge,
                                   passage_text=passage_text)
        golden = check_golden(body, q.q_type, q.correct_answer, labels)
        items.append({"question_id": q.id, "q_type": q.q_type,
                      **scored, "golden": golden})

    scored_items = [it for it in items if "error" not in it]
    n = len(scored_items)

    def _mean(key: str) -> Optional[float]:
        vals = [it[key] for it in scored_items if key in it]
        return round(sum(vals) / len(vals), 4) if vals else None

    golden_judged = [it["golden"] for it in scored_items
                     if it.get("golden", {}).get("passed") is not None]
    golden_passed = sum(1 for g in golden_judged if g["passed"])

    return {
        "n": n,
        "mean_overall": _mean("overall"),
        "mean_asserts_correct": _mean("asserts_correct"),
        "mean_addresses_each_choice": _mean("addresses_each_choice"),
        "mean_no_hallucination": _mean("no_hallucination"),
        "golden_total": len(golden_judged),
        "golden_passed": golden_passed,
        "golden_pass_rate": (round(golden_passed / len(golden_judged), 4)
                             if golden_judged else None),
        "items": items,
    }


def _release_floor_explainer(stem: str, prompt: str, choices: list[dict],
                             correct: str, **kwargs) -> str:
    lines = [f"The correct answer is ({correct})."]
    for c in choices:
        verdict = "correct answer" if c["label"] == correct else "incorrect trap"
        lines.append(f"({c['label']}) {verdict}: {c['text']}")
    if kwargs.get("passage_text"):
        lines.append("The passage evidence is considered for this explanation.")
    return "\n".join(lines)


def _release_floor_judge(prompt: str) -> str:
    return json.dumps({
        "addresses_each_choice": 1.0,
        "no_hallucination": 1.0,
        "notes": "deterministic release floor",
    })


def run_release_floor(session: Session, *, limit: int = len(GOLDEN_SET),
                      min_mean_overall: float = 0.99,
                      min_golden_pass_rate: float = 1.0) -> dict:
    """Run the deterministic explanation quality floor used by release gates.

    This deliberately does not invoke the local model. It proves that the eval
    harness, seeded question data, golden checks, and aggregate scoring still
    work before live/provider evals are trusted.
    """
    report = run_eval(
        session,
        explainer=_release_floor_explainer,
        judge=_release_floor_judge,
        limit=limit,
    )
    issues: list[str] = []
    if report["n"] < 1:
        issues.append("no_questions_scored")
    if report["golden_total"] < 1:
        issues.append("no_golden_questions_scored")
    if report["golden_pass_rate"] is None or report["golden_pass_rate"] < min_golden_pass_rate:
        issues.append("golden_pass_rate_below_floor")
    if report["mean_overall"] is None or report["mean_overall"] < min_mean_overall:
        issues.append("mean_overall_below_floor")
    return {
        "ok": not issues,
        "issues": issues,
        "thresholds": {
            "min_mean_overall": min_mean_overall,
            "min_golden_pass_rate": min_golden_pass_rate,
        },
        "report": report,
    }


def format_report(report: dict) -> str:
    """A short human-readable summary of a :func:`run_eval` report."""
    lines = [
        "LSATLab Tier-A explanation eval",
        f"  questions scored : {report['n']}",
        f"  mean overall     : {report['mean_overall']}",
        f"  asserts correct  : {report['mean_asserts_correct']}",
        f"  addresses choices: {report['mean_addresses_each_choice']}",
        f"  no hallucination : {report['mean_no_hallucination']}",
        f"  golden pass rate : {report['golden_pass_rate']} "
        f"({report['golden_passed']}/{report['golden_total']})",
    ]
    fails = [it for it in report["items"]
             if it.get("golden", {}).get("passed") is False or "error" in it]
    if fails:
        lines.append("  failing items:")
        for it in fails:
            why = it.get("error") or ", ".join(it.get("golden", {}).get("reasons", []))
            lines.append(f"    - Q{it['question_id']} ({it['q_type']}): {why}")
    return "\n".join(lines)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run LSAT explanation evals.")
    parser.add_argument("--release-floor", action="store_true",
                        help="Run the deterministic offline release floor.")
    parser.add_argument("--check", action="store_true",
                        help="Exit non-zero if the selected eval misses its floor.")
    parser.add_argument("--seed", action="store_true",
                        help="Seed the sample LSAT bank before running.")
    parser.add_argument("--json", action="store_true",
                        help="Print machine-readable JSON instead of text.")
    parser.add_argument("--limit", type=int, default=len(GOLDEN_SET))
    parser.add_argument("--min-mean-overall", type=float, default=0.99)
    parser.add_argument("--min-golden-pass-rate", type=float, default=1.0)
    return parser.parse_args(argv)


def _main(argv: list[str] | None = None) -> None:  # pragma: no cover - CLI entrypoint
    args = _parse_args(argv)
    from .db import engine

    if args.seed:
        from . import seed as seed_mod

        seed_mod.seed(reset=True)

    with Session(engine) as session:
        if args.release_floor:
            result = run_release_floor(
                session,
                limit=args.limit,
                min_mean_overall=args.min_mean_overall,
                min_golden_pass_rate=args.min_golden_pass_rate,
            )
            report = result["report"]
        else:
            report = run_eval(session, limit=args.limit)
            result = {
                "ok": (
                    report["mean_overall"] is not None
                    and report["mean_overall"] >= args.min_mean_overall
                    and report["golden_pass_rate"] is not None
                    and report["golden_pass_rate"] >= args.min_golden_pass_rate
                ),
                "issues": [],
                "report": report,
            }

    if args.json:
        print(json.dumps(result if args.release_floor else report, indent=2, sort_keys=True))
    else:
        print(format_report(report))
        if args.release_floor:
            print(
                "explanation_golden_floor "
                f"ok={result['ok']} "
                f"golden_pass_rate={report['golden_pass_rate']} "
                f"mean_overall={report['mean_overall']}"
            )
            if result["issues"]:
                print("issues:", ", ".join(result["issues"]))
    if args.check and not result["ok"]:
        raise SystemExit(1)


if __name__ == "__main__":  # pragma: no cover
    _main()
