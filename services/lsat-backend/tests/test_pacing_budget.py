"""LSAT-7 — Content-Ops drill-depth endpoints: pacing budgets + weak-type suggestions.

Locks:
  * ``GET  /api/content/pacing-budget`` returns per-type benchmark/observed/budget,
  * ``POST /api/content/pacing-budget`` persists an override (and clears it on null),
  * ``GET  /api/content/weak-type-suggestions`` returns ready-to-submit DrillBodies,
  * the additive ``weak_type_remediation`` flag on POST /api/drills is honored.
"""
from __future__ import annotations


def test_pacing_budget_lists_benchmarks(client):
    res = client.get("/api/content/pacing-budget")
    assert res.status_code == 200
    body = res.json()
    assert body["source"] == "all"
    assert body["benchmarks_ms"]["LR"] == 90_000
    assert body["benchmarks_ms"]["RC"] == 120_000
    assert "budgets" in body
    assert "over_budget_count" in body


def test_pacing_budget_override_round_trips_and_clears(client):
    # Set an override for a type.
    res = client.post(
        "/api/content/pacing-budget",
        json={"q_type": "Weaken", "target_seconds": 75},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["override_ms"] == 75_000
    weaken = next((r for r in body["budgets"] if r["q_type"] == "Weaken"), None)
    assert weaken is not None
    assert weaken["override_ms"] == 75_000
    assert weaken["budget_ms"] == 75_000

    # GET reflects the persisted override.
    listed = client.get("/api/content/pacing-budget").json()
    weaken_listed = next((r for r in listed["budgets"] if r["q_type"] == "Weaken"), None)
    assert weaken_listed is not None
    assert weaken_listed["override_ms"] == 75_000

    # Clearing (null) reverts to the section benchmark.
    cleared = client.post(
        "/api/content/pacing-budget",
        json={"q_type": "Weaken", "target_seconds": None},
    ).json()
    assert cleared["override_ms"] is None
    weaken_cleared = next((r for r in cleared["budgets"] if r["q_type"] == "Weaken"), None)
    if weaken_cleared is not None:
        assert weaken_cleared["override_ms"] is None
        assert weaken_cleared["budget_ms"] == weaken_cleared["benchmark_ms"]


def test_weak_type_suggestions_shape(client):
    res = client.get("/api/content/weak-type-suggestions?limit=3")
    assert res.status_code == 200
    body = res.json()
    assert body["count"] == len(body["suggestions"])
    for suggestion in body["suggestions"]:
        assert "q_type" in suggestion
        drill = suggestion["drill"]
        assert drill["weak_type_remediation"] is True
        assert drill["q_type"] == suggestion["q_type"]
        assert drill["count"] >= 1


def test_drill_accepts_weak_type_remediation_flag(client):
    """The additive flag is accepted and echoed; with no explicit type it may apply
    the weakest type. On a freshly-seeded DB with no analytics it degrades to no-op
    (weak_type_applied=None) rather than failing."""
    res = client.post(
        "/api/drills",
        json={"count": 5, "source": "any", "timed": True, "weak_type_remediation": True},
    )
    assert res.status_code == 200
    body = res.json()
    selection = body["selection"]
    assert selection["weak_type_remediation"] is True
    assert "weak_type_applied" in selection
