"""LSAT-4 — streaming Socratic tutor endpoints.

A nudge -> eliminate -> confirm -> explain Socratic flow that elicits a
prediction BEFORE any reveal and cites the retrieved similar-misses + Notebook
artifacts behind each nudge. Two routes, both scoped to an existing
``QuestionConversation`` (created via the sync ``POST /api/conversations`` path):

  * ``POST /api/conversations/{conversation_id}/turns-stream`` — Server-Sent
    Events. Persists the user turn + the deterministic assistant reply (the SAME
    text the sync ``POST .../turns`` produces), then streams the reply token by
    token as ``data: {"token": "…"}`` frames, finishing with a single
    ``data: {"done": true, …}`` frame that carries the persisted turn/reply and
    the citable ``socratic_context``.

  * ``GET /api/conversations/{conversation_id}/evidence`` — the citable evidence
    (similar_misses + notebook_context + lightweight question/turn context) for
    the conversation's question, as a standalone read so the UI can render
    inline citation badges without waiting for the next streamed turn.

The SSE framing (the ``_sse`` ``data: {json}\\n\\n`` helper + the
``StreamingResponse(..., media_type="text/event-stream")`` envelope) deliberately
mirrors ``ai_routes`` explain so the unified BB2 streaming client
(``src/lib/streamingClient.ts``) parses both with the same reader.
"""
from __future__ import annotations

import json
import logging
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, StringConstraints
from sqlmodel import Session

from .. import adaptivity
from ..db import get_session

log = logging.getLogger("lsatlab.socratic_routes")

router = APIRouter()


def _sse(data: dict) -> str:
    """SSE frame, identical to ``ai_routes._sse`` so one client reader handles both."""
    return f"data: {json.dumps(data)}\n\n"


class TurnStreamBody(BaseModel):
    """Mirrors ``adaptivity_routes.TurnBody`` so the streaming + sync paths share a
    request shape; ``auto_reply`` defaults on (a user turn elicits a Socratic
    nudge). ``role`` is constrained to the two persisted roles."""

    role: Literal["user", "assistant"] = "user"
    content: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=8000)
    ]
    auto_reply: bool = True


@router.post("/conversations/{conversation_id}/turns-stream")
def add_turn_stream(
    conversation_id: int,
    body: TurnStreamBody,
    session: Session = Depends(get_session),
):
    """Stream a Socratic reply for a new user turn (SSE).

    The user turn + deterministic assistant reply are persisted up front (inside
    ``adaptivity.stream_tutor_turn``) so an aborted mid-stream read never loses the
    record — the client can re-fetch the conversation. We pre-roll the generator's
    events here (the persistence + context build happens before the first yield) so
    a missing conversation surfaces as a clean 404 rather than a half-open stream.
    """
    try:
        events = adaptivity.stream_tutor_turn(
            session,
            conversation_id=conversation_id,
            role=body.role,
            content=body.content,
            auto_reply=body.auto_reply,
        )
        first = next(events)
    except ValueError as exc:
        if str(exc) == "conversation_not_found":
            raise HTTPException(404, "Conversation not found") from exc
        raise
    except StopIteration:
        # No reply (e.g. an assistant-role turn with auto_reply off): nothing to
        # stream — emit a terminal done frame so the client settles cleanly.
        def _empty_gen():
            yield _sse({"done": True})

        return StreamingResponse(_empty_gen(), media_type="text/event-stream")

    def gen():
        try:
            yield _sse(first[1])
            for _kind, payload in events:
                yield _sse(payload)
        except Exception:
            # Match ai_routes: emit a fixed error code rather than leak the message.
            log.exception(
                "socratic turn stream failed conversation_id=%s", conversation_id
            )
            yield _sse({"error": "socratic_stream_failed"})

    return StreamingResponse(gen(), media_type="text/event-stream")


@router.get("/conversations/{conversation_id}/evidence")
def conversation_evidence(
    conversation_id: int,
    session: Session = Depends(get_session),
):
    """The citable similar-misses + Notebook context behind this conversation's
    Socratic nudges (read-only; never writes a turn)."""
    try:
        return adaptivity.socratic_evidence(session, conversation_id)
    except ValueError as exc:
        if str(exc) == "conversation_not_found":
            raise HTTPException(404, "Conversation not found") from exc
        raise
