"""Quality audit + near-duplicate clustering (D4) and the report bundle (D6)."""
from __future__ import annotations

import re

from app import audit, embeddings
from app.models import Question, QuestionSource

_VOCAB = ["cat", "dog", "math", "logic", "bird"]


def _bow(text: str, model=None) -> list[float]:
    t = (text or "").lower()
    return [float(len(re.findall(rf"\b{w}\b", t))) for w in _VOCAB]


def _mk(session, stem: str) -> Question:
    q = Question(stem=stem, prompt=stem, correct_answer="A", q_type="Inference",
                 source=QuestionSource.research)
    session.add(q)
    session.commit()
    session.refresh(q)
    return q


def test_quality_report_flags_placeholders(db_session):
    _mk(db_session, "a research item left as a generic placeholder type")
    rep = audit.quality_report(db_session)
    assert rep["total"] >= 14
    assert rep["by_source"].get("sample", 0) >= 13
    # the research item above keeps the generic "Inference" placeholder
    assert rep["generic_placeholder"] >= 1
    assert "missing_trap_tags" in rep and "length_tell" in rep


def test_duplicate_clusters_groups_near_identical(db_session):
    _mk(db_session, "logic logic logic")
    _mk(db_session, "logic logic logic")   # near-identical -> should cluster
    _mk(db_session, "math math math")       # distinct

    embeddings.backfill_question_embeddings(db_session, embedder=_bow)
    clusters = audit.duplicate_clusters(db_session, threshold=0.99)
    assert any(c["size"] >= 2 for c in clusters)


def test_audit_and_report_endpoints(client):
    a = client.get("/api/bank/audit").json()
    assert "total" in a and "by_source" in a

    rep = client.get("/api/analytics/report").json()
    for key in ("dashboard", "by_type", "mastery", "blind_review_gap",
                "traps", "forecast", "activity"):
        assert key in rep
