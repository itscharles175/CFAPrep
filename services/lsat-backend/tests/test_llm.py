"""LLM provider layer: transient classification, retry, routing, cloud shape."""
from __future__ import annotations

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
    monkeypatch.setattr(cloud.AnthropicProvider, "generate",
                        lambda self, model, prompt, system, timeout: f"cloud::{prompt}")
    assert llm.cloud_enabled() is True
    assert llm.offline_provider_name() == "anthropic"
    assert llm.offline_generate("hello") == "cloud::hello"


def test_cloud_provider_builds_cached_messages_request(monkeypatch):
    from app.llm import cloud

    # AI-10: opt out of the strict-offline fence so the provider can construct.
    monkeypatch.setattr(config, "ENFORCE_OFFLINE", False)
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


def test_provider_info_shape():
    import app.llm as llm

    info = llm.provider_info()
    assert info["realtime_provider"] == "ollama"
    assert "explain_model" in info and "embed_model" in info
