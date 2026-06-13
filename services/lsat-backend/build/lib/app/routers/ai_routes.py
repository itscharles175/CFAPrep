"""AI endpoints: streaming explain (SSE, cached, follow-ups), diagnose, hint, coach."""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from .. import ai, coach, embeddings, notebook_os, pregenerate
from ..db import engine, get_session

log = logging.getLogger("lsatlab.ai_routes")
from ..models import (
    AnswerChoice,
    Attempt,
    AttemptRationale,
    Explanation,
    ExplanationFeedback,
    ExplanationSource,
    Passage,
    Question,
    QuestionConversation,
    QuestionSource,
    TutorTurn,
)

router = APIRouter(prefix="/ai")


class ExplainBody(BaseModel):
    question_id: int
    chosen_answer: Optional[str] = None
    attempt_id: Optional[int] = None
    conversation_id: Optional[int] = None
    # A1 — follow-up turns:
    user_message: Optional[str] = None    # "Why is C wrong?"
    focus_choice: Optional[str] = None    # focus the explanation on one choice


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


_CHOICE_LINE_RE = re.compile(r"^\s*\(?([A-E])\)?\s*[:.\)-]\s*(.+)$")


def _complete_choice_lines(text: str, emitted: set) -> list:
    """Per-choice notes for lines that are fully received (A4 incremental)."""
    out = []
    lines = text.split("\n")
    for line in lines[:-1]:  # last line may still be streaming
        m = _CHOICE_LINE_RE.match(line.strip())
        if m and m.group(1) not in emitted:
            emitted.add(m.group(1))
            out.append((m.group(1), m.group(2).strip()))
    return out


def _excerpt(text: str | None, *, limit: int = 240) -> str:
    compact = " ".join((text or "").split())
    if len(compact) <= limit:
        return compact
    return compact[: max(0, limit - 1)].rstrip() + "..."


def _conversation_for_attempt(
    session: Session,
    *,
    question_id: int,
    attempt_id: int,
) -> QuestionConversation | None:
    return session.exec(
        select(QuestionConversation)
        .where(QuestionConversation.question_id == question_id)
        .where(QuestionConversation.attempt_id == attempt_id)
        .order_by(QuestionConversation.updated_at.desc())
    ).first()


def _socratic_explain_context(
    session: Session,
    *,
    question_id: int,
    attempt_id: int | None,
    conversation_id: int | None,
) -> dict | None:
    attempt: Attempt | None = None
    if attempt_id is not None:
        attempt = session.get(Attempt, attempt_id)
        if attempt is None:
            raise HTTPException(404, "Attempt not found")
        if attempt.question_id != question_id:
            raise HTTPException(400, "Attempt does not belong to this question")

    conv: QuestionConversation | None = None
    if conversation_id is not None:
        conv = session.get(QuestionConversation, conversation_id)
        if conv is None:
            raise HTTPException(404, "Conversation not found")
        if conv.question_id != question_id:
            raise HTTPException(400, "Conversation does not belong to this question")
        if attempt is not None and conv.attempt_id not in (None, attempt.id):
            raise HTTPException(400, "Conversation does not belong to this attempt")
        if attempt is None and conv.attempt_id is not None:
            attempt = session.get(Attempt, conv.attempt_id)
    elif attempt is not None and attempt.id is not None:
        conv = _conversation_for_attempt(
            session,
            question_id=question_id,
            attempt_id=attempt.id,
        )

    rationale_rows: list[AttemptRationale] = []
    if attempt is not None and attempt.id is not None:
        rationale_rows = session.exec(
            select(AttemptRationale)
            .where(AttemptRationale.attempt_id == attempt.id)
            .order_by(AttemptRationale.id)
        ).all()
    rationale = rationale_rows[-1] if rationale_rows else None

    turn_rows: list[TutorTurn] = []
    if conv is not None and conv.id is not None:
        turn_rows = session.exec(
            select(TutorTurn)
            .where(TutorTurn.conversation_id == conv.id)
            .order_by(TutorTurn.id)
        ).all()
    recent_turns = [
        {"role": row.role, "content": _excerpt(row.content, limit=160)}
        for row in turn_rows[-4:]
        if row.content.strip()
    ]

    if (
        rationale is None
        and not recent_turns
        and (attempt is None or attempt.br_answer is None)
    ):
        return None

    prompt_context = {
        "attempt_id": attempt.id if attempt is not None else None,
        "conversation_id": conv.id if conv is not None else None,
        "timed_answer": attempt.chosen_answer if attempt is not None else None,
        "blind_review_answer": attempt.br_answer if attempt is not None else None,
        "rationale": {
            "stage": rationale.stage,
            "answer": rationale.answer,
            "confidence": (
                rationale.confidence.value if rationale.confidence else None
            ),
            "trap_guess": rationale.trap_guess,
            "text": _excerpt(rationale.rationale_text, limit=260),
        } if rationale is not None else None,
        "recent_turns": recent_turns,
    }
    prompt_context["meta"] = {
        "personalized": True,
        "attempt_id": prompt_context["attempt_id"],
        "conversation_id": prompt_context["conversation_id"],
        "rationale_count": len(rationale_rows),
        "turn_count": len(turn_rows),
        "trap_guess": rationale.trap_guess if rationale else None,
    }
    return prompt_context


