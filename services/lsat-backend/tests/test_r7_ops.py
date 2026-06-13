"""R7 Wave 4b — runtime ops, budget enforcement, MCP read-write, batch writes.

Covers the four items end to end with injected fakes (no real Ollama/cloud):
  5.2 — batch + idempotent attempt writes,
  7.3 — persisted metrics (MetricSample/UsageLedger) + ENFORCED cloud budget,
  7.5 — provenance-safe read-write MCP tools,
  worker hook — the idle hook runs audit.calibrate_difficulty (called directly).
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlmodel import Session, select

from app import config
from app.db import engine
from app.models import (
    Attempt,
    AttemptChoiceEvent,
    AttemptMode,
    MetricSample,
    Question,
    QuestionSource,
    StudySession,
    UsageLedger,
)


# --- helpers ----------------------------------------------------------------
def _new_session(client) -> int:
    return client.post("/api/sessions", json={"type": "section", "config": {}}).json()["id"]


def _make_question(db_session: Session, *, source: QuestionSource,
                   q_type: str = "Inference", correct: str = "A") -> Question:
    q = Question(stem="s", prompt="p", correct_answer=correct, q_type=q_type,
                 source=source)
    db_session.add(q)
    db_session.commit()
    db_session.refresh(q)
    return q


# ============================================================================
# 5.2 — batch, idempotent attempt writes
# ============================================================================
def test_single_attempt_response_shape_preserved(client):
    """The single create endpoint still returns just {"attempt_id": ...}."""
    sid = _new_session(client)
    r = client.post(f"/api/sessions/{sid}/attempts", json={
        "question_id": 1, "mode": "timed", "chosen_answer": "A", "time_ms": 1000})
    assert r.status_code == 200
    body = r.json()
    assert list(body.keys()) == ["attempt_id"]
    assert isinstance(body["attempt_id"], int)


def test_single_attempt_idempotent_on_client_id(client):
    """Replaying the single POST with the same client_attempt_id returns the
    same attempt id and creates no duplicate row."""
    sid = _new_session(client)
    payload = {"question_id": 1, "mode": "timed", "chosen_answer": "A",
               "time_ms": 1000, "client_attempt_id": "cae-single-1"}
    a1 = client.post(f"/api/sessions/{sid}/attempts", json=payload).json()["attempt_id"]
    a2 = client.post(f"/api/sessions/{sid}/attempts", json=payload).json()["attempt_id"]
    assert a1 == a2
    with Session(engine) as s:
        rows = s.exec(
            select(Attempt).where(Attempt.client_attempt_id == "cae-single-1")
        ).all()
        assert len(rows) == 1


def test_batch_insert_creates_all(client):
    sid = _new_session(client)
    body = {"attempts": [
        {"question_id": 1, "mode": "timed", "chosen_answer": "A", "time_ms": 1000,
         "client_attempt_id": "b1"},
        {"question_id": 2, "mode": "timed", "chosen_answer": "B", "time_ms": 1200,
         "client_attempt_id": "b2"},
        {"question_id": 3, "mode": "timed", "chosen_answer": "C", "time_ms": 900,
         "client_attempt_id": "b3"},
    ]}
    r = client.post(f"/api/sessions/{sid}/attempts/batch", json=body)
    assert r.status_code == 200
    out = r.json()
    assert out["total"] == 3
    assert out["created"] == 3
    assert out["duplicates"] == 0
    assert all(item["created"] is True for item in out["results"])
    assert all(isinstance(item["attempt_id"], int) for item in out["results"])


def test_batch_replay_creates_zero_duplicates(client):
    """Replaying the EXACT same batch (offline retry) inserts 0 new rows."""
    sid = _new_session(client)
    body = {"attempts": [
        {"question_id": 1, "client_attempt_id": "r1", "chosen_answer": "A"},
        {"question_id": 2, "client_attempt_id": "r2", "chosen_answer": "B"},
    ]}
    first = client.post(f"/api/sessions/{sid}/attempts/batch", json=body).json()
    assert first["created"] == 2

    second = client.post(f"/api/sessions/{sid}/attempts/batch", json=body).json()
    assert second["created"] == 0
    assert second["duplicates"] == 2
    # same attempt ids returned both times
    ids1 = sorted(i["attempt_id"] for i in first["results"])
    ids2 = sorted(i["attempt_id"] for i in second["results"])
    assert ids1 == ids2

    with Session(engine) as s:
        total = s.exec(select(Attempt).where(Attempt.session_id == sid)).all()
        assert len(total) == 2


def test_batch_mixed_new_and_existing(client):
    sid = _new_session(client)
    client.post(f"/api/sessions/{sid}/attempts/batch", json={"attempts": [
        {"question_id": 1, "client_attempt_id": "m1", "chosen_answer": "A"},
    ]})
    mixed = client.post(f"/api/sessions/{sid}/attempts/batch", json={"attempts": [
        {"question_id": 1, "client_attempt_id": "m1", "chosen_answer": "A"},   # existing
        {"question_id": 2, "client_attempt_id": "m2", "chosen_answer": "B"},   # new
    ]}).json()
    assert mixed["created"] == 1
    assert mixed["duplicates"] == 1
    by_qid = {r["question_id"]: r for r in mixed["results"]}
    assert by_qid[1]["created"] is False
    assert by_qid[2]["created"] is True


def test_batch_persists_choice_events(client):
    sid = _new_session(client)
    body = {"attempts": [{
        "question_id": 1, "chosen_answer": "A", "client_attempt_id": "ce1",
        "choice_events": [
            {"label": "B", "action": "eliminate", "order_index": 0, "time_ms": 500},
            {"label": "A", "action": "select", "order_index": 1, "time_ms": 1500},
        ],
    }]}
    out = client.post(f"/api/sessions/{sid}/attempts/batch", json=body).json()
    aid = out["results"][0]["attempt_id"]
    with Session(engine) as s:
        events = s.exec(
            select(AttemptChoiceEvent).where(AttemptChoiceEvent.attempt_id == aid)
        ).all()
        assert len(events) == 2
        assert {e.action for e in events} == {"eliminate", "select"}


def test_batch_without_client_id_always_inserts(client):
    """No idempotency token => every item inserts (no dedup signal)."""
    sid = _new_session(client)
    body = {"attempts": [
        {"question_id": 1, "chosen_answer": "A"},
        {"question_id": 1, "chosen_answer": "A"},
    ]}
    out = client.post(f"/api/sessions/{sid}/attempts/batch", json=body).json()
    assert out["created"] == 2


def test_batch_unknown_question_reported_not_fatal(client):
    sid = _new_session(client)
    out = client.post(f"/api/sessions/{sid}/attempts/batch", json={"attempts": [
        {"question_id": 999999, "chosen_answer": "A", "client_attempt_id": "x1"},
        {"question_id": 1, "chosen_answer": "A", "client_attempt_id": "x2"},
    ]}).json()
    by_qid = {r["question_id"]: r for r in out["results"]}
    assert by_qid[999999]["attempt_id"] is None
    assert by_qid[999999].get("error") == "question_not_found"
    assert by_qid[1]["created"] is True
    assert out["created"] == 1


# ============================================================================
# 7.3 — persisted metrics + enforced cloud budget
# ============================================================================
def test_cloud_cost_uses_configurable_rates(monkeypatch):
    from app import observability

    monkeypatch.setattr(config, "CLOUD_INPUT_COST_PER_MTOK", 10.0)
    monkeypatch.setattr(config, "CLOUD_OUTPUT_COST_PER_MTOK", 30.0)
    # 1,000,000 input @ $10/M + 1,000,000 output @ $30/M = $40
    assert observability.cloud_cost_usd(1_000_000, 1_000_000) == 40.0
    assert observability.cloud_cost_usd(0, 0) == 0.0


def test_persist_cloud_usage_writes_priced_ledger_row(db_session, monkeypatch):
    from app import observability

    monkeypatch.setattr(config, "CLOUD_INPUT_COST_PER_MTOK", 15.0)
    monkeypatch.setattr(config, "CLOUD_OUTPUT_COST_PER_MTOK", 75.0)
    cost = observability.persist_cloud_usage("anthropic", "claude-x", 2000, 1000)
    # 2000*15/1e6 + 1000*75/1e6 = 0.03 + 0.075 = 0.105
    assert cost == pytest.approx(0.105)
    with Session(engine) as s:
        rows = s.exec(select(UsageLedger)).all()
        assert len(rows) == 1
        assert rows[0].model == "claude-x"
        assert rows[0].input_tokens == 2000
        assert rows[0].cost_usd == pytest.approx(0.105)


def test_month_to_date_spend_sums_current_month_only(db_session):
    from app import observability

    now = datetime.now(timezone.utc)
    # two rows this month
    db_session.add(UsageLedger(model="m", cost_usd=0.10, created_at=now))
    db_session.add(UsageLedger(model="m", cost_usd=0.25, created_at=now))
    # one row clearly LAST month (first day of this month minus a day)
    last_month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    # step back one second -> previous month
    from datetime import timedelta
    prev = last_month - timedelta(seconds=1)
    db_session.add(UsageLedger(model="m", cost_usd=99.0, created_at=prev))
    db_session.commit()

    spend = observability.month_to_date_spend_usd()
    assert spend == pytest.approx(0.35)


def test_persisted_latency_p50_reads_metric_samples(db_session):
    from app import observability

    for v in (100.0, 200.0, 300.0):
        db_session.add(MetricSample(kind="llm_latency_ms", model="qwen3:8b",
                                    value=v, meta_json={"task": "explain_stream"}))
    # a sample for a DIFFERENT task must not bleed in
    db_session.add(MetricSample(kind="llm_latency_ms", model="qwen3:14b",
                                value=9999.0, meta_json={"task": "gate_critic"}))
    db_session.commit()
    assert observability.persisted_latency_p50("explain_stream") == 200.0
    assert observability.persisted_latency_p50("never_seen") is None


def test_time_llm_call_persists_a_latency_sample(db_session):
    """Every model call goes through time_llm_call, which now ALSO writes a
    durable MetricSample (in addition to the RAM ring)."""
    from app import observability

    with observability.time_llm_call("explain_stream", provider="ollama",
                                     model="qwen3:8b"):
        pass
    with Session(engine) as s:
        rows = s.exec(
            select(MetricSample).where(MetricSample.kind == "llm_latency_ms")
        ).all()
        assert any((r.meta_json or {}).get("task") == "explain_stream" for r in rows)


def test_offline_generate_cloud_accrues_to_ledger(db_session, monkeypatch):
    """Routing to the cloud (faked) records tokens AND a priced ledger row."""
    import app.llm as llm
    from app.llm import cloud

    monkeypatch.setattr(config, "GEN_PROVIDER", "cloud")
    monkeypatch.setattr(config, "CLOUD_API_KEY", "sk-test")
    monkeypatch.setattr(config, "CLOUD_MONTHLY_BUDGET_USD", 0.0)  # unlimited

    # Fake the HTTP layer so the REAL provider.generate runs (incl. its usage
    # accounting) but no network is hit.
    class _Resp:
        def raise_for_status(self): pass
        def json(self):
            return {"content": [{"type": "text", "text": "GEN"}],
                    "usage": {"input_tokens": 1000, "output_tokens": 500}}

    class _FakeClient:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def post(self, *a, **k): return _Resp()

    monkeypatch.setattr(cloud.httpx, "Client", _FakeClient)

    out = llm.offline_generate("make a question")
    assert out == "GEN"
    with Session(engine) as s:
        rows = s.exec(select(UsageLedger)).all()
        assert len(rows) == 1
        assert rows[0].input_tokens == 1000
        assert rows[0].output_tokens == 500
        assert rows[0].cost_usd > 0


def test_over_budget_cloud_call_falls_back_to_local(db_session, monkeypatch):
    """A cloud call is REFUSED once month-to-date spend reaches the budget; it
    falls back to local Ollama instead of overspending."""
    import app.llm as llm
    from app.llm import cloud

    monkeypatch.setattr(config, "GEN_PROVIDER", "cloud")
    monkeypatch.setattr(config, "CLOUD_API_KEY", "sk-test")
    monkeypatch.setattr(config, "CLOUD_MONTHLY_BUDGET_USD", 1.00)

    # Pre-load ledger spend at/over the budget for this month.
    db_session.add(UsageLedger(model="m", cost_usd=1.50,
                               created_at=datetime.now(timezone.utc)))
    db_session.commit()

    # If the cloud path were taken this would blow up the test (network); make it
    # explode so a regression is caught loudly.
    def _boom(*a, **k):
        raise AssertionError("cloud must NOT be called when over budget")
    monkeypatch.setattr(cloud.AnthropicProvider, "generate", _boom)

    # Local fallback target.
    monkeypatch.setattr(llm.ollama(), "generate",
                        lambda model, prompt, system, timeout, **kw: f"local::{prompt}")

    assert llm.cloud_budget_status()["within_budget"] is False
    out = llm.offline_generate("hello")
    assert out == "local::hello"


def test_local_path_never_budget_limited(db_session, monkeypatch):
    """With GEN_PROVIDER=ollama, a huge over-budget ledger does not block calls."""
    import app.llm as llm

    monkeypatch.setattr(config, "GEN_PROVIDER", "ollama")
    monkeypatch.setattr(config, "CLOUD_MONTHLY_BUDGET_USD", 0.01)
    db_session.add(UsageLedger(model="m", cost_usd=999.0,
                               created_at=datetime.now(timezone.utc)))
    db_session.commit()

    monkeypatch.setattr(llm.ollama(), "generate",
                        lambda model, prompt, system, timeout, **kw: "free-local")
    assert llm.cloud_enabled() is False
    assert llm.offline_generate("x") == "free-local"


def test_under_budget_cloud_call_proceeds(db_session, monkeypatch):
    import app.llm as llm
    from app.llm import cloud

    monkeypatch.setattr(config, "GEN_PROVIDER", "cloud")
    monkeypatch.setattr(config, "CLOUD_API_KEY", "sk-test")
    monkeypatch.setattr(config, "CLOUD_MONTHLY_BUDGET_USD", 100.0)
    db_session.add(UsageLedger(model="m", cost_usd=1.0,
                               created_at=datetime.now(timezone.utc)))
    db_session.commit()
    monkeypatch.setattr(cloud.AnthropicProvider, "generate",
                        lambda self, model, prompt, system, timeout, **kw: f"cloud::{prompt}")
    assert llm.cloud_budget_status()["within_budget"] is True
    assert llm.offline_generate("go") == "cloud::go"


def test_observability_status_preserves_existing_keys_and_adds_new(client):
    r = client.get("/api/observability/status")
    assert r.status_code == 200
    body = r.json()
    # Existing keys the frontend hand-types — must all still be present.
    for key in ("gen_queued", "gen_running", "worker_alive",
                "last_coach_refresh_ms", "explain_p50_ms", "embed_coverage_pct",
                "models", "cloud_tokens", "cloud_monthly_budget_usd"):
        assert key in body, f"missing preserved key {key}"
    assert set(body["cloud_tokens"]) == {"input_tokens", "output_tokens", "total_tokens"}
    # New additive keys.
    for key in ("cloud_spend_mtd_usd", "cloud_budget_within",
                "cloud_budget_remaining_usd", "explain_p50_ms_persisted"):
        assert key in body, f"missing additive key {key}"


def test_observability_metrics_endpoint(client, db_session):
    db_session.add(MetricSample(kind="llm_latency_ms", model="qwen3:8b",
                                value=123.0, meta_json={"task": "explain_stream"}))
    db_session.add(UsageLedger(model="claude-x", input_tokens=10, output_tokens=5,
                               cost_usd=0.001, created_at=datetime.now(timezone.utc)))
    db_session.commit()
    r = client.get("/api/observability/metrics?task=explain_stream")
    assert r.status_code == 200
    body = r.json()
    assert body["latency_p50_ms"] == 123.0
    assert body["cloud"]["budget_usd"] is None  # default 0 => unlimited
    assert "input_cost_per_mtok_usd" in body["cloud"]
    assert len(body["cloud"]["recent_calls"]) == 1


# ============================================================================
# 7.5 — provenance-safe read-write MCP tools
# ============================================================================
def test_mcp_registry_has_new_tools_and_keeps_read_only_seven(db_session):
    from app import mcp_server

    # original read-only seven still present
    for name in ("get_dashboard", "get_accuracy_by_type", "get_mastery",
                 "get_score_forecast", "get_blind_review_gap", "get_bank_stats",
                 "get_coach"):
        assert name in mcp_server.TOOLS
    # new read-write four registered
    for name in ("enqueue_generation", "tag_review_question",
                 "soft_delete_duplicate", "set_study_target"):
        assert name in mcp_server.TOOLS


def test_mcp_soft_delete_refuses_official(db_session):
    """PROVENANCE GUARD: official questions cannot be soft-deleted via MCP."""
    from app import mcp_server

    q = _make_question(db_session, source=QuestionSource.official)
    res = mcp_server.tool_soft_delete_duplicate(q.id)
    assert res["ok"] is False
    assert res["reason"] == "provenance_protected"
    with Session(engine) as s:
        assert s.get(Question, q.id).deleted_at is None  # untouched


def test_mcp_soft_delete_refuses_sample(db_session):
    from app import mcp_server

    q = _make_question(db_session, source=QuestionSource.sample)
    res = mcp_server.tool_soft_delete_duplicate(q.id)
    assert res["ok"] is False
    assert res["reason"] == "provenance_protected"


def test_mcp_soft_delete_allows_ai_generated(db_session):
    from app import mcp_server

    q = _make_question(db_session, source=QuestionSource.ai_generated)
    res = mcp_server.tool_soft_delete_duplicate(q.id)
    assert res["ok"] is True
    with Session(engine) as s:
        assert s.get(Question, q.id).deleted_at is not None


def test_mcp_soft_delete_allows_research(db_session):
    from app import mcp_server

    q = _make_question(db_session, source=QuestionSource.research)
    res = mcp_server.tool_soft_delete_duplicate(q.id)
    assert res["ok"] is True


def test_mcp_tag_review_mutates_and_audits(db_session):
    from app import mcp_server
    from app.models import AuditLog

    q = _make_question(db_session, source=QuestionSource.research,
                       q_type="Inference")
    res = mcp_server.tool_tag_review_question(q.id, q_type="Flaw", difficulty=4)
    assert res["ok"] is True
    assert set(res["changed"]) == {"q_type", "difficulty"}
    assert res["q_type"] == "Flaw"
    assert res["difficulty"] == 4
    # never leaks question text
    assert "stem" not in res and "prompt" not in res
    with Session(engine) as s:
        refreshed = s.get(Question, q.id)
        assert refreshed.q_type == "Flaw"
        assert refreshed.difficulty == 4
        assert refreshed.updated_at is not None
        audits = s.exec(
            select(AuditLog).where(AuditLog.entity_id == q.id)
        ).all()
        fields = {a.field for a in audits}
        assert {"q_type", "difficulty"} <= fields


def test_mcp_enqueue_generation_refuses_without_anchor(db_session):
    from app import mcp_server

    # "Evaluate" is a valid LR type with no seed bank anchor.
    res = mcp_server.tool_enqueue_generation("Evaluate", count=3)
    assert res["enqueued"] is False
    assert "anchor" in res["reason"]


def test_mcp_enqueue_generation_queues_with_anchor(db_session):
    from app import mcp_server
    from app.models import GenJob, GenStatus

    # research anchor exists for this type.
    _make_question(db_session, source=QuestionSource.research, q_type="Method")
    res = mcp_server.tool_enqueue_generation("Method", count=4)
    assert res["enqueued"] is True
    assert res["status"] == GenStatus.queued.value
    assert res["anchors"] >= 1
    with Session(engine) as s:
        job = s.get(GenJob, res["job_id"])
        assert job is not None
        assert job.status == GenStatus.queued
        assert job.q_type == "Method"


def test_mcp_set_study_target_and_note(db_session):
    from app import mcp_server
    from app.models import Setting, StudyPlan

    res = mcp_server.tool_set_study_target(170, exam_date="2026-09-12",
                                           daily_minutes=90, note="focus on RC")
    assert res["ok"] is True
    assert res["target_score"] == 170
    assert res["exam_date"] == "2026-09-12"
    assert res["daily_minutes"] == 90
    assert res["note"] == "focus on RC"
    with Session(engine) as s:
        plan = s.exec(
            select(StudyPlan).where(StudyPlan.active == True)  # noqa: E712
        ).first()
        assert plan.target_score == 170
        note = s.get(Setting, "study_plan_note")
        assert note is not None and note.value == "focus on RC"


def test_mcp_read_only_tools_still_work(client):
    """Smoke test the read-only tools against a seeded DB (no mutation)."""
    from app import mcp_server

    dash = mcp_server.tool_dashboard()
    assert isinstance(dash, dict)
    stats = mcp_server.tool_bank_stats()
    assert "total" in stats and "by_source" in stats


# ============================================================================
# Worker hook — idle hook runs audit.calibrate_difficulty (called directly)
# ============================================================================
def test_idle_hook_calls_calibration(db_session, monkeypatch):
    """The worker idle hook recomputes empirical difficulty (on throttle). We
    call the hook function directly rather than starting the worker thread."""
    from app import main

    calls = {"n": 0}

    def _fake_calibrate(session, **kw):
        calls["n"] += 1
        return {"calibrated": 0}

    monkeypatch.setattr(main.audit, "calibrate_difficulty", _fake_calibrate)
    # Don't actually run coach refresh / backups in this unit test.
    monkeypatch.setattr(main.coach, "maybe_refresh", lambda *a, **k: False)
    monkeypatch.setattr(main.backup, "maybe_backup", lambda *a, **k: False)

    hook = main.make_idle_hook(engine, calibration_interval_s=3600.0)
    hook()
    assert calls["n"] == 1
    # Throttled: an immediate second tick does NOT recalibrate.
    hook()
    assert calls["n"] == 1


def test_idle_hook_recalibrates_after_interval(db_session, monkeypatch):
    from app import main

    calls = {"n": 0}
    monkeypatch.setattr(main.audit, "calibrate_difficulty",
                        lambda session, **kw: calls.__setitem__("n", calls["n"] + 1))
    monkeypatch.setattr(main.coach, "maybe_refresh", lambda *a, **k: False)
    monkeypatch.setattr(main.backup, "maybe_backup", lambda *a, **k: False)

    # Zero interval => every tick recalibrates.
    hook = main.make_idle_hook(engine, calibration_interval_s=0.0)
    hook()
    hook()
    assert calls["n"] == 2


def test_idle_hook_coach_refresh_thread_target_is_guarded(db_session, monkeypatch):
    from app import main

    def _boom(*_args, **_kwargs):
        raise RuntimeError("coach refresh should be logged, not escaped")

    monkeypatch.setattr(main.coach, "maybe_refresh", _boom)
    main._run_coach_refresh_safely(engine)


def test_idle_hook_actually_calibrates_on_real_data(client, db_session):
    """End-to-end: with enough attempts on a question, the idle hook sets its
    empirical_difficulty via the real audit.calibrate_difficulty."""
    from app import main

    q = _make_question(db_session, source=QuestionSource.research, correct="A")
    s = StudySession(type="drill")
    db_session.add(s)
    db_session.commit()
    db_session.refresh(s)
    # 5 wrong attempts -> accuracy 0 -> empirical difficulty 5.0
    for _ in range(config.CALIBRATION_MIN_ATTEMPTS):
        db_session.add(Attempt(question_id=q.id, session_id=s.id,
                               mode=AttemptMode.drill, chosen_answer="B",
                               is_correct=False))
    db_session.commit()

    hook = main.make_idle_hook(engine, calibration_interval_s=0.0)
    hook()
    with Session(engine) as s2:
        refreshed = s2.get(Question, q.id)
        assert refreshed.empirical_difficulty == 5.0
