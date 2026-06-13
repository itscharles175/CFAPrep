"""HTTP surface for the bank/dataset-import pipeline."""
from __future__ import annotations


def test_bank_stats_endpoint(client):
    body = client.get("/api/bank/stats").json()
    assert "total" in body
    assert "by_source" in body
    assert "by_q_type" in body
    # Seed bank ships 13 sample questions.
    assert body["total"] >= 13
    assert body["by_source"].get("sample", 0) >= 13


def test_bank_sources_endpoint(client):
    body = client.get("/api/bank/sources").json()
    keys = {row["key"] for row in body}
    assert "agieval-lsat-lr" in keys
    assert "agieval-lsat-rc" in keys
    assert "tasksource-lsat-rc" in keys


def test_bank_import_rejects_unknown_source(client):
    r = client.post("/api/bank/import", json={"sources": ["not-a-real-key"]})
    assert r.status_code == 400


def test_bank_import_records_failed_run_for_missing_local_source(client):
    r = client.post(
        "/api/bank/import",
        json={"sources": ["reclor"], "nc_acknowledged": True},
    )
    assert r.status_code == 200
    row = r.json()["results"][0]
    assert row["import_run_id"]
    assert "requires a local file path" in row["error"]

    run = client.get(f"/api/import/runs/{row['import_run_id']}").json()
    assert run["source"] == "reclor"
    assert run["status"] == "failed"
    assert run["license"]


def test_bank_bootstrap_plan_only_returns_job_ids(client):
    """Plan-only mode should never invoke the model; it just queues jobs."""
    r = client.post("/api/bank/bootstrap", json={
        "target_total": 100,  # tiny target so a plan is produced
        "per_type_cap": 2,
        "tag_limit": 1,
        "run_generation": False,
        "no_import": True,    # skip network in the test
    })
    assert r.status_code == 200
    body = r.json()
    assert "job_ids" in body
    assert body["generation_dispatched"] is False
