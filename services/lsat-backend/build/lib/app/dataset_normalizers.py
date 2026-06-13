"""Normalize raw rows from open LSAT research datasets into a common shape.

Each `normalize_*` function consumes raw row dicts (as they appear on Hugging
Face) and yields `NormalizedQuestion` dicts that `import_dataset.commit_records`
knows how to persist. Splitting per-source mapping out keeps the importer itself
small and lets new datasets plug in by adding a function here.

Supported sources (see plan):

- ``agieval-lsat-lr`` (dmayhem93/agieval-lsat-lr) — 510 LR rows, MIT.
- ``agieval-lsat-rc`` (dmayhem93/agieval-lsat-rc) — 269 RC rows, MIT.
- ``tasksource-lsat-rc`` (tasksource/lsat-rc) — 2,366 RC rows, CC-BY-4.0.
- ``tasksource-lsat-lr`` (tasksource/lsat-lr) — ~4,500 LR rows, CC-BY-4.0.
- ``reclor`` (Yu et al., ICLR 2020) — local zip import (user-pulled), non-commercial.

The AGIEval rows store the entire question (passage + prompt + choices) packed
into a single ``query`` string; we parse it back out. The tasksource rows are
already split into ``context`` / ``question`` / ``answers``.

The normalizer never touches the DB. It only emits records, so it is trivial to
unit-test against tiny frozen fixtures.
"""
from __future__ import annotations

import hashlib
import re
import unicodedata
from collections.abc import Iterable, Iterator
from typing import Any, Optional, TypedDict

_LABELS = ["A", "B", "C", "D", "E"]


class NormalizedChoice(TypedDict):
    label: str
    text: str


class NormalizedQuestion(TypedDict, total=False):
    external_id: str
    section_type: str  # "LR" | "RC"
    stem: str          # LR stimulus, or RC question stem (passage held separately)
    prompt: str
    correct_answer: str
    choices: list[NormalizedChoice]
    passage_text: Optional[str]
    passage_group: Optional[str]   # rows sharing this string collapse to one passage
    q_type_hint: Optional[str]     # best-effort label from the source; tagger refines
    difficulty: int
    source_dataset: str
    content_hash: str


# --- helpers ---------------------------------------------------------------
def _strip_label_prefix(s: str) -> str:
    """Remove a leading "(A)" / "A." / "A)" prefix from a choice string."""
    return re.sub(r"^\s*\(?([A-E])\)?[\.\)\:\-]?\s*", "", s).strip()


def _normalize_text(s: str) -> str:
    """Lowercase + collapse whitespace + strip combining marks. For hashing only."""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"\s+", " ", s)
    return s.strip().lower()


def content_hash(stem: str, choices: Iterable[str]) -> str:
    """Stable hash of (normalized stem + sorted normalized choices).

    Choice order is dropped so two sources that present the same item with
    options shuffled still collide and dedup. The stem dominates the signal in
    practice, but including choices guards against the rare case of two distinct
    questions sharing a stem.
    """
    parts = [_normalize_text(stem)]
    parts.extend(sorted(_normalize_text(c) for c in choices))
    h = hashlib.sha256("\u0001".join(parts).encode("utf-8")).hexdigest()
    return h


# --- AGIEval --------------------------------------------------------------
# The query field looks like:
#   "<stimulus>Q: <prompt> Answer Choices: (A)... (B)... (C)... (D)... (E)...\nA: Among A through E, the answer is"
# We split on the "Q:" marker, then on "Answer Choices:". The cleaned `choices`
# array on the row is the authoritative source for choice text (label prefix
# stripped), and `gold` is a single-element list with the 0-based correct index.
_QMARK_RE = re.compile(r"\bQ\s*[:\.]\s*", re.IGNORECASE)
_CHOICES_MARK_RE = re.compile(r"answer\s*choices\s*[:\.]\s*", re.IGNORECASE)
_TAIL_PROMPT_RE = re.compile(
    r"\s*A\s*[:\.]\s*Among\s+A\s+through\s+E.*$", re.IGNORECASE | re.DOTALL
)


def _split_agieval_query(query: str) -> tuple[str, str]:
    """Return (stimulus, prompt) extracted from the packed AGIEval query string."""
    q = _TAIL_PROMPT_RE.sub("", query).strip()
    # Cut off "Answer Choices: ..." if present (the cleaned `choices` field is
    # authoritative; we ignore whatever follows in the packed text).
    cm = _CHOICES_MARK_RE.search(q)
    if cm:
        q = q[: cm.start()].rstrip()
    m = _QMARK_RE.search(q)
    if not m:
        return q.strip(), ""
    stimulus = q[: m.start()].rstrip()
    prompt = q[m.end():].strip()
    return stimulus, prompt


