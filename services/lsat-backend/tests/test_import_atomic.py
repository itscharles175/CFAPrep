"""B4a — portable bank import atomicity + official-source clamp.

Covers two guarantees added to ``bank_export.import_bank`` / the
``/api/bank/import-backup`` route:

1. ATOMIC import (Codex P1 #3): the whole import is one transaction. A malformed
   LATER record must roll back EVERY row written by the earlier valid records —
   no partial PrepTests / sections / passages / questions / answer choices.
2. OFFICIAL clamp (swarm #46): the over-the-wire import path must never mint
   ``source='official'`` rows from a crafted payload; an incoming ``official``
   is demoted to a non-official source (``sample``).
"""
from __future__ import annotations

import pytest
from sqlmodel import func, select

from app import bank_export
from app.models import (
    AnswerChoice,
    Passage,
    PrepTest,
    Question,
    QuestionSource,
    Section,
)

ATOMIC_PT_NAME = "B4a Atomic PrepTest"
GOOD_EXT = "b4a:atomic-good-1"
BAD_EXT = "b4a:atomic-bad-2"
GOOD_STEM = "B4A-ATOMIC-GOOD-STEM-sentinel"


def _choices(correct: str = "A") -> list[dict]:
    return [
        {"label": lbl, "text": f"opt {lbl}", "is_correct": (lbl == correct)}
        for lbl in "ABCDE"
    ]


def _count(session, model) -> int:
    return session.exec(select(func.count()).select_from(model)).one()


def _malformed_payload() -> dict:
    """One valid PrepTest+section whose FIRST question is fine and SECOND is
    malformed (difficulty that cannot be coerced to int -> ValueError mid-import).

    The good question (and its parent PrepTest/section/passage/choices) flush to
    the DB before the bad one fails, so a non-atomic importer would leave them
    behind. An atomic importer rolls them all back.
    """
    return {
        "schema_version": bank_export.SCHEMA_VERSION,
        "preptests": [
            {
                "name": ATOMIC_PT_NAME,
                "source": "imported",
                "is_official": False,
                "sections": [
                    {
                        "type": "LR",
                        "order": 0,
                        "time_limit_sec": 2100,
                        "passages": [],
                        "questions": [
                            {
                                "stem": GOOD_STEM,
                                "prompt": "Which one follows?",
                                "correct_answer": "A",
                                "difficulty": 3,
                                "q_type": "Inference",
                                "source": "sample",
                                "external_id": GOOD_EXT,
                                "content_hash": "b4a-good-hash-1",
                                "choices": _choices("A"),
                            },
                            {
                                # Malformed LATER record: int("NOT-A-NUMBER")
                                # raises inside _commit_question.
                                "stem": "later malformed question",
                                "prompt": "boom",
                                "correct_answer": "B",
                                "difficulty": "NOT-A-NUMBER",
                                "q_type": "Flaw",
                                "source": "sample",
                                "external_id": BAD_EXT,
                                "content_hash": "b4a-bad-hash-2",
                                "choices": _choices("B"),
                            },
                        ],
                    }
                ],
            }
        ],
    }


def test_malformed_later_record_rolls_back_everything(db_session):
    payload = _malformed_payload()

    before = {
        "preptests": _count(db_session, PrepTest),
        "sections": _count(db_session, Section),
        "passages": _count(db_session, Passage),
        "questions": _count(db_session, Question),
        "choices": _count(db_session, AnswerChoice),
    }

    # The malformed record must abort the whole import.
    with pytest.raises(Exception):
        bank_export.import_bank(db_session, payload)

    # Nothing partial survived: counts are identical to before the import.
    after = {
        "preptests": _count(db_session, PrepTest),
        "sections": _count(db_session, Section),
        "passages": _count(db_session, Passage),
        "questions": _count(db_session, Question),
        "choices": _count(db_session, AnswerChoice),
    }
    assert after == before, f"partial rows left behind: before={before} after={after}"

    # And specifically: the early (valid) rows from THIS import are gone.
    assert db_session.exec(
        select(PrepTest).where(PrepTest.name == ATOMIC_PT_NAME)
    ).first() is None
    assert db_session.exec(
        select(Question).where(Question.external_id == GOOD_EXT)
    ).first() is None
    assert db_session.exec(
        select(Question).where(Question.stem == GOOD_STEM)
    ).first() is None
    assert db_session.exec(
        select(Question).where(Question.external_id == BAD_EXT)
    ).first() is None


