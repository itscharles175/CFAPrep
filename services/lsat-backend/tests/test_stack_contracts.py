"""W1-6 — contract tests for provenance immutability and session list aggregation."""
from __future__ import annotations

from sqlmodel import select

from app.models import Attempt, AttemptMode, Question, QuestionSource, StudySession


def test_question_source_immutable_trigger(db_session):
    q = Question(
        stem="s",
        prompt="p",
        correct_answer="A",
        q_type="Inference",
        source=QuestionSource.official,
    )
    db_session.add(q)
    db_session.commit()
    db_session.refresh(q)

    q.source = QuestionSource.sample
    try:
        db_session.commit()
        assert False, "expected provenance trigger to abort source change"
    except Exception as exc:
        db_session.rollback()
        assert "immutable" in str(exc).lower() or "ABORT" in str(exc)


def test_list_sessions_uses_sql_aggregation(client, db_session):
    s = StudySession(type="section")
    db_session.add(s)
    db_session.commit()
    db_session.refresh(s)

    q_off = Question(
        stem="o",
        prompt="p",
        correct_answer="A",
        q_type="Inference",
        source=QuestionSource.official,
    )
    q_samp = Question(
        stem="x",
        prompt="p",
        correct_answer="B",
        q_type="Inference",
        source=QuestionSource.sample,
    )
    db_session.add(q_off)
    db_session.add(q_samp)
    db_session.commit()
    db_session.refresh(q_off)
    db_session.refresh(q_samp)

    db_session.add(
        Attempt(
            session_id=s.id,
            question_id=q_off.id,
            mode=AttemptMode.timed,
            chosen_answer="A",
            is_correct=True,
        )
    )
    db_session.add(
        Attempt(
            session_id=s.id,
            question_id=q_samp.id,
            mode=AttemptMode.timed,
            chosen_answer="B",
            is_correct=True,
        )
    )
    db_session.add(
        Attempt(
            session_id=s.id,
            question_id=q_off.id,
            mode=AttemptMode.timed,
            chosen_answer="B",
            br_answer="A",
            br_correct=True,
        )
    )
    db_session.commit()

    r = client.get("/api/sessions")
    assert r.status_code == 200
    row = next(x for x in r.json() if x["id"] == s.id)
    assert row["question_count"] == 3
    assert row["br_accuracy"] == 1.0
    assert row["official_only_score"] is not None
