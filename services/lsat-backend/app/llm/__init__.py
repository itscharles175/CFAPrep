"""LLM provider facade.

Routing policy (docs/00-vision.md):
- Realtime tasks (explain, diagnose, tag) ALWAYS use the selected LOCAL
  provider: Ollama by default, or LMStudio when ``LOCAL_PROVIDER=lmstudio``.
- Offline Tier-B generation MAY use an optional cloud provider only when the
  user sets ``LSATLAB_GEN_PROVIDER=cloud``, provides an API key, opts out of the
  strict offline fence, and sets ``LSATLAB_CLOUD_EGRESS_ALLOWED=1``; otherwise
  it also uses the selected local provider. Cloud is never used for realtime
  paths or score-affecting content.

Callers use the small surface here (``offline_generate``, ``embed_sync``,
``local_provider()``) rather than importing providers directly, so the routing
decision lives in one place.
"""
from __future__ import annotations

import copy
from typing import Any, Optional, Union

import logging
import math
from urllib.parse import urlparse

from .. import config, observability
from ..observability import time_llm_call
from . import cache
from .base import CloudBudgetExceeded, LLMError, LLMOOMError
from .lmstudio import LMStudioProvider
from .ollama import OllamaProvider

__all__ = [
    "LLMError",
    "LLMOOMError",
    "CloudBudgetExceeded",
    "OllamaProvider",
    "LMStudioProvider",
    "ollama",
    "lmstudio",
    "local_provider",
    "offline_generate",
    "critic_generate",
    "offline_provider_name",
    "critic_model_name",
    "cloud_configured",
    "cloud_egress_allowed",
    "cloud_enabled",
    "assert_cloud_allowed",
    "cloud_budget_status",
    "cloud_budget_dry_run",
    "embed_sync",
    "provider_info",
    "provider_capabilities",
    "provider_capability_matrix",
    "cache",
    "cache_stats",
]

_log = logging.getLogger("lsatlab.llm")

_PROVIDER_CAPABILITIES: dict[str, dict[str, Any]] = {
    "ollama": {
        "provider": "ollama",
        "local": True,
        "cloud": False,
        "system_prompt": True,
        "sampling": {"temperature": True, "top_p": True, "seed": True},
        "structured_output": {"json_mode": True, "json_schema": True},
        "chat_stream": True,
        "embeddings": True,
        "keep_alive": True,
        "degradations": [],
    },
    "lmstudio": {
        "provider": "lmstudio",
        "local": True,
        "cloud": False,
        "system_prompt": True,
        "sampling": {"temperature": True, "top_p": True, "seed": True},
        "structured_output": {"json_mode": True, "json_schema": True},
        "chat_stream": True,
        "embeddings": True,
        "keep_alive": False,
        "degradations": [
            {
                "field": "keep_alive",
                "behavior": "no_op",
                "reason": "LM Studio's OpenAI-compatible API has no keep-alive verb.",
            },
        ],
    },
    "anthropic": {
        "provider": "anthropic",
        "local": False,
        "cloud": True,
        "system_prompt": True,
        "sampling": {"temperature": True, "top_p": True, "seed": False},
        "structured_output": {"json_mode": True, "json_schema": True},
        "chat_stream": False,
        "embeddings": False,
        "keep_alive": False,
        "degradations": [
            {
                "field": "seed",
                "behavior": "omitted",
                "reason": "Anthropic Messages has no seed parameter; seed alone is not a deterministic cache contract.",
            },
        ],
    },
}

_ollama: Optional[OllamaProvider] = None
_lmstudio: Optional[LMStudioProvider] = None


def ollama() -> OllamaProvider:
    """Process-wide local Ollama provider singleton."""
    global _ollama
    if _ollama is None:
        _ollama = OllamaProvider()
    return _ollama


def lmstudio() -> LMStudioProvider:
    """Process-wide LMStudio provider, rebuilt if the configured URL changes so a
    live ``lmstudio_url`` settings update takes effect without a restart."""
    global _lmstudio
    want = config.LMSTUDIO_URL.rstrip("/")
    if _lmstudio is None or _lmstudio.base_url != want:
        _lmstudio = LMStudioProvider(want)
    return _lmstudio