@router.post("/explain")
def explain(body: ExplainBody, session: Session = Depends(get_session)):
    q = session.get(Question, body.question_id)
    if not q:
        raise HTTPException(404, "Question not found")
    choices = sorted(
        session.exec(
            select(AnswerChoice).where(AnswerChoice.question_id == q.id)
        ).all(),
        key=lambda c: c.label,
    )
    choice_dicts = [{"label": c.label, "text": c.text} for c in choices]
    labels = [c.label for c in choices]
    is_followup = bool(body.user_message)
    socratic_context = _socratic_explain_context(
        session,
        question_id=q.id,
        attempt_id=body.attempt_id,
        conversation_id=body.conversation_id,
    )
    is_personalized = socratic_context is not None

    # Cache hit (base explanation only — follow-ups and personalized why-loop
    # reveal contrasts always go live, never cached as canonical explanations).
    cached = None
    if not is_followup and not is_personalized:
        cached = session.exec(
            select(Explanation)
            .where(Explanation.question_id == q.id)
            .order_by(Explanation.id.desc())
        ).first()

    if cached is not None:
        exp_id = cached.id
        body_text = cached.body
        per_choice = cached.per_choice_json or {}
        # 2.6 — surface the cached explanation's self-check provenance (additive).
        c_model = cached.model_used
        c_conf = cached.confidence
        c_checked = cached.answer_checked

        def cache_gen():
            for word in body_text.split(" "):
                yield _sse({"token": word + " "})
            for label in sorted(per_choice):
                yield _sse({"choice": label, "text": per_choice[label]})
            yield _sse({"done": True, "explanation_id": exp_id,
                        "cached": True, "per_choice": per_choice,
                        "model_used": c_model, "confidence": c_conf,
                        "answer_checked": c_checked})

        return StreamingResponse(cache_gen(), media_type="text/event-stream")

    # Live generation: stream tokens + per-choice events, accumulate, persist.
    stem, prompt, correct = q.stem, q.prompt, q.correct_answer
    passage_text = None
    passage_topic = None
    if q.passage_id is not None:
        passage = session.get(Passage, q.passage_id)
        if passage is not None:
            passage_text = passage.text
            passage_topic = passage.topic

    # Best-effort RAG (base turn only): the student's own notes on similar past
    # misses (2.x) + a worked exemplar from a similar real question (2.7). Neither
    # blocks or fails the explanation if embeddings are unavailable.
    context_notes: list[str] = []
    exemplar = None
    notebook_context: dict = {"notes": [], "items": []}
    if not is_followup:
        try:
            context_notes = embeddings.context_notes_for_question(session, q.id)
        except Exception:
            log.debug("context_notes failed for question_id=%s", q.id, exc_info=True)
            context_notes = []
        try:
            trap_misses = embeddings.trap_similar_misses_for_question(
                session,
                q.id,
                chosen_answer=body.chosen_answer,
            )
            context_notes.extend(embeddings.trap_miss_context_notes(trap_misses))
        except Exception:
            log.debug("trap miss context failed for question_id=%s", q.id, exc_info=True)
        try:
            notebook_context = notebook_os.explanation_context_for_question(
                session, q, passage_id=q.passage_id
            )
            context_notes.extend(notebook_context.get("notes") or [])
        except Exception:
            log.debug(
                "notebook explanation context failed for question_id=%s",
                q.id,
                exc_info=True,
            )
            notebook_context = {"notes": [], "items": []}
        try:
            exemplar = embeddings.exemplar_for_question(session, q.id)
        except Exception:
            log.debug("exemplar failed for question_id=%s", q.id, exc_info=True)
            exemplar = None

    async def live_gen():
        acc: list[str] = []
        emitted: set = set()
        extra: dict = {}
        if context_notes:
            extra["context_notes"] = context_notes
        if exemplar:
            extra["exemplar"] = exemplar
        if passage_text:
            extra["passage_text"] = passage_text
        if passage_topic:
            extra["passage_topic"] = passage_topic
        if body.user_message:
            extra["user_message"] = body.user_message
        if body.focus_choice:
            extra["focus_choice"] = body.focus_choice
        if socratic_context:
            extra["socratic_context"] = {
                key: value
                for key, value in socratic_context.items()
                if key != "meta"
            }
        try:
            async for tok in ai.stream_explanation(
                stem, prompt, choice_dicts, correct, body.chosen_answer, **extra
            ):
                acc.append(tok)
                yield _sse({"token": tok})
                for label, txt in _complete_choice_lines("".join(acc), emitted):
                    yield _sse({"choice": label, "text": txt})
        except Exception:
            # B2: emit a fixed error code instead of leaking the exception message.
            log.exception("explain stream failed question_id=%s", body.question_id)
            yield _sse({"error": "explain_failed"})
            return
        full = "".join(acc).strip()
        per_choice = ai.parse_per_choice(full, labels)
        # 2.6 — post-stream self-check on the ASSEMBLED text (can't verify mid-
        # stream). A contradictory base explanation is persisted but flagged
        # answer_checked=False / confidence="low" so the next reveal regenerates it
        # via the feedback loop and the UI can warn; we never re-stream live.
        answer_checked, confidence = (True, "medium")
        if not is_followup:
            answer_checked, confidence = ai.check_explanation(full, correct)
        new_id = None
        # Persist only the canonical base explanation, not conversational follow-ups.
        if not is_followup and not is_personalized:
            with Session(engine) as s2:
                exp = Explanation(
                    question_id=body.question_id,
                    body=full,
                    source=ExplanationSource.ai,
                    per_choice_json=per_choice,
                    model_used=ai.config.EXPLAIN_MODEL,
                    confidence=confidence,
                    answer_checked=answer_checked,
                )
                s2.add(exp)
                s2.commit()
                s2.refresh(exp)
                new_id = exp.id
        done = {"done": True, "explanation_id": new_id,
                "cached": False, "per_choice": per_choice,
                "model_used": ai.config.EXPLAIN_MODEL if not is_followup else None,
                "confidence": confidence, "answer_checked": answer_checked}
        if notebook_context.get("items"):
            done["notebook_context"] = {
                "count": len(notebook_context["items"]),
                "items": notebook_context["items"],
            }
        if socratic_context:
            done["socratic_context"] = socratic_context["meta"]
        yield _sse(done)

    return StreamingResponse(live_gen(), media_type="text/event-stream")


