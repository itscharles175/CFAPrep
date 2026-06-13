"""R7 Backend Wave 4c — Playlists ("Smart sets").

Covers:
  - CRUD round-trip (create / list / detail / rename / delete).
  - manual playlist resolution (servable-filtered, order preserved).
  - smart resolution: q_type, flagged, outcome=concept_gap, incorrect_only,
    source, difficulty, section_type, limit.
  - /questions returns TEST-MODE payloads (no answer key leak).
  - /play creates a drill session and returns navigable test-mode questions.
  - soft-deleted questions are excluded everywhere.
"""
from __future__ import annotations

import pytest
from sqlmodel import Session

from app import playlists
from app.models import Question

# Seed question ids -> q_type (LR 1-8, RC 9-13), see app/seed.py:
#   1 Weaken, 2 NecessaryAssumption, 3 Flaw, 4 Strengthen, 5 Inference,
#   6 Paradox, 7 Parallel, 8 Role, 9 MainPoint(RC), 10 Attitude(RC),
#   11 Detail(RC), 12 Inference(RC), 13 Function(RC).
Q_FLAW = 3
Q_OK, Q_TIMING, Q_CONCEPT, Q_LUCKY = 1, 4, 8, 9  # card-free in seed (cards: 2,3,6,7)


# --- helpers (mirror tests/test_r7_pedagogy.py) -----------------------------
def _correct_answer(client, qid: int) -> str:
    del client
    from app.db import engine

    with Session(engine) as s:
        q = s.get(Question, qid)
        assert q is not None
        return q.correct_answer


def _wrong(correct: str) -> str:
    return "A" if correct != "A" else "B"


def _attempt(client, sid: int, qid: int, chosen: str, *, time_ms: int = 60000,
             flagged: bool = False) -> int:
    body = {"question_id": qid, "mode": "timed", "chosen_answer": chosen,
            "time_ms": time_ms, "flagged": flagged}
    return client.post(f"/api/sessions/{sid}/attempts", json=body).json()["attempt_id"]


def _br(client, attempt_id: int, answer: str) -> dict:
    return client.patch(
        f"/api/attempts/{attempt_id}/blind-review", json={"br_answer": answer}
    ).json()


def _new_session(client, type_="section") -> int:
    return client.post("/api/sessions", json={"type": type_, "config": {}}).json()["id"]


# --- CRUD round-trip --------------------------------------------------------
def test_crud_round_trip(client):
    # create (smart)
    r = client.post("/api/playlists", json={
        "name": "Flaw misses", "kind": "smart", "criteria": {"q_type": "Flaw"},
    })
    assert r.status_code == 200
    created = r.json()
    pid = created["id"]
    assert created["kind"] == "smart"
    assert created["criteria"] == {"q_type": "Flaw"}
    assert created["question_ids"] == []

    # list (wrapped + advertises the criteria vocabulary)
    listing = client.get("/api/playlists").json()
    assert any(p["id"] == pid for p in listing["playlists"])
    assert "q_type" in listing["criteria_keys"]
    assert "outcome" in listing["criteria_keys"]
    assert "incorrect_only" in listing["criteria_keys"]

    # detail (+ live resolved_count)
    det = client.get(f"/api/playlists/{pid}").json()
    assert det["id"] == pid
    assert "resolved_count" in det
    assert det["resolved_count"] == 1  # exactly one seeded Flaw question

    # rename / re-target
    upd = client.put(f"/api/playlists/{pid}", json={
        "name": "Flaw misses (renamed)", "criteria": {"q_type": "Weaken"},
    }).json()
    assert upd["name"] == "Flaw misses (renamed)"
    assert upd["criteria"] == {"q_type": "Weaken"}

    # delete
    assert client.delete(f"/api/playlists/{pid}").json()["ok"] is True
    assert client.get(f"/api/playlists/{pid}").status_code == 404


def test_crud_404s(client):
    assert client.get("/api/playlists/999999").status_code == 404
    assert client.put("/api/playlists/999999", json={"name": "x"}).status_code == 404
    assert client.delete("/api/playlists/999999").status_code == 404
    assert client.get("/api/playlists/999999/questions").status_code == 404
    assert client.post("/api/playlists/999999/play").status_code == 404