def local_provider() -> Union[OllamaProvider, LMStudioProvider]:
    """The selected LOCAL inference provider — used for realtime (explain/
    diagnose/tag), embeddings, and the local branch of offline generation.
    Ollama by default; LMStudio when ``config.LOCAL_PROVIDER == "lmstudio"``.
    Cloud offline-gen is orthogonal (see ``cloud_enabled``)."""
    if config.LOCAL_PROVIDER == "lmstudio":
        return lmstudio()
    return ollama()


def cloud_configured() -> bool:
    """Cloud offline generation is selected and has credential material."""
    return config.GEN_PROVIDER == "cloud" and bool(config.CLOUD_API_KEY)


def cloud_egress_allowed() -> bool:
    """Whether the user explicitly admitted outbound cloud model traffic."""
    return bool(getattr(config, "CLOUD_EGRESS_ALLOWED", False))


def cloud_enabled() -> bool:
    """Cloud offline generation is configured and explicitly egress-enabled."""
    return cloud_configured() and cloud_egress_allowed()


def assert_cloud_allowed() -> None:
    """AI-10 strict offline fence: refuse to select/instantiate the cloud provider.

    StudyVault's no-cloud invariant ("works on a plane") is enforced here, not by
    convention: when ``config.ENFORCE_OFFLINE`` is on (the default in the packaged
    build) and the cloud provider is configured (``GEN_PROVIDER=cloud`` + a key),
    raise a clear :class:`RuntimeError` naming the offending env var so the egress
    path to api.anthropic.com is unreachable. The cloud code itself stays in the
    tree for opt-out/standalone use, but selecting it also requires
    ``LSATLAB_CLOUD_EGRESS_ALLOWED=1``.
    """
    if not config.ENFORCE_OFFLINE:
        if cloud_configured() and not cloud_egress_allowed():
            raise RuntimeError(
                "Cloud LLM egress is disabled: LSATLAB_GEN_PROVIDER='cloud' and "
                "an API key are configured, but LSATLAB_CLOUD_EGRESS_ALLOWED is "
                "not set. Set LSATLAB_CLOUD_EGRESS_ALLOWED=1 only when outbound "
                "model-provider traffic is intentional."
            )
        return
    if config.GEN_PROVIDER == "cloud":
        raise RuntimeError(
            "Strict offline fence is ON: the cloud LLM provider is blocked "
            "(LSATLAB_GEN_PROVIDER='cloud'). StudyVault is local-only by default - "
            "no cloud, no telemetry. Set LSATLAB_GEN_PROVIDER=ollama (or lmstudio) to "
            "use a local model, or LSATLAB_ENFORCE_OFFLINE=0 and "
            "LSATLAB_CLOUD_EGRESS_ALLOWED=1 to opt out of the fence and admit "
            "cloud egress."
        )


def cloud_budget_status() -> dict:
    """7.3 — month-to-date cloud spend vs the configured monthly budget.

    ``budget_usd`` is ``None`` when no budget is set (0 => unlimited; cloud is
    opt-in either way). ``within_budget`` is True when another cloud call is
    allowed. Reads the durable ``UsageLedger`` so the gauge/enforcement survive a
    restart. Surfaced on /observability/status and checked before each cloud call.
    """
    budget = config.CLOUD_MONTHLY_BUDGET_USD
    spend = observability.month_to_date_spend_usd()
    if budget and budget > 0:
        return {
            "spend_usd": round(spend, 4),
            "budget_usd": round(budget, 2),
            "within_budget": spend < budget,
            "remaining_usd": round(max(0.0, budget - spend), 4),
        }
    return {
        "spend_usd": round(spend, 4),
        "budget_usd": None,
        "within_budget": True,
        "remaining_usd": None,
    }


