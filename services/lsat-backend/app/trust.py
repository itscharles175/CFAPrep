"""Tutor OS release-trust manifest.

This module turns many small local-first safety signals into one auditable JSON
object. It is deliberately read-only unless ``persist`` or ``write_path`` is
requested by an explicit caller: the dashboard can inspect trust without
creating artifacts, while the release gate can persist a snapshot.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from sqlmodel import Session, select

from . import backup, config, content_health, doctor, jobs, llm, notebook_os, observability
from .models import BenchmarkRun, ScheduledTask, SchedulerRun, SourceRegistry, TrustSnapshot

TrustTier = Literal["dev", "release", "packaged"]

ROOT = config.BASE_DIR.parent
FRONTEND = ROOT / "frontend"
TAURI_CONF = FRONTEND / "src-tauri" / "tauri.conf.json"
OPENAPI_SNAPSHOT = FRONTEND / "openapi.json"
RELEASE_LOCAL_REPORT = ROOT / "dist" / "release_local_report.json"
PACKAGED_CONTRACTS = Path(getattr(sys, "_MEIPASS", config.BASE_DIR)) / "release_contracts"

REQUIRED_RELEASE_LOCAL_LABELS = (
    "backend compile",
    "backend route/import contract",
    "OpenAPI drift",
    "backend benchmark smoke",
    "query plan budget",
    "scheduler evidence smoke",
    "backend pytest",
    "backend doctor",
    "frontend lint",
    "frontend test",
    "frontend build",
)

PACKAGED_SMOKE_IN_PROGRESS_ENV = "LSATLAB_RELEASE_LOCAL_PACKAGED_SMOKE_IN_PROGRESS"

REQUIRED_OPENAPI_PATHS = (
    "/api/ready",
    "/api/observability/status",
    "/api/observability/runtime-evidence",
    "/api/observability/trust",
    "/api/observability/diagnostics",
    "/api/adaptivity/ability",
    "/api/adaptivity/next",
    "/api/adaptivity/plan",
    "/api/readiness",
    "/api/content/health",
    "/api/workspaces/default",
    "/api/evidence/capture",
    "/api/notebook/pages",
    "/api/notebook-sources",
    "/api/notebook-sources/import",
    "/api/notebook-capabilities",
    "/api/notebook-notes",
    "/api/notebook-export",
    "/api/notebook-chat/sessions",
    "/api/notebook-search",
    "/api/notebook-search/health",
    "/api/transformations",
    "/api/podcasts",
    "/api/activity",
    "/api/context-presets",
    "/api/rc/dashboard",
    "/api/observability/migrations/dry-run",
)


def build_release_trust_manifest(
    session: Session,
    *,
    tier: TrustTier = "dev",
    persist: bool = False,
    write_path: str | Path | None = None,
) -> dict[str, Any]:
    """Build the machine-readable ``release_trust.json`` payload."""
    tier = _normalize_tier(tier)
    generated_at = datetime.now(timezone.utc).isoformat()
    checks = {
        "release_local": _release_local_check(tier),
        "model_readiness": _model_readiness_check(tier),
        "backend_readiness": _backend_readiness_check(tier),
        "backup_integrity": _backup_check(tier),
        "migration_integrity": _migration_check(tier),
        "content_health": _content_check(session, tier),
        "openapi_snapshot": _openapi_snapshot_check(tier),
        "privacy_firewall": _privacy_check(session, tier),
        "knowledge_index": _knowledge_index_check(session, tier),
        "sidecar_status": _sidecar_check(tier),
        "runtime_evidence": _runtime_evidence_check(session, tier),
        "updater_placeholder_guard": _updater_check(tier),
        "scheduler": _scheduler_check(session, tier),
        "benchmarks": _benchmark_check(session, tier),
    }
    blockers = _messages(checks, "block")
    warnings = _messages(checks, "warn")
    status = "blocked" if blockers else "warning" if warnings else "ok"
    score = _score(checks)
    manifest: dict[str, Any] = {
        "schema": "lsatlab.release_trust.v1",
        "tier": tier,
        "status": status,
        "score": score,
        "generated_at": generated_at,
        "app_version": config.APP_VERSION,
        "environment": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "data_dir": str(config.DATA_DIR),
            "db_path": str(config.DB_PATH),
            "local_provider": config.LOCAL_PROVIDER,
            "offline_generation_provider": config.GEN_PROVIDER,
        },
        "checks": checks,
        "blockers": blockers,
        "warnings": warnings,
        "next_actions": _next_actions(checks),
    }
    if persist:
        row = TrustSnapshot(
            tier=tier,
            status=status,
            score=score,
            checks_json=checks,
            blockers_json=blockers,
            warnings_json=warnings,
            manifest_json=manifest,
        )
        session.add(row)
        session.commit()
        session.refresh(row)
        manifest["snapshot_id"] = row.id
    if write_path is not None:
        path = Path(write_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
        manifest["written_to"] = str(path)
    return manifest


def _normalize_tier(tier: str) -> TrustTier:
    if tier not in {"dev", "release", "packaged"}:
        return "dev"
    return tier  # type: ignore[return-value]


def _aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _env_flag(name: str) -> bool:
    return (os.getenv(name) or "").strip().lower() in {"1", "true", "yes", "on"}


def _check(
    *,
    status: str,
    summary: str,
    detail: dict[str, Any] | None = None,
    action: str | None = None,
) -> dict[str, Any]:
    return {
        "status": status,
        "summary": summary,
        "detail": detail or {},
        "action": action,
    }


def _backend_readiness_check(tier: TrustTier) -> dict[str, Any]:
    report = backup.integrity_report()
    ready = report.get("ready") is True
    status = "ok" if ready else "block"
    return _check(
        status=status,
        summary="database, schema, migrations, indexes, and pragmas are ready"
        if ready else "backend integrity report is not ready",
        detail={
            "report_status": report.get("status"),
            "errors": report.get("errors", []),
            "warnings": report.get("warnings", []),
            "pragma_user_version": (report.get("pragmas") or {})
            .get("actual", {})
            .get("user_version"),
            "tier": tier,
        },
        action=None if ready else "Open Settings > Diagnostics and restore or repair the local DB.",
    )


def _backup_check(tier: TrustTier) -> dict[str, Any]:
    status = backup.backup_status()
    ok = bool(status.get("ok"))
    if ok:
        level = "ok"
    elif tier == "dev":
        level = "warn"
    else:
        level = "block"
    return _check(
        status=level,
        summary="local backup is fresh" if ok else "local backup is missing or stale",
        detail=status,
        action=None if ok else "Create a fresh local backup before release work.",
    )


def _migration_check(tier: TrustTier) -> dict[str, Any]:
    report = backup.migration_report()
    ok = (
        report.get("ok") is True
        and not report.get("failed")
        and not report.get("running")
        and not report.get("checksum_mismatches")
        and not report.get("missing")
    )
    latest = report.get("latest_expected_version")
    user_version = (backup.pragma_report().get("actual") or {}).get("user_version")
    user_version_ok = user_version in (None, 0) or latest is None or int(user_version) >= int(latest)
    level = "ok" if ok and user_version_ok else "block"
    return _check(
        status=level,
        summary="migration checksums and user_version are aligned"
        if level == "ok" else "migration state is dirty, incomplete, or stale",
        detail={
            "latest_expected_version": latest,
            "latest_applied_version": report.get("latest_applied_version"),
            "user_version": user_version,
            "failed": report.get("failed", []),
            "running": report.get("running", []),
            "checksum_mismatches": report.get("checksum_mismatches", []),
            "missing": report.get("missing", []),
            "tier": tier,
        },
        action=None if level == "ok" else "Run migrations on a backed-up DB and inspect checksum drift.",
    )


def _release_local_check(tier: TrustTier) -> dict[str, Any]:
    report = _first_existing(_release_report_candidates())
    if report is None:
        level = "block" if tier in {"release", "packaged"} else "warn"
        return _check(
            status=level,
            summary="release:local report is missing",
            detail={"candidate_paths": [str(path) for path in _release_report_candidates()]},
            action="Run `uv run python scripts/release_local.py` before promotion.",
        )
    try:
        payload = json.loads(report.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return _check(
            status="block" if tier in {"release", "packaged"} else "warn",
            summary="release:local report cannot be read",
            detail={"path": str(report), "error": str(exc)},
            action="Re-run the local release gate to regenerate release evidence.",
        )

    checks = payload.get("checks") if isinstance(payload, dict) else None
    if not isinstance(checks, list):
        return _check(
            status="block" if tier in {"release", "packaged"} else "warn",
            summary="release:local report has an invalid shape",
            detail={"path": str(report), "schema": payload.get("schema") if isinstance(payload, dict) else None},
            action="Re-run the local release gate to regenerate release evidence.",
        )
    by_label = {
        str(item.get("label")): item
        for item in checks
        if isinstance(item, dict) and item.get("label")
    }
    options = payload.get("options") if isinstance(payload.get("options"), dict) else {}
    packaged_smoke_in_progress = tier == "packaged" and _env_flag(
        PACKAGED_SMOKE_IN_PROGRESS_ENV
    )
    required_labels = list(REQUIRED_RELEASE_LOCAL_LABELS)
    if not bool(options.get("skip_e2e")):
        required_labels.append("frontend playwright e2e")
    if not bool(options.get("skip_tauri")):
        if not bool(options.get("skip_sidecar_build")):
            required_labels.append("backend sidecar build")
        required_labels.append("tauri build")
        if not bool(options.get("skip_packaged_smoke")) and not packaged_smoke_in_progress:
            required_labels.append("packaged app smoke")
    missing = [label for label in required_labels if label not in by_label]
    failed = [
        {
            "label": str(item.get("label")),
            "status": item.get("status"),
            "exit_code": item.get("exit_code"),
        }
        for item in checks
        if isinstance(item, dict) and item.get("status") != "passed"
    ]
    skipped = [
        name
        for name in ("skip_e2e", "skip_tauri", "skip_sidecar_build", "skip_packaged_smoke")
        if bool(options.get(name))
    ]
    generated_at = _parse_timestamp(str(payload.get("generated_at") or ""))
    age_seconds = None
    stale = False
    if generated_at is not None:
        age_seconds = max(
            0.0,
            (datetime.now(timezone.utc) - generated_at).total_seconds(),
        )
        stale_after = 6 * 3600 if tier == "packaged" else 24 * 3600
        stale = age_seconds > stale_after

    status = str(payload.get("status") or "unknown")
    git = payload.get("git") if isinstance(payload.get("git"), dict) else {}
    freshness_contract = _release_freshness_contract(
        git=git,
        stale=stale,
        skipped=skipped,
        missing=missing,
        failed=failed,
        report_status=status,
    )
    blocking = status != "passed" or bool(missing or failed) or bool(
        freshness_contract["blocking_status_lines"]
        or freshness_contract["head_mismatch"]
    )
    # At release/packaged tiers a release-critical SKIP is a BLOCKER, not a
    # warning: a release-tier "ok" emitted while the packaged smoke / tauri build
    # / e2e were skipped would let the gate self-certify a build it never actually
    # exercised. Lower tiers (dev/canary) keep skips at warn for fast iteration.
    skipped_blocks = bool(skipped) and tier in {"release", "packaged"}
    if blocking or skipped_blocks:
        level = "block" if tier in {"release", "packaged"} else "warn"
    elif stale or skipped:
        level = "warn"
    else:
        level = "ok"
    return _check(
        status=level,
        summary="release:local gate evidence is current and complete"
        if level == "ok" else "release:local gate evidence is missing, stale, partial, or failed",
        detail={
            "path": str(report),
            "report_status": status,
            "generated_at": payload.get("generated_at"),
            "age_seconds": round(age_seconds, 1) if age_seconds is not None else None,
            "stale": stale,
            "missing_required_labels": missing,
            "failed_checks": failed,
            "skipped": skipped,
            "packaged_smoke_in_progress": packaged_smoke_in_progress,
            "summary": payload.get("summary") or {},
            "git": git,
            "freshness_contract": freshness_contract,
            "tier": tier,
        },
        action=None if level == "ok" else "Run the full local release gate without skips before calling the build production-ready.",
    )


def _release_freshness_contract(
    *,
    git: dict[str, Any],
    stale: bool,
    skipped: list[str],
    missing: list[str],
    failed: list[dict[str, Any]],
    report_status: str,
) -> dict[str, Any]:
    status_lines = [
        str(line)
        for line in git.get("status_lines", [])
        if str(line).strip()
    ]
    live_status_lines = _current_git_status_lines()
    combined_status_lines = list(dict.fromkeys([*status_lines, *live_status_lines]))
    ignored_status_lines = [
        line for line in combined_status_lines if _ignored_release_status_line(line)
    ]
    blocking_status_lines = [
        line for line in combined_status_lines if line not in ignored_status_lines
    ]
    report_head = str(git.get("head") or "")
    live_head = _current_git_head()
    head_mismatch = bool(report_head and live_head and report_head != live_head)
    ready = (
        report_status == "passed"
        and not stale
        and not skipped
        and not missing
        and not failed
        and not blocking_status_lines
        and not head_mismatch
    )
    reasons: list[str] = []
    if report_status != "passed":
        reasons.append("release_local_not_passed")
    if stale:
        reasons.append("release_local_stale")
    if skipped:
        reasons.append("release_local_had_skips")
    if missing:
        reasons.append("release_local_missing_required_checks")
    if failed:
        reasons.append("release_local_failed_checks")
    if blocking_status_lines:
        reasons.append("working_tree_has_blocking_changes")
    if head_mismatch:
        reasons.append("release_local_head_mismatch")
    return {
        "ready": ready,
        "reasons": reasons,
        "report_head": report_head or None,
        "live_head": live_head or None,
        "head_mismatch": head_mismatch,
        "branch": git.get("branch"),
        "dirty": bool(git.get("dirty") or combined_status_lines),
        "report_status_lines": status_lines,
        "live_status_lines": live_status_lines,
        "status_lines": combined_status_lines,
        "ignored_status_lines": ignored_status_lines,
        "blocking_status_lines": blocking_status_lines,
        "ignored_policy": [
            "AGENTS.md and CLAUDE.md are generated policy files intentionally left untracked in this wave"
        ],
    }


def _ignored_release_status_line(line: str) -> bool:
    text = line.strip()
    return text in {"?? AGENTS.md", "?? CLAUDE.md"}


def _current_git_head() -> str | None:
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout.strip() or None


def _current_git_status_lines() -> list[str]:
    try:
        proc = subprocess.run(
            ["git", "status", "--short"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if proc.returncode != 0:
        return []
    return [line for line in proc.stdout.splitlines()[:200] if line.strip()]


def _runtime_evidence_check(session: Session, tier: TrustTier) -> dict[str, Any]:
    summary = observability.runtime_evidence_summary(session)
    if summary["ok"]:
        level = "ok" if not summary["recent_error_count"] else "warn"
    else:
        level = "block" if tier == "packaged" else "warn"
    if level == "ok":
        text = "local runtime logs and metrics are observable"
    elif summary["ok"]:
        text = "local runtime evidence has recent errors to inspect"
    else:
        text = "local runtime evidence is missing or unreadable"
    return _check(
        status=level,
        summary=text,
        detail={
            "log_dir": summary["log_dir"],
            "log_dir_exists": summary["log_dir_exists"],
            "log_dir_writable": summary["log_dir_writable"],
            "log_file_count": summary["log_file_count"],
            "log_files": summary["log_files"][:5],
            "recent_error_count": summary["recent_error_count"],
            "stale_error_count": summary.get("stale_error_count", 0),
            "recent_error_window_hours": summary.get("recent_error_window_hours"),
            "last_request_error": summary["last_request_error"],
            "metrics": summary["metrics"],
            "crash_free_window": summary["crash_free_window"],
            "tier": tier,
        },
        action=None if level == "ok" else "Open Settings > Diagnostics, export logs, and inspect the latest runtime error evidence.",
    )


def _model_readiness_check(tier: TrustTier) -> dict[str, Any]:
    """Trust-tier view of local model availability.

    ``doctor`` already performs the live Ollama/LM Studio probe. The trust
    manifest makes that signal release-visible: missing core realtime/generation
    models block promotion, while degraded-but-fallback-capable features such as
    missing embeddings stay warning-level.
    """
    try:
        report = doctor.build_report(include_ai=True)
    except Exception as exc:  # pragma: no cover - defensive release evidence
        return _check(
            status="warn" if tier == "dev" else "block",
            summary="local model readiness could not be probed",
            detail={"error": str(exc), "tier": tier},
            action="Start the configured local model provider and re-run diagnostics.",
        )

    ai_report = report.get("ai") if isinstance(report.get("ai"), dict) else {}
    available = ai_report.get("model_available") or {}
    expected = ai_report.get("expected_models") or {}
    explain_ready = bool(available.get("explain") or available.get("explain_fallback"))
    required_missing: list[str] = []
    # Provider-agnostic reachability: prefer the new ``provider_reachable`` field,
    # falling back to the legacy ``ollama_reachable`` only for an older report.
    # Without this a reachable LM Studio would add "provider" to required_missing
    # and BLOCK release promotion at non-dev tiers even though AI is fully up.
    provider_reachable = ai_report.get("provider_reachable")
    if provider_reachable is None:
        provider_reachable = bool(ai_report.get("ollama_reachable"))
    if not provider_reachable:
        required_missing.append("provider")
    if not explain_ready:
        required_missing.append("explain")
    for role in ("diagnose", "generation"):
        if not available.get(role):
            required_missing.append(role)

    degraded_missing: list[str] = []
    if not available.get("embedding"):
        degraded_missing.append("embedding")
    if not available.get("explain") and available.get("explain_fallback"):
        degraded_missing.append("preferred_explain")

    if required_missing:
        level = "warn" if tier == "dev" else "block"
    elif degraded_missing:
        level = "warn"
    else:
        level = "ok"
    return _check(
        status=level,
        summary="local realtime, generation, and retrieval models are available"
        if level == "ok" else "local model environment is incomplete or degraded",
        detail={
            "ready": ai_report.get("ready"),
            "provider": ai_report.get("provider"),
            "realtime_provider": ai_report.get("realtime_provider"),
            "provider_reachable": provider_reachable,
            "ollama_reachable": ai_report.get("ollama_reachable"),
            "models": ai_report.get("models") or [],
            "expected_models": expected,
            "model_available": available,
            "required_missing": required_missing,
            "degraded_missing": degraded_missing,
            "doctor_warnings": report.get("warnings") or [],
            "tier": tier,
        },
        action=None
        if level == "ok"
        else "Install/start the configured local models, or change Settings to models available on this machine.",
    )


def _content_check(session: Session, tier: TrustTier) -> dict[str, Any]:
    report = content_health.health_report(session)
    firewall_ok = bool((report.get("official_firewall") or {}).get("ok"))
    score = int(report.get("score") or 0)
    if not firewall_ok:
        level = "block"
    elif score < 70 and tier != "dev":
        level = "block"
    elif report.get("warnings"):
        level = "warn"
    else:
        level = "ok"
    return _check(
        status=level,
        summary="content firewall and validator health are acceptable"
        if level == "ok" else "content health needs attention",
        detail={
            "score": score,
            "warnings": report.get("warnings", []),
            "official_firewall": report.get("official_firewall"),
            "index_health": report.get("index_health"),
            "validator_coverage": report.get("validator_coverage"),
            "revalidation": report.get("revalidation"),
            "quarantine": report.get("quarantine"),
        },
        action=None if level == "ok" else "Review content health, quarantine, validators, and official firewall rows.",
    )


def _openapi_snapshot_check(tier: TrustTier) -> dict[str, Any]:
    snapshot = _first_existing(_openapi_snapshot_candidates())
    if snapshot is None:
        return _check(
            status="warn" if tier == "dev" else "block",
            summary="committed OpenAPI snapshot is missing",
            detail={"candidate_paths": [str(path) for path in _openapi_snapshot_candidates()]},
            action="Run npm run gen:api and commit the generated contract.",
        )
    try:
        spec = json.loads(snapshot.read_text(encoding="utf-8"))
        paths = set((spec.get("paths") or {}).keys())
    except (OSError, json.JSONDecodeError) as exc:
        return _check(
            status="warn" if tier == "dev" else "block",
            summary="committed OpenAPI snapshot cannot be read",
            detail={"path": str(snapshot), "error": str(exc)},
            action="Regenerate frontend/openapi.json.",
        )
    missing = [p for p in REQUIRED_OPENAPI_PATHS if p not in paths]
    level = "ok" if not missing else ("warn" if tier == "dev" else "block")
    return _check(
        status=level,
        summary="committed OpenAPI snapshot includes Tutor OS contracts"
        if not missing else "committed OpenAPI snapshot is missing Tutor OS contracts",
        detail={"path": str(snapshot), "missing_paths": missing},
        action=None if not missing else "Run npm run gen:api and check for drift.",
    )


def _privacy_check(session: Session, tier: TrustTier) -> dict[str, Any]:
    content = content_health.health_report(session)
    firewall_ok = bool((content.get("official_firewall") or {}).get("ok"))
    cloud_enabled = llm.cloud_enabled()
    cloud_generation_opt_in = (
        config.GEN_PROVIDER == "cloud" and bool(config.CLOUD_API_KEY)
    )
    budgeted = config.CLOUD_MONTHLY_BUDGET_USD > 0
    warnings: list[str] = []
    if cloud_generation_opt_in and not budgeted:
        warnings.append("cloud_generation_has_no_budget")
    if config.LOCAL_PROVIDER not in {"ollama", "lmstudio"}:
        warnings.append("unknown_local_provider")
    block = not firewall_ok
    return _check(
        status="block" if block else "warn" if warnings else "ok",
        summary="realtime tutoring and score evidence remain local-first"
        if not block else "official-content firewall is unsafe",
        detail={
            "official_firewall_ok": firewall_ok,
            "local_provider": config.LOCAL_PROVIDER,
            "generation_provider": config.GEN_PROVIDER,
            "cloud_enabled": cloud_enabled,
            "cloud_generation_opt_in": cloud_generation_opt_in,
            "cloud_monthly_budget_usd": config.CLOUD_MONTHLY_BUDGET_USD,
            "warnings": warnings,
            "tier": tier,
        },
        action=None if not block and not warnings else "Keep cloud generation opt-in, budgeted, and segregated from score prediction.",
    )


def _knowledge_index_check(session: Session, tier: TrustTier) -> dict[str, Any]:
    report = notebook_os.knowledge_index_health(session)
    status = str(report.get("status") or "error")
    detail = report.get("detail") if isinstance(report.get("detail"), dict) else {}
    if status == "ok":
        level = "ok"
    elif detail.get("official_body_leak_ids"):
        level = "block"
    elif tier == "dev":
        level = "warn"
    else:
        level = "block"
    return _check(
        status=level,
        summary="Notebook OS search index is available and firewall-safe"
        if level == "ok" else "Notebook OS search index is missing, stale, or unsafe",
        detail={**detail, "tier": tier},
        action=None if level == "ok" else "Re-run migrations or rebuild the Notebook OS knowledge index before release.",
    )


def _sidecar_check(tier: TrustTier) -> dict[str, Any]:
    conf = _tauri_conf()
    external_bins = (
        ((conf.get("bundle") or {}).get("externalBin") or [])
        if isinstance(conf, dict) else []
    )
    candidates = _sidecar_binary_candidates(external_bins)
    binary_present = any(path.exists() for path in candidates)
    worker = jobs.get_worker()
    thread = worker._thread
    alive = thread is not None and thread.is_alive()
    missing_binary = bool(external_bins) and not binary_present
    level = "ok"
    if missing_binary:
        level = "warn" if tier != "packaged" else "block"
    return _check(
        status=level,
        summary="sidecar configuration is observable"
        if level == "ok" else "packaged sidecar binary is not present in the bundle path",
        detail={
            "external_bin": external_bins,
            "binary_present": binary_present,
            "candidate_paths": [str(path) for path in candidates],
            "worker_alive": alive,
            "worker_enabled": config.JOBS_WORKER_ENABLED,
        },
        action=None if level == "ok" else "Build the backend sidecar before packaged release smoke.",
    )


def _updater_check(tier: TrustTier) -> dict[str, Any]:
    conf = _tauri_conf()
    updater = ((conf.get("plugins") or {}).get("updater") or {}) if isinstance(conf, dict) else {}
    active = bool(updater.get("active"))
    endpoints = updater.get("endpoints") or []
    pubkey = updater.get("pubkey") or ""
    placeholders = [
        value for value in [pubkey, *endpoints]
        if isinstance(value, str) and "PLACEHOLDER_TAURI_UPDATER" in value
    ]
    level = "ok"
    if active and placeholders:
        level = "warn" if tier == "dev" else "block"
    elif not active:
        summary = "updater is disabled until signing/channel config is real"
        action = None
    else:
        summary = "updater release channel is signed/configured"
        action = None
    return _check(
        status=level,
        summary=summary if level == "ok" else "updater still contains placeholder signing/channel config",
        detail={"active": active, "placeholder_count": len(placeholders)},
        action=action if level == "ok" else "Wire signed updater endpoint/pubkey or disable updater for non-dev builds.",
    )


def _sidecar_binary_candidates(external_bins: list[Any]) -> list[Path]:
    binaries_dir = FRONTEND / "src-tauri" / "binaries"
    candidates: list[Path] = []
    for entry in external_bins:
        if not isinstance(entry, str):
            continue
        base = Path(entry).name
        candidates.extend(
            [
                binaries_dir / f"{base}.exe",
                binaries_dir / base,
            ]
        )
        target = _rust_host_triple()
        if target:
            candidates.extend(
                [
                    binaries_dir / f"{base}-{target}.exe",
                    binaries_dir / f"{base}-{target}",
                ]
            )
        candidates.extend(sorted(binaries_dir.glob(f"{base}-*")))
        if getattr(sys, "frozen", False):
            exe = Path(sys.executable)
            frozen_target = _rust_host_triple()
            candidates.extend(
                [
                    exe,
                    exe.parent / f"{base}.exe",
                    exe.parent / base,
                ]
            )
            if frozen_target:
                candidates.append(exe.parent / f"{base}-{frozen_target}.exe")
    deduped: list[Path] = []
    seen: set[str] = set()
    for path in candidates:
        key = str(path)
        if key not in seen:
            seen.add(key)
            deduped.append(path)
    return deduped


def _rust_host_triple() -> str | None:
    try:
        proc = subprocess.run(
            ["rustc", "-vV"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    for line in proc.stdout.splitlines():
        if line.startswith("host:"):
            return line.split(":", 1)[1].strip() or None
    return None


def _scheduler_check(session: Session, tier: TrustTier) -> dict[str, Any]:
    summary = jobs.queue_summary(session)
    task_count = len(session.exec(select(SourceRegistry)).all())  # source ops seed signal
    scheduled_rows = session.exec(select(ScheduledTask)).all()
    by_key = {row.key: row for row in scheduled_rows}
    expected_keys = list(jobs.DEFAULT_SCHEDULE_KEYS)
    missing_keys = [key for key in expected_keys if key not in by_key]
    disabled_keys = [key for key in expected_keys if key in by_key and not by_key[key].enabled]
    latest_runs: dict[str, dict[str, Any] | None] = {}
    stale_success_keys: list[str] = []
    now = datetime.now(timezone.utc)
    for key in expected_keys:
        run = session.exec(
            select(SchedulerRun)
            .where(SchedulerRun.task_key == key)
            .order_by(SchedulerRun.created_at.desc())
        ).first()
        if run is None:
            latest_runs[key] = None
            stale_success_keys.append(key)
            continue
        age_seconds = max(0.0, (now - _aware_utc(run.created_at)).total_seconds())
        latest_runs[key] = {
            "id": run.id,
            "status": run.status,
            "created_at": run.created_at.isoformat(),
            "age_seconds": round(age_seconds, 1),
        }
        row = by_key.get(key)
        freshness_window = timedelta(seconds=max(3600, int((row.cadence_s if row else 86400) * 3)))
        if run.status != "ok" or now - _aware_utc(run.created_at) > freshness_window:
            stale_success_keys.append(key)
    missing_or_disabled = bool(missing_keys or disabled_keys)
    stale = bool(stale_success_keys)
    if missing_or_disabled:
        level = "warn" if tier == "dev" else "block"
    elif stale:
        level = "warn" if tier in {"dev", "release"} else "block"
    else:
        level = "ok"
    return _check(
        status=level,
        summary="scheduled maintenance registry and recent run evidence are healthy"
        if level == "ok" else "scheduled maintenance evidence is incomplete or stale",
        detail={
            "queue": summary,
            "scheduled_tasks": len(scheduled_rows),
            "expected_keys": expected_keys,
            "present_keys": sorted(by_key),
            "missing_keys": missing_keys,
            "disabled_keys": disabled_keys,
            "stale_success_keys": stale_success_keys,
            "latest_runs": latest_runs,
            "source_registry_rows": task_count,
            "tier": tier,
        },
        action=None if level == "ok" else "Run scheduled maintenance defaults and record fresh successful run evidence.",
    )


def _benchmark_check(session: Session, tier: TrustTier) -> dict[str, Any]:
    runs = session.exec(select(BenchmarkRun).order_by(BenchmarkRun.id.desc()).limit(20)).all()
    recent = runs[:5]
    required_quality_metrics = (
        "generation_quality_cases",
        "generation_quality_failed_cases",
        "generation_quality_clean_pass",
        "generation_quality_trap_metadata_rejected",
        "generation_quality_weak_distractor_rejected",
    )
    quality_run = None
    for run in runs:
        metrics = run.metrics_json or {}
        if all(key in metrics for key in required_quality_metrics):
            quality_run = run
            break
    quality_metrics = quality_run.metrics_json if quality_run else {}
    quality_ok = bool(
        quality_run
        and quality_run.status == "ok"
        and int(quality_metrics.get("generation_quality_cases") or 0) >= 3
        and int(quality_metrics.get("generation_quality_failed_cases") or 0) == 0
        and float(quality_metrics.get("generation_quality_clean_pass") or 0) >= 1.0
        and float(
            quality_metrics.get("generation_quality_trap_metadata_rejected") or 0
        ) >= 1.0
        and float(
            quality_metrics.get("generation_quality_weak_distractor_rejected") or 0
        ) >= 1.0
    )
    if tier != "dev" and not quality_ok:
        level = "block"
    elif runs:
        level = "ok" if quality_ok or tier == "dev" else "warn"
    else:
        level = "ok" if tier == "dev" else "warn"
    return _check(
        status=level,
        summary="recent benchmark and generation-quality evidence is present"
        if runs and quality_ok else "benchmark or generation-quality evidence is incomplete",
        detail={
            "recent": [
                {
                    "id": r.id,
                    "kind": r.kind,
                    "status": r.status,
                    "metrics": r.metrics_json,
                    "created_at": r.created_at.isoformat(),
                }
                for r in recent
            ],
            "generation_quality": {
                "present": quality_run is not None,
                "ok": quality_ok,
                "run_id": quality_run.id if quality_run else None,
                "status": quality_run.status if quality_run else None,
                "created_at": quality_run.created_at.isoformat() if quality_run else None,
                "required_metrics": list(required_quality_metrics),
                "metrics": {
                    key: quality_metrics.get(key)
                    for key in required_quality_metrics
                } if quality_run else {},
            },
        },
        action=None if level == "ok"
        else "Run benchmark smoke so release trust records passing generation-quality gate evidence.",
    )


def _tauri_conf() -> dict[str, Any]:
    conf = _first_existing(_tauri_conf_candidates())
    if conf is None:
        return {}
    try:
        return json.loads(conf.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _openapi_snapshot_candidates() -> list[Path]:
    return [
        OPENAPI_SNAPSHOT,
        PACKAGED_CONTRACTS / "openapi.json",
        config.BASE_DIR / "release_contracts" / "openapi.json",
    ]


def _tauri_conf_candidates() -> list[Path]:
    return [
        TAURI_CONF,
        PACKAGED_CONTRACTS / "tauri.conf.json",
        config.BASE_DIR / "release_contracts" / "tauri.conf.json",
    ]


def _release_report_candidates() -> list[Path]:
    candidates: list[Path] = []
    explicit = os.environ.get("LSATLAB_RELEASE_LOCAL_REPORT")
    if explicit:
        candidates.append(Path(explicit))
    candidates.extend(
        [
            RELEASE_LOCAL_REPORT,
            PACKAGED_CONTRACTS / "release_local_report.json",
            config.BASE_DIR / "release_contracts" / "release_local_report.json",
        ]
    )
    return candidates


def _parse_timestamp(value: str) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return _aware_utc(parsed)


def _first_existing(paths: list[Path]) -> Path | None:
    for path in paths:
        if path.exists():
            return path
    return None


def _messages(checks: dict[str, dict[str, Any]], status: str) -> list[dict[str, Any]]:
    return [
        {
            "check": key,
            "summary": value.get("summary"),
            "action": value.get("action"),
        }
        for key, value in checks.items()
        if value.get("status") == status
    ]


def _score(checks: dict[str, dict[str, Any]]) -> int:
    value = 100
    for check in checks.values():
        if check.get("status") == "block":
            value -= 18
        elif check.get("status") == "warn":
            value -= 7
    return max(0, value)


def _next_actions(checks: dict[str, dict[str, Any]]) -> list[str]:
    actions = [
        str(check["action"])
        for check in checks.values()
        if check.get("action")
    ]
    deduped: list[str] = []
    for action in actions:
        if action not in deduped:
            deduped.append(action)
    return deduped[:8]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tier", choices=["dev", "release", "packaged"], default="dev")
    parser.add_argument("--output", default="")
    parser.add_argument("--persist", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    from .db import engine, init_db

    init_db()
    with Session(engine) as session:
        jobs.ensure_default_schedules(session)
        manifest = build_release_trust_manifest(
            session,
            tier=args.tier,
            persist=args.persist,
            write_path=args.output or None,
        )
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 1 if args.check and manifest["status"] == "blocked" else 0


if __name__ == "__main__":
    raise SystemExit(main())
