"""Bank-expansion plan Wave 1 — tasksource/lsat-lr + ReClor ingest, lexical-leak
gate, training-corpus flag propagation."""
from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pytest
from sqlmodel import select

from app import dataset_normalizers as dn
from app import generation, import_dataset, import_pdf
from app.import_dataset import DATASETS, import_dataset as run_import, read_jsonl
from app.models import (
    AnswerChoice,
    Question,
    QuestionSource,
    Section,
    SectionType,
)

FIXTURES = Path(__file__).parent / "fixtures"


# --- 1.1 tasksource/lsat-lr ingest -----------------------------------------
def test_tasksource_lr_normalizer_emits_lr_records():
    rows = list(read_jsonl(FIXTURES / "tasksource-lsat-lr.jsonl"))
    recs = list(dn.normalize_tasksource_lr(rows))
    assert len(recs) == 2

    first = recs[0]
    assert first["section_type"] == "LR"
    # tasksource-lsat-lr's label is 0-based; row 0 has label=1 -> letter B.
    assert first["correct_answer"] == "B"
    # LR rows have no passage grouping (passage_group is intentionally None).
    assert first["passage_group"] is None
    assert first["passage_text"] is None
    # External id includes the source key prefix so dedup vs other tasksource
    # variants (rc) cannot collide.
    assert first["external_id"].startswith("tasksource-lsat-lr:")


def test_tasksource_lr_commit_writes_research_questions_to_lr_section(db_session):
    rows = list(read_jsonl(FIXTURES / "tasksource-lsat-lr.jsonl"))
    res = run_import(db_session, "tasksource-lsat-lr", rows_iter=iter(rows))
    assert res.inserted == 2
    sections = db_session.exec(select(Section)).all()
    assert any(s.type == SectionType.LR for s in sections)
    qs = db_session.exec(select(Question)).all()
    # tasksource-lsat-lr rows are research-grade (CC-BY-4.0), so they share
    # the existing `research` bucket and never land in `official` or `reclor`.
    assert any(q.source == QuestionSource.research for q in qs)


# --- 1.2 ReClor with the non-commercial gate -------------------------------
_RECLOR_ROW = {
    "id_string": "reclor-lsat-001",
    "context": (
        "Most species of birds living near the coast forage at low tide. "
        "A new study found that, contrary to expectations, the species of "
        "bird called the rockwren actually forages mainly at high tide."
    ),
    "question": (
        "Which one of the following, if true, most helps to explain the "
        "surprising finding above?"
    ),
    "answers": [
        "Rockwrens nest only in the inland mountains far from any coast.",
        "At high tide, predators of the rockwren retreat to deeper waters, "
        "allowing the rockwren to forage with reduced risk.",
        "Rockwrens often forage in groups rather than alone.",
        "Low-tide foragers of all species typically eat the same insects "
        "as high-tide foragers.",
    ],
    "label": 1,
}
_RECLOR_NON_LSAT_ROW = {
    "id_string": "reclor-other-001",
    "context": "Some non-LSAT philosophy snippet that should be filtered out.",
    "question": "Filler.",
    "answers": ["a", "b", "c", "d"],
    "label": 0,
}


def test_reclor_normalizer_filters_non_lsat_rows():
    rows = [_RECLOR_ROW, _RECLOR_NON_LSAT_ROW]
    recs = list(dn.normalize_reclor(rows))
    # Only the LSAT row survives the default lsat_only filter.
    assert len(recs) == 1
    assert recs[0]["external_id"].startswith("reclor:")
    assert recs[0]["correct_answer"] == "B"


def test_reclor_source_requires_nc_acknowledgement(db_session):
    spec = DATASETS["reclor"]
    assert spec.requires_nc_acknowledgement is True
    # Without nc_acknowledged the importer refuses to run, even with a
    # provided rows_iter — the legal posture is enforced at the front door.
    try:
        run_import(
            db_session, "reclor",
            rows_iter=iter([_RECLOR_ROW]),
            nc_acknowledged=False,
        )
    except ValueError as exc:
        assert "nc_acknowledged" in str(exc)
    else:
        raise AssertionError("expected ValueError for missing NC ack")


