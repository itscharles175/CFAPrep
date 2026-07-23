"""LEARN-1 — unified cross-domain ability model.

Covers ``adaptivity.ability_estimate``'s new optional ``domain`` parameter:
  - ``domain=None`` is the historical LSAT-only behaviour, unchanged (and now
    carries a self-describing ``domain="lsat"`` key);
  - a host plane (``cfa``/``quant``/``excel``) reads HostProgressSnapshot
    attempt rows (DATA-4a), feeds the SAME estimation math, and produces a sane
    estimate with blind-review outcomes zeroed (no BR analogue for host);
  - an unknown domain degrades gracefully to an empty (zeroed) estimate rather
    than leaking LSAT evidence;
  - the GET /api/adaptivity/ability route honours the optional ``?domain=``.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlmodel import Session, select

from app import adaptivity
from app.models import (
    Attempt,
    AttemptMode,
    Confidence,
    HostProgressSnapshot,
    Question,
    QuestionSource,
    SessionType,
    StudySession,
)


def _lsat_attempts(db_session: Session, *, n_correct: int = 4, n_wrong: int = 2) -> None:
    """Seed a small, deterministic LSAT attempt set (clears any seeded ones first)."""
    for row in db_session.exec(select(Attempt)).all():
        db_session.delete(row)
    db_session.commit()

    session = StudySession(type=SessionType.drill)
    db_session.add(session)
    db_session.commit()
    db_session.refresh(session)

    when = datetime.now(timezone.utc) - timedelta(days=5)
    total = n_correct + n_wrong
    for idx in range(total):
        correct = idx < n_correct
        q = Question(
            stem=f"learn1 lsat {idx}",
            prompt="Which choice follows?",
            correct_answer="A",
            difficulty=3,
            q_type="Flaw",
            source=QuestionSource.official,
            approved=True,
        )
        db_session.add(q)
        db_session.commit()
        db_session.refresh(q)
        db_session.add(
            Attempt(
                question_id=q.id,
                session_id=session.id,
                mode=AttemptMode.timed,
                chosen_answer="A" if correct else "B",
                is_correct=correct,
                time_ms=70_000,
                confidence=Confidence.likely,
                created_at=when + timedelta(hours=idx),
            )
        )
    db_session.commit()


def _host_attempt_snapshot(cross_id: str, *, correct: bool, difficulty: str = "intermediate",
                           confidence: str = "medium", elapsed: int = 60,
                           created_at: str | None = None) -> HostProgressSnapshot:
    payload: dict = {
        "crossId": cross_id,
        "domain": "cfa",
        "questionCrossId": cross_id.replace(":attempt:", ":question:"),
        "correct": correct,
        "confidence": confidence,
        "difficulty": difficulty,
        "elapsedSeconds": elapsed,
    }
    if created_at:
        payload["createdAt"] = created_at
    return HostProgressSnapshot(
        cross_id=cross_id,
        kind="attempt",
        plane="cfa",
        dedupe_key=cross_id,
        payload=payload,
    )


def _seed_host_attempts(db_session: Session, *, n_correct: int = 4, n_wrong: int = 2,
                        plane: str = "cfa") -> None:
    base = datetime.now(timezone.utc) - timedelta(days=10)
    total = n_correct + n_wrong
    for idx in range(total):
        correct = idx < n_correct
        snap = _host_attempt_snapshot(
            f"{plane}:attempt:{idx}",
            correct=correct,
            created_at=(base + timedelta(hours=idx)).isoformat(),
        )
        snap.plane = plane
        snap.payload["domain"] = plane
        db_session.add(snap)
    db_session.commit()


# --- domain=None is unchanged LSAT-only behaviour --------------------------
def test_domain_none_matches_lsat_only(db_session):
    _lsat_attempts(db_session, n_correct=4, n_wrong=2)

    default = adaptivity.ability_estimate(db_session)
    explicit_none = adaptivity.ability_estimate(db_session, domain=None)

    # The default and the explicit None path are identical (no behaviour change).
    assert default == explicit_none
    # Six LSAT attempts seen, self-describing as the "lsat" plane (additive key).
    assert default["evidence_n"] == 6
    assert default["domain"] == "lsat"
    assert default["accuracy"] == round(4 / 6, 4)
    assert default["model"] == "local_irt_elo_v2"


def test_domain_none_does_not_read_host_snapshots(db_session):
    _lsat_attempts(db_session, n_correct=3, n_wrong=1)
    _seed_host_attempts(db_session, n_correct=5, n_wrong=0)

    # The default (LSAT-only) estimate must NOT pick up the host attempt rows.
    default = adaptivity.ability_estimate(db_session)
    assert default["evidence_n"] == 4
    assert default["domain"] == "lsat"


# --- domain="cfa" reads HostProgressSnapshot -------------------------------
def test_host_domain_reads_snapshots_and_estimates(db_session):
    # No LSAT attempts at all, only host attempts: the estimate must come
    # entirely from the host plane.
    for row in db_session.exec(select(Attempt)).all():
        db_session.delete(row)
    db_session.commit()
    _seed_host_attempts(db_session, n_correct=4, n_wrong=2, plane="cfa")

    est = adaptivity.ability_estimate(db_session, domain="cfa")

    assert est["domain"] == "cfa"
    assert est["evidence_n"] == 6
    assert est["accuracy"] == round(4 / 6, 4)
    # A sane bounded estimate from the shared math.
    assert 0.0 <= est["mastery"] <= 1.0
    assert 0.0 <= est["uncertainty"] <= 1.0
    assert est["model"] == "local_irt_elo_v2"
    # Host has no Blind Review analogue: those outcome counters stay zeroed.
    assert est["components"]["blind_review_outcomes"] == {
        "timed_ok": 0,
        "timing_problem": 0,
        "concept_gap": 0,
        "lucky": 0,
    }
    # avg_time_ms reflects the host elapsedSeconds (60s -> 60_000ms).
    assert est["avg_time_ms"] == 60_000.0


def test_host_domain_more_correct_raises_ability(db_session):
    _seed_host_attempts(db_session, n_correct=6, n_wrong=0, plane="quant")
    strong = adaptivity.ability_estimate(db_session, domain="quant")

    for row in db_session.exec(select(HostProgressSnapshot)).all():
        db_session.delete(row)
    db_session.commit()
    _seed_host_attempts(db_session, n_correct=1, n_wrong=5, plane="quant")
    weak = adaptivity.ability_estimate(db_session, domain="quant")

    # More-correct evidence yields a higher ability/mastery than mostly-wrong.
    assert strong["ability"] > weak["ability"]
    assert strong["mastery"] > weak["mastery"]


def test_host_domain_only_reads_its_own_plane(db_session):
    _seed_host_attempts(db_session, n_correct=3, n_wrong=0, plane="cfa")
    _seed_host_attempts(db_session, n_correct=2, n_wrong=0, plane="excel")

    cfa = adaptivity.ability_estimate(db_session, domain="cfa")
    excel = adaptivity.ability_estimate(db_session, domain="excel")

    assert cfa["evidence_n"] == 3
    assert excel["evidence_n"] == 2


def test_host_domain_persist_does_not_write_lsat_snapshot(db_session):
    from app.models import AbilitySnapshot

    _seed_host_attempts(db_session, n_correct=3, n_wrong=1, plane="cfa")
    before = len(db_session.exec(select(AbilitySnapshot)).all())
    # Even with persist=True, a host-plane read must not pollute the LSAT
    # AbilitySnapshot history (read-only cross-domain contract).
    est = adaptivity.ability_estimate(db_session, domain="cfa", persist=True)
    after = len(db_session.exec(select(AbilitySnapshot)).all())
    assert after == before
    assert "snapshot_id" not in est


# --- unknown domain degrades gracefully ------------------------------------
def test_unknown_domain_degrades_gracefully(db_session):
    _lsat_attempts(db_session, n_correct=4, n_wrong=0)
    _seed_host_attempts(db_session, n_correct=4, n_wrong=0, plane="cfa")

    est = adaptivity.ability_estimate(db_session, domain="martian")

    # Unknown plane: empty estimate, never a silent fallback to LSAT/host data.
    assert est["domain"] == "martian"
    assert est["evidence_n"] == 0
    assert est["accuracy"] is None
    assert est["ability"] == 0.0
    assert est["uncertainty"] == 1.0


def test_host_domain_empty_when_no_snapshots(db_session):
    # A valid host plane with no snapshots yet is a sane empty estimate.
    est = adaptivity.ability_estimate(db_session, domain="excel")
    assert est["domain"] == "excel"
    assert est["evidence_n"] == 0
    assert est["accuracy"] is None


# --- route honours the optional ?domain= -----------------------------------
def test_route_default_is_lsat_matrix(client):
    r = client.get("/api/adaptivity/ability")
    assert r.status_code == 200
    body = r.json()
    # Unchanged default: the LSAT ability matrix (overall/by_type/selector).
    assert "overall" in body
    assert "by_type" in body


def test_route_q_type_returns_serializable_selector_snapshot(client):
    r = client.get("/api/adaptivity/ability", params={"q_type": "Flaw"})

    assert r.status_code == 200
    body = r.json()
    assert body["q_type"] == "Flaw"
    assert body["selector"]["ability"]["q_type"] == "Flaw"
    assert "selector" not in body["selector"]["ability"]


def test_route_host_domain_returns_unified_estimate(client):
    from app.db import engine

    with Session(engine) as s:
        _seed_host_attempts(s, n_correct=3, n_wrong=1, plane="cfa")

    r = client.get("/api/adaptivity/ability", params={"domain": "cfa"})
    assert r.status_code == 200
    body = r.json()
    assert body["domain"] == "cfa"
    assert body["evidence_n"] == 4
    assert "mastery" in body and "ability" in body
    # No LSAT matrix keys on the host-plane estimate.
    assert "by_type" not in body


def test_route_rejects_unsupported_domain(client):
    # The route's Literal narrows ?domain= to the host planes; anything else 422s.
    r = client.get("/api/adaptivity/ability", params={"domain": "lsat"})
    assert r.status_code == 422
