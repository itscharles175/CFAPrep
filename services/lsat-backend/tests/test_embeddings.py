"""Embeddings + RAG: cosine, backfill, similarity ranking, note retrieval."""
from __future__ import annotations

import re

import pytest
from sqlmodel import delete

from app import embeddings
from app.models import (
    Attempt, ErrorLogEntry, ErrorReason, Passage, PrepTest, Question,
    QuestionSource, Section, SectionType, SessionType, StudySession,
)

# Deterministic bag-of-words "embedder" over a tiny vocab so cosine is meaningful
# and no network is touched.
_VOCAB = ["cat", "dog", "math", "logic", "bird", "climate", "zoning"]


def _bow(text: str, model=None) -> list[float]:
    t = (text or "").lower()
    # word-boundary counts so "cat" doesn't match inside "indicate" etc.
    return [float(len(re.findall(rf"\b{w}\b", t))) for w in _VOCAB]


def test_cosine_basics():
    assert embeddings.cosine([1, 0], [1, 0]) == pytest.approx(1.0)
    assert embeddings.cosine([1, 0], [0, 1]) == pytest.approx(0.0)
    assert embeddings.cosine([], [1]) == 0.0


def _mk_question(session, stem: str) -> Question:
    q = Question(stem=stem, prompt=stem, correct_answer="A", q_type="Inference",
                 source=QuestionSource.research)
    session.add(q)
    session.commit()
    session.refresh(q)
    return q


def _mk_rc_question(session, passage_text: str, stem: str) -> Question:
    pt = PrepTest(name="embedding rc", source="research", is_official=False)
    session.add(pt)
    session.commit()
    session.refresh(pt)
    sec = Section(preptest_id=pt.id, type=SectionType.RC, order=0)
    session.add(sec)
    session.commit()
    session.refresh(sec)
    passage = Passage(section_id=sec.id, text=passage_text, type="single")
    session.add(passage)
    session.commit()
    session.refresh(passage)
    q = Question(
        section_id=sec.id,
        passage_id=passage.id,
        stem=stem,
        prompt=stem,
        correct_answer="A",
        q_type="Detail",
        source=QuestionSource.research,
    )
    session.add(q)
    session.commit()
    session.refresh(q)
    return q


def test_backfill_and_similarity_ranking(db_session):
    cat1 = _mk_question(db_session, "cat cat cat")
    cat2 = _mk_question(db_session, "cat cat")
    math = _mk_question(db_session, "math math math")

    res = embeddings.backfill_question_embeddings(db_session, embedder=_bow)
    assert res["embedded"] >= 3

    sims = embeddings.similar_questions(db_session, cat1.id, k=50, embedder=_bow)
    # cat2 shares all keywords with cat1 -> highest score; math is orthogonal.
    assert sims[0]["question_id"] == cat2.id
    cat2_score = sims[0]["score"]
    math_score = next(s["score"] for s in sims if s["question_id"] == math.id)
    assert cat2_score > math_score


def test_question_embeddings_include_rc_passage_text(db_session):
    rc1 = _mk_rc_question(db_session, "climate climate zoning", "detail prompt")
    rc2 = _mk_rc_question(db_session, "climate climate zoning", "different prompt")
    other = _mk_rc_question(db_session, "math math logic", "different prompt")

    embeddings.backfill_question_embeddings(db_session, embedder=_bow)

    sims = embeddings.similar_questions(db_session, rc1.id, k=50, embedder=_bow)
    assert sims[0]["question_id"] == rc2.id
    rc2_score = sims[0]["score"]
    other_score = next(s["score"] for s in sims if s["question_id"] == other.id)
    assert rc2_score > other_score


def test_context_notes_empty_short_circuits_without_embedding(db_session):
    db_session.exec(delete(ErrorLogEntry))
    db_session.commit()

    calls = {"n": 0}

    def counting_embedder(text, model=None):
        calls["n"] += 1
        return _bow(text)

    notes = embeddings.context_notes_for_question(db_session, 1, embedder=counting_embedder)
    assert notes == []
    assert calls["n"] == 0  # no notes to retrieve -> never embeds


def test_context_notes_returns_similar_past_note(db_session):
    db_session.exec(delete(ErrorLogEntry))
    db_session.commit()

    cat1 = _mk_question(db_session, "cat cat cat")
    cat2 = _mk_question(db_session, "cat cat")
    _mk_question(db_session, "math math math")

    s = StudySession(type=SessionType.drill)
    db_session.add(s)
    db_session.commit()
    db_session.refresh(s)
    a = Attempt(question_id=cat2.id, session_id=s.id, chosen_answer="B")
    db_session.add(a)
    db_session.commit()
    db_session.refresh(a)
    db_session.add(ErrorLogEntry(attempt_id=a.id, reason=ErrorReason.concept,
                                 user_note="watch the scope on cat arguments"))
    db_session.commit()

    embeddings.backfill_question_embeddings(db_session, embedder=_bow)
    notes = embeddings.context_notes_for_question(db_session, cat1.id, embedder=_bow)
    assert "watch the scope on cat arguments" in notes


def test_embed_and_similar_endpoints(client, monkeypatch):
    import app.llm as llm
    monkeypatch.setattr(llm, "embed_sync", _bow)

    r = client.post("/api/bank/embed", json={"limit": 100})
    assert r.status_code == 200
    assert r.json()["embedded"] >= 1

    r2 = client.get("/api/bank/similar/1?k=3")
    assert r2.status_code == 200
    assert isinstance(r2.json(), list)