def test_playlist_rejects_invalid_request_values(client):
    bad_creates = [
        {"name": "bad", "kind": "practice"},
        {"name": "bad", "kind": "manual", "question_ids": [0]},
        {"name": "bad", "kind": "smart", "criteria": {"section_type": "LG"}},
        {"name": "bad", "kind": "smart", "criteria": {"difficulty": 6}},
        {"name": "bad", "kind": "smart", "criteria": {"limit": 0}},
    ]
    for payload in bad_creates:
        r = client.post("/api/playlists", json=payload)
        assert r.status_code == 422

    pid = client.post("/api/playlists", json={"name": "ok", "kind": "smart"}).json()["id"]
    assert client.put(f"/api/playlists/{pid}", json={"kind": "practice"}).status_code == 422


def test_playlist_service_rejects_invalid_kind(db_session: Session):
    with pytest.raises(ValueError):
        playlists.create(db_session, name="bad", kind="practice")


# --- manual resolution ------------------------------------------------------
def test_manual_resolves_to_its_ids(client):
    ids = [Q_OK, Q_TIMING, Q_LUCKY]
    pid = client.post("/api/playlists", json={
        "name": "My picks", "kind": "manual", "question_ids": ids,
    }).json()["id"]

    q = client.get(f"/api/playlists/{pid}/questions").json()
    assert q["count"] == 3
    assert [item["id"] for item in q["questions"]] == ids


def test_manual_excludes_soft_deleted(client):
    ids = [Q_OK, Q_TIMING, Q_LUCKY]
    pid = client.post("/api/playlists", json={
        "name": "picks", "kind": "manual", "question_ids": ids,
    }).json()["id"]

    # Soft-delete one pinned question.
    client.delete(f"/api/questions/{Q_TIMING}")

    q = client.get(f"/api/playlists/{pid}/questions").json()
    got = [item["id"] for item in q["questions"]]
    assert Q_TIMING not in got
    assert got == [Q_OK, Q_LUCKY]
    assert q["count"] == 2


# --- smart resolution -------------------------------------------------------
def test_smart_q_type(client):
    pid = client.post("/api/playlists", json={
        "name": "All Flaw", "kind": "smart", "criteria": {"q_type": "Flaw"},
    }).json()["id"]
    q = client.get(f"/api/playlists/{pid}/questions").json()
    ids = [item["id"] for item in q["questions"]]
    assert ids == [Q_FLAW]                       # exactly the one seeded Flaw
    assert all(item["q_type"] == "Flaw" for item in q["questions"])


def test_smart_section_type_and_source(client):
    # RC-only smart set: every seeded RC question (9-13), all source=sample.
    pid = client.post("/api/playlists", json={
        "name": "RC sample", "kind": "smart",
        "criteria": {"section_type": "RC", "source": "sample"},
    }).json()["id"]
    q = client.get(f"/api/playlists/{pid}/questions").json()
    ids = sorted(item["id"] for item in q["questions"])
    assert ids == [9, 10, 11, 12, 13]

    # No official questions exist in the seed -> empty set (ANDed criteria).
    pid2 = client.post("/api/playlists", json={
        "name": "official", "kind": "smart", "criteria": {"source": "official"},
    }).json()["id"]
    assert client.get(f"/api/playlists/{pid2}/questions").json()["count"] == 0


def test_smart_difficulty_and_limit(client):
    pid = client.post("/api/playlists", json={
        "name": "hard", "kind": "smart", "criteria": {"difficulty": 4},
    }).json()["id"]
    q = client.get(f"/api/playlists/{pid}/questions").json()
    assert q["count"] >= 1
    assert all(item["difficulty"] == 4 for item in q["questions"])

    # limit caps the resolved set.
    pid2 = client.post("/api/playlists", json={
        "name": "two", "kind": "smart", "criteria": {"limit": 2},
    }).json()["id"]
    assert client.get(f"/api/playlists/{pid2}/questions").json()["count"] == 2


def test_smart_flagged(client):
    # Flag a fresh attempt on Q_OK; smart flagged=true must surface it, and only it
    # among questions with no other flagged attempts. (Seed flags some others too,
    # so assert membership rather than exact equality across the whole bank.)
    sid = _new_session(client)
    c = _correct_answer(client, Q_OK)
    _attempt(client, sid, Q_OK, c, flagged=True)

    pid = client.post("/api/playlists", json={
        "name": "flagged", "kind": "smart", "criteria": {"flagged": True},
    }).json()["id"]
    q = client.get(f"/api/playlists/{pid}/questions").json()
    ids = {item["id"] for item in q["questions"]}
    assert Q_OK in ids

    # flagged=false must EXCLUDE Q_OK (it now has a flagged attempt).
    pid2 = client.post("/api/playlists", json={
        "name": "unflagged", "kind": "smart", "criteria": {"flagged": False},
    }).json()["id"]
    ids2 = {item["id"] for item in client.get(f"/api/playlists/{pid2}/questions").json()["questions"]}
    assert Q_OK not in ids2


