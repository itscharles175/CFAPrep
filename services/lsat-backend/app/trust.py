"""Tutor OS release-trust manifest.

This module turns many small local-first safety signals into one auditable JSON
object. It is deliberately read-only unless ``persist`` or ``write_path`` is
requested by an explicit caller: the dashboard can inspect trust without
creating artifacts, while the release gate can persist a snapshot.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from sqlmodel import Session, select

from . import backup, config, content_health, doctor, jobs, llm, notebook_os, observability
from .models import BenchmarkRun, ScheduledTask, SchedulerRun, SourceRegistry, TrustSnapshot

TrustTier = Literal["dev", "release", "packaged"]

ROOT = config.BASE_DIR.parent
REPO_ROOT = config.BASE_DIR.parent.parent
FRONTEND = ROOT / "frontend"
OPENAPI_SNAPSHOT = FRONTEND / "openapi.json"
RELEASE_LOCAL_REPORT = REPO_ROOT / "dist" / "release_local_report.json"
RELEASE_MANIFEST = REPO_ROOT / "dist" / "studyvault-release-manifest.json"
PACKAGED_CONTRACTS = Path(getattr(sys, "_MEIPASS", config.BASE_DIR)) / "release_contracts"
RELEASE_LOCAL_REPORT_SCHEMA = "lsatlab.release_local_report.v1"
RELEASE_MANIFEST_SCHEMA = "studyvault.release-manifest.v2"
SIGNING_EVIDENCE_SCHEMA = "studyvault.signing-evidence.v1"
PERSONAL_SIGNING_EVIDENCE_SCHEMA = "studyvault.personal-signing-evidence.v1"
SIDECAR_PROVENANCE_SCHEMA = "studyvault.sidecar-provenance.v1"
REQUIRED_SIDECAR_PROVENANCE_SERVICES = ("LSAT backend",)

REQUIRED_RELEASE_LOCAL_LABELS = (
    "backend compile",
    "backend route/import contract",
    "OpenAPI drift",
    "backend benchmark smoke",
    "query plan budget",
    "scheduler evidence smoke",
    "generation quality regression floor",
    "explanation golden floor",
    "prompt regression fixture floor",
    "rag retrieval-eval floor",
    "citation faithfulness floor",
    "source-grounded answer benchmark floor",
    "generated content gate floor",
    "backend pytest",
    "backend doctor",
    "frontend lint",
    "frontend test",
    "frontend build",
    "version sync",
    "frontend typecheck",
    "lsat typecheck",
    "lsat test",
    "host mutation score gate",
    "backend mutation score gate",
    "bundle report",
    "route performance budget gate",
    "content validation",
    "no-egress gate",
    "direct sidecar fetch inventory gate",
    "docs-drift gate",
    "baseline catalog gate",
    "vault archive restore drill",
    "dependency audit",
)

PACKAGED_SMOKE_IN_PROGRESS_ENV = "LSATLAB_RELEASE_LOCAL_PACKAGED_SMOKE_IN_PROGRESS"
TRUST_TIER_ENV = "STUDYVAULT_TRUST_TIER"

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
        "release_manifest": _release_manifest_check(tier),
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


# --- BC4: cached lightweight trust status -----------------------------------
# A cheap subset of the full manifest (content_health + privacy_firewall +
# model_readiness only) for a live "is the app trustworthy right now?" strip.
# It deliberately skips the release-gate checks (release:local report, OpenAPI
# snapshot, sidecar/updater config, scheduler/benchmark evidence) that are slow,
# release-only, or shell out to git/rustc. Cached ~1h because the model-readiness
# probe hits the local provider; the cache is process-local and resets on
# restart, mirroring the other RAM gauges in observability.py.
_TRUST_STATUS_TTL_SECONDS = 3600
_trust_status_cache: tuple[float, dict[str, Any]] | None = None
_trust_status_lock = threading.Lock()

# block > warn > ok — the worst child status wins for the rollup. ``_STATUS_BY_RANK``
# maps that worst rank back to the public ok|warning|blocked label.
_STATUS_RANK = {"ok": 0, "warn": 1, "block": 2}
_STATUS_BY_RANK = {0: "ok", 1: "warning", 2: "blocked"}


def trust_status(
    session: Session,
    *,
    tier: TrustTier = "dev",
    force_refresh: bool = False,
) -> dict[str, Any]:
    """BC4 — lightweight, cached trust status for the Settings trust strip.

    Runs only ``content_health``, ``privacy_firewall``, and ``model_readiness``
    (NOT the full release manifest) and rolls their statuses up into a single
    ``ok`` | ``warning`` | ``blocked`` verdict. Cached for ~1h (process-local) so
    the model-readiness probe of the local provider is not repeated on every
    poll. Pass ``force_refresh=True`` to bypass the cache.
    """
    global _trust_status_cache
    tier = _normalize_tier(tier)
    now = time.monotonic()
    with _trust_status_lock:
        cached = _trust_status_cache
        if (
            not force_refresh
            and cached is not None
            and now - cached[0] < _TRUST_STATUS_TTL_SECONDS
        ):
            return cached[1]

    checks = {
        "content_health": _content_check(session, tier),
        "privacy_firewall": _privacy_check(session, tier),
        "model_readiness": _model_readiness_check(tier),
    }
    worst = max(
        (_STATUS_RANK.get(c.get("status", "ok"), 0) for c in checks.values()),
        default=0,
    )
    status = _STATUS_BY_RANK[worst]
    payload = {
        "status": status,
        "tier": tier,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "cache_ttl_seconds": _TRUST_STATUS_TTL_SECONDS,
        "checks": checks,
    }
    with _trust_status_lock:
        _trust_status_cache = (now, payload)
    return payload


def _default_tier() -> TrustTier:
    """Tier a caller falls back to when it does not (or must not) pin one.

    Every shipped UI surface asks for ``dev``, where the strict gates — signing
    evidence above all — are skipped outright. Deriving the floor from
    ``sys.frozen`` means a packaged sidecar evaluates the release-grade path for
    real users; ``STUDYVAULT_TRUST_TIER`` is the explicit development override.
    """
    override = (os.getenv(TRUST_TIER_ENV) or "").strip().lower()
    if override in {"dev", "release", "packaged"}:
        return override  # type: ignore[return-value]
    return "packaged" if getattr(sys, "frozen", False) else "dev"


def _normalize_tier(tier: str) -> TrustTier:
    default = _default_tier()
    if tier not in {"dev", "release", "packaged"}:
        return default
    # A packaged build must not be able to self-downgrade into the lenient dev
    # path just because the requesting surface asked for it.
    if tier == "dev" and default != "dev":
        return default
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
            action="Run `python scripts/release_local.py` from the repository root before promotion.",
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

    if not isinstance(payload, dict) or payload.get("schema") != RELEASE_LOCAL_REPORT_SCHEMA:
        return _check(
            status="block" if tier in {"release", "packaged"} else "warn",
            summary="release:local report has an invalid schema",
            detail={"path": str(report), "schema": payload.get("schema") if isinstance(payload, dict) else None},
            action="Re-run the local release gate to regenerate release evidence.",
        )

    checks = payload.get("checks")
    if not isinstance(checks, list):
        return _check(
            status="block" if tier in {"release", "packaged"} else "warn",
            summary="release:local report has an invalid shape",
            detail={"path": str(report), "schema": payload.get("schema")},
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
    if not bool(options.get("skip_electron")):
        if not bool(options.get("skip_sidecar_build")):
            required_labels.append("backend sidecar build")
        required_labels.append("electron build")
        if not bool(options.get("skip_packaged_smoke")) and not packaged_smoke_in_progress:
            required_labels.append("packaged app smoke")
        if not packaged_smoke_in_progress:
            required_labels.append("release manifest/SBOM")
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
        for name in ("skip_e2e", "skip_electron", "skip_sidecar_build", "skip_packaged_smoke")
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
    blocking = status != "passed" or stale or bool(missing or failed) or bool(
        freshness_contract["blocking_status_lines"]
        or freshness_contract["head_mismatch"]
    )
    # At release/packaged tiers a release-critical SKIP is a BLOCKER, not a
    # warning: a release-tier "ok" emitted while the packaged smoke / Electron build
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


def _release_manifest_check(tier: TrustTier) -> dict[str, Any]:
    strict = tier in {"release", "packaged"}
    path = _first_existing(_release_manifest_candidates())
    if path is None:
        level = "block" if strict else "warn"
        return _check(
            status=level,
            summary="release manifest/SBOM evidence is missing",
            detail={"candidate_paths": [str(p) for p in _release_manifest_candidates()]},
            action="Run `node scripts/release-manifest.mjs write --require-assets --require-sidecar-provenance` after building the Electron bundle.",
        )
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return _check(
            status="block" if strict else "warn",
            summary="release manifest/SBOM evidence cannot be read",
            detail={"path": str(path), "error": str(exc)},
            action="Regenerate the release manifest after the Electron bundle is built.",
        )

    errors: list[str] = []
    if not isinstance(payload, dict) or payload.get("schema") != RELEASE_MANIFEST_SCHEMA:
        errors.append("invalid_schema")
    versions = payload.get("versions") if isinstance(payload.get("versions"), dict) else {}
    if versions.get("consistent") is not True:
        errors.append("version_mismatch")
    lockfiles = payload.get("lockfiles") if isinstance(payload.get("lockfiles"), list) else []
    missing_inputs = [
        item.get("path")
        for item in lockfiles
        if isinstance(item, dict)
        and item.get("required") is True
        and not (item.get("present") is True and item.get("sha256") and int(item.get("size") or 0) > 0)
    ]
    if missing_inputs:
        errors.append("required_inputs_missing")
    sbom = payload.get("sbom") if isinstance(payload.get("sbom"), dict) else {}
    counts = sbom.get("counts") if isinstance(sbom.get("counts"), dict) else {}
    component_counts = {name: int(counts.get(name) or 0) for name in ("npm", "pypi")}
    if any(value <= 0 for value in component_counts.values()):
        errors.append("sbom_component_gap")

    sidecar = payload.get("sidecarProvenance") if isinstance(payload.get("sidecarProvenance"), dict) else {}
    sidecar_entries = sidecar.get("entries") if isinstance(sidecar.get("entries"), list) else []
    has_lsat_sidecar = any(
        isinstance(entry, dict) and entry.get("service") == "LSAT backend"
        for entry in sidecar_entries
    )
    if strict and (sidecar.get("present") is not True or not has_lsat_sidecar):
        errors.append("sidecar_provenance_missing")

    assets = payload.get("bundleAssets") if isinstance(payload.get("bundleAssets"), list) else []
    if strict and not assets:
        errors.append("bundle_assets_missing")

    signing = payload.get("signing") if isinstance(payload.get("signing"), dict) else {}
    if strict:
        errors.extend(_signing_evidence_errors(signing, assets))

    recorded_sha = str(payload.get("manifestSha256") or "")
    actual_sha = _sha256_file(path)
    if recorded_sha and recorded_sha != actual_sha:
        errors.append("manifest_digest_mismatch")

    if errors:
        level = "block" if strict else "warn"
    else:
        level = "ok"
    return _check(
        status=level,
        summary="release manifest/SBOM evidence is present and complete"
        if level == "ok" else "release manifest/SBOM evidence is missing or incomplete",
        detail={
            "path": str(path),
            "schema": payload.get("schema") if isinstance(payload, dict) else None,
            "sha256": actual_sha,
            "errors": errors,
            "missing_inputs": missing_inputs,
            "component_counts": component_counts,
            "bundle_asset_count": len(assets),
            "sidecar_provenance_present": sidecar.get("present") is True,
            "has_lsat_sidecar": has_lsat_sidecar,
            "signing": signing,
            "tier": tier,
        },
        action=None
        if level == "ok"
        else "Regenerate the release manifest after building sidecars, Electron bundles, and verified platform-signing evidence.",
    )


def _current_signing_platform() -> str:
    name = platform.system().lower()
    if name == "windows":
        return "windows"
    if name == "darwin":
        return "macos"
    return "linux"


def _evidence_int(value: Any, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


def _signing_directory_digest(assets: list[dict[str, Any]], directory_path: str) -> tuple[str, int] | None:
    prefix = f"{directory_path.rstrip('/')}/"
    children = sorted(
        (
            item for item in assets
            if isinstance(item, dict) and str(item.get("path") or "").startswith(prefix)
        ),
        key=lambda item: str(item.get("path") or ""),
    )
    if not children:
        return None
    digest = hashlib.sha256()
    total_size = 0
    for child in children:
        relative_path = str(child.get("path") or "")[len(prefix):]
        child_hash = str(child.get("sha256") or "")
        child_size = _evidence_int(child.get("size"), -1)
        if child_size < 0:
            return None
        digest.update(f"{relative_path}\0{child_hash}\0{child_size}\n".encode())
        total_size += child_size
    return digest.hexdigest(), total_size


def _signing_asset_binding_errors(
    platform_name: str,
    artifacts: list[dict[str, Any]],
    assets: list[dict[str, Any]],
) -> list[str]:
    errors: list[str] = []
    if not assets:
        return errors
    asset_paths = [str(item.get("path") or "") if isinstance(item, dict) else "" for item in assets]
    if any(not path for path in asset_paths) or len(set(asset_paths)) != len(asset_paths):
        errors.append("bundle_asset_paths_invalid")
    exact_assets = {
        str(item.get("path") or ""): item
        for item in assets
        if isinstance(item, dict) and item.get("path")
    }
    published = [item for item in artifacts if item.get("published") is True]
    for artifact in published:
        if platform_name == "macos" and artifact.get("kind") == "app":
            bound = _signing_directory_digest(assets, str(artifact.get("path") or ""))
            if bound is None:
                errors.append("signing_asset_binding_missing")
                continue
            actual_hash, actual_size = bound
        else:
            asset = exact_assets.get(str(artifact.get("path") or ""))
            if asset is None:
                errors.append("signing_asset_binding_missing")
                continue
            actual_hash = str(asset.get("sha256") or "")
            actual_size = _evidence_int(asset.get("size"), -1)
        expected_size = _evidence_int(artifact.get("size"), -2)
        if actual_hash != str(artifact.get("sha256") or "") or actual_size != expected_size:
            errors.append("signing_asset_digest_mismatch")

    for asset in assets:
        if not isinstance(asset, dict):
            continue
        path = str(asset.get("path") or "")
        if platform_name == "windows":
            normalized = path.replace("\\", "/")
            required = path.endswith(".msi") or (
                normalized.startswith("release/")
                and "/" not in normalized[len("release/"):]
                and normalized.endswith(".exe")
            )
            covered = any(item.get("published") is True and item.get("path") == path for item in artifacts)
        else:
            required = path.endswith(".dmg") or ".app/" in path
            app = next(
                (item for item in artifacts if item.get("kind") == "app" and item.get("published") is True),
                None,
            )
            covered = any(item.get("published") is True and item.get("path") == path for item in artifacts) or bool(
                app and path.startswith(f"{app.get('path')}/")
            )
        if required and not covered:
            errors.append("bundle_asset_signing_evidence_missing")
    return list(dict.fromkeys(errors))


def _signing_evidence_errors(signing: dict[str, Any], assets: list[dict[str, Any]]) -> list[str]:
    if signing.get("schema") == PERSONAL_SIGNING_EVIDENCE_SCHEMA:
        artifacts = signing.get("artifacts") if isinstance(signing.get("artifacts"), list) else []
        errors: list[str] = []
        if _current_signing_platform() != "macos":
            errors.append("signing_platform_mismatch")
        if signing.get("platform") != "macos" or signing.get("releaseTier") != "personal":
            errors.append("personal_signing_policy_invalid")
        if signing.get("required") is not True or signing.get("status") != "verified":
            errors.append("platform_signature_unverified")
        if (
            signing.get("identity") != "adhoc"
            or signing.get("strictDeepVerification") is not True
            or signing.get("developerId") is not False
            or signing.get("notarized") is not False
        ):
            errors.append("personal_signing_policy_invalid")
        if len(artifacts) != 1:
            errors.append("personal_signing_artifacts_invalid")
        elif (
            not isinstance(artifacts[0], dict)
            or artifacts[0].get("kind") != "app"
            or artifacts[0].get("published") is not True
            or artifacts[0].get("signed") is not True
            or artifacts[0].get("verified") is not True
            or artifacts[0].get("identity") != "adhoc"
            or artifacts[0].get("developer_id") is not False
            or artifacts[0].get("notarized") is not False
            or artifacts[0].get("stapled") is not False
            or artifacts[0].get("timestamped") is not False
        ):
            errors.append("personal_signing_artifacts_invalid")
        artifact = artifacts[0] if len(artifacts) == 1 and isinstance(artifacts[0], dict) else None
        checksum = str(artifact.get("sha256") or "") if artifact else ""
        if artifact is None or (
            _evidence_int(artifact.get("size"), 0) <= 0
            or len(checksum) != 64
            or any(character not in "0123456789abcdefABCDEF" for character in checksum)
            or not str(artifact.get("path") or "")
        ):
            errors.append("signing_artifact_digest_missing")
        errors.extend(_signing_asset_binding_errors("macos", artifacts, assets))
        return list(dict.fromkeys(errors))

    errors: list[str] = []
    if signing.get("schema") != SIGNING_EVIDENCE_SCHEMA:
        return ["signing_evidence_missing"]

    platform_name = str(signing.get("platform") or "")
    if platform_name != _current_signing_platform():
        errors.append("signing_platform_mismatch")
    artifacts = signing.get("artifacts") if isinstance(signing.get("artifacts"), list) else []
    if platform_name == "linux":
        if signing.get("required") is not False or signing.get("status") != "not_applicable":
            errors.append("linux_signing_policy_invalid")
        return errors
    if platform_name not in {"windows", "macos"}:
        return ["signing_platform_invalid"]
    if signing.get("required") is not True or signing.get("status") != "verified":
        errors.append("platform_signature_unverified")
    if not artifacts:
        errors.append("signing_artifacts_missing")
        return errors
    if any(
        not isinstance(item, dict)
        or item.get("signed") is not True
        or item.get("verified") is not True
        for item in artifacts
    ):
        errors.append("platform_signature_unverified")
    paths = [str(item.get("path") or "") if isinstance(item, dict) else "" for item in artifacts]
    if any(not path for path in paths) or len(set(paths)) != len(paths):
        errors.append("signing_artifact_paths_invalid")
    if any(
        not isinstance(item, dict)
        or _evidence_int(item.get("size"), 0) <= 0
        or len(str(item.get("sha256") or "")) != 64
        or any(character not in "0123456789abcdefABCDEF" for character in str(item.get("sha256") or ""))
        for item in artifacts
    ):
        errors.append("signing_artifact_digest_missing")

    kinds = {
        str(item.get("kind"))
        for item in artifacts
        if isinstance(item, dict) and item.get("kind")
    }
    if platform_name == "windows":
        if not {"app", "nsis", "msi"}.issubset(kinds):
            errors.append("windows_signing_artifacts_incomplete")
        thumbprints = [
            str(item.get("signer", {}).get("thumbprint") or "")
            if isinstance(item, dict) and isinstance(item.get("signer"), dict)
            else ""
            for item in artifacts
        ]
        if any(not thumbprint for thumbprint in thumbprints) or len(set(thumbprints)) != 1:
            errors.append("windows_signer_mismatch")
        if any(
            not isinstance(item, dict)
            or item.get("timestamped") is not True
            or not isinstance(item.get("timestamp"), dict)
            or not item["timestamp"].get("thumbprint")
            for item in artifacts
        ):
            errors.append("windows_timestamp_missing")
    else:
        if not {"app", "dmg"}.issubset(kinds):
            errors.append("macos_signing_artifacts_incomplete")
        signer_pairs = [
            (
                str(item.get("signer", {}).get("authority") or ""),
                str(item.get("signer", {}).get("teamIdentifier") or ""),
            )
            for item in artifacts
            if isinstance(item, dict) and isinstance(item.get("signer"), dict)
        ]
        if (
            len(signer_pairs) != len(artifacts)
            or any(not authority or not team for authority, team in signer_pairs)
            or len(set(signer_pairs)) != 1
        ):
            errors.append("macos_signer_mismatch")
        if any(
            not isinstance(item, dict)
            or item.get("notarized") is not True
            or item.get("stapled") is not True
            for item in artifacts
            if isinstance(item, dict) and item.get("kind") == "app"
        ):
            errors.append("macos_notarization_missing")
        if any(
            not isinstance(item, dict) or item.get("timestamped") is not True
            for item in artifacts
        ):
            errors.append("macos_timestamp_missing")
    errors.extend(_signing_asset_binding_errors(platform_name, artifacts, assets))
    return list(dict.fromkeys(errors))


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
            "provider_capabilities": ai_report.get("capabilities") or {},
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
    cloud_configured = llm.cloud_configured()
    cloud_egress_allowed = llm.cloud_egress_allowed()
    cloud_generation_opt_in = cloud_enabled
    budgeted = config.CLOUD_MONTHLY_BUDGET_USD > 0
    warnings: list[str] = []
    if cloud_configured and not cloud_egress_allowed:
        warnings.append("cloud_generation_requires_explicit_egress_opt_in")
    if cloud_enabled and not budgeted:
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
            "cloud_configured": cloud_configured,
            "cloud_egress_allowed": cloud_egress_allowed,
            "cloud_enabled": cloud_enabled,
            "cloud_generation_opt_in": cloud_generation_opt_in,
            "cloud_monthly_budget_usd": config.CLOUD_MONTHLY_BUDGET_USD,
            "warnings": warnings,
            "tier": tier,
        },
        action=None if not block and not warnings else "Keep cloud generation explicit, budgeted, and segregated from score prediction.",
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
    candidates = _sidecar_binary_candidates()
    provenance_path = _first_existing(_sidecar_provenance_candidates())
    provenance = _verify_sidecar_provenance(provenance_path)
    # An explicitly supplied provenance manifest may describe a staged package
    # outside the repository's default resource roots. Successful verification
    # already proves that each recorded binary exists and matches its digest.
    binary_present = any(path.exists() for path in candidates) or bool(provenance["verified"])
    worker = jobs.get_worker()
    thread = worker._thread
    alive = thread is not None and thread.is_alive()
    missing_binary = not binary_present
    problems = []
    if missing_binary:
        problems.append("sidecar_binary_missing")
    if provenance["status"] != "ok":
        problems.append("sidecar_provenance_not_verified")
    if not problems:
        level = "ok"
    elif tier == "dev":
        level = "warn"
    else:
        level = "block"
    return _check(
        status=level,
        summary="sidecar configuration and provenance are observable"
        if level == "ok" else "sidecar provenance or packaged binary evidence is incomplete",
        detail={
            "resource_root": str(REPO_ROOT / "electron" / "resources" / "services"),
            "binary_present": binary_present,
            "candidate_paths": [str(path) for path in candidates],
            "provenance": provenance,
            "worker_alive": alive,
            "worker_enabled": config.JOBS_WORKER_ENABLED,
        },
        action=None if level == "ok"
        else "Build the backend sidecar and verify electron/resources/services/sidecar-provenance.json before packaged release smoke.",
    )


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _sidecar_provenance_candidates() -> list[Path]:
    candidates: list[Path] = []
    explicit = os.environ.get("STUDYVAULT_SIDECAR_PROVENANCE")
    if explicit:
        candidates.append(Path(explicit))
    candidates.append(
        REPO_ROOT / "electron" / "resources" / "services" / "sidecar-provenance.json"
    )
    if not getattr(sys, "frozen", False):
        candidates.extend(
            [
                PACKAGED_CONTRACTS / "sidecar-provenance.json",
                config.BASE_DIR / "release_contracts" / "sidecar-provenance.json",
            ]
        )
    return candidates


def _sidecar_provenance_entry_path(rel: str) -> Path | None:
    parts = rel.replace("\\", "/").lstrip("/").split("/")
    if any(part in {"", ".", ".."} for part in parts):
        return None
    return Path(*parts)


def _verify_sidecar_provenance(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {
            "status": "missing",
            "path": None,
            "candidate_paths": [str(p) for p in _sidecar_provenance_candidates()],
            "verified": [],
            "failures": [],
            "missing_required_services": list(REQUIRED_SIDECAR_PROVENANCE_SERVICES),
        }
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return {
            "status": "invalid",
            "path": str(path),
            "error": str(exc),
            "verified": [],
            "failures": [{"reason": "manifest_unreadable", "error": str(exc)}],
            "missing_required_services": list(REQUIRED_SIDECAR_PROVENANCE_SERVICES),
        }
    entries = manifest.get("entries") if isinstance(manifest, dict) else None
    if manifest.get("schema") != SIDECAR_PROVENANCE_SCHEMA or not isinstance(entries, list):
        return {
            "status": "invalid",
            "path": str(path),
            "schema": manifest.get("schema") if isinstance(manifest, dict) else None,
            "verified": [],
            "failures": [{"reason": "invalid_manifest_shape"}],
            "missing_required_services": list(REQUIRED_SIDECAR_PROVENANCE_SERVICES),
        }
    services_root = path.parent
    verified: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    services: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            failures.append({"reason": "invalid_entry"})
            continue
        service = str(entry.get("service") or "")
        rel = str(entry.get("path") or "").replace("\\", "/").lstrip("/")
        expected_sha = str(entry.get("sha256") or "")
        services.add(service)
        entry_path = _sidecar_provenance_entry_path(rel)
        if (
            not service
            or entry_path is None
            or len(expected_sha) != 64
            or any(ch not in "0123456789abcdefABCDEF" for ch in expected_sha)
        ):
            failures.append({"service": service, "path": rel, "reason": "invalid_entry"})
            continue
        binary = services_root / entry_path
        if not binary.is_file():
            failures.append({"service": service, "path": rel, "reason": "missing_binary"})
            continue
        actual_size = binary.stat().st_size
        actual_sha = _sha256_file(binary)
        expected_size = entry.get("size")
        if expected_sha.lower() != actual_sha or expected_size != actual_size:
            failures.append({
                "service": service,
                "path": rel,
                "reason": "digest_mismatch",
                "expected_sha256": expected_sha,
                "actual_sha256": actual_sha,
                "expected_size": expected_size,
                "actual_size": actual_size,
            })
            continue
        verified.append({
            "service": service,
            "path": rel,
            "sha256": actual_sha,
            "size": actual_size,
        })
    missing_required = [
        service for service in REQUIRED_SIDECAR_PROVENANCE_SERVICES
        if service not in services
    ]
    status = "ok" if not failures and not missing_required else "mismatch"
    return {
        "status": status,
        "path": str(path),
        "schema": manifest.get("schema"),
        "generated_at": manifest.get("generatedAt"),
        "entry_count": len(entries),
        "verified": verified,
        "failures": failures,
        "missing_required_services": missing_required,
    }


def _updater_check(tier: TrustTier) -> dict[str, Any]:
    del tier
    active = False
    level = "ok"
    summary = "updater is disabled until a signed Electron update channel is configured"
    return _check(
        status=level,
        summary=summary,
        detail={"active": active, "placeholder_count": 0, "runtime": "electron"},
        action=None,
    )


def _sidecar_binary_candidates() -> list[Path]:
    root = REPO_ROOT / "electron" / "resources" / "services" / "lsat-backend"
    candidates = [root / "lsatlab-backend.exe", root / "lsatlab-backend"]
    if getattr(sys, "frozen", False):
        candidates.insert(0, Path(sys.executable))
    return candidates


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


def _openapi_snapshot_candidates() -> list[Path]:
    return [
        config.BASE_DIR / "openapi-baseline.json",
        REPO_ROOT / "src" / "domains" / "lsat" / "_meta" / "openapi.json",
        OPENAPI_SNAPSHOT,
        PACKAGED_CONTRACTS / "openapi.json",
        config.BASE_DIR / "release_contracts" / "openapi.json",
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


def _release_manifest_candidates() -> list[Path]:
    candidates: list[Path] = []
    explicit = os.environ.get("STUDYVAULT_RELEASE_MANIFEST") or os.environ.get("LSATLAB_RELEASE_MANIFEST")
    if explicit:
        candidates.append(Path(explicit))
    candidates.extend(
        [
            RELEASE_MANIFEST,
            PACKAGED_CONTRACTS / "studyvault-release-manifest.json",
            config.BASE_DIR / "release_contracts" / "studyvault-release-manifest.json",
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
    parser.add_argument("--tier", choices=["dev", "release", "packaged"], default=_default_tier())
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