def cloud_budget_dry_run(
    input_tokens: Optional[int] = None,
    output_tokens: Optional[int] = None,
) -> dict:
    """BB4 — the full cloud-budget picture + a NEXT-CALL dry-run cost estimate.

    Builds on :func:`cloud_budget_status` (month-to-date spend vs budget) and
    :func:`observability.estimate_cloud_cost_usd` (the SAME pricing the real
    pre-call guard and ledger use) to forecast what the next cloud call would
    cost — WITHOUT ever invoking the provider. ``input_tokens``/``output_tokens``
    default to the representative ``config.CLOUD_DRY_RUN_*`` token counts when not
    supplied (the endpoint accepts query params to override them).

    ``next_call.would_exceed_budget`` mirrors the real enforcement: it reuses
    :func:`_cloud_within_budget` with the dry-run estimate so the UI's "this would
    overshoot" warning matches what ``offline_generate`` would actually refuse.
    Read-only and best-effort: the underlying spend read degrades to 0.0 on error
    (the gauge stays visible), exactly like the status path.
    """
    in_tok = int(input_tokens) if input_tokens is not None else config.CLOUD_DRY_RUN_INPUT_TOKENS
    out_tok = int(output_tokens) if output_tokens is not None else config.CLOUD_DRY_RUN_OUTPUT_TOKENS
    in_tok = max(0, in_tok)
    out_tok = max(0, out_tok)
    estimate = observability.estimate_cloud_cost_usd(in_tok, out_tok)
    status = cloud_budget_status()
    return {
        **status,
        "cloud_enabled": cloud_enabled(),
        "cloud_configured": cloud_configured(),
        "cloud_egress_allowed": cloud_egress_allowed(),
        "dry_run": bool(config.CLOUD_DRY_RUN),
        "pricing": {
            "input_cost_per_mtok_usd": config.CLOUD_INPUT_COST_PER_MTOK,
            "output_cost_per_mtok_usd": config.CLOUD_OUTPUT_COST_PER_MTOK,
        },
        "next_call": {
            "input_tokens": in_tok,
            "output_tokens": out_tok,
            "estimated_cost_usd": estimate,
            # True only when a budget is configured AND admitting this call would
            # push spend past the cap (matches the real enforcement guard).
            "would_exceed_budget": (
                status["budget_usd"] is not None and not _cloud_within_budget(estimate)
            ),
        },
    }


def _estimate_input_tokens(prompt: str, system: Optional[str] = None) -> int:
    """Rough input-token count for the worst-case pre-call cost estimate.

    ~4 chars/token is the usual English heuristic; we ceil so a partial token
    still counts. Used only to keep a single large call from overshooting the
    monthly budget — exactness isn't required, but we must not UNDER-count, so
    rounding up is the safe direction.
    """
    chars = len(prompt or "") + len(system or "")
    return math.ceil(chars / 4)


def _cloud_within_budget(estimate_usd: float = 0.0) -> bool:
    """True if a cloud call is permitted under the monthly budget (or none set).

    ``estimate_usd`` is the WORST-CASE cost of the call about to be made (priced
    input tokens + the full ``CLOUD_MAX_TOKENS`` output). Admitting on
    ``spend < budget`` alone lets a single large call push month-to-date spend
    PAST the cap; we instead require ``spend + estimate_usd <= budget`` so the
    budget is a true ceiling, not just a pre-call gate.
    """
    budget = config.CLOUD_MONTHLY_BUDGET_USD
    if not budget or budget <= 0:
        return True  # no budget configured => unlimited (still opt-in)
    try:
        spend = observability.month_to_date_spend_usd(strict=True)
    except Exception:
        # Spend read FAILED while a budget is configured: fail CLOSED. Returning
        # 0.0 ("plenty left") would let a metrics-store glitch silently disable
        # the cap while still spending; refusing falls back to the free local model.
        _log.warning(
            "cloud spend read failed; refusing cloud call (fail-closed under budget)"
        )
        return False
    return (spend + max(0.0, estimate_usd)) <= budget


def _cloud_url_host() -> str:
    try:
        return urlparse(config.CLOUD_API_URL).hostname or ""
    except Exception:
        return ""


def _log_cloud_egress_decision(
    *,
    task: str,
    model: str,
    allowed: bool,
    reason: str,
    input_tokens_estimate: int,
    worst_case_usd: float,
) -> None:
    _log.info(
        "cloud_egress task=%s provider=anthropic model=%s allowed=%s reason=%s "
        "input_tokens_est=%d max_output_tokens=%d worst_case_usd=%.6f "
        "budget_usd=%s url_host=%s prompt_logged=false",
        task,
        model,
        allowed,
        reason,
        input_tokens_estimate,
        config.CLOUD_MAX_TOKENS,
        worst_case_usd,
        config.CLOUD_MONTHLY_BUDGET_USD if config.CLOUD_MONTHLY_BUDGET_USD > 0 else None,
        _cloud_url_host(),
    )


def offline_provider_name() -> str:
    return "anthropic" if cloud_enabled() else config.LOCAL_PROVIDER


