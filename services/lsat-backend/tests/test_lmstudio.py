"""LMStudio local provider (OpenAI-compatible) + LOCAL_PROVIDER routing.

All HTTP is faked, so these never need a live LMStudio server (mirrors how
test_llm.py fakes the cloud provider's httpx client).
"""
from __future__ import annotations

import asyncio
import sys

import httpx
import pytest

import app.llm.lmstudio  # noqa: F401 — register the submodule in sys.modules
from app import config
from app.llm.base import LLMError

# The facade defines a `lmstudio()` function that shadows the `lmstudio`
# submodule attribute on the package (the same pattern it uses for `ollama()`),
# so `from app.llm import lmstudio` / `import app.llm.lmstudio as x` both yield
# the function. Reach the real module — to fake its httpx — via sys.modules.
_LMS = sys.modules["app.llm.lmstudio"]


# --- provider selection -----------------------------------------------------
def test_local_provider_selection(monkeypatch):
    import app.llm as llm

    monkeypatch.setattr(config, "LOCAL_PROVIDER", "ollama")
    assert llm.local_provider().name == "ollama"

    monkeypatch.setattr(config, "LOCAL_PROVIDER", "lmstudio")
    assert llm.local_provider().name == "lmstudio"


def test_lmstudio_singleton_rebuilds_on_url_change(monkeypatch):
    import app.llm as llm

    monkeypatch.setattr(config, "LMSTUDIO_URL", "http://localhost:1234/v1")
    a = llm.lmstudio()
    assert a.base_url == "http://localhost:1234/v1"
    monkeypatch.setattr(config, "LMSTUDIO_URL", "http://localhost:5678/v1")
    b = llm.lmstudio()
    assert b.base_url == "http://localhost:5678/v1"
    assert a is not b  # rebuilt to pick up the live URL change


# --- generate (sync) maps onto /chat/completions ----------------------------
def test_lmstudio_generate_maps_to_chat_completions(monkeypatch):
    lms = _LMS

    captured: dict = {}

    class _Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"choices": [{"message": {"content": "GENERATED"}}]}

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None):
            captured["url"] = url
            captured["json"] = json
            return _Resp()

    monkeypatch.setattr(lms.httpx, "Client", _FakeClient)

    prov = lms.LMStudioProvider("http://localhost:1234/v1")
    out = prov.generate("local-model", "make a question",
                        system="You are strict.", temperature=0, seed=7,
                        format="json")
    assert out == "GENERATED"
    assert captured["url"].endswith("/chat/completions")
    body = captured["json"]
    assert body["model"] == "local-model"
    assert body["messages"] == [
        {"role": "system", "content": "You are strict."},
        {"role": "user", "content": "make a question"},
    ]
    assert body["stream"] is False
    assert body["temperature"] == 0
    assert body["seed"] == 7
    # format="json" -> OpenAI json_object response_format.
    assert body["response_format"] == {"type": "json_object"}


def test_lmstudio_generate_maps_schema_response_format(monkeypatch):
    lms = _LMS

    captured: dict = {}

    class _Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"choices": [{"message": {"content": "{}"}}]}

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None):
            captured["json"] = json
            return _Resp()

    monkeypatch.setattr(lms.httpx, "Client", _FakeClient)

    schema = {"type": "object", "properties": {"answer": {"type": "string"}}}
    prov = lms.LMStudioProvider("http://localhost:1234/v1")
    prov.generate("m", "p", format=schema)
    rf = captured["json"]["response_format"]
    assert rf["type"] == "json_schema"
    assert rf["json_schema"]["schema"] == schema


# --- embeddings -------------------------------------------------------------
def test_lmstudio_embed_maps_to_openai(monkeypatch):
    lms = _LMS

    captured: dict = {}

    class _Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"data": [{"embedding": [0.1, 0.2, 0.3]}]}

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None):
            captured["url"] = url
            captured["json"] = json
            return _Resp()

    monkeypatch.setattr(lms.httpx, "Client", _FakeClient)

    prov = lms.LMStudioProvider("http://localhost:1234/v1")
    vec = prov.embed_sync("hello", model="nomic-embed-text")
    assert vec == [0.1, 0.2, 0.3]
    assert captured["url"].endswith("/embeddings")
    assert captured["json"] == {"model": "nomic-embed-text", "input": "hello"}


