"""Attempts, blind review, finish, and the 2x2 outcome routing."""
from __future__ import annotations

from time import sleep

from app.analytics import blind_review_outcome


def test_2x2_outcome_pure_function():
    assert blind_review_outcome(True, True) == "timed_ok"
    assert blind_review_outcome(False, True) == "timing_problem"
    assert blind_review_outcome(False, False) == "concept_gap"
    assert blind_review_outcome(True, False) == "lucky"
    # no BR answer falls back to timed-only labels
    assert blind_review_outcome(True, None) == "timed_ok"
    assert blind_review_outcome(False, None) == "concept_gap"


def _correct_answer(client, question_id):
    sess = client.post("/api/sessions", json={"type": "review", "config": {}}).json()
    sid = sess["id"]
    attempt = client.post(f"/api/sessions/{sid}/attempts", json={
        "question_id": question_id,
        "mode": "drill",
        "chosen_answer": "A",
    }).json()["attempt_id"]
    return client.get(
        f"/api/questions/{question_id}?reveal=true"
        f"&session_id={sid}&attempt_id={attempt}"
    ).json()["correct_answer"]


def test_attempt_blind_review_results_flow(client):
    # New session
    sess = client.post("/api/sessions", json={"type": "section", "config": {}}).json()
    sid = sess["id"]

    correct = _correct_answer(client, 1)
    wrong = "A" if correct != "A" else "B"

    # Build all four outcomes across four questions.
    # Q1: timed right, BR right -> timed_ok
    a1 = client.post(f"/api/sessions/{sid}/attempts", json={
        "question_id": 1, "mode": "timed", "chosen_answer": correct,
        "time_ms": 40000, "flagged": False, "confidence": "sure"}).json()["attempt_id"]
    client.patch(f"/api/attempts/{a1}/blind-review",
                 json={"br_answer": correct, "confidence": "sure"})

    # Q2: timed wrong, BR right -> timing_problem
    c2 = _correct_answer(client, 2)
    w2 = "A" if c2 != "A" else "B"
    a2 = client.post(f"/api/sessions/{sid}/attempts", json={
        "question_id": 2, "mode": "timed", "chosen_answer": w2,
        "time_ms": 90000, "flagged": True}).json()["attempt_id"]
    client.patch(f"/api/attempts/{a2}/blind-review", json={"br_answer": c2})

    # Q3: timed wrong, BR wrong -> concept_gap
    c3 = _correct_answer(client, 3)
    w3 = "A" if c3 != "A" else "B"
    a3 = client.post(f"/api/sessions/{sid}/attempts", json={
        "question_id": 3, "mode": "timed", "chosen_answer": w3,
        "time_ms": 120000}).json()["attempt_id"]
    client.patch(f"/api/attempts/{a3}/blind-review", json={"br_answer": w3})

    # Q4: timed right, BR wrong -> lucky
    c4 = _correct_answer(client, 4)
    w4 = "A" if c4 != "A" else "B"
    a4 = client.post(f"/api/sessions/{sid}/attempts", json={
        "question_id": 4, "mode": "timed", "chosen_answer": c4,
        "time_ms": 30000}).json()["attempt_id"]
    client.patch(f"/api/attempts/{a4}/blind-review", json={"br_answer": w4})

    fin = client.post(f"/api/sessions/{sid}/finish").json()
    assert fin["total"] >= 0  # sample questions are not 'official' so total may be 0

    res = client.get(f"/api/sessions/{sid}/results").json()
    outcomes = [it["attempt"]["outcome"] for it in res["items"]]
    assert outcomes == ["timed_ok", "timing_problem", "concept_gap", "lucky"]

    # results expose review-form questions (answers visible here, by design)
    assert all("correct_answer" in it["question"] for it in res["items"])


def test_client_attempt_id_idempotency_scoped_by_session(client):
    s1 = client.post("/api/sessions", json={"type": "section", "config": {}}).json()["id"]
    s2 = client.post("/api/sessions", json={"type": "section", "config": {}}).json()["id"]
    payload = {
        "question_id": 1,
        "mode": "timed",
        "chosen_answer": "A",
        "client_attempt_id": "same-client-token",
    }

    a1 = client.post(f"/api/sessions/{s1}/attempts", json=payload).json()["attempt_id"]
    a1_replay = client.post(f"/api/sessions/{s1}/attempts", json=payload).json()["attempt_id"]
    a2 = client.post(f"/api/sessions/{s2}/attempts", json=payload).json()["attempt_id"]
    a2_replay = client.post(f"/api/sessions/{s2}/attempts", json=payload).json()["attempt_id"]

    assert a1_replay == a1
    assert a2_replay == a2
    assert a2 != a1


def test_finish_is_idempotent_and_preserves_first_ended_timestamp(client):
    sid = client.post("/api/sessions", json={"type": "section", "config": {}}).json()["id"]

    first = client.post(f"/api/sessions/{sid}/finish").json()
    sleep(0.01)
    second = client.post(f"/api/sessions/{sid}/finish").json()

    assert second["ended"] == first["ended"]
    res = client.get(f"/api/sessions/{sid}/results").json()
    assert res["session"]["ended"] == first["ended"]


def test_error_log(client):
    sess = client.post("/api/sessions", json={"type": "drill", "config": {}}).json()
    sid = sess["id"]
    aid = client.post(f"/api/sessions/{sid}/attempts", json={
        "question_id": 1, "mode": "drill", "chosen_answer": "A",
        "time_ms": 5000}).json()["attempt_id"]
    r = client.post(f"/api/attempts/{aid}/error-log",
                    json={"reason": "trap", "note": "fell for reversal"})
    assert r.status_code == 200
    log = client.get("/api/error-log").json()
    assert any(e["reason"] == "trap" for e in log)