def provider_capabilities(provider_name: Optional[str] = None) -> dict[str, Any]:
    """Static capability/degradation contract for a known LLM provider.

    The matrix is deliberately conservative: if a provider cannot honor a knob
    (notably Anthropic ``seed``), the facade must omit that knob from the
    provider request and from the cache determinism contract.
    """
    name = (provider_name or offline_provider_name() or "").lower()
    caps = _PROVIDER_CAPABILITIES.get(name)
    if caps is None:
        return {
            "provider": name,
            "known": False,
            "local": False,
            "cloud": False,
            "system_prompt": False,
            "sampling": {"temperature": False, "top_p": False, "seed": False},
            "structured_output": {"json_mode": False, "json_schema": False},
            "chat_stream": False,
            "embeddings": False,
            "keep_alive": False,
            "degradations": [{"field": "*", "behavior": "unsupported",
                              "reason": "Unknown provider."}],
        }
    out = copy.deepcopy(caps)
    out["known"] = True
    return out


def provider_capability_matrix() -> dict[str, dict[str, Any]]:
    """All supported provider capability rows, keyed by provider name."""
    return {name: provider_capabilities(name) for name in sorted(_PROVIDER_CAPABILITIES)}


def _negotiate_generation_options(
    provider_name: str,
    opts: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, str]]]:
    """Return provider kwargs plus the effective cache-key contract.

    The returned ``contract`` mirrors the actual provider request after any
    degradation. This prevents unsupported knobs from making a cache key look
    more deterministic or schema-constrained than the provider can really honor.
    """
    caps = provider_capabilities(provider_name)
    effective = dict(opts)
    degradations: list[dict[str, str]] = []

    sampling = caps["sampling"]
    if "seed" in effective and not sampling.get("seed"):
        effective.pop("seed", None)
        degradations.append({
            "field": "seed",
            "behavior": "omitted",
            "reason": "provider_does_not_support_seed",
        })
    if "top_p" in effective and not sampling.get("top_p"):
        effective.pop("top_p", None)
        degradations.append({
            "field": "top_p",
            "behavior": "omitted",
            "reason": "provider_does_not_support_top_p",
        })
    if "temperature" in effective and not sampling.get("temperature"):
        effective.pop("temperature", None)
        degradations.append({
            "field": "temperature",
            "behavior": "omitted",
            "reason": "provider_does_not_support_temperature",
        })

    structured = caps["structured_output"]
    if "format" in effective:
        fmt = effective.get("format")
        if isinstance(fmt, dict) and not structured.get("json_schema"):
            if structured.get("json_mode"):
                effective["format"] = "json"
                degradations.append({
                    "field": "format",
                    "behavior": "json_schema_to_json",
                    "reason": "provider_does_not_support_json_schema",
                })
            else:
                effective.pop("format", None)
                degradations.append({
                    "field": "format",
                    "behavior": "omitted",
                    "reason": "provider_does_not_support_structured_output",
                })
        elif fmt is not None and not isinstance(fmt, dict) and fmt != "json":
            effective.pop("format", None)
            degradations.append({
                "field": "format",
                "behavior": "omitted",
                "reason": "unsupported_format_value",
            })
        elif fmt is not None and not isinstance(fmt, dict) and not structured.get("json_mode"):
            effective.pop("format", None)
            degradations.append({
                "field": "format",
                "behavior": "omitted",
                "reason": "provider_does_not_support_json_mode",
            })

    contract = {
        "temperature": effective.get("temperature"),
        "top_p": effective.get("top_p"),
        "seed": effective.get("seed"),
        "format": effective.get("format"),
    }
    return effective, contract, degradations