# --- list_models (async) ----------------------------------------------------
def test_lmstudio_list_models(monkeypatch):
    lms = _LMS

    class _Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"data": [{"id": "model-a"}, {"id": "model-b"}]}

    class _FakeAsyncClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            return _Resp()

    monkeypatch.setattr(lms.httpx, "AsyncClient", _FakeAsyncClient)

    prov = lms.LMStudioProvider("http://localhost:1234/v1")
    models = asyncio.run(prov.list_models())
    assert models == ["model-a", "model-b"]


# --- chat_stream (async SSE) ------------------------------------------------
def test_lmstudio_chat_stream_parses_sse(monkeypatch):
    lms = _LMS

    lines = [
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        "",  # SSE blank separator line — must be skipped
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        "data: [DONE]",
    ]

    class _Resp:
        def raise_for_status(self):
            pass

        async def aiter_lines(self):
            for ln in lines:
                yield ln

    class _StreamCtx:
        async def __aenter__(self):
            return _Resp()

        async def __aexit__(self, *a):
            return False

    class _FakeAsyncClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def stream(self, method, url, json=None):
            return _StreamCtx()

    monkeypatch.setattr(lms.httpx, "AsyncClient", _FakeAsyncClient)

    prov = lms.LMStudioProvider("http://localhost:1234/v1")

    async def _collect():
        return [d async for d in prov.chat_stream(
            "m", [{"role": "user", "content": "hi"}], 5.0)]

    assert asyncio.run(_collect()) == ["Hel", "lo"]


# --- facade routing ---------------------------------------------------------
def test_offline_generate_routes_to_lmstudio_local(monkeypatch):
    import app.llm as llm

    monkeypatch.setattr(config, "LOCAL_PROVIDER", "lmstudio")
    monkeypatch.setattr(config, "GEN_PROVIDER", "ollama")  # local, not cloud
    monkeypatch.setattr(llm.lmstudio(), "generate",
                        lambda model, prompt, system, timeout: f"lms::{prompt}")
    assert llm.cloud_enabled() is False
    assert llm.offline_provider_name() == "lmstudio"
    assert llm.offline_generate("hello") == "lms::hello"


def test_cloud_still_wins_over_lmstudio_for_offline(monkeypatch):
    import app.llm as llm
    from app.llm import cloud

    # LMStudio is the local provider, but GEN_PROVIDER=cloud + a key must still
    # route OFFLINE generation to Anthropic (cloud is orthogonal to LOCAL).
    monkeypatch.setattr(config, "LOCAL_PROVIDER", "lmstudio")
    monkeypatch.setattr(config, "GEN_PROVIDER", "cloud")
    monkeypatch.setattr(config, "CLOUD_API_KEY", "sk-test")
    monkeypatch.setattr(cloud.AnthropicProvider, "generate",
                        lambda self, model, prompt, system, timeout: f"cloud::{prompt}")
    assert llm.offline_provider_name() == "anthropic"
    assert llm.offline_generate("hello") == "cloud::hello"


def test_provider_info_reports_lmstudio(monkeypatch):
    import app.llm as llm

    monkeypatch.setattr(config, "LOCAL_PROVIDER", "lmstudio")
    info = llm.provider_info()
    assert info["realtime_provider"] == "lmstudio"
    assert info["local_provider"] == "lmstudio"
    assert info["lmstudio_url"]  # surfaced for the settings UI


def test_resolve_explain_model_skips_probe_for_lmstudio(monkeypatch):
    from app import ai

    ai.reset_resolved_models()
    monkeypatch.setattr(config, "LOCAL_PROVIDER", "lmstudio")
    monkeypatch.setattr(config, "EXPLAIN_MODEL", "my-lmstudio-model")
    # Must NOT probe Ollama's tag list; returns the configured id as-is.
    assert ai.resolve_explain_model() == "my-lmstudio-model"
    ai.reset_resolved_models()  # let other tests re-resolve


