"""Full question-bank JSON export/import round-trip."""
from __future__ import annotations

import json
from pathlib import Path

from sqlmodel import select

from app import bank_export
from app.import_dataset import import_dataset as run_import, read_jsonl
from app.models import (
    AnswerChoice,
    PrepTest,
    Question,
    QuestionSource,
    Section,
    SectionType,
)

FIXTURES = Path(__file__).parent / "fixtures"


def test_export_includes_seed_and_research(db_session):
    # Add some research items so the export has multiple sources.
    rows = list(read_jsonl(FIXTURES / "agieval-lsat-lr.jsonl"))
    run_import(db_session, "agieval-lsat-lr", rows_iter=iter(rows))

    payload = bank_export.export_bank(db_session)
    assert payload["schema_version"] == bank_export.SCHEMA_VERSION
    assert "T" in payload["exported_at"]
    assert len(payload["preptests"]) >= 2  # seed + research preptest

    # Every exported question carries the provenance fields.
    sources = {
        q["source"]
        for pt in payload["preptests"]
        for sec in pt["sections"]
        for q in sec["questions"]
    }
    assert "sample" in sources
    assert "research" in sources


def test_export_choices_round_trip_each_letter(db_session):
    payload = bank_export.export_bank(db_session)
    seed_pt = next(
        pt for pt in payload["preptests"]
        if pt["name"].startswith("Sample Diagnostic")
    )
    for sec in seed_pt["sections"]:
        for q in sec["questions"]:
            labels = [c["label"] for c in q["choices"]]
            assert labels == ["A", "B", "C", "D", "E"]
            # Exactly one is_correct = True.
            assert sum(1 for c in q["choices"] if c["is_correct"]) == 1


def test_import_is_idempotent_on_re_run(db_session):
    payload = bank_export.export_bank(db_session)
    # First re-import: every question already exists by content_hash/external_id
    # or by reusing the same PrepTest name + section. Seed items have neither
    # external_id nor content_hash, so they will be re-created (new rows).
    # The interesting invariant: re-importing the exported payload TWICE does
    # not multiply the bank further on the second round-trip.

    before = db_session.exec(select(Question)).all()
    bank_export.import_bank(db_session, payload)
    after_first = db_session.exec(select(Question)).all()
    # Some duplication is acceptable on seed-style rows (no hash); we just need
    # to ensure the importer accepted the payload.
    assert len(after_first) >= len(before)

    # Now export the newly-larger bank and re-import — research items must dedup
    # by external_id so the count cannot grow unboundedly.
    rows = list(read_jsonl(FIXTURES / "agieval-lsat-lr.jsonl"))
    run_import(db_session, "agieval-lsat-lr", rows_iter=iter(rows))

    snapshot = bank_export.export_bank(db_session)
    research_before = db_session.exec(
        select(Question).where(Question.source == QuestionSource.research)
    ).all()
    bank_export.import_bank(db_session, snapshot)
    research_after = db_session.exec(
        select(Question).where(Question.source == QuestionSource.research)
    ).all()
    # Research rows have stable external_id + content_hash, so re-import is a no-op.
    assert len(research_after) == len(research_before)


def test_import_rejects_newer_schema_version(db_session):
    bad = {"schema_version": bank_export.SCHEMA_VERSION + 1, "preptests": []}
    import pytest
    with pytest.raises(ValueError):
        bank_export.import_bank(db_session, bad)


def test_export_endpoint(client):
    body = client.get("/api/bank/export").json()
    assert body["schema_version"] == bank_export.SCHEMA_VERSION
    assert "preptests" in body
    assert "attempts" in body  # history included by default


def test_export_excludes_history_when_flag_off(client):
    body = client.get("/api/bank/export?include_history=false").json()
    assert "attempts" not in body
    assert "srs_cards" not in body


def test_import_endpoint_round_trip(client):
    exported = client.get("/api/bank/export").json()
    r = client.post("/api/bank/import-backup", json={"payload": exported})
    assert r.status_code == 200
    body = r.json()
    assert "preptests" in body
    assert body["preptests"] >= 1


