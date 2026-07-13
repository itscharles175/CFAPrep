"""Dataset ingestion: normalizers, idempotent commit, and the module CLI.

These tests never hit the network. They feed the importer rows from the small
JSONL fixtures under ``tests/fixtures/`` so the dataset code paths are exercised
deterministically.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from sqlmodel import select

from app import dataset_normalizers as dn
from app import import_dataset
from app.import_dataset import DATASETS, import_dataset as run_import, read_jsonl
from app.models import Passage, PrepTest, Question, QuestionSource, Section, SectionType

FIXTURES = Path(__file__).parent / "fixtures"


def _row_count(rows_iter):
    return sum(1 for _ in rows_iter)


def test_agieval_lr_normalizer_extracts_stem_prompt_and_answer():
    rows = list(read_jsonl(FIXTURES / "agieval-lsat-lr.jsonl"))
    recs = list(dn.normalize_agieval_lr(rows))
    assert len(recs) == 2

    first = recs[0]
    assert first["section_type"] == "LR"
    assert first["correct_answer"] == "E"
    assert "school calendar" in first["stem"]
    assert "assumption" in first["prompt"].lower()
    # AGIEval labels are stripped from choice texts.
    assert all(not c["text"].startswith("(") for c in first["choices"])
    assert {c["label"] for c in first["choices"]} == {"A", "B", "C", "D", "E"}

    # External id is the source key + row index so dedup works on re-import.
    assert first["external_id"] == "agieval-lsat-lr:0"
    assert first["content_hash"]


def test_tasksource_rc_groups_passages_by_id_string():
    rows = list(read_jsonl(FIXTURES / "tasksource-lsat-rc.jsonl"))
    recs = list(dn.normalize_tasksource_rc(rows))
    assert len(recs) == 3

    # Questions 1 and 2 share a passage; question 3 has a different passage.
    groups = {r["passage_group"] for r in recs}
    assert len(groups) == 2
    # The shared passage group key uses the tasksource id prefix.
    assert any("199106_1-RC_1" in g for g in groups)
    # All come in as RC.
    assert all(r["section_type"] == "RC" for r in recs)


def test_read_jsonl_rejects_oversized_files(tmp_path, monkeypatch):
    monkeypatch.setattr(import_dataset, "MAX_JSONL_BYTES", 8)
    path = tmp_path / "too-big.jsonl"
    path.write_text('{"row": 1}\n', encoding="utf-8")

    with pytest.raises(ValueError, match="dataset_file_too_large"):
        list(read_jsonl(path))


def test_read_jsonl_rejects_symlinked_files_when_supported(tmp_path):
    real = tmp_path / "real.jsonl"
    link = tmp_path / "linked.jsonl"
    real.write_text('{"row": 1}\n', encoding="utf-8")
    try:
        os.symlink(real, link)
    except OSError as exc:
        pytest.skip(f"symlink fixture unavailable: {exc}")

    with pytest.raises(ValueError, match="dataset_path_symlink"):
        list(read_jsonl(link))


def test_content_hash_is_order_insensitive_for_choices():
    h1 = dn.content_hash("Same stem.", ["alpha", "beta", "gamma", "delta", "epsilon"])
    h2 = dn.content_hash("Same stem.", ["epsilon", "delta", "gamma", "beta", "alpha"])
    assert h1 == h2

    h3 = dn.content_hash("Different stem.", ["alpha", "beta", "gamma", "delta", "epsilon"])
    assert h1 != h3


def test_commit_records_is_idempotent(db_session):
    rows1 = list(read_jsonl(FIXTURES / "agieval-lsat-lr.jsonl"))
    rows2 = list(read_jsonl(FIXTURES / "agieval-lsat-lr.jsonl"))

    first = run_import(db_session, "agieval-lsat-lr", rows_iter=iter(rows1))
    assert first.inserted == 2
    assert first.skipped_duplicate == 0

    # Re-running the same import inserts nothing new.
    second = run_import(db_session, "agieval-lsat-lr", rows_iter=iter(rows2))
    assert second.inserted == 0
    assert second.skipped_duplicate == 2
    assert second.preptest_id == first.preptest_id

    # The PrepTest is marked unofficial and has one LR section.
    pt = db_session.get(PrepTest, first.preptest_id)
    assert pt is not None
    assert pt.is_official is False
    sections = db_session.exec(
        select(Section).where(Section.preptest_id == pt.id)
    ).all()
    assert len(sections) == 1
    assert sections[0].type == SectionType.LR

    # Questions land as `research` and carry external_id + content_hash.
    questions = db_session.exec(
        select(Question).where(Question.section_id == sections[0].id)
    ).all()
    assert len(questions) == 2
    assert all(q.source == QuestionSource.research for q in questions)
    assert all(q.external_id and q.content_hash for q in questions)


def test_rc_import_creates_one_passage_per_group(db_session):
    rows = list(read_jsonl(FIXTURES / "tasksource-lsat-rc.jsonl"))
    res = run_import(db_session, "tasksource-lsat-rc", rows_iter=iter(rows))
    assert res.inserted == 3

    pt = db_session.get(PrepTest, res.preptest_id)
    sec = db_session.exec(
        select(Section).where(Section.preptest_id == pt.id)
    ).first()
    assert sec.type == SectionType.RC

    passages = db_session.exec(
        select(Passage).where(Passage.section_id == sec.id)
    ).all()
    # Two distinct passages from the three-question fixture.
    assert len(passages) == 2

    questions = db_session.exec(
        select(Question).where(Question.section_id == sec.id)
    ).all()
    # Every RC question is wired to a passage.
    assert all(q.passage_id is not None for q in questions)


def test_cli_imports_from_fixtures_dir(db_session, capsys, tmp_path):
    # CLI path: pass --fixtures-dir so no network call is made.
    rc = import_dataset.main([
        "--sources", "agieval-lsat-lr,tasksource-lsat-rc",
        "--fixtures-dir", str(FIXTURES),
    ])
    assert rc == 0
    out = capsys.readouterr().out
    assert "agieval-lsat-lr" in out
    assert "tasksource-lsat-rc" in out

    # Re-import via CLI should report zero new inserts (skipped duplicates).
    rc2 = import_dataset.main([
        "--sources", "agieval-lsat-lr",
        "--fixtures-dir", str(FIXTURES),
    ])
    assert rc2 == 0
    out2 = capsys.readouterr().out
    assert "inserted=0" in out2


def test_cross_source_dedup_via_content_hash(db_session, tmp_path):
    """If an AGIEval RC row and a tasksource RC row share the same stem+choices,
    only one should land in the bank."""
    shared_context = "Some passage text shared between sources."
    shared_question = "Which one of the following best expresses the main point?"
    shared_choices = ["alpha", "beta", "gamma", "delta", "epsilon"]

    # tasksource row goes first.
    ts_row = {
        "context": shared_context,
        "id_string": "shared_1-RC_1_1",
        "answers": shared_choices,
        "label": 2,
        "question": shared_question,
    }
    res1 = run_import(db_session, "tasksource-lsat-rc", rows_iter=iter([ts_row]))
    assert res1.inserted == 1

    # AGIEval row carries the same stem text (passage) + same prompt + same choices.
    # We pack them like AGIEval would.
    packed_query = (
        f"{shared_context}Q: {shared_question} Answer Choices: "
        + " ".join(f"({chr(ord('A') + i)}){t}" for i, t in enumerate(shared_choices))
        + "\nA: Among A through E, the answer is"
    )
    ag_row = {
        "query": packed_query,
        "choices": [
            f"({chr(ord('A') + i)}){t}" for i, t in enumerate(shared_choices)
        ],
        "gold": [2],
    }
    res2 = run_import(db_session, "agieval-lsat-rc", rows_iter=iter([ag_row]))
    # Same content_hash -> rejected as duplicate even with a different external_id.
    assert res2.inserted == 0
    assert res2.skipped_duplicate == 1


def test_dataset_import_rolls_back_scaffold_on_malformed_record(db_session):
    spec = DATASETS["agieval-lsat-lr"]
    bad_record = {
        "external_id": "audit-bad-1",
        "content_hash": "audit-bad-hash-1",
        "stem": "A malformed row should not leave scaffold behind.",
        "prompt": "Which one of the following is true?",
        "correct_answer": "A",
        "difficulty": "not-an-int",
        "q_type_hint": "Inference",
        "section_type": "LR",
        "choices": [{"label": label, "text": label} for label in "ABCDE"],
    }

    with pytest.raises(ValueError):
        import_dataset.commit_records(db_session, spec, [bad_record])

    pt = db_session.exec(
        select(PrepTest).where(PrepTest.name == spec.preptest_name)
    ).first()
    assert pt is None
    assert db_session.exec(
        select(Question).where(Question.external_id == "audit-bad-1")
    ).first() is None
