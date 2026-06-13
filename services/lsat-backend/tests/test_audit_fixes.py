"""Regression tests for the cross-stack audit remediation.

Each test locks a specific fix so the bug it addresses can't silently return.
Faked HTTP throughout — none of these need a live model server.
"""
from __future__ import annotations

import json

import httpx
import pytest
from sqlalchemy import text

from app import config  # noqa: F401  (kept for parity / future use)


# --- C1: SQLite WAL + busy_timeout (two-writer "database is locked") --------
def test_sqlite_pragmas_wal_and_busy_timeout():
    from app.db import engine

    with engine.connect() as conn:
        journal = conn.exec_driver_sql("PRAGMA journal_mode").fetchone()[0]
        busy = conn.exec_driver_sql("PRAGMA busy_timeout").fetchone()[0]
    assert str(journal).lower() == "wal"
    assert int(busy) >= 1  # non-zero => a writer waits instead of erroring instantly


# --- Provenance: m012 insert-side source guard ------------------------------
def test_source_insert_trigger_rejects_unknown_and_null(db_session):
    # RAISE(ABORT) in the trigger surfaces as a constraint (IntegrityError) via
    # sqlite3; accept OperationalError too for robustness across drivers.
    from sqlalchemy.exc import IntegrityError, OperationalError

    base = (
        "INSERT INTO question (stem, prompt, correct_answer, q_type, source, "
        "created_at) VALUES ('s', 'p', 'A', 'Weaken', {src}, '2026-01-01T00:00:00')"
    )
    for src in ("'bogus'", "NULL"):
        with pytest.raises((IntegrityError, OperationalError)):
            db_session.execute(text(base.format(src=src)))
        db_session.rollback()


# --- Provenance: passages firewalled by referencing-question provenance -----
def test_export_excludes_passages_referenced_only_by_official(db_session):
    from app import bank_export
    from app.models import (Passage, PrepTest, Question, QuestionSource,
                            Section, SectionType)

    pt = PrepTest(name="Mixed", source="sample", is_official=False)
    db_session.add(pt)
    db_session.flush()
    sec = Section(preptest_id=pt.id, type=SectionType.RC, order=0)
    db_session.add(sec)
    db_session.flush()
    p_off = Passage(section_id=sec.id, text="OFFICIAL_SECRET_PASSAGE", type="single")
    p_ok = Passage(section_id=sec.id, text="SHAREABLE_PASSAGE", type="single")
    db_session.add(p_off)
    db_session.add(p_ok)
    db_session.flush()
    db_session.add(Question(
        section_id=sec.id, passage_id=p_off.id, stem="x", prompt="p",
        correct_answer="A", q_type="Inference", source=QuestionSource.official))
    db_session.add(Question(
        section_id=sec.id, passage_id=p_ok.id, stem="y", prompt="p",
        correct_answer="B", q_type="Inference",
        source=QuestionSource.ai_generated, approved=True))
    db_session.commit()

    blob = json.dumps(bank_export.export_bank(db_session))
    # The official question is stripped AND its passage (referenced only by it)
    # must not leak via this non-official PrepTest.
    assert "OFFICIAL_SECRET_PASSAGE" not in blob
    assert "SHAREABLE_PASSAGE" in blob


# --- Import: reconcile must not over-count a short/misaligned key ------------
def test_reconcile_key_too_short_does_not_overcount():
    from app import import_pdf

    parsed = {"name": "T", "sections": [{
        "type": "LR", "passages": [],
        "questions": [
            {"prompt": f"q{i}", "correct_answer": ans,
             "choices": [{"label": x, "text": x} for x in "ABCDE"]}
            for i, ans in enumerate(["A", "B", "C"])
        ],
    }]}
    r = import_pdf.reconcile_answer_key(parsed, ["A"])  # key covers only q0
    assert r["total_questions"] == 3
    assert r["covered_questions"] == 1
    assert r["uncovered_questions"] == 2
    assert r["key_too_short"] is True
    assert r["match_count"] == 1   # only q0 validated+agreed (was 3 before the fix)
    assert r["mismatches"] == []


# --- Domain: an inverted/non-monotonic scale curve is rejected --------------
def test_parse_scale_table_rejects_inverted_curve():
    from app import scoring

    with pytest.raises(ValueError):
        scoring.parse_scale_table({"10": 170, "20": 150})
    assert scoring.parse_scale_table({"10": 150, "20": 170}) == [(10, 150), (20, 170)]


# --- Gate: structural validator fails CLOSED when the critic call fails ------
def test_validate_structure_fails_closed_on_critic_error(monkeypatch):
    from app import gen_validators
    from app.llm.base import LLMError

    def boom(cand, critic):
        raise LLMError("critic/model down")

    monkeypatch.setitem(gen_validators._VALIDATORS, "Weaken", boom)
    v = gen_validators.validate_structure("Weaken", {}, lambda p: "")
    assert v["ok"] is False
    assert v["reason"] == "critic_unavailable"


def test_validate_structure_passes_on_validator_logic_bug(monkeypatch):
    from app import gen_validators

    def buggy(cand, critic):
        raise KeyError("typo in validator")

    monkeypatch.setitem(gen_validators._VALIDATORS, "Weaken", buggy)
    # A validator LOGIC bug must not quarantine an entire run (stays a soft pass).
    assert gen_validators.validate_structure("Weaken", {}, lambda p: "")["ok"] is True


