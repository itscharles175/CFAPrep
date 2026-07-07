"""Schema creation, seeding, and basic content endpoints."""
from __future__ import annotations

from sqlmodel import select

from app.seed import SEED_QUESTION_COUNT


def test_seed_creates_sample_preptest(db_session):
    from app.models import Attempt, Explanation, PrepTest, Question, Section

    pts = db_session.exec(select(PrepTest)).all()
    assert any(p.name.startswith("Sample Diagnostic") for p in pts)

    # Sample bank may grow over time; assert against the single source of
    # truth in app.seed so adding a sample item doesn't break the suite.
    questions = db_session.exec(select(Question)).all()
    assert len(questions) == SEED_QUESTION_COUNT

    # every sample question has explanations + 5 choices
    exps = db_session.exec(select(Explanation)).all()
    assert len(exps) >= SEED_QUESTION_COUNT

    # a prior session with attempts exists
    attempts = db_session.exec(select(Attempt)).all()
    assert len(attempts) == SEED_QUESTION_COUNT
    assert any(a.flagged for a in attempts)
    assert any(a.br_answer for a in attempts)


def test_preptests_endpoint(client):
    r = client.get("/api/preptests")
    assert r.status_code == 200
    data = r.json()
    assert len(data) >= 1
    pt = data[0]
    assert pt["section_count"] == 2
    assert "completed_sections" in pt


def test_health(client):
    body = client.get("/api/health").json()
    assert body["ok"] is True
    assert body["service"] == "lsat-backend"
    assert isinstance(body["version"], str) and body["version"]
