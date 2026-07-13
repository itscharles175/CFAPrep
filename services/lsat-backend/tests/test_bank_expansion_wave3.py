"""Bank-expansion plan Wave 3 — CoVe, novelty gate, import dedup."""
from __future__ import annotations

import json

import pytest
from sqlmodel import select

from app import config, generation, import_dataset
from app.dataset_normalizers import NormalizedQuestion
from app.db import engine
from app import embeddings
from app.import_dataset import DATASETS, commit_records
from app.models import Question, QuestionSource
from sqlmodel import Session


def _bow_embedder(text, model=None):
    # Deterministic: identical text -> identical vector -> cosine 1.0
    t = text or ""
    return [float(len(t)), float(hash(t) % 10_000)]


def test_import_skips_near_duplicate(db_session, monkeypatch):
    """Wave 3.3 — cosine >= 0.98 skips import."""
    monkeypatch.setattr(config, "IMPORT_DEDUP_SKIP", 0.5)  # low bar for test
    spec = DATASETS["tasksource-lsat-lr"]
    rec = {
        "section_type": "LR",
        "stem": "duplicate stem text here for testing purposes only",
        "prompt": "Which must be true?",
        "correct_answer": "A",
        "choices": [{"label": l, "text": f"choice {l} text"} for l in "ABCDE"],
        "external_id": "dup-test-1",
        "content_hash": "hash-dup-1",
        "q_type_hint": "Inference",
    }
    from app.models import AnswerChoice

    q = Question(
        stem=rec["stem"], prompt=rec["prompt"], correct_answer="A",
        q_type="Inference", source=QuestionSource.research,
    )
    db_session.add(q)
    db_session.commit()
    db_session.refresh(q)
    for c in rec["choices"]:
        db_session.add(AnswerChoice(
            question_id=q.id, label=c["label"], text=c["text"],
            is_correct=(c["label"] == "A"),
        ))
    db_session.commit()
    embeddings.embed_question(db_session, q, embedder=_bow_embedder)

    result = commit_records(db_session, spec, [rec], embedder=_bow_embedder)
    assert result.inserted == 0
    assert result.skipped_duplicate >= 1


def test_novelty_gate_inside_validate(db_session, monkeypatch):
    """Wave 3.4 — near-duplicate rejected via validate_candidate(session=...)."""
    from app.models import AnswerChoice

    from tests.test_generation import GOOD_CANDIDATE

    existing = Question(
        stem=GOOD_CANDIDATE["stem"], prompt=GOOD_CANDIDATE["prompt"],
        correct_answer="B", q_type="Inference", source=QuestionSource.research,
    )
    db_session.add(existing)
    db_session.commit()
    db_session.refresh(existing)
    for c in GOOD_CANDIDATE["choices"]:
        db_session.add(AnswerChoice(
            question_id=existing.id, label=c["label"], text=c["text"],
            is_correct=(c["label"] == "B"),
        ))
    db_session.commit()
    embeddings.embed_question(db_session, existing, embedder=_bow_embedder)

    monkeypatch.setattr(config, "GEN_DEDUP_THRESHOLD_LR", 0.5)
    report = generation.validate_candidate(
        GOOD_CANDIDATE, runs=1,
        solver=lambda _p: "B",
        critic=lambda _p: json.dumps(
            {"single_defensible": True, "defensible_letters": ["B"]}
        ),
        session=db_session,
        embedder=_bow_embedder,
    )
    assert report["passed"] is False
    assert report["reason"] == "near_duplicate"
    assert report["checks"]["novelty"]["checked"] is True
