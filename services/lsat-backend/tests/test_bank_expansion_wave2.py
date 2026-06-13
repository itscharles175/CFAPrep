"""Bank-expansion plan Wave 2 — quality gates and anchor weighting."""
from __future__ import annotations

import json
from collections import Counter

import pytest
from sqlmodel import Session, select

from app import config, embeddings, generation
from app.db import engine
from app.models import AnswerChoice, Question, QuestionSource


GOOD_LR = {
    "stem": "All cats are mammals. Felix is a cat.",
    "prompt": "Which one of the following must be true?",
    "difficulty": 2,
    "correct_answer": "B",
    "choices": [
        {"label": "A", "text": "Felix is a reptile.", "trap_type": "opposite"},
        {"label": "B", "text": "Felix is a mammal okay.", "trap_type": "none"},
        {"label": "C", "text": "All mammals are cats here.", "trap_type": "reversal"},
        {"label": "D", "text": "Felix is not an animal!", "trap_type": "out_of_scope"},
        {"label": "E", "text": "Some cats are not mammals.", "trap_type": "degree"},
    ],
}


def test_permutation_invariant_rejects_positional_bias(monkeypatch):
    """Wave 2.1 — shuffled choice order must still map back to credited letter."""
    monkeypatch.setattr(config, "GEN_PERMUTATION_SC", True)

    def solver(prompt: str) -> str:
        # Always return the letter the prompt's choice order suggests at position B
        if "Solve this LSAT" in prompt:
            return "B"
        return "A"  # wrong under rotation

    report = generation.validate_candidate(
        GOOD_LR, runs=1,
        solver=solver,
        critic=lambda _p: json.dumps(
            {"single_defensible": True, "defensible_letters": ["B"]}
        ),
        informativity=False,
    )
    assert report["passed"] is False
    assert report["reason"] == "permutation_inconsistent"
    assert report["checks"]["permutation_invariant"]["ok"] is False


def test_informativity_rejects_stimulus_free_solve(monkeypatch):
    """Wave 2.2 — solver must not recover credited letter without stimulus."""
    monkeypatch.setattr(config, "GEN_INFORMATIVITY_CHECK", True)

    def solver(prompt: str) -> str:
        if "[removed]" in prompt:
            return "B"
        return "B"

    report = generation.validate_candidate(
        GOOD_LR, runs=1,
        solver=solver,
        critic=lambda _p: json.dumps(
            {"single_defensible": True, "defensible_letters": ["B"]}
        ),
        permutation_invariant=False,
    )
    assert report["passed"] is False
    assert report["reason"] == "uninformative_stimulus"


def test_training_anchor_weighted_rotation(db_session, monkeypatch):
    """Wave 2.6 — flagged parents appear ~4x more in weighted rotation."""
    monkeypatch.setattr(config, "GEN_TRAINING_ANCHOR_WEIGHT", 4)
    q_type = "W2AnchorType"
    plain = Question(
        stem="plain " * 10, prompt="p", correct_answer="A", q_type=q_type,
        source=QuestionSource.official, training_eligible=False,
    )
    flagged = Question(
        stem="flagged " * 10, prompt="p", correct_answer="A", q_type=q_type,
        source=QuestionSource.official, training_eligible=True,
    )
    db_session.add(plain)
    db_session.add(flagged)
    db_session.commit()

    parents = generation._eligible_parents(db_session, q_type)
    counts = Counter(p.id for p in parents)
    assert counts[flagged.id] == 4
    assert counts[plain.id] == 1
    # Simulate 100 round-robin picks
    picks = [parents[i % len(parents)].id for i in range(100)]
    pick_counts = Counter(picks)
    ratio = pick_counts[flagged.id] / max(1, pick_counts[plain.id])
    assert 2.5 <= ratio <= 5.5


def test_vector_store_protocol(db_session):
    """Wave 2.5 — SQLiteVectorStore satisfies VectorStore protocol."""
    store = embeddings.vector_store(db_session)
    assert isinstance(store, embeddings.VectorStore)
    q = db_session.exec(select(Question).where(Question.deleted_at.is_(None))).first()
    assert q is not None
    vec = [0.1, 0.2, 0.3, 0.4]
    store.upsert(embeddings.QUESTION, q.id, vec, "test-model")
    got = store.all_for(embeddings.QUESTION)
    assert q.id in got
    top = store.cosine_top_k(vec, k=3, exclude_id=q.id)
    assert isinstance(top, list)


def test_coverage_includes_training_anchor_count(db_session):
    """Wave 2.6 — coverage() surfaces training_anchor_count per q_type."""
    q_type = "W2CovType"
    db_session.add(Question(
        stem="t " * 10, prompt="p", correct_answer="A", q_type=q_type,
        source=QuestionSource.official, training_eligible=True,
    ))
    db_session.commit()
    row = next(r for r in generation.coverage(db_session) if r["q_type"] == q_type)
    assert row["training_anchor_count"] >= 1


def test_rc_hard_gate_rejects_short_passage(monkeypatch):
    """Wave 2.3 — rc_authenticity is a hard gate inside validate_candidate."""
    monkeypatch.setattr(config, "GEN_PERMUTATION_SC", False)
    monkeypatch.setattr(config, "GEN_INFORMATIVITY_CHECK", False)
    cand = {
        "passage": "Too short for RC.",
        "stem": "x" * 40,
        "prompt": "Main point?",
        "correct_answer": "B",
        "choices": [
            {
                "label": l,
                "text": "even length choice text here ok",
                "trap_type": "none" if l == "B" else {
                    "A": "opposite",
                    "C": "reversal",
                    "D": "out_of_scope",
                    "E": "degree",
                }[l],
            }
            for l in "ABCDE"
        ],
    }
    report = generation.validate_candidate(
        cand, runs=1,
        solver=lambda _p: "B",
        critic=lambda _p: '{"single_defensible": true, "defensible_letters": ["B"]}',
    )
    assert report["passed"] is False
    assert report["reason"].startswith("rc_authenticity:")
