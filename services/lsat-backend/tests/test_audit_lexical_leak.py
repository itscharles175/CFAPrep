"""LSAT-7 — near-duplicate report + lexical-leak heatmap + audit-log summary.

Locks the cockpit additions:
  * ``audit.near_duplicate_report`` returns a dict (clusters + lexical_leak_sources
    + coverage_by_type) while ``audit.duplicate_clusters`` keeps its list contract,
  * ``content_health.health_report`` gains ``lexical_leak`` + ``audit_log_summary``,
  * ``GET /api/content/audit-log`` serves the AuditLog feed with tallies.
"""
from __future__ import annotations

import re

from app import audit, embeddings
from app.models import AnswerChoice, Question, QuestionSource


_VOCAB = ["cat", "dog", "math", "logic", "bird"]


def _bow(text: str, model=None) -> list[float]:
    t = (text or "").lower()
    return [float(len(re.findall(rf"\b{w}\b", t))) for w in _VOCAB]


def _question_with_length_tell(session, *, source: QuestionSource) -> Question:
    """A question whose credited choice (A) is the uniquely longest — a length tell."""
    q = Question(
        stem="A length-tell item where the credited choice is conspicuously long.",
        prompt="Which one?",
        correct_answer="A",
        q_type="Weaken",
        source=source,
        approved=True,
    )
    session.add(q)
    session.commit()
    session.refresh(q)
    texts = {
        "A": "This is by far the longest, most elaborate, qualified answer choice here.",
        "B": "short",
        "C": "tiny",
        "D": "brief",
        "E": "small",
    }
    for label, text in texts.items():
        session.add(AnswerChoice(
            question_id=q.id, label=label, text=text, is_correct=(label == "A"),
        ))
    session.commit()
    return q


def test_duplicate_clusters_still_returns_list(db_session):
    """Backward-compat: the list-shaped contract that /api/bank/duplicates relies on
    is untouched by the new report function."""
    clusters = audit.duplicate_clusters(db_session, threshold=0.99)
    assert isinstance(clusters, list)


def test_near_duplicate_report_shape_and_leak_sources(db_session):
    _question_with_length_tell(db_session, source=QuestionSource.ai_generated)
    embeddings.backfill_question_embeddings(db_session, embedder=_bow)

    report = audit.near_duplicate_report(db_session, threshold=0.93)
    assert isinstance(report, dict)
    assert isinstance(report["clusters"], list)
    assert report["cluster_count"] == len(report["clusters"])
    # The lexical-leak source must include the ai_generated source we just leaked on.
    leak_sources = {row["source"] for row in report["lexical_leak_sources"]}
    assert "ai_generated" in leak_sources
    leak_row = next(r for r in report["lexical_leak_sources"] if r["source"] == "ai_generated")
    assert leak_row["length_tell"] >= 1
    assert 0.0 <= leak_row["rate"] <= 1.0
    # Coverage-by-type carries the Weaken type we seeded.
    coverage_types = {row["q_type"] for row in report["coverage_by_type"]}
    assert "Weaken" in coverage_types


def test_health_report_includes_lexical_leak_and_audit_summary(db_session):
    _question_with_length_tell(db_session, source=QuestionSource.ai_generated)
    from app import content_health

    report = content_health.health_report(db_session)
    assert "lexical_leak" in report
    assert "audit_log_summary" in report
    leak = report["lexical_leak"]
    assert leak["total_length_tells"] >= 1
    assert any(cell["length_tell"] >= 1 for cell in leak["cells"])
    summary = report["audit_log_summary"]
    assert "by_entity" in summary and "by_field" in summary and "recent" in summary


def test_audit_log_endpoint_serves_edits_with_tallies(client):
    from sqlmodel import Session, select

    from app.db import engine

    # Record an edit on a seeded question through the audit trail (same shared
    # engine the TestClient uses) so the feed is non-empty.
    with Session(engine) as s:
        q = s.exec(select(Question)).first()
        assert q is not None
        audit.record_edit(
            s, entity="question", entity_id=q.id, field="q_type",
            old_value=q.q_type, new_value="Flaw", commit=True,
        )
    res = client.get("/api/content/audit-log")
    assert res.status_code == 200
    body = res.json()
    assert "edits" in body and "by_entity" in body and "by_field" in body
    assert body["count"] == len(body["edits"])
    assert body["count"] >= 1
    assert "question" in body["by_entity"]
