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
