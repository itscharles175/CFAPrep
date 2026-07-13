"""Auto-tagging: heuristic prompt classifier + model-injected batch driver."""
from __future__ import annotations

import json
from pathlib import Path

from sqlmodel import select

from app import tagging
from app.import_dataset import import_dataset as run_import, read_jsonl
from app.models import AnswerChoice, Question, QuestionSource

FIXTURES = Path(__file__).parent / "fixtures"


def test_heuristic_recognizes_common_lr_prompts():
    cases = [
        ("Which one of the following, if true, most weakens the editorial's argument?", "Weaken"),
        ("Which one of the following, if true, most strengthens the argument?", "Strengthen"),
        ("The argument's reasoning is most vulnerable to criticism on the grounds that it", "Flaw"),
        ("The argument depends on which one of the following assumptions?", "NecessaryAssumption"),
        ("Which one of the following most accurately expresses the main point?", "MainPoint"),
        ("If the statements above are true, which one of the following must also be true?", "Inference"),
    ]
    for prompt, expected in cases:
        assert tagging._heuristic_q_type("LR", prompt) == expected, prompt


def test_heuristic_recognizes_common_rc_prompts():
    cases = [
        ("Which one of the following most accurately expresses the main idea of the passage?", "MainPoint"),
        ("The author's attitude toward the newer view can best be described as", "Attitude"),
        ("According to the passage, suppressing fire has which effect?", "Detail"),
        ("It can be inferred from the passage that", "Inference"),
    ]
    for prompt, expected in cases:
        assert tagging._heuristic_q_type("RC", prompt) == expected, prompt


def test_tag_question_uses_model_when_heuristic_misses(db_session):
    """LR prompts with no obvious keywords should fall through to the model."""

    def fake_model(prompt: str) -> str:
        return json.dumps({
            "q_type": "Paradox",
            "difficulty": 4,
            "traps": {
                "A": "out_of_scope", "B": "none", "C": "too_strong",
                "D": "irrelevant_comparison", "E": "half_right",
            },
        })

    # Seed-style obscure prompt that doesn't match heuristics.
    choices = [
        AnswerChoice(question_id=0, label=l, text=f"opt {l}", is_correct=(l == "B"))
        for l in "ABCDE"
    ]
    res = tagging.tag_question(
        "LR",
        "Two facts that appear contradictory are stated.",
        "Which one of the following best accounts for both facts?",
        choices, "B",
        model_call=fake_model,
    )
    assert res.q_type == "Paradox"
    assert res.difficulty == 4
    assert res.via == "model"
    assert res.trap_types == [
        "out_of_scope", "none", "too_strong",
        "irrelevant_comparison", "half_right",
    ]


def test_tag_question_falls_back_when_model_fails(db_session):
    def broken_model(prompt: str) -> str:
        raise RuntimeError("ollama offline")

    choices = [
        AnswerChoice(question_id=0, label=l, text=f"opt {l}", is_correct=(l == "A"))
        for l in "ABCDE"
    ]
    res = tagging.tag_question(
        "LR",
        "Some obscure stimulus with no keyword phrasing.",
        "Choose the best response.",
        choices, "A",
        model_call=broken_model,
    )
    assert res.q_type == "Inference"  # LR fallback
    assert res.via == "fallback"


def test_batch_tag_updates_imported_research_questions(db_session):
    # Import the fixture so the bank has untagged research questions.
    rows = list(read_jsonl(FIXTURES / "agieval-lsat-lr.jsonl"))
    res = run_import(db_session, "agieval-lsat-lr", rows_iter=iter(rows))
    assert res.inserted == 2

    # The importer sets the generic "Inference" placeholder, which the batch
    # driver treats as needs-tagging for research items.
    before = db_session.exec(
        select(Question).where(Question.source == QuestionSource.research)
    ).all()
    assert all(q.q_type == "Inference" for q in before)

    def fake_model(prompt: str) -> str:
        # Pick from the prompt: first row is assumption, second is flaw.
        if "school calendar" in prompt:
            q_type = "NecessaryAssumption"
        else:
            q_type = "Flaw"
        return json.dumps({"q_type": q_type, "difficulty": 3})

    batch = tagging.batch_tag(db_session, limit=10, model_call=fake_model)
    # Both fixture rows have heuristic-friendly prompts ("assumption", "vulnerable to criticism");
    # heuristic wins before the model call.
    assert batch.updated == 2
    assert batch.via_heuristic == 2

    after = db_session.exec(
        select(Question).where(Question.source == QuestionSource.research)
    ).all()
    types = {q.q_type for q in after}
    assert "NecessaryAssumption" in types
    assert "Flaw" in types


def test_batch_tag_is_resumable(db_session):
    rows = list(read_jsonl(FIXTURES / "agieval-lsat-lr.jsonl"))
    run_import(db_session, "agieval-lsat-lr", rows_iter=iter(rows))

    def fake_model(prompt: str) -> str:
        return json.dumps({"q_type": "Weaken", "difficulty": 2})

    # First pass with limit=1 touches only one row.
    first = tagging.batch_tag(db_session, limit=1, model_call=fake_model)
    assert first.updated == 1

    # Second pass should pick up the remaining untagged row.
    second = tagging.batch_tag(db_session, limit=10, model_call=fake_model)
    assert second.updated == 1

    # And a third pass is a no-op.
    third = tagging.batch_tag(db_session, limit=10, model_call=fake_model)
    assert third.updated == 0