def _route_failure_payload() -> dict:
    """Valid first question, then a LATER question whose ``choices`` hold a
    non-dict element -> ``AttributeError`` inside _commit_question. Unlike the
    difficulty ValueError, this is NOT a ValueError, so it exercises the route's
    broad ``except Exception`` -> 500 / ImportRun 'failed' branch (the ValueError
    branch is the 400 / 'rolled_back' schema-rejection path, covered elsewhere)."""
    payload = _malformed_payload()
    questions = payload["preptests"][0]["sections"][0]["questions"]
    # First question stays valid; replace the second's choices with junk.
    questions[1]["difficulty"] = 3  # don't trip the ValueError path first
    questions[1]["choices"] = ["not-a-dict-choice"]
    return payload


def test_import_backup_route_marks_run_failed_not_committing(client):
    """The /api/bank/import-backup route catches the broad failure, rolls back,
    and records the ImportRun as failed (never stuck in 'committing')."""
    payload = _route_failure_payload()
    r = client.post(
        "/api/bank/import-backup",
        json={"payload": payload, "force_commit": True},
    )
    assert r.status_code == 500

    # The ledger row exists and is terminal (failed), with the error captured.
    runs = client.get("/api/import/runs").json()["runs"]
    portable = [
        run for run in runs
        if run.get("source") == "portable_json_export"
    ]
    assert portable, "expected an ImportRun for the portable import attempt"
    latest = portable[0]  # /runs is ordered newest-first
    assert latest["status"] == "failed"
    assert latest["status"] != "committing"
    assert latest.get("error")

    # No partial rows from the aborted import leaked into the served DB.
    bank = client.get("/api/bank/questions?q=" + GOOD_STEM).json()
    assert bank["total"] == 0


# --- official clamp (swarm #46) --------------------------------------------
def test_imported_official_source_is_clamped_to_non_official(db_session):
    """A payload claiming source='official' must NOT create an official row on
    the over-the-wire import path (reserve 'official' for in-process import)."""
    payload = {
        "schema_version": bank_export.SCHEMA_VERSION,
        "preptests": [
            {
                "name": "B4a Clamp PrepTest",
                "source": "imported",
                "is_official": False,
                "sections": [
                    {
                        "type": "LR",
                        "order": 0,
                        "time_limit_sec": 2100,
                        "passages": [],
                        "questions": [
                            {
                                "stem": "clamp me",
                                "prompt": "which assumption?",
                                "correct_answer": "C",
                                "difficulty": 3,
                                "q_type": "NecessaryAssumption",
                                # Crafted payload tries to inject official content.
                                "source": "official",
                                "external_id": "b4a:clamp-official-1",
                                "content_hash": "b4a-clamp-hash-1",
                                "choices": _choices("C"),
                            }
                        ],
                    }
                ],
            }
        ],
    }

    bank_export.import_bank(db_session, payload)

    q = db_session.exec(
        select(Question).where(Question.external_id == "b4a:clamp-official-1")
    ).first()
    assert q is not None, "the clamped question should still import"
    assert q.source != QuestionSource.official, "official must be clamped away"
    assert q.source == QuestionSource.sample

    # Belt-and-suspenders: the import path created ZERO official rows.
    official_rows = db_session.exec(
        select(func.count())
        .select_from(Question)
        .where(Question.source == QuestionSource.official)
    ).one()
    assert official_rows == 0


def test_clamp_helper_demotes_official_only():
    """``_clamp_import_source`` keeps every non-official source but demotes
    official (and falls back to sample for unknown / missing values)."""
    clamp = bank_export._clamp_import_source
    assert clamp("official") == QuestionSource.sample
    assert clamp(QuestionSource.official) == QuestionSource.sample
    assert clamp("sample") == QuestionSource.sample
    assert clamp("research") == QuestionSource.research
    assert clamp("reclor") == QuestionSource.reclor
    assert clamp("ai_generated") == QuestionSource.ai_generated
    assert clamp(None) == QuestionSource.sample
    assert clamp("not-a-real-source") == QuestionSource.sample
