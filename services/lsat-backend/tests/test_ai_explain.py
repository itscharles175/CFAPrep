"""AI explain SSE with mocked Ollama; think-strip; caching."""
from __future__ import annotations

import json

import pytest

from app import ai


def test_strip_think():
    assert ai.strip_think("<think>reasoning</think>Answer") == "Answer"
    assert ai.strip_think("a<think>x</think>b") == "ab"
    assert ai.strip_think("no tags here") == "no tags here"


def test_think_filter_streaming():
    flt = ai._ThinkFilter()
    out = ""
    for chunk in ["Hello <thi", "nk>secret rea", "soning</thi", "nk> world"]:
        out += flt.feed(chunk)
    out += flt.flush()
    assert "secret" not in out
    assert "Hello" in out and "world" in out


def _parse_sse(text: str):
    events = []
    for line in text.splitlines():
        if line.startswith("data: "):
            events.append(json.loads(line[len("data: "):]))
    return events


def test_explain_streams_and_persists(client, monkeypatch):
    async def fake_stream(stem, prompt, choices, correct, chosen, **kwargs):
        for tok in ["The ", "correct ", "answer ", "is right. ",
                    "A: wrong\n", "B: right\n"]:
            yield tok

    monkeypatch.setattr(ai, "stream_explanation", fake_stream)

    # question 1 has a seeded explanation already (cache path). Use a question
    # without one by first deleting? Instead use a fresh generated scenario:
    # delete the seeded explanation for q 2 to force live path.
    from app.db import engine
    from app.models import Explanation
    from sqlmodel import Session, delete
    with Session(engine) as s:
        s.exec(delete(Explanation).where(Explanation.question_id == 2))
        s.commit()

    r = client.post("/api/ai/explain", json={"question_id": 2, "chosen_answer": "A"})
    assert r.status_code == 200
    events = _parse_sse(r.text)
    tokens = [e["token"] for e in events if "token" in e]
    assert "".join(tokens).startswith("The correct answer")
    done = [e for e in events if e.get("done")]
    assert done and done[0]["explanation_id"]

    # Now cached path: should still stream + report cached
    r2 = client.post("/api/ai/explain", json={"question_id": 2})
    events2 = _parse_sse(r2.text)
    done2 = [e for e in events2 if e.get("done")]
    assert done2[0]["cached"] is True


def test_explain_cache_hit_on_seeded(client):
    # q1 has a seeded explanation -> cached stream
    r = client.post("/api/ai/explain", json={"question_id": 1})
    events = _parse_sse(r.text)
    done = [e for e in events if e.get("done")]
    assert done and done[0].get("cached") is True


def _seed_rc_question(session, *, passage_text, topic="legal history", correct="B"):
    """Seed a real RC question (PrepTest -> RC Section -> Passage -> Question with
    passage_id set) so the /ai/explain route resolves the passage from the DB,
    exactly as it does in production."""
    from app.models import (
        AnswerChoice,
        Passage,
        PrepTest,
        Question,
        QuestionSource,
        Section,
        SectionType,
    )

    pt = PrepTest(name="LSAT-1 RC prompt test", source="sample", is_official=False)
    session.add(pt)
    session.commit()
    session.refresh(pt)
    sec = Section(preptest_id=pt.id, type=SectionType.RC, order=0)
    session.add(sec)
    session.commit()
    session.refresh(sec)
    passage = Passage(section_id=sec.id, text=passage_text, type="single", topic=topic)
    session.add(passage)
    session.commit()
    session.refresh(passage)
    q = Question(
        section_id=sec.id,
        passage_id=passage.id,
        stem="According to the passage, which claim is supported?",
        prompt="Which one of the following is most strongly supported?",
        correct_answer=correct,
        q_type="Detail",
        source=QuestionSource.sample,
        approved=True,
    )
    session.add(q)
    session.commit()
    session.refresh(q)
    for lbl in "ABCDE":
        session.add(AnswerChoice(question_id=q.id, label=lbl, text=f"choice {lbl}",
                                 is_correct=(lbl == correct)))
    session.commit()
    return q.id


def test_explain_route_injects_passage_into_real_prompt(client, monkeypatch):
    """LSAT-1: when a question has passage_id set, the route resolves the passage
    and the REAL ``_explain_prompt`` it builds includes the passage text. Unlike
    the kwargs-level checks elsewhere, this mocks the single network seam
    (``_chat_stream``) so the production prompt builder actually runs end-to-end."""
    captured = {}

    async def fake_chat_stream(model, messages, timeout):
        captured["messages"] = messages
        yield "The correct answer is (B). A: trap\nB: correct\n"

    monkeypatch.setattr(ai, "_chat_stream", fake_chat_stream)

    from app.db import engine
    from sqlmodel import Session
    with Session(engine) as s:
        qid = _seed_rc_question(
            s, passage_text="UNIQUE_PROMPT_PASSAGE explains the author's concession."
        )

    r = client.post("/api/ai/explain", json={"question_id": qid})
    assert r.status_code == 200
    events = _parse_sse(r.text)
    assert any(e.get("done") for e in events)

    user = captured["messages"][1]["content"]
    sys = captured["messages"][0]["content"]
    assert "UNIQUE_PROMPT_PASSAGE" in user
    assert "Reading Comprehension passage" in user
    assert "Topic: legal history" in user
    # The RC-specific system instruction is engaged for passage-backed questions.
    assert "ground every factual claim in the passage" in sys


def test_explain_route_non_rc_prompt_has_no_passage_block(client, monkeypatch):
    """LSAT-1 guard: a non-RC question (no passage_id) builds a prompt with NO
    passage block and NO RC-only system instruction — non-RC behavior is unchanged."""
    captured = {}

    async def fake_chat_stream(model, messages, timeout):
        captured["messages"] = messages
        yield "The correct answer is (B). A: trap\nB: correct\n"

    monkeypatch.setattr(ai, "_chat_stream", fake_chat_stream)

    # q2 is a seeded LR question with no passage; clear its cached explanation so
    # the live (prompt-building) path runs.
    from app.db import engine
    from app.models import Explanation, Question
    from sqlmodel import Session, delete
    with Session(engine) as s:
        s.exec(delete(Explanation).where(Explanation.question_id == 2))
        s.commit()
        assert s.get(Question, 2).passage_id is None

    r = client.post("/api/ai/explain", json={"question_id": 2})
    assert r.status_code == 200

    user = captured["messages"][1]["content"]
    sys = captured["messages"][0]["content"]
    assert "Reading Comprehension passage" not in user
    assert "ground every factual claim in the passage" not in sys


def test_diagnose_fallback(client, monkeypatch):
    async def boom(summary):
        raise RuntimeError("ollama down")
    monkeypatch.setattr(ai, "diagnose", boom)
    r = client.post("/api/ai/diagnose")
    assert r.status_code == 200
    body = r.json()
    assert "text" in body and "recommendation" in body
    assert body["source"] == "local_coach_context_v1"
    assert body["recommendation"]["action"]["type"] in {
        "drill",
        "srs",
        "analytics",
        "blind_review",
        "start_section",
    }
    assert body["recommendation"]["action"]["type"] != "start_drill"
