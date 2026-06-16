"""INT-4 — shared study-artifact store.

Covers the CRUD surface under ``/api/study-artifacts``:
  - POST creates an artifact (host explanation / LSAT Socratic note) and returns
    the typed row; GET{id} fetches it back; PUT{id} partially updates; DELETE{id}
    removes it (full round-trip);
  - list filters by ``?question_id=``, ``?topic=``, and ``?type=`` independently
    and in combination;
  - list pagination returns the BC2 envelope shape
    (``items``/``total``/``limit``/``offset``/``has_more``) and honors limit/offset;
  - 404s for missing ids on GET/PUT/DELETE;
  - the route is published in the OpenAPI schema with a typed response_model.
"""
from __future__ import annotations


# --- CRUD round-trip --------------------------------------------------------
def test_create_get_update_delete_round_trip(client):
    # CREATE — a host explanation persisted as an artifact.
    created = client.post(
        "/api/study-artifacts",
        json={
            "type": "rationale",
            "title": "Why (C) is correct",
            "body": "The argument commits a part-to-whole fallacy.",
            "summary": "part-to-whole",
            "topic": "Flaw",
            "tags": ["LR"],
            "question_id": 1,
        },
    )
    assert created.status_code == 200
    art = created.json()
    aid = art["id"]
    assert isinstance(aid, int)
    assert art["type"] == "rationale"
    assert art["kind"] == "rationale"
    assert art["title"] == "Why (C) is correct"
    assert art["question_id"] == 1
    # topic stored as the canonical (first) tag; tags carries the full list.
    assert art["topic"] == "Flaw"
    assert art["tags"] == ["Flaw", "LR"]
    assert art["created_at"] is not None

    # GET{id} — fetch it back identically.
    got = client.get(f"/api/study-artifacts/{aid}")
    assert got.status_code == 200
    assert got.json()["id"] == aid
    assert got.json()["title"] == "Why (C) is correct"

    # PUT{id} — partial update changes only the sent fields.
    upd = client.put(
        f"/api/study-artifacts/{aid}",
        json={"summary": "updated summary", "type": "note"},
    )
    assert upd.status_code == 200
    body = upd.json()
    assert body["summary"] == "updated summary"
    assert body["type"] == "note"
    # untouched fields persist.
    assert body["title"] == "Why (C) is correct"
    assert body["question_id"] == 1
    assert body["tags"] == ["Flaw", "LR"]

    # DELETE{id} — removes the row.
    deleted = client.delete(f"/api/study-artifacts/{aid}")
    assert deleted.status_code == 200
    assert deleted.json() == {"ok": True, "deleted_id": aid}

    # GET{id} now 404s.
    assert client.get(f"/api/study-artifacts/{aid}").status_code == 404


def test_partial_put_preserves_topic_when_only_tags_sent(client):
    aid = client.post(
        "/api/study-artifacts",
        json={"type": "note", "title": "T", "topic": "Assumption", "tags": ["LR"]},
    ).json()["id"]
    # Sending only `tags` must preserve the existing canonical topic.
    body = client.put(f"/api/study-artifacts/{aid}", json={"tags": ["RC", "timing"]}).json()
    assert body["topic"] == "Assumption"
    assert body["tags"] == ["Assumption", "RC", "timing"]


# --- filters ----------------------------------------------------------------
def _seed_artifacts(client):
    client.post(
        "/api/study-artifacts",
        json={"type": "rationale", "title": "A", "topic": "Flaw", "question_id": 10},
    )
    client.post(
        "/api/study-artifacts",
        json={"type": "note", "title": "B", "topic": "Flaw", "question_id": 11},
    )
    client.post(
        "/api/study-artifacts",
        json={"type": "tutor", "title": "C", "topic": "Assumption", "question_id": 10},
    )


def test_list_filter_by_question_id(client):
    _seed_artifacts(client)
    r = client.get("/api/study-artifacts", params={"question_id": 10})
    assert r.status_code == 200
    body = r.json()
    titles = {it["title"] for it in body["items"]}
    assert titles == {"A", "C"}
    assert body["total"] == 2


def test_list_filter_by_type(client):
    _seed_artifacts(client)
    body = client.get("/api/study-artifacts", params={"type": "note"}).json()
    assert {it["title"] for it in body["items"]} == {"B"}
    assert body["total"] == 1
    assert all(it["type"] == "note" for it in body["items"])


def test_list_filter_by_topic(client):
    _seed_artifacts(client)
    body = client.get("/api/study-artifacts", params={"topic": "Flaw"}).json()
    assert {it["title"] for it in body["items"]} == {"A", "B"}
    assert body["total"] == 2


def test_list_filter_combined(client):
    _seed_artifacts(client)
    body = client.get(
        "/api/study-artifacts", params={"topic": "Flaw", "question_id": 10}
    ).json()
    assert {it["title"] for it in body["items"]} == {"A"}
    assert body["total"] == 1


# --- pagination shape -------------------------------------------------------
def test_list_pagination_shape_and_paging(client):
    for i in range(5):
        client.post(
            "/api/study-artifacts",
            json={"type": "note", "title": f"P{i}", "topic": "Pager"},
        )
    first = client.get(
        "/api/study-artifacts", params={"topic": "Pager", "limit": 2, "offset": 0}
    ).json()
    # BC2 envelope shape.
    for key in ("items", "total", "limit", "offset", "has_more"):
        assert key in first
    assert first["total"] == 5
    assert first["limit"] == 2
    assert first["offset"] == 0
    assert len(first["items"]) == 2
    assert first["has_more"] is True

    last = client.get(
        "/api/study-artifacts", params={"topic": "Pager", "limit": 2, "offset": 4}
    ).json()
    assert len(last["items"]) == 1
    assert last["offset"] == 4
    assert last["has_more"] is False


# --- 404s -------------------------------------------------------------------
def test_get_missing_is_404(client):
    assert client.get("/api/study-artifacts/999999").status_code == 404


def test_put_missing_is_404(client):
    assert client.put("/api/study-artifacts/999999", json={"title": "x"}).status_code == 404


def test_delete_missing_is_404(client):
    assert client.delete("/api/study-artifacts/999999").status_code == 404


# --- OpenAPI contract -------------------------------------------------------
def test_study_artifacts_routes_have_openapi_schema(client):
    spec = client.get("/openapi.json").json()
    paths = spec["paths"]
    # collection + item routes are published with typed response_models.
    assert "/api/study-artifacts" in paths or "/api/study-artifacts/" in paths
    item = paths.get("/api/study-artifacts/{artifact_id}")
    assert item is not None
    for method in ("get", "put", "delete"):
        schema = item[method]["responses"]["200"]["content"]["application/json"].get(
            "schema"
        )
        assert schema  # inline typed response_model is published
