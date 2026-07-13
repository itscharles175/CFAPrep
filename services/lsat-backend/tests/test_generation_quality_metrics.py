"""INT-5 — generation-quality observability.

Covers the two derived, read-only surfaces:
  - ``generation.quality_metrics`` / ``GET /api/gen/generation/quality-metrics``:
    per-type pass rates + per-gate (8+ pipeline gates) judged/passed/failed +
    fail-reason histograms, replayed from stored ``GenJob.validation_report``
    candidate ``checks`` (no model calls, no DB writes, no new table).
  - ``generation.audit_log`` / ``GET /api/gen/generation/audit-log``: recent
    generate/validate/firewall events derived from ``GenCandidate`` rows, newest
    first, with an optional ``?kind=`` filter and a scanned-window ``counts`` tally.
"""
from __future__ import annotations

from app import generation
from app.models import GenCandidate, GenJob, GenStatus


# A passed candidate's flattened checks: every gate ran and passed. Mirrors the
# slots ``validate_candidate`` writes (the keys ``_GENERATION_QUALITY_GATES``
# reads via ``_gate_pass``).
def _passing_checks() -> dict:
    return {
        "structural": True,
        "trap_metadata": {"ok": True},
        "no_length_tell": True,
        "lexical_leak_ok": {"ok": True},
        "deterministic_solve": {"ok": True, "solved": "B", "credited": "B"},
        "self_consistency_confidence": 1.0,
        "permutation_invariant": {"ok": True},
        "informativity": {"ok": True},
        "single_defensible": True,
        "distractor_quality": {"ok": True},
        "cove_verify": {"ok": True},
        "multi_model_agreement": {"ok": True},
        "structural_type": {"ok": True, "reason": None},
        "rc_authenticity": {"ok": True, "flags": []},
        "novelty": {"ok": True, "checked": True},
    }


def _passing_candidate() -> dict:
    return {
        "passed": True,
        "reason": None,
        "self_consistency_pass": True,
        "checks": _passing_checks(),
    }


def _solve_mismatch_candidate() -> dict:
    """Fails the deterministic-solve gate; later gates short-circuit (absent)."""
    return {
        "passed": False,
        "reason": "solve_mismatch",
        "self_consistency_pass": False,
        "checks": {
            "structural": True,
            "trap_metadata": {"ok": True},
            "no_length_tell": True,
            "lexical_leak_ok": {"ok": True},
            "deterministic_solve": {"ok": False, "solved": "A", "credited": "B"},
            "self_consistency_confidence": 0.0,
        },
    }


def _rc_authenticity_candidate() -> dict:
    """Reaches the back of the pipeline but fails RC-authenticity (too short)."""
    checks = _passing_checks()
    checks["rc_authenticity"] = {"ok": False, "flags": ["too_short", "repetitive"]}
    return {
        "passed": False,
        "reason": "rc_authenticity:too_short",
        "self_consistency_pass": True,
        "checks": checks,
    }


def _seed_jobs(session) -> None:
    """Two jobs across two q_types with a mix of pass/fail candidates."""
    job_a = GenJob(
        status=GenStatus.done,
        q_type="Strengthen",
        count=3,
        validation_report={
            "candidates": [
                _passing_candidate(),
                _passing_candidate(),
                _solve_mismatch_candidate(),
                {"error": "model unreachable"},  # must be ignored everywhere
            ]
        },
    )
    job_b = GenJob(
        status=GenStatus.done,
        q_type="MainPoint",
        count=2,
        validation_report={
            "candidates": [
                _passing_candidate(),
                _rc_authenticity_candidate(),
            ]
        },
    )
    session.add(job_a)
    session.add(job_b)
    session.commit()
    session.refresh(job_a)
    session.refresh(job_b)

    # GenCandidate rows back the audit feed (one per non-error candidate).
    rows = [
        GenCandidate(gen_job_id=job_a.id, candidate_index=0, question_id=101,
                     verdict="accepted", verdict_reason=None,
                     solver_model="qwen", critic_model="llama"),
        GenCandidate(gen_job_id=job_a.id, candidate_index=1, question_id=102,
                     verdict="accepted", verdict_reason=None),
        GenCandidate(gen_job_id=job_a.id, candidate_index=2, question_id=103,
                     verdict="quarantined", verdict_reason="solve_mismatch"),
        GenCandidate(gen_job_id=job_b.id, candidate_index=0, question_id=201,
                     verdict="accepted", verdict_reason=None),
        GenCandidate(gen_job_id=job_b.id, candidate_index=1, question_id=202,
                     verdict="quarantined", verdict_reason="near_duplicate"),
    ]
    for r in rows:
        session.add(r)
    session.commit()


# --- quality_metrics (pure) -------------------------------------------------
def test_quality_metrics_overall_counts(db_session):
    _seed_jobs(db_session)
    m = generation.quality_metrics(db_session)
    assert m["jobs"] == 2
    # 5 non-error candidates (the {"error": ...} row is skipped).
    assert m["total_candidates"] == 5
    assert m["passed"] == 3
    assert m["quarantined"] == 2
    assert m["pass_rate"] == round(3 / 5, 4)
    # First-failure histogram aggregates both failing candidates.
    assert m["fail_reasons"]["solve_mismatch"] == 1
    assert m["fail_reasons"]["rc_authenticity:too_short"] == 1


