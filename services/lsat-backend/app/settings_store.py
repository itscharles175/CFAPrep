"""Runtime-overridable settings (model routing) persisted in the DB.

Why this exists
---------------
Model routing (which model explains vs. generates vs. embeds, and whether
offline generation uses the cloud) lived only in environment variables, so the
desktop user couldn't change it from the app. This persists a small set of
overrides and applies them over config.py — at startup and live on update.

How "live" works
----------------
The call sites read ``config.EXPLAIN_MODEL`` etc. at call time, so setting the
attribute on the ``config`` module takes effect for subsequent calls without a
restart. Secrets (cloud API key) are intentionally excluded — they stay in the
environment and are never persisted or returned.
"""
from __future__ import annotations

import math

from sqlmodel import Session, select

from . import config
from .models import Setting

class SettingsValidationError(ValueError):
    """Raised when a settings patch violates runtime safety policy."""


def is_allowed_lmstudio_url(url: str) -> bool:
    """True when ``url`` is safe to use as the LOCAL LMStudio provider.

    Realtime explanations send official LSAT content (stem, prompt, choices, and
    the correct answer) to this URL, and the app's privacy contract is that
    realtime AI never leaves the device (docs/00-vision.md). So by default only
    loopback hosts are accepted. Set ``LSATLAB_ALLOW_REMOTE_LLM=1`` to permit a
    non-loopback URL (e.g. another machine on your LAN) at your own risk. URLs
    with embedded credentials are always rejected. When the strict offline fence
    is on, the remote opt-out is intentionally ignored. (Addresses the audit
    finding that ``lmstudio_url`` could route official content off-device.)
    """
    try:
        config.validate_local_model_url(url, name="LSATLAB_LMSTUDIO_URL")
        return True
    except config.OfflineFenceError:
        return False


def _validate_lmstudio_url(url: str) -> bool:
    try:
        config.validate_local_model_url(url, name="LSATLAB_LMSTUDIO_URL")
    except config.OfflineFenceError as exc:
        raise SettingsValidationError(str(exc)) from exc
    return True


def _validate_gen_provider(value: str) -> bool:
    if value not in ("ollama", "cloud"):
        return False
    if value == "cloud" and config.ENFORCE_OFFLINE:
        raise SettingsValidationError(
            "gen_provider=cloud is blocked while the strict offline fence is on. "
            "Use local generation, or set LSATLAB_ENFORCE_OFFLINE=0 and "
            "LSATLAB_CLOUD_EGRESS_ALLOWED=1 only when outbound cloud model traffic is intentional."
        )
    return True

# public setting key -> config attribute it overrides.
_OVERRIDABLE: dict[str, str] = {
    "explain_model": "EXPLAIN_MODEL",
    "gen_model": "GEN_MODEL",
    "diagnose_model": "DIAGNOSE_MODEL",
    "embed_model": "EMBED_MODEL",
    "gen_provider": "GEN_PROVIDER",
    "cloud_gen_model": "CLOUD_GEN_MODEL",
    # The gate's decorrelated critic. Overridable so an LMStudio user can point
    # generation's solve/critique pass at a model id that actually exists locally
    # (the Ollama default `llama3.1:8b` is not an LMStudio model id).
    "gen_critic_model": "GEN_CRITIC_MODEL",
    # LMStudio-as-local-provider (OpenAI-compatible) routing. Lets the desktop
    # user pick Ollama vs LMStudio (and its base URL) without env vars.
    "local_provider": "LOCAL_PROVIDER",
    "lmstudio_url": "LMSTUDIO_URL",
    # 3.2 — FSRS retention target. Stored as a string like every Setting, but
    # coerced to a float on apply (see _COERCE) since callers read a float.
    "desired_retention": "SRS_DESIRED_RETENTION",
}

# Keys whose stored string must be coerced to a non-string type before being set
# on the config module (Settings are always strings on disk).
_COERCE: dict[str, callable] = {
    "desired_retention": float,
}


