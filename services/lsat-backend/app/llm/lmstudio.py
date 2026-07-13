"""Local LMStudio provider (OpenAI-compatible API).

LMStudio runs an OpenAI-compatible server (default ``http://localhost:1234/v1``)
exposing chat completions (streaming + non-streaming), embeddings, and a models
list. This mirrors :class:`OllamaProvider`'s method surface exactly — same names,
same signatures — so the facade can route the local realtime / embed / offline
paths to either, selected by ``config.LOCAL_PROVIDER``. Transport resilience
(retry-on-connect, the GPU concurrency cap) is shared via ``base``.

Mapping notes vs. Ollama
------------------------
- ``generate`` has no separate prompt+system endpoint here; we send a
  system+user message pair to ``/chat/completions`` (same intent).
- ``format`` maps to OpenAI ``response_format``: ``"json"`` -> ``json_object``;
  a JSON-Schema ``dict`` -> ``json_schema`` (the LMStudio analogue of Ollama's
  structured ``format``). LMStudio honours ``temperature``/``seed`` natively.
- Think-tag stripping stays the caller's job (ai.py), exactly as for Ollama.
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


class LMStudioProvider:
    name = "lmstudio"

    def __init__(self, base_url: Optional[str] = None) -> None:
        # base_url already includes the OpenAI-compatible /v1 prefix.
        self.base_url = config.validate_local_model_url(
            base_url or config.LMSTUDIO_URL,
            name="LSATLAB_LMSTUDIO_URL",
        )

    @staticmethod
    def _response_format(
        format: Optional[Union[str, dict[str, Any]]],
    ) -> Optional[dict[str, Any]]:
        """Map the generic ``format`` arg to an OpenAI ``response_format``."""
        if format is None:
            return None
        if isinstance(format, dict):
            # A JSON-Schema dict -> structured json_schema response.
            return {
                "type": "json_schema",
                "json_schema": {"name": "response", "schema": format},
            }
        if format == "json":
            return {"type": "json_object"}
        return None

    # --- streaming chat (realtime, yields raw deltas) ----------------------
    async def chat_stream(self, model: str, messages: list[dict],
                          timeout: float) -> AsyncIterator[str]:
        """Yield content deltas from an SSE chat-completions stream. Retries only
        the *connect* (before the first token); a mid-stream break is re-raised
        since it can't be safely resumed (matches OllamaProvider)."""
        policy = default_policy()
        for attempt in range(policy.attempts):
            yielded = False
            try:
                async with get_async_guard():
                    async with httpx.AsyncClient(timeout=timeout) as client:
                        async with client.stream(
                            "POST", f"{self.base_url}/chat/completions",
                            json={"model": model, "messages": messages,
                                  "stream": True},
                        ) as resp:
                            resp.raise_for_status()
                            async for line in resp.aiter_lines():
                                line = line.strip()
                                if not line or not line.startswith("data:"):
                                    continue
                                data = line[len("data:"):].strip()
                                if data == "[DONE]":
                                    break
                                try:
                                    obj = json.loads(data)
                                except json.JSONDecodeError:
                                    continue
                                choices = obj.get("choices") or []
                                if not choices:
                                    continue
                                delta = (choices[0].get("delta") or {}).get(
                                    "content", ""
                                )
                                if delta:
                                    yielded = True
                                    yield delta
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
                        f"{self.base_url}/chat/completions",
                        json={"model": model, "messages": messages, "stream": False},
                    )
                    resp.raise_for_status()
                    choices = resp.json().get("choices") or []
                    if not choices:
                        return ""
                    return (choices[0].get("message") or {}).get("content", "") or ""
        return await retry_async(_call)

    # --- sync generate (offline jobs in worker threads) --------------------
    def generate(self, model: str, prompt: str, system: Optional[str] = None,
                 timeout: Optional[float] = None, *,
                 temperature: Optional[float] = None,
                 top_p: Optional[float] = None,
                 seed: Optional[int] = None,
                 format: Optional[Union[str, dict[str, Any]]] = None) -> str:
        """Non-streaming generation, mapped onto ``/chat/completions``.

        A system+user message pair carries the same intent as Ollama's separate
        prompt+system fields. ``temperature``/``top_p``/``seed`` map to the
        OpenAI fields so the generation gate can run its solve/critique passes
        deterministically; ``format`` maps to ``response_format``.
        """
        def _call() -> str:
            messages: list[dict] = []
            if system:
                messages.append({"role": "system", "content": system})
            messages.append({"role": "user", "content": prompt})
            payload: dict = {"model": model, "messages": messages, "stream": False}
            if temperature is not None:
                payload["temperature"] = temperature
            if top_p is not None:
                payload["top_p"] = top_p
            if seed is not None:
                payload["seed"] = seed
            rf = self._response_format(format)
            if rf is not None:
                payload["response_format"] = rf
            with sync_guard():
                with httpx.Client(
                    timeout=timeout or config.GEN_REQUEST_TIMEOUT_S
                ) as client:
                    resp = client.post(
                        f"{self.base_url}/chat/completions", json=payload
                    )
                    resp.raise_for_status()
                    choices = resp.json().get("choices") or []
                    if not choices:
                        return ""
                    return (choices[0].get("message") or {}).get("content", "") or ""
        return retry_sync(_call)

    # --- model lifecycle (warm / unload) -----------------------------------
    def set_keep_alive(self, model: str, keep_alive: "int | str") -> bool:
        """Parity no-op with :meth:`OllamaProvider.set_keep_alive`.

        LMStudio's OpenAI-compatible ``/v1`` surface has no keep-alive/unload
        verb (load/unload is driven by the LMStudio app or the ``lms`` CLI), so
        there is nothing to call here. Returns True and never raises so a study
        action routed through ``llm.local_provider()`` is never blocked by a
        warm/unload step when LMStudio is the active provider."""
        del model, keep_alive
        return True

    # --- embeddings --------------------------------------------------------
    def embed_sync(self, text: str, model: Optional[str] = None) -> list[float]:
        model = model or config.EMBED_MODEL

        def _call() -> list[float]:
            # B22 parity: use the configurable embed timeout, like OllamaProvider,
            # instead of a hardcoded literal so it can be tuned per deployment.
            with httpx.Client(timeout=config.EMBED_REQUEST_TIMEOUT_S) as client:
                resp = client.post(
                    f"{self.base_url}/embeddings",
                    json={"model": model, "input": text},
                )
                resp.raise_for_status()
                data = resp.json().get("data") or []
                if not data:
                    return []
                return data[0].get("embedding", []) or []
        return retry_sync(_call)

    async def list_models(self) -> list[str]:
        async def _call() -> list[str]:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{self.base_url}/models")
                resp.raise_for_status()
                return [m["id"] for m in resp.json().get("data", [])]
        return await retry_async(_call)
