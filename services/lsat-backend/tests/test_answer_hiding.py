"""Test-mode endpoints MUST NOT leak the answer key or explanation."""
from __future__ import annotations

LEAK_KEYS = {"is_correct", "correct_answer", "explanation"}


def _assert_no_leak(question: dict):
    assert "correct_answer" not in question
    assert "explanation" not in question
    for ch in question["choices"]:
        assert "is_correct" not in ch
        assert "trap_type" not in ch


def test_section_hides_answers(client):
    # section 1 is the LR section from the seed
    r = client.get("/api/sections/1")
    assert r.status_code == 200
    body = r.json()
    assert body["type"] in ("LR", "RC")
    assert len(body["questions"]) > 0
    for q in body["questions"]:
        _assert_no_leak(q)


def test_question_test_vs_reveal(client):
    r = client.get("/api/questions/1?reveal=false")
    assert r.status_code == 200
    _assert_no_leak(r.json())

    r2 = client.get("/api/questions/1?reveal=true")
    assert r2.status_code == 403

    sess = client.post("/api/sessions", json={"type": "review", "config": {}}).json()
    sid = sess["id"]
    attempt = client.post(f"/api/sessions/{sid}/attempts", json={
        "question_id": 1,
        "mode": "drill",
        "chosen_answer": "A",
        "time_ms": 1000,
    }).json()

    r3 = client.get(
        f"/api/questions/1?reveal=true&session_id={sid}"
        f"&attempt_id={attempt['attempt_id']}"
    )
    assert r3.status_code == 200
    rev = r3.json()
    assert "correct_answer" in rev
    assert rev["explanation"] is not None
    assert any("is_correct" in ch for ch in rev["choices"])


def test_question_reveal_requires_matching_attempt_context(client):
    sess = client.post("/api/sessions", json={"type": "review", "config": {}}).json()
    sid = sess["id"]
    attempt = client.post(f"/api/sessions/{sid}/attempts", json={
        "question_id": 2,
        "mode": "drill",
        "chosen_answer": "A",
    }).json()["attempt_id"]

    wrong_question = client.get(
        f"/api/questions/1?reveal=true&session_id={sid}&attempt_id={attempt}"
    )
    assert wrong_question.status_code == 403

    no_attempt_for_question = client.get(f"/api/questions/1?reveal=true&session_id={sid}")
    assert no_attempt_for_question.status_code == 403

    matching_question = client.get(f"/api/questions/2?reveal=true&session_id={sid}")
    assert matching_question.status_code == 200
    assert "correct_answer" in matching_question.json()


def test_drill_questions_hidden(client):
    r = client.post("/api/drills", json={"count": 3, "source": "any"})
    assert r.status_code == 200
    for q in r.json()["questions"]:
        _assert_no_leak(q)
