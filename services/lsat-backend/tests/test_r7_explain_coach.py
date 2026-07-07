"""R7 Wave 3b — explanation + coach intelligence.

Covers: 2.6 self-checked explanations (pass / mismatch->regenerate->flag, and the
model_used/confidence/answer_checked provenance), 2.7 worked-exemplar RAG (injected
and no-op'd), 2.5 grounded question-referencing coach (context + varied
recommendation), and 2.4 the offline LLM-as-judge eval harness + golden set.

Every model call is a fake — nothing here touches real Ollama.
"""
from __future__ import annotations

import json

import pytest
from sqlmodel import Session, delete, select

from app import ai, coach, embeddings, eval as evalmod, pregenerate
from app.db import engine
from app.models import (
    AnswerChoice,
    Attempt,
    AttemptMode,
    AttemptRationale,
    ErrorLogEntry,
    ErrorReason,
    Explanation,
    ExplanationSource,
    Passage,
    PrepTest,
    Question,
    QuestionConversation,
    QuestionSource,
    Section,
    SectionType,
    SessionType,
    StudyArtifact,
    StudySession,
    TutorTurn,
)


# --- helpers ----------------------------------------------------------------
def _mk_question(session: Session, *, q_type="Weaken", correct="B",
                 source=QuestionSource.sample, stem="An argument here.") -> Question:
    q = Question(stem=stem, prompt=f"Which one most {q_type.lower()}s the argument?",
                 correct_answer=correct, q_type=q_type, source=source, approved=True)
    session.add(q)
    session.commit()
    session.refresh(q)
    for lbl in "ABCDE":
        session.add(AnswerChoice(question_id=q.id, label=lbl, text=f"choice {lbl}",
                                 is_correct=(lbl == correct)))
    session.commit()
    return q


def _mark_trap(session: Session, qid: int, label: str, trap_type: str) -> None:
    choice = session.exec(
        select(AnswerChoice)
        .where(AnswerChoice.question_id == qid)
        .where(AnswerChoice.label == label)
    ).one()
    choice.trap_type = trap_type
    session.add(choice)
    session.commit()


def _mk_rc_question(session: Session, *, passage_text: str, topic: str = "science",
                    q_type: str = "Detail", correct: str = "B",
                    source=QuestionSource.sample) -> Question:
    pt = PrepTest(name="RC explain test", source="sample", is_official=False)
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
        q_type=q_type,
        source=source,
        approved=True,
    )
    session.add(q)
    session.commit()
    session.refresh(q)
    for lbl in "ABCDE":
        session.add(AnswerChoice(question_id=q.id, label=lbl, text=f"choice {lbl}",
                                 is_correct=(lbl == correct)))
    session.commit()
    return q


def _parse_sse(text: str):
    return [json.loads(l[len("data: "):]) for l in text.splitlines()
            if l.startswith("data: ")]


# ===========================================================================
# 2.6 — self-checked explanations + calibration
# ===========================================================================
def test_asserted_letter_and_check():
    assert ai.asserted_letter("The correct answer is (B): foo.") == "B"
    assert ai.asserted_letter("...therefore the answer is C.") == "C"
    assert ai.asserted_letter("A: Correct, this bridges the gap.\nB: trap") == "A"
    assert ai.asserted_letter("no letter named here") is None

    assert ai.check_explanation("The correct answer is (B).", "B") == (True, "high")
    assert ai.check_explanation("The correct answer is (D).", "B") == (False, "low")
    # No asserted letter -> can't contradict -> honest medium, still "checked".
    assert ai.check_explanation("Some prose with no letter.", "B") == (True, "medium")


def test_pregenerate_passes_self_check_and_populates_provenance(db_session):
    q = _mk_question(db_session, correct="B")

    def good_gen(stem, prompt, choices, correct, chosen=None, context_notes=None,
                 exemplar=None):
        return ("The correct answer is (B) because it undermines the link.\n"
                "A: out of scope\nB: correct\nC: reversal\nD: too strong\nE: distractor")

    res = pregenerate.pregenerate_explanations(db_session, limit=50, generator=good_gen)
    assert res["explained"] >= 1 and res["flagged"] == 0

    exp = db_session.exec(
        select(Explanation).where(Explanation.question_id == q.id)
    ).first()
    assert exp is not None
    assert exp.answer_checked is True
    assert exp.confidence == "high"
    assert exp.model_used  # populated (the configured explain model)


