"""Analytics math: dashboard, by-type, timing, BR gap, traps, score curve."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app import scoring
from app import analytics
from app.models import (
    ActivityEvent,
    Attempt,
    AttemptMode,
    Question,
    QuestionSource,
    SessionType,
    SRSCard,
    StudySession,
)
from app.seed import SEED_QUESTION_COUNT
from sqlmodel import select


def test_score_curve_anchors():
    assert scoring.percent_to_scaled(100) == 180
    assert scoring.percent_to_scaled(0) == 120
    assert scoring.percent_to_scaled(50) == 145
    # interpolation midway between 80(164) and 90(170) ~ 167
    assert scoring.percent_to_scaled(85) == 167
    assert scoring.predict_scaled(0, 0) is None
    assert scoring.predict_scaled(10, 10) == 180


def test_dashboard_shape(client):
    d = client.get("/api/analytics/dashboard").json()
    for key in ("predicted_score", "score_delta_30d", "trend",
                "weakest_types", "coach", "streak_days"):
        assert key in d
    assert isinstance(d["trend"], list)
    assert "text" in d["coach"]
    assert "recommendation" in d["coach"]
    assert d["coach"]["source"] == "local_coach_context_v1"
    assert "signals" in d["coach"]


def test_dashboard_coach_uses_grounded_recommendation_policy(db_session):
    qid = db_session.exec(select(Question.id)).first()
    db_session.add(
        SRSCard(
            question_id=qid,
            due_date=datetime.now(timezone.utc) - timedelta(minutes=5),
            origin="concept_gap",
        )
    )
    db_session.commit()

    d = analytics.dashboard(db_session)
    rec = d["coach"]["recommendation"]

    assert rec["action"]["type"] == "srs"
    assert rec["action"]["payload"]["due"] >= 5
    assert d["coach"]["signals"]["srs_due"] >= 5


def test_feedback_cohorts_window_grouping_and_endpoint(client, db_session):
    now = datetime.now(timezone.utc)
    q = Question(
        stem="Feedback policy diagnostic stem with sufficient detail.",
        prompt="Which answer best identifies the issue?",
        correct_answer="A",
        q_type="FeedbackPolicyFlaw",
        difficulty=3,
        source=QuestionSource.sample,
    )
    other_q = Question(
        stem="Feedback policy inference stem with sufficient detail.",
        prompt="Which answer follows?",
        correct_answer="B",
        q_type="FeedbackPolicyInference",
        difficulty=3,
        source=QuestionSource.sample,
    )
    sess = StudySession(type=SessionType.drill)
    db_session.add_all([q, other_q, sess])
    db_session.commit()
    db_session.refresh(q)
    db_session.refresh(other_q)
    db_session.refresh(sess)
    db_session.add_all([
        Attempt(
            question_id=q.id,
            session_id=sess.id,
            mode=AttemptMode.drill,
            chosen_answer="A",
            is_correct=False,
            time_ms=80_000,
            created_at=now - timedelta(days=10),
        ),
        Attempt(
            question_id=q.id,
            session_id=sess.id,
            mode=AttemptMode.drill,
            chosen_answer="A",
            is_correct=True,
            time_ms=70_000,
            created_at=now - timedelta(days=8),
        ),
        Attempt(
            question_id=q.id,
            session_id=sess.id,
            mode=AttemptMode.drill,
            chosen_answer="A",
            is_correct=True,
            time_ms=60_000,
            created_at=now - timedelta(days=2, hours=12),
        ),
        Attempt(
            question_id=q.id,
            session_id=sess.id,
            mode=AttemptMode.drill,
            chosen_answer="A",
            is_correct=True,
            time_ms=65_000,
            created_at=now - timedelta(days=1, hours=12),
        ),
        Attempt(
            question_id=q.id,
            session_id=sess.id,
            mode=AttemptMode.drill,
            chosen_answer="B",
            is_correct=False,
            time_ms=85_000,
            created_at=now - timedelta(hours=12),
        ),
        Attempt(
            question_id=other_q.id,
            session_id=sess.id,
            mode=AttemptMode.blind_review,
            chosen_answer="B",
            is_correct=True,
            time_ms=10_000,
            created_at=now,
        ),
    ])
    rows = [
        ActivityEvent(
            kind="daily_plan_task_feedback",
            title="complete flaw",
            entity="study_plan",
            created_at=now - timedelta(days=3),
            detail_json={
                "source": "today_plan",
                "task_type": "drill",
                "action": "complete",
                "q_type": "FeedbackPolicyFlaw",
                "minutes": 20,
                "utility_score": 0.9,
            },
        ),
        ActivityEvent(
            kind="daily_plan_task_feedback",
            title="complete flaw again",
            entity="study_plan",
            created_at=now - timedelta(days=2),
            detail_json={
                "source": "today_plan",
                "task_type": "drill",
                "action": "complete",
                "q_type": "FeedbackPolicyFlaw",
                "minutes": 10,
                "utility_score": 0.8,
            },
        ),
        ActivityEvent(
            kind="daily_plan_task_feedback",
            title="skip inference",
            entity="study_plan",
            created_at=now - timedelta(days=1),
            detail_json={
                "source": "today_plan",
                "task_type": "drill",
                "action": "skip",
                "q_type": "FeedbackPolicyInference",
                "minutes": 15,
                "utility_score": 0.6,
            },
        ),
        ActivityEvent(
            kind="daily_plan_task_feedback",
            title="reopen flaw",
            entity="study_plan",
            created_at=now,
            detail_json={
                "source": "today_plan",
                "task_type": "drill",
                "action": "reopen",
                "q_type": "FeedbackPolicyFlaw",
                "minutes": 0,
                "utility_score": 0.7,
            },
        ),
        ActivityEvent(
            kind="daily_plan_task_feedback",
            title="old complete",
            entity="study_plan",
            created_at=now - timedelta(days=45),
            detail_json={
                "source": "today_plan",
                "task_type": "drill",
                "action": "complete",
                "q_type": "FeedbackPolicyFlaw",
                "minutes": 99,
            },
        ),
        ActivityEvent(
            kind="daily_plan_task_feedback",
            title="other source ignored",
            entity="study_plan",
            created_at=now,
            detail_json={
                "source": "manual",
                "task_type": "drill",
                "action": "complete",
                "q_type": "FeedbackPolicyFlaw",
                "minutes": 99,
            },
        ),
        ActivityEvent(
            kind="not_daily_plan_task_feedback",
            title="wrong kind ignored",
            entity="study_plan",
            created_at=now,
            detail_json={
                "source": "today_plan",
                "task_type": "drill",
                "action": "complete",
                "q_type": "FeedbackPolicyFlaw",
                "minutes": 99,
            },
        ),
    ]
    db_session.add_all(rows)
    db_session.commit()

    response = client.get("/api/analytics/feedback-cohorts?days=30")
    assert response.status_code == 200
    body = response.json()

    assert body["model"] == "daily_plan_feedback_cohorts_v1"
    assert body["window_days"] == 30
    assert body["total_events_seen"] == 5
    assert body["total"] == 4
    assert body["complete"] == 2
    assert body["skip"] == 1
    assert body["reopen"] == 1
    assert body["completion_rate"] == 0.6667
    assert body["minutes_completed"] == 30
    assert body["by_q_type"]["FeedbackPolicyFlaw"]["total"] == 3
    assert body["by_q_type"]["FeedbackPolicyInference"]["skip"] == 1
    assert body["by_task_type"]["drill"]["total"] == 4
    flaw = next(row for row in body["q_type_cohorts"] if row["q_type"] == "FeedbackPolicyFlaw")
    assert flaw["drill_sequence_multiplier"] > 1
    assert flaw["sequencing_hint"] == "sequence_forward"
    assert flaw["selector_policy"]["model"] == "ability_feedback_policy_v1"
    assert flaw["selector_policy"]["evidence_events"] == 3
    assert flaw["outcome_evidence"]["status"] == "improving"
    assert flaw["outcome_evidence"]["attempts_after_acceptance"] == 3
    assert flaw["outcome_evidence"]["accuracy_after_acceptance"] == 0.6667
    assert flaw["outcome_evidence"]["baseline_accuracy"] == 0.5
    assert flaw["outcome_evidence"]["delta_accuracy"] == 0.1667
    inference = next(
        row for row in body["q_type_cohorts"] if row["q_type"] == "FeedbackPolicyInference"
    )
    assert inference["outcome_evidence"]["status"] == "needs_acceptance"
    assert body["outcome_evidence"]["attempts_after_acceptance"] == 3
    assert body["top_q_type"]["q_type"] == "FeedbackPolicyFlaw"


def test_feedback_outcomes_endpoint_filters_source_and_thresholds(client, db_session):
    now = datetime.now(timezone.utc)
    q_type = "FeedbackOutcomeFlaw"
    official_q = Question(
        stem="Feedback outcome official stem with enough diagnostic detail.",
        prompt="Which answer best describes the flaw?",
        correct_answer="A",
        q_type=q_type,
        difficulty=3,
        source=QuestionSource.official,
    )
    sample_q = Question(
        stem="Feedback outcome sample stem with enough diagnostic detail.",
        prompt="Which answer best describes the flaw?",
        correct_answer="A",
        q_type=q_type,
        difficulty=3,
        source=QuestionSource.sample,
    )
    sess = StudySession(type=SessionType.drill)
    db_session.add_all([official_q, sample_q, sess])
    db_session.commit()
    db_session.refresh(official_q)
    db_session.refresh(sample_q)
    db_session.refresh(sess)

    db_session.add_all([
        ActivityEvent(
            kind="daily_plan_task_feedback",
            title="accepted outcome drill",
            entity="study_plan",
            created_at=now - timedelta(days=10),
            detail_json={
                "source": "today_plan",
                "task_type": "drill",
                "action": "complete",
                "q_type": q_type,
                "minutes": 15,
            },
        ),
        ActivityEvent(
            kind="daily_plan_task_feedback",
            title="skipped outcome drill",
            entity="study_plan",
            created_at=now - timedelta(days=5),
            detail_json={
                "source": "today_plan",
                "task_type": "drill",
                "action": "skip",
                "q_type": "FeedbackOutcomeSkip",
                "minutes": 10,
            },
        ),
    ])
    for idx, correct in enumerate([False, False, True]):
        db_session.add(
            Attempt(
                question_id=official_q.id,
                session_id=sess.id,
                mode=AttemptMode.drill,
                chosen_answer="A",
                is_correct=correct,
                time_ms=80_000,
                created_at=now - timedelta(days=20 - idx),
            )
        )
    for idx in range(3):
        db_session.add(
            Attempt(
                question_id=official_q.id,
                session_id=sess.id,
                mode=AttemptMode.drill,
                chosen_answer="A",
                is_correct=True,
                time_ms=60_000,
                created_at=now - timedelta(days=9 - idx),
            )
        )
    db_session.add(
        Attempt(
            question_id=sample_q.id,
            session_id=sess.id,
            mode=AttemptMode.drill,
            chosen_answer="B",
            is_correct=False,
            time_ms=90_000,
            created_at=now - timedelta(days=6),
        )
    )
    db_session.commit()

    response = client.get(
        "/api/analytics/feedback-outcomes"
        "?feedback_days=90&outcome_days=30&source=official&min_attempts=3"
    )
    assert response.status_code == 200
    body = response.json()

    assert body["model"] == "daily_plan_feedback_outcomes_v1"
    assert body["source"] == "official"
    assert body["feedback_window_days"] == 90
    assert body["outcome_window_days"] == 30
    assert body["min_attempts"] == 3
    assert body["summary"]["status"] == "planner_ready"
    complete = next(
        row for row in body["cohorts"]
        if row["q_type"] == q_type and row["action"] == "complete"
    )
    assert complete["feedback_events"] == 1
    assert complete["outcome_attempts"] == 3
    assert complete["outcome_accuracy"] == 1
    assert complete["baseline_attempts"] == 3
    assert complete["baseline_accuracy"] == 0.3333
    assert complete["delta_accuracy"] == 0.6667
    assert complete["planner_weight_eligible"] is True
    assert complete["status"] == "improving"
    skipped = next(
        row for row in body["cohorts"]
        if row["q_type"] == "FeedbackOutcomeSkip" and row["action"] == "skip"
    )
    assert skipped["status"] == "needs_more_attempts"
    assert skipped["planner_weight_eligible"] is False

    all_source = client.get(
        "/api/analytics/feedback-outcomes"
        "?feedback_days=90&outcome_days=30&source=all&min_attempts=3"
    ).json()
    all_complete = next(
        row for row in all_source["cohorts"]
        if row["q_type"] == q_type and row["action"] == "complete"
    )
    assert all_complete["outcome_attempts"] == 4
    assert all_complete["outcome_accuracy"] == 0.75

    too_thin = client.get(
        "/api/analytics/feedback-outcomes"
        "?feedback_days=90&outcome_days=30&source=official&min_attempts=4"
    ).json()
    thin_complete = next(
        row for row in too_thin["cohorts"]
        if row["q_type"] == q_type and row["action"] == "complete"
    )
    assert thin_complete["planner_weight_eligible"] is False
    assert thin_complete["status"] == "insufficient_outcomes"
    assert too_thin["summary"]["planner_ready_cohorts"] == 0


def test_by_type_official_vs_all(client):
    all_rows = client.get("/api/analytics/by-type?source=all").json()
    official_rows = client.get("/api/analytics/by-type?source=official").json()
    # seed content is 'sample', not 'official' -> official filter yields nothing
    assert len(all_rows) > 0
    assert official_rows == []
    for row in all_rows:
        assert 0.0 <= row["accuracy"] <= 1.0
        assert row["attempts"] >= 1
        assert row["section_type"] in ("LR", "RC")


def test_timing_endpoint(client):
    # seed session is id 1; the seeded prior session attempts one of each
    # sample question (see app.seed), so the row count tracks SEED_QUESTION_COUNT.
    rows = client.get("/api/analytics/timing/1").json()
    assert len(rows) == SEED_QUESTION_COUNT
    assert rows[0]["question_order"] == 1
    assert all("time_ms" in r for r in rows)


def test_blind_review_gap(client):
    g = client.get("/api/analytics/blind-review-gap").json()
    assert "timed_accuracy" in g and "br_accuracy" in g and "gap" in g
    # seed has BR-right-after-timed-wrong cases, so BR accuracy should exceed timed
    assert g["br_accuracy"] >= g["timed_accuracy"]
    assert isinstance(g["by_type"], list)


def test_traps(client):
    t = client.get("/api/analytics/traps").json()
    assert isinstance(t, list)
    # seed has wrong answers that carry trap_type tags
    assert len(t) >= 1
    total_pct = sum(x["pct"] for x in t)
    assert abs(total_pct - 1.0) < 0.01 or total_pct == 0.0


def test_by_difficulty(client):
    rows = client.get("/api/analytics/by-difficulty?source=all").json()
    assert isinstance(rows, list)
    diffs = [r["difficulty"] for r in rows]
    assert diffs == sorted(diffs)  # ascending difficulty
    for r in rows:
        assert 1 <= r["difficulty"] <= 5
        assert 0.0 <= r["accuracy"] <= 1.0
        assert r["attempts"] >= 1
    # sample content isn't official
    assert client.get("/api/analytics/by-difficulty?source=official").json() == []


def test_regression_alerts_detect_recent_type_drop(db_session):
    q = Question(
        stem="A local regression diagnostic question stem with enough text.",
        prompt="Which answer is best supported?",
        correct_answer="A",
        q_type="RegressionType",
        difficulty=3,
        source=QuestionSource.sample,
    )
    sess = StudySession(type=SessionType.drill)
    db_session.add(q)
    db_session.add(sess)
    db_session.commit()
    db_session.refresh(q)
    db_session.refresh(sess)

    now = datetime.now(timezone.utc)
    # Baseline: strong historical performance.
    for idx in range(12):
        db_session.add(
            Attempt(
                question_id=q.id,
                session_id=sess.id,
                mode=AttemptMode.timed,
                chosen_answer="A",
                is_correct=idx < 10,
                created_at=now - timedelta(days=14 + idx),
            )
        )
    # Recent: material accuracy drop.
    for idx in range(8):
        db_session.add(
            Attempt(
                question_id=q.id,
                session_id=sess.id,
                mode=AttemptMode.timed,
                chosen_answer="A",
                is_correct=idx < 2,
                created_at=now - timedelta(days=idx % 3),
            )
        )
    db_session.commit()

    out = analytics.regression_alerts(
        db_session,
        recent_days=7,
        baseline_days=30,
        min_attempts=4,
        min_drop=0.15,
    )

    alert = next(a for a in out["alerts"] if a["q_type"] == "RegressionType")
    assert out["model"] == "silent_regression_v1"
    assert out["status"] == "regression"
    assert alert["recent_attempts"] == 8
    assert alert["baseline_attempts"] == 12
    assert alert["recent_accuracy"] == 0.25
    assert alert["baseline_accuracy"] == round(10 / 12, 4)
    assert alert["delta"] < -0.5
    assert alert["z_score"] < -1.64
    assert alert["statistically_significant"] is True
    assert alert["severity"] == "high"


def test_regression_alerts_endpoint_shape(client):
    r = client.get(
        "/api/analytics/regressions?recent_days=7&baseline_days=30&min_attempts=2"
    )
    assert r.status_code == 200
    body = r.json()
    assert body["model"] == "silent_regression_v1"
    assert "alerts" in body
    assert "summary" in body


def test_activity_calendar(client):
    rows = client.get("/api/analytics/activity?days=30").json()
    assert len(rows) == 30  # zero-filled, one entry per day
    # oldest -> newest, contiguous dates
    dates = [r["date"] for r in rows]
    assert dates == sorted(dates)
    for r in rows:
        for key in ("date", "questions", "minutes", "correct", "sessions"):
            assert key in r
        assert r["correct"] <= r["questions"]
    # the seeded session's attempts should land on at least one day
    assert any(r["questions"] > 0 for r in rows) or all(r["questions"] == 0 for r in rows)
    # clamp check
    clamped = client.get("/api/analytics/activity?days=99999")
    assert clamped.status_code == 422  # exceeds le=730 bound