# --- HTTP round-trip via the settings route --------------------------------
def test_settings_put_switches_local_provider(client):
    """PUT /api/settings switches the local provider live and reports it back
    via provider_info. Restores ollama in `finally` so later tests are
    unaffected (settings apply to the process-wide config module)."""
    try:
        r = client.put("/api/settings", json={
            "local_provider": "lmstudio",
            "lmstudio_url": "http://localhost:4321/v1",
        })
        assert r.status_code == 200
        body = r.json()
        assert body["settings"]["local_provider"] == "lmstudio"
        assert body["settings"]["lmstudio_url"] == "http://localhost:4321/v1"
        assert body["provider"]["realtime_provider"] == "lmstudio"
        assert body["provider"]["local_provider"] == "lmstudio"
        # An unknown provider is rejected by the Literal validator.
        assert client.put(
            "/api/settings", json={"local_provider": "vllm"}
        ).status_code == 422
    finally:
        client.put("/api/settings", json={
            "local_provider": "ollama",
            "lmstudio_url": "http://localhost:1234/v1",
        })


# --- failure modes: the resilient transport normalises into LLMError --------
def test_lmstudio_generate_raises_llmerror_on_500(monkeypatch):
    """A non-retryable terminal error surfaces as LLMError (not a raw httpx error)."""
    lms = _LMS
    monkeypatch.setattr(config, "LLM_MAX_RETRIES", 0)  # 1 attempt, no backoff sleep

    class _Resp:
        def raise_for_status(self):
            raise httpx.HTTPStatusError(
                "server error",
                request=httpx.Request("POST", "http://x"),
                response=httpx.Response(500),
            )

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None):
            return _Resp()

    monkeypatch.setattr(lms.httpx, "Client", _FakeClient)
    prov = lms.LMStudioProvider("http://localhost:1234/v1")
    with pytest.raises(LLMError):
        prov.generate("m", "p")


def test_lmstudio_generate_retries_transient_then_succeeds(monkeypatch):
    """A transient connect blip is retried; the second attempt's result is returned."""
    import app.llm.base as base
    lms = _LMS
    monkeypatch.setattr(config, "LLM_MAX_RETRIES", 2)
    monkeypatch.setattr(base.time, "sleep", lambda *_: None)  # no real backoff wait
    calls = {"n": 0}

    class _Ok:
        def raise_for_status(self):
            pass

        def json(self):
            return {"choices": [{"message": {"content": "RECOVERED"}}]}

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None):
            calls["n"] += 1
            if calls["n"] == 1:
                raise httpx.ConnectError("connection refused")  # transient
            return _Ok()

    monkeypatch.setattr(lms.httpx, "Client", _FakeClient)
    prov = lms.LMStudioProvider("http://localhost:1234/v1")
    assert prov.generate("m", "p") == "RECOVERED"
    assert calls["n"] == 2


def test_lmstudio_chat_non_streaming_round_trip(monkeypatch):
    lms = _LMS
    captured: dict = {}

    class _Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"choices": [{"message": {"content": "HELLO"}}]}

    class _FakeAsyncClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None):
            captured["url"] = url
            captured["json"] = json
            return _Resp()

    monkeypatch.setattr(lms.httpx, "AsyncClient", _FakeAsyncClient)
    prov = lms.LMStudioProvider("http://localhost:1234/v1")
    out = asyncio.run(prov.chat("m", [{"role": "user", "content": "hi"}], 5.0))
    assert out == "HELLO"
    assert captured["url"].endswith("/chat/completions")
    assert captured["json"]["stream"] is False