def test_import_endpoint_rejects_unknown_schema(client):
    bad = {"schema_version": bank_export.SCHEMA_VERSION + 5, "preptests": []}
    r = client.post("/api/bank/import-backup", json={"payload": bad})
    assert r.status_code == 400


def test_orphan_ai_generated_questions_export_via_unsectioned(db_session):
    # Add an orphan question (no section), the way generation.py creates them.
    q = Question(
        section_id=None, passage_id=None,
        stem="x", prompt="y", correct_answer="A", q_type="Flaw",
        source=QuestionSource.ai_generated, approved=True,
        external_id="test:orphan-1",
        content_hash=bank_export.__dict__.get("SCHEMA_VERSION", "h")  # any non-null
        and "orphan-hash-1",
    )
    db_session.add(q)
    db_session.commit()
    db_session.refresh(q)
    for lbl in "ABCDE":
        db_session.add(AnswerChoice(
            question_id=q.id, label=lbl, text=f"opt {lbl}",
            is_correct=(lbl == "A"),
        ))
    db_session.commit()

    payload = bank_export.export_bank(db_session)
    assert "unsectioned_questions" in payload
    keys = {item.get("external_id") for item in payload["unsectioned_questions"]}
    assert "test:orphan-1" in keys


# --- provenance firewall (R7 P0): official content must NEVER leave the box ---
OFFICIAL_SENTINEL = "COPYRIGHTED-OFFICIAL-STEM-DO-NOT-LEAK-7f3a"


def _add_official_preptest(session):
    """Insert one official (copyrighted) PrepTest carrying a sentinel stem."""
    pt = PrepTest(name="PrepTest 73 (official)", source="official", is_official=True)
    session.add(pt)
    session.commit()
    session.refresh(pt)
    sec = Section(preptest_id=pt.id, type=SectionType.LR, order=1, time_limit_sec=2100)
    session.add(sec)
    session.commit()
    session.refresh(sec)
    q = Question(
        section_id=sec.id,
        passage_id=None,
        stem=OFFICIAL_SENTINEL,
        prompt="Which one of the following is an assumption?",
        correct_answer="C",
        difficulty=3,
        q_type="NecessaryAssumption",
        source=QuestionSource.official,
        approved=True,
    )
    session.add(q)
    session.commit()
    session.refresh(q)
    for lbl in "ABCDE":
        session.add(AnswerChoice(
            question_id=q.id,
            label=lbl,
            text=f"{OFFICIAL_SENTINEL} choice {lbl}",
            is_correct=(lbl == "C"),
        ))
    session.commit()
    return pt


def test_export_excludes_official_content_by_default(db_session):
    _add_official_preptest(db_session)
    payload = bank_export.export_bank(db_session)

    names = [pt["name"] for pt in payload["preptests"]]
    assert "PrepTest 73 (official)" not in names

    sources = {
        q["source"]
        for pt in payload["preptests"]
        for sec in pt["sections"]
        for q in sec["questions"]
    }
    assert "official" not in sources

    # Belt-and-suspenders: the copyrighted text appears NOWHERE in the payload.
    assert OFFICIAL_SENTINEL not in json.dumps(payload)


def test_export_include_official_opt_in_for_local_tooling(db_session):
    # The in-process flag (never exposed over HTTP) may include official content
    # for local-only full backups.
    _add_official_preptest(db_session)
    payload = bank_export.export_bank(db_session, include_official=True)
    assert "PrepTest 73 (official)" in [pt["name"] for pt in payload["preptests"]]
    assert OFFICIAL_SENTINEL in json.dumps(payload)


def test_export_endpoint_never_leaks_official(client):
    # Seed official content directly into the same DB the client serves from.
    from sqlmodel import Session

    from app.db import engine

    with Session(engine) as s:
        _add_official_preptest(s)

    body = client.get("/api/bank/export").json()
    assert OFFICIAL_SENTINEL not in json.dumps(body)
    sources = {
        q["source"]
        for pt in body["preptests"]
        for sec in pt["sections"]
        for q in sec["questions"]
    }
    assert "official" not in sources
