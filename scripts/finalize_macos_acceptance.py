#!/usr/bin/env python3
"""Finalize macos-acceptance.json only from complete authoritative evidence."""
from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

from macos_personal_release import ReleaseError, validate_acceptance_payload


REPO_ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = REPO_ROOT / "release-personal" / "evidence"


def read_json(path: Path) -> dict:
    if not path.is_file():
        raise ReleaseError(f"required acceptance evidence is missing: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


REQUIRED_AUTOMATED_CHECKS = {
    "LSAT release Python dependencies",
    "complete packaged release trust",
    "Electron runtime test suite",
    "arm64 LSAT sidecar build",
    "sidecar provenance verification",
    "production renderer build",
    "arm64 Electron application build",
    "ZIP and DMG strict signature verification",
    "packaged fresh profile smoke",
    "packaged clone smoke",
    "semantic profile migration parity",
    "packaged live smoke",
    "live profile semantic parity",
    "Electron fuses",
    "macOS transport and permission plist",
}


def validate_packaged_visual(manifest: dict, commit: str, app_tree_sha256: str, executable_sha256: str) -> dict:
    captures = manifest.get("captures", [])
    required = {
        "today-wide-light", "today-minimum-dark", "assessment-focus-light", "long-reading-dark",
        "empty-state-light", "offline-recovery-dark", "reduced-motion-dark", "fullscreen-light",
    }
    present = {capture.get("id") for capture in captures}
    missing = sorted(required - present)
    if (
        manifest.get("kind") != "studyvault-packaged-visual-evidence"
        or manifest.get("status") != "pass"
        or manifest.get("native_capture_gate", {}).get("status") != "pass"
        or manifest.get("commit") != commit
        or manifest.get("application", {}).get("app_tree_sha256") != app_tree_sha256
        or manifest.get("application", {}).get("executable_sha256") != executable_sha256
        or missing
    ):
        raise ReleaseError("packaged visual manifest is incomplete or belongs to another commit")
    failed = [
        capture.get("id") for capture in captures
        if capture.get("renderer_capture", {}).get("status") != "captured"
        or capture.get("native_capture", {}).get("status") != "captured"
    ]
    if failed:
        raise ReleaseError("packaged renderer or native captures failed: " + ", ".join(failed))
    if len(manifest.get("displays", [])) > 1 and manifest.get("secondary_display_capture") != "captured":
        raise ReleaseError("connected secondary display was not captured")
    return {"status": "pass", "captures": len(captures), "secondary_display": manifest.get("secondary_display_capture")}


def validate_performance(report: dict, commit: str, app_tree_sha256: str, executable_sha256: str) -> dict:
    if report.get("status") != "pass" or report.get("authoritative") is not True:
        raise ReleaseError("packaged performance evidence is not an authoritative pass")
    if report.get("shutdown", {}).get("normal_quit") is not True or report.get("shutdown", {}).get("owned_ports_closed") is not True:
        raise ReleaseError("packaged performance evidence lacks clean shutdown")
    if report.get("source", {}).get("commit") != commit or report.get("source", {}).get("working_tree_clean") is not True:
        raise ReleaseError("packaged performance evidence is not bound to the accepted clean commit")
    if report.get("artifact", {}).get("bundle_tree_sha256") != app_tree_sha256:
        raise ReleaseError("packaged performance evidence is not bound to the accepted signed app")
    if report.get("artifact", {}).get("executable_sha256") != executable_sha256:
        raise ReleaseError("packaged performance executable is not bound to the accepted signed app")
    return {
        "status": "pass", "authoritative": True, "startup": report.get("startup"),
        "performance": report.get("performance"), "network": report.get("network"), "shutdown": report.get("shutdown"),
    }


def finalize(acceptance_path: Path, visual_path: Path, performance_path: Path, manual_path: Path) -> dict:
    acceptance = read_json(acceptance_path)
    identity = acceptance.get("application_identity", {})
    if identity.get("commit") != acceptance.get("commit"):
        raise ReleaseError("accepted application identity is not bound to the release commit")
    visual = validate_packaged_visual(
        read_json(visual_path), acceptance.get("commit"), identity.get("app_tree_sha256"), identity.get("executable_sha256"),
    )
    performance = validate_performance(
        read_json(performance_path), acceptance.get("commit"), identity.get("app_tree_sha256"), identity.get("executable_sha256"),
    )
    automated = acceptance.get("test_results", [])
    automated_names = [item.get("name") for item in automated]
    if set(automated_names) != REQUIRED_AUTOMATED_CHECKS or len(automated_names) != len(REQUIRED_AUTOMATED_CHECKS):
        raise ReleaseError("automated acceptance checks do not match the required personal release set")
    if any(item.get("status") != "pass" for item in automated):
        raise ReleaseError("one or more required automated acceptance checks did not pass")
    manual = read_json(manual_path).get("checks", [])
    required_names = {item.get("name") for item in acceptance.get("manual_checks", [])}
    supplied = {item.get("name"): item for item in manual}
    if set(supplied) != required_names:
        raise ReleaseError("manual acceptance evidence names do not exactly match the required checks")
    incomplete = []
    for name in sorted(required_names):
        item = supplied[name]
        timestamp = item.get("checked_at")
        try:
            parsed = datetime.fromisoformat(str(timestamp).replace("Z", "+00:00"))
        except ValueError:
            parsed = None
        if item.get("status") != "pass" or item.get("evidence") in (None, "", [], {}) or parsed is None or parsed.tzinfo is None:
            incomplete.append(name)
    if incomplete:
        raise ReleaseError("manual acceptance evidence is incomplete: " + ", ".join(incomplete))
    acceptance["packaged_visual"] = visual
    acceptance["performance"] = performance
    acceptance["manual_checks"] = [supplied[name] for name in sorted(required_names)]
    acceptance["verdict"] = "pass"
    validate_acceptance_payload(acceptance)
    acceptance_path.write_text(json.dumps(acceptance, indent=2) + "\n", encoding="utf-8")
    return acceptance


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--acceptance", type=Path, default=EVIDENCE / "macos-acceptance.json")
    parser.add_argument("--visual", type=Path, default=EVIDENCE / "packaged-visual" / "packaged-visual-manifest.json")
    parser.add_argument("--performance", type=Path, default=EVIDENCE / "packaged-performance.json")
    parser.add_argument("--manual", type=Path, default=EVIDENCE / "manual-checks.json")
    args = parser.parse_args()
    payload = finalize(args.acceptance, args.visual, args.performance, args.manual)
    print(json.dumps({"verdict": payload["verdict"], "acceptance": str(args.acceptance)}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ReleaseError as error:
        print(f"finalize-macos-acceptance: {error}")
        raise SystemExit(1)
