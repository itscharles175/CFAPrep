"""LLM provider layer: transient classification, retry, routing, cloud shape."""
from __future__ import annotations

import logging

import httpx
import pytest

from app import config
from app.llm import base


def test_is_transient_classification():
    assert base.is_transient(httpx.ConnectError("refused")) is True
    assert base.is_transient(httpx.ConnectTimeout("slow connect")) is True
    # read timeout = slow model, not retried
    assert base.is_transient(httpx.ReadTimeout("slow gen")) is False
    assert base.is_transient(ValueError("bad json")) is False

    req = httpx.Request("GET", "http://x")
    r500 = httpx.Response(503, request=req)
    r400 = httpx.Response(400, request=req)
    assert base.is_transient(httpx.HTTPStatusError("x", request=req, response=r500)) is True
    assert base.is_transient(httpx.HTTPStatusError("x", request=req, response=r400)) is False


def test_retry_sync_recovers(monkeypatch):
    monkeypatch.setattr(base.time, "sleep", lambda *_: None)
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise httpx.ConnectError("refused")
        return "ok"

    out = base.retry_sync(flaky, policy=base.RetryPolicy(attempts=3, base_s=0))
    assert out == "ok"
    assert calls["n"] == 3


def test_retry_sync_gives_up_as_llmerror(monkeypatch):
    monkeypatch.setattr(base.time, "sleep", lambda *_: None)

    def always_fail():
        raise httpx.ConnectError("refused")

    with pytest.raises(base.LLMError):
        base.retry_sync(always_fail, policy=base.RetryPolicy(attempts=3, base_s=0))


def test_retry_sync_no_retry_on_non_transient():
    calls = {"n": 0}

    def boom():
        calls["n"] += 1
        raise ValueError("logic bug")

    with pytest.raises(base.LLMError):
        base.retry_sync(boom, policy=base.RetryPolicy(attempts=5, base_s=0))
    assert calls["n"] == 1  # not retried


def test_offline_generate_routes_to_ollama_by_default(monkeypatch):
    import app.llm as llm

    monkeypatch.setattr(config, "GEN_PROVIDER", "ollama")
    monkeypatch.setattr(llm.ollama(), "generate",
                        lambda model, prompt, system, timeout: f"local::{prompt}")
    assert llm.cloud_enabled() is False
    assert llm.offline_provider_name() == "ollama"
    assert llm.offline_generate("hello") == "local::hello"


def test_offline_generate_routes_to_cloud_when_configured(monkeypatch):
    import app.llm as llm
    from app.llm import cloud

    # AI-10: opt out of the strict-offline fence so this exercises the cloud path.
    monkeypatch.setattr(config, "ENFORCE_OFFLINE", False)
    monkeypatch.setattr(config, "GEN_PROVIDER", "cloud")
    monkeypatch.setattr(config, "CLOUD_API_KEY", "sk-test")
    monkeypatch.setattr(config, "CLOUD_EGRESS_ALLOWED", True)
    monkeypatch.setattr(cloud.AnthropicProvider, "generate",
                        lambda self, model, prompt, system, timeout: f"cloud::{prompt}")
    assert llm.cloud_enabled() is True
    assert llm.offline_provider_name() == "anthropic"
    assert llm.offline_generate("hello") == "cloud::hello"