def offline_generate(prompt: str, system: Optional[str] = None,
                     timeout: Optional[float] = None, *,
                     model: Optional[str] = None,
                     temperature: Optional[float] = None,
                     top_p: Optional[float] = None,
                     seed: Optional[int] = None,
                     format: Optional[Union[str, dict[str, Any]]] = None,
                     task: str = "offline_generate") -> str:
    """Sync text generation for OFFLINE tiers (generate, solve, critique, structure).

    Routes to the cloud provider when configured, else the local gen model. The
    ``temperature``/``top_p``/``seed``/``format`` knobs are forwarded so the
    generation gate can run its solve/critique passes DETERMINISTICALLY and ask
    for guaranteed JSON. Raises ``LLMError`` on failure (callers decide whether
    to quarantine / fall back).
    """
    # Only forward the deterministic/structured options when set, so callers
    # (and test fakes) that don't use them keep the simple 4-arg signature.
    opts: dict = {}
    if temperature is not None:
        opts["temperature"] = temperature
    if top_p is not None:
        opts["top_p"] = top_p
    if seed is not None:
        opts["seed"] = seed
    if format is not None:
        opts["format"] = format
    if cloud_configured():
        target = model or config.CLOUD_GEN_MODEL
        input_tokens_estimate = _estimate_input_tokens(prompt, system)
        worst_case = observability.estimate_cloud_cost_usd(
            input_tokens_estimate, config.CLOUD_MAX_TOKENS
        )
        # AI-10 — strict offline fence: before doing ANYTHING cloud-bound, refuse
        # (with a clear, env-var-naming RuntimeError) when enforcement is on. This
        # is the selection point that makes the api.anthropic.com egress path
        # unreachable in the normal StudyVault build.
        if config.ENFORCE_OFFLINE:
            _log_cloud_egress_decision(
                task=task,
                model=target,
                allowed=False,
                reason="strict_offline_fence",
                input_tokens_estimate=input_tokens_estimate,
                worst_case_usd=worst_case,
            )
            assert_cloud_allowed()
        if not cloud_egress_allowed():
            _log_cloud_egress_decision(
                task=task,
                model=target,
                allowed=False,
                reason="egress_not_explicitly_allowed",
                input_tokens_estimate=input_tokens_estimate,
                worst_case_usd=worst_case,
            )
            prov = local_provider()
            target = model or config.GEN_MODEL
            return _cached_generate(
                prov, prov.name, target, prompt, system, timeout,
                opts=opts, task=task,
            )
        assert_cloud_allowed()
        # 7.3 — ENFORCE the monthly budget: refuse the (paid) cloud call when its
        # WORST-CASE cost would push month-to-date spend past the cap, so a single
        # large call can't overshoot the budget. We fall back to the local model so
        # generation still proceeds — never silently overspending. The local Ollama
        # path below is free and is never budget-checked.
        if _cloud_within_budget(worst_case):
            from .cloud import AnthropicProvider
            prov = AnthropicProvider(config.CLOUD_API_KEY)
            _log_cloud_egress_decision(
                task=task,
                model=target,
                allowed=True,
                reason="explicit_opt_in",
                input_tokens_estimate=input_tokens_estimate,
                worst_case_usd=worst_case,
            )
            return _cached_generate(
                prov, "anthropic", target, prompt, system, timeout,
                opts=opts, task=task,
            )
        _log_cloud_egress_decision(
            task=task,
            model=target,
            allowed=False,
            reason="budget_would_be_exceeded",
            input_tokens_estimate=input_tokens_estimate,
            worst_case_usd=worst_case,
        )
        _log.warning(
            "cloud monthly budget would be exceeded (spend=%.4f + worst_case=%.4f "
            "> budget=%.2f); falling back to local model for task=%s",
            observability.month_to_date_spend_usd(), worst_case,
            config.CLOUD_MONTHLY_BUDGET_USD, task,
        )
    prov = local_provider()
    target = model or config.GEN_MODEL
    return _cached_generate(
        prov, prov.name, target, prompt, system, timeout,
        opts=opts, task=task,
    )


def _cached_generate(prov, provider_name: str, target: str, prompt: str,
                     system: Optional[str], timeout: Optional[float], *,
                     opts: dict, task: str) -> str:
    """BACK-1 — wrap a provider ``generate`` call with the deterministic cache.

    For a DETERMINISTIC call (temp 0 / seeded) and ``config.LLM_CACHE_ENABLED``:
    look up the content-addressed cache first using the full output-affecting
    contract (provider, model, system prompt, structured-output format/schema,
    sampling knobs, and prompt). On a hit return the stored text WITHOUT a model
    call (still recorded as a hit for the rate counter). On a miss, call the
    model under the usual ``time_llm_call`` timing seam and STORE the result
    before returning. Warm/creative calls bypass the cache entirely and behave
    exactly as before. The cache layer is best-effort — any cache error degrades
    to a plain model call, never a crash. Timeout is intentionally omitted: it
    affects failure behavior, not the model output contract.
    """
    effective_opts, contract, degradations = _negotiate_generation_options(
        provider_name, opts,
    )
    if degradations:
        _log.info(
            "llm_provider_degradation provider=%s model=%s fields=%s prompt_logged=false",
            provider_name,
            target,
            ",".join(d["field"] for d in degradations),
        )
    cache_on = getattr(config, "LLM_CACHE_ENABLED", True)
    if cache_on:
        cached = cache.get(
            provider=provider_name, model=target,
            system=system, format=contract["format"],
            temperature=contract["temperature"], top_p=contract["top_p"],
            seed=contract["seed"], prompt=prompt,
        )
        if cached is not None:
            return cached
    with time_llm_call(task, provider=provider_name, model=target):
        result = prov.generate(target, prompt, system, timeout, **effective_opts)
    if cache_on:
        cache.put(
            provider=provider_name, model=target,
            system=system, format=contract["format"],
            temperature=contract["temperature"], top_p=contract["top_p"],
            seed=contract["seed"], prompt=prompt,
            response=result,
        )
    return result


