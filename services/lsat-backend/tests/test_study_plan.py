"""Study plan + daily plan + score forecast."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlmodel import select

from app import analytics
from app.models import ActivityEvent


def test_plan_crud_and_today(client):
    # No plan initially.
    assert client.get("/api/study/plan").json()["has_plan"] is False

    exam = (date.today() + timedelta(days=45)).isoformat()
    r = client.put("/api/study/plan",
                   json={"target_score": 170, "exam_date": exam, "daily_minutes": 90})
    body = r.json()
    assert body["has_plan"] is True
    assert body["target_score"] == 170
    assert body["exam_date"] == exam

    got = client.get("/api/study/plan").json()
    assert got["target_score"] == 170

    today = client.get("/api/study/today").json()
    assert today["has_plan"] is True
    assert today["target_score"] == 170
    assert today["days_to_exam"] is not None and 40 <= today["days_to_exam"] <= 46
    assert isinstance(today["tasks"], list)
    assert "forecast" in today
    assert today["utility_model"] == "ability_engine_v2"
    assert today["ability_selector"]["model"] == "ability_engine_v2"
    assert today["ability_selector"]["utility"]["model"] == "ability_engine_v2_utility_v1"
    assert today["selector_summary"]["target_difficulty"] is not None
    assert today["selector_summary"]["utility_model"] == "ability_engine_v2_utility_v1"
    assert today["selector_summary"]["utility_score"] == today["ability_selector"]["utility"]["score"]


def test_plan_upsert_replaces_active(client):
    client.put("/api/study/plan", json={"target_score": 160})
    client.put("/api/study/plan", json={"target_score": 175})
    got = client.get("/api/study/plan").json()
    assert got["target_score"] == 175  # latest wins, single active plan


def test_today_feedback_persists_utility_task_event(client, db_session):
    r = client.post(
        "/api/study/today/feedback",
        json={
            "task_id": "drill-Flaw",
            "task_type": "drill",
            "task_label": "Drill Flaw",
            "action": "complete",
            "client_day": date.today().isoformat(),
            "minutes": 15,
            "q_type": "Flaw",
            "utility_score": 0.84,
            "utility_model": "ability_engine_v2_utility_v1",
            "target_difficulty": 0.62,
            "tradeoffs": ["Mastery gap 46%", "Uncertainty 21%"],
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "daily_plan_task_feedback"
    assert body["detail"]["action"] == "complete"
    assert body["detail"]["utility_score"] == 0.84
    assert body["detail"]["tradeoffs"] == ["Mastery gap 46%", "Uncertainty 21%"]

    rows = db_session.exec(
        select(ActivityEvent).where(ActivityEvent.kind == "daily_plan_task_feedback")
    ).all()
    assert rows
    assert rows[-1].detail_json["task_id"] == "drill-Flaw"


def test_today_plan_surfaces_feedback_evidence(client):
    client.put("/api/study/plan", json={"target_score": 170, "daily_minutes": 90})
    for action in ("complete", "complete", "skip"):
        r = client.post(
            "/api/study/today/feedback",
            json={
                "task_id": "drill-Flaw",
                "task_type": "drill",
                "task_label": "Drill Flaw",
                "action": action,
                "client_day": date.today().isoformat(),
                "minutes": 15,
                "q_type": "Flaw",
                "utility_score": 0.84,
                "utility_model": "ability_engine_v2_utility_v1",
            },
        )
        assert r.status_code == 200

    today = client.get("/api/study/today").json()
    feedback = today["selector_summary"]["feedback"]
    assert feedback["model"] == "ability_feedback_v1"
    assert feedback["total"] == 3
    assert feedback["completion_rate"] == 0.6667
    assert today["ability_selector"]["utility"]["signals"]["feedback_events"] == 3

    drill = next(task for task in today["tasks"] if task["type"] == "drill")
    assert drill["feedback_evidence"]["label"] == "Accepted 67%"
    assert drill["feedback_evidence"]["completion_rate"] == 0.6667
    assert {row["key"] for row in drill["feedback_evidence"]["impact"]} == {
        "mastery",
        "cadence",
        "readiness",
    }


def test_weighted_targets_use_longer_horizon_feedback_cohorts(db_session):
    from app import study_plan

    base = study_plan._weighted_targets(db_session)
    assert base
    q_type = base[0]["q_type"]
    now = datetime.now(timezone.utc)
    for idx, action in enumerate(("complete", "complete")):
        db_session.add(
            ActivityEvent(
                kind="daily_plan_task_feedback",
                status="done",
                title=f"{action}: Drill {q_type}",
                entity="study_plan",
                created_at=now - timedelta(days=20 + idx),
                detail_json={
                    "source": "today_plan",
                    "task_id": f"drill-{q_type}",
                    "task_type": "drill",
                    "task_label": f"Drill {q_type}",
                    "action": action,
                    "q_type": q_type,
                    "minutes": 15,
                    "utility_score": 0.82,
                    "utility_model": "ability_engine_v2_utility_v1",
                },
            )
        )
    db_session.commit()

    tuned = study_plan._weighted_targets(db_session)
    row = next(item for item in tuned if item["q_type"] == q_type)
    assert row["feedback_sequence_multiplier"] > 1
    assert row["feedback_cohort"]["completion_rate"] == 1.0
    assert row["feedback_cohort"]["sequencing_hint"] == "sequence_forward"


# --- LEARN-3 — unified daily plan spanning domains --------------------------
#
# When ``?include_host=true`` the /study/today plan folds the host's
# weakest-by-ability planes (CFA/Quant/Excel, via DATA-4a attempt snapshots) in
# as ``host_drill`` tasks, reranks the WHOLE list by one cross-domain utility,
# and packs to the merged DATA-6 SharedStudyProfile budget. The default path
# (no flag) must be byte-for-byte the historical LSAT-only plan.


def _seed_host_attempts(client, *, plane: str, n: int, correct: bool, topic: str) -> None:
    """Push ``n`` host attempt snapshots (DATA-4a) so ``ability_estimate(domain=
    plane)`` has evidence, plus one mastery snapshot so the drill names a topic."""
    snapshots = [
        {
            "crossId": f"{plane}:attempt:{i}",
            "domain": plane,
            "kind": "attempt",
            "payload": {
                "crossId": f"{plane}:attempt:{i}",
                "domain": plane,
                "questionCrossId": f"{plane}:question:{i}",
                "correct": correct,
                "elapsedSeconds": 40,
            },
        }
        for i in range(n)
    ]
    snapshots.append(
        {
            "crossId": f"{plane}:question:{topic}",
            "domain": plane,
            "kind": "mastery",
            "payload": {
                "crossId": f"{plane}:question:{topic}",
                "domain": plane,
                "masteryFraction": 0.2 if not correct else 0.9,
                "key": topic,
                "attempts": n,
            },
        }
    )
    r = client.post("/api/sync/progress-updates", json={"snapshots": snapshots})
    assert r.status_code == 200


def test_today_default_is_lsat_only_and_unchanged(client):
    """Default (no include_host) carries NO cross-domain keys and no host tasks."""
    # Even with host evidence present, the default plan ignores it entirely.
    _seed_host_attempts(client, plane="cfa", n=6, correct=False, topic="time-value")
    body = client.get("/api/study/today").json()
    # Additive LEARN-3 keys are absent on the LSAT-only path.
    assert "include_host" not in body
    assert "planes_merged" not in body
    assert "cross_domain" not in body
    assert "budget_source" not in body
    # No host_drill tasks leaked into the LSAT-only plan.
    assert all(task["type"] != "host_drill" for task in body["tasks"])


def test_today_include_host_merges_host_tasks(client):
    """include_host=true folds in weakest host planes as host_drill tasks and
    reranks the merged list by one cross-domain utility."""
    client.put("/api/study/plan", json={"target_score": 170, "daily_minutes": 180})
    # A weak CFA plane (low accuracy) and a strong Quant plane (high accuracy):
    # the weaker plane must outrank the stronger in the merged plan.
    _seed_host_attempts(client, plane="cfa", n=8, correct=False, topic="ethics")
    _seed_host_attempts(client, plane="quant", n=8, correct=True, topic="probability")

    body = client.get("/api/study/today?include_host=true").json()

    assert body["include_host"] is True
    # Both evidenced planes are merged in.
    assert set(body["planes_merged"]) >= {"cfa", "quant"}
    assert body["cross_domain"]["ranking"] == "cross_domain_utility_desc"
    assert body["cross_domain"]["utility_model"] == "ability_engine_v2"
    assert body["cross_domain"]["host_candidate_count"] >= 2

    host_tasks = [t for t in body["tasks"] if t["type"] == "host_drill"]
    assert host_tasks, "expected at least one host_drill task in the merged plan"
    assert body["host_task_count"] == len(host_tasks)
    # Each host task carries the SAME utility vocabulary the LSAT tasks do, plus
    # its plane + a concrete topic label and host weakness.
    cfa_task = next(t for t in host_tasks if t["domain"] == "cfa")
    assert cfa_task["utility_model"] == "ability_engine_v2"
    assert cfa_task["utility_score"] is not None
    assert cfa_task["host_evidence_n"] >= 1
    assert "ethics" in cfa_task["label"]
    # The whole merged list is sorted by cross-domain utility (DESC).
    scores = [float(t.get("utility_score") or 0.0) for t in body["tasks"]]
    assert scores == sorted(scores, reverse=True)


def test_today_include_host_packs_to_shared_profile_budget(client):
    """The merged plan sizes to the DATA-6 SharedStudyProfile daily_minutes when
    that budget decided the number (newer / different from the plan's own)."""
    # Plan starts small; the shared profile then sets a larger merged budget.
    client.put("/api/study/plan", json={"target_score": 170, "daily_minutes": 30})
    _seed_host_attempts(client, plane="cfa", n=6, correct=False, topic="derivatives")

    small = client.get("/api/study/today?include_host=true").json()
    assert small["cross_domain"]["base_minutes"] == 30

    # Raise the shared budget via the DATA-6 arbiter; the merged plan picks it up.
    client.put("/api/study/profile", json={"daily_minutes": 240})
    big = client.get("/api/study/today?include_host=true").json()
    assert big["cross_domain"]["base_minutes"] == 240
    assert big["budget_source"] == "shared_profile"
    # A bigger budget never produces a SMALLER packed day.
    assert big["estimated_minutes"] >= small["estimated_minutes"]


def test_today_include_host_no_host_evidence_is_lsat_subset(client):
    """With no host evidence, include_host=true returns the LSAT plan plus the
    (empty) cross-domain summary — never invents host tasks."""
    body = client.get("/api/study/today?include_host=true").json()
    assert body["include_host"] is True
    assert body["planes_merged"] == []
    assert body["host_task_count"] == 0
    assert all(task["type"] != "host_drill" for task in body["tasks"])


def test_forecast_endpoint_shape(client):
    r = client.get("/api/analytics/forecast?target_score=170")
    assert r.status_code == 200
    body = r.json()
    for key in ("current_score", "projected_score", "slope_per_week",
                "target_score", "gap_to_target", "n_points"):
        assert key in body
    assert body["target_score"] == 170


def test_forecast_linfit_projects_upward(db_session):
    # Two improving points 10 days apart -> positive slope, higher projection.
    out = analytics._linfit([0.0, 10.0], [150.0, 160.0])
    slope, intercept = out
    assert slope == 1.0
    assert intercept == 150.0