def test_pregenerate_mismatch_regenerates_then_succeeds(db_session):
    q = _mk_question(db_session, correct="B")
    calls = {"n": 0}

    def flaky_gen(stem, prompt, choices, correct, chosen=None, context_notes=None,
                  exemplar=None):
        calls["n"] += 1
        if calls["n"] == 1:
            # First attempt asserts the WRONG letter -> must trigger a regenerate.
            return "The correct answer is (D). A: x\nB: y\nC: z\nD: correct\nE: w"
        return "The correct answer is (B). A: x\nB: correct\nC: z\nD: w\nE: v"

    res = pregenerate.pregenerate_explanations(db_session, limit=50, generator=flaky_gen)
    assert calls["n"] == 2          # regenerated exactly once
    assert res["explained"] >= 1 and res["flagged"] == 0
    exp = db_session.exec(
        select(Explanation).where(Explanation.question_id == q.id)
    ).first()
    assert exp.answer_checked is True and exp.confidence == "high"
    assert "(B)" in exp.body


def test_pregenerate_persistent_mismatch_is_flagged_not_cached(db_session):
    q = _mk_question(db_session, correct="B")
    calls = {"n": 0}

    def always_wrong(stem, prompt, choices, correct, chosen=None, context_notes=None,
                     exemplar=None):
        calls["n"] += 1
        return "The correct answer is (E). A: x\nB: y\nC: z\nD: w\nE: correct"

    res = pregenerate.pregenerate_explanations(db_session, limit=50, generator=always_wrong)
    assert calls["n"] == 2          # tried twice (generate + 1 regenerate)
    assert res["explained"] == 0 and res["flagged"] >= 1
    # Contradictory explanation was NOT cached as authoritative.
    assert db_session.exec(
        select(Explanation).where(Explanation.question_id == q.id)
    ).first() is None


def test_pregenerate_cache_unverified_stores_low_confidence(db_session):
    q = _mk_question(db_session, correct="B")

    def always_wrong(stem, prompt, choices, correct, **k):
        return "The correct answer is (E). A:x\nB:y\nC:z\nD:w\nE:correct"

    res = pregenerate.pregenerate_explanations(
        db_session, limit=50, generator=always_wrong, cache_unverified=True)
    assert res["explained"] >= 1
    exp = db_session.exec(
        select(Explanation).where(Explanation.question_id == q.id)
    ).first()
    assert exp is not None
    assert exp.answer_checked is False and exp.confidence == "low"


def test_explain_route_populates_and_surfaces_provenance(client, monkeypatch):
    async def fake_stream(stem, prompt, choices, correct, chosen=None, **kwargs):
        for tok in [f"The correct answer is ({correct}). ", "A: x\n", "B: correct\n"]:
            yield tok

    monkeypatch.setattr(ai, "stream_explanation", fake_stream)
    # q2 is seeded with an explanation; drop it to force the live path.
    with Session(engine) as s:
        s.exec(delete(Explanation).where(Explanation.question_id == 2))
        s.commit()

    r = client.post("/api/ai/explain", json={"question_id": 2})
    events = _parse_sse(r.text)
    done = [e for e in events if e.get("done")][0]
    assert done["answer_checked"] is True
    assert done["confidence"] == "high"
    assert done["model_used"]

    # The persisted explanation carries the provenance, and the cached path
    # surfaces it too.
    with Session(engine) as s:
        exp = s.exec(select(Explanation).where(Explanation.question_id == 2)).first()
        assert exp.answer_checked is True and exp.confidence == "high"
    r2 = client.post("/api/ai/explain", json={"question_id": 2})
    done2 = [e for e in _parse_sse(r2.text) if e.get("done")][0]
    assert done2["cached"] is True
    assert done2["answer_checked"] is True and done2["confidence"] == "high"


def test_explain_route_flags_contradictory_stream(client, monkeypatch):
    # Stream asserts the WRONG letter; q2's real answer is not 'E' for all, so
    # force a known mismatch by streaming a fixed wrong letter.
    async def wrong_stream(stem, prompt, choices, correct, chosen=None, **kwargs):
        wrong = "E" if correct != "E" else "A"
        yield f"The correct answer is ({wrong}). A: x\nB: y\n"

    monkeypatch.setattr(ai, "stream_explanation", wrong_stream)
    with Session(engine) as s:
        s.exec(delete(Explanation).where(Explanation.question_id == 2))
        s.commit()

    r = client.post("/api/ai/explain", json={"question_id": 2})
    done = [e for e in _parse_sse(r.text) if e.get("done")][0]
    assert done["answer_checked"] is False
    assert done["confidence"] == "low"