# --- Settings: domain validation on the non-HTTP (startup/internal) path -----
def test_settings_store_rejects_out_of_domain(monkeypatch):
    from app import config, settings_store

    monkeypatch.setattr(config, "SRS_DESIRED_RETENTION", 0.9)
    monkeypatch.setattr(config, "LOCAL_PROVIDER", "ollama")

    assert settings_store._coerce("desired_retention", "nan") == 0.9   # non-finite
    assert settings_store._coerce("desired_retention", "inf") == 0.9
    assert settings_store._coerce("desired_retention", "1.5") == 0.9   # out of (0,1)
    assert settings_store._coerce("desired_retention", "0.85") == 0.85  # valid
    assert settings_store._coerce("local_provider", "vllm") == "ollama"  # unknown
    assert settings_store._coerce("local_provider", "lmstudio") == "lmstudio"


# --- C2: cloud generate maps a JSON-Schema dict to tool-use ------------------
def test_cloud_generate_schema_uses_tool_use(monkeypatch):
    from app.llm import cloud

    captured: dict = {}
    # Don't touch the metrics DB in this transport-only test.
    monkeypatch.setattr(cloud.observability, "persist_cloud_usage", lambda *a, **k: 0.0)
    monkeypatch.setattr(cloud.observability, "record_cloud_tokens", lambda *a, **k: None)

    class _Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {
                "content": [{"type": "tool_use",
                             "input": {"stem": "x", "correct_answer": "A"}}],
                "usage": {"input_tokens": 1, "output_tokens": 1},
            }

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, headers=None, json=None):
            captured["body"] = json
            return _Resp()

    monkeypatch.setattr(cloud.httpx, "Client", _FakeClient)
    prov = cloud.AnthropicProvider("sk-test")
    schema = {"type": "object", "properties": {"stem": {"type": "string"}}}
    out = prov.generate("m", "p", format=schema)

    body = captured["body"]
    assert body["tool_choice"]["name"] == "respond_schema"
    assert body["tools"][0]["input_schema"] == schema
    # the structured object is handed back as JSON text for the caller's parser
    assert json.loads(out)["correct_answer"] == "A"


def test_cloud_generate_raises_llmerror_on_terminal_error(monkeypatch):
    from app.llm import cloud
    from app.llm.base import LLMError

    class _Resp:
        def raise_for_status(self):
            raise httpx.HTTPStatusError(
                "bad request",
                request=httpx.Request("POST", "http://x"),
                response=httpx.Response(400),
            )

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, headers=None, json=None):
            return _Resp()

    monkeypatch.setattr(cloud.httpx, "Client", _FakeClient)
    prov = cloud.AnthropicProvider("sk-test")
    with pytest.raises(LLMError):
        prov.generate("m", "p")


# --- Cost: budget fails CLOSED when the spend read errors --------------------
def test_cloud_within_budget_fails_closed_on_read_error(monkeypatch):
    import app.llm as llm
    from app import config, observability

    def boom(*a, **k):
        raise RuntimeError("ledger unavailable")

    monkeypatch.setattr(observability, "month_to_date_spend_usd", boom)
    monkeypatch.setattr(config, "CLOUD_MONTHLY_BUDGET_USD", 10.0)
    assert llm._cloud_within_budget() is False   # budget set + read fails => refuse
    monkeypatch.setattr(config, "CLOUD_MONTHLY_BUDGET_USD", 0.0)
    assert llm._cloud_within_budget() is True    # no budget => always allowed


# --- Domain: exam scoring excludes soft-deleted (tombstoned) questions -------
def test_exam_results_excludes_soft_deleted(db_session):
    from datetime import datetime, timezone

    from app import exams
    from app.models import (Attempt, AttemptMode, PrepTest, Question,
                            QuestionSource, Section, SectionType, StudySession)

    pt = PrepTest(name="Ex", source="official", is_official=True)
    db_session.add(pt)
    db_session.flush()
    sec = Section(preptest_id=pt.id, type=SectionType.LR, order=0)
    db_session.add(sec)
    db_session.flush()
    q1 = Question(section_id=sec.id, stem="a", prompt="p", correct_answer="A",
                  q_type="Weaken", source=QuestionSource.official)
    q2 = Question(section_id=sec.id, stem="b", prompt="p", correct_answer="B",
                  q_type="Weaken", source=QuestionSource.official)
    db_session.add(q1)
    db_session.add(q2)
    db_session.flush()
    s = StudySession(type="full_exam")
    db_session.add(s)
    db_session.flush()
    for q in (q1, q2):
        db_session.add(Attempt(
            question_id=q.id, session_id=s.id, mode=AttemptMode.drill,
            chosen_answer=q.correct_answer, is_correct=True))
    db_session.commit()

    assert exams.exam_results(db_session, s.id)["official_total"] == 2
    q2.deleted_at = datetime.now(timezone.utc)
    db_session.add(q2)
    db_session.commit()
    assert exams.exam_results(db_session, s.id)["official_total"] == 1
