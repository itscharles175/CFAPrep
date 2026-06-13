"""Round 5 wave 3: annotations CRUD, bulk SRS cards, reflection journal."""
from __future__ import annotations


def _make_attempt(client) -> int:
    sess = client.post("/api/sessions", json={"type": "drill"}).json()
    return client.post(f"/api/sessions/{sess['id']}/attempts",
                       json={"question_id": 1, "chosen_answer": "B"}).json()["attempt_id"]


# --- H1/C1/C2: annotations --------------------------------------------------
def test_attempt_annotations_roundtrip(client):
    aid = _make_attempt(client)
    hl = [{"kind": "highlight", "start": 0, "end": 12, "color": "yellow"},
          {"kind": "note", "anchor": 5, "text": "key premise"}]

    assert client.put(f"/api/attempts/{aid}/annotations", json={"highlights": hl}).json()["ok"]
    got = client.get(f"/api/attempts/{aid}/annotations").json()
    assert got["highlights"] == hl

    # update replaces
    assert client.put(f"/api/attempts/{aid}/annotations", json={"highlights": []}).json()["ok"]
    assert client.get(f"/api/attempts/{aid}/annotations").json()["highlights"] == []

    assert client.delete(f"/api/attempts/{aid}/annotations").json()["ok"] is True
    # after delete, default empty
    assert client.get(f"/api/attempts/{aid}/annotations").json()["highlights"] == []


def test_question_annotations_roundtrip(client):
    hl = [{"kind": "underline", "start": 3, "end": 9}]
    assert client.put("/api/questions/1/annotations", json={"highlights": hl}).json()["ok"]
    assert client.get("/api/questions/1/annotations").json()["highlights"] == hl
    # POST also upserts (frontend fallback)
    assert client.post("/api/questions/1/annotations", json={"highlights": []}).json()["ok"]
    assert client.get("/api/questions/1/annotations").json()["highlights"] == []


def test_annotations_404_on_missing_attempt(client):
    assert client.get("/api/attempts/999999/annotations").status_code == 404


# --- H2/D5: bulk SRS cards --------------------------------------------------
def test_bulk_srs_cards_idempotent(client):
    r = client.post("/api/srs/cards", json={"question_ids": [1, 2, 3]})
    body = r.json()
    assert body["created"] >= 1
    first_created = body["created"]

    # second call: those questions already have cards -> skipped
    r2 = client.post("/api/srs/cards", json={"question_ids": [1, 2, 3]})
    assert r2.json()["created"] == 0
    assert r2.json()["skipped"] >= first_created


def test_bulk_srs_cards_skips_unknown(client):
    r = client.post("/api/srs/cards", json={"question_ids": [999999]})
    assert r.json()["created"] == 0
    assert r.json()["skipped"] == 1


# --- E3: reflection journal -------------------------------------------------
def test_reflection_upsert_and_get(client):
    sid = client.post("/api/sessions", json={"type": "section"}).json()["id"]
    # none yet
    assert client.get(f"/api/sessions/{sid}/reflection").json()["exists"] is False

    client.post(f"/api/sessions/{sid}/reflection",
                json={"text": "rushed the last 5", "prompts": ["What slowed you?"]})
    got = client.get(f"/api/sessions/{sid}/reflection").json()
    assert got["exists"] is True
    assert got["text"] == "rushed the last 5"
    assert got["prompts"] == ["What slowed you?"]

    # upsert replaces
    client.post(f"/api/sessions/{sid}/reflection", json={"text": "better pacing"})
    assert client.get(f"/api/sessions/{sid}/reflection").json()["text"] == "better pacing"
