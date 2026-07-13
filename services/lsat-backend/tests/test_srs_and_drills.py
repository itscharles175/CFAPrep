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


# --- LEARN-5 — leech + concept-gap unification (host projection) ------------
def _post_host_review_snapshots(client, snapshots: list[dict]) -> None:
    """UPSERT host review snapshots through the DATA-4a sync route (kind=review)."""
    r = client.post("/api/sync/progress-updates", json={"snapshots": snapshots})
    assert r.status_code == 200


def test_leeches_and_concept_gap_unchanged_without_include_host(client):
    """Default (no include_host) responses are byte-for-byte the LSAT-only queue —
    even with host review snapshots present, none of them leak in."""
    # Seed host review snapshots that WOULD qualify as a leech + a gap if asked.
    _post_host_review_snapshots(client, [
        {
            "crossId": "cfa:review:host-leech-1", "domain": "cfa", "kind": "review",
            "payload": {
                "crossId": "cfa:review:host-leech-1", "domain": "cfa",
                "questionCrossId": "cfa:question:obj-1", "title": "Host leech card",
                "difficulty": "advanced", "origin": "missed-question",
                "lapses": 12, "leech": True,
            },
        },
    ])

    leeches_default = client.get("/api/srs/leeches").json()
    gaps_default = client.get("/api/srs/concept-gap-queue").json()

    # Shape is exactly the legacy {count, cards} — no host_cards / include_host keys.
    assert set(leeches_default) == {"count", "cards"}
    assert set(gaps_default) == {"count", "cards"}
    # No host (non-lsat) row leaked into the LSAT-native payload.
    for card in leeches_default["cards"]:
        assert "card_id" in card  # LSAT test-mode row
    for card in gaps_default["cards"]:
        assert card.get("origin") == "concept_gap"


def test_leeches_include_host_appends_canonical_host_rows(client):
    """include_host=true appends host leech rows on the canonical
    CrossDomainReviewCard shape, sorted most-lapsed first, leaving the LSAT-native
    ``cards`` array unchanged from the default response."""
    _post_host_review_snapshots(client, [
        {
            "crossId": "cfa:review:host-leech-low", "domain": "cfa", "kind": "review",
            "payload": {
                "crossId": "cfa:review:host-leech-low", "domain": "cfa",
                "questionCrossId": "cfa:question:obj-low", "title": "Lower-lapse leech",
                "difficulty": "intermediate", "origin": "weak-objective",
                "lapses": 9, "leech": True,
            },
        },
        {
            "crossId": "quant:review:host-leech-high", "domain": "quant", "kind": "review",
            "payload": {
                "crossId": "quant:review:host-leech-high", "domain": "quant",
                "questionCrossId": "quant:question:obj-high", "title": "Higher-lapse leech",
                "difficulty": "advanced", "origin": "missed-question",
                "lapses": 15, "leech": True,
            },
        },
        {
            # Not a leech (under threshold, not flagged) — must NOT appear.
            "crossId": "excel:review:not-a-leech", "domain": "excel", "kind": "review",
            "payload": {
                "crossId": "excel:review:not-a-leech", "domain": "excel",
                "questionCrossId": "excel:question:obj-ok", "title": "Healthy card",
                "difficulty": "foundation", "origin": "due-review",
                "lapses": 1, "leech": False,
            },
        },
    ])

    default = client.get("/api/srs/leeches").json()
    with_host = client.get("/api/srs/leeches?include_host=true").json()

    # LSAT-native cards are identical to the default response.
    assert with_host["cards"] == default["cards"]
    assert with_host["include_host"] is True
    host_cards = with_host["host_cards"]
    # Both leeches appended; the non-leech is excluded.
    assert len(host_cards) == 2
    titles = {c["title"] for c in host_cards}
    assert titles == {"Higher-lapse leech", "Lower-lapse leech"}
    # Canonical shape + most-lapsed first.
    first = host_cards[0]
    assert first["domain"] == "quant"
    assert first["crossId"] == "quant:review:host-leech-high"
    assert first["lapses"] == 15
    assert first["leech"] is True
    assert host_cards[0]["lapses"] >= host_cards[1]["lapses"]
    # count reflects LSAT-native + host rows.
    assert with_host["count"] == len(default["cards"]) + len(host_cards)


def test_concept_gap_include_host_appends_canonical_host_rows(client):
    """include_host=true on /concept-gap-queue appends host concept-gap rows
    (origin marks unfinished understanding) on the canonical shape; rows whose
    origin is not a gap reason are excluded."""
    _post_host_review_snapshots(client, [
        {
            "crossId": "cfa:review:host-gap-1", "domain": "cfa", "kind": "review",
            "payload": {
                "crossId": "cfa:review:host-gap-1", "domain": "cfa",
                "questionCrossId": "cfa:question:gap-1", "title": "Host concept gap",
                "difficulty": "advanced", "origin": "missed-question",
                "lapses": 2, "leech": False,
            },
        },
        {
            # A routine due-review row is NOT a concept gap.
            "crossId": "cfa:review:host-due-1", "domain": "cfa", "kind": "review",
            "payload": {
                "crossId": "cfa:review:host-due-1", "domain": "cfa",
                "questionCrossId": "cfa:question:due-1", "title": "Routine due review",
                "difficulty": "foundation", "origin": "due-review",
                "lapses": 0, "leech": False,
            },
        },
    ])

    default = client.get("/api/srs/concept-gap-queue").json()
    with_host = client.get("/api/srs/concept-gap-queue?include_host=true").json()

    # LSAT-native cards unchanged.
    assert with_host["cards"] == default["cards"]
    assert with_host["include_host"] is True
    host_cards = with_host["host_cards"]
    assert len(host_cards) == 1
    gap = host_cards[0]
    assert gap["title"] == "Host concept gap"
    assert gap["domain"] == "cfa"
    assert gap["origin"] == "missed-question"
    assert with_host["count"] == len(default["cards"]) + 1


def test_host_leech_and_gap_rows_empty_without_host_data(db_session):
    """With no host review snapshots, the projection helper returns ([], [])."""
    leech_rows, gap_rows = srs.host_leech_and_gap_rows(db_session)
    assert leech_rows == []
    assert gap_rows == []
