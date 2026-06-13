"""vNext roadmap slice: adaptivity, tutor records, content health, migration integrity."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlmodel import select


def _first_question(client):
    pts = client.get("/api/preptests").json()
    pt = client.get(f"/api/preptests/{pts[0]['id']}").json()
    section = client.get(f"/api/sections/{pt['sections'][0]['id']}").json()
    return section["questions"][0]


def test_adaptivity_and_readiness_endpoints_do_not_leak_answers(client):
    ability = client.get("/api/adaptivity/ability").json()
    assert "overall" in ability
    assert ability["overall"]["model"] if "model" in ability["overall"] else True
    assert "weakest" in ability
    assert ability["selector"]["model"] == "ability_engine_v2"
    assert ability["selector"]["utility_model"] == "ability_engine_v2_utility_v1"
    assert ability["selector"]["utility"]["model"] == "ability_engine_v2_utility_v1"
    assert "srs_pressure" in ability["selector"]["utility"]["signals"]
    assert "mastery_slope_per_week" in ability["selector"]["utility"]["signals"]
    assert 1 <= ability["selector"]["zpd"]["target_difficulty"] <= 5

    next_payload = client.post("/api/adaptivity/next", json={"count": 3}).json()
    assert next_payload["count"] <= 3
    assert next_payload["selector"]["model"] == "ability_engine_v2"
    for rec in next_payload["recommendations"]:
        assert "expected_success" in rec
        assert "utility_score" in rec
        assert "zpd_fit" in rec
        assert "correct_answer" not in rec["question"]

    plan = client.post("/api/adaptivity/plan", json={"minutes": 60}).json()
    assert plan["utility_model"] == "ability_engine_v2"
    assert plan["utility"]["model"] == "ability_engine_v2_utility_v1"
    assert plan["ability_selector"]["zpd"]["target_success_window"] == [0.42, 0.78]
    assert all("utility" in task for task in plan["tasks"])

    readiness = client.get("/api/readiness?persist=false").json()
    assert 0 <= readiness["readiness_score"] <= 100
    assert "components" in readiness
    assert readiness["ability_selector"]["model"] == "ability_engine_v2"
    assert readiness["components"]["ability_selector_model"] == "ability_engine_v2"
    assert readiness["components"]["utility_model"] == "ability_engine_v2_utility_v1"
    assert readiness["utility"]["score"] == readiness["ability_selector"]["utility"]["score"]
    assert readiness["exam_simulation"]["model"] == "exam_readiness_v1"
    assert readiness["exam_simulation"]["exam_ready"] is readiness["exam_ready"]
    assert {
        "goal",
        "forecast",
        "mastery",
        "evidence",
        "blind_review",
        "calibration",
        "pacing",
        "srs",
        "plateau",
    }.issubset({row["key"] for row in readiness["exam_simulation"]["checks"]})
    assert "correct_answer" not in repr(readiness["exam_simulation"])


def test_daily_plan_feedback_adjusts_selector_utility(db_session):
    from app import adaptivity
    from app.models import ActivityEvent

    base = adaptivity.ability_selector(db_session, q_type="Flaw", days=180)
    assert base["utility"]["feedback"]["total"] == 0

    for action in ("complete", "complete", "skip", "reopen"):
        db_session.add(
            ActivityEvent(
                kind="daily_plan_task_feedback",
                status="done",
                title=f"{action}: Drill Flaw",
                detail_json={
                    "source": "today_plan",
                    "task_id": "drill-Flaw",
                    "task_type": "drill",
                    "task_label": "Drill Flaw",
                    "action": action,
                    "q_type": "Flaw",
                    "minutes": 15,
                    "utility_score": 0.8,
                    "utility_model": "ability_engine_v2_utility_v1",
                },
                entity="study_plan",
            )
        )
    db_session.add(
        ActivityEvent(
            kind="not_daily_plan_feedback",
            detail_json={"source": "today_plan", "action": "complete"},
        )
    )
    db_session.commit()

    selector = adaptivity.ability_selector(db_session, q_type="Flaw", days=180)
    feedback = selector["utility"]["feedback"]
    assert feedback["model"] == "ability_feedback_v1"
    assert feedback["total"] == 4
    assert feedback["complete"] == 2
    assert feedback["skip"] == 1
    assert feedback["reopen"] == 1
    assert 0 < feedback["selector_adjustment"] <= 0.08
    assert selector["utility"]["signals"]["feedback_events"] == 4
    assert selector["utility"]["signals"]["feedback_q_type_events"] == 4
    assert selector["utility"]["effective_weights"]["feedback_acceptance"] > 0
    assert {row["key"] for row in feedback["impact"]} == {
        "mastery",
        "cadence",
        "readiness",
    }


def test_readiness_uses_evidence_window_and_active_goal(db_session):
    from app import adaptivity
    from app.models import (
        Attempt,
        AttemptMode,
        Confidence,
        Question,
        QuestionSource,
        SessionType,
        StudyPlan,
        StudySession,
    )

    for row in db_session.exec(select(Attempt)).all():
        db_session.delete(row)
    db_session.commit()

    exam = (date.today() + timedelta(days=45)).isoformat()
    db_session.add(StudyPlan(target_score=170, exam_date=exam, daily_minutes=75, active=True))
    session = StudySession(type=SessionType.drill)
    db_session.add(session)
    db_session.commit()
    db_session.refresh(session)

    old_when = datetime.now(timezone.utc) - timedelta(days=120)
    recent_when = datetime.now(timezone.utc) - timedelta(days=10)
    for idx, when in enumerate([old_when] * 4 + [recent_when] * 3):
        q = Question(
            stem=f"readiness {idx}",
            prompt="Which choice follows?",
            correct_answer="A",
            difficulty=3,
            q_type="Flaw",
            source=QuestionSource.official,
            approved=True,
        )
        db_session.add(q)
        db_session.commit()
        db_session.refresh(q)
        db_session.add(
            Attempt(
                question_id=q.id,
                session_id=session.id,
                mode=AttemptMode.timed,
                chosen_answer="A" if idx % 2 == 0 else "B",
                is_correct=idx % 2 == 0,
                time_ms=70_000,
                confidence=Confidence.likely,
                created_at=when,
            )
        )
    db_session.commit()

    recent = adaptivity.readiness(db_session, days=30, persist=False)
    all_time = adaptivity.readiness(db_session, days=180, persist=False)

    assert recent["components"]["evidence_days"] == 30
    assert all_time["components"]["evidence_days"] == 180
    assert recent["components"]["attempts_90d"] == 3
    assert all_time["components"]["attempts_90d"] == 7
    assert recent["exam_simulation"]["target_score"] == 170
    assert recent["exam_simulation"]["exam_date"] == exam


def test_attempt_rationale_conversation_and_item_stats(client, db_session):
    from app.models import QuestionItemStats
    from sqlmodel import select

    q = _first_question(client)
    sid = client.post("/api/sessions", json={"type": "drill", "config": {}}).json()["id"]
    attempt = client.post(
        f"/api/sessions/{sid}/attempts",
        json={
            "question_id": q["id"],
            "mode": "drill",
            "chosen_answer": "A",
            "time_ms": 91000,
            "flagged": True,
            "confidence": "likely",
        },
    ).json()
    aid = attempt["attempt_id"]

    stats = db_session.exec(
        select(QuestionItemStats).where(QuestionItemStats.question_id == q["id"])
    ).first()
    assert stats is not None
    assert stats.attempts >= 1

    rationale = client.post(
        f"/api/attempts/{aid}/rationale",
        json={
            "stage": "blind_review",
            "answer": "A",
            "confidence": "likely",
            "rationale_text": "I thought the bypass explained the collision drop.",
            "trap_guess": "scope_shift",
        },
    )
    assert rationale.status_code == 200
    assert rationale.json()["attempt_id"] == aid

    conv = client.post(
        "/api/conversations",
        json={"question_id": q["id"], "attempt_id": aid},
    ).json()
    turn = client.post(
        f"/api/conversations/{conv['id']}/turns",
        json={"role": "user", "content": "Why is my answer vulnerable?"},
    ).json()
    assert turn["reply"]["role"] == "assistant"
    assert "answer key" not in turn["reply"]["content"].lower()


def test_socratic_reply_persists_similar_miss_context(db_session):
    from sqlmodel import select

    from app import adaptivity
    from app.models import (
        Attempt,
        AttemptMode,
        AttemptRationale,
        Confidence,
        Question,
        QuestionSource,
        SessionType,
        StudyArtifact,
        StudySession,
    )

    current = db_session.exec(select(Question)).first()
    db_session.add(
        StudyArtifact(
            kind="note",
            title="Scope shift notebook",
            body="Check whether the answer preserves the same actor and scope.",
            summary="Actor and scope check.",
            q_type=current.q_type,
            official_firewall=False,
        )
    )
    prior = Question(
        stem="A policy argument shifts from one committee to the whole council.",
        prompt="Which flaw is most vulnerable?",
        correct_answer="D",
        difficulty=current.difficulty,
        q_type=current.q_type,
        source=QuestionSource.research,
    )
    study = StudySession(type=SessionType.drill, config_json={})
    db_session.add(prior)
    db_session.add(study)
    db_session.commit()
    db_session.refresh(prior)
    db_session.refresh(study)

    prior_attempt = Attempt(
        question_id=prior.id,
        session_id=study.id,
        mode=AttemptMode.drill,
        chosen_answer="B",
        is_correct=False,
        confidence=Confidence.guess,
    )
    current_attempt = Attempt(
        question_id=current.id,
        session_id=study.id,
        mode=AttemptMode.drill,
        chosen_answer="A",
        is_correct=False,
        confidence=Confidence.guess,
    )
    db_session.add(prior_attempt)
    db_session.add(current_attempt)
    db_session.commit()
    db_session.refresh(prior_attempt)
    db_session.refresh(current_attempt)

    db_session.add(
        AttemptRationale(
            attempt_id=prior_attempt.id,
            question_id=prior.id,
            stage="blind_review",
            answer="B",
            confidence=Confidence.guess,
            rationale_text="I overread the narrow committee claim as proving a broader council claim.",
            trap_guess="scope_shift",
        )
    )
    db_session.add(
        AttemptRationale(
            attempt_id=current_attempt.id,
            question_id=current.id,
            stage="blind_review",
            answer="A",
            confidence=Confidence.guess,
            rationale_text="The attractive choice sounded necessary.",
            trap_guess="too_strong",
        )
    )
    db_session.commit()

    conv = adaptivity.start_conversation(
        db_session,
        question_id=current.id,
        attempt_id=current_attempt.id,
    )
    first = adaptivity.add_tutor_turn(
        db_session,
        conversation_id=conv.id,
        role="user",
        content="Why is my tempting answer wrong?",
    )

    reply = first["reply"]
    assert reply["role"] == "assistant"
    assert reply["meta"]["model"] == "deterministic_socratic_v2"
    context = reply["meta"]["socratic_context"]
    assert context["answer_key_hidden"] is True
    assert context["prior_turn_count"] == 0
    assert context["similar_misses"][0]["question_id"] == prior.id
    assert context["similar_misses"][0]["trap_guess"] == "scope_shift"
    assert context["notebook_context"]["count"] >= 1
    assert context["notebook_context"]["items"][0]["title"] == "Scope shift notebook"
    assert "correct_answer" not in repr(context)
    assert "answer key" not in reply["content"].lower()
    assert "recent" in reply["content"].lower()
    assert "Notebook note" in reply["content"]

    second = adaptivity.add_tutor_turn(
        db_session,
        conversation_id=conv.id,
        role="user",
        content="I think I framed the conclusion too broadly.",
    )
    second_context = second["reply"]["meta"]["socratic_context"]
    assert second_context["prior_turn_count"] == 2
    assert any(
        row["role"] == "user" and "tempting answer" in row["content"]
        for row in second_context["recent_turns"]
    )


def test_socratic_similar_miss_prefers_cached_semantic_match(db_session):
    from sqlmodel import select

    from app import adaptivity, embeddings
    from app.models import (
        Attempt,
        AttemptMode,
        Confidence,
        Question,
        QuestionSource,
        SessionType,
        StudySession,
    )

    current = db_session.exec(select(Question)).first()
    semantic = Question(
        stem="The argument confuses a necessary condition for a sufficient one.",
        prompt="Which flaw is present?",
        correct_answer="C",
        difficulty=current.difficulty,
        q_type=current.q_type,
        source=QuestionSource.research,
    )
    recent = Question(
        stem="A different flaw about sampling is described.",
        prompt="Which flaw is present?",
        correct_answer="E",
        difficulty=current.difficulty,
        q_type=current.q_type,
        source=QuestionSource.research,
    )
    study = StudySession(type=SessionType.drill, config_json={})
    db_session.add_all([semantic, recent, study])
    db_session.commit()
    db_session.refresh(semantic)
    db_session.refresh(recent)
    db_session.refresh(study)

    older_semantic_attempt = Attempt(
        question_id=semantic.id,
        session_id=study.id,
        mode=AttemptMode.drill,
        chosen_answer="B",
        is_correct=False,
        confidence=Confidence.guess,
    )
    newer_recent_attempt = Attempt(
        question_id=recent.id,
        session_id=study.id,
        mode=AttemptMode.drill,
        chosen_answer="A",
        is_correct=False,
        confidence=Confidence.guess,
    )
    current_attempt = Attempt(
        question_id=current.id,
        session_id=study.id,
        mode=AttemptMode.drill,
        chosen_answer="D",
        is_correct=False,
        confidence=Confidence.guess,
    )
    db_session.add_all([older_semantic_attempt, newer_recent_attempt, current_attempt])
    db_session.commit()
    db_session.refresh(current_attempt)

    embeddings.embed_question(db_session, current, embedder=lambda _text: [1.0, 0.0])
    embeddings.embed_question(db_session, semantic, embedder=lambda _text: [0.98, 0.02])
    embeddings.embed_question(db_session, recent, embedder=lambda _text: [0.0, 1.0])

    conv = adaptivity.start_conversation(
        db_session,
        question_id=current.id,
        attempt_id=current_attempt.id,
    )
    result = adaptivity.add_tutor_turn(
        db_session,
        conversation_id=conv.id,
        role="user",
        content="I'm stuck between two answers.",
    )

    misses = result["reply"]["meta"]["socratic_context"]["similar_misses"]
    assert misses[0]["question_id"] == semantic.id
    assert misses[0]["matched_by"] == "semantic"
    assert misses[0]["similarity"] > 0.9


def test_socratic_context_includes_rc_passage_and_trap_similar_miss(db_session):
    from app import adaptivity
    from app.models import (
        AnswerChoice,
        Attempt,
        AttemptMode,
        AttemptRationale,
        Confidence,
        Passage,
        PrepTest,
        Question,
        QuestionSource,
        Section,
        SectionType,
        SessionType,
        StudySession,
    )

    pt = PrepTest(name="RC Socratic PT", source="research", is_official=False)
    db_session.add(pt)
    db_session.commit()
    db_session.refresh(pt)
    section = Section(preptest_id=pt.id, type=SectionType.RC, order=1)
    db_session.add(section)
    db_session.commit()
    db_session.refresh(section)
    current_passage = Passage(
        section_id=section.id,
        text=(
            "The passage contrasts a conservation board's narrow permit rule "
            "with a broader public-interest justification for watershed planning."
        ),
        type="single",
        topic="watershed permits",
    )
    prior_passage = Passage(
        section_id=section.id,
        text="A historical passage contrasts a critic's narrow claim with a broader thesis.",
        type="single",
        topic="historical criticism",
    )
    db_session.add_all([current_passage, prior_passage])
    db_session.commit()
    db_session.refresh(current_passage)
    db_session.refresh(prior_passage)

    current = Question(
        section_id=section.id,
        passage_id=current_passage.id,
        stem="The board's permit rule applies only to wetlands inside city limits.",
        prompt="Which choice most strongly supports the board's reasoning?",
        correct_answer="E",
        difficulty=3,
        q_type="Inference",
        source=QuestionSource.research,
    )
    prior = Question(
        section_id=section.id,
        passage_id=prior_passage.id,
        stem="The critic's point applies only to one chapter of the biography.",
        prompt="Which answer best captures the author's reasoning?",
        correct_answer="A",
        difficulty=3,
        q_type="Inference",
        source=QuestionSource.research,
    )
    study = StudySession(type=SessionType.drill, config_json={})
    db_session.add_all([current, prior, study])
    db_session.commit()
    db_session.refresh(current)
    db_session.refresh(prior)
    db_session.refresh(study)

    for qid in [current.id, prior.id]:
        for label in ["A", "B", "C", "D", "E"]:
            db_session.add(
                AnswerChoice(
                    question_id=qid,
                    label=label,
                    text=f"choice {label}",
                    is_correct=(qid == current.id and label == "E")
                    or (qid == prior.id and label == "A"),
                    trap_type="scope_shift" if label == "B" else None,
                )
            )
    db_session.commit()

    prior_attempt = Attempt(
        question_id=prior.id,
        session_id=study.id,
        mode=AttemptMode.drill,
        chosen_answer="B",
        is_correct=False,
        confidence=Confidence.guess,
    )
    current_attempt = Attempt(
        question_id=current.id,
        session_id=study.id,
        mode=AttemptMode.drill,
        chosen_answer="B",
        is_correct=False,
        confidence=Confidence.guess,
    )
    db_session.add_all([prior_attempt, current_attempt])
    db_session.commit()
    db_session.refresh(prior_attempt)
    db_session.refresh(current_attempt)
    db_session.add_all(
        [
            AttemptRationale(
                attempt_id=prior_attempt.id,
                question_id=prior.id,
                stage="blind_review",
                answer="B",
                confidence=Confidence.guess,
                rationale_text="I let a one-chapter claim stand in for the whole book.",
                trap_guess="scope_shift",
            ),
            AttemptRationale(
                attempt_id=current_attempt.id,
                question_id=current.id,
                stage="blind_review",
                answer="B",
                confidence=Confidence.guess,
                rationale_text="I treated the narrow permit rule as broader than it was.",
                trap_guess="scope_shift",
            ),
        ]
    )
    db_session.commit()

    conv = adaptivity.start_conversation(
        db_session,
        question_id=current.id,
        attempt_id=current_attempt.id,
    )
    result = adaptivity.add_tutor_turn(
        db_session,
        conversation_id=conv.id,
        role="user",
        content="I'm stuck on how the passage supports this.",
    )
    reply = result["reply"]
    context = reply["meta"]["socratic_context"]

    question_context = context["question_context"]
    assert question_context["section_type"] == "RC"
    assert question_context["passage_topic"] == "watershed permits"
    assert "conservation board" in question_context["passage_excerpt"]
    assert context["similar_misses"][0]["question_id"] == prior.id
    assert context["similar_misses"][0]["matched_by"] == "trap_type"
    assert context["similar_misses"][0]["trap_type"] == "scope_shift"
    assert context["similar_misses"][0]["trap_guess"] == "scope_shift"
    assert "For RC" in reply["content"]
    assert "correct_answer" not in repr(context)
    assert "is_correct" not in repr(context)


def test_content_health_and_migration_integrity(client, db_session):
    from app import backup

    health = client.get("/api/content/health").json()
    assert health["total_questions"] >= 1
    assert health["official_firewall"]["ok"] is True
    assert "validator_coverage" in health

    report = backup.migration_report()
    assert report["schema_migration_integrity_table"] is True
    assert report["failed"] == []
    assert report["running"] == []
    assert report["latest_expected_version"] >= 15
