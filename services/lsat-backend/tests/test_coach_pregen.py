"""Pre-generated explanations (B4) + scheduled coach snapshot (B5)."""
from __future__ import annotations

from sqlmodel import Session, select

from app import coach, pregenerate
from app.db import engine
from app.models import AnswerChoice, Explanation, Question, QuestionSource


def _unexplained_question() -> int:
    with Session(engine) as s:
        q = Question(stem="An argument with a subtle gap in its reasoning here.",
                     prompt="Which one of the following is an assumption?",
                     correct_answer="A", q_type="NecessaryAssumption",
                     source=QuestionSource.research)
        s.add(q)
        s.commit()
        s.refresh(q)
        for lbl in "ABCDE":
            s.add(AnswerChoice(question_id=q.id, label=lbl, text=f"choice {lbl}",
                               is_correct=(lbl == "A")))
        s.commit()
        return q.id


def test_pregenerate_creates_and_caches_explanation(db_session):
    qid = _unexplained_question()

    def fake_gen(stem, prompt, choices, correct, chosen=None, context_notes=None):
        return "Overall: A is right because it bridges the gap.\nA: correct\nB: trap"

    res = pregenerate.pregenerate_explanations(db_session, limit=50, generator=fake_gen)
    assert res["explained"] >= 1

    exp = db_session.exec(
        select(Explanation).where(Explanation.question_id == qid)
    ).first()
    assert exp is not None
    assert "bridges the gap" in exp.body
    assert exp.per_choice_json.get("A") == "correct"


def test_pregenerate_endpoint(client, monkeypatch):
    from app import ai
    monkeypatch.setattr(ai, "explain_sync",
                        lambda *a, **k: "Overall reason.\nA: yes\nB: no")
    _unexplained_question()
    r = client.post("/api/ai/pregenerate", json={"limit": 50})
    assert r.status_code == 200
    assert r.json()["explained"] >= 1


def test_coach_refresh_and_latest(db_session):
    snap = coach.refresh_snapshot(db_session, diagnoser=lambda summary: "Do X next.")
    assert snap.id is not None
    latest = coach.latest_snapshot(db_session)
    assert latest.id == snap.id
    # seed ships prior attempts -> by_type non-empty -> uses the diagnoser text
    assert latest.text == "Do X next."
    # R7 2.5: the recommendation is now GROUNDED + VARIED (drill/srs/analytics/
    # blind_review) instead of the old hardcoded "start_drill" — and uses the
    # action.type vocabulary the DockedCoach actually consumes. Shape preserved.
    rec = latest.recommendation_json
    assert set(rec) == {"label", "action"}
    assert set(rec["action"]) == {"type", "payload"}
    assert rec["action"]["type"] in {"drill", "srs", "analytics", "blind_review"}


def test_coach_maybe_refresh_respects_age(db_session):
    coach.refresh_snapshot(db_session, diagnoser=lambda s: "x")
    # fresh snapshot -> not stale -> no refresh
    assert coach.maybe_refresh(engine, max_age_s=10_000, diagnoser=lambda s: "y") is False
    # zero max age -> always stale -> refresh
    assert coach.maybe_refresh(engine, max_age_s=0, diagnoser=lambda s: "y") is True


def test_coach_endpoints(client, monkeypatch):
    from app import ai
    assert client.get("/api/ai/coach").json()["available"] is False
    monkeypatch.setattr(ai, "diagnose_sync", lambda summary: "Coach says drill Flaw.")
    r = client.post("/api/ai/coach/refresh")
    assert r.status_code == 200
    body = client.get("/api/ai/coach").json()
    assert body["available"] is True
    assert "drill" in body["text"].lower()
