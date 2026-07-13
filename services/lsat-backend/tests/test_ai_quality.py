"""Wave-3 AI-quality loops: Q1 explanation feedback, Q2 generation analytics,
Q3 RAG drill selection, P3 embedding cache. All model calls are fakes."""
from __future__ import annotations

from sqlmodel import Session, select

from app.db import engine


# --- Q1: explanation feedback ----------------------------------------------
def _a_question_id() -> int:
    from app.models import Question
    with Session(engine) as s:
        return s.exec(select(Question)).first().id


def test_explain_feedback_and_quality(client):
    from app.models import Explanation
    qid = _a_question_id()

    # 👍 then seed a cached explanation, then 👎 (drops the cache to regenerate).
    r = client.post("/api/ai/explain/feedback", json={"question_id": qid, "helpful": True})
    assert r.status_code == 200 and r.json()["ok"] is True

    with Session(engine) as s:
        s.add(Explanation(question_id=qid, body="cached body"))
        s.commit()

    r = client.post("/api/ai/explain/feedback",
                    json={"question_id": qid, "helpful": False, "note": "unclear"})
    assert r.json()["will_regenerate"] is True
    with Session(engine) as s:
        assert s.exec(select(Explanation).where(Explanation.question_id == qid)).first() is None

    q = client.get("/api/ai/explanation-quality").json()
    assert q["total"] >= 2
    assert qid in q["low_rated_question_ids"]   # latest feedback was 👎


def test_explain_feedback_unknown_question(client):
    r = client.post("/api/ai/explain/feedback", json={"question_id": 999999, "helpful": True})
    assert r.status_code == 404


# --- Q2: generation-failure analytics --------------------------------------
def test_generation_quality_aggregates(db_session):
    from app import generation
    from app.models import GenJob, GenStatus

    db_session.add(GenJob(
        q_type="Weaken", count=3, status=GenStatus.done,
        validation_report={"candidates": [
            {"passed": True}, {"passed": False, "reason": "length_tell"},
            {"passed": False, "reason": "self_consistency"},
        ]},
    ))
    db_session.commit()

    q = generation.generation_quality(db_session)
    assert q["total_candidates"] == 3
    assert q["passed"] == 1 and q["quarantined"] == 2
    assert q["fail_reasons"]["length_tell"] == 1
    assert q["pass_rate"] == round(1 / 3, 4)
    assert q["by_type"]["Weaken"] == {"passed": 1, "failed": 2}


def test_generation_quality_endpoint(client):
    r = client.get("/api/gen/quality")
    assert r.status_code == 200 and "pass_rate" in r.json()


# --- P3: embedding cache ----------------------------------------------------
def test_vector_cache_invalidates_on_reembed(db_session):
    from app import embeddings
    from app.models import Question, QuestionSource

    embeddings.reset_cache()
    q = Question(stem="s", prompt="p", correct_answer="A", q_type="Weaken",
                 source=QuestionSource.sample)
    db_session.add(q)
    db_session.commit()
    db_session.refresh(q)

    embeddings.embed_question(db_session, q, embedder=lambda _t: [1.0, 0.0])
    assert embeddings._question_vectors(db_session)[q.id] == [1.0, 0.0]
    # re-embed: the upsert must invalidate the cache so the next read is fresh
    embeddings.embed_question(db_session, q, embedder=lambda _t: [0.0, 1.0])
    assert embeddings._question_vectors(db_session)[q.id] == [0.0, 1.0]


# --- Q3: RAG drill selection ------------------------------------------------
def _mk_question(s: Session, i: int):
    from app.models import AnswerChoice, Question, QuestionSource
    q = Question(stem=f"stem {i}", prompt="p", correct_answer="A", q_type="Weaken",
                 source=QuestionSource.sample, difficulty=3)
    s.add(q)
    s.commit()
    s.refresh(q)
    s.add(AnswerChoice(question_id=q.id, label="A", text="a"))
    s.commit()
    return q


def test_near_miss_drill_uses_embeddings(db_session):
    from app import embeddings
    from app.models import Attempt, AttemptMode, SessionType, StudySession
    from app.routers.drills import DrillBody, _near_miss_questions

    embeddings.reset_cache()
    qs = [_mk_question(db_session, i) for i in range(4)]
    vecs = {
        qs[0].id: [1.0, 0.0, 0.0],
        qs[1].id: [0.98, 0.1, 0.0],   # near q0
        qs[2].id: [0.0, 1.0, 0.0],
        qs[3].id: [0.0, 0.0, 1.0],
    }
    for q in qs:
        embeddings.embed_question(db_session, q, embedder=lambda _t, _id=q.id: vecs[_id])

    sess = StudySession(type=SessionType.drill)
    db_session.add(sess)
    db_session.commit()
    db_session.refresh(sess)
    db_session.add(Attempt(question_id=qs[0].id, session_id=sess.id,
                           mode=AttemptMode.timed, is_correct=False, chosen_answer="B"))
    db_session.commit()

    out = _near_miss_questions(db_session, DrillBody(near_misses=True, count=10, source="any"))
    ids = [q.id for q in out]
    assert qs[1].id in ids        # nearest neighbour of the missed q0 is included
    assert qs[0].id not in ids    # the exact miss is not re-served


def test_near_miss_falls_back_with_no_embeddings(db_session):
    from app import embeddings
    from app.routers.drills import DrillBody, _near_miss_questions

    embeddings.reset_cache()
    assert _near_miss_questions(db_session, DrillBody(near_misses=True)) == []
