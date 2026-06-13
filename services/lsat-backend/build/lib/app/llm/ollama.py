"""Local Ollama provider.

All HTTP to Ollama flows through this class: streaming chat (realtime explain),
non-streaming chat, sync generate (offline jobs run in worker threads), and
embeddings. Retry-on-connection-blip and the GPU concurrency cap come from
``base``; callers (ai.py, generation.py, tagging.py, embeddings.py) just call
methods. Think-tag stripping is the caller's job — it is model-specific, not
transport-specific.
"""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any, Optional, Union

import httpx

from .. import config
from .base import (
    LLMError,
    default_policy,
    get_async_guard,
    is_transient,
    retry_async,
    retry_sync,
    sync_guard,
)


class OllamaProvider:
    name = "ollama"

    def __init__(self, base_url: Optional[str] = None) -> None:
        self.base_url = (base_url or config.OLLAMA_URL).rstrip("/")

    # --- streaming chat (realtime, yields raw deltas) ----------------------
    async def chat_stream(self, model: str, messages: list[dict],
                          timeout: float) -> AsyncIterator[str]:
        """Yield content deltas. Retries only the *connect* (before first token);
        a mid-stream break is re-raised since it can't be safely resumed."""
        policy = default_policy()
        for attempt in range(policy.attempts):
            yielded = False
            try:
                async with get_async_guard():
                    async with httpx.AsyncClient(timeout=timeout) as client:
                        async with client.stream(
                            "POST", f"{self.base_url}/api/chat",
                            json={"model": model, "messages": messages, "stream": True},
                        ) as resp:
                            resp.raise_for_status()
                            async for line in resp.aiter_lines():
                                if not line.strip():
                                    continue
                                try:
                                    obj = json.loads(line)
                                except json.JSONDecodeError:
                                    continue
                                delta = (obj.get("message") or {}).get("content", "")
                                if delta:
                                    yielded = True
                                    yield delta
                                if obj.get("done"):
                                    break
                return
            except Exception as exc:  # noqa: BLE001
                if yielded or not is_transient(exc) or attempt == policy.attempts - 1:
                    raise LLMError(str(exc)) from exc
                await asyncio.sleep(policy.backoff(attempt))

    # --- non-streaming chat ------------------------------------------------
    async def chat(self, model: str, messages: list[dict], timeout: float) -> str:
        async def _call() -> str:
            async with get_async_guard():
                async with httpx.AsyncClient(timeout=timeout) as client:
                    resp = await client.post(
                        f"{self.base_url}/api/chat",
                        json={"model": model, "messages": messages, "stream": False},
                    )
                    resp.raise_for_status()
                    return (resp.json().get("message") or {}).get("content", "")
        return await retry_async(_call)

    # --- sync generate (offline jobs in worker threads) --------------------
    def generate(self, model: str, prompt: str, system: Optional[str] = None,
                 timeout: Optional[float] = None, *,
                 temperature: Optional[float] = None,
                 seed: Optional[int] = None,
                 format: Optional[Union[str, dict[str, Any]]] = None) -> str:
        """Non-streaming generate.

        ``temperature``/``seed`` map to Ollama's ``options`` block so the gate's
        solve/critique calls can run DETERMINISTICALLY (temp 0 + fixed seed),
        making the correctness signal measure item soundness rather than sampling
        luck. ``format`` may be ``"json"`` (free-shape JSON) or a JSON Schema
        ``dict`` (Ollama 0.5+ structured outputs) — the latter pins the
        candidate envelope so even when the model paraphrases freely the wrapper
        shape stays parseable.
        """
        def _call() -> str:
            payload: dict = {"model": model, "prompt": prompt, "stream": False}
            if system:
                payload["system"] = system
            options: dict = {}
            if temperature is not None:
                options["temperature"] = temperature
            if seed is not None:
                options["seed"] = seed
            if options:
                payload["options"] = options
            if format:
                payload["format"] = format
            with sync_guard():
                with httpx.Client(timeout=timeout or config.GEN_REQUEST_TIMEOUT_S) as client:
                    resp = client.post(f"{self.base_url}/api/generate", json=payload)
                    resp.raise_for_status()
                    return resp.json().get("response", "")
        return retry_sync(_call)

    # --- model lifecycle (warm / unload) -----------------------------------
    def set_keep_alive(self, model: str, keep_alive: "int | str") -> bool:
        """Pin (keep_alive=-1), unload (keep_alive=0), or TTL a model in VRAM via a
        bodyless /api/generate. Best-effort: returns False on any failure and never
        raises, so a study action is never blocked by a warm/unload hiccup. Used to
        pin the realtime explain model during study and unload the gen model, so the
        two ~9 GB models don't thrash a 12 GB GPU."""
        def _call() -> dict:
            with sync_guard():
                with httpx.Client(timeout=30.0) as client:
                    resp = client.post(
                        f"{self.base_url}/api/generate",
                        json={"model": model, "keep_alive": keep_alive},
                    )
                    resp.raise_for_status()
                    return resp.json()
        try:
            retry_sync(_call)
            return True
        except LLMError:
            return False

    # --- embeddings --------------------------------------------------------
    def embed_sync(self, text: str, model: Optional[str] = None) -> list[float]:
        model = model or config.EMBED_MODEL

        def _call() -> list[float]:
            # B22: use the configurable EMBED_REQUEST_TIMEOUT_S (default 30s)
            # instead of a hardcoded literal so it can be tuned per deployment.
            with httpx.Client(timeout=config.EMBED_REQUEST_TIMEOUT_S) as client:
                resp = client.post(
                    f"{self.base_url}/api/embeddings",
                    json={"model": model, "prompt": text},
                )
                resp.raise_for_status()
                return resp.json().get("embedding", []) or []
        return retry_sync(_call)

    async def list_models(self) -> list[str]:
        async def _call() -> list[str]:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{self.base_url}/api/tags")
                resp.raise_for_status()
                return [m["name"] for m in resp.json().get("models", [])]
        return await retry_async(_call)