def test_lmstudio_chat_stream_reraises_after_first_token(monkeypatch):
    """A mid-stream break AFTER a token was emitted can't be resumed: it must
    re-raise as LLMError rather than silently truncate or retry."""
    lms = _LMS

    class _Resp:
        def raise_for_status(self):
            pass

        async def aiter_lines(self):
            yield 'data: {"choices":[{"delta":{"content":"Hel"}}]}'
            raise httpx.RemoteProtocolError("peer closed mid-stream")

    class _StreamCtx:
        async def __aenter__(self):
            return _Resp()

        async def __aexit__(self, *a):
            return False

    class _FakeAsyncClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def stream(self, method, url, json=None):
            return _StreamCtx()

    monkeypatch.setattr(lms.httpx, "AsyncClient", _FakeAsyncClient)
    prov = lms.LMStudioProvider("http://localhost:1234/v1")

    async def _collect():
        return [d async for d in prov.chat_stream(
            "m", [{"role": "user", "content": "hi"}], 5.0)]

    with pytest.raises(LLMError):
        asyncio.run(_collect())


def test_lmstudio_chat_stream_skips_malformed_and_empty(monkeypatch):
    lms = _LMS
    lines = [
        "data: {bad json",                        # malformed -> skipped
        "",                                        # blank -> skipped
        'data: {"choices":[{"delta":{}}]}',        # no content -> skipped
        'data: {"choices":[{"delta":{"content":"ok"}}]}',
        "data: [DONE]",
    ]

    class _Resp:
        def raise_for_status(self):
            pass

        async def aiter_lines(self):
            for ln in lines:
                yield ln

    class _StreamCtx:
        async def __aenter__(self):
            return _Resp()

        async def __aexit__(self, *a):
            return False

    class _FakeAsyncClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def stream(self, method, url, json=None):
            return _StreamCtx()

    monkeypatch.setattr(lms.httpx, "AsyncClient", _FakeAsyncClient)
    prov = lms.LMStudioProvider("http://localhost:1234/v1")

    async def _collect():
        return [d async for d in prov.chat_stream(
            "m", [{"role": "user", "content": "hi"}], 5.0)]

    assert asyncio.run(_collect()) == ["ok"]


# === LM Studio audit fixes (2026-06-02) ====================================
# Privacy firewall (loopback-only URL), the missing_models nudge, and the
# provider-neutral readiness / release-trust gates.

def test_settings_rejects_remote_lmstudio_url(client):
    """Privacy firewall: a non-loopback lmstudio_url is rejected with 422 —
    realtime explanations carry official LSAT content and must stay on-device.
    Restores the loopback default in `finally`."""
    try:
        assert client.put(
            "/api/settings", json={"lmstudio_url": "http://192.168.1.50:1234/v1"}
        ).status_code == 422
        # Embedded credentials are rejected even on a loopback host.
        assert client.put(
            "/api/settings", json={"lmstudio_url": "http://u:p@localhost:1234/v1"}
        ).status_code == 422
    finally:
        client.put("/api/settings", json={"lmstudio_url": "http://localhost:1234/v1"})


def test_settings_allows_remote_lmstudio_url_with_optout(client, monkeypatch):
    """LSATLAB_ALLOW_REMOTE_LLM=1 opts out of the loopback restriction."""
    monkeypatch.setenv("LSATLAB_ALLOW_REMOTE_LLM", "1")
    try:
        r = client.put(
            "/api/settings", json={"lmstudio_url": "http://192.168.1.50:1234/v1"}
        )
        assert r.status_code == 200
        assert r.json()["settings"]["lmstudio_url"] == "http://192.168.1.50:1234/v1"
    finally:
        client.put("/api/settings", json={"lmstudio_url": "http://localhost:1234/v1"})


