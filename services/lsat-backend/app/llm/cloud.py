"""Optional cloud provider (Anthropic Claude) for OFFLINE Tier-B generation.

Why this exists
---------------
Generating genuinely LSAT-quality items is the single hardest task for a local
8B/14B model (docs/00-vision.md "the hard truth"). The user opted in to allowing
a cloud model for the *offline* tiers only — drill generation, the solve/critique
validation passes, PDF structuring. It is never used for realtime explain/diagnose
and never feeds score prediction (only ``source=="official"`` does).

Implementation notes
--------------------
- Plain ``httpx`` against the Anthropic Messages API — no SDK dependency, so the
  default offline build stays dependency-free and fully local.
- The system prompt is sent with ``cache_control: ephemeral`` so the long, shared
  instruction prefix is prompt-cached across the many candidates in a batch run.
- Activated only when ``GEN_PROVIDER=cloud``, an API key is present,
  ``LSATLAB_ENFORCE_OFFLINE=0``, and ``LSATLAB_CLOUD_EGRESS_ALLOWED=1``;
  otherwise the facade routes offline generation back to the local provider.
"""
from __future__ import annotations

import json
import logging
from typing import Optional, Union
from urllib.parse import urlparse

import httpx

from .. import config, observability
from .base import retry_sync, sync_guard

_log = logging.getLogger("lsatlab.llm.cloud")


class AnthropicProvider:
    name = "anthropic"

    def __init__(self, api_key: str, *, model: Optional[str] = None,
                 url: Optional[str] = None, max_tokens: Optional[int] = None) -> None:
        # AI-10 — strict offline fence, defense-in-depth. The facade
        # (app.llm.assert_cloud_allowed) already blocks the cloud SELECTION path,
        # but guarding the constructor makes the egress path unreachable even if a
        # future caller instantiates the provider directly. No-op when the fence is
        # off (the default under pytest, so the cloud HTTP-shape tests still run).
        if config.ENFORCE_OFFLINE:
            raise RuntimeError(
                "Strict offline fence is ON: refusing to instantiate the cloud "
                "AnthropicProvider. StudyVault is local-only by default — no cloud, "
                "no telemetry. Set LSATLAB_ENFORCE_OFFLINE=0 and "
                "LSATLAB_CLOUD_EGRESS_ALLOWED=1 to opt out of the fence."
            )
        if not getattr(config, "CLOUD_EGRESS_ALLOWED", False):
            raise RuntimeError(
                "Cloud LLM egress is disabled: set LSATLAB_CLOUD_EGRESS_ALLOWED=1 "
                "only when outbound Anthropic traffic is intentional."
            )
        if not api_key:
            raise ValueError("AnthropicProvider requires an API key")
        self.api_key = api_key
        self.model = model or config.CLOUD_GEN_MODEL
        self.url = url or config.CLOUD_API_URL
        self.max_tokens = max_tokens or config.CLOUD_MAX_TOKENS

    # A trivial single-field tool that forces the model to return its answer as a
    # JSON object (the Anthropic equivalent of Ollama's ``format:"json"``). We
    # ask for the raw JSON text in one field, then hand it back to the caller's
    # existing JSON parser — no schema lock-in, just guaranteed-parseable output.
    _JSON_TOOL = {
        "name": "respond_json",
        "description": "Return your entire answer as a single JSON object.",
        "input_schema": {
            "type": "object",
            "properties": {
                "json": {
                    "type": "string",
                    "description": "The full answer encoded as a JSON object string.",
                }
            },
            "required": ["json"],
        },
    }

    def generate(self, model: Optional[str], prompt: str,
                 system: Optional[str] = None, timeout: Optional[float] = None, *,
                 temperature: Optional[float] = None,
                 top_p: Optional[float] = None,
                 seed: Optional[int] = None,
                 format: Optional[Union[str, dict]] = None) -> str:
        """Generate via the Anthropic Messages API.

        ``temperature``/``top_p`` are forwarded for deterministic gate calls
        (0 = greedy). ``seed`` has no Anthropic analogue and is accepted-but-
        ignored so the offline facade can pass the same kwargs to either
        provider.

        ``format`` requests guaranteed-parseable JSON (the cloud analogue of
        Ollama's ``format``):
          * ``"json"`` -> a generic single-field tool; the raw JSON string is
            handed back;
          * a JSON-Schema ``dict`` (e.g. generation's ``_CANDIDATE_SCHEMA``) ->
            a tool whose ``input_schema`` IS that schema, so the response is
            constrained to it at decode time and the structured object is
            re-serialised to JSON text for the caller's parser.
        Previously only the literal ``"json"`` triggered tool-use, so a schema
        dict silently fell through to free prose — that gap is closed here.
        ``_extract_json`` remains the caller's fallback either way.
        """
        def _call() -> str:
            headers = {
                "x-api-key": self.api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            }
            body: dict = {
                "model": model or self.model,
                "max_tokens": self.max_tokens,
                "messages": [{"role": "user", "content": prompt}],
            }
            if temperature is not None:
                body["temperature"] = temperature
            if top_p is not None:
                body["top_p"] = top_p
            # Force tool-use so the output is guaranteed-parseable JSON. A schema
            # dict constrains the response directly; "json" (or any other truthy
            # format) uses the generic single-field tool.
            tool_name: Optional[str] = None
            if isinstance(format, dict):
                tool_name = "respond_schema"
                body["tools"] = [{
                    "name": tool_name,
                    "description": "Return your answer as a JSON object matching the schema.",
                    "input_schema": format,
                }]
                body["tool_choice"] = {"type": "tool", "name": tool_name}
            elif format is not None:
                tool_name = "respond_json"
                body["tools"] = [self._JSON_TOOL]
                body["tool_choice"] = {"type": "tool", "name": tool_name}
            if system:
                # cache the shared instruction prefix across a batch run.
                body["system"] = [{
                    "type": "text",
                    "text": system,
                    "cache_control": {"type": "ephemeral"},
                }]
            _log.info(
                "cloud_http_request provider=anthropic model=%s url_host=%s "
                "max_tokens=%d prompt_logged=false",
                body["model"],
                urlparse(self.url).hostname or "",
                self.max_tokens,
            )
            with httpx.Client(timeout=timeout or config.GEN_REQUEST_TIMEOUT_S) as client:
                resp = client.post(self.url, headers=headers, json=body)
                resp.raise_for_status()
                data = resp.json()
            usage = data.get("usage") or {}
            in_tok = int(usage.get("input_tokens") or 0)
            out_tok = int(usage.get("output_tokens") or 0)
            observability.record_cloud_tokens(in_tok, out_tok)  # RAM fast path
            # 7.3 — durable, priced ledger row so month-to-date spend (and its
            # budget enforcement) survive a restart.
            observability.persist_cloud_usage(
                self.name, model or self.model, in_tok, out_tok,
            )
            # Forced tool-use: the JSON we want is in the tool_use block's input.
            for block in data.get("content", []):
                if block.get("type") == "tool_use":
                    inp = block.get("input")
                    if not isinstance(inp, dict):
                        return ""
                    if tool_name == "respond_json":
                        return inp.get("json", "")
                    # schema tool: hand the structured object back as JSON text.
                    return json.dumps(inp)
            parts = [
                block.get("text", "")
                for block in data.get("content", [])
                if block.get("type") == "text"
            ]
            return "".join(parts)
        # Cap concurrent (paid) cloud calls with the same guard the local
        # providers use, so a batch fan-out can't issue many in parallel.
        with sync_guard():
            return retry_sync(_call)