def test_cloud_configured_without_explicit_egress_falls_back_without_prompt_log(
    monkeypatch, caplog
):
    import app.llm as llm
    from app.llm import cloud

    sentinel = "SECRET_PROMPT_SHOULD_NOT_APPEAR_IN_LOGS"
    monkeypatch.setattr(config, "ENFORCE_OFFLINE", False)
    monkeypatch.setattr(config, "GEN_PROVIDER", "cloud")
    monkeypatch.setattr(config, "CLOUD_API_KEY", "sk-test")
    monkeypatch.setattr(config, "CLOUD_EGRESS_ALLOWED", False)
    monkeypatch.setattr(config, "LLM_CACHE_ENABLED", False, raising=False)

    def _boom(*a, **k):
        raise AssertionError("cloud must not be called without explicit egress opt-in")

    monkeypatch.setattr(cloud.AnthropicProvider, "generate", _boom)
    monkeypatch.setattr(llm.ollama(), "generate",
                        lambda model, prompt, system, timeout, **kw: f"local::{prompt}")

    caplog.set_level(logging.INFO, logger="lsatlab.llm")
    assert llm.cloud_configured() is True
    assert llm.cloud_egress_allowed() is False
    assert llm.cloud_enabled() is False
    assert llm.offline_generate(sentinel, task="unit_cloud_denied") == f"local::{sentinel}"

    logs = caplog.text
    assert "cloud_egress" in logs
    assert "allowed=False" in logs
    assert "egress_not_explicitly_allowed" in logs
    assert "prompt_logged=false" in logs
    assert sentinel not in logs


def test_cloud_egress_allow_log_excludes_prompt(monkeypatch, caplog):
    import app.llm as llm
    from app.llm import cloud

    sentinel = "SECRET_ALLOWED_PROMPT_SHOULD_NOT_APPEAR_IN_LOGS"
    monkeypatch.setattr(config, "ENFORCE_OFFLINE", False)
    monkeypatch.setattr(config, "GEN_PROVIDER", "cloud")
    monkeypatch.setattr(config, "CLOUD_API_KEY", "sk-test")
    monkeypatch.setattr(config, "CLOUD_EGRESS_ALLOWED", True)
    monkeypatch.setattr(config, "CLOUD_MONTHLY_BUDGET_USD", 0.0)
    monkeypatch.setattr(config, "LLM_CACHE_ENABLED", False, raising=False)
    monkeypatch.setattr(cloud.AnthropicProvider, "generate",
                        lambda self, model, prompt, system, timeout, **kw: "cloud-ok")

    caplog.set_level(logging.INFO, logger="lsatlab.llm")
    assert llm.offline_generate(sentinel, task="unit_cloud_allowed") == "cloud-ok"

    logs = caplog.text
    assert "cloud_egress" in logs
    assert "allowed=True" in logs
    assert "explicit_opt_in" in logs
    assert "prompt_logged=false" in logs
    assert sentinel not in logs


def test_cloud_provider_builds_cached_messages_request(monkeypatch):
    from app.llm import cloud

    # AI-10: opt out of the strict-offline fence so the provider can construct.
    monkeypatch.setattr(config, "ENFORCE_OFFLINE", False)
    monkeypatch.setattr(config, "CLOUD_EGRESS_ALLOWED", True)
    captured = {}

    class _Resp:
        def raise_for_status(self): pass
        def json(self):
            return {"content": [{"type": "text", "text": "GENERATED"}]}

    class _FakeClient:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def post(self, url, headers=None, json=None):
            captured["url"] = url
            captured["headers"] = headers
            captured["json"] = json
            return _Resp()

    monkeypatch.setattr(cloud.httpx, "Client", _FakeClient)

    prov = cloud.AnthropicProvider("sk-test", model="claude-opus-4-7")
    out = prov.generate(None, "make a question", system="You are strict.")
    assert out == "GENERATED"
    assert captured["headers"]["x-api-key"] == "sk-test"
    assert captured["headers"]["anthropic-version"] == "2023-06-01"
    body = captured["json"]
    assert body["model"] == "claude-opus-4-7"
    assert body["messages"] == [{"role": "user", "content": "make a question"}]
    # system carries a prompt-cache hint
    assert body["system"][0]["cache_control"] == {"type": "ephemeral"}


