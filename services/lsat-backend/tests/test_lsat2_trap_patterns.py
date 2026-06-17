"""LSAT-2 — the /ai/explain SSE ``done`` event carries trap-similar misses as an
optional ``trap_patterns`` field when the student has prior misses sharing the
active trap pattern, and omits it otherwise.

Mirrors test_ai_explain.py: mock the single network seam (``stream_explanation``)
and reuse the per-PID conftest ``client`` fixture (fresh seeded DB per test).
"""
from __future__ import annotations

import json

from app import ai


def _parse_sse(text: str):
    events = []
    for line in text.splitlines():
        if line.startswith("data: "):
            events.append(json.loads(line[len("data: "):]))
    return events


def _seed_trap_question(session, *, trap_type: str, q_type: str = "Flaw",
                        correct: str = "B"):
    """Seed a standalone LR question whose WRONG choices carry ``trap_type`` so the
    trap-similar retrieval has a shared shape to match on. Returns the question id."""
    from app.models import (
        AnswerChoice,
        PrepTest,
        Question,
        QuestionSource,
        Section,
        SectionType,
    )

    pt = PrepTest(name="LSAT-2 trap prompt test", source="sample", is_official=False)
    session.add(pt)
    session.commit()
    session.refresh(pt)
    sec = Section(preptest_id=pt.id, type=SectionType.LR, order=0)
    session.add(sec)
    session.commit()
    session.refresh(sec)
    q = Question(
        section_id=sec.id,
        stem="The argument above is most vulnerable to which criticism?",
        prompt="Which one of the following most accurately describes a flaw?",
        correct_answer=correct,
        q_type=q_type,
        source=QuestionSource.sample,
        approved=True,
    )
    session.add(q)
    session.commit()
    session.refresh(q)
    for lbl in "ABCDE":
        session.add(AnswerChoice(
            question_id=q.id,
            label=lbl,
            text=f"choice {lbl}",
            is_correct=(lbl == correct),
            # Every WRONG choice carries the trap so any wrong pick maps to it.
            trap_type=(None if lbl == correct else trap_type),
        ))
    session.commit()
    return q.id


def _log_wrong_attempt(session, *, question_id: int, chosen: str,
                       note: str | None = None):
    """Record a prior wrong attempt (and optional rationale note) on a question so
    it becomes a candidate trap-similar miss for a later explanation."""
    from app.models import Attempt, AttemptRationale, SessionType, StudySession

    sess = StudySession(type=SessionType.drill)
    session.add(sess)
    session.commit()
    session.refresh(sess)
    a = Attempt(
        question_id=question_id,
        session_id=sess.id,
        chosen_answer=chosen,
        is_correct=False,
    )
    session.add(a)
    session.commit()
    session.refresh(a)
    if note:
        session.add(AttemptRationale(
            attempt_id=a.id,
            question_id=question_id,
            stage="blind_review",
            answer=chosen,
            rationale_text=note,
        ))
        session.commit()
    return a.id


def _fake_stream(stem, prompt, choices, correct, chosen, **kwargs):
    async def gen():
        for tok in ["The ", "correct ", "answer ", "is right. ",
                    "A: trap\n", "B: correct\n"]:
            yield tok
    return gen()


def test_explain_done_carries_trap_patterns_when_prior_misses_exist(client, monkeypatch):
    monkeypatch.setattr(ai, "stream_explanation", _fake_stream)

    from app.db import engine
    from sqlmodel import Session

    with Session(engine) as s:
        prior_qid = _seed_trap_question(s, trap_type="reversal")
        current_qid = _seed_trap_question(s, trap_type="reversal")
        # A prior wrong attempt on the OTHER question sharing the reversal trap.
        _log_wrong_attempt(
            s,
            question_id=prior_qid,
            chosen="A",
            note="Read 'weakens' as 'strengthens' under time pressure.",
        )

    r = client.post(
        "/api/ai/explain",
        json={"question_id": current_qid, "chosen_answer": "C"},
    )
    assert r.status_code == 200
    events = _parse_sse(r.text)
    done = [e for e in events if e.get("done")]
    assert done, "expected a terminal done event"
    tp = done[0].get("trap_patterns")
    assert tp is not None, "expected trap_patterns on the done event"
    assert tp["count"] >= 1
    items = tp["items"]
    assert isinstance(items, list) and items
    # The prior miss is surfaced with its identifying fields.
    miss = next((m for m in items if m["question_id"] == prior_qid), None)
    assert miss is not None
    assert miss["trap_type"] == "reversal"
    assert miss["chosen_answer"] == "A"
    assert "weakens" in (miss.get("note_excerpt") or "")


def test_explain_done_omits_trap_patterns_when_no_prior_misses(client, monkeypatch):
    monkeypatch.setattr(ai, "stream_explanation", _fake_stream)

    from app.db import engine
    from sqlmodel import Session

    with Session(engine) as s:
        # A fresh trap question whose wrong choices carry a SENTINEL trap no other
        # (seeded or test) question uses. With a concrete target trap resolved from
        # the chosen wrong answer, the retrieval's exact-trap branch can't match
        # anything, and the looser q_type/question-trap fallbacks are disabled once
        # a target trap exists — so there are provably no prior misses to surface.
        current_qid = _seed_trap_question(
            s, trap_type="zzz_unique_trap_lsat2", q_type="Parallel"
        )

    r = client.post(
        "/api/ai/explain",
        json={"question_id": current_qid, "chosen_answer": "C"},
    )
    assert r.status_code == 200
    events = _parse_sse(r.text)
    done = [e for e in events if e.get("done")]
    assert done
    # Absent entirely (not an empty envelope) when there is nothing to surface.
    assert "trap_patterns" not in done[0]


def test_explain_passes_trap_misses_into_prompt_context(client, monkeypatch):
    """The trap-similar misses are injected into the explanation's prompt context
    via the ``trap_misses`` kwarg on ``stream_explanation`` (so ai.py can render a
    'common traps you've fallen for' block)."""
    captured = {}

    def fake_stream(stem, prompt, choices, correct, chosen, **kwargs):
        captured["kwargs"] = kwargs

        async def gen():
            yield "The correct answer is (B). A: trap\nB: correct\n"
        return gen()

    monkeypatch.setattr(ai, "stream_explanation", fake_stream)

    from app.db import engine
    from sqlmodel import Session

    with Session(engine) as s:
        prior_qid = _seed_trap_question(s, trap_type="reversal")
        current_qid = _seed_trap_question(s, trap_type="reversal")
        _log_wrong_attempt(s, question_id=prior_qid, chosen="A")

    r = client.post(
        "/api/ai/explain",
        json={"question_id": current_qid, "chosen_answer": "C"},
    )
    assert r.status_code == 200
    trap_misses = captured["kwargs"].get("trap_misses")
    assert trap_misses, "expected trap_misses forwarded into stream_explanation"
    assert any(m["question_id"] == prior_qid for m in trap_misses)