def test_explain_route_injects_safe_notebook_context(client, monkeypatch):
    captured = {}

    async def fake_stream(stem, prompt, choices, correct, chosen=None, **kwargs):
        captured["context_notes"] = kwargs.get("context_notes") or []
        yield f"The correct answer is ({correct}). A: trap\nB: correct\n"

    monkeypatch.setattr(ai, "stream_explanation", fake_stream)

    with Session(engine) as s:
        q = _mk_question(
            s,
            q_type="Weaken",
            correct="B",
            source=QuestionSource.sample,
            stem="Notebook context target stem.",
        )
        s.add(StudyArtifact(
            kind="note",
            title="Scope shift memo",
            body="Use the scope-shift memo when a choice changes the population.",
            summary="Scope-shift memo for wrong answer traps.",
            question_id=q.id,
            q_type="Weaken",
            official_firewall=False,
        ))
        s.add(StudyArtifact(
            kind="note",
            title="Official-only memo",
            body="OFFICIAL_ONLY_BODY_SHOULD_NOT_APPEAR",
            summary="OFFICIAL_ONLY_SUMMARY_SHOULD_NOT_APPEAR",
            question_id=q.id,
            q_type="Weaken",
            official_firewall=True,
        ))
        s.commit()
        qid = q.id

    r = client.post("/api/ai/explain", json={"question_id": qid})
    events = _parse_sse(r.text)
    done = [e for e in events if e.get("done")][0]

    joined = "\n".join(captured["context_notes"])
    assert "Scope shift memo" in joined
    assert "OFFICIAL_ONLY" not in joined
    assert done["notebook_context"]["count"] == 1
    assert done["notebook_context"]["items"][0]["title"] == "Scope shift memo"


# ===========================================================================
# 2.7 — worked-exemplar RAG in the explainer
# ===========================================================================
def test_exemplar_for_question_returns_similar_real_explanation(db_session):
    embeddings.reset_cache()
    # Two near-identical real questions, both with canonical explanations.
    q1 = _mk_question(db_session, q_type="Weaken", correct="B", stem="alpha alpha alpha")
    q2 = _mk_question(db_session, q_type="Weaken", correct="C", stem="alpha alpha beta")
    db_session.add(Explanation(question_id=q2.id, body="Canonical exemplar for q2.",
                               source=ExplanationSource.official))
    db_session.commit()

    vecs = {q1.id: [1.0, 0.0], q2.id: [0.99, 0.01]}
    for q in (q1, q2):
        embeddings.embed_question(db_session, q, embedder=lambda _t, _i=q.id: vecs[_i])

    ex = embeddings.exemplar_for_question(db_session, q1.id, min_score=0.5)
    assert ex is not None
    assert ex["question_id"] == q2.id           # the similar one, never q1 itself
    assert "Canonical exemplar for q2." in ex["explanation"]


def test_exemplar_never_same_question_and_noop_when_nothing_similar(db_session):
    embeddings.reset_cache()
    # A single embedded real question with an explanation: nothing else similar.
    q = _mk_question(db_session, q_type="Weaken", correct="B", stem="lonely lonely")
    db_session.add(Explanation(question_id=q.id, body="self explanation",
                               source=ExplanationSource.official))
    db_session.commit()
    embeddings.embed_question(db_session, q, embedder=lambda _t: [1.0, 0.0])

    # No other question -> similar_questions empty -> no exemplar (and never self).
    assert embeddings.exemplar_for_question(db_session, q.id) is None


def test_exemplar_noop_without_embeddings(db_session):
    embeddings.reset_cache()
    q = _mk_question(db_session, q_type="Weaken", correct="B")
    # No vectors stored at all -> graceful no-op.
    assert embeddings.exemplar_for_question(db_session, q.id) is None


def test_exemplar_skips_ai_generated_source(db_session):
    embeddings.reset_cache()
    q1 = _mk_question(db_session, q_type="Weaken", correct="B", stem="gamma gamma")
    # The only neighbour is ai_generated -> not an eligible exemplar source.
    q2 = _mk_question(db_session, q_type="Weaken", correct="C", stem="gamma delta",
                      source=QuestionSource.ai_generated)
    db_session.add(Explanation(question_id=q2.id, body="ai explanation",
                               source=ExplanationSource.ai))
    db_session.commit()
    vecs = {q1.id: [1.0, 0.0], q2.id: [0.99, 0.01]}
    for q in (q1, q2):
        embeddings.embed_question(db_session, q, embedder=lambda _t, _i=q.id: vecs[_i])
    assert embeddings.exemplar_for_question(db_session, q1.id, min_score=0.5) is None


