"""PSY-2 — what-if exam-plan simulator (POST /api/study/simulate).

The simulator must be PURE: it previews the effect of plan edits on projected
readiness without writing anything. These tests assert (1) it never mutates the
DB or the active plan, (2) the comparison + delta math reuses the shared forecast,
and (3) the time-budget / topic-mix edits move the modelled slope in the right
direction with the documented bounds.
"""
from __future__ import annotations

from datetime import date, timedelta

from sqlmodel import select

from app.models import StudyPlan


def _exam_in(days: int) -> str:
    return (date.today() + timedelta(days=days)).isoformat()


def test_simulate_is_pure_no_write(client):
    # Establish a plan so there's a baseline to compare against.
    client.put("/api/study/plan",
               json={"target_score": 168, "exam_date": _exam_in(60), "daily_minutes": 60})

    before_plan = client.get("/api/study/plan").json()

    body = {"edits": {"daily_minutes": 120, "target_score": 172}}
    r = client.post("/api/study/simulate", json=body)
    assert r.status_code == 200
    out = r.json()
    assert out["ok"] is True
    assert out["mutated"] is False
    assert out["has_plan"] is True

    # The active plan is UNCHANGED — the simulator wrote nothing.
    after_plan = client.get("/api/study/plan").json()
    assert after_plan == before_plan
    assert after_plan["target_score"] == 168
    assert after_plan["daily_minutes"] == 60


def test_simulate_idempotent_same_body(client):
    client.put("/api/study/plan",
               json={"target_score": 165, "exam_date": _exam_in(45), "daily_minutes": 90})
    body = {"edits": {"daily_minutes": 45, "weak_topic_focus": 0.8}}
    first = client.post("/api/study/simulate", json=body).json()
    second = client.post("/api/study/simulate", json=body).json()
    assert first == second


def test_simulate_more_time_raises_effective_slope(client):
    client.put("/api/study/plan",
               json={"target_score": 170, "exam_date": _exam_in(90), "daily_minutes": 60})
    out = client.post("/api/study/simulate",
                      json={"edits": {"daily_minutes": 240}}).json()
    base = out["baseline"]
    proj = out["projected"]
    # Doubling+ the budget lifts the modelled multiplier above 1.0...
    assert proj["slope_multiplier"] > 1.0
    # ...but is clamped (a 4x budget can't more than ~double the rate).
    assert proj["slope_multiplier"] <= 2.0
    # The effective slope is bounded by the realistic weekly ceiling.
    assert proj["effective_slope_per_week"] <= 7.0
    assert "time budget" in " ".join(out["notes"]).lower()
    # baseline keeps a neutral multiplier (no edits applied to it).
    assert base["slope_multiplier"] == 1.0


def test_simulate_less_time_lowers_effective_slope(client):
    client.put("/api/study/plan",
               json={"target_score": 170, "exam_date": _exam_in(90), "daily_minutes": 120})
    out = client.post("/api/study/simulate",
                      json={"edits": {"daily_minutes": 30}}).json()
    assert out["projected"]["slope_multiplier"] < 1.0


def test_simulate_target_and_date_feed_forecast(client):
    client.put("/api/study/plan",
               json={"target_score": 160, "exam_date": _exam_in(30), "daily_minutes": 60})
    out = client.post("/api/study/simulate",
                      json={"edits": {"target_score": 178, "exam_date": _exam_in(120)}}).json()
    proj = out["projected"]
    # The edited target/date are reflected in the projected scenario directly.
    assert proj["target_score"] == 178
    assert proj["exam_date"] == _exam_in(120)
    # Longer horizon -> more days to exam than the 30-day baseline.
    assert proj["days_to_exam"] is not None
    assert proj["days_to_exam"] > out["baseline"]["days_to_exam"]
    # delta reports the horizon change.
    assert out["delta"]["days_to_exam"] == proj["days_to_exam"] - out["baseline"]["days_to_exam"]


def test_simulate_without_plan_uses_defaults(client):
    # No plan set — simulator still returns a coherent body off defaults.
    out = client.post("/api/study/simulate", json={"edits": {"daily_minutes": 90}}).json()
    assert out["has_plan"] is False
    assert out["baseline"]["target_score"] == 165  # default
    assert out["projected"]["daily_minutes"] == 90
    assert out["mutated"] is False


def test_simulate_reprojection_safe_without_trend(client, db_session):
    """With no official trend (seeded bank only), the forecast is low-confidence
    and the base slope is 0; the re-projection must not invent gains (multiplier x
    0 slope = 0 delta) and must stay pure."""
    client.put("/api/study/plan",
               json={"target_score": 175, "exam_date": _exam_in(120), "daily_minutes": 60})
    out = client.post("/api/study/simulate",
                      json={"edits": {"daily_minutes": 240, "weak_topic_focus": 0.9}}).json()
    base = out["baseline"]
    proj = out["projected"]
    # No trend -> base slope ~0, so the multiplier can't manufacture a score gain.
    assert base["base_slope_per_week"] == 0.0
    assert proj["base_slope_per_week"] == 0.0
    assert proj["effective_slope_per_week"] == 0.0
    if base["projected_score"] is not None and proj["projected_score"] is not None:
        assert proj["projected_score"] == base["projected_score"]
    # Still pure.
    assert out["mutated"] is False
    # The active plan count is unchanged (no rows written by simulate).
    plans = db_session.exec(select(StudyPlan)).all()
    assert len([p for p in plans if p.active]) == 1