def _choice_label_for_index(idx: int) -> str:
    if 0 <= idx < len(_LABELS):
        return _LABELS[idx]
    raise ValueError(f"gold index {idx} out of range")


def _agieval_record(row: dict[str, Any], idx: int, *,
                    dataset: str, section_type: str) -> Optional[NormalizedQuestion]:
    query = (row.get("query") or "").strip()
    raw_choices = list(row.get("choices") or [])
    gold = row.get("gold") or []
    if not query or not raw_choices or not gold:
        return None
    try:
        correct_idx = int(gold[0])
    except (TypeError, ValueError):
        return None

    stimulus, prompt = _split_agieval_query(query)
    if not stimulus and not prompt:
        return None

    cleaned = [_strip_label_prefix(c) for c in raw_choices][: len(_LABELS)]
    # Pad to 5 if a row is short (rare in AGIEval).
    while len(cleaned) < len(_LABELS):
        cleaned.append("")

    correct_label = _choice_label_for_index(min(correct_idx, len(_LABELS) - 1))
    choices: list[NormalizedChoice] = [
        {"label": _LABELS[i], "text": cleaned[i]} for i in range(len(_LABELS))
    ]
    return {
        "external_id": f"{dataset}:{idx}",
        "section_type": section_type,
        "stem": stimulus,
        "prompt": prompt or "Which one of the following is most accurate?",
        "correct_answer": correct_label,
        "choices": choices,
        "passage_text": stimulus if section_type == "RC" else None,
        "passage_group": stimulus if section_type == "RC" else None,
        "q_type_hint": None,
        "difficulty": 3,
        "source_dataset": dataset,
        "content_hash": content_hash(stimulus + "\n" + prompt, cleaned),
    }


def normalize_agieval_lr(rows: Iterable[dict[str, Any]]) -> Iterator[NormalizedQuestion]:
    for i, row in enumerate(rows):
        rec = _agieval_record(row, i, dataset="agieval-lsat-lr", section_type="LR")
        if rec is not None:
            yield rec


def normalize_agieval_rc(rows: Iterable[dict[str, Any]]) -> Iterator[NormalizedQuestion]:
    for i, row in enumerate(rows):
        rec = _agieval_record(row, i, dataset="agieval-lsat-rc", section_type="RC")
        if rec is not None:
            yield rec


# --- tasksource/lsat-rc ----------------------------------------------------
# Row shape: { context, id_string, answers: [5 strings], label: int, question }
# id_string looks like "199106_1-RC_1_1": <date>_<form>-RC_<passage>_<qnum>.
_TASKSOURCE_GROUP_RE = re.compile(r"^([0-9]+_[0-9]+-RC_[0-9]+)_[0-9]+$")


def _tasksource_passage_group(id_string: str, context: str) -> str:
    """Stable key that groups questions sharing a passage.

    Prefer the id_string prefix (cheap, deterministic, survives whitespace
    differences). Fall back to the raw passage text so questions still attach to
    *some* passage if the id doesn't match the expected shape.
    """
    if id_string:
        m = _TASKSOURCE_GROUP_RE.match(id_string)
        if m:
            return f"tasksource-rc:{m.group(1)}"
    return f"tasksource-rc:passage:{_normalize_text(context)[:120]}"


def normalize_tasksource_rc(
    rows: Iterable[dict[str, Any]],
) -> Iterator[NormalizedQuestion]:
    for i, row in enumerate(rows):
        context = (row.get("context") or "").strip()
        question = (row.get("question") or "").strip()
        answers = list(row.get("answers") or [])
        label = row.get("label")
        id_string = (row.get("id_string") or "").strip()
        if not context or not question or not answers or label is None:
            continue
        try:
            correct_idx = int(label)
        except (TypeError, ValueError):
            continue

        cleaned = [str(a).strip() for a in answers][: len(_LABELS)]
        while len(cleaned) < len(_LABELS):
            cleaned.append("")
        correct_label = _choice_label_for_index(min(correct_idx, len(_LABELS) - 1))
        choices: list[NormalizedChoice] = [
            {"label": _LABELS[j], "text": cleaned[j]} for j in range(len(_LABELS))
        ]
        external_id = id_string or f"tasksource-lsat-rc:{i}"
        yield {
            "external_id": f"tasksource-lsat-rc:{external_id}",
            "section_type": "RC",
            "stem": context,
            "prompt": question,
            "correct_answer": correct_label,
            "choices": choices,
            "passage_text": context,
            "passage_group": _tasksource_passage_group(id_string, context),
            "q_type_hint": None,
            "difficulty": 3,
            "source_dataset": "tasksource-lsat-rc",
            "content_hash": content_hash(context + "\n" + question, cleaned),
        }