def test_exemplar_injected_into_explain_prompt():
    ex = {"question_id": 9, "q_type": "Weaken", "explanation": "WORKED-EXEMPLAR-TEXT"}
    msgs = ai._explain_prompt("stem", "prompt",
                              [{"label": "A", "text": "a"}, {"label": "B", "text": "b"}],
                              "B", None, exemplar=ex)
    user = msgs[1]["content"]
    assert "WORKED-EXEMPLAR-TEXT" in user
    assert "similar question is explained" in user
    # And the "do not hedge" instruction is gone; honesty is requested instead.
    sys = msgs[0]["content"]
    assert "Do not hedge" not in sys
    assert "confidence honestly" in sys


def test_rc_passage_injected_into_explain_prompt():
    passage = "UNIQUE_RC_EVIDENCE " + ("evidence " * 800)
    msgs = ai._explain_prompt(
        "stem", "prompt",
        [{"label": "A", "text": "a"}, {"label": "B", "text": "b"}],
        "B", None, passage_text=passage, passage_topic="legal history",
    )

    sys = msgs[0]["content"]
    user = msgs[1]["content"]
    assert "Reading Comprehension" in sys
    assert "ground every factual claim in the passage" in sys
    assert "Reading Comprehension passage" in user
    assert "Topic: legal history" in user
    assert "UNIQUE_RC_EVIDENCE" in user
    assert "Passage truncated" in user


def test_explain_route_passes_rc_passage_to_stream(client, monkeypatch):
    captured = {}

    async def fake_stream(stem, prompt, choices, correct, chosen=None, **kwargs):
        captured.update(kwargs)
        yield f"The correct answer is ({correct}). A: trap\nB: correct\n"

    monkeypatch.setattr(ai, "stream_explanation", fake_stream)
    with Session(engine) as s:
        q = _mk_rc_question(
            s,
            passage_text="UNIQUE_ROUTE_PASSAGE says the critic concedes only one claim.",
            topic="legal history",
        )
        qid = q.id

    r = client.post("/api/ai/explain", json={"question_id": qid})
    assert r.status_code == 200
    assert "UNIQUE_ROUTE_PASSAGE" in captured["passage_text"]
    assert captured["passage_topic"] == "legal history"


def test_explain_route_injects_trap_similar_miss_context(client, monkeypatch):
    captured = {}

    async def fake_stream(stem, prompt, choices, correct, chosen=None, **kwargs):
        captured["context_notes"] = kwargs.get("context_notes") or []
        yield f"The correct answer is ({correct}). A: trap\nB: correct\n"

    monkeypatch.setattr(ai, "stream_explanation", fake_stream)
    with Session(engine) as s:
        current = _mk_question(
            s,
            q_type="Flaw",
            correct="D",
            stem="The current argument widens a committee claim to the whole council.",
        )
        prior = _mk_question(
            s,
            q_type="Flaw",
            correct="B",
            stem="The prior argument also shifts from a subgroup to the whole institution.",
        )
        _mark_trap(s, current.id, "A", "scope_shift")
        _mark_trap(s, prior.id, "C", "scope_shift")
        study = StudySession(type=SessionType.drill, config_json={})
        s.add(study)
        s.commit()
        s.refresh(study)
        miss = Attempt(
            question_id=prior.id,
            session_id=study.id,
            mode=AttemptMode.drill,
            chosen_answer="C",
            is_correct=False,
        )
        s.add(miss)
        s.commit()
        s.refresh(miss)
        s.add(
            ErrorLogEntry(
                attempt_id=miss.id,
                reason=ErrorReason.trap,
                user_note="I widened the committee claim into a claim about the whole council.",
            )
        )
        s.commit()
        qid = current.id

    r = client.post("/api/ai/explain", json={"question_id": qid, "chosen_answer": "A"})
    assert r.status_code == 200
    notes = captured["context_notes"]
    assert any("Past trap-similar miss" in n for n in notes)
    assert any("scope_shift" in n and "whole council" in n for n in notes)


