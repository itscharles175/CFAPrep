"""Full timed exam mode: assemble from a PrepTest, record, per-section results."""
from __future__ import annotations


def test_create_exam_and_results(client):
    pts = client.get("/api/preptests").json()
    assert pts, "seed should provide at least one PrepTest"
    pid = pts[0]["id"]

    exam = client.post("/api/exams", json={"preptest_id": pid}).json()
    sid = exam["session_id"]
    assert exam["sections"], "exam should span the PrepTest's sections"
    # the seeded sample diagnostic has an LR and an RC section
    assert len(exam["sections"]) >= 2

    # record one attempt in the first section under the single exam session
    sec0 = exam["sections"][0]["section_id"]
    sec_data = client.get(f"/api/sections/{sec0}").json()
    qid = sec_data["questions"][0]["id"]
    r = client.post(f"/api/sessions/{sid}/attempts",
                    json={"question_id": qid, "mode": "timed", "chosen_answer": "A"})
    assert r.status_code == 200

    res = client.get(f"/api/exams/{sid}/results").json()
    assert res["session_id"] == sid
    assert res["total"] == 1
    assert any(s["section_id"] == sec0 for s in res["sections"])
    # sample content is not official -> no scaled score
    assert res["official_total"] == 0
    assert res["scaled_score"] is None


def test_create_exam_unknown_preptest_404(client):
    r = client.post("/api/exams", json={"preptest_id": 999999})
    assert r.status_code == 404
