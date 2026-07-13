"""Round 5 wave 4: bulk-tag, re-import replace, observability, questions/similar."""
from __future__ import annotations

import re

from sqlmodel import Session, select

from app import embeddings, import_pdf
from app.db import engine
from app.models import PrepTest, Question, QuestionSource

_VOCAB = ["cat", "dog", "math", "logic", "bird"]


def _bow(text: str, model=None) -> list[float]:
    t = (text or "").lower()
    return [float(len(re.findall(rf"\b{w}\b", t))) for w in _VOCAB]


# --- F2: bulk-tag -----------------------------------------------------------
def test_bulk_tag_sets_type_and_confidence(client):
    body = {"question_ids": [1, 2], "q_type": "Paradox", "difficulty": 4}
    r = client.post("/api/bank/bulk-tag", json=body)
    assert r.json()["updated"] == 2
    with Session(engine) as s:
        q = s.get(Question, 1)
        assert q.q_type == "Paradox"
        assert q.difficulty == 4
        assert q.tag_confidence == "high"


def test_bulk_tag_rejects_empty_patch(client):
    r = client.post("/api/bank/bulk-tag", json={"question_ids": [1]})
    assert r.status_code == 400
    assert "q_type" in r.json()["detail"]


def test_bulk_tag_reports_missing_and_unchanged(client):
    body = {"question_ids": [1, 999999], "q_type": "Paradox", "difficulty": 4}
    first = client.post("/api/bank/bulk-tag", json=body)
    assert first.status_code == 200

    second = client.post("/api/bank/bulk-tag", json=body)
    assert second.status_code == 200
    assert second.json()["updated"] == 0
    assert second.json()["missing"] == 1
    assert second.json()["unchanged"] == 1


# --- F8: re-import collision + replace -------------------------------------
def test_reimport_replace_avoids_duplicate(db_session):
    parsed = {
        "name": "Collision PT",
        "sections": [{"type": "LR", "passages": [], "questions": [
            {"stem": "s1", "prompt": "p", "q_type": "Weaken", "difficulty": 3,
             "correct_answer": "A", "choices": [{"label": x, "text": x} for x in "ABCDE"]},
        ]}],
    }
    pid1 = import_pdf.commit_structure(db_session, parsed, source="sample")
    coll = import_pdf.find_collision(db_session, "Collision PT")
    assert coll and coll["preptest_id"] == pid1 and coll["question_count"] == 1

    # replace: should delete the old PT's content, not add a second copy
    import_pdf.commit_structure(db_session, parsed, source="sample", replace=True)
    pts = db_session.exec(select(PrepTest).where(PrepTest.name == "Collision PT")).all()
    assert len(pts) == 1                       # replaced, not duplicated
    coll2 = import_pdf.find_collision(db_session, "Collision PT")
    assert coll2["question_count"] == 1        # only the re-imported question remains


def test_parse_response_reports_no_collision_for_new_name(client):
    # endpoint-level: a fresh fixture name has no collision
    import io
    import os
    import tempfile
    path = os.path.join(tempfile.gettempdir(), "lsatlab_w4_fixture.pdf")
    import_pdf.write_fixture_pdf(path)
    with open(path, "rb") as f:
        data = f.read()
    r = client.post("/api/import/parse",
                    files={"file": ("t.pdf", io.BytesIO(data), "application/pdf")})
    assert r.status_code == 200
    assert "collision" in r.json()


# --- H6: observability status ----------------------------------------------
def test_observability_status(client):
    body = client.get("/api/observability/status").json()
    for key in ("gen_queued", "gen_running", "worker_alive",
                "last_coach_refresh_ms", "explain_p50_ms", "embed_coverage_pct",
                "models"):
        assert key in body
    assert body["worker_alive"] is False         # disabled in tests
    assert 0.0 <= body["embed_coverage_pct"] <= 100.0


def test_explain_latency_ring():
    from app import observability
    # the ring is module-global; isolate this test from others' recordings.
    observability._LATENCY.pop("explain_stream", None)
    observability.record_latency("explain_stream", 100.0)
    observability.record_latency("explain_stream", 200.0)
    observability.record_latency("explain_stream", 300.0)
    assert observability.latency_p50("explain_stream") == 200.0


# --- H10: questions/{id}/similar -------------------------------------------
def test_questions_similar_empty_without_embeddings(client):
    # nothing embedded -> [] and (critically) no model call
    assert client.get("/api/questions/1/similar").json() == []


def test_questions_similar_returns_question_objects(client, monkeypatch):
    import app.llm as llm
    monkeypatch.setattr(llm, "embed_sync", _bow)
    client.post("/api/bank/embed", json={"limit": 100})   # embed the bank with the fake
    rows = client.get("/api/questions/1/similar?k=3").json()
    assert isinstance(rows, list)
    if rows:
        assert "id" in rows[0] and "similarity" in rows[0] and "choices" in rows[0]