def test_explain_route_injects_socratic_attempt_context_live_only(
    client, monkeypatch
):
    captured = {}

    async def fake_stream(stem, prompt, choices, correct, chosen=None, **kwargs):
        captured.update(kwargs)
        yield (
            f"The correct answer is ({correct}).\n"
            "A: trap\nB: correct\nC: trap\nD: trap\nE: trap\n"
        )

    monkeypatch.setattr(ai, "stream_explanation", fake_stream)
    with Session(engine) as s:
        q = _mk_question(
            s,
            q_type="Flaw",
            correct="B",
            stem="The author treats a correlation as proof of a cause.",
        )
        study = StudySession(type=SessionType.drill, config_json={})
        s.add(study)
        s.commit()
        s.refresh(study)
        attempt = Attempt(
            question_id=q.id,
            session_id=study.id,
            mode=AttemptMode.timed,
            chosen_answer="A",
            br_answer="C",
            is_correct=False,
        )
        s.add(attempt)
        s.commit()
        s.refresh(attempt)
        s.add(
            AttemptRationale(
                attempt_id=attempt.id,
                question_id=q.id,
                stage="blind_review",
                answer="C",
                trap_guess="correlation_causation",
                rationale_text=(
                    "I picked the answer that sounded like it proved the cause "
                    "because the two events moved together."
                ),
            )
        )
        conversation = QuestionConversation(
            question_id=q.id,
            attempt_id=attempt.id,
            mode="socratic",
            title="Correlation why loop",
        )
        s.add(conversation)
        s.commit()
        s.refresh(conversation)
        s.add(
            TutorTurn(
                conversation_id=conversation.id,
                role="student",
                content="I think A fixes the causal link.",
            )
        )
        s.add(
            TutorTurn(
                conversation_id=conversation.id,
                role="assistant",
                content="What evidence rules out a shared third cause?",
            )
        )
        s.commit()
        qid = q.id
        attempt_id = attempt.id

    r = client.post(
        "/api/ai/explain",
        json={"question_id": qid, "chosen_answer": "A", "attempt_id": attempt_id},
    )
    assert r.status_code == 200
    events = _parse_sse(r.text)
    done = [e for e in events if e.get("done")][0]

    context = captured["socratic_context"]
    assert context["attempt_id"] == attempt_id
    assert context["timed_answer"] == "A"
    assert context["blind_review_answer"] == "C"
    assert context["rationale"]["trap_guess"] == "correlation_causation"
    assert "events moved together" in context["rationale"]["text"]
    assert [t["role"] for t in context["recent_turns"]] == ["student", "assistant"]

    assert done["cached"] is False
    assert done["explanation_id"] is None
    assert done["socratic_context"]["personalized"] is True
    assert done["socratic_context"]["attempt_id"] == attempt_id
    assert done["socratic_context"]["rationale_count"] == 1
    assert done["socratic_context"]["turn_count"] == 2
    with Session(engine) as s:
        assert s.exec(
            select(Explanation).where(Explanation.question_id == qid)
        ).first() is None


def test_pregenerate_passes_rc_passage_to_generator(db_session):
    _mk_rc_question(
        db_session,
        passage_text="UNIQUE_PREGEN_PASSAGE links the author's concession to the answer.",
        topic="comparative law",
        source=QuestionSource.research,
    )
    seen: list[tuple[str | None, str | None]] = []

    def gen(stem, prompt, choices, correct, passage_text=None, passage_topic=None, **kwargs):
        seen.append((passage_text, passage_topic))
        return (
            f"The correct answer is ({correct}).\n"
            "A: trap\nB: correct\nC: trap\nD: trap\nE: trap"
        )

    res = pregenerate.pregenerate_explanations(db_session, limit=50, generator=gen)
    assert res["explained"] >= 1
    assert any(
        "UNIQUE_PREGEN_PASSAGE" in (text or "") and topic == "comparative law"
        for text, topic in seen
    )


# ===========================================================================
# 2.5 — grounded, question-referencing coach
# ===========================================================================
def test_coach_context_includes_specific_question_ids(db_session):
    ctx = coach.build_coach_context(db_session)
    assert ctx["has_data"] is True
    # Specific recent misses with ids + q_type the coach can reference.
    assert ctx["recent_misses"], "expected at least one specific recent miss"
    for m in ctx["recent_misses"]:
        assert isinstance(m["question_id"], int)
        assert m["q_type"]
    # The grounding prose names a concrete question id.
    assert any(f"Q{m['question_id']}" in ctx["summary"] for m in ctx["recent_misses"])
    # Weak types come from mastery (lower-bound ranked), not just a flat string.
    assert ctx["weak_types"] and "lower_bound" in ctx["weak_types"][0]


def test_coach_context_includes_safe_notebook_context(db_session):
    from app.models import StudyArtifact

    baseline = coach.build_coach_context(db_session)
    q_type = baseline["weak_types"][0]["q_type"]
    db_session.add(
        StudyArtifact(
            kind="note",
            title="Coach pattern memo",
            body="When coaching this type, ask for the conclusion first.",
            summary="Conclusion-first memo.",
            q_type=q_type,
            official_firewall=False,
        )
    )
    db_session.commit()

    ctx = coach.build_coach_context(db_session)

    assert ctx["notebook_context"]["count"] >= 1
    assert "Notebook context:" in ctx["summary"]
    assert "Coach pattern memo" in ctx["summary"]