class ExplainFeedbackBody(BaseModel):
    question_id: int
    helpful: bool
    note: Optional[str] = None


@router.post("/explain/feedback")
def explain_feedback(body: ExplainFeedbackBody, session: Session = Depends(get_session)):
    """Q1 — rate a question's explanation. A 👎 drops the cached explanation so
    the next /ai/explain regenerates a fresh one (closing the feedback loop)."""
    q = session.get(Question, body.question_id)
    if not q:
        raise HTTPException(404, "Question not found")
    session.add(ExplanationFeedback(
        question_id=body.question_id, helpful=body.helpful, note=body.note,
    ))
    will_regenerate = False
    if not body.helpful:
        cached = session.exec(
            select(Explanation).where(Explanation.question_id == body.question_id)
        ).all()
        for e in cached:
            session.delete(e)
        will_regenerate = bool(cached)
    session.commit()
    return {"ok": True, "will_regenerate": will_regenerate}


@router.get("/explanation-quality")
def explanation_quality(session: Session = Depends(get_session)):
    """Q1 — explanation-quality signal: helpful rate + the questions whose most
    recent feedback was 👎 (candidates for regeneration / review)."""
    rows = session.exec(select(ExplanationFeedback)).all()
    helpful = sum(1 for r in rows if r.helpful)
    latest: dict[int, bool] = {}
    for r in sorted(rows, key=lambda r: r.id or 0):
        latest[r.question_id] = r.helpful
    low = sorted(qid for qid, ok in latest.items() if not ok)
    return {
        "total": len(rows),
        "helpful": helpful,
        "unhelpful": len(rows) - helpful,
        "helpful_rate": round(helpful / len(rows), 4) if rows else None,
        "low_rated_question_ids": low,
    }


