"""MCP tools (C6), tag-review queue (B6), dataset schema validation (D5)."""
from __future__ import annotations

from pathlib import Path

from sqlmodel import Session, select

from app import import_dataset as imp
from app import mcp_server, tagging
from app.db import engine
from app.import_dataset import import_dataset as run_import, read_jsonl
from app.models import AnswerChoice, Question, QuestionSource

FIXTURES = Path(__file__).parent / "fixtures"


# --- C6: MCP read-only tools -----------------------------------------------
def test_mcp_tools_return_read_only_data(db_session):
    assert "predicted_score" in mcp_server.tool_dashboard()
    assert isinstance(mcp_server.tool_by_type(), list)
    assert isinstance(mcp_server.tool_mastery(), list)
    assert "gap" in mcp_server.tool_blind_review_gap()
    assert mcp_server.tool_bank_stats()["total"] >= 13
    assert "available" in mcp_server.tool_coach()
    assert {"get_dashboard", "get_bank_stats", "get_coach"} <= set(mcp_server.TOOLS)


def test_mcp_build_server_registers_tools():
    server = mcp_server.build_server()
    assert server is not None


# --- B6: tag confidence + review queue -------------------------------------
def test_batch_tag_records_confidence(db_session):
    run_import(db_session, "agieval-lsat-lr",
               rows_iter=iter(list(read_jsonl(FIXTURES / "agieval-lsat-lr.jsonl"))))
    tagging.batch_tag(db_session, limit=10,
                      model_call=lambda p: '{"q_type":"Weaken","difficulty":2}')
    research = db_session.exec(
        select(Question).where(Question.source == QuestionSource.research)
    ).all()
    assert research
    assert all(q.tag_confidence in ("high", "medium", "low") for q in research)


def test_tag_review_lists_low_confidence(client):
    with Session(engine) as s:
        q = Question(stem="x", prompt="p", correct_answer="A", q_type="Inference",
                     source=QuestionSource.research)
        s.add(q)
        s.commit()
        s.refresh(q)
        for lbl in "ABCDE":
            s.add(AnswerChoice(question_id=q.id, label=lbl, text=f"c{lbl}",
                               is_correct=(lbl == "A")))
        s.commit()
        qid = q.id
    rows = client.get("/api/bank/tag-review").json()
    assert any(r["id"] == qid for r in rows)


# --- D5: schema-drift validation -------------------------------------------
def test_validate_rows_detects_schema_drift():
    good = [{"context": "c", "question": "q", "answers": ["a", "b"], "label": 0}]
    assert imp.validate_rows("tasksource-lsat-rc", iter(good))["schema_ok"] is True

    drifted = [{"context": "c", "question": "q"}]  # missing answers + label
    res = imp.validate_rows("tasksource-lsat-rc", iter(drifted))
    assert res["schema_ok"] is False
    assert "answers" in res["missing_fields"] and "label" in res["missing_fields"]


def test_sources_endpoint_exposes_license_and_fields(client):
    rows = client.get("/api/bank/sources").json()
    ts = next(x for x in rows if x["key"] == "tasksource-lsat-rc")
    assert ts["license"] == "CC-BY-4.0"
    assert "answers" in ts["expected_fields"]