def test_smart_outcome_concept_gap(client):
    """Build a known concept_gap (timed wrong + BR wrong) on a card-free question
    and assert outcome=concept_gap resolves to it (and not a timed_ok question)."""
    sid = _new_session(client)

    # concept_gap on Q_CONCEPT: wrong timed, wrong BR.
    c = _correct_answer(client, Q_CONCEPT)
    aid = _attempt(client, sid, Q_CONCEPT, _wrong(c))
    _br(client, aid, _wrong(c))

    # timed_ok on Q_OK: right timed, right BR (must NOT match concept_gap).
    c2 = _correct_answer(client, Q_OK)
    aid2 = _attempt(client, sid, Q_OK, c2)
    _br(client, aid2, c2)

    pid = client.post("/api/playlists", json={
        "name": "concept gaps", "kind": "smart",
        "criteria": {"outcome": "concept_gap"},
    }).json()["id"]
    ids = {item["id"] for item in client.get(f"/api/playlists/{pid}/questions").json()["questions"]}
    assert Q_CONCEPT in ids
    assert Q_OK not in ids


def test_smart_incorrect_only(client):
    """incorrect_only surfaces questions with at least one wrong practice attempt
    and excludes ones answered only correctly."""
    sid = _new_session(client)
    c = _correct_answer(client, Q_CONCEPT)
    _attempt(client, sid, Q_CONCEPT, _wrong(c))      # wrong
    c2 = _correct_answer(client, Q_LUCKY)
    _attempt(client, sid, Q_LUCKY, c2)               # right

    pid = client.post("/api/playlists", json={
        "name": "my misses", "kind": "smart", "criteria": {"incorrect_only": True},
    }).json()["id"]
    ids = {item["id"] for item in client.get(f"/api/playlists/{pid}/questions").json()["questions"]}
    assert Q_CONCEPT in ids
    assert Q_LUCKY not in ids


def test_smart_excludes_soft_deleted(client):
    # All RC questions, then soft-delete one — it must drop out of the smart set.
    pid = client.post("/api/playlists", json={
        "name": "RC", "kind": "smart", "criteria": {"section_type": "RC"},
    }).json()["id"]
    before = client.get(f"/api/playlists/{pid}/questions").json()["count"]
    client.delete("/api/questions/9")  # MainPoint RC
    after = client.get(f"/api/playlists/{pid}/questions").json()
    ids = {item["id"] for item in after["questions"]}
    assert 9 not in ids
    assert after["count"] == before - 1


# --- test-mode guarantee ----------------------------------------------------
def test_questions_are_test_mode(client):
    pid = client.post("/api/playlists", json={
        "name": "RC", "kind": "smart", "criteria": {"section_type": "RC"},
    }).json()["id"]
    q = client.get(f"/api/playlists/{pid}/questions").json()
    assert q["count"] >= 1
    for item in q["questions"]:
        assert "correct_answer" not in item        # answer key withheld
        assert "explanation" not in item
        for ch in item["choices"]:
            assert "is_correct" not in ch
            assert "trap_type" not in ch


# --- play -------------------------------------------------------------------
def test_play_creates_session_and_returns_navigable_questions(client):
    pid = client.post("/api/playlists", json={
        "name": "RC drill", "kind": "smart", "criteria": {"section_type": "RC"},
    }).json()["id"]

    r = client.post(f"/api/playlists/{pid}/play")
    assert r.status_code == 200
    data = r.json()
    assert "session_id" in data and isinstance(data["session_id"], int)
    assert len(data["questions"]) == 5            # all seeded RC questions
    # same test-mode guarantee as /drills
    assert all("correct_answer" not in item for item in data["questions"])

    # The returned session is real and usable: navigate straight into it by
    # recording an attempt against the first question.
    sid = data["session_id"]
    first = data["questions"][0]["id"]
    c = _correct_answer(client, first)
    aid = _attempt(client, sid, first, c)
    assert isinstance(aid, int)

    # The session records its playlist origin in config.
    res = client.get(f"/api/sessions/{sid}/results").json()
    assert res["session"]["type"] == "drill"


def test_play_manual_playlist(client):
    ids = [Q_OK, Q_FLAW, Q_LUCKY]
    pid = client.post("/api/playlists", json={
        "name": "picks", "kind": "manual", "question_ids": ids,
    }).json()["id"]
    data = client.post(f"/api/playlists/{pid}/play").json()
    assert [item["id"] for item in data["questions"]] == ids
