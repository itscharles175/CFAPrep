"""LSAT-6 — Annotation Notebook knowledge-base: FTS search, backlinks, inline
explanation authoring, and tags.

Verifies migration 25 ran (the FTS5 mirror + nullable columns exist) and that the
new ``annotation_kb_routes`` endpoints search/resolve/persist as contracted,
WITHOUT disturbing the existing scope-based annotation CRUD.
"""
from __future__ import annotations

from sqlmodel import Session

from app.db import engine
from app.models import Annotation, Question, QuestionSource


def _make_question() -> int:
    """Insert a real Question (so the scope-based GET, which validates existence,
    serves it) and return its id."""
    with Session(engine) as session:
        q = Question(
            stem="KB test stem placeholder",
            prompt="KB test prompt placeholder",
            correct_answer="A",
            difficulty=2,
            q_type="Flaw",
            source=QuestionSource.sample,
            approved=True,
        )
        session.add(q)
        session.commit()
        session.refresh(q)
        assert q.id is not None
        return q.id


def _make_annotation(
    scope: str = "question",
    ref_id: int = 1,
    *,
    notes: list[dict] | None = None,
    user_explanation: str | None = None,
    tags_json: str | None = None,
) -> int:
    """Insert an Annotation row directly and return its id."""
    with Session(engine) as session:
        row = Annotation(
            scope=scope,
            ref_id=ref_id,
            data_json={"highlights": [], "notes": notes or []},
            user_explanation=user_explanation,
            tags_json=tags_json,
        )
        session.add(row)
        session.commit()
        session.refresh(row)
        assert row.id is not None
        return row.id


def test_migration_25_applied_and_columns_exist(client):
    """Migration 25 records itself, bumps user_version, and adds the FTS table +
    the two nullable Annotation columns."""
    with engine.begin() as conn:
        versions = {
            int(r[0])
            for r in conn.exec_driver_sql(
                "SELECT version FROM schema_migrations"
            ).fetchall()
        }
        assert 25 in versions
        cols = {
            r[1]
            for r in conn.exec_driver_sql("PRAGMA table_info(annotation)").fetchall()
        }
        assert "user_explanation" in cols
        assert "tags_json" in cols
        fts = conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='annotation_fts'"
        ).fetchone()
        assert fts is not None


def test_explanation_post_persists_and_is_searchable(client):
    """POSTing a user explanation persists it AND makes it FTS-searchable."""
    ann_id = _make_annotation(ref_id=101)

    # No explanation yet.
    got = client.get(f"/api/annotations/{ann_id}/explanation")
    assert got.status_code == 200
    assert got.json()["user_explanation"] == ""

    # Author one.
    posted = client.post(
        f"/api/annotations/{ann_id}/explanation",
        json={"user_explanation": "Watch for a necessary-condition reversal here."},
    )
    assert posted.status_code == 200
    assert posted.json()["ok"] is True

    # Persisted on read-back.
    again = client.get(f"/api/annotations/{ann_id}/explanation").json()
    assert "necessary-condition reversal" in again["user_explanation"]

    # FTS finds it by a keyword from the explanation text.
    search = client.get("/api/annotations/search?q=reversal").json()
    assert search["mode"] in {"fts", "like"}
    ids = {h["annotation_id"] for h in search["hits"]}
    assert ann_id in ids


def test_search_matches_note_text_from_data_json(client):
    """A margin-note body packed in data_json is indexed and matchable."""
    ann_id = _make_annotation(
        ref_id=202,
        notes=[{"id": "n1", "body": "Equivocation between two senses of 'right'."}],
    )
    # The migration backfill only saw rows present at migration time; this row was
    # inserted after, so seed the FTS via an explanation write OR rely on the
    # search route. Author an (empty-ish) explanation to trigger a re-mirror.
    client.post(
        f"/api/annotations/{ann_id}/explanation",
        json={"user_explanation": ""},
    )
    search = client.get("/api/annotations/search?q=equivocation").json()
    ids = {h["annotation_id"] for h in search["hits"]}
    assert ann_id in ids


def test_tags_put_and_tag_backlinks(client):
    """PUT tags persists a de-duplicated list and powers tag: backlinks."""
    ann_id = _make_annotation(ref_id=303)
    put = client.put(
        f"/api/annotations/{ann_id}/tags",
        json={"tags": ["causal-reversal", "causal-reversal", " degree "]},
    )
    assert put.status_code == 200
    tags = put.json()["tags"]
    assert tags == ["causal-reversal", "degree"]

    # tag: backlink resolves every annotation carrying the tag.
    bl = client.get("/api/annotations/backlinks/tag:causal-reversal").json()
    ids = {h["annotation_id"] for h in bl["backlinks"]}
    assert ann_id in ids


def test_ref_backlinks_resolve_scope_and_id(client):
    """A scope:ref_id backlink returns the matching annotation."""
    ann_id = _make_annotation(scope="question", ref_id=404)
    bl = client.get("/api/annotations/backlinks/question:404").json()
    assert bl["count"] >= 1
    ids = {h["annotation_id"] for h in bl["backlinks"]}
    assert ann_id in ids

    # An unrelated ref returns nothing.
    empty = client.get("/api/annotations/backlinks/question:999999").json()
    assert empty["count"] == 0


def test_explanation_404_for_unknown_annotation(client):
    missing = client.get("/api/annotations/123456789/explanation")
    assert missing.status_code == 404


def test_existing_scope_crud_still_works(client):
    """The new KB routes are additive — the original scope-based annotation
    GET/PUT contract is unchanged."""
    qid = _make_question()
    ann_id = _make_annotation(scope="question", ref_id=qid)
    # Existing question-scoped GET still serves the opaque highlight payload.
    got = client.get(f"/api/questions/{qid}/annotations")
    assert got.status_code == 200
    assert "highlights" in got.json()
    # And the id route the KB uses points at the same row.
    expl = client.get(f"/api/annotations/{ann_id}/explanation").json()
    assert expl["ref_id"] == qid