# --- tasksource/lsat-lr ----------------------------------------------------
# Same parquet shape as tasksource/lsat-rc (context, question, answers, label,
# id_string) but each row is a self-contained LR item — no passage grouping.
def normalize_tasksource_lr(
    rows: Iterable[dict[str, Any]],
) -> Iterator[NormalizedQuestion]:
    for i, row in enumerate(rows):
        context = (row.get("context") or "").strip()
        question = (row.get("question") or "").strip()
        answers = list(row.get("answers") or [])
        label = row.get("label")
        id_string = (row.get("id_string") or "").strip()
        if not context or not question or not answers or label is None:
            continue
        try:
            correct_idx = int(label)
        except (TypeError, ValueError):
            continue

        cleaned = [str(a).strip() for a in answers][: len(_LABELS)]
        while len(cleaned) < len(_LABELS):
            cleaned.append("")
        correct_label = _choice_label_for_index(min(correct_idx, len(_LABELS) - 1))
        choices: list[NormalizedChoice] = [
            {"label": _LABELS[j], "text": cleaned[j]} for j in range(len(_LABELS))
        ]
        external_id = id_string or str(i)
        yield {
            "external_id": f"tasksource-lsat-lr:{external_id}",
            "section_type": "LR",
            "stem": context,
            "prompt": question,
            "correct_answer": correct_label,
            "choices": choices,
            "passage_text": None,
            "passage_group": None,
            "q_type_hint": None,
            "difficulty": 3,
            "source_dataset": "tasksource-lsat-lr",
            "content_hash": content_hash(context + "\n" + question, cleaned),
        }


# --- ReClor ----------------------------------------------------------------
# Local-only import (user supplies the zip path; ReClor's license forbids
# redistribution). Row shape from the upstream JSON files:
#   { id_string, context, question, answers: [4 strings], label: int }
# ReClor has only 4 answer choices per question; we pad the fifth slot with an
# empty string and pin the correct label to A-D (label is 0-based). The LSAT
# half is identified upstream by ``id_string`` containing "lsat" — callers
# pre-filter via ``reclor_lsat_only=True``.
def normalize_reclor(
    rows: Iterable[dict[str, Any]],
    *,
    lsat_only: bool = True,
) -> Iterator[NormalizedQuestion]:
    for i, row in enumerate(rows):
        id_string = (row.get("id_string") or row.get("id") or "").strip()
        if lsat_only and id_string and "lsat" not in id_string.lower():
            continue
        context = (row.get("context") or "").strip()
        question = (row.get("question") or "").strip()
        answers = list(row.get("answers") or [])
        label = row.get("label")
        if not context or not question or not answers or label is None:
            continue
        try:
            correct_idx = int(label)
        except (TypeError, ValueError):
            continue

        cleaned = [str(a).strip() for a in answers][: len(_LABELS)]
        while len(cleaned) < len(_LABELS):
            cleaned.append("")
        correct_label = _choice_label_for_index(min(correct_idx, len(_LABELS) - 1))
        choices: list[NormalizedChoice] = [
            {"label": _LABELS[j], "text": cleaned[j]} for j in range(len(_LABELS))
        ]
        external_id = id_string or str(i)
        yield {
            "external_id": f"reclor:{external_id}",
            "section_type": "LR",
            "stem": context,
            "prompt": question,
            "correct_answer": correct_label,
            "choices": choices,
            "passage_text": None,
            "passage_group": None,
            "q_type_hint": None,
            "difficulty": 3,
            "source_dataset": "reclor",
            "content_hash": content_hash(context + "\n" + question, cleaned),
        }


# --- dispatch --------------------------------------------------------------
NORMALIZERS = {
    "agieval-lsat-lr": normalize_agieval_lr,
    "agieval-lsat-rc": normalize_agieval_rc,
    "tasksource-lsat-rc": normalize_tasksource_rc,
    "tasksource-lsat-lr": normalize_tasksource_lr,
    "reclor": normalize_reclor,
}
