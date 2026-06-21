"""AI-10 — strict offline provider fence.

StudyVault is local-only by default ("works on a plane"): no cloud, no telemetry.
The optional cloud provider (``GEN_PROVIDER=cloud``) stays in the tree for
opt-out/standalone use, but in the normal app build ``config.ENFORCE_OFFLINE`` is
ON so any attempt to SELECT or INSTANTIATE the cloud provider raises a clear
``RuntimeError`` naming the offending env var — making the api.anthropic.com
egress path unreachable.

These tests flip ``config.ENFORCE_OFFLINE`` explicitly (the suite defaults it OFF
so the existing cloud HTTP-shape/budget tests can exercise the faked cloud path).
No live model server or network is touched.
"""
from __future__ import annotations

import pytest

from app import config


# --- enforcement ON: the cloud path is unreachable --------------------------
def test_default_app_build_enforces_offline(monkeypatch):
    """Outside pytest the fence defaults ON. Drop both pytest signals (the env
    marker and the ``pytest`` module entry) to exercise the real packaged-build
    branch of the default helper without an explicit env override."""
    import sys

    monkeypatch.delenv("LSATLAB_ENFORCE_OFFLINE", raising=False)
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.delitem(sys.modules, "pytest", raising=False)
    assert config._default_enforce_offline() is True


def test_explicit_env_override_wins_both_ways(monkeypatch):
    """An explicit LSATLAB_ENFORCE_OFFLINE always beats the pytest auto-detect."""
    monkeypatch.setenv("LSATLAB_ENFORCE_OFFLINE", "0")
    assert config._default_enforce_offline() is False
    monkeypatch.setenv("LSATLAB_ENFORCE_OFFLINE", "1")
    assert config._default_enforce_offline() is True


def test_offline_fence_blocks_cloud_selection(monkeypatch):
    """assert_cloud_allowed raises a clear, env-var-naming error when the fence is
    ON and the cloud provider is configured."""
    import app.llm as llm

    monkeypatch.setattr(config, "ENFORCE_OFFLINE", True)
    monkeypatch.setattr(config, "GEN_PROVIDER", "cloud")
    monkeypatch.setattr(config, "CLOUD_API_KEY", "sk-test")

    with pytest.raises(RuntimeError) as ei:
        llm.assert_cloud_allowed()
    msg = str(ei.value)
    assert "LSATLAB_GEN_PROVIDER" in msg          # names the offending env var
    assert "LSATLAB_ENFORCE_OFFLINE" in msg       # tells the user how to opt out


def test_offline_fence_blocks_offline_generate_routing(monkeypatch):
    """The fence fires at the SELECTION point in offline_generate, so a cloud
    config never reaches AnthropicProvider / api.anthropic.com."""
    import app.llm as llm
    from app.llm import cloud

    monkeypatch.setattr(config, "ENFORCE_OFFLINE", True)
    monkeypatch.setattr(config, "GEN_PROVIDER", "cloud")
    monkeypatch.setattr(config, "CLOUD_API_KEY", "sk-test")

    # If the cloud constructor were ever reached, fail loudly rather than silently.
    def _boom(*a, **k):
        raise AssertionError("cloud provider must NOT be constructed under the fence")
    monkeypatch.setattr(cloud.AnthropicProvider, "__init__", _boom)

    with pytest.raises(RuntimeError):
        llm.offline_generate("write a hard inference question")


def test_offline_fence_blocks_anthropic_constructor(monkeypatch):
    """Defense-in-depth: even a DIRECT construction is refused under the fence."""
    from app.llm import cloud

    monkeypatch.setattr(config, "ENFORCE_OFFLINE", True)
    with pytest.raises(RuntimeError) as ei:
        cloud.AnthropicProvider("sk-test")
    assert "LSATLAB_ENFORCE_OFFLINE" in str(ei.value)


def test_offline_fence_no_op_when_provider_is_local(monkeypatch):
    """Enforcement ON but a LOCAL provider is fine — assert_cloud_allowed no-ops."""
    import app.llm as llm

    monkeypatch.setattr(config, "ENFORCE_OFFLINE", True)
    monkeypatch.setattr(config, "GEN_PROVIDER", "ollama")
    llm.assert_cloud_allowed()  # must not raise


# --- enforcement OFF: back-compat opt-out still works -----------------------
def test_optout_allows_cloud_selection(monkeypatch):
    """With the fence OFF (opt-out), assert_cloud_allowed permits the cloud path."""
    import app.llm as llm

    monkeypatch.setattr(config, "ENFORCE_OFFLINE", False)
    monkeypatch.setattr(config, "GEN_PROVIDER", "cloud")
    monkeypatch.setattr(config, "CLOUD_API_KEY", "sk-test")
    llm.assert_cloud_allowed()  # must not raise


def test_optout_allows_anthropic_construction(monkeypatch):
    """With the fence OFF the cloud provider constructs as before (back-compat)."""
    from app.llm import cloud

    monkeypatch.setattr(config, "ENFORCE_OFFLINE", False)
    prov = cloud.AnthropicProvider("sk-test", model="claude-3-5-sonnet-20241022")
    assert prov.api_key == "sk-test"
    assert prov.model == "claude-3-5-sonnet-20241022"


def test_optout_offline_generate_routes_to_cloud(monkeypatch):
    """With the fence OFF, offline_generate still routes to the (faked) cloud
    provider exactly as it did before AI-10 — the cloud code stays usable."""
    import app.llm as llm
    from app.llm import cloud

    monkeypatch.setattr(config, "ENFORCE_OFFLINE", False)
    monkeypatch.setattr(config, "GEN_PROVIDER", "cloud")
    monkeypatch.setattr(config, "CLOUD_API_KEY", "sk-test")
    monkeypatch.setattr(config, "CLOUD_MONTHLY_BUDGET_USD", 0.0)  # unlimited
    monkeypatch.setattr(
        cloud.AnthropicProvider, "generate",
        lambda self, model, prompt, system, timeout, **kw: f"cloud::{prompt}",
    )
    assert llm.cloud_enabled() is True
    assert llm.offline_generate("hello") == "cloud::hello"


# --- config version pin ------------------------------------------------------
def test_app_version_is_canonical():
    """config.APP_VERSION is pinned to the canonical 0.9.0 (matches package.json)."""
    assert config.APP_VERSION == "0.9.0"
