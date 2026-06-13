"""R6 Wave-4 backend: Q4 RC authenticity, Q5 AI-drift watch, X3 coach chat,
D5 soft-delete, D3 atomic dedup, Q6 cloud-routing hints."""
from __future__ import annotations

import pytest
from sqlmodel import Session

from app.db import engine


# --- Q4: RC authenticity ----------------------------------------------------
def test_rc_authenticity_flags_degenerate():
    from app import generation
    short = generation.rc_authenticity("Too short.")
    assert short["ok"] is False
    assert "too_short" in short["flags"] and "too_few_sentences" in short["flags"]

    # Wave 2.3 hard gate requires >=250 words; this passage is ~290 with varied
    # sentence lengths so FKGL and stdev checks pass comfortably.
    passage = (
        "Historians have long debated the causes of the rapid urban growth that "
        "transformed the region during the nineteenth century. Some attribute it "
        "primarily to industrialization, arguing that factories drew rural workers "
        "into expanding cities. Others emphasize agricultural innovation, which "
        "freed labor from the countryside and made surplus food available to feed "
        "dense populations. A third group points to improvements in transportation, "
        "noting that railways connected distant markets and lowered the cost of "
        "moving goods. Recent scholarship suggests these explanations are not "
        "mutually exclusive. Instead, a feedback loop likely emerged: cheaper "
        "transport encouraged manufacturing, manufacturing attracted migrants, and "
        "growing cities demanded ever more efficient agriculture. Critics of this "
        "synthesis caution that it risks obscuring regional differences, since the "
        "pace and character of growth varied considerably from one province to "
        "another. Nevertheless, the integrated account has gained wide acceptance "
        "because it accommodates evidence that earlier single-cause theories struggled "
        "to explain. Demographers add another dimension by tracing patterns of "
        "internal migration, showing that newcomers often clustered near kin already "
        "established in particular districts. Economic historians, meanwhile, have "
        "reconstructed wage series indicating that urban earnings, though volatile, "
        "generally exceeded rural alternatives during the period. Taken together, "
        "these strands of evidence portray a process far more contingent and uneven "
        "than the tidy narratives of progress that dominated earlier textbooks. "
        "Public-health planners, who once treated the problem as one of paving "
        "choices alone, now appeal for greener corridors, lighter roofing, and "
        "tighter building envelopes — interventions that target each of the three "
        "principal forcings simultaneously rather than serially."
    )
    good = generation.rc_authenticity(passage)
    assert good["ok"] is True
    assert good["score"] > 0.6 and good["n_words"] > 150


def test_validate_candidate_records_rc_authenticity():
    from app import generation
    cand = {
        "passage": "p " * 5,
        "stem": "x" * 40, "prompt": "Which?", "correct_answer": "B",
        "choices": [
            {
                "label": l,
                "text": "even length choice text here",
                "trap_type": "none" if l == "B" else {
                    "A": "opposite",
                    "C": "reversal",
                    "D": "out_of_scope",
                    "E": "degree",
                }[l],
            }
            for l in "ABCDE"
        ],
    }
    report = generation.validate_candidate(
        cand, runs=1, solver=lambda _p: "B",
        critic=lambda _p: '{"single_defensible": true, "defensible_letters": ["B"]}',
    )
    assert "rc_authenticity" in report["checks"]


# --- Q5: AI drift watch -----------------------------------------------------
def test_ai_drift_flags_low_accuracy(db_session):
    from app import generation
    from app.models import (
        Attempt, AttemptMode, Question, QuestionSource, SessionType, StudySession,
    )

    q = Question(stem="s" * 40, prompt="p", correct_answer="A", q_type="Weaken",
                 source=QuestionSource.ai_generated, approved=True, quarantined=False)
    db_session.add(q)
    db_session.commit()
    db_session.refresh(q)

    sess = StudySession(type=SessionType.drill)
    db_session.add(sess)
    db_session.commit()
    db_session.refresh(sess)
    for _ in range(5):
        db_session.add(Attempt(question_id=q.id, session_id=sess.id,
                               mode=AttemptMode.timed, is_correct=False))
    db_session.commit()

    rep = generation.ai_drift_report(db_session, min_attempts=4, floor=0.4)
    assert any(f["question_id"] == q.id for f in rep["flagged"])


