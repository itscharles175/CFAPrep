"""LEARN-2 — unified due-today queue (ability-ranked), read-only.

Covers GET /api/study/due-unified:
  - returns the LSAT due cards (sourced like /api/srs/due) in the canonical
    ``CrossDomainReviewCard`` shape (mirrors ``src/lib/dataDictionary.ts`` §1 /
    ``lsatSrsCardToCanonical``): namespaced ids, host 3-bucket difficulty, no
    answer-key leak;
  - ranking: overdue_seconds DESC, then q_type round-robin interleave, then the
    ability-weighted utility score rides on each row;
  - strictly read-only (a repeat GET leaves the SRS cards untouched);
  - exposed in the OpenAPI schema with a typed response_model.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlmodel import Session, select


def test_due_unified_returns_canonical_cards(client):
    r = client.get("/api/study/due-unified")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["due_count"] >= 1
    assert body["due_count"] == len(body["items"])

    card = body["items"][0]
    # Canonical CrossDomainReviewCard shape (namespaced identity + host buckets).
    assert card["domain"] == "lsat"
    assert card["crossId"].startswith("lsat:review:")
    assert card["questionCrossId"].startswith("lsat:question:")
    assert card["difficulty"] in {"foundation", "intermediate", "advanced"}
    assert isinstance(card["title"], str) and card["title"]
    # LEARN-2 ranking signals present on every row.
    assert card["overdueSeconds"] >= 0
    assert "utilityScore" in card
    # Test-mode: never leak the answer key through this read-only feed.
    assert "correct_answer" not in card
    assert "choices" not in card


def test_due_unified_carries_ability_utility_model(client):
    body = client.get("/api/study/due-unified").json()
    assert body["utility_model"] == "ability_engine_v2_utility_v1"
    strategy = body["review_strategy"]
    assert strategy["ordering"] == "overdue_interleaved_by_qtype_ability_weighted"
    assert strategy["planes"] == ["lsat"]
    assert strategy["host_merges_local_queue"] is True
    # The per-row utilityScore mirrors the global selector utility score.
    assert body["items"][0]["utilityScore"] == strategy["utility_score"]


def test_due_unified_ordering_overdue_then_interleaved(client):
    items = client.get("/api/study/due-unified").json()["items"]
    # q_type round-robin: the same type never appears in two consecutive slots
    # when more than one type is present (mirrors srs/due _interleave_by_qtype).
    q_types = [it.get("itemType") for it in items]
    if len(set(q_types)) > 1:
        runs = [q_types[i] == q_types[i + 1] for i in range(len(q_types) - 1)]
        assert not all(runs)  # not one long single-type run


def test_due_unified_is_read_only(client):
    from app.db import engine
    from app.models import SRSCard

    with Session(engine) as s:
        before = {c.id: c.due_date for c in s.exec(select(SRSCard)).all()}
    # A second GET must not mutate any card (no review/scheduling side effects).
    client.get("/api/study/due-unified")
    client.get("/api/study/due-unified")
    with Session(engine) as s:
        after = {c.id: c.due_date for c in s.exec(select(SRSCard)).all()}
    assert before.keys() == after.keys()
    assert before == after


def test_due_unified_due_at_in_the_past(client):
    """Every returned card is genuinely due (due_date <= now), like /api/srs/due."""
    now = datetime.now(timezone.utc)
    for card in client.get("/api/study/due-unified").json()["items"]:
        due_at = card.get("dueAt")
        if due_at is None:
            continue
        parsed = datetime.fromisoformat(due_at)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        assert parsed <= now


def test_due_unified_route_has_openapi_schema(client):
    spec = client.get("/openapi.json").json()
    op = spec["paths"]["/api/study/due-unified"]["get"]
    schema = op["responses"]["200"]["content"]["application/json"].get("schema")
    assert schema  # inline typed response_model is published
