"""Backend readiness doctor for local launch and release gates."""
from __future__ import annotations

import argparse
import asyncio
import json
from typing import Any

from sqlmodel import Session, select

from . import ai, backup, config, jobs, llm, observability
from .db import engine, init_db
from .models import GenJob, GenStatus


def _generation_queue_counts() -> tuple[int, int]:
    with Session(engine) as session:
        jobs_ = session.exec(select(GenJob)).all()
    return (
        sum(1 for j in jobs_ if j.status == GenStatus.queued),
        sum(1 for j in jobs_ if j.status == GenStatus.running),
    )


def _provider_capabilities_from_health(ai_health: dict[str, Any]) -> dict[str, Any]:
    capabilities = ai_health.get("capabilities")
    if isinstance(capabilities, dict):
        return capabilities
    realtime = (
        ai_health.get("provider")
        or ai_health.get("realtime_provider")
        or config.LOCAL_PROVIDER
    )
    offline = ai_health.get("offline_provider") or llm.offline_provider_name()
    return {
        "realtime": llm.provider_capabilities(realtime),
        "offline": llm.provider_capabilities(offline),
        "matrix": llm.provider_capability_matrix(),
    }


def build_report(*, include_ai: bool = True) -> dict[str, Any]:
    """Return the same launch-readiness facts used by the HTTP diagnostics."""
    init_db()
    gen_queued, gen_running = _generation_queue_counts()
    integrity = backup.integrity_report()
    readiness = observability.backend_readiness(
        integrity_report=integrity,
        gen_queued=gen_queued,
        gen_running=gen_running,
        require_worker=False,
    )
    ai_report: dict[str, Any] | None = None
    warnings = list(readiness["warnings"])
    if include_ai:
        ai_health = asyncio.run(ai.health())
        model_names = set(ai_health.get("models") or [])
        expected_models = {
            "explain": config.EXPLAIN_MODEL,
            "explain_fallback": config.EXPLAIN_FALLBACK_MODEL,
            "diagnose": config.DIAGNOSE_MODEL,
            "generation": config.GEN_MODEL,
            "embedding": config.EMBED_MODEL,
        }
        model_available = {
            role: bool(
                name in model_names
                or name.split(":", 1)[0] in model_names
                or any(m.startswith(f"{name.split(':', 1)[0]}:") for m in model_names)
            )
            for role, name in expected_models.items()
        }
        explain_ready = (
            model_available["explain"] or model_available["explain_fallback"]
        )
        # Provider-agnostic reachability: prefer the generic ``ok`` (the active
        # local provider is reachable), falling back to the legacy ``ollama``
        # boolean only for an older health payload. Keying readiness off ``ok``
        # (not the Ollama-specific flag, which health() forces False for any
        # non-Ollama provider) is what lets a healthy LM Studio pass the gate.
        provider_reachable = bool(ai_health.get("ok", ai_health.get("ollama")))
        active_provider = (
            ai_health.get("provider")
            or ai_health.get("realtime_provider")
            or "ollama"
        )
        capabilities = _provider_capabilities_from_health(ai_health)
        ai_ready = (
            provider_reachable
            and explain_ready
            and model_available["diagnose"]
            and model_available["generation"]
        )
        if not ai_ready:
            warnings.append("ai_not_ready")
        if not provider_reachable:
            # Name the ACTIVE provider so the warning is correct under LM Studio
            # ("ollama_unreachable" is preserved when Ollama is the provider).
            warnings.append(f"{active_provider}_unreachable")
        for role, available in model_available.items():
            if not available and not (
                role == "explain" and model_available["explain_fallback"]
            ):
                warnings.append(f"model_missing:{role}")
        ai_report = {
            "ready": ai_ready,
            "provider_reachable": provider_reachable,
            "ollama_reachable": bool(ai_health.get("ollama")),
            "models": ai_health.get("models") or [],
            "expected_models": expected_models,
            "model_available": model_available,
            "provider": ai_health.get("offline_provider"),
            "realtime_provider": ai_health.get("realtime_provider"),
            "capabilities": capabilities,
        }
    status = "ok" if readiness["ok"] and not warnings else (
        "warning" if readiness["ok"] else "error"
    )
    return {
        "ok": readiness["ok"],
        "status": status,
        "generated_at": readiness["generated_at"],
        "db": readiness["db"],
        "backup": readiness["backup"],
        "worker": readiness["worker"],
        "ai": ai_report,
        "errors": readiness["errors"],
        "warnings": warnings,
        "integrity_report": integrity,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Print LSATLab backend readiness.")
    parser.add_argument("--no-ai", action="store_true", help="Skip Ollama probes.")
    parser.add_argument(
        "--soft",
        action="store_true",
        help="Always exit 0 after printing the report.",
    )
    args = parser.parse_args(argv)
    observability.setup_logging()
    report = build_report(include_ai=not args.no_ai)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if args.soft or report["ok"] else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
