"""LLM provider facade.

Routing policy (docs/00-vision.md):
- Realtime tasks (explain, diagnose, tag) ALWAYS use the selected LOCAL
  provider: Ollama by default, or LMStudio when ``LOCAL_PROVIDER=lmstudio``.
- Offline Tier-B generation MAY use an optional cloud provider when the user sets
  ``LSATLAB_GEN_PROVIDER=cloud`` and provides an API key; otherwise it also uses
  the selected local provider. Cloud is never used for realtime paths or
  score-affecting content.

Callers use the small surface here (``offline_generate``, ``embed_sync``,
``local_provider()``) rather than importing providers directly, so the routing
decision lives in one place.
"""
from __future__ import annotations

from typing import Any, Optional, Union

import logging
import math

from .. import config, observability
from ..observability import time_llm_call
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
    "cloud_enabled",
    "cloud_budget_status",
    "embed_sync",
    "provider_info",
]

_log = logging.getLogger("lsatlab.llm")

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


def cloud_enabled() -> bool:
    """Cloud offline generation is configured AND has a key."""
    return config.GEN_PROVIDER == "cloud" and bool(config.CLOUD_API_KEY)


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


def offline_provider_name() -> str:
    return "anthropic" if cloud_enabled() else config.LOCAL_PROVIDER


def offline_generate(prompt: str, system: Optional[str] = None,
                     timeout: Optional[float] = None, *,
                     model: Optional[str] = None,
                     temperature: Optional[float] = None,
                     seed: Optional[int] = None,
                     format: Optional[Union[str, dict[str, Any]]] = None,
                     task: str = "offline_generate") -> str:
    """Sync text generation for OFFLINE tiers (generate, solve, critique, structure).

    Routes to the cloud provider when configured, else the local gen model. The
    ``temperature``/``seed``/``format`` knobs are forwarded so the generation gate
    can run its solve/critique passes DETERMINISTICALLY and ask for guaranteed
    JSON. Raises ``LLMError`` on failure (callers decide whether to quarantine /
    fall back).
    """
    # Only forward the deterministic/structured options when set, so callers
    # (and test fakes) that don't use them keep the simple 4-arg signature.
    opts: dict = {}
    if temperature is not None:
        opts["temperature"] = temperature
    if seed is not None:
        opts["seed"] = seed
    if format is not None:
        opts["format"] = format
    if cloud_enabled():
        # 7.3 — ENFORCE the monthly budget: refuse the (paid) cloud call when its
        # WORST-CASE cost would push month-to-date spend past the cap, so a single
        # large call can't overshoot the budget. We fall back to the local model so
        # generation still proceeds — never silently overspending. The local Ollama
        # path below is free and is never budget-checked.
        worst_case = observability.estimate_cloud_cost_usd(
            _estimate_input_tokens(prompt, system), config.CLOUD_MAX_TOKENS
        )
        if _cloud_within_budget(worst_case):
            from .cloud import AnthropicProvider
            prov = AnthropicProvider(config.CLOUD_API_KEY)
            target = model or config.CLOUD_GEN_MODEL
            with time_llm_call(task, provider="anthropic", model=target):
                return prov.generate(target, prompt, system, timeout, **opts)
        _log.warning(
            "cloud monthly budget would be exceeded (spend=%.4f + worst_case=%.4f "
            "> budget=%.2f); falling back to local model for task=%s",
            observability.month_to_date_spend_usd(), worst_case,
            config.CLOUD_MONTHLY_BUDGET_USD, task,
        )
    prov = local_provider()
    target = model or config.GEN_MODEL
    with time_llm_call(task, provider=prov.name, model=target):
        return prov.generate(target, prompt, system, timeout, **opts)


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
                    seed: Optional[int] = None,
                    format: Optional[Union[str, dict[str, Any]]] = None) -> str:
    """Like :func:`offline_generate` but routed to the CRITIC model so the gate's
    solve/critique passes are decorrelated from generation."""
    return offline_generate(prompt, system, timeout, model=critic_model_name(),
                            temperature=temperature, seed=seed, format=format,
                            task="gate_critic")


def embed_sync(text: str, model: Optional[str] = None) -> list[float]:
    """Embed one text via the local embed model (always local — Ollama or
    LMStudio per ``LOCAL_PROVIDER``)."""
    prov = local_provider()
    target = model or config.EMBED_MODEL
    with time_llm_call("embed", provider=prov.name, model=target):
        return prov.embed_sync(text, target)


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
        "cloud_enabled": cloud_enabled(),
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