def test_health_missing_models_flags_unloaded_for_lmstudio(monkeypatch):
    """health() flags configured model ids the active LM Studio doesn't list (the
    nudge the routing card + onboarding render); loaded roles aren't flagged."""
    import app.llm as llm
    from app import ai

    ai.reset_resolved_models()
    monkeypatch.setattr(config, "LOCAL_PROVIDER", "lmstudio")
    monkeypatch.setattr(config, "GEN_PROVIDER", "ollama")
    monkeypatch.setattr(config, "CLOUD_API_KEY", "")
    monkeypatch.setattr(config, "EXPLAIN_MODEL", "loaded-explain")   # loaded
    monkeypatch.setattr(config, "DIAGNOSE_MODEL", "loaded-diag")     # loaded
    monkeypatch.setattr(config, "GEN_MODEL", "qwen3:14b")            # not loaded
    monkeypatch.setattr(config, "EMBED_MODEL", "nomic-embed-text")   # not loaded
    monkeypatch.setattr(config, "GEN_CRITIC_MODEL", "llama3.1:8b")   # not loaded

    async def _fake_list_models():
        return ["loaded-explain", "loaded-diag"]

    monkeypatch.setattr(llm.lmstudio(), "list_models", _fake_list_models)
    try:
        health = asyncio.run(ai.health())
        assert health["provider"] == "lmstudio"
        assert health["ok"] is True
        assert health["missing_models"] == sorted(
            {"qwen3:14b", "nomic-embed-text", "llama3.1:8b"}
        )
    finally:
        ai.reset_resolved_models()


def _fake_health(payload):
    async def _h():
        return payload
    return _h


_LMS_REACHABLE = {
    "ok": True, "provider": "lmstudio", "ollama": False,
    "models": ["m-explain", "m-diag", "m-gen", "m-embed"], "missing_models": [],
    "realtime_provider": "lmstudio", "offline_provider": "lmstudio",
}


def _match_models_to_config(monkeypatch):
    monkeypatch.setattr(config, "EXPLAIN_MODEL", "m-explain")
    monkeypatch.setattr(config, "EXPLAIN_FALLBACK_MODEL", "m-explain")
    monkeypatch.setattr(config, "DIAGNOSE_MODEL", "m-diag")
    monkeypatch.setattr(config, "GEN_MODEL", "m-gen")
    monkeypatch.setattr(config, "EMBED_MODEL", "m-embed")


def test_ready_provider_neutral_when_lmstudio_reachable(client, monkeypatch):
    """GET /api/ready treats a reachable LM Studio as AI-ready and does NOT emit
    the misleading ollama_unreachable warning."""
    from app import ai

    _match_models_to_config(monkeypatch)
    monkeypatch.setattr(ai, "health", _fake_health(dict(_LMS_REACHABLE)))
    r = client.get("/api/ready")
    assert r.status_code == 200
    body = r.json()
    assert body["ai"]["ready"] is True
    assert body["ai"]["provider_reachable"] is True
    assert "ollama_unreachable" not in body["warnings"]
    assert "ai_not_ready" not in body["warnings"]


def test_ready_names_active_provider_when_unreachable(client, monkeypatch):
    """When LM Studio is the active provider but unreachable, the warning names
    LM Studio — not Ollama."""
    from app import ai

    monkeypatch.setattr(ai, "health", _fake_health({
        "ok": False, "provider": "lmstudio", "ollama": False,
        "models": [], "missing_models": [],
        "realtime_provider": "lmstudio", "offline_provider": "lmstudio",
    }))
    r = client.get("/api/ready")
    assert r.status_code == 200
    body = r.json()
    assert body["ai"]["ready"] is False
    assert body["ai"]["provider_reachable"] is False
    assert "lmstudio_unreachable" in body["warnings"]
    assert "ollama_unreachable" not in body["warnings"]


def test_trust_not_blocked_by_lmstudio_when_reachable(client, monkeypatch):
    """The release-trust gate must not list 'provider' as required-missing when
    LM Studio is reachable with all role models loaded."""
    from app import ai, trust

    _match_models_to_config(monkeypatch)
    monkeypatch.setattr(ai, "health", _fake_health(dict(_LMS_REACHABLE)))
    res = trust._model_readiness_check("packaged")
    assert res["detail"]["provider_reachable"] is True
    assert "provider" not in res["detail"]["required_missing"]
    assert res["status"] == "ok"