def test_reclor_import_lands_in_reclor_source_bucket(db_session):
    res = run_import(
        db_session, "reclor",
        rows_iter=iter([_RECLOR_ROW]),
        nc_acknowledged=True,
    )
    assert res.inserted == 1
    # Filter by the new reclor bucket — the seeded sample questions also live
    # in db_session and they're QuestionSource.sample, so a bare first() would
    # return a seed row.
    qs = db_session.exec(
        select(Question).where(Question.source == QuestionSource.reclor)
    ).all()
    # ReClor uses its own QuestionSource bucket so a future commercial build
    # can filter the source out wholesale; it is NOT lumped in with research.
    assert len(qs) == 1
    assert qs[0].source == QuestionSource.reclor


def test_reclor_zip_loader_reads_local_json_files(tmp_path, db_session):
    # Write a fake ReClor zip the loader can ingest end-to-end.
    zpath = tmp_path / "reclor-fake.zip"
    payload = [_RECLOR_ROW]
    with zipfile.ZipFile(zpath, "w") as zf:
        zf.writestr("train.json", json.dumps(payload))
        zf.writestr("README.md", "ignored non-json content")

    rows = list(import_dataset.read_reclor_zip(zpath))
    assert len(rows) == 1
    assert rows[0]["id_string"] == "reclor-lsat-001"

    # And the full import_dataset path works with local_path + nc_acknowledged.
    res = run_import(
        db_session, "reclor", local_path=str(zpath), nc_acknowledged=True,
    )
    assert res.inserted == 1


def test_reclor_zip_loader_rejects_path_traversal_members(tmp_path):
    zpath = tmp_path / "reclor-traversal.zip"
    with zipfile.ZipFile(zpath, "w") as zf:
        zf.writestr("../train.json", json.dumps([_RECLOR_ROW]))

    with pytest.raises(ValueError, match="reclor_zip_invalid_member_path"):
        list(import_dataset.read_reclor_zip(zpath))


def test_reclor_zip_loader_rejects_oversized_json_members(tmp_path, monkeypatch):
    monkeypatch.setattr(import_dataset, "MAX_RECLOR_MEMBER_BYTES", 8)
    zpath = tmp_path / "reclor-huge-member.zip"
    with zipfile.ZipFile(zpath, "w") as zf:
        zf.writestr("train.json", json.dumps([_RECLOR_ROW]))

    with pytest.raises(ValueError, match="reclor_zip_member_too_large"):
        list(import_dataset.read_reclor_zip(zpath))


def test_reclor_zip_loader_rejects_unexpected_json_members(tmp_path):
    zpath = tmp_path / "reclor-unexpected-json.zip"
    with zipfile.ZipFile(zpath, "w") as zf:
        zf.writestr("answers.json", json.dumps([_RECLOR_ROW]))

    with pytest.raises(ValueError, match="reclor_zip_unexpected_json_member"):
        list(import_dataset.read_reclor_zip(zpath))


# --- 1.4 lexical-leak gate -------------------------------------------------
def _leakish_strengthen_cand():
    return {
        "stem": (
            "All approved compounds must pass three independent safety tests "
            "before publication. Compound X has only passed two tests so far."
        ),
        "prompt": "Which one of the following, if true, most strengthens the argument?",
        "correct_answer": "B",
        "choices": [
            {"label": "A", "text": "Lab budgets vary year to year across the country."},
            # Correct heavily quotes the stem distinctive vocab.
            {"label": "B", "text": "Compound X has only passed two tests, not three independent tests."},
            {"label": "C", "text": "Most journals require peer review of submissions."},
            {"label": "D", "text": "Some scientists publish findings in conference proceedings."},
            {"label": "E", "text": "External grants often fund early-stage research."},
        ],
    }


def _clean_strengthen_cand():
    return {
        "stem": (
            "All approved compounds must pass three independent safety tests "
            "before publication. Compound X has only passed two tests so far."
        ),
        "prompt": "Which one of the following, if true, most strengthens the argument?",
        "correct_answer": "B",
        "choices": [
            {"label": "A", "text": "Funding agencies sometimes waive procedural reviews."},
            {"label": "B", "text": "Editorial policies at every major journal forbid printing unverified results."},
            {"label": "C", "text": "Many compounds initially fail one of the required reviews."},
            {"label": "D", "text": "Compound Y has been thoroughly retested elsewhere."},
            {"label": "E", "text": "Researchers prefer rigorous independent verification."},
        ],
    }