def test_drift_and_requarantine_endpoints(client):
    from app.models import Question, QuestionSource
    with Session(engine) as s:
        q = Question(stem="s" * 40, prompt="p", correct_answer="A", q_type="Weaken",
                     source=QuestionSource.ai_generated, approved=True, quarantined=False)
        s.add(q)
        s.commit()
        s.refresh(q)
        qid = q.id

    assert client.get("/api/gen/drift").status_code == 200
    assert client.post(f"/api/gen/quarantine/{qid}/requarantine").status_code == 200
    with Session(engine) as s:
        assert s.get(Question, qid).quarantined is True


# --- X3: coach chat ---------------------------------------------------------
def test_coach_chat(client, monkeypatch):
    async def fake(summary, message, history=None):
        return f"coached: {message}"

    monkeypatch.setattr("app.ai.coach_chat", fake)
    r = client.post("/api/ai/coach/chat", json={"message": "how am I doing on Weaken?"})
    assert r.status_code == 200 and "coached:" in r.json()["reply"]
    assert client.post("/api/ai/coach/chat", json={"message": "  "}).status_code == 400


# --- D5: soft-delete --------------------------------------------------------
def test_soft_delete_excludes_from_servable(client):
    from app import generation
    from app.models import Question, QuestionSource
    with Session(engine) as s:
        q = Question(stem="s" * 40, prompt="p", correct_answer="A", q_type="ZZTestType",
                     source=QuestionSource.sample)
        s.add(q)
        s.commit()
        s.refresh(q)
        qid = q.id
        assert generation.servable_count(s, "ZZTestType") == 1

    assert client.delete(f"/api/questions/{qid}").status_code == 200
    with Session(engine) as s:
        assert generation.servable_count(s, "ZZTestType") == 0
    assert client.post(f"/api/questions/{qid}/restore").status_code == 200
    with Session(engine) as s:
        assert generation.servable_count(s, "ZZTestType") == 1


# --- D3: atomic dedup -------------------------------------------------------
def test_duplicate_content_hash_rejected(db_session):
    from app.models import Question, QuestionSource
    db_session.add(Question(stem="a" * 40, prompt="p", correct_answer="A",
                            q_type="Weaken", source=QuestionSource.sample,
                            content_hash="DUPHASH"))
    db_session.commit()
    db_session.add(Question(stem="b" * 40, prompt="p", correct_answer="A",
                            q_type="Weaken", source=QuestionSource.sample,
                            content_hash="DUPHASH"))
    with pytest.raises(Exception):
        db_session.commit()
    db_session.rollback()


def test_null_content_hash_allows_many(db_session):
    from app.models import Question, QuestionSource
    for _ in range(3):
        db_session.add(Question(stem="c" * 40, prompt="p", correct_answer="A",
                                q_type="Weaken", source=QuestionSource.sample,
                                content_hash=None))
    db_session.commit()  # partial unique index ignores NULLs → no error


# --- Q6: cloud-routing hints ------------------------------------------------
def test_generation_quality_recommends_cloud_for_hard_types(db_session):
    from app import generation
    from app.models import GenJob, GenStatus
    db_session.add(GenJob(
        q_type="Parallel", count=4, status=GenStatus.done,
        validation_report={"candidates": [
            {"passed": False, "reason": "self_consistency"},
            {"passed": False, "reason": "ambiguous_answer"},
            {"passed": False, "reason": "length_tell"},
            {"passed": True},
        ]},
    ))
    db_session.commit()
    q = generation.generation_quality(db_session)
    assert "Parallel" in q["cloud_recommended_types"]