def critic_model_name() -> str:
    """The model used for the gate's adversarial solve/critique passes.

    Deliberately distinct from the generator (``GEN_MODEL``) so a model that
    writes a flawed item can't also rubber-stamp it (correlated errors). When
    cloud generation is enabled the same strong cloud model serves as critic.
    """
    return config.CLOUD_GEN_MODEL if cloud_enabled() else config.GEN_CRITIC_MODEL


def critic_generate(prompt: str, system: Optional[str] = None,
                    timeout: Optional[float] = None, *,
                    temperature: Optional[float] = None,
                    top_p: Optional[float] = None,
                    seed: Optional[int] = None,
                    format: Optional[Union[str, dict[str, Any]]] = None) -> str:
    """Like :func:`offline_generate` but routed to the CRITIC model so the gate's
    solve/critique passes are decorrelated from generation."""
    return offline_generate(prompt, system, timeout, model=critic_model_name(),
                            temperature=temperature, top_p=top_p, seed=seed,
                            format=format, task="gate_critic")


def embed_sync(text: str, model: Optional[str] = None) -> list[float]:
    """Embed one text via the local embed model (always local — Ollama or
    LMStudio per ``LOCAL_PROVIDER``)."""
    prov = local_provider()
    target = model or config.EMBED_MODEL
    with time_llm_call("embed", provider=prov.name, model=target):
        return prov.embed_sync(text, target)


def cache_stats() -> dict:
    """BACK-1 — content-addressed LLM cache counters for the observability surface.

    A thin pass-through to :func:`cache.stats` (hit/miss/store counts + hit_rate +
    LRU size) plus whether the cache is enabled, so /observability can show the
    deterministic-call cache hit rate alongside the latency/contention gauges.
    """
    return {"enabled": getattr(config, "LLM_CACHE_ENABLED", True), **cache.stats()}


def provider_info() -> dict:
    """Surface routing + model config for /ai/health and the settings UI.

    ``explain_model`` is the **resolved** Tier-A model: Phi-4 14B by default,
    falling back to Qwen3 8B when Phi-4 isn't pulled (Wave 1.5). The settings
    UI shows this and ``explain_model_configured`` so users can see whether
    they're getting the preferred model or the fallback.
    """
    # Late import to avoid the (app.ai -> app.llm -> app.ai) cycle.
    from .. import ai as _ai
    return {
        "realtime_provider": config.LOCAL_PROVIDER,
        "local_provider": config.LOCAL_PROVIDER,
        "lmstudio_url": config.LMSTUDIO_URL,
        "offline_provider": offline_provider_name(),
        "cloud_configured": cloud_configured(),
        "cloud_egress_allowed": cloud_egress_allowed(),
        "cloud_enabled": cloud_enabled(),
        "capabilities": {
            "realtime": provider_capabilities(config.LOCAL_PROVIDER),
            "offline": provider_capabilities(offline_provider_name()),
            "matrix": provider_capability_matrix(),
        },
        "explain_model": _ai.resolve_explain_model(),
        "explain_model_configured": config.EXPLAIN_MODEL,
        "explain_model_fallback": config.EXPLAIN_FALLBACK_MODEL,
        "tag_model": config.TAG_MODEL or config.EXPLAIN_MODEL,
        "gen_model": config.GEN_MODEL,
        "critic_model": critic_model_name(),
        "diagnose_model": config.DIAGNOSE_MODEL,
        "embed_model": config.EMBED_MODEL,
        "cloud_gen_model": config.CLOUD_GEN_MODEL if cloud_enabled() else None,
    }