# Domain validators applied AFTER coercion. The HTTP route (SettingsPatch) also
# validates, but apply_saved_settings (startup) and any internal caller bypass it,
# so we re-check here: a non-finite retention or an unknown provider from a stale/
# typo'd persisted key must not poison the live config (FSRS math / provider
# routing). An out-of-domain value keeps the current config value instead.
_VALIDATORS: dict[str, callable] = {
    "local_provider": lambda v: v in ("ollama", "lmstudio"),
    "gen_provider": _validate_gen_provider,
    # Keep a remote/garbage URL from ever reaching the live config (the HTTP
    # route rejects it too, but apply_saved_settings/internal callers bypass that).
    "lmstudio_url": _validate_lmstudio_url,
    "desired_retention": lambda v: isinstance(v, float)
    and math.isfinite(v)
    and 0.0 < v < 1.0,
}


def _coerce(key: str, value):
    fn = _COERCE.get(key)
    coerced = value
    if fn is not None:
        try:
            coerced = fn(value)
        except (TypeError, ValueError):
            return getattr(config, _OVERRIDABLE[key])  # keep current on bad input
    validator = _VALIDATORS.get(key)
    if validator is not None and not validator(coerced):
        return getattr(config, _OVERRIDABLE[key])  # out-of-domain => keep current
    return coerced


def effective_settings() -> dict:
    """Current effective values (config defaults with any overrides applied)."""
    return {key: getattr(config, attr) for key, attr in _OVERRIDABLE.items()}


def apply_saved_settings(session: Session) -> None:
    """Apply persisted overrides onto the config module (called at startup)."""
    previous = {attr: getattr(config, attr) for attr in set(_OVERRIDABLE.values())}
    try:
        for s in session.exec(select(Setting)).all():
            attr = _OVERRIDABLE.get(s.key)
            if attr:
                setattr(config, attr, _coerce(s.key, s.value))
        config.validate_offline_provider_fence()
    except Exception:
        for attr, value in previous.items():
            setattr(config, attr, value)
        raise
    # 3.2 — also load any persisted optimized FSRS weights so the spaced-repetition
    # scheduler reflects the user's own optimization from the first review.
    try:
        from . import srs

        srs.load_optimized_params(session)
    except Exception:
        import logging as _lg
        # B34: log warning instead of silently swallowing the failure; a broken
        # optimizer load should surface in logs rather than producing wrong SRS
        # schedules without any trace.
        _lg.getLogger("lsatlab").warning(
            "load_optimized_params failed; using default FSRS weights", exc_info=True
        )


def update_settings(session: Session, patch: dict) -> dict:
    """Persist + apply recognised overrides. Unknown keys are ignored."""
    coerced: dict[str, object] = {}
    for key, val in patch.items():
        attr = _OVERRIDABLE.get(key)
        if attr is None or val is None:
            continue
        coerced[key] = _coerce(key, str(val))

    previous = {attr: getattr(config, attr) for attr in set(_OVERRIDABLE.values())}
    for key, value in coerced.items():
        setattr(config, _OVERRIDABLE[key], value)
    try:
        config.validate_offline_provider_fence()
    except Exception:
        for attr, value in previous.items():
            setattr(config, attr, value)
        raise

    for key, val in patch.items():
        attr = _OVERRIDABLE.get(key)
        if attr is None or val is None:
            continue
        sval = str(val)
        row = session.get(Setting, key)
        if row is None:
            row = Setting(key=key, value=sval)
        else:
            row.value = sval
        session.add(row)
    session.commit()
    # Switching the local provider (or the explain model) invalidates the cached
    # phi4->qwen3 resolution, which is Ollama-tag specific.
    if "local_provider" in patch or "explain_model" in patch:
        try:
            from . import ai

            ai.reset_resolved_models()
        except Exception:
            pass
    return effective_settings()
