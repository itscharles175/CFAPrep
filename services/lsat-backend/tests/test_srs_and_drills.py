"""SRS scheduling + drill selection."""
from __future__ import annotations

from app import srs


def test_srs_scheduling_pure():
    state = srs.new_card_state()
    new_state, due, interval = srs.review(state, 3)  # good
    assert isinstance(interval, int)
    assert due is not None
    previews = srs.predicted_intervals(state)
    assert set(previews) == {"1", "2", "3", "4"}
    assert all(isinstance(value, int) for value in previews.values())
    # easy should schedule further out than again
    _, due_again, int_again = srs.review(state, 1)
    _, due_easy, int_easy = srs.review(state, 4)
    assert int_easy >= int_again
    assert previews["4"] >= previews["1"]


def test_srs_due_and_review_endpoints(client):
    due = client.get("/api/srs/due").json()
    assert due["due_count"] >= 1
    assert due["utility_model"] == "ability_engine_v2"
    assert due["ability_selector"]["model"] == "ability_engine_v2"
    assert due["ability_selector"]["utility"]["model"] == "ability_engine_v2_utility_v1"
    assert due["review_strategy"]["ordering"] == "overdue_interleaved_by_qtype"
    assert due["review_strategy"]["utility_model"] == "ability_engine_v2_utility_v1"
    assert due["review_strategy"]["utility_score"] == due["ability_selector"]["utility"]["score"]
    assert due["review_strategy"]["srs_pressure"] == due["ability_selector"]["utility"]["signals"]["srs_pressure"]
    card = due["cards"][0]
    assert "card_id" in card
    assert set(card["predicted_intervals"]) == {"1", "2", "3", "4"}
    assert card["predicted_intervals"]["4"] >= card["predicted_intervals"]["1"]
    # test-mode: no leak
    assert "correct_answer" not in card

    r = client.post(f"/api/srs/{card['card_id']}/review", json={"rating": 3})
    assert r.status_code == 200
    body = r.json()
    assert "next_due" in body and "interval_days" in body
    assert set(body["predicted_intervals"]) == {"1", "2", "3", "4"}


def test_drill_selection_by_type(client):
    r = client.post("/api/drills", json={
        "q_type": "Weaken", "count": 5, "source": "real", "timed": True})
    assert r.status_code == 200
    data = r.json()
    assert "session_id" in data
    assert data["utility_model"] == "ability_engine_v2"
    assert data["ability_selector"]["model"] == "ability_engine_v2"
    assert data["selection"]["target_difficulty"] is not None
    assert data["selection"]["selector_utility_model"] == "ability_engine_v2_utility_v1"
    assert data["selection"]["utility_score"] == data["ability_selector"]["utility"]["score"]
    assert data["selection"]["zpd"]["target_success_window"] == [0.42, 0.78]
    for q in data["questions"]:
        assert q["q_type"] == "Weaken"
        assert "correct_answer" not in q


def test_drill_ai_source_empty_without_generated(client):
    r = client.post("/api/drills", json={"count": 5, "source": "ai"})
    # no ai_generated content seeded -> empty selection but valid session
    assert r.status_code == 200
    assert r.json()["questions"] == []


def test_drill_rejects_invalid_request_values(client):
    bad_payloads = [
        {"count": 0},
        {"count": 51},
        {"difficulty": 0},
        {"difficulty": 6},
        {"source": "synthetic"},
    ]
    for payload in bad_payloads:
        r = client.post("/api/drills", json=payload)
        assert r.status_code == 422