def test_cloud_facade_omits_unsupported_seed_but_keeps_supported_top_p(monkeypatch):
    import app.llm as llm
    from app.llm import cloud

    monkeypatch.setattr(config, "ENFORCE_OFFLINE", False)
    monkeypatch.setattr(config, "GEN_PROVIDER", "cloud")
    monkeypatch.setattr(config, "CLOUD_API_KEY", "sk-test")
    monkeypatch.setattr(config, "CLOUD_EGRESS_ALLOWED", True)
    monkeypatch.setattr(config, "CLOUD_MONTHLY_BUDGET_USD", 0.0)
    monkeypatch.setattr(config, "LLM_CACHE_ENABLED", False, raising=False)
    captured = {}

    def fake_generate(self, model, prompt, system, timeout, **kw):
        captured.update(kw)
        return "cloud-ok"

    monkeypatch.setattr(cloud.AnthropicProvider, "generate", fake_generate)
    assert llm.offline_generate("p", temperature=0.8, top_p=0.9, seed=7) == "cloud-ok"
    assert captured == {"temperature": 0.8, "top_p": 0.9}


def test_cloud_seed_alone_does_not_make_warm_call_cacheable(monkeypatch, db_session):
    import app.llm as llm
    from app.llm import cloud

    monkeypatch.setattr(config, "ENFORCE_OFFLINE", False)
    monkeypatch.setattr(config, "GEN_PROVIDER", "cloud")
    monkeypatch.setattr(config, "CLOUD_API_KEY", "sk-test")
    monkeypatch.setattr(config, "CLOUD_EGRESS_ALLOWED", True)
    monkeypatch.setattr(config, "CLOUD_MONTHLY_BUDGET_USD", 0.0)
    monkeypatch.setattr(config, "LLM_CACHE_ENABLED", True, raising=False)
    calls = {"n": 0}

    def fake_generate(self, model, prompt, system, timeout, **kw):
        calls["n"] += 1
        return f"cloud-{calls['n']}"

    monkeypatch.setattr(cloud.AnthropicProvider, "generate", fake_generate)
    a = llm.offline_generate("p", temperature=0.8, seed=7)
    b = llm.offline_generate("p", temperature=0.8, seed=7)
    assert (a, b) == ("cloud-1", "cloud-2")
    assert calls["n"] == 2


def test_facade_omits_unsupported_format_from_provider_and_cache(monkeypatch, db_session):
    import app.llm as llm

    monkeypatch.setattr(config, "GEN_PROVIDER", "ollama")
    monkeypatch.setattr(config, "LLM_CACHE_ENABLED", True, raising=False)
    calls = {"n": 0}
    seen: list[dict] = []

    def fake_generate(model, prompt, system, timeout, **kw):
        calls["n"] += 1
        seen.append(kw)
        return f"local-{calls['n']}"

    monkeypatch.setattr(llm.ollama(), "generate", fake_generate)
    a = llm.offline_generate("p", temperature=0, seed=7, format="yaml")
    b = llm.offline_generate("p", temperature=0, seed=7, format=None)
    assert (a, b) == ("local-1", "local-1")
    assert seen == [{"temperature": 0, "seed": 7}]


def test_provider_info_shape(monkeypatch):
    import app.llm as llm

    monkeypatch.setattr(config, "GEN_PROVIDER", "cloud")
    monkeypatch.setattr(config, "CLOUD_API_KEY", "sk-test")
    monkeypatch.setattr(config, "CLOUD_EGRESS_ALLOWED", False)
    info = llm.provider_info()
    assert info["realtime_provider"] == "ollama"
    assert "explain_model" in info and "embed_model" in info
    assert info["cloud_configured"] is True
    assert info["cloud_egress_allowed"] is False
    assert info["cloud_enabled"] is False
    caps = info["capabilities"]
    assert caps["realtime"]["provider"] == "ollama"
    assert caps["offline"]["provider"] == "ollama"
    assert caps["matrix"]["anthropic"]["sampling"]["seed"] is False
    assert caps["matrix"]["ollama"]["structured_output"]["json_schema"] is True