def test_coach_context_includes_trap_similar_miss_retrieval(db_session):
    baseline = coach.build_coach_context(db_session)
    q_type = baseline["worst"] or "Weaken"
    current = _mk_question(
        db_session,
        q_type=q_type,
        correct="D",
        stem="A newer miss again broadens one agency's claim to all agencies.",
    )
    prior = _mk_question(
        db_session,
        q_type=q_type,
        correct="B",
        stem="An older miss confused one committee with the whole organization.",
    )
    _mark_trap(db_session, current.id, "A", "scope_shift")
    _mark_trap(db_session, prior.id, "C", "scope_shift")
    study = StudySession(type=SessionType.drill, config_json={})
    db_session.add(study)
    db_session.commit()
    db_session.refresh(study)
    prior_attempt = Attempt(
        question_id=prior.id,
        session_id=study.id,
        mode=AttemptMode.drill,
        chosen_answer="C",
        is_correct=False,
    )
    current_attempt = Attempt(
        question_id=current.id,
        session_id=study.id,
        mode=AttemptMode.drill,
        chosen_answer="A",
        is_correct=False,
    )
    db_session.add_all([prior_attempt, current_attempt])
    db_session.commit()
    db_session.refresh(prior_attempt)
    db_session.add(
        ErrorLogEntry(
            attempt_id=prior_attempt.id,
            reason=ErrorReason.trap,
            user_note="I broadened a narrow organization claim into a universal one.",
        )
    )
    db_session.commit()

    ctx = coach.build_coach_context(db_session, recent_misses=10)

    assert ctx["trap_similar_misses"]
    assert any(
        m["trap_type"] == "scope_shift"
        and "universal one" in (m.get("note_excerpt") or "")
        for m in ctx["trap_similar_misses"]
    )
    assert "Trap-similar miss retrieval:" in ctx["summary"]


def test_coach_context_includes_prior_explanation_recall(db_session):
    baseline = coach.build_coach_context(db_session)
    q_type = baseline["worst"] or "Weaken"
    q = _mk_question(
        db_session,
        q_type=q_type,
        correct="E",
        stem="A fresh miss where an alternate cause explains the result.",
    )
    study = StudySession(type=SessionType.drill, config_json={})
    db_session.add(study)
    db_session.commit()
    db_session.refresh(study)
    attempt = Attempt(
        question_id=q.id,
        session_id=study.id,
        mode=AttemptMode.drill,
        chosen_answer="A",
        is_correct=False,
    )
    db_session.add(attempt)
    db_session.commit()
    db_session.refresh(attempt)
    db_session.add(
        Explanation(
            question_id=q.id,
            body=(
                "The credited answer isolates the alternate cause instead of "
                "treating correlation as proof."
            ),
            source=ExplanationSource.ai,
        )
    )
    db_session.add(
        AttemptRationale(
            attempt_id=attempt.id,
            question_id=q.id,
            stage="blind_review",
            answer="A",
            rationale_text="I picked the answer that repeated the correlation.",
            trap_guess="causal_flaw",
        )
    )
    db_session.commit()

    ctx = coach.build_coach_context(db_session, recent_misses=10)

    assert ctx["explanation_recall"]
    kinds = {item["kind"] for item in ctx["explanation_recall"]}
    assert {"explanation", "rationale"}.issubset(kinds)
    assert "Prior explanation/rationale recall:" in ctx["summary"]
    assert "alternate cause" in ctx["summary"]
    assert "repeated the correlation" in ctx["summary"]


