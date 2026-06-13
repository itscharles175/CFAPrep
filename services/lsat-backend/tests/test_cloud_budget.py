"""B2 — cloud monthly budget must not overshoot.

The old enforcement admitted a cloud call whenever ``spend < budget``, so a
single large call could push month-to-date spend PAST the configured
``CLOUD_MONTHLY_BUDGET_USD``. The fix prices the WORST-CASE cost of the pending
call (estimated input tokens + the full ``CLOUD_MAX_TOKENS`` output) and refuses
it unless ``spend + worst_case <= budget``, falling back to the free local model
exactly like the existing over-budget fallback.

Faked HTTP/provider throughout — no live model server. Mirrors the cloud-budget
patterns in tests/test_r7_ops.py.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlmodel import Session, select

from app import config
from app.db import engine
from app.models import UsageLedger


def test_estimate_cloud_cost_matches_ledger_pricing(monkeypatch):
    """The pre-call estimate reuses the SAME pricing as the actual ledger cost."""
    from app import observability

    monkeypatch.setattr(config, "CLOUD_INPUT_COST_PER_MTOK", 15.0)
    monkeypatch.setattr(config, "CLOUD_OUTPUT_COST_PER_MTOK", 75.0)
    # estimate_cloud_cost_usd must equal cloud_cost_usd for the same tokens.
    assert observability.estimate_cloud_cost_usd(1000, 2000) == \
        observability.cloud_cost_usd(1000, 2000)
    # And the math is the documented per-MTok formula.
    assert observability.estimate_cloud_cost_usd(1000, 2000) == pytest.approx(
        (1000 * 15.0 + 2000 * 75.0) / 1_000_000.0
    )


def test_estimate_input_tokens_ceils(monkeypatch):
    """~4 chars/token, rounded UP so the worst-case never under-counts."""
    import app.llm as llm

    assert llm._estimate_input_tokens("", None) == 0
    assert llm._estimate_input_tokens("a", None) == 1          # 1 char -> ceil(0.25)
    assert llm._estimate_input_tokens("abcd", None) == 1        # exactly 1 token
    assert llm._estimate_input_tokens("abcde", None) == 2       # 5 chars -> ceil(1.25)
    # system text is counted toward the input estimate too.
    assert llm._estimate_input_tokens("abcd", "efgh") == 2


def test_worst_case_estimate_blocks_overshoot_even_when_spend_under_budget(
    db_session, monkeypatch
):
    """The core B2 regression: spend is STILL strictly under the budget, but the
    pending call's worst-case cost would push it over the cap — so it must be
    refused and fall back to local. The old ``spend < budget`` check admitted it.
    """
    import app.llm as llm
    from app.llm import cloud

    monkeypatch.setattr(config, "GEN_PROVIDER", "cloud")
    monkeypatch.setattr(config, "CLOUD_API_KEY", "sk-test")
    monkeypatch.setattr(config, "CLOUD_INPUT_COST_PER_MTOK", 15.0)
    monkeypatch.setattr(config, "CLOUD_OUTPUT_COST_PER_MTOK", 75.0)
    monkeypatch.setattr(config, "CLOUD_MAX_TOKENS", 2048)
    # Budget 0.20; worst-case output alone = 2048 * 75 / 1e6 = 0.15360 USD.
    monkeypatch.setattr(config, "CLOUD_MONTHLY_BUDGET_USD", 0.20)

    # Pre-load spend at 0.10: strictly UNDER 0.20 (old check would admit), but
    # 0.10 + ~0.1536 worst-case = ~0.2536 > 0.20 (new check refuses).
    db_session.add(UsageLedger(model="m", cost_usd=0.10,
                               created_at=datetime.now(timezone.utc)))
    db_session.commit()

    # Sanity: the display gauge still reports we're under (spend < budget); the
    # per-call worst-case guard is what blocks the overshoot.
    assert llm.cloud_budget_status()["within_budget"] is True

    # Cloud must NOT be called; make a regression explode loudly.
    def _boom(*a, **k):
        raise AssertionError("cloud must NOT be called when worst-case overshoots")
    monkeypatch.setattr(cloud.AnthropicProvider, "generate", _boom)
    monkeypatch.setattr(llm.ollama(), "generate",
                        lambda model, prompt, system, timeout, **kw: f"local::{prompt}")

    out = llm.offline_generate("write a hard inference question please")
    assert out == "local::write a hard inference question please"

    # No new ledger row was written (the cloud call never ran).
    with Session(engine) as s:
        rows = s.exec(select(UsageLedger)).all()
        assert len(rows) == 1  # only the pre-loaded spend row


def test_comfortably_under_budget_call_is_admitted(db_session, monkeypatch):
    """A call whose worst-case still fits under the cap proceeds to cloud."""
    import app.llm as llm
    from app.llm import cloud

    monkeypatch.setattr(config, "GEN_PROVIDER", "cloud")
    monkeypatch.setattr(config, "CLOUD_API_KEY", "sk-test")
    monkeypatch.setattr(config, "CLOUD_INPUT_COST_PER_MTOK", 15.0)
    monkeypatch.setattr(config, "CLOUD_OUTPUT_COST_PER_MTOK", 75.0)
    monkeypatch.setattr(config, "CLOUD_MAX_TOKENS", 2048)
    # Budget 100.0 with 1.0 already spent: worst-case ~0.1536 leaves ample room.
    monkeypatch.setattr(config, "CLOUD_MONTHLY_BUDGET_USD", 100.0)
    db_session.add(UsageLedger(model="m", cost_usd=1.0,
                               created_at=datetime.now(timezone.utc)))
    db_session.commit()

    monkeypatch.setattr(cloud.AnthropicProvider, "generate",
                        lambda self, model, prompt, system, timeout, **kw: f"cloud::{prompt}")
    assert llm.cloud_budget_status()["within_budget"] is True
    assert llm.offline_generate("go") == "cloud::go"


def test_within_budget_estimate_at_exact_cap_is_admitted(db_session, monkeypatch):
    """The boundary is inclusive: spend + worst_case == budget is allowed."""
    import app.llm as llm
    from app import observability

    monkeypatch.setattr(config, "CLOUD_INPUT_COST_PER_MTOK", 15.0)
    monkeypatch.setattr(config, "CLOUD_OUTPUT_COST_PER_MTOK", 75.0)
    monkeypatch.setattr(config, "CLOUD_MAX_TOKENS", 2048)
    worst = observability.estimate_cloud_cost_usd(1, config.CLOUD_MAX_TOKENS)

    # spend + worst == budget exactly -> admitted (<=).
    monkeypatch.setattr(config, "CLOUD_MONTHLY_BUDGET_USD", round(0.05 + worst, 6))
    db_session.add(UsageLedger(model="m", cost_usd=0.05,
                               created_at=datetime.now(timezone.utc)))
    db_session.commit()
    assert llm._cloud_within_budget(worst) is True

    # One cent tighter and the same call is refused.
    monkeypatch.setattr(config, "CLOUD_MONTHLY_BUDGET_USD", round(0.05 + worst - 0.01, 6))
    assert llm._cloud_within_budget(worst) is False


def test_no_budget_set_admits_regardless_of_estimate(db_session, monkeypatch):
    """Budget 0 (default) means unlimited; the worst-case estimate is ignored."""
    import app.llm as llm

    monkeypatch.setattr(config, "CLOUD_MONTHLY_BUDGET_USD", 0.0)
    db_session.add(UsageLedger(model="m", cost_usd=999.0,
                               created_at=datetime.now(timezone.utc)))
    db_session.commit()
    assert llm._cloud_within_budget(123456.0) is True


def test_budget_guard_fails_closed_on_spend_read_error(monkeypatch):
    """A spend-read failure under a configured budget still refuses (fail-closed),
    even with a tiny worst-case estimate — a metrics glitch must not open the cap.
    """
    import app.llm as llm
    from app import observability

    monkeypatch.setattr(config, "CLOUD_MONTHLY_BUDGET_USD", 100.0)

    def _explode(*a, **k):
        raise RuntimeError("metrics store unavailable")
    monkeypatch.setattr(observability, "month_to_date_spend_usd", _explode)

    assert llm._cloud_within_budget(0.0001) is False
