"""LSAT-3 — Blind-review rationale capture (br_note) + auto-cloze "Gap" cards.

Covers:
  - migration 21 adds ``attemptrationale.br_note`` (PRAGMA-guarded, idempotent).
  - POST /srs/attempts/{id}/blind-review-note persists an AttemptRationale row
    with the note in ``br_note`` (and 404s for a missing attempt).
  - POST /srs/concept-gap-cards promotes concept-gap questions into distinct
    "Gap" cards (origin="concept_gap_cloze") with a deterministic cloze/pattern,
    is idempotent, and seeds the pattern line from a captured br_note.
"""
from __future__ import annotations

from sqlmodel import Session, select

from app.models import AttemptRationale, SRSCard


def _br(client, attempt_id: int, answer: str) -> dict:
    return client.patch(
        f"/api/attempts/{attempt_id}/blind-review", json={"br_answer": answer}
    ).json()


def _attempt(client, sid: int, qid: int, chosen: str) -> int:
    body = {"question_id": qid, "mode": "timed", "chosen_answer": chosen,
            "time_ms": 60000, "flagged": False}
    return client.post(f"/api/sessions/{sid}/attempts", json=body).json()["attempt_id"]


def _correct(qid: int) -> str:
    from app.db import engine
    from app.models import Question
    with Session(engine) as s:
        return s.get(Question, qid).correct_answer


def _wrong(correct: str) -> str:
    return "A" if correct != "A" else "B"


# Questions 1, 8 have no seeded SRS card; qid 8 is used as a clean concept gap.
Q_CONCEPT = 8


# --- migration 21 -----------------------------------------------------------
def test_migration_21_adds_br_note_column(db_session):
    from app.db import engine

    with engine.begin() as conn:
        rows = conn.exec_driver_sql(
            "SELECT version, name FROM schema_migrations WHERE version = 21"
        ).fetchall()
        cols = {r[1] for r in conn.exec_driver_sql(
            "PRAGMA table_info(attemptrationale)"
        ).fetchall()}
    assert rows and rows[0][1] == "attempt_rationale_br_note"
    assert "br_note" in cols


# --- blind-review note capture ----------------------------------------------
def test_blind_review_note_persists(client):
    sid = client.post("/api/sessions", json={"type": "section", "config": {}}).json()["id"]
    c = _correct(Q_CONCEPT)
    aid = _attempt(client, sid, Q_CONCEPT, _wrong(c))

    r = client.post(
        f"/api/srs/attempts/{aid}/blind-review-note",
        json={"br_note": "Reversed the sufficient/necessary direction.",
              "answer": "C", "confidence": "likely"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["attempt_id"] == aid
    assert body["stage"] == "blind_review"
    assert body["br_note"].startswith("Reversed")

    from app.db import engine
    with Session(engine) as s:
        row = s.exec(
            select(AttemptRationale).where(AttemptRationale.attempt_id == aid)
        ).first()
    assert row is not None
    assert row.br_note == "Reversed the sufficient/necessary direction."
    assert row.question_id == Q_CONCEPT


def test_blind_review_note_unknown_attempt_404(client):
    r = client.post(
        "/api/srs/attempts/999999/blind-review-note",
        json={"br_note": "x"},
    )
    assert r.status_code == 404


def test_blind_review_note_rejects_blank(client):
    sid = client.post("/api/sessions", json={"type": "section", "config": {}}).json()["id"]
    aid = _attempt(client, sid, Q_CONCEPT, "A")
    # min_length=1 — an empty note is a 422 validation error.
    assert client.post(
        f"/api/srs/attempts/{aid}/blind-review-note", json={"br_note": ""}
    ).status_code == 422


# --- auto-cloze gap cards ----------------------------------------------------
def _make_concept_gap(client) -> int:
    """Drive Q_CONCEPT to a concept_gap (timed wrong, BR wrong) and return the qid."""
    sid = client.post("/api/sessions", json={"type": "section", "config": {}}).json()["id"]
    c = _correct(Q_CONCEPT)
    aid = _attempt(client, sid, Q_CONCEPT, _wrong(c))
    _br(client, aid, _wrong(c))  # route_one creates an origin="concept_gap" card
    return aid


def test_concept_gap_cards_promotes_to_gap_type(client):
    _make_concept_gap(client)
    # The concept gap is queued as a plain concept_gap card.
    cgq = client.get("/api/srs/concept-gap-queue").json()
    assert Q_CONCEPT in {c["question_id"] for c in cgq["cards"]}

    r = client.post("/api/srs/concept-gap-cards", json={})
    assert r.status_code == 200
    data = r.json()
    assert data["card_type"] == "gap"
    assert data["origin"] == "concept_gap_cloze"
    assert data["generated"] >= 1
    gap = next(c for c in data["cards"] if c["question_id"] == Q_CONCEPT)
    assert gap["origin"] == "concept_gap_cloze"
    assert gap["card_type"] == "gap"
    assert "______" in gap["cloze"] or gap["answer"] is None
    assert gap["pattern"]  # always a non-empty pattern line

    # The card is now stamped with the distinct Gap origin in the DB.
    from app.db import engine
    with Session(engine) as s:
        card = s.exec(
            select(SRSCard).where(SRSCard.question_id == Q_CONCEPT)
        ).first()
    assert card is not None and card.origin == "concept_gap_cloze"


def test_concept_gap_cards_is_idempotent(client):
    _make_concept_gap(client)
    first = client.post("/api/srs/concept-gap-cards", json={}).json()
    assert first["generated"] >= 1

    from app.db import engine
    with Session(engine) as s:
        n_after_first = len(s.exec(select(SRSCard)).all())

    # A promoted card no longer appears in the concept_gap queue, so a re-run
    # generates nothing and creates no duplicate card.
    second = client.post("/api/srs/concept-gap-cards", json={}).json()
    assert second["generated"] == 0
    with Session(engine) as s:
        n_after_second = len(s.exec(select(SRSCard)).all())
    assert n_after_first == n_after_second


def test_concept_gap_card_pattern_uses_captured_note(client):
    aid = _make_concept_gap(client)
    client.post(
        f"/api/srs/attempts/{aid}/blind-review-note",
        json={"br_note": "Watch the scope shift in the second premise."},
    )
    data = client.post("/api/srs/concept-gap-cards", json={}).json()
    gap = next(c for c in data["cards"] if c["question_id"] == Q_CONCEPT)
    assert gap["pattern"] == "Watch the scope shift in the second premise."


def test_concept_gap_cards_surface_in_due(client):
    _make_concept_gap(client)
    client.post("/api/srs/concept-gap-cards", json={})
    due = client.get("/api/srs/due").json()
    # The /srs/due payload now carries each card's origin so the SRS screen can
    # badge the distinct Gap type; the promoted concept gap is due immediately.
    gap = next(c for c in due["cards"] if c["id"] == Q_CONCEPT)
    assert gap["origin"] == "concept_gap_cloze"
    assert "correct_answer" not in gap  # still answer-key-free
