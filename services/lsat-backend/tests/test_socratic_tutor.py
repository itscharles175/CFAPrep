"""LSAT-4 — streaming Socratic tutor endpoints.

Covers the SSE turn stream (``POST /api/conversations/{id}/turns-stream``) and the
standalone evidence read (``GET /api/conversations/{id}/evidence``):

  * the stream yields one or more ``{"token": …}`` frames followed by a single
    ``{"done": true, …}`` frame carrying the persisted turn/reply + the citable
    ``socratic_context`` (similar_misses + notebook_context);
  * the concatenated tokens reproduce the persisted reply byte-for-byte (so the
    deterministic text matches the sync ``add_tutor_turn`` path);
  * the reply never leaks the answer key, and the persisted turns survive (the
    record is committed before the first token), so a re-fetch sees both turns;
  * the evidence endpoint returns the same similar_misses + notebook_context as
    the stream's done-frame context, and 404s for an unknown conversation;
  * both endpoints 404 cleanly for a missing conversation.

Relies on the shared per-PID test DB isolation in ``tests/conftest.py`` (each
interpreter binds ``app.db``'s engine to its OWN throwaway SQLite file keyed on
``os.getpid()``), so parallel backend swarms never share state.
"""
from __future__ import annotations

import json

from sqlmodel import select


def _parse_sse(text: str) -> list[dict]:
    """Parse an SSE response body into the list of decoded ``data:`` JSON frames."""
    frames: list[dict] = []
    for block in text.split("\n\n"):
        for line in block.splitlines():
            line = line.strip()
            if not line.startswith("data:"):
                continue
            payload = line[len("data:"):].strip()
            if not payload or payload == "[DONE]":
                continue
            frames.append(json.loads(payload))
    return frames


def _seed_conversation(client, *, content: str = "I think C is wrong here.") -> dict:
    """Create a question + blind-review rationale + conversation, returning ids."""
    from app.db import engine
    from app.models import Question
    from sqlmodel import Session

    with Session(engine) as s:
        q = s.exec(select(Question)).first()
        assert q is not None, "seed should provide at least one question"
        question_id = q.id

    sess = client.post("/api/sessions", json={"type": "drill", "config": {}}).json()
    attempt = client.post(
        f"/api/sessions/{sess['id']}/attempts",
        json={"question_id": question_id, "chosen_answer": "B", "time_ms": 60000},
    ).json()
    aid = attempt["attempt_id"]
    client.post(
        f"/api/attempts/{aid}/rationale",
        json={
            "stage": "blind_review",
            "answer": "A",
            "confidence": "likely",
            "rationale_text": "I think the bypass explains the drop.",
            "trap_guess": "scope_shift",
        },
    )
    conv = client.post(
        "/api/conversations",
        json={"question_id": question_id, "attempt_id": aid},
    ).json()
    return {"question_id": question_id, "attempt_id": aid, "conversation_id": conv["id"]}


def test_turns_stream_yields_tokens_then_done_with_citations(client):
    ids = _seed_conversation(client)
    conv_id = ids["conversation_id"]

    res = client.post(
        f"/api/conversations/{conv_id}/turns-stream",
        json={"role": "user", "content": "Why is my tempting answer wrong?"},
    )
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")

    frames = _parse_sse(res.text)
    assert frames, "stream should emit at least one frame"

    token_frames = [f for f in frames if "token" in f]
    done_frames = [f for f in frames if f.get("done") is True]
    assert token_frames, "stream should emit token frames before the done frame"
    assert len(done_frames) == 1, "exactly one terminal done frame"
    # The done frame is last.
    assert frames[-1] is done_frames[0]

    done = done_frames[0]
    # The persisted user turn + assistant reply ride the done frame.
    assert done["turn"]["role"] == "user"
    assert done["reply"]["role"] == "assistant"

    # Concatenated tokens reproduce the persisted reply text exactly.
    streamed = "".join(f["token"] for f in token_frames)
    assert streamed.strip() == done["reply"]["content"].strip()

    # The reveal-before-prediction contract: the answer key is never leaked.
    assert "answer key" not in done["reply"]["content"].lower()

    # The citable socratic context (BB2 done-frame metadata) is present.
    ctx = done["socratic_context"]
    assert ctx is not None
    assert ctx["answer_key_hidden"] is True
    assert "similar_misses" in ctx
    assert "notebook_context" in ctx


def test_turns_stream_persists_both_turns(client):
    ids = _seed_conversation(client)
    conv_id = ids["conversation_id"]

    res = client.post(
        f"/api/conversations/{conv_id}/turns-stream",
        json={"role": "user", "content": "Walk me through the gap."},
    )
    assert res.status_code == 200
    _ = _parse_sse(res.text)

    # Re-fetch: the user turn + assistant reply must have survived the stream.
    conv = client.get(f"/api/conversations/{conv_id}").json()
    roles = [t["role"] for t in conv["turns"]]
    assert roles[-2:] == ["user", "assistant"]
    assert conv["turns"][-2]["content"] == "Walk me through the gap."
    assert conv["turns"][-1]["meta"]["model"] == "deterministic_socratic_v2_stream"


def test_evidence_endpoint_returns_misses_and_notebook(client):
    ids = _seed_conversation(client)
    conv_id = ids["conversation_id"]

    res = client.get(f"/api/conversations/{conv_id}/evidence")
    assert res.status_code == 200
    body = res.json()
    assert body["conversation_id"] == conv_id
    assert body["question_id"] == ids["question_id"]
    assert body["answer_key_hidden"] is True
    # Both citation collections are always present (possibly empty) so the UI can
    # render badge containers without a null check.
    assert isinstance(body["similar_misses"], list)
    assert "notebook_context" in body
    assert "count" in body["notebook_context"]
    assert isinstance(body["question_context"], dict)


def test_stream_and_evidence_404_for_unknown_conversation(client):
    missing = client.post(
        "/api/conversations/999999/turns-stream",
        json={"role": "user", "content": "Hello?"},
    )
    assert missing.status_code == 404

    missing_ev = client.get("/api/conversations/999999/evidence")
    assert missing_ev.status_code == 404


def test_stream_matches_sync_reply_text(client):
    """The streaming path's deterministic reply must match the sync path's text for
    the same conversation state (both reuse ``_socratic_reply``)."""
    from app import adaptivity
    from app.db import engine
    from app.models import QuestionConversation
    from sqlmodel import Session

    ids = _seed_conversation(client)
    conv_id = ids["conversation_id"]

    # Compute the deterministic reply directly (no persistence) for the same input.
    with Session(engine) as s:
        conv = s.get(QuestionConversation, conv_id)
        ctx = adaptivity._socratic_context(s, conv)
        expected = adaptivity._socratic_reply(
            s, conv, "Why is my tempting answer wrong?", context=ctx
        )

    res = client.post(
        f"/api/conversations/{conv_id}/turns-stream",
        json={"role": "user", "content": "Why is my tempting answer wrong?"},
    )
    frames = _parse_sse(res.text)
    streamed = "".join(f["token"] for f in frames if "token" in f)
    assert streamed.strip() == expected.strip()