@router.post("/diagnose")
async def diagnose(session: Session = Depends(get_session)):
    ctx = coach.build_coach_context(session)
    rec = coach.choose_recommendation(ctx)
    if not ctx["has_data"]:
        return {
            "text": "No attempts yet. Take a timed section to begin your diagnosis.",
            "recommendation": rec,
            "source": "local_coach_context_v1",
        }
    try:
        text = await ai.diagnose(ctx["summary"])
    except Exception:
        # Deterministic fallback when Ollama is unreachable.
        text = (
            f"Your weakest type is {ctx['worst']}. Focus a drill set there and use "
            f"blind review to separate timing errors from concept gaps."
        )
    return {
        "text": text,
        "recommendation": rec,
        "source": "local_coach_context_v1",
    }


class HintBody(BaseModel):
    question_id: int
    mode: Optional[str] = "study"


@router.post("/hint")
async def hint(body: HintBody, session: Session = Depends(get_session)):
    """A11/A10: a study-mode nudge that never reveals the answer. Test Mode is
    sacred — hints are refused unless mode == 'study'."""
    if (body.mode or "study") != "study":
        raise HTTPException(400, "Hints are only available in study mode")
    q = session.get(Question, body.question_id)
    if not q:
        raise HTTPException(404, "Question not found")
    choices = sorted(
        session.exec(select(AnswerChoice).where(AnswerChoice.question_id == q.id)).all(),
        key=lambda c: c.label,
    )
    cds = [{"label": c.label, "text": c.text} for c in choices]
    try:
        text = await ai.hint(q.stem, q.prompt, cds)
    except Exception:
        text = ("Re-read the stimulus and pin down the exact conclusion and the gap "
                "the argument leaves open before scanning the choices.")
    return {"hint": text}


class PregenBody(BaseModel):
    limit: int = 20
    sources: Optional[list[str]] = None


@router.post("/pregenerate")
async def pregenerate_explanations(body: PregenBody):
    """Fill the explanation cache ahead of time so the study loop never waits.

    B35: runs the blocking LLM-heavy work in a thread pool via asyncio.to_thread
    so it does not stall the async event loop. A fresh session is created inside
    the thread (SQLAlchemy sessions are not thread-safe to share across threads).
    """
    limit = max(1, min(body.limit, 500))
    sources = body.sources

    def _run():
        from ..db import engine as _engine
        from sqlmodel import Session as _Session
        with _Session(_engine) as s:
            return pregenerate.pregenerate_explanations(s, limit=limit, sources=sources)

    return await asyncio.to_thread(_run)


@router.get("/coach")
def coach_latest(session: Session = Depends(get_session)):
    """Latest scheduled coach diagnosis snapshot (no model call)."""
    snap = coach.latest_snapshot(session)
    if snap is None:
        return {"available": False}
    return {
        "available": True,
        "text": snap.text,
        "recommendation": snap.recommendation_json,
        "created_at": snap.created_at.isoformat(),
    }


@router.post("/coach/refresh")
async def coach_refresh():
    """Force-refresh the coach snapshot now (uses the model).

    B35: runs the blocking model call in a thread pool via asyncio.to_thread
    so it does not stall the async event loop. Creates its own DB session
    inside the thread for thread safety.
    """
    def _run():
        from ..db import engine as _engine
        from sqlmodel import Session as _Session
        with _Session(_engine) as s:
            return coach.refresh_snapshot(s)

    snap = await asyncio.to_thread(_run)
    return {
        # Parity with GET /api/ai/coach (CoachSnapshot) so clients can treat both
        # responses identically.
        "available": True,
        "text": snap.text,
        "recommendation": snap.recommendation_json,
        "created_at": snap.created_at.isoformat(),
    }


class CoachChatBody(BaseModel):
    message: str
    history: Optional[list[dict]] = None


@router.post("/coach/chat")
async def coach_chat(body: CoachChatBody, session: Session = Depends(get_session)):
    """X3 — a grounded coach Q&A turn. Stateless: the client keeps the transcript
    and sends recent history; the student's recent-performance summary is the
    grounding context. Always local (Ollama)."""
    if not (body.message or "").strip():
        raise HTTPException(400, "Empty message")
    # 2.5 — ground the chat coach in the richer structured context (weak types,
    # specific recent missed question ids, BR gap, traps, forecast, calibration)
    # so it can tutor and cite, not just summarize a flat accuracy string.
    ctx = coach.build_coach_context(session)
    try:
        reply = await ai.coach_chat(
            ctx["summary"] or "No attempts logged yet.",
            body.message, history=body.history,
        )
    except Exception:
        reply = (
            "I can't reach the local model right now. From your data, your weakest "
            f"area is {ctx.get('worst') or 'not yet clear'} — run a focused drill there "
            "and use blind review to separate timing from concept gaps."
        )
    return {"reply": reply}
