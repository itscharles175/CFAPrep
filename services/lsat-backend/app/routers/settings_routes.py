"""Settings / model-routing endpoints."""
from __future__ import annotations

from typing import Annotated, Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator
from sqlmodel import Session

from .. import llm, settings_store
from ..db import get_session

router = APIRouter(prefix="/settings")

ModelName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)
]
ProviderName = Literal["ollama", "cloud"]
LocalProviderName = Literal["ollama", "lmstudio"]


class SettingsPatch(BaseModel):
    explain_model: Optional[ModelName] = None
    gen_model: Optional[ModelName] = None
    diagnose_model: Optional[ModelName] = None
    embed_model: Optional[ModelName] = None
    gen_critic_model: Optional[ModelName] = None
    gen_provider: Optional[ProviderName] = None
    cloud_gen_model: Optional[ModelName] = None
    local_provider: Optional[LocalProviderName] = None
    lmstudio_url: Optional[ModelName] = None
    desired_retention: Optional[float] = Field(default=None, gt=0.0, lt=1.0)

    @field_validator("lmstudio_url")
    @classmethod
    def _loopback_only(cls, v: Optional[str]) -> Optional[str]:
        # Realtime explanations send official content to this URL, so it must
        # stay on-device by default. (Set LSATLAB_ALLOW_REMOTE_LLM=1 to opt out.)
        if v is not None and not settings_store.is_allowed_lmstudio_url(v):
            raise ValueError(
                "lmstudio_url must be a loopback http(s) URL "
                "(localhost / 127.0.0.1). Set LSATLAB_ALLOW_REMOTE_LLM=1 to "
                "allow a remote endpoint."
            )
        return v


class SettingsValuesOut(BaseModel):
    """Effective model-routing values — the fixed ``settings_store._OVERRIDABLE``
    key set (settings_store.py). All keys are always emitted; ``extra="allow"``
    keeps any future additive keys on the wire without a schema edit. Secret
    keys (e.g. ``cloud_api_key``) are never part of this payload and MUST NOT
    be declared here."""

    model_config = ConfigDict(extra="allow")

    explain_model: str
    gen_model: str
    diagnose_model: str
    embed_model: str
    gen_provider: str
    cloud_gen_model: str
    gen_critic_model: str
    local_provider: str
    lmstudio_url: str
    desired_retention: float


class SettingsProviderInfoOut(BaseModel):
    """Mirror of ``llm.provider_info()`` (app/llm/__init__.py). ``capabilities``
    stays ``dict[str, Any]`` because its ``matrix`` block is dynamically keyed
    by provider name; ``cloud_gen_model`` is null when cloud is disabled."""

    model_config = ConfigDict(extra="allow")

    realtime_provider: str
    local_provider: str
    lmstudio_url: str
    offline_provider: str
    cloud_configured: bool
    cloud_egress_allowed: bool
    cloud_enabled: bool
    capabilities: dict[str, Any]
    explain_model: str
    explain_model_configured: str
    explain_model_fallback: str
    tag_model: str
    gen_model: str
    critic_model: str
    diagnose_model: str
    embed_model: str
    cloud_gen_model: Optional[str] = None


class SettingsEnvelopeOut(BaseModel):
    """Shared GET/PUT /api/settings envelope: both handlers return the same
    two-key shape built from ``settings_store`` + ``llm.provider_info()``."""

    model_config = ConfigDict(extra="allow")

    settings: SettingsValuesOut
    provider: SettingsProviderInfoOut


@router.get("", response_model=SettingsEnvelopeOut, response_model_exclude_unset=True)
def get_settings(session: Session = Depends(get_session)):
    """Effective model routing + provider status (no secrets)."""
    return {
        "settings": settings_store.effective_settings(),
        "provider": llm.provider_info(),
    }


@router.put("", response_model=SettingsEnvelopeOut, response_model_exclude_unset=True)
def put_settings(body: SettingsPatch, session: Session = Depends(get_session)):
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    try:
        effective = settings_store.update_settings(session, patch)
    except (settings_store.SettingsValidationError, ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"settings": effective, "provider": llm.provider_info()}