def test_quality_metrics_per_gate_breakdown(db_session):
    _seed_jobs(db_session)
    m = generation.quality_metrics(db_session)
    gates = {g["gate"]: g for g in m["gates"]}

    # deterministic_solve ran on every candidate that reached it: the 4 passers
    # + the solve-mismatch failer = 5 judged, 4 passed, 1 failed.
    ds = gates["deterministic_solve"]
    assert ds["judged"] == 5
    assert ds["passed"] == 4
    assert ds["failed"] == 1
    assert ds["pass_rate"] == round(4 / 5, 4)
    assert ds["fail_reasons"] == {"solve_mismatch": 1}

    # rc_authenticity is near the back: the solve-mismatch candidate
    # short-circuited before it, so only the 4 deep-reaching candidates are
    # judged; one of them failed with the flagged reason.
    rc = gates["rc_authenticity"]
    assert rc["judged"] == 4
    assert rc["passed"] == 3
    assert rc["failed"] == 1
    assert rc["fail_reasons"] == {"rc_authenticity:too_short": 1}

    # Gate set is exactly the INT-1 pipeline gate labels, in order.
    expected = [label for _key, label in generation._GENERATION_QUALITY_GATES]
    assert [g["gate"] for g in m["gates"]] == expected


def test_quality_metrics_by_type_rollup(db_session):
    _seed_jobs(db_session)
    m = generation.quality_metrics(db_session)
    by_type = {row["q_type"]: row for row in m["by_type"]}
    assert set(by_type) == {"Strengthen", "MainPoint"}

    strengthen = by_type["Strengthen"]
    assert strengthen["passed"] == 2
    assert strengthen["failed"] == 1
    assert strengthen["pass_rate"] == round(2 / 3, 4)

    main_point = by_type["MainPoint"]
    assert main_point["passed"] == 1
    assert main_point["failed"] == 1
    # Per-type per-gate breakdown is present and mirrors the global gate set.
    mp_gates = {g["gate"]: g for g in main_point["gates"]}
    assert mp_gates["rc_authenticity"]["failed"] == 1


def test_quality_metrics_empty_db(db_session):
    # No jobs seeded — every aggregate is zero/None and never raises.
    m = generation.quality_metrics(db_session)
    assert m["jobs"] == 0
    assert m["total_candidates"] == 0
    assert m["pass_rate"] is None
    assert all(g["judged"] == 0 and g["pass_rate"] is None for g in m["gates"])
    assert m["by_type"] == []


# --- audit_log (pure) -------------------------------------------------------
def test_audit_log_classifies_events(db_session):
    _seed_jobs(db_session)
    log = generation.audit_log(db_session, limit=50)
    kinds = [e["kind"] for e in log["events"]]
    # 3 accepted -> generate, 1 solve_mismatch -> validate, 1 near_duplicate -> firewall.
    assert kinds.count("generate") == 3
    assert kinds.count("validate") == 1
    assert kinds.count("firewall") == 1
    assert log["counts"] == {"generate": 3, "validate": 1, "firewall": 1}

    # Newest first (highest GenCandidate id leads).
    ids = [e["id"] for e in log["events"]]
    assert ids == sorted(ids, reverse=True)

    # Provenance fields are carried through on the first accepted row.
    accepted = next(e for e in log["events"] if e["question_id"] == 101)
    assert accepted["kind"] == "generate"
    assert accepted["q_type"] == "Strengthen"
    assert accepted["solver_model"] == "qwen"
    assert accepted["critic_model"] == "llama"
    assert accepted["created_at"] is not None


def test_audit_log_kind_filter_keeps_full_counts(db_session):
    _seed_jobs(db_session)
    log = generation.audit_log(db_session, limit=50, kind="firewall")
    assert all(e["kind"] == "firewall" for e in log["events"])
    assert len(log["events"]) == 1
    assert log["events"][0]["reason"] == "near_duplicate"
    # counts reflect the scanned window, not just the filtered slice.
    assert log["counts"]["generate"] == 3
    assert log["kind"] == "firewall"


def test_audit_log_limit(db_session):
    _seed_jobs(db_session)
    log = generation.audit_log(db_session, limit=2)
    assert len(log["events"]) == 2
    assert log["limit"] == 2


# --- HTTP surface -----------------------------------------------------------
def test_quality_metrics_endpoint(client):
    res = client.get("/api/gen/generation/quality-metrics")
    assert res.status_code == 200
    body = res.json()
    # Typed response_model shape (BC2-style): the keys are always present.
    assert set(body) >= {
        "jobs", "total_candidates", "passed", "quarantined", "pass_rate",
        "fail_reasons", "gates", "by_type",
    }
    assert isinstance(body["gates"], list)
    # Even on a freshly-seeded DB with no gen jobs the gate scaffold is present.
    labels = {g["gate"] for g in body["gates"]}
    assert "deterministic_solve" in labels
    assert "rc_authenticity" in labels


def test_audit_log_endpoint(client):
    res = client.get("/api/gen/generation/audit-log?limit=10")
    assert res.status_code == 200
    body = res.json()
    assert set(body) >= {"events", "limit", "counts", "kind"}
    assert body["limit"] == 10
    assert isinstance(body["events"], list)


def test_audit_log_endpoint_rejects_bad_kind(client):
    # ?kind= is constrained to the three known event classes.
    res = client.get("/api/gen/generation/audit-log?kind=bogus")
    assert res.status_code == 422


def test_routes_published_in_openapi(client):
    schema = client.get("/openapi.json").json()
    assert "/api/gen/generation/quality-metrics" in schema["paths"]
    assert "/api/gen/generation/audit-log" in schema["paths"]
