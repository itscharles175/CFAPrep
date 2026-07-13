"""AI-10 — strict offline provider fence.

StudyVault is local-only by default ("works on a plane"): no cloud, no telemetry.
The optional cloud provider (``GEN_PROVIDER=cloud``) stays in the tree for
opt-out/standalone use, but in the normal app build ``config.ENFORCE_OFFLINE`` is
ON so any attempt to SELECT or INSTANTIATE the cloud provider raises a clear
``RuntimeError`` naming the offending env var — making the api.anthropic.com
egress path unreachable. Even after opting out of that fence, cloud egress still
requires ``LSATLAB_CLOUD_EGRESS_ALLOWED=1``.

These tests flip ``config.ENFORCE_OFFLINE`` explicitly (the suite defaults it OFF
so the existing cloud HTTP-shape/budget tests can exercise the faked cloud path).
No live model server or network is touched.
"""
from __future__ import annotations

import pytest

from app import config


def _strict_local_profile(monkeypatch):
    monkeypatch.setattr(config, "ENFORCE_OFFLINE", True)
    monkeypatch.setattr(config, "GEN_PROVIDER", "ollama")
    monkeypatch.setattr(config, "CLOUD_API_KEY", "")
    monkeypatch.setattr(config, "CLOUD_EGRESS_ALLOWED", False)
    monkeypatch.setattr(config, "OLLAMA_URL", "http://127.0.0.1:11434")
    monkeypatch.setattr(config, "LMSTUDIO_URL", "http://127.0.0.1:1234/v1")


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


def test_strict_offline_rejects_cloud_key_material(monkeypatch):
    _strict_local_profile(monkeypatch)
    monkeypatch.setattr(config, "CLOUD_API_KEY", "sk-test")

    with pytest.raises(config.OfflineFenceError) as ei:
        config.validate_offline_provider_fence()

    msg = str(ei.value)
    assert "LSATLAB_CLOUD_API_KEY" in msg
    assert "ANTHROPIC_API_KEY" in msg


def test_strict_offline_rejects_cloud_egress_flag(monkeypatch):
    _strict_local_profile(monkeypatch)
    monkeypatch.setattr(config, "CLOUD_EGRESS_ALLOWED", True)

    with pytest.raises(config.OfflineFenceError) as ei:
        config.validate_offline_provider_fence()

    assert "LSATLAB_CLOUD_EGRESS_ALLOWED" in str(ei.value)


def test_strict_offline_rejects_remote_ollama_url(monkeypatch):
    _strict_local_profile(monkeypatch)
    monkeypatch.setattr(config, "OLLAMA_URL", "http://192.168.1.5:11434")

    with pytest.raises(config.OfflineFenceError) as ei:
        config.validate_offline_provider_fence()

    assert "LSATLAB_OLLAMA_URL" in str(ei.value)


def test_strict_offline_rejects_remote_lmstudio_url(monkeypatch):
    _strict_local_profile(monkeypatch)
    monkeypatch.setattr(config, "LMSTUDIO_URL", "http://192.168.1.5:1234/v1")

    with pytest.raises(config.OfflineFenceError) as ei:
        config.validate_offline_provider_fence()

    assert "LSATLAB_LMSTUDIO_URL" in str(ei.value)


def test_loopback_local_model_urls_pass(monkeypatch):
    _strict_local_profile(monkeypatch)

    assert config.validate_local_model_url(
        "http://localhost:11434/", name="LSATLAB_OLLAMA_URL"
    ) == "http://localhost:11434"
    assert config.validate_local_model_url(
        "http://127.0.0.1:11434", name="LSATLAB_OLLAMA_URL"
    ) == "http://127.0.0.1:11434"
    assert config.validate_local_model_url(
        "http://[::1]:11434", name="LSATLAB_OLLAMA_URL"
    ) == "http://[::1]:11434"


def test_remote_local_model_url_requires_two_optouts(monkeypatch):
    _strict_local_profile(monkeypatch)
    monkeypatch.setenv("LSATLAB_ALLOW_REMOTE_LLM", "1")

    with pytest.raises(config.OfflineFenceError):
        config.validate_local_model_url(
            "http://192.168.1.5:11434", name="LSATLAB_OLLAMA_URL"
        )

    monkeypatch.setattr(config, "ENFORCE_OFFLINE", False)
    assert config.validate_local_model_url(
        "http://192.168.1.5:11434/", name="LSATLAB_OLLAMA_URL"
    ) == "http://192.168.1.5:11434"


