"""Settings/model-routing API + per-type mastery model."""
from __future__ import annotations

import pytest


def test_settings_get_and_live_update(client):
    from app import config

    before = client.get("/api/settings").json()
    assert "settings" in before and "provider" in before
    assert before["settings"]["explain_model"] == config.EXPLAIN_MODEL
    assert before["provider"]["capabilities"]["matrix"]["anthropic"]["sampling"]["seed"] is False

    try:
        r = client.put("/api/settings", json={"gen_model": "qwen3:32b"})
        body = r.json()
        assert body["settings"]["gen_model"] == "qwen3:32b"
        assert body["provider"]["capabilities"]["offline"]["known"] is True
        # applied live to the config module (call sites read it at call time)
        assert config.GEN_MODEL == "qwen3:32b"

        # persisted: a fresh GET reflects it
        assert client.get("/api/settings").json()["settings"]["gen_model"] == "qwen3:32b"
    finally:
        # Restore in a `finally` so a mid-test failure can't leak the module
        # mutation into later tests. (The autouse `_restore_config` fixture in
        # conftest is the broader safety net; this keeps intent local + explicit.)
        config.GEN_MODEL = "qwen3:14b"


def test_settings_ignores_unknown_and_secret_keys(client):
    # cloud_api_key is NOT an accepted field -> ignored, never echoed back.
    r = client.put(
        "/api/settings",
        json={"explain_model": "qwen3:8b", "cloud_api_key": "sk-local-only"},
    )
    assert "cloud_api_key" not in r.json()["settings"]


def test_settings_rejects_invalid_values(client):
    bad_payloads = [
        {"gen_provider": "anthropic"},
        {"desired_retention": 0},
        {"desired_retention": 1},
        {"gen_model": ""},
        {"embed_model": "   "},
    ]
    for payload in bad_payloads:
        r = client.put("/api/settings", json=payload)
        assert r.status_code == 422


def test_mastery_endpoint_shape(client):
    rows = client.get("/api/analytics/mastery").json()
    assert isinstance(rows, list)
    if rows:
        r = rows[0]
        for key in ("q_type", "section_type", "attempts", "mastery",
                    "weighted_accuracy", "recent_accuracy", "avg_difficulty"):
            assert key in r
        assert 0.0 <= r["mastery"] <= 1.0
    # R7 3.3: weakest-first is now ranked by the credible-interval lower bound
    # (uncertainty-aware), not the bare posterior mean — so a tiny noisy sample
    # can't top the weakest list. (Was: sorted by `mastery`.)
    lowers = [r["lower_bound"] for r in rows]
    assert lowers == sorted(lowers)


def test_mastery_recency_weighting(db_session):
    """Recent correct answers should pull mastery above the raw average."""
    from app import analytics
    from app.models import Attempt, AttemptMode, Question, QuestionSource, StudySession

    q = Question(stem="s", prompt="p", correct_answer="A", q_type="Method",
                 source=QuestionSource.research, difficulty=3)
    db_session.add(q)
    db_session.commit()
    db_session.refresh(q)
    s = StudySession(type="drill")
    db_session.add(s)
    db_session.commit()
    db_session.refresh(s)
    # 2 wrong (older) then 3 right (newer) — recency weighting favors the recent.
    for correct in [False, False, True, True, True]:
        db_session.add(Attempt(
            question_id=q.id, session_id=s.id, mode=AttemptMode.drill,
            chosen_answer="A" if correct else "B", is_correct=correct,
        ))
        db_session.commit()

    rows = analytics.mastery(db_session)
    method = next(r for r in rows if r["q_type"] == "Method")
    raw_acc = 3 / 5
    assert method["weighted_accuracy"] > raw_acc