def test_coach_recommendation_varies_srs_drill_analytics(db_session):
    # SRS backlog wins.
    ctx_srs = {"has_data": True, "worst": "Weaken", "srs_due": 9,
               "blind_review_gap": {"gap": 0.0, "by_type": []},
               "calibration": {}, "top_trap": None}
    rec = coach.choose_recommendation(ctx_srs)
    assert rec["action"]["type"] == "srs"
    assert rec["action"]["payload"]["due"] == 9

    # Big BR gap -> blind_review on the worst-gap type.
    ctx_br = {"has_data": True, "worst": "Flaw", "srs_due": 0,
              "blind_review_gap": {"gap": 0.3, "by_type": [{"q_type": "Flaw"}]},
              "calibration": {}, "top_trap": None}
    assert coach.choose_recommendation(ctx_br)["action"]["type"] == "blind_review"

    # Overconfident -> analytics/calibration.
    ctx_cal = {"has_data": True, "worst": "Inference", "srs_due": 0,
               "blind_review_gap": {"gap": 0.0, "by_type": []},
               "calibration": {"verdict": "overconfident", "calibration_gap": 0.2},
               "top_trap": None}
    rec_cal = coach.choose_recommendation(ctx_cal)
    assert rec_cal["action"]["type"] == "analytics"

    # Nothing pressing -> drill the weakest type (default), preserving the shape.
    ctx_drill = {"has_data": True, "worst": "Parallel", "srs_due": 0,
                 "blind_review_gap": {"gap": 0.0, "by_type": []},
                 "calibration": {"verdict": "calibrated", "calibration_gap": 0.0},
                 "top_trap": {"trap_type": "reversal"}}
    rec_drill = coach.choose_recommendation(ctx_drill)
    assert rec_drill["action"]["type"] == "drill"
    assert rec_drill["action"]["payload"]["q_type"] == "Parallel"
    assert rec_drill["action"]["payload"]["trap_type"] == "reversal"
    # Shape preserved on every branch.
    for rec in (rec, rec_cal, rec_drill):
        assert set(rec) == {"label", "action"}
        assert set(rec["action"]) == {"type", "payload"}


def test_coach_refresh_grounded_snapshot_shape(db_session):
    snap = coach.refresh_snapshot(db_session, diagnoser=lambda summary: "Grounded advice.")
    assert snap.text == "Grounded advice."
    rec = snap.recommendation_json
    # Snapshot shape the DockedCoach reads is preserved.
    assert set(rec) == {"label", "action"}
    assert set(rec["action"]) == {"type", "payload"}
    # Seed data has a large BR gap -> varied (non-"start_drill") recommendation.
    assert rec["action"]["type"] in {"drill", "srs", "analytics", "blind_review"}


def test_coach_chat_route_grounds_on_specific_questions(client, monkeypatch):
    captured = {}

    async def fake_chat(summary, message, history=None):
        captured["summary"] = summary
        return "Look at your recent misses."

    monkeypatch.setattr(ai, "coach_chat", fake_chat)
    r = client.post("/api/ai/coach/chat", json={"message": "What should I do?"})
    assert r.status_code == 200
    assert r.json()["reply"] == "Look at your recent misses."   # {reply} shape preserved
    # The grounding summary handed to the model references a specific question id.
    assert "Q" in captured["summary"] and "Weakest types" in captured["summary"]


def test_coach_empty_state_recommends_start_section(db_session):
    # Wipe attempts -> no data -> graceful start_section recommendation.
    db_session.exec(delete(Attempt))
    db_session.commit()
    ctx = coach.build_coach_context(db_session)
    assert ctx["has_data"] is False
    rec = coach.choose_recommendation(ctx)
    assert rec["action"]["type"] == "start_section"


# ===========================================================================
# 2.4 — offline LLM-as-judge eval harness + golden set
# ===========================================================================
def _good_explainer(stem, prompt, choices, correct, **k):
    lines = [f"The correct answer is ({correct}) because it best fits the prompt."]
    for c in choices:
        lines.append(f"{c['label']}: {'correct' if c['label'] == correct else 'a trap'}")
    return "\n".join(lines)


def _fake_judge_factory(addresses=0.9, no_hallucination=1.0):
    def judge(prompt: str) -> str:
        return json.dumps({"addresses_each_choice": addresses,
                           "no_hallucination": no_hallucination,
                           "notes": "looks fine"})
    return judge


def test_eval_choice_coverage_and_golden_deterministic():
    body = ("The correct answer is (B).\nA: trap\nB: correct\nC: trap\nD: trap\nE: trap")
    labels = list("ABCDE")
    assert evalmod.choice_coverage(body, labels) == 1.0

    g = evalmod.check_golden(body, "Weaken", "B", labels)
    assert g["passed"] is True and g["asserts_correct"] is True

    # Asserts the wrong letter -> golden fails with a reason.
    bad = "The correct answer is (D).\nA: x\nB: x\nC: x\nD: correct\nE: x"
    gb = evalmod.check_golden(bad, "Weaken", "B", labels)
    assert gb["passed"] is False and "does_not_assert_correct" in gb["reasons"]


