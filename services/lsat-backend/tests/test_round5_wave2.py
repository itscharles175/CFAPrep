"""Round 5 wave 2: follow-up explain, per-choice SSE, error-log AI diag + CRUD,
hint, drill intent, quarantine triage."""
from __future__ import annotations

import json

from sqlmodel import Session, select

from app import ai
from app.routers import error_log as error_log_mod
from app.db import engine
from app.models import (
    AnswerChoice, Attempt, ErrorLogEntry, ErrorReason, GenJob, GenStatus,
    Question, QuestionSource, StudySession,
)
from app.routers.drills import parse_drill_intent


def _sse_events(text: str):
    out = []
    for line in text.splitlines():
        if line.startswith("data: "):
            out.append(json.loads(line[len("data: "):]))
    return out


# --- A1 / A4: follow-up explain + per-choice SSE ----------------------------
def test_explain_followup_streams_choices_and_does_not_persist(client, monkeypatch):
    async def fake_stream(stem, prompt, choices, correct, chosen, **kwargs):
        # follow-up should pass user_message through
        assert kwargs.get("user_message") == "why is A wrong?"
        for tok in ["Because ", "scope.\n", "A: out of scope\n", "B: correct\n"]:
            yield tok

    monkeypatch.setattr(ai, "stream_explanation", fake_stream)
    r = client.post("/api/ai/explain",
                    json={"question_id": 1, "chosen_answer": "A",
                          "user_message": "why is A wrong?"})
    assert r.status_code == 200
    events = _sse_events(r.text)
    choice_events = {e["choice"]: e["text"] for e in events if "choice" in e}
    assert choice_events.get("A") == "out of scope"
    assert choice_events.get("B") == "correct"
    done = [e for e in events if e.get("done")][0]
    assert done["cached"] is False
    assert done["explanation_id"] is None      # follow-ups are not persisted
    assert "A" in done["per_choice"]


def test_explain_cached_emits_per_choice_and_cached_flag(client):
    # q1 ships a seeded explanation -> cached path
    events = _sse_events(client.post("/api/ai/explain", json={"question_id": 1}).text)
    done = [e for e in events if e.get("done")][0]
    assert done["cached"] is True
    assert "per_choice" in done


# --- A6: error-log AI diagnosis --------------------------------------------
def test_generate_diagnosis_populates_field(db_session):
    s = StudySession(type="drill")
    db_session.add(s); db_session.commit(); db_session.refresh(s)
    a = Attempt(question_id=1, session_id=s.id, chosen_answer="B", is_correct=False)
    db_session.add(a); db_session.commit(); db_session.refresh(a)
    e = ErrorLogEntry(attempt_id=a.id, reason=ErrorReason.trap, user_note="fell for it")
    db_session.add(e); db_session.commit(); db_session.refresh(e)

    out = error_log_mod.generate_diagnosis(
        db_session, e.id,
        diagnoser=lambda stem, reason, note, chosen, correct: "Root cause: scope. Tip: pre-phrase.",
    )
    assert out == "Root cause: scope. Tip: pre-phrase."
    db_session.refresh(e)
    assert e.ai_diagnosis == "Root cause: scope. Tip: pre-phrase."


# --- H5 / D6: error-log edit + delete --------------------------------------
def test_error_log_patch_and_delete(client):
    sess = client.post("/api/sessions", json={"type": "drill"}).json()
    aid = client.post(f"/api/sessions/{sess['id']}/attempts",
                      json={"question_id": 1, "chosen_answer": "B"}).json()["attempt_id"]
    eid = client.post(f"/api/attempts/{aid}/error-log",
                      json={"reason": "trap", "note": "orig"}).json()["id"]

    assert client.patch(f"/api/error-log/{eid}", json={"note": "edited"}).json()["ok"] is True
    rows = client.get("/api/error-log").json()
    assert any(r["id"] == eid and r["note"] == "edited" for r in rows)

    assert client.delete(f"/api/error-log/{eid}").json()["ok"] is True
    rows2 = client.get("/api/error-log").json()
    assert all(r["id"] != eid for r in rows2)
    assert client.delete(f"/api/error-log/{eid}").status_code == 404


# --- A10: study-mode hint ---------------------------------------------------
def test_hint_study_mode(client, monkeypatch):
    async def fake_hint(stem, prompt, choices):
        return "Find the conclusion first."
    monkeypatch.setattr(ai, "hint", fake_hint)
    r = client.post("/api/ai/hint", json={"question_id": 1, "mode": "study"})
    assert r.status_code == 200
    assert r.json()["hint"] == "Find the conclusion first."


def test_hint_refused_outside_study_mode(client):
    r = client.post("/api/ai/hint", json={"question_id": 1, "mode": "timed"})
    assert r.status_code == 400


# --- A8: NL drill intent ----------------------------------------------------
def test_parse_drill_intent_phrases():
    cfg = parse_drill_intent("3 harder Parallel, official only")
    assert cfg["q_type"] == "Parallel"
    assert cfg["difficulty"] == 4
    assert cfg["count"] == 3
    assert cfg["source"] == "real"

    cfg2 = parse_drill_intent("10 untimed reading comprehension inference questions")
    assert cfg2["section_type"] == "RC"
    assert cfg2["timed"] is False


def test_drill_intent_endpoint(client):
    cfg = client.post("/api/drills/intent", json={"text": "5 easy weaken ai"}).json()
    assert cfg["q_type"] == "Weaken"
    assert cfg["difficulty"] == 2
    assert cfg["count"] == 5
    assert cfg["source"] == "ai"


# --- A11: quarantine triage -------------------------------------------------
def test_quarantine_triage(client):
    with Session(engine) as s:
        q = Question(stem="q", prompt="p", correct_answer="A", q_type="Flaw",
                     source=QuestionSource.ai_generated, quarantined=True, approved=False)
        s.add(q); s.commit(); s.refresh(q)
        for lbl in "ABCDE":
            s.add(AnswerChoice(question_id=q.id, label=lbl, text=f"c{lbl}", is_correct=(lbl == "A")))
        job = GenJob(q_type="Flaw", count=1, status=GenStatus.done,
                     validation_report={"candidates": [
                         {"question_id": q.id, "passed": False, "reason": "self_consistency",
                          "checks": {"structural": True, "self_consistency": "1/3"}}
                     ]})
        s.add(job); s.commit()
        qid = q.id

    triage = client.get(f"/api/gen/quarantine/{qid}/triage").json()
    assert triage["found"] is True
    assert triage["suggested_verdict"] == "reject"
    assert triage["reason"] == "self_consistency"
