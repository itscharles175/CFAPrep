from __future__ import annotations

import importlib.util
import sys
from argparse import Namespace
from datetime import datetime, timezone
from pathlib import Path

from app import trust as trust_mod


def _load_release_local():
    path = Path(__file__).resolve().parents[3] / "scripts" / "release_local.py"
    spec = importlib.util.spec_from_file_location("release_local", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _args(**overrides):
    base = {
        "skip_e2e": False,
        "skip_electron": False,
        "skip_sidecar_build": False,
        "skip_packaged_smoke": False,
        "electron_debug": False,
    }
    base.update(overrides)
    return Namespace(**base)


def test_release_local_full_plan_matches_trust_required_labels():
    release_local = _load_release_local()

    checks = release_local.planned_checks(
        _args(),
        py="python",
        node="node",
        npm="npm",
    )
    labels = [check.label for check in checks]
    explanation = next(
        check for check in checks if check.label == "explanation golden floor"
    )
    explanation_step = explanation.steps[0]

    assert explanation_step.args == [
        "python",
        "-m",
        "app.eval",
        "--release-floor",
        "--check",
        "--seed",
    ]
    assert "LSATLAB_DATA_DIR" in explanation_step.env

    prompt_floor = next(
        check for check in checks if check.label == "prompt regression fixture floor"
    )
    assert prompt_floor.steps[0].args == [
        "node",
        "--import",
        "./scripts/register-ts-loader.mjs",
        "scripts/prompt-regression-fixture-floor.mjs",
    ]
    assert prompt_floor.steps[1].args == [
        "python",
        "-m",
        "app.prompt_contracts",
        "--check",
    ]
    assert prompt_floor.steps[1].cwd == release_local.BACKEND_DIR
    assert prompt_floor.steps[1].env["PYTHONPATH"] == str(release_local.BACKEND_DIR)

    assert labels[: len(release_local.REQUIRED_RELEASE_LOCAL_LABELS)] == list(
        release_local.REQUIRED_RELEASE_LOCAL_LABELS
    )
    assert "frontend playwright e2e" in labels
    assert "backend sidecar build" in labels
    assert "release signing preflight" in labels
    assert "electron build" in labels
    assert "packaged app smoke" in labels
    assert "release signing evidence" in labels
    assert "release manifest/SBOM" in labels
    assert labels.index("release signing preflight") < labels.index("electron build")
    assert labels.index("electron build") < labels.index("release signing evidence")
    signing_preflight = next(check for check in checks if check.label == "release signing preflight")
    assert "--config-output" in signing_preflight.steps[0].args
    signing_evidence = next(check for check in checks if check.label == "release signing evidence")
    assert "--bundle-root" in signing_evidence.steps[0].args
    manifest = next(check for check in checks if check.label == "release manifest/SBOM")
    assert manifest.steps[0].env["STUDYVAULT_SIGNING_EVIDENCE"] == str(
        release_local.SIGNING_EVIDENCE
    )
    for label in (
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
    ):
        assert label in labels
    assert labels.index("generation quality regression floor") < labels.index("backend pytest")
    assert labels.index("explanation golden floor") < labels.index("backend pytest")
    assert labels.index("prompt regression fixture floor") < labels.index("backend pytest")
    assert labels.index("rag retrieval-eval floor") < labels.index("backend pytest")
    assert labels.index("citation faithfulness floor") < labels.index("backend pytest")
    assert labels.index("source-grounded answer benchmark floor") < labels.index("backend pytest")
    assert labels.index("generated content gate floor") < labels.index("backend pytest")
    assert labels.index("host mutation score gate") > labels.index("lsat test")
    assert labels.index("backend mutation score gate") > labels.index("host mutation score gate")


def test_release_local_required_labels_match_trust_manifest_contract():
    release_local = _load_release_local()

    assert tuple(release_local.REQUIRED_RELEASE_LOCAL_LABELS) == trust_mod.REQUIRED_RELEASE_LOCAL_LABELS


def test_release_local_skip_flags_omit_only_optional_heavy_legs():
    release_local = _load_release_local()

    labels = [
        check.label
        for check in release_local.planned_checks(
            _args(skip_e2e=True, skip_electron=True, skip_sidecar_build=True, skip_packaged_smoke=True),
            py="python",
            node="node",
            npm="npm",
        )
    ]

    assert labels[: len(release_local.REQUIRED_RELEASE_LOCAL_LABELS)] == list(
        release_local.REQUIRED_RELEASE_LOCAL_LABELS
    )
    assert "frontend playwright e2e" not in labels
    assert "backend sidecar build" not in labels
    assert "release signing preflight" not in labels
    assert "electron build" not in labels
    assert "packaged app smoke" not in labels
    assert "release signing evidence" not in labels
    assert "release manifest/SBOM" not in labels
    assert "dependency audit" in labels
    assert "generation quality regression floor" in labels
    assert "explanation golden floor" in labels
    assert "prompt regression fixture floor" in labels
    assert "rag retrieval-eval floor" in labels
    assert "citation faithfulness floor" in labels
    assert "source-grounded answer benchmark floor" in labels
    assert "generated content gate floor" in labels
    assert "vault archive restore drill" in labels


def test_release_local_inline_python_preserves_nested_indentation():
    release_local = _load_release_local()

    code = release_local._py_code(
        """
        with object():
            print('inside')
        """
    )

    assert code.splitlines() == ["with object():", "    print('inside')"]


def test_release_local_report_payload_records_summary_and_options(monkeypatch):
    release_local = _load_release_local()
    monkeypatch.setattr(
        release_local,
        "git_info",
        lambda: {"head": "abc", "branch": "unit", "dirty": False, "status_lines": []},
    )
    monkeypatch.setattr(release_local, "_node_version", lambda node="node": "v24.0.0")

    payload = release_local.report_payload(
        checks=[
            {"label": "backend compile", "status": "passed", "timed_out": False},
            {"label": "frontend lint", "status": "failed", "timed_out": True},
        ],
        options={
            "skip_e2e": True,
            "skip_electron": True,
            "skip_sidecar_build": True,
            "skip_packaged_smoke": True,
        },
        started_at=datetime(2026, 7, 5, tzinfo=timezone.utc),
        duration_s=1.25,
    )

    assert payload["schema"] == "lsatlab.release_local_report.v1"
    assert payload["status"] == "failed"
    assert payload["summary"] == {"passed": 1, "failed": 1, "timed_out": 1, "total": 2}
    assert payload["options"]["skip_e2e"] is True
    assert payload["git"]["head"] == "abc"


def test_release_local_trust_snapshot_runs_check_mode(monkeypatch, tmp_path):
    release_local = _load_release_local()
    captured = {}

    def fake_run_step(step, timeout):
        captured["step"] = step
        captured["timeout"] = timeout
        return {"exit_code": 0, "timed_out": False}

    monkeypatch.setattr(release_local, "_run_step", fake_run_step)

    result = release_local.write_trust_snapshot(
        tmp_path / "release_local_report.json",
        tmp_path / "release_trust.json",
        "release",
        "python",
        30,
    )

    assert result["exit_code"] == 0
    assert captured["timeout"] == 30
    assert captured["step"].args[-1] == "--check"
    assert captured["step"].env["LSATLAB_RELEASE_LOCAL_REPORT"].endswith("release_local_report.json")


def test_release_local_run_check_records_spawn_failure():
    release_local = _load_release_local()

    result = release_local.run_check(
        release_local.Check(
            "missing executable",
            [release_local.Step(["definitely-missing-studyvault-command"])],
        ),
        timeout=5,
    )

    assert result["status"] == "failed"
    assert result["exit_code"] is None
    assert result["steps"][0]["stderr_tail"]


def test_packaged_smoke_uses_electron_resources_layout():
    release_local = _load_release_local()

    services_dir = release_local._packaged_services_dir(False)

    assert services_dir == release_local.REPO_ROOT / "release" / "resources" / "services"
    assert release_local._lsat_sidecar_path(services_dir).parent.name == "lsat-backend"
    assert "release/*.msi" in release_local._packaged_bundle_patterns(False)


def test_packaged_smoke_log_failure_catches_startup_errors():
    release_local = _load_release_local()

    assert release_local._packaged_smoke_log_failure("sidecar: boot status = error", "") is not None
    assert release_local._packaged_smoke_log_failure("sidecar: LSAT backend failed to start: missing", "") is not None
    assert release_local._packaged_smoke_log_failure("sidecar: boot status = degraded", "") is None


def test_packaged_smoke_cleanup_waits_for_all_owned_ports(monkeypatch):
    release_local = _load_release_local()

    monkeypatch.setattr(release_local, "_is_port_open", lambda port: port in {5055, 8000})

    assert release_local._wait_for_ports_closed([8100, 8000, 5055, 8000], timeout=0) == [5055, 8000]