def test_score_explanation_with_injected_judge():
    choices = [{"label": l, "text": f"c{l}"} for l in "ABCDE"]
    body = _good_explainer("s", "p", choices, "B")
    scored = evalmod.score_explanation("s", "p", choices, "B", body,
                                       judge=_fake_judge_factory())
    assert scored["asserts_correct"] == 1.0            # deterministic
    assert scored["addresses_each_choice"] == 0.9      # from the judge
    assert scored["no_hallucination"] == 1.0
    assert 0.0 <= scored["overall"] <= 1.0
    # Weighted aggregate: 0.5*1 + 0.3*0.9 + 0.2*1.0
    assert scored["overall"] == 0.97


def test_run_eval_aggregates_and_golden(db_session):
    report = evalmod.run_eval(db_session, explainer=_good_explainer,
                              judge=_fake_judge_factory())
    assert report["n"] >= 1
    assert report["mean_asserts_correct"] == 1.0       # the explainer always names it
    assert report["mean_overall"] is not None
    assert report["golden_total"] >= 1
    assert report["golden_pass_rate"] == 1.0           # good explainer passes golden
    # Per-item detail is present and carries the golden verdict.
    assert all("golden" in it for it in report["items"])
    # A formatted report renders without error.
    assert "mean overall" in evalmod.format_report(report)


def test_release_floor_is_deterministic_and_offline(db_session):
    result = evalmod.run_release_floor(db_session)
    report = result["report"]

    assert result["ok"] is True
    assert result["issues"] == []
    assert report["n"] >= 1
    assert report["golden_total"] >= 1
    assert report["golden_passed"] == report["golden_total"]
    assert report["golden_pass_rate"] == 1.0
    assert report["mean_overall"] == 1.0


def test_release_floor_blocks_when_thresholds_are_not_met(db_session):
    result = evalmod.run_release_floor(db_session, min_mean_overall=1.01)

    assert result["ok"] is False
    assert "mean_overall_below_floor" in result["issues"]


def test_release_floor_cli_check_is_deterministic(db_session, capsys):
    evalmod._main(["--release-floor", "--check"])

    out = capsys.readouterr().out
    assert "LSATLab Tier-A explanation eval" in out
    assert "explanation_golden_floor ok=True" in out
    assert "golden_pass_rate=1.0" in out


def test_release_floor_cli_check_exits_nonzero_below_floor(db_session):
    with pytest.raises(SystemExit) as exc:
        evalmod._main(["--release-floor", "--check", "--min-mean-overall", "1.01"])

    assert exc.value.code == 1


def test_run_eval_passes_rc_passage_to_explainer_and_judge(db_session):
    _mk_rc_question(
        db_session,
        passage_text="UNIQUE_EVAL_PASSAGE says the historian rejects the broader thesis.",
        topic="legal history",
        q_type="RCUniqueEval",
    )
    captured = {"explainer": None, "judge": None}

    def explainer(stem, prompt, choices, correct, passage_text=None, **kwargs):
        captured["explainer"] = passage_text
        return _good_explainer(stem, prompt, choices, correct)

    def judge(prompt: str) -> str:
        captured["judge"] = prompt
        return json.dumps({"addresses_each_choice": 1.0,
                           "no_hallucination": 1.0,
                           "notes": "passage grounded"})

    report = evalmod.run_eval(db_session, explainer=explainer, judge=judge,
                              q_types=["RCUniqueEval"], limit=3)
    assert report["n"] == 1
    assert "UNIQUE_EVAL_PASSAGE" in captured["explainer"]
    assert "UNIQUE_EVAL_PASSAGE" in captured["judge"]


def test_run_eval_detects_bad_explainer(db_session):
    def wrong_explainer(stem, prompt, choices, correct, **k):
        wrong = "E" if correct != "E" else "A"
        return f"The correct answer is ({wrong}). A: x"   # wrong letter, no coverage

    report = evalmod.run_eval(db_session, explainer=wrong_explainer,
                              judge=_fake_judge_factory(addresses=0.1))
    assert report["mean_asserts_correct"] == 0.0       # never names the true answer
    assert report["golden_pass_rate"] == 0.0           # fails golden across the board


def test_eval_judge_parse_is_robust():
    # Judge wraps JSON in prose; parser still extracts it, clamps out-of-range.
    raw = 'Sure! {"addresses_each_choice": 1.5, "no_hallucination": -0.2} done'
    parsed = evalmod._parse_judge(raw)
    assert parsed["addresses_each_choice"] == 1.0      # clamped to [0,1]
    assert parsed["no_hallucination"] == 0.0
    # Garbage -> neutral 0.5 defaults, no crash.
    assert evalmod._parse_judge("not json at all")["addresses_each_choice"] == 0.5
