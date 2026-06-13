"""Closing the generation loop: coverage + backfill-a-weak-type endpoints."""
from __future__ import annotations


def test_coverage_reports_servable_and_anchors(client):
    rows = client.get("/api/gen/coverage").json()
    by_type = {r["q_type"]: r for r in rows}
    # Seed ships a "Weaken" sample question -> servable + anchor >= 1.
    assert "Weaken" in by_type
    assert by_type["Weaken"]["servable"] >= 1
    assert by_type["Weaken"]["anchors"] >= 1


def test_for_type_with_anchors_enqueues_planned(client):
    r = client.post("/api/gen/for-type",
                    json={"q_type": "Weaken", "count": 3, "activate": False})
    body = r.json()
    assert body["enqueued"] is True
    assert body["status"] == "planned"
    assert body["anchors"] >= 1

    # Shows up in the job list as a planned job (worker won't touch it).
    listed = client.get("/api/gen/jobs").json()
    row = next(j for j in listed if j["id"] == body["job_id"])
    assert row["status"] == "planned"


def test_for_type_activate_queues(client):
    r = client.post("/api/gen/for-type",
                    json={"q_type": "Weaken", "count": 2, "activate": True})
    body = r.json()
    assert body["enqueued"] is True
    assert body["status"] == "queued"


def test_for_type_without_anchors_refuses(client):
    # "Evaluate" is a valid LR type but not present in the seed bank.
    r = client.post("/api/gen/for-type", json={"q_type": "Evaluate"})
    body = r.json()
    assert body["enqueued"] is False
    assert "anchor" in body["reason"]
