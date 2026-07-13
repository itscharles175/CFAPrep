"""Round 5 wave 1: ?days filtering, enriched sessions, type analytics, progress, focus."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app import analytics
from app.models import (
    Attempt, AttemptMode, Question, QuestionSource, StudySession,
)


def _old_attempt(db_session, q_type="Method", days_ago=100):
    q = Question(stem="s", prompt="p", correct_answer="A", q_type=q_type,
                 source=QuestionSource.research, difficulty=3)
    db_session.add(q)
    db_session.commit()
    db_session.refresh(q)
    s = StudySession(type="drill")
    db_session.add(s)
    db_session.commit()
    db_session.refresh(s)
    a = Attempt(question_id=q.id, session_id=s.id, mode=AttemptMode.drill,
                chosen_answer="A", is_correct=True, time_ms=1000,
                created_at=datetime.now(timezone.utc) - timedelta(days=days_ago))
    db_session.add(a)
    db_session.commit()
    return q, s


def test_days_filter_excludes_old_attempts(db_session):
    _old_attempt(db_session, q_type="Method", days_ago=100)
    all_rows = analytics.by_type(db_session)
    win_rows = analytics.by_type(db_session, days=30)
    assert any(r["q_type"] == "Method" for r in all_rows)       # all-time sees it
    assert all(r["q_type"] != "Method" for r in win_rows)        # 30-day window excludes it


def test_dashboard_and_mastery_accept_days(db_session):
    d = analytics.dashboard(db_session, days=7)
    assert "predicted_score" in d
    m = analytics.mastery(db_session, days=7)
    assert isinstance(m, list)


def test_type_analytics_payload(db_session):
    out = analytics.type_analytics(db_session, "Weaken")
    assert out["q_type"] == "Weaken"
    for key in ("overall", "by_section", "gap", "traps", "recent_misses"):
        assert key in out
    assert 0.0 <= out["overall"]["accuracy"] <= 1.0


def test_focus_quality(db_session):
    # the seed ships a prior session with attempts
    sessions = db_session.exec(__import__("sqlmodel").select(StudySession)).all()
    sid = sessions[0].id
    fq = analytics.focus_quality(db_session, sid)
    assert "score" in fq and "components" in fq


def test_enriched_sessions_endpoint(client):
    rows = client.get("/api/sessions").json()
    assert rows
    r = rows[0]
    for key in ("duration_sec", "br_accuracy", "official_only_score", "question_count"):
        assert key in r


def test_preptest_progress_endpoint(client):
    pts = client.get("/api/preptests").json()
    pid = pts[0]["id"]
    prog = client.get(f"/api/preptests/{pid}/progress").json()
    assert prog["preptest_id"] == pid
    assert prog["sections"]
    s0 = prog["sections"][0]
    for key in ("section_id", "question_count", "attempted", "done", "accuracy"):
        assert key in s0


def test_analytics_endpoints_accept_days_and_new_routes(client):
    assert client.get("/api/analytics/dashboard?days=30").status_code == 200
    assert client.get("/api/analytics/by-type?source=all&days=30").status_code == 200
    assert client.get("/api/analytics/traps?days=30").status_code == 200
    assert client.get("/api/analytics/mastery?days=30").status_code == 200
    assert client.get("/api/analytics/type/Weaken").status_code == 200
    sid = client.get("/api/sessions").json()[0]["id"]
    assert client.get(f"/api/analytics/focus/{sid}").status_code == 200
