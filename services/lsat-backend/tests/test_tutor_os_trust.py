"""Tutor OS tranche: trust manifest, scheduler, job controls, and why loop."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlmodel import select

from app import trust as trust_mod
from app import jobs
from app.models import BenchmarkRun, GenJob, GenStatus, ScheduledTask, SchedulerRun


def _first_question(client):
    pts = client.get("/api/preptests").json()
    pt = client.get(f"/api/preptests/{pts[0]['id']}").json()
    section = client.get(f"/api/sections/{pt['sections'][0]['id']}").json()
    return section["questions"][0]


def _write_sidecar_provenance(tmp_path, payload: bytes = b"lsat-sidecar"):
    services = tmp_path / "services"
    binary = services / "lsat-backend" / "lsatlab-backend"
    binary.parent.mkdir(parents=True)
    binary.write_bytes(payload)
    manifest = services / "sidecar-provenance.json"
    manifest.write_text(
        json.dumps(
            {
                "schema": trust_mod.SIDECAR_PROVENANCE_SCHEMA,
                "generatedAt": "2026-07-05T00:00:00.000Z",
                "servicesRoot": "src-tauri/resources/services",
                "entries": [
                    {
                        "service": "LSAT backend",
                        "path": "lsat-backend/lsatlab-backend",
                        "sha256": trust_mod._sha256_file(binary),
                        "size": binary.stat().st_size,
                        "optional": False,
                        "source": "test",
                        "recordedAt": "2026-07-05T00:00:00.000Z",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    return manifest, binary


def _write_release_manifest(tmp_path, *, assets: bool = True, sidecar: bool = True):
    manifest = tmp_path / "studyvault-release-manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "schema": trust_mod.RELEASE_MANIFEST_SCHEMA,
                "versions": {
                    "package": "0.9.0",
                    "tauri": "0.9.0",
                    "cargo": "0.9.0",
                    "consistent": True,
                },
                "lockfiles": [
                    {"path": "package-lock.json", "present": True, "required": True, "sha256": "a" * 64, "size": 100},
                    {"path": "src-tauri/Cargo.lock", "present": True, "required": True, "sha256": "b" * 64, "size": 100},
                    {
                        "path": "services/lsat-backend/uv.lock",
                        "present": True,
                        "required": True,
                        "sha256": "c" * 64,
                        "size": 100,
                    },
                ],
                "sbom": {"counts": {"npm": 10, "cargo": 11, "pypi": 12, "total": 33}},
                "sidecarProvenance": {
                    "present": sidecar,
                    "entries": [{"service": "LSAT backend", "path": "lsat-backend/lsatlab-backend"}] if sidecar else [],
                },
                "bundleAssets": [{"path": "src-tauri/target/release/bundle/msi/app.msi", "sha256": "d" * 64, "size": 100}]
                if assets
                else [],
                "signing": {
                    "windows": {"configured": False, "digestAlgorithm": "sha256"},
                    "macos": {"configured": False},
                },
            }
        ),
        encoding="utf-8",
    )
    return manifest


def test_release_trust_default_report_path_is_repo_dist(monkeypatch):
    monkeypatch.delenv("LSATLAB_RELEASE_LOCAL_REPORT", raising=False)
    monkeypatch.delenv("STUDYVAULT_RELEASE_MANIFEST", raising=False)

    repo_root = Path(__file__).resolve().parents[3]

    assert trust_mod.RELEASE_LOCAL_REPORT == repo_root / "dist" / "release_local_report.json"
    assert trust_mod.RELEASE_MANIFEST == repo_root / "dist" / "studyvault-release-manifest.json"
    assert trust_mod._release_report_candidates()[0] == trust_mod.RELEASE_LOCAL_REPORT
    assert trust_mod._release_manifest_candidates()[0] == trust_mod.RELEASE_MANIFEST


def test_release_trust_blocks_invalid_release_local_schema(db_session, monkeypatch, tmp_path):
    report = tmp_path / "release_local_report.json"
    report.write_text(
        json.dumps(
            {
                "schema": "wrong.schema",
                "status": "passed",
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "git": {"head": "unit", "branch": "test", "dirty": False, "status_lines": []},
                "options": {},
                "checks": [],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("LSATLAB_RELEASE_LOCAL_REPORT", str(report))

    release_local = trust_mod.build_release_trust_manifest(db_session, tier="release")["checks"][
        "release_local"
    ]

    assert release_local["status"] == "block"
    assert release_local["summary"] == "release:local report has an invalid schema"
    assert release_local["detail"]["schema"] == "wrong.schema"


def test_release_manifest_trust_accepts_complete_manifest(monkeypatch, tmp_path):
    manifest = _write_release_manifest(tmp_path)
    monkeypatch.setenv("STUDYVAULT_RELEASE_MANIFEST", str(manifest))

    check = trust_mod._release_manifest_check("release")

    assert check["status"] == "ok"
    assert check["detail"]["component_counts"] == {"npm": 10, "cargo": 11, "pypi": 12}
    assert check["detail"]["bundle_asset_count"] == 1
    assert check["detail"]["has_lsat_sidecar"] is True


def test_release_manifest_trust_blocks_missing_release_assets(monkeypatch, tmp_path):
    manifest = _write_release_manifest(tmp_path, assets=False, sidecar=False)
    monkeypatch.setenv("STUDYVAULT_RELEASE_MANIFEST", str(manifest))

    release_check = trust_mod._release_manifest_check("release")
    dev_check = trust_mod._release_manifest_check("dev")

    assert release_check["status"] == "block"
    assert set(release_check["detail"]["errors"]) == {
        "bundle_assets_missing",
        "sidecar_provenance_missing",
    }
    assert dev_check["status"] == "ok"


def test_release_trust_manifest_and_diagnostics(client):
    trust = client.get("/api/observability/trust?tier=dev").json()
    assert trust["schema"] == "lsatlab.release_trust.v1"
    assert trust["tier"] == "dev"
    assert "release_local" in trust["checks"]
    assert "release_manifest" in trust["checks"]
    assert "backend_readiness" in trust["checks"]
    assert "privacy_firewall" in trust["checks"]
    assert 0 <= trust["score"] <= 100

    diagnostics = client.get("/api/observability/diagnostics?tier=dev").json()
    assert diagnostics["trust"]["schema"] == "lsatlab.release_trust.v1"
    assert diagnostics["queue"]["queued"] >= 0
    assert diagnostics["content"]["official_firewall"]["ok"] is True


def test_release_trust_reads_release_local_report(db_session, monkeypatch, tmp_path):
    report = tmp_path / "release_local_report.json"
    labels = [
        *trust_mod.REQUIRED_RELEASE_LOCAL_LABELS,
        "frontend playwright e2e",
        "backend sidecar build",
        "tauri build",
        "packaged app smoke",
        "release manifest/SBOM",
    ]
    checks = [
        {"label": label, "status": "passed", "exit_code": 0, "duration_s": 0.1}
        for label in labels
    ]
    report.write_text(
        json.dumps(
            {
                "schema": "lsatlab.release_local_report.v1",
                "status": "passed",
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "duration_s": 12.3,
                "git": {
                    "head": "unit",
                    "branch": "test",
                    "dirty": True,
                    "status_lines": ["?? AGENTS.md", "?? CLAUDE.md"],
                },
                "options": {
                    "skip_e2e": False,
                    "skip_tauri": False,
                    "skip_sidecar_build": False,
                    "skip_packaged_smoke": False,
                },
                "summary": {"passed": len(checks), "failed": 0, "timed_out": 0, "total": len(checks)},
                "checks": checks,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("LSATLAB_RELEASE_LOCAL_REPORT", str(report))
    monkeypatch.setattr(trust_mod, "_current_git_head", lambda: "unit")
    monkeypatch.setattr(trust_mod, "_current_git_status_lines", lambda: [])

    manifest = trust_mod.build_release_trust_manifest(db_session, tier="release")
    release_local = manifest["checks"]["release_local"]

    assert release_local["status"] == "ok"
    assert release_local["detail"]["path"] == str(report)
    assert release_local["detail"]["missing_required_labels"] == []
    assert release_local["detail"]["failed_checks"] == []
    contract = release_local["detail"]["freshness_contract"]
    assert contract["ready"] is True
    assert contract["blocking_status_lines"] == []
    assert contract["ignored_status_lines"] == ["?? AGENTS.md", "?? CLAUDE.md"]


@pytest.mark.parametrize(
    "omitted",
    [
        "rag retrieval-eval floor",
        "explanation golden floor",
        "prompt regression fixture floor",
        "source-grounded answer benchmark floor",
    ],
)
def test_release_trust_blocks_missing_eval_release_label(
    db_session,
    monkeypatch,
    tmp_path,
    omitted,
):
    report = tmp_path / "release_local_report.json"
    checks = [
        {"label": label, "status": "passed", "exit_code": 0, "duration_s": 0.1}
        for label in trust_mod.REQUIRED_RELEASE_LOCAL_LABELS
        if label != omitted
    ]
    report.write_text(
        json.dumps(
            {
                "schema": "lsatlab.release_local_report.v1",
                "status": "passed",
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "duration_s": 9.0,
                "git": {"head": "unit", "branch": "test", "dirty": False, "status_lines": []},
                "options": {
                    "skip_e2e": True,
                    "skip_tauri": True,
                    "skip_sidecar_build": True,
                    "skip_packaged_smoke": True,
                },
                "summary": {"passed": len(checks), "failed": 0, "timed_out": 0, "total": len(checks)},
                "checks": checks,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("LSATLAB_RELEASE_LOCAL_REPORT", str(report))
    monkeypatch.setattr(trust_mod, "_current_git_head", lambda: "unit")
    monkeypatch.setattr(trust_mod, "_current_git_status_lines", lambda: [])

    release_local = trust_mod.build_release_trust_manifest(db_session, tier="release")[
        "checks"
    ]["release_local"]

    assert release_local["status"] == "block"
    assert omitted in release_local["detail"]["missing_required_labels"]
    assert "release_local_missing_required_checks" in release_local["detail"][
        "freshness_contract"
    ]["reasons"]


def test_release_trust_blocks_skipped_critical_steps(db_session, monkeypatch, tmp_path):
    """Hardening (Codex prod-readiness P1): a release:local report that SKIPPED
    tauri/packaged/e2e must BLOCK at the release tier — a release-tier "ok" while
    the build was never exercised is self-certifying theatre. Lower tiers keep
    skips at warn for fast iteration."""
    report = tmp_path / "release_local_report.json"
    # Only the always-required checks ran; the skipped steps are absent, exactly
    # what release_local.py writes when --skip-tauri / --skip-e2e are passed.
    checks = [
        {"label": label, "status": "passed", "exit_code": 0, "duration_s": 0.1}
        for label in trust_mod.REQUIRED_RELEASE_LOCAL_LABELS
    ]
    report.write_text(
        json.dumps(
            {
                "schema": "lsatlab.release_local_report.v1",
                "status": "passed",
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "duration_s": 9.0,
                "git": {"head": "unit", "branch": "test", "dirty": False, "status_lines": []},
                "options": {
                    "skip_e2e": True,
                    "skip_tauri": True,
                    "skip_sidecar_build": True,
                    "skip_packaged_smoke": True,
                },
                "summary": {"passed": len(checks), "failed": 0, "timed_out": 0, "total": len(checks)},
                "checks": checks,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("LSATLAB_RELEASE_LOCAL_REPORT", str(report))
    monkeypatch.setattr(trust_mod, "_current_git_head", lambda: "unit")
    monkeypatch.setattr(trust_mod, "_current_git_status_lines", lambda: [])

    rel = trust_mod.build_release_trust_manifest(db_session, tier="release")["checks"][
        "release_local"
    ]
    assert rel["status"] == "block"
    assert set(rel["detail"]["skipped"]) == {
        "skip_e2e",
        "skip_tauri",
        "skip_sidecar_build",
        "skip_packaged_smoke",
    }

    # The SAME evidence at a non-release tier stays a warning, not a block.
    dev = trust_mod.build_release_trust_manifest(db_session, tier="dev")["checks"][
        "release_local"
    ]
    assert dev["status"] == "warn"


def test_release_trust_blocks_stale_release_local_report(db_session, monkeypatch, tmp_path):
    report = tmp_path / "release_local_report.json"
    labels = [
        *trust_mod.REQUIRED_RELEASE_LOCAL_LABELS,
        "frontend playwright e2e",
        "backend sidecar build",
        "tauri build",
        "packaged app smoke",
        "release manifest/SBOM",
    ]
    checks = [
        {"label": label, "status": "passed", "exit_code": 0, "duration_s": 0.1}
        for label in labels
    ]
    report.write_text(
        json.dumps(
            {
                "schema": trust_mod.RELEASE_LOCAL_REPORT_SCHEMA,
                "status": "passed",
                "generated_at": (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat(),
                "duration_s": 12.3,
                "git": {
                    "head": "unit",
                    "branch": "test",
                    "dirty": False,
                    "status_lines": [],
                },
                "options": {
                    "skip_e2e": False,
                    "skip_tauri": False,
                    "skip_sidecar_build": False,
                    "skip_packaged_smoke": False,
                },
                "summary": {"passed": len(checks), "failed": 0, "timed_out": 0, "total": len(checks)},
                "checks": checks,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("LSATLAB_RELEASE_LOCAL_REPORT", str(report))
    monkeypatch.setattr(trust_mod, "_current_git_head", lambda: "unit")
    monkeypatch.setattr(trust_mod, "_current_git_status_lines", lambda: [])

    release_local = trust_mod.build_release_trust_manifest(db_session, tier="release")["checks"][
        "release_local"
    ]

    assert release_local["status"] == "block"
    assert release_local["detail"]["stale"] is True
    assert release_local["detail"]["freshness_contract"]["ready"] is False
    assert "release_local_stale" in release_local["detail"]["freshness_contract"]["reasons"]


def test_packaged_trust_allows_packaged_smoke_in_progress(db_session, monkeypatch, tmp_path):
    report = tmp_path / "release_local_report.json"
    labels = [
        *trust_mod.REQUIRED_RELEASE_LOCAL_LABELS,
        "frontend playwright e2e",
        "backend sidecar build",
        "tauri build",
    ]
    checks = [
        {"label": label, "status": "passed", "exit_code": 0, "duration_s": 0.1}
        for label in labels
    ]
    report.write_text(
        json.dumps(
            {
                "schema": "lsatlab.release_local_report.v1",
                "status": "passed",
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "duration_s": 12.3,
                "git": {
                    "head": "unit",
                    "branch": "test",
                    "dirty": False,
                    "status_lines": [],
                },
                "options": {
                    "skip_e2e": False,
                    "skip_tauri": False,
                    "skip_sidecar_build": False,
                    "skip_packaged_smoke": False,
                },
                "summary": {"passed": len(checks), "failed": 0, "timed_out": 0, "total": len(checks)},
                "checks": checks,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("LSATLAB_RELEASE_LOCAL_REPORT", str(report))
    monkeypatch.setenv(trust_mod.PACKAGED_SMOKE_IN_PROGRESS_ENV, "1")
    monkeypatch.setattr(trust_mod, "_current_git_head", lambda: "unit")
    monkeypatch.setattr(trust_mod, "_current_git_status_lines", lambda: [])

    manifest = trust_mod.build_release_trust_manifest(db_session, tier="packaged")
    release_local = manifest["checks"]["release_local"]

    assert release_local["status"] == "ok"
    assert release_local["detail"]["packaged_smoke_in_progress"] is True
    assert release_local["detail"]["missing_required_labels"] == []
    assert release_local["detail"]["freshness_contract"]["ready"] is True


def test_release_trust_blocks_real_dirty_release_local_report(db_session, monkeypatch, tmp_path):
    report = tmp_path / "release_local_report.json"
    labels = [
        *trust_mod.REQUIRED_RELEASE_LOCAL_LABELS,
        "frontend playwright e2e",
        "backend sidecar build",
        "tauri build",
        "packaged app smoke",
        "release manifest/SBOM",
    ]
    checks = [
        {"label": label, "status": "passed", "exit_code": 0, "duration_s": 0.1}
        for label in labels
    ]
    report.write_text(
        json.dumps(
            {
                "schema": "lsatlab.release_local_report.v1",
                "status": "passed",
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "duration_s": 12.3,
                "git": {
                    "head": "unit",
                    "branch": "test",
                    "dirty": True,
                    "status_lines": [" M backend/app/trust.py"],
                },
                "options": {
                    "skip_e2e": False,
                    "skip_tauri": False,
                    "skip_sidecar_build": False,
                    "skip_packaged_smoke": False,
                },
                "summary": {"passed": len(checks), "failed": 0, "timed_out": 0, "total": len(checks)},
                "checks": checks,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("LSATLAB_RELEASE_LOCAL_REPORT", str(report))
    monkeypatch.setattr(trust_mod, "_current_git_head", lambda: "unit")
    monkeypatch.setattr(trust_mod, "_current_git_status_lines", lambda: [])

    manifest = trust_mod.build_release_trust_manifest(db_session, tier="release")
    release_local = manifest["checks"]["release_local"]

    assert release_local["status"] == "block"
    assert release_local["detail"]["freshness_contract"]["ready"] is False
    assert release_local["detail"]["freshness_contract"]["blocking_status_lines"] == [
        " M backend/app/trust.py"
    ]
    assert "working_tree_has_blocking_changes" in release_local["detail"]["freshness_contract"]["reasons"]


def test_release_trust_blocks_head_mismatch(db_session, monkeypatch, tmp_path):
    report = tmp_path / "release_local_report.json"
    labels = [
        *trust_mod.REQUIRED_RELEASE_LOCAL_LABELS,
        "frontend playwright e2e",
        "backend sidecar build",
        "tauri build",
        "packaged app smoke",
        "release manifest/SBOM",
    ]
    checks = [
        {"label": label, "status": "passed", "exit_code": 0, "duration_s": 0.1}
        for label in labels
    ]
    report.write_text(
        json.dumps(
            {
                "schema": "lsatlab.release_local_report.v1",
                "status": "passed",
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "duration_s": 12.3,
                "git": {
                    "head": "old-head",
                    "branch": "test",
                    "dirty": False,
                    "status_lines": [],
                },
                "options": {
                    "skip_e2e": False,
                    "skip_tauri": False,
                    "skip_sidecar_build": False,
                    "skip_packaged_smoke": False,
                },
                "summary": {"passed": len(checks), "failed": 0, "timed_out": 0, "total": len(checks)},
                "checks": checks,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("LSATLAB_RELEASE_LOCAL_REPORT", str(report))
    monkeypatch.setattr(trust_mod, "_current_git_head", lambda: "new-head")
    monkeypatch.setattr(trust_mod, "_current_git_status_lines", lambda: [])

    manifest = trust_mod.build_release_trust_manifest(db_session, tier="release")
    contract = manifest["checks"]["release_local"]["detail"]["freshness_contract"]

    assert manifest["checks"]["release_local"]["status"] == "block"
    assert contract["head_mismatch"] is True
    assert contract["live_head"] == "new-head"
    assert "release_local_head_mismatch" in contract["reasons"]


def test_release_trust_blocks_live_dirty_tree(db_session, monkeypatch, tmp_path):
    report = tmp_path / "release_local_report.json"
    labels = [
        *trust_mod.REQUIRED_RELEASE_LOCAL_LABELS,
        "frontend playwright e2e",
        "backend sidecar build",
        "tauri build",
        "packaged app smoke",
        "release manifest/SBOM",
    ]
    checks = [
        {"label": label, "status": "passed", "exit_code": 0, "duration_s": 0.1}
        for label in labels
    ]
    report.write_text(
        json.dumps(
            {
                "schema": "lsatlab.release_local_report.v1",
                "status": "passed",
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "duration_s": 12.3,
                "git": {
                    "head": "unit",
                    "branch": "test",
                    "dirty": False,
                    "status_lines": [],
                },
                "options": {
                    "skip_e2e": False,
                    "skip_tauri": False,
                    "skip_sidecar_build": False,
                    "skip_packaged_smoke": False,
                },
                "summary": {"passed": len(checks), "failed": 0, "timed_out": 0, "total": len(checks)},
                "checks": checks,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("LSATLAB_RELEASE_LOCAL_REPORT", str(report))
    monkeypatch.setattr(trust_mod, "_current_git_head", lambda: "unit")
    monkeypatch.setattr(trust_mod, "_current_git_status_lines", lambda: [" M backend/app/trust.py"])

    manifest = trust_mod.build_release_trust_manifest(db_session, tier="release")
    contract = manifest["checks"]["release_local"]["detail"]["freshness_contract"]

    assert manifest["checks"]["release_local"]["status"] == "block"
    assert contract["live_status_lines"] == [" M backend/app/trust.py"]
    assert contract["blocking_status_lines"] == [" M backend/app/trust.py"]


def test_model_readiness_warns_on_degraded_embeddings(monkeypatch):
    def fake_report(*, include_ai: bool = True):
        assert include_ai is True
        return {
            "warnings": ["model_missing:embedding"],
            "ai": {
                "ready": True,
                "ollama_reachable": True,
                "provider": "ollama",
                "realtime_provider": "ollama",
                "models": ["qwen3:8b", "qwen3:14b"],
                "expected_models": {
                    "explain": "phi4:14b",
                    "explain_fallback": "qwen3:8b",
                    "diagnose": "qwen3:8b",
                    "generation": "qwen3:14b",
                    "embedding": "nomic-embed-text",
                },
                "model_available": {
                    "explain": False,
                    "explain_fallback": True,
                    "diagnose": True,
                    "generation": True,
                    "embedding": False,
                },
                "capabilities": {
                    "realtime": {"provider": "ollama"},
                    "offline": {"provider": "ollama"},
                    "matrix": {"anthropic": {"sampling": {"seed": False}}},
                },
            },
        }

    monkeypatch.setattr(trust_mod.doctor, "build_report", fake_report)

    check = trust_mod._model_readiness_check("release")

    assert check["status"] == "warn"
    assert check["detail"]["required_missing"] == []
    assert set(check["detail"]["degraded_missing"]) == {
        "embedding",
        "preferred_explain",
    }
    assert check["detail"]["provider_capabilities"]["matrix"]["anthropic"]["sampling"]["seed"] is False


def test_model_readiness_blocks_release_when_core_model_missing(monkeypatch):
    def fake_report(*, include_ai: bool = True):
        assert include_ai is True
        return {
            "warnings": ["ollama_unreachable", "ai_not_ready"],
            "ai": {
                "ready": False,
                "ollama_reachable": False,
                "provider": "ollama",
                "realtime_provider": "ollama",
                "models": [],
                "expected_models": {
                    "explain": "phi4:14b",
                    "explain_fallback": "qwen3:8b",
                    "diagnose": "qwen3:8b",
                    "generation": "qwen3:14b",
                    "embedding": "nomic-embed-text",
                },
                "model_available": {
                    "explain": False,
                    "explain_fallback": False,
                    "diagnose": False,
                    "generation": False,
                    "embedding": False,
                },
                "capabilities": {
                    "realtime": {"provider": "ollama"},
                    "offline": {"provider": "ollama"},
                    "matrix": {"anthropic": {"sampling": {"seed": False}}},
                },
            },
        }

    monkeypatch.setattr(trust_mod.doctor, "build_report", fake_report)

    check = trust_mod._model_readiness_check("release")

    assert check["status"] == "block"
    assert set(check["detail"]["required_missing"]) == {
        "provider",
        "explain",
        "diagnose",
        "generation",
    }


def test_packaged_trust_has_no_placeholder_updater_blocker(client):
    trust = client.get("/api/release/trust?tier=packaged").json()
    blocked = {item["check"] for item in trust["blockers"]}
    assert "updater_placeholder_guard" not in blocked
    updater = trust["checks"]["updater_placeholder_guard"]
    assert updater["status"] == "ok"
    assert updater["detail"]["active"] is False


def test_sidecar_trust_accepts_matching_provenance(monkeypatch, tmp_path):
    manifest, _binary = _write_sidecar_provenance(tmp_path)
    monkeypatch.setenv("STUDYVAULT_SIDECAR_PROVENANCE", str(manifest))

    check = trust_mod._sidecar_check("release")

    assert check["status"] == "ok"
    provenance = check["detail"]["provenance"]
    assert provenance["status"] == "ok"
    assert provenance["missing_required_services"] == []
    assert provenance["verified"][0]["service"] == "LSAT backend"


def test_sidecar_trust_blocks_release_on_provenance_mismatch(monkeypatch, tmp_path):
    manifest, binary = _write_sidecar_provenance(tmp_path)
    binary.write_bytes(b"tampered-sidecar")
    monkeypatch.setenv("STUDYVAULT_SIDECAR_PROVENANCE", str(manifest))

    release_check = trust_mod._sidecar_check("release")
    dev_check = trust_mod._sidecar_check("dev")

    assert release_check["status"] == "block"
    assert dev_check["status"] == "warn"
    failures = release_check["detail"]["provenance"]["failures"]
    assert failures[0]["service"] == "LSAT backend"
    assert failures[0]["reason"] == "digest_mismatch"


def test_sidecar_trust_rejects_manifest_path_escape(monkeypatch, tmp_path):
    manifest, _binary = _write_sidecar_provenance(tmp_path)
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    payload["entries"][0]["path"] = "../outside"
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setenv("STUDYVAULT_SIDECAR_PROVENANCE", str(manifest))

    check = trust_mod._sidecar_check("release")

    assert check["status"] == "block"
    failures = check["detail"]["provenance"]["failures"]
    assert failures[0]["reason"] == "invalid_entry"


def test_scheduled_defaults_and_benchmark_recording(client):
    schedules = client.get("/api/observability/scheduled-tasks").json()
    keys = {row["key"] for row in schedules["tasks"]}
    assert {
        "daily_backup",
        "daily_calibration",
        "content_health_audit",
        "content_revalidation",
    } <= keys
    for key in sorted(keys):
        run = client.post(f"/api/observability/scheduled-tasks/{key}/run").json()
        assert run["ok"] is True
        if key == "generation_gate_eval":
            benchmark = run["result"]["benchmark"]
            assert benchmark["kind"] == "generation_gate_eval"
            assert benchmark["metrics"]["generation_quality_failed_cases"] == 0.0
        if key == "content_revalidation":
            assert run["result"]["model_gate"] is False
            assert "remaining" in run["result"]
    trust = client.get("/api/observability/trust?tier=dev").json()
    scheduler = trust["checks"]["scheduler"]["detail"]
    assert set(scheduler["expected_keys"]) <= set(scheduler["present_keys"])
    assert scheduler["missing_keys"] == []
    assert scheduler["disabled_keys"] == []
    assert scheduler["stale_success_keys"] == []
    assert trust["checks"]["knowledge_index"]["status"] in {"ok", "warn"}

    benchmark = client.post(
        "/api/observability/benchmarks",
        json={
            "kind": "route_budget",
            "status": "recorded",
            "metrics": {"dashboard_ms": 42},
            "environment": {"profile": "unit"},
        },
    ).json()
    assert benchmark["kind"] == "route_budget"
    assert benchmark["metrics"]["dashboard_ms"] == 42
    assert client.get("/api/observability/benchmarks").json()["count"] >= 1


def test_release_trust_requires_generation_quality_benchmark(db_session):
    db_session.add(
        BenchmarkRun(
            kind="local_smoke",
            status="ok",
            metrics_json={"readiness_ms": 1.0},
            environment_json={"profile": "legacy_smoke"},
        )
    )
    db_session.commit()

    check = trust_mod._benchmark_check(db_session, "release")

    assert check["status"] == "block"
    assert check["detail"]["generation_quality"]["present"] is False
    assert "generation-quality" in check["action"]


def test_generation_quality_benchmark_satisfies_release_trust(db_session):
    smoke = jobs.run_benchmark_smoke(db_session, notes="unit")

    check = trust_mod._benchmark_check(db_session, "release")
    quality = check["detail"]["generation_quality"]

    assert smoke["status"] == "ok"
    assert smoke["metrics"]["generation_quality_failed_cases"] == 0.0
    assert smoke["metrics"]["generation_quality_clean_pass"] == 1.0
    assert smoke["metrics"]["generation_quality_trap_metadata_rejected"] == 1.0
    assert smoke["metrics"]["generation_quality_weak_distractor_rejected"] == 1.0
    assert quality["present"] is True
    assert quality["ok"] is True
    assert check["status"] == "ok"


def test_generation_gate_eval_records_dedicated_benchmark(db_session):
    result = jobs.run_generation_gate_eval(db_session, notes="unit")

    check = trust_mod._benchmark_check(db_session, "release")

    assert result["kind"] == "generation_gate_eval"
    assert result["status"] == "ok"
    assert result["metrics"]["generation_quality_failed_cases"] == 0.0
    assert result["evidence"]["generation_quality"]["ok"] is True
    assert check["detail"]["generation_quality"]["run_id"] == result["id"]
    assert check["status"] == "ok"


def test_unknown_scheduled_task_type_is_rejected(client):
    response = client.post(
        "/api/observability/scheduled-tasks",
        json={
            "key": "mystery_task",
            "label": "Mystery task",
            "task_type": "does_not_exist",
            "cadence_s": 60,
        },
    )
    assert response.status_code == 422
    assert "unsupported scheduled task type" in response.json()["detail"]


def test_unknown_existing_scheduled_task_type_fails_closed(db_session):
    db_session.add(
        ScheduledTask(
            key="legacy_mystery_task",
            label="Legacy mystery task",
            task_type="does_not_exist",
            cadence_s=60,
            enabled=True,
        )
    )
    db_session.commit()

    result = jobs.run_scheduled_task(db_session, "legacy_mystery_task")

    assert result["ok"] is False
    assert "unsupported scheduled task type" in result["error"]
    task = db_session.exec(
        select(ScheduledTask).where(ScheduledTask.key == "legacy_mystery_task")
    ).one()
    run = db_session.exec(
        select(SchedulerRun).where(SchedulerRun.task_key == "legacy_mystery_task")
    ).one()
    assert task.status == "failed"
    assert run.status == "failed"
    assert run.error == result["error"]
    assert run.result_json["error"] == result["error"]


def test_generation_job_priority_progress_and_cancel(client):
    created = client.post(
        "/api/gen/jobs",
        json={"q_type": "Flaw", "count": 2, "priority": 7, "max_retries": 1},
    ).json()
    jid = created["job_id"]
    progress = client.get(f"/api/gen/jobs/{jid}/progress").json()
    assert progress["priority"] == 7
    assert progress["progress_pct"] == 0
    updated = client.patch(f"/api/gen/jobs/{jid}/priority", json={"priority": 11}).json()
    assert updated["priority"] == 11
    cancelled = client.patch(f"/api/gen/jobs/{jid}/cancel").json()
    assert cancelled["ok"] is True
    assert cancelled["status"] == "cancelled"


def test_generation_job_manual_retry_endpoint(client, db_session):
    created = client.post(
        "/api/gen/jobs",
        json={"q_type": "Flaw", "count": 1, "max_retries": 1},
    ).json()
    jid = created["job_id"]
    job = db_session.get(GenJob, jid)
    job.status = GenStatus.failed
    job.validation_report = {"error": "temporary provider outage"}
    db_session.add(job)
    db_session.commit()

    retried = client.patch(f"/api/gen/jobs/{jid}/retry").json()

    assert retried["status"] == "queued"
    assert retried["retry_count"] == 1
    progress = client.get(f"/api/gen/jobs/{jid}/progress").json()
    assert progress["retry_pending"] is True


def test_socratic_why_loop_and_concept_card_generation(client):
    q = _first_question(client)
    sid = client.post("/api/sessions", json={"type": "drill", "config": {}}).json()["id"]
    attempt = client.post(
        f"/api/sessions/{sid}/attempts",
        json={
            "question_id": q["id"],
            "mode": "drill",
            "chosen_answer": "A",
            "time_ms": 93000,
            "flagged": True,
            "confidence": "guess",
        },
    ).json()
    aid = attempt["attempt_id"]
    rationale = client.post(
        f"/api/attempts/{aid}/rationale",
        json={
            "stage": "blind_review",
            "answer": "A",
            "confidence": "guess",
            "rationale_text": "The attractive choice seemed necessary.",
            "trap_guess": "too_strong",
        },
    )
    assert rationale.status_code == 200

    state = client.get(f"/api/attempts/{aid}/why-loop").json()
    assert state["answer_key_hidden"] is True
    assert state["next_step"] in {"socratic_hint", "revised_answer", "reveal_contrast"}
    assert all(
        step.get("value", {}).get("correct_answer") is None
        for step in state["steps"]
        if isinstance(step.get("value"), dict)
    )

    cards = client.post(f"/api/attempts/{aid}/concept-cards").json()
    assert cards["origin"] in {"trap_recognition", "concept_gap"}
    assert cards["card_id"] > 0
