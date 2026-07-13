"""ANL-3 — cross-domain blind-review gap (careless vs concept).

Covers:
  - BACKWARD COMPAT: GET /api/analytics/blind-review-gap with no ``?domain=``
    returns the unchanged LSAT-native shape (timed/br accuracy, gap, by_type,
    lucky_rate_by_type) and is NOT broken by the new branch.
  - The cross-domain function/endpoint merges LSAT Attempt(br_answer/br_correct)
    with HOST blind-review attempts mirrored via DATA-4a HostProgressSnapshot
    (payload brAnswer/brCorrect), reporting the 2x2 outcome distribution,
    careless/concept/lucky rates, accuracy-by-type, and per-domain blocks.
  - ``domain=`` plane selection: lsat / host / all / a specific host plane.
  - Only attempts that captured a BR answer contribute (mirrors the LSAT gate).

Deterministic test data, in the style of test_analytics.py / test_sync_progress.py.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlmodel import delete

from app import analytics
from app.models import (
    Attempt,
    AttemptMode,
    HostProgressSnapshot,
    Question,
    QuestionSource,
    StudySession,
)


# --- builders ---------------------------------------------------------------
def _mk_session(db):
    s = StudySession(type="drill")
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def _mk_question(db, *, q_type="Flaw", correct="A"):
    q = Question(
        stem="A diagnostic stem with sufficient detail for the bank.",
        prompt="Which answer is best supported?",
        correct_answer=correct,
        q_type=q_type,
        difficulty=3,
        source=QuestionSource.sample,
    )
    db.add(q)
    db.commit()
    db.refresh(q)
    return q


def _mk_attempt(db, *, q, s, correct, br_correct=None, br_answer=None, time_ms=60_000):
    a = Attempt(
        question_id=q.id,
        session_id=s.id,
        mode=AttemptMode.timed,
        chosen_answer=q.correct_answer if correct else "Z",
        is_correct=correct,
        time_ms=time_ms,
        br_correct=br_correct,
        br_answer=br_answer,
    )
    db.add(a)
    db.commit()
    db.refresh(a)
    return a


def _host_attempt_snapshot(db, *, plane, cross_id, correct, br_answer=None, br_correct=None):
    """A DATA-4a host attempt snapshot whose canonical payload carries the ANL-3
    blind-review fields the host now captures (brAnswer/brCorrect)."""
    payload = {
        "crossId": cross_id,
        "domain": plane,
        "questionCrossId": f"{plane}:question:q1",
        "correct": correct,
    }
    if br_answer is not None:
        payload["brAnswer"] = br_answer
    if br_correct is not None:
        payload["brCorrect"] = br_correct
    snap = HostProgressSnapshot(
        cross_id=cross_id,
        kind="attempt",
        plane=plane,
        dedupe_key=cross_id,
        payload=payload,
    )
    db.add(snap)
    db.commit()
    db.refresh(snap)
    return snap


def _clear_attempts(db):
    db.execute(delete(Attempt))
    db.commit()


# --- backward compatibility -------------------------------------------------
def test_default_endpoint_unchanged(client):
    """No ?domain= => the LSAT-native shape (no meta/by_domain), exactly as before."""
    g = client.get("/api/analytics/blind-review-gap").json()
    assert "timed_accuracy" in g and "br_accuracy" in g and "gap" in g
    assert isinstance(g["by_type"], list)
    assert isinstance(g["lucky_rate_by_type"], dict)
    # The default branch must NOT carry the cross-domain-only keys.
    assert g.get("meta") is None
    assert g.get("by_domain") is None


def test_default_function_matches_legacy(db_session):
    """blind_review_gap_cross_domain(domain='lsat') agrees with the legacy
    top-line over the same LSAT data."""
    legacy = analytics.blind_review_gap(db_session)
    cd = analytics.blind_review_gap_cross_domain(db_session, domain="lsat")
    assert cd["timed_accuracy"] == legacy["timed_accuracy"]
    assert cd["br_accuracy"] == legacy["br_accuracy"]
    assert cd["gap"] == legacy["gap"]


# --- 2x2 outcomes + careless vs concept -------------------------------------
def test_cross_domain_outcomes_and_rates(db_session):
    _clear_attempts(db_session)
    s = _mk_session(db_session)
    # LSAT: 1 timed_ok, 1 timing_problem (careless), 1 concept_gap, 1 lucky.
    q1 = _mk_question(db_session, q_type="Flaw")
    _mk_attempt(db_session, q=q1, s=s, correct=True, br_correct=True, br_answer="A")   # timed_ok
    q2 = _mk_question(db_session, q_type="Flaw")
    _mk_attempt(db_session, q=q2, s=s, correct=False, br_correct=True, br_answer="A")  # timing_problem
    q3 = _mk_question(db_session, q_type="Flaw")
    _mk_attempt(db_session, q=q3, s=s, correct=False, br_correct=False, br_answer="Z")  # concept_gap
    q4 = _mk_question(db_session, q_type="Flaw")
    _mk_attempt(db_session, q=q4, s=s, correct=True, br_correct=False, br_answer="Z")  # lucky

    out = analytics.blind_review_gap_cross_domain(db_session, domain="lsat")
    assert out["outcomes"] == {
        "timed_ok": 1, "timing_problem": 1, "concept_gap": 1, "lucky": 1,
    }
    assert out["careless_rate"] == 0.25
    assert out["concept_gap_rate"] == 0.25
    assert out["lucky_rate"] == 0.25
    assert out["meta"]["lsat_attempts"] == 4
    assert out["meta"]["host_attempts"] == 0
    assert out["meta"]["model"] == "cross_domain_blind_review_v1"


def test_host_only_from_snapshots(db_session):
    _clear_attempts(db_session)
    # 3 host BR attempts on the CFA plane: 2 timing_problem (careless), 1 concept_gap.
    _host_attempt_snapshot(db_session, plane="cfa", cross_id="cfa:attempt:1",
                           correct=False, br_answer="1", br_correct=True)
    _host_attempt_snapshot(db_session, plane="cfa", cross_id="cfa:attempt:2",
                           correct=False, br_answer="1", br_correct=True)
    _host_attempt_snapshot(db_session, plane="cfa", cross_id="cfa:attempt:3",
                           correct=False, br_answer="2", br_correct=False)
    # A host attempt with NO BR answer must not contribute.
    _host_attempt_snapshot(db_session, plane="cfa", cross_id="cfa:attempt:4",
                           correct=True)

    out = analytics.blind_review_gap_cross_domain(db_session, domain="host")
    assert out["meta"]["host_attempts"] == 3
    assert out["meta"]["lsat_attempts"] == 0
    assert out["outcomes"] == {
        "timed_ok": 0, "timing_problem": 2, "concept_gap": 1, "lucky": 0,
    }
    # careless = 2/3, concept = 1/3.
    assert out["careless_rate"] == round(2 / 3, 4)
    assert out["concept_gap_rate"] == round(1 / 3, 4)
    # by_domain blocks split the two planes.
    assert out["by_domain"]["host"]["attempts"] == 3
    assert out["by_domain"]["lsat"]["attempts"] == 0


def test_all_merges_lsat_and_host(db_session):
    _clear_attempts(db_session)
    s = _mk_session(db_session)
    # LSAT: 2 concept_gap.
    for _ in range(2):
        q = _mk_question(db_session, q_type="Inference")
        _mk_attempt(db_session, q=q, s=s, correct=False, br_correct=False, br_answer="Z")
    # Host: 2 timing_problem.
    _host_attempt_snapshot(db_session, plane="quant", cross_id="quant:attempt:1",
                           correct=False, br_answer="0", br_correct=True)
    _host_attempt_snapshot(db_session, plane="quant", cross_id="quant:attempt:2",
                           correct=False, br_answer="0", br_correct=True)

    out = analytics.blind_review_gap_cross_domain(db_session, domain="all")
    assert out["meta"]["lsat_attempts"] == 2
    assert out["meta"]["host_attempts"] == 2
    assert out["outcomes"] == {
        "timed_ok": 0, "timing_problem": 2, "concept_gap": 2, "lucky": 0,
    }
    assert out["careless_rate"] == 0.5
    assert out["concept_gap_rate"] == 0.5
    # by_type groups host rows under the plane key, LSAT under the q_type.
    keys = {row["q_type"] for row in out["by_type"]}
    assert "Inference" in keys
    assert "quant" in keys


def test_specific_host_plane_filters(db_session):
    _clear_attempts(db_session)
    _host_attempt_snapshot(db_session, plane="cfa", cross_id="cfa:attempt:1",
                           correct=False, br_answer="1", br_correct=True)
    _host_attempt_snapshot(db_session, plane="excel", cross_id="excel:attempt:1",
                           correct=False, br_answer="1", br_correct=True)
    out = analytics.blind_review_gap_cross_domain(db_session, domain="cfa")
    assert out["meta"]["host_attempts"] == 1
    keys = {row["q_type"] for row in out["by_type"]}
    assert keys == {"cfa"}


def test_lucky_rate_by_type_floor(db_session):
    """lucky_rate_by_type only includes types with >= 3 BR attempts (shared floor)."""
    _clear_attempts(db_session)
    s = _mk_session(db_session)
    # 3 lucky (timed-right / BR-wrong) on "Weaken" => included at the floor.
    for _ in range(3):
        q = _mk_question(db_session, q_type="Weaken")
        _mk_attempt(db_session, q=q, s=s, correct=True, br_correct=False, br_answer="Z")
    # 2 on "Method" => below the floor, excluded.
    for _ in range(2):
        q = _mk_question(db_session, q_type="Method")
        _mk_attempt(db_session, q=q, s=s, correct=True, br_correct=False, br_answer="Z")
    out = analytics.blind_review_gap_cross_domain(db_session, domain="lsat")
    assert out["lucky_rate_by_type"].get("Weaken") == 1.0
    assert "Method" not in out["lucky_rate_by_type"]


def test_endpoint_domain_param(client):
    """The endpoint accepts ?domain= and returns the cross-domain shape."""
    g = client.get("/api/analytics/blind-review-gap?domain=all").json()
    assert g["meta"]["model"] == "cross_domain_blind_review_v1"
    assert g["meta"]["domain"] == "all"
    assert "outcomes" in g and "careless_rate" in g and "by_domain" in g


def test_endpoint_rejects_unknown_domain(client):
    """An out-of-vocabulary domain is a 422 (the pattern guard), not a 500."""
    r = client.get("/api/analytics/blind-review-gap?domain=bogus")
    assert r.status_code == 422


def test_no_br_data_is_empty_not_error(db_session):
    """No BR attempts anywhere => zeroed blocks, never an exception."""
    _clear_attempts(db_session)
    out = analytics.blind_review_gap_cross_domain(db_session, domain="all")
    assert out["outcomes"] == {
        "timed_ok": 0, "timing_problem": 0, "concept_gap": 0, "lucky": 0,
    }
    assert out["careless_rate"] == 0.0
    assert out["by_type"] == []
    assert out["lucky_rate_by_type"] == {}