def test_provider_constructors_reject_remote_urls_under_fence(monkeypatch):
    from app.llm.lmstudio import LMStudioProvider
    from app.llm.ollama import OllamaProvider

    _strict_local_profile(monkeypatch)

    with pytest.raises(config.OfflineFenceError):
        OllamaProvider("http://192.168.1.5:11434")
    with pytest.raises(config.OfflineFenceError):
        LMStudioProvider("http://192.168.1.5:1234/v1")


def test_settings_route_rejects_cloud_provider_under_strict_fence(client, monkeypatch):
    _strict_local_profile(monkeypatch)

    response = client.put("/api/settings", json={"gen_provider": "cloud"})

    assert response.status_code == 422
    assert "gen_provider=cloud" in response.json()["detail"]
    assert config.GEN_PROVIDER == "ollama"


def test_settings_route_rejects_remote_lmstudio_with_strict_fence(
    client, monkeypatch
):
    _strict_local_profile(monkeypatch)
    monkeypatch.setenv("LSATLAB_ALLOW_REMOTE_LLM", "1")

    response = client.put(
        "/api/settings", json={"lmstudio_url": "http://192.168.1.5:1234/v1"}
    )

    assert response.status_code == 422
    assert "loopback" in response.text
    assert config.LMSTUDIO_URL == "http://127.0.0.1:1234/v1"


def test_saved_cloud_provider_rejected_under_strict_fence(db_session, monkeypatch):
    from app import settings_store
    from app.models import Setting

    _strict_local_profile(monkeypatch)
    db_session.add(Setting(key="gen_provider", value="cloud"))
    db_session.commit()

    with pytest.raises(settings_store.SettingsValidationError):
        settings_store.apply_saved_settings(db_session)

    assert config.GEN_PROVIDER == "ollama"


def test_saved_remote_lmstudio_url_rejected_under_strict_fence(
    db_session, monkeypatch
):
    from app import settings_store
    from app.models import Setting

    _strict_local_profile(monkeypatch)
    db_session.add(Setting(key="lmstudio_url", value="http://192.168.1.5:1234/v1"))
    db_session.commit()

    with pytest.raises(settings_store.SettingsValidationError) as ei:
        settings_store.apply_saved_settings(db_session)

    assert "LSATLAB_LMSTUDIO_URL" in str(ei.value)
    assert config.LMSTUDIO_URL == "http://127.0.0.1:1234/v1"


# --- enforcement OFF: back-compat opt-out still works -----------------------
def test_optout_allows_cloud_selection(monkeypatch):
    """Fence opt-out plus explicit egress opt-in permits the cloud path."""
    import app.llm as llm

    monkeypatch.setattr(config, "ENFORCE_OFFLINE", False)
    monkeypatch.setattr(config, "GEN_PROVIDER", "cloud")
    monkeypatch.setattr(config, "CLOUD_API_KEY", "sk-test")
    monkeypatch.setattr(config, "CLOUD_EGRESS_ALLOWED", True)
    llm.assert_cloud_allowed()  # must not raise


def test_optout_still_requires_explicit_egress(monkeypatch):
    """Fence opt-out alone is not enough to admit outbound model traffic."""
    import app.llm as llm

    monkeypatch.setattr(config, "ENFORCE_OFFLINE", False)
    monkeypatch.setattr(config, "GEN_PROVIDER", "cloud")
    monkeypatch.setattr(config, "CLOUD_API_KEY", "sk-test")
    monkeypatch.setattr(config, "CLOUD_EGRESS_ALLOWED", False)

    with pytest.raises(RuntimeError) as ei:
        llm.assert_cloud_allowed()
    assert "LSATLAB_CLOUD_EGRESS_ALLOWED" in str(ei.value)


def test_optout_allows_anthropic_construction(monkeypatch):
    """Fence opt-out plus explicit egress opt-in allows provider construction."""
    from app.llm import cloud

    monkeypatch.setattr(config, "ENFORCE_OFFLINE", False)
    monkeypatch.setattr(config, "CLOUD_EGRESS_ALLOWED", True)
    prov = cloud.AnthropicProvider("sk-test", model="claude-3-5-sonnet-20241022")
    assert prov.api_key == "sk-test"
    assert prov.model == "claude-3-5-sonnet-20241022"


def test_optout_offline_generate_routes_to_cloud(monkeypatch):
    """With both opt-ins, offline_generate routes to the faked cloud provider."""
    import app.llm as llm
    from app.llm import cloud

    monkeypatch.setattr(config, "ENFORCE_OFFLINE", False)
    monkeypatch.setattr(config, "GEN_PROVIDER", "cloud")
    monkeypatch.setattr(config, "CLOUD_API_KEY", "sk-test")
    monkeypatch.setattr(config, "CLOUD_EGRESS_ALLOWED", True)
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