def test_lexical_leak_flags_overlap_on_argument_qtype():
    v = generation.lexical_leak_ok(_leakish_strengthen_cand(), q_type="Strengthen")
    assert v["ok"] is False
    assert v["ratio"] > v["threshold"]


def test_lexical_leak_passes_a_clean_strengthen_candidate():
    v = generation.lexical_leak_ok(_clean_strengthen_cand(), q_type="Strengthen")
    assert v["ok"] is True


def test_lexical_leak_skips_paraphrase_qtypes():
    # An Inference candidate that quotes the stem should NOT be rejected by
    # the leak heuristic — paraphrase is the norm for the type.
    v = generation.lexical_leak_ok(_leakish_strengthen_cand(), q_type="Inference")
    assert v.get("ok") is True
    assert v.get("skipped") is True


def test_lexical_leak_skipped_when_q_type_missing():
    # No q_type signal => skip rather than risk a false positive.
    v = generation.lexical_leak_ok(_leakish_strengthen_cand(), q_type=None)
    assert v["ok"] is True
    assert v["skipped"] is True


def test_lexical_leak_skipped_for_rc():
    cand = _leakish_strengthen_cand()
    cand["passage"] = "Some RC passage text " * 30
    v = generation.lexical_leak_ok(cand, q_type="Strengthen")
    assert v["ok"] is True
    assert v["skipped"] is True


# --- 1.6 training-corpus flag propagation ----------------------------------
def test_dataset_import_flags_questions_as_training_eligible(db_session):
    res = run_import(
        db_session, "tasksource-lsat-lr",
        rows_iter=iter(list(read_jsonl(FIXTURES / "tasksource-lsat-lr.jsonl"))),
        training_eligible=True,
        training_notes="curated LR sample",
    )
    assert res.inserted == 2
    # Only check the rows we just imported — the seed bank includes 13 sample
    # rows that are deliberately not training-eligible.
    qs = db_session.exec(
        select(Question).where(Question.training_notes == "curated LR sample")
    ).all()
    assert len(qs) == 2
    assert all(q.training_eligible is True for q in qs)
    assert all(q.training_role == "both" for q in qs)


def test_dataset_import_defaults_to_not_training_eligible(db_session):
    run_import(
        db_session, "tasksource-lsat-lr",
        rows_iter=iter(list(read_jsonl(FIXTURES / "tasksource-lsat-lr.jsonl"))),
    )
    qs = db_session.exec(
        select(Question).where(Question.source == QuestionSource.research)
    ).all()
    assert qs and all(q.training_eligible in (False, 0, None) for q in qs)


def test_pdf_commit_propagates_training_flag_with_per_question_override(db_session):
    # Build a minimal parsed structure the way the wizard would.
    parsed = {
        "name": "Test Imported PT (training flag)",
        "sections": [
            {
                "type": "LR",
                "time_limit_sec": 2100,
                "passages": [],
                "questions": [
                    # Page-level training-eligible applies by default.
                    {
                        "stem": "A short stem of acceptable length for the gate." * 2,
                        "prompt": "Which one of the following must be true?",
                        "correct_answer": "B",
                        "q_type": "Inference",
                        "difficulty": 3,
                        "choices": [
                            {"label": l, "text": f"choice text {l} content"}
                            for l in "ABCDE"
                        ],
                    },
                    # Explicit override: this noisy item opts out individually.
                    {
                        "stem": "Another stem ample length for testing the gate." * 2,
                        "prompt": "Which one of the following most strengthens?",
                        "correct_answer": "A",
                        "q_type": "Strengthen",
                        "difficulty": 3,
                        "choices": [
                            {"label": l, "text": f"choice text {l} content"}
                            for l in "ABCDE"
                        ],
                        "training_eligible": False,
                    },
                ],
            }
        ],
    }

    pt_id = import_pdf.commit_structure(
        db_session, parsed, source="sample",
        training_eligible=True, training_notes="PT89 own copy",
    )
    qs = db_session.exec(
        select(Question)
        .join(Section)
        .where(Section.preptest_id == pt_id)
        .order_by(Question.id)
    ).all()
    assert len(qs) == 2
    assert qs[0].training_eligible is True
    assert qs[0].training_role == "both"
    assert qs[0].training_notes == "PT89 own copy"
    # Per-question override flips the second item off without touching the
    # PrepTest-level flag.
    assert qs[1].training_eligible is False
