"""Run the local release gate and write release evidence.

This is the evidence producer consumed by
``services/lsat-backend/app/trust.py::_release_local_check``. It intentionally
records the exact command labels, skip flags, git state, timings, and failures
instead of relying on a human-readable terminal log.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
import textwrap
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib import error as urlerror
from urllib import request as urlrequest


REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "services" / "lsat-backend"
DIST_DIR = REPO_ROOT / "dist"
DEFAULT_REPORT = DIST_DIR / "release_local_report.json"
DEFAULT_TRUST = DIST_DIR / "release_trust.json"
PACKAGED_SMOKE_PORTS = (8000, 5055, 8100)
PACKAGED_SMOKE_HEALTH_URL = "http://127.0.0.1:8100/api/health"
WINDOWS_SIGNING_CONFIG = DIST_DIR / "windows-signing-config.json"
SIGNING_EVIDENCE = DIST_DIR / "signing-evidence-local.json"

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


@dataclass(frozen=True)
class Step:
    args: list[str]
    cwd: Path = REPO_ROOT
    env: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Check:
    label: str
    steps: list[Step]


def _npm() -> str:
    return "npm.cmd" if os.name == "nt" else "npm"


def _npx() -> str:
    return "npx.cmd" if os.name == "nt" else "npx"


def _python() -> str:
    return sys.executable


def _signing_platform() -> str:
    if sys.platform == "win32":
        return "windows"
    if sys.platform == "darwin":
        return "macos"
    if sys.platform.startswith("linux"):
        return "linux"
    raise RuntimeError(f"unsupported release signing platform: {sys.platform}")


def _backend_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    env = {"PYTHONPATH": str(BACKEND_DIR)}
    if extra:
        env.update(extra)
    return env


def _py_code(source: str) -> str:
    return textwrap.dedent(source).strip()


def _base_checks(py: str, node: str, npm: str) -> list[Check]:
    route_contract = _py_code(
        """
        from app.main import app
        spec = app.openapi()
        required = ['/api/ready', '/api/adaptivity/ability', '/api/readiness', '/api/content/health', '/api/observability/trust']
        missing = [path for path in required if path not in spec['paths']]
        assert not missing, missing
        assert 'ErrorEnvelope' in spec['components']['schemas']
        print(len(app.routes), 'routes')
        """
    )
    benchmark_smoke = _py_code(
        """
        from sqlmodel import Session
        from app.db import engine, init_db
        from app import jobs
        init_db()
        with Session(engine) as session:
            result = jobs.run_benchmark_smoke(session, notes='release_local')
        assert result['status'] == 'ok', result
        print(result['kind'], result['status'])
        """
    )
    scheduler_smoke = _py_code(
        """
        from sqlmodel import Session
        from app.db import engine, init_db
        from app import jobs
        init_db()
        with Session(engine) as session:
            jobs.ensure_default_schedules(session)
            result = jobs.run_scheduled_task(session, 'generation_gate_eval')
        assert result['ok'] is True, result
        print('generation_gate_eval', result['ok'])
        """
    )
    generation_quality_floor = _py_code(
        """
        from sqlmodel import Session
        from app.db import engine, init_db
        from app import jobs
        init_db()
        with Session(engine) as session:
            result = jobs.run_generation_gate_eval(session, notes='release_local')
        metrics = result['metrics']
        assert result['status'] == 'ok', result
        assert metrics['generation_quality_cases'] >= 3, metrics
        assert metrics['generation_quality_failed_cases'] == 0.0, metrics
        assert metrics['generation_quality_clean_pass'] >= 1.0, metrics
        assert metrics['generation_quality_trap_metadata_rejected'] >= 1.0, metrics
        assert metrics['generation_quality_weak_distractor_rejected'] >= 1.0, metrics
        print(result['kind'], result['status'], metrics['generation_quality_cases'])
        """
    )
    return [
        Check(
            "backend compile",
            [Step([py, "-m", "compileall", "-q", "app"], cwd=BACKEND_DIR, env=_backend_env())],
        ),
        Check(
            "backend route/import contract",
            [Step([py, "-c", route_contract], cwd=BACKEND_DIR, env=_backend_env())],
        ),
        Check(
            "OpenAPI drift",
            [Step([node, "scripts/export-lsat-openapi.mjs", "--check", "--python", py])],
        ),
        Check(
            "backend benchmark smoke",
            [Step([py, "-c", benchmark_smoke], cwd=BACKEND_DIR, env=_backend_env())],
        ),
        Check(
            "query plan budget",
            [Step([py, "-m", "pytest", "tests/test_backend_perf.py", "-q"], cwd=BACKEND_DIR, env=_backend_env())],
        ),
        Check(
            "scheduler evidence smoke",
            [Step([py, "-c", scheduler_smoke], cwd=BACKEND_DIR, env=_backend_env())],
        ),
        Check(
            "generation quality regression floor",
            [Step([py, "-c", generation_quality_floor], cwd=BACKEND_DIR, env=_backend_env())],
        ),
        Check(
            "explanation golden floor",
            [
                Step(
                    [py, "-m", "app.eval", "--release-floor", "--check", "--seed"],
                    cwd=BACKEND_DIR,
                    env=_backend_env({"LSATLAB_DATA_DIR": str(DIST_DIR / "release-local-explanation-gate")}),
                )
            ],
        ),
        Check(
            "prompt regression fixture floor",
            [
                Step([node, "--import", "./scripts/register-ts-loader.mjs", "scripts/prompt-regression-fixture-floor.mjs"]),
                Step([py, "-m", "app.prompt_contracts", "--check"], cwd=BACKEND_DIR, env=_backend_env()),
            ],
        ),
        Check(
            "rag retrieval-eval floor",
            [Step([node, "--import", "./scripts/register-ts-loader.mjs", "scripts/rag-eval.mjs"])],
        ),
        Check(
            "citation faithfulness floor",
            [Step([node, "--import", "./scripts/register-ts-loader.mjs", "scripts/citation-faithfulness-eval.mjs"])],
        ),
        Check(
            "source-grounded answer benchmark floor",
            [Step([node, "--import", "./scripts/register-ts-loader.mjs", "scripts/source-grounded-answer-eval.mjs"])],
        ),
        Check(
            "generated content gate floor",
            [Step([node, "--import", "./scripts/register-ts-loader.mjs", "scripts/generated-content-gate-eval.mjs"])],
        ),
        Check(
            "backend pytest",
            [Step([py, "-m", "pytest", "-q"], cwd=BACKEND_DIR, env=_backend_env())],
        ),
        Check(
            "backend doctor",
            [Step([py, "-m", "app.doctor", "--soft"], cwd=BACKEND_DIR, env=_backend_env())],
        ),
        Check("frontend lint", [Step([npm, "run", "lint"])]),
        Check("frontend test", [Step([npm, "run", "test"])]),
        Check("frontend build", [Step([npm, "run", "build"])]),
    ]


def _static_release_checks(node: str, npm: str, npx: str) -> list[Check]:
    return [
        Check("version sync", [Step([npm, "run", "check:versions"])]),
        Check("frontend typecheck", [Step([npx, "tsc", "--noEmit"])]),
        Check("lsat typecheck", [Step([npm, "run", "typecheck:lsat"])]),
        Check("lsat test", [Step([npm, "run", "test:lsat"])]),
        Check("host mutation score gate", [Step([npm, "run", "mutation:host"])]),
        Check("backend mutation score gate", [Step([npm, "run", "mutation:backend"])]),
        Check("bundle report", [Step([npm, "run", "bundle:report"])]),
        Check("route performance budget gate", [Step([npm, "run", "perf:regression"])]),
        Check("content validation", [Step([npm, "run", "content:validate"])]),
        Check("no-egress gate", [Step([npm, "run", "check:no-egress"])]),
        Check("direct sidecar fetch inventory gate", [Step([npm, "run", "check:sidecar-fetches"])]),
        Check("docs-drift gate", [Step([npm, "run", "check:docs"])]),
        Check("baseline catalog gate", [Step([npm, "run", "check:baselines"])]),
        Check("vault archive restore drill", [Step([npm, "run", "vault-archive:drill"])]),
        Check("dependency audit", [Step([npm, "audit", "--omit=dev", "--audit-level=high"])]),
    ]


def _optional_checks(args: argparse.Namespace, py: str, node: str, npm: str) -> list[Check]:
    checks: list[Check] = []
    if not args.skip_e2e:
        checks.append(Check("frontend playwright e2e", [Step([node, "scripts/e2e-integration.mjs"])]))
    if not args.skip_electron:
        if not args.skip_sidecar_build:
            checks.append(
                Check(
                    "backend sidecar build",
                    [
                        Step([npm, "run", "build:lsat-binary"]),
                        Step([npm, "run", "check:sidecar-provenance"]),
                    ],
                )
            )
        signing_platform = _signing_platform()
        if not args.electron_debug:
            checks.append(
                Check(
                    "release signing preflight",
                    [
                        Step(
                            [
                                node,
                                "scripts/release-signing.mjs",
                                "preflight",
                                "--platform",
                                signing_platform,
                                "--config-output",
                                str(WINDOWS_SIGNING_CONFIG),
                            ]
                        )
                    ],
                )
            )
        electron_script = "electron:build:debug" if args.electron_debug else "electron:build"
        electron_args = [npm, "run", electron_script]
        if not args.electron_debug and signing_platform == "windows":
            electron_args.extend(["--", "--config", str(WINDOWS_SIGNING_CONFIG)])
        checks.append(Check("electron build", [Step(electron_args)]))
        if not args.skip_packaged_smoke:
            internal = "_packaged_smoke_debug" if args.electron_debug else "_packaged_smoke"
            checks.append(Check("packaged app smoke", [Step([py, str(Path(__file__).resolve()), internal])]))
        if not args.electron_debug:
            checks.append(
                Check(
                    "release signing evidence",
                    [
                        Step(
                            [
                                node,
                                "scripts/release-signing.mjs",
                                "verify",
                                "--platform",
                                signing_platform,
                                "--bundle-root",
                                "release",
                                "--output",
                                str(SIGNING_EVIDENCE),
                            ]
                        )
                    ],
                )
            )
        manifest_args = [
            node,
            "scripts/release-manifest.mjs",
            "write",
            "--require-assets",
            "--require-sidecar-provenance",
        ]
        if args.electron_debug:
            manifest_args.append("--debug")
        manifest_env = {} if args.electron_debug else {"STUDYVAULT_SIGNING_EVIDENCE": str(SIGNING_EVIDENCE)}
        checks.append(Check("release manifest/SBOM", [Step(manifest_args, env=manifest_env)]))
    return checks


def planned_checks(
    args: argparse.Namespace,
    *,
    py: str | None = None,
    node: str = "node",
    npm: str | None = None,
    npx: str | None = None,
) -> list[Check]:
    """Return checks in the same label order consumed by release trust."""
    py = py or _python()
    npm = npm or _npm()
    npx = npx or _npx()
    return [
        *_base_checks(py, node, npm),
        *_static_release_checks(node, npm, npx),
        *_optional_checks(args, py, node, npm),
    ]


def _tail(text: str, limit: int = 4000) -> str:
    return text[-limit:] if len(text) > limit else text


def _run_step(step: Step, timeout: int) -> dict[str, Any]:
    env = os.environ.copy()
    for key, value in step.env.items():
        if key == "PYTHONPATH" and env.get("PYTHONPATH"):
            env[key] = f"{value}{os.pathsep}{env[key]}"
        else:
            env[key] = value
    started = time.monotonic()
    try:
        proc = subprocess.run(
            step.args,
            cwd=step.cwd,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        duration_s = round(time.monotonic() - started, 3)
        return {
            "command": step.args,
            "cwd": str(step.cwd),
            "exit_code": proc.returncode,
            "duration_s": duration_s,
            "timed_out": False,
            "stdout_tail": _tail(proc.stdout or ""),
            "stderr_tail": _tail(proc.stderr or ""),
        }
    except OSError as exc:
        duration_s = round(time.monotonic() - started, 3)
        return {
            "command": step.args,
            "cwd": str(step.cwd),
            "exit_code": None,
            "duration_s": duration_s,
            "timed_out": False,
            "stdout_tail": "",
            "stderr_tail": str(exc),
        }
    except subprocess.TimeoutExpired as exc:
        duration_s = round(time.monotonic() - started, 3)
        return {
            "command": step.args,
            "cwd": str(step.cwd),
            "exit_code": None,
            "duration_s": duration_s,
            "timed_out": True,
            "stdout_tail": _tail((exc.stdout or "") if isinstance(exc.stdout, str) else ""),
            "stderr_tail": _tail((exc.stderr or "") if isinstance(exc.stderr, str) else ""),
        }


def run_check(check: Check, timeout: int) -> dict[str, Any]:
    started = time.monotonic()
    step_results = []
    for step in check.steps:
        result = _run_step(step, timeout)
        step_results.append(result)
        if result["timed_out"] or result["exit_code"] != 0:
            break
    failed = [step for step in step_results if step["timed_out"] or step["exit_code"] != 0]
    return {
        "label": check.label,
        "status": "failed" if failed else "passed",
        "exit_code": failed[0]["exit_code"] if failed else 0,
        "duration_s": round(time.monotonic() - started, 3),
        "timed_out": bool(failed and failed[0]["timed_out"]),
        "steps": step_results,
    }


def git_info() -> dict[str, Any]:
    def run_git(*args: str) -> str:
        proc = subprocess.run(
            ["git", *args],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return proc.stdout.strip() if proc.returncode == 0 else ""

    status_lines = [line for line in run_git("status", "--short").splitlines() if line.strip()]
    return {
        "head": run_git("rev-parse", "HEAD") or None,
        "branch": run_git("branch", "--show-current") or None,
        "dirty": bool(status_lines),
        "status_lines": status_lines,
    }


def report_payload(
    *,
    checks: list[dict[str, Any]],
    options: dict[str, bool],
    started_at: datetime,
    duration_s: float,
    node: str = "node",
) -> dict[str, Any]:
    passed = sum(1 for item in checks if item.get("status") == "passed")
    failed = sum(1 for item in checks if item.get("status") == "failed")
    timed_out = sum(1 for item in checks if item.get("timed_out"))
    total = len(checks)
    return {
        "schema": "lsatlab.release_local_report.v1",
        "status": "passed" if failed == 0 and timed_out == 0 else "failed",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "started_at": started_at.isoformat(),
        "duration_s": round(duration_s, 3),
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "python": sys.version.split()[0],
            "node": _node_version(node),
        },
        "git": git_info(),
        "options": options,
        "summary": {
            "passed": passed,
            "failed": failed,
            "timed_out": timed_out,
            "total": total,
        },
        "checks": checks,
    }


def _node_version(node: str = "node") -> str | None:
    try:
        proc = subprocess.run([node, "--version"], cwd=REPO_ROOT, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return proc.stdout.strip() if proc.returncode == 0 else None


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_trust_snapshot(report_path: Path, trust_path: Path, tier: str, py: str, timeout: int) -> dict[str, Any]:
    env = {"PYTHONPATH": str(BACKEND_DIR), "LSATLAB_RELEASE_LOCAL_REPORT": str(report_path)}
    step = Step(
        [py, "-m", "app.trust", "--tier", tier, "--output", str(trust_path), "--check"],
        cwd=BACKEND_DIR,
        env=env,
    )
    return _run_step(step, timeout)


def _is_port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def _exe(name: str) -> str:
    return f"{name}.exe" if os.name == "nt" else name


def _electron_output_dir(debug: bool) -> Path:
    return REPO_ROOT / ("release-debug" if debug else "release")


def _electron_executable_candidates(debug: bool) -> list[Path]:
    output_dir = _electron_output_dir(debug)
    if os.name == "nt":
        return [
            output_dir / "win-unpacked" / "StudyVault.exe",
            output_dir / "win-arm64-unpacked" / "StudyVault.exe",
        ]
    if sys.platform == "darwin":
        candidates = [
            output_dir / "mac" / "StudyVault.app" / "Contents" / "MacOS" / "StudyVault",
            output_dir / "mac-arm64" / "StudyVault.app" / "Contents" / "MacOS" / "StudyVault",
        ]
        machine = platform.machine().lower()
        if machine in {"arm64", "aarch64"}:
            candidates.reverse()
        return candidates
    return [
        output_dir / "linux-unpacked" / "studyvault",
        output_dir / "linux-arm64-unpacked" / "studyvault",
    ]


def _resolve_electron_executable(debug: bool) -> Path | None:
    for path in _electron_executable_candidates(debug):
        if path.is_file() and path.stat().st_size > 0:
            return path
    return None


def _packaged_services_dir(debug: bool) -> Path:
    executable = _resolve_electron_executable(debug)
    if executable is None:
        return _electron_output_dir(debug) / "resources" / "services"
    if sys.platform == "darwin":
        return executable.parents[1] / "Resources" / "services"
    return executable.parent / "resources" / "services"


def _lsat_sidecar_path(services_dir: Path) -> Path:
    return services_dir / "lsat-backend" / _exe("lsatlab-backend")


def _packaged_bundle_patterns(debug: bool) -> list[str]:
    output = "release-debug" if debug else "release"
    return [
        f"{output}/*.exe",
        f"{output}/*.msi",
        f"{output}/*.dmg",
        f"{output}/*.AppImage",
        f"{output}/*.deb",
        f"{output}/win*-unpacked/StudyVault.exe",
        f"{output}/mac*/StudyVault.app/Contents/MacOS/StudyVault",
        f"{output}/linux*-unpacked/studyvault",
    ]


def _non_empty_bundle_artifacts(debug: bool) -> list[Path]:
    matches: list[str] = []
    for pattern in _packaged_bundle_patterns(debug):
        matches.extend(glob.glob(str(REPO_ROOT / pattern)))
    return [Path(match) for match in matches if Path(match).is_file() and Path(match).stat().st_size > 0]


def _poll_lsat_health(proc: subprocess.Popen[str], timeout: int = 120) -> tuple[bool, str]:
    deadline = time.monotonic() + timeout
    last_error = "health endpoint was not reached"
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return False, f"app exited early with code {proc.returncode}"
        try:
            with urlrequest.urlopen(PACKAGED_SMOKE_HEALTH_URL, timeout=2) as response:
                body = response.read().decode("utf-8", errors="replace")
            payload = json.loads(body)
            if (
                payload.get("ok") is True
                and payload.get("service") == "lsat-backend"
                and str(payload.get("version") or "").strip()
            ):
                return True, f"lsat-backend {payload['version']}"
            last_error = f"unexpected health payload: {body[:500]}"
        except (OSError, urlerror.URLError, json.JSONDecodeError) as exc:
            last_error = str(exc)
        time.sleep(1)
    return False, f"timed out waiting for {PACKAGED_SMOKE_HEALTH_URL}: {last_error}"


def _terminate_process_tree(proc: subprocess.Popen[str]) -> None:
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        try:
            proc.wait(timeout=5)
            return
        except subprocess.TimeoutExpired:
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                capture_output=True,
                text=True,
                timeout=15,
            )
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
            return
    proc.terminate()
    try:
        proc.wait(timeout=5)
        return
    except subprocess.TimeoutExpired:
        pass
    proc.kill()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass


def _wait_for_port_closed(port: int, timeout: int = 15) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _is_port_open(port):
            return True
        time.sleep(0.5)
    return not _is_port_open(port)


def _wait_for_ports_closed(ports: Iterable[int], timeout: int = 15) -> list[int]:
    expected = sorted(set(ports))
    deadline = time.monotonic() + timeout
    while True:
        still_open = [port for port in expected if _is_port_open(port)]
        if not still_open or time.monotonic() >= deadline:
            return still_open
        time.sleep(0.5)


PACKAGED_SMOKE_FATAL_LOG_MARKERS = (
    "boot status = error",
    "required sidecar(s) not ready",
    " failed to start:",
    "refused before launch by provenance check",
)
PACKAGED_SMOKE_STARTUP_SETTLE_SECONDS = 3


def _packaged_smoke_log_failure(stdout: str, stderr: str) -> str | None:
    combined = f"{stdout}\n{stderr}"
    for marker in PACKAGED_SMOKE_FATAL_LOG_MARKERS:
        if marker in combined:
            return f"startup log contains {marker!r}"
    return None


def _packaged_smoke(debug: bool = False) -> int:
    busy_ports = [port for port in PACKAGED_SMOKE_PORTS if _is_port_open(port)]
    if busy_ports:
        print(f"packaged smoke: ports already in use: {busy_ports}")
        return 1

    services_dir = _packaged_services_dir(debug)
    sidecar = _lsat_sidecar_path(services_dir)
    provenance = services_dir / "sidecar-provenance.json"
    missing = [path for path in (services_dir, sidecar, provenance) if not path.exists()]
    empty = [path for path in (sidecar, provenance) if path.exists() and path.is_file() and path.stat().st_size <= 0]
    if missing or empty:
        print("packaged smoke: packaged service resources are incomplete")
        for path in missing:
            print(f"  missing: {path.relative_to(REPO_ROOT)}")
        for path in empty:
            print(f"  empty: {path.relative_to(REPO_ROOT)}")
        return 1

    artifacts = _non_empty_bundle_artifacts(debug)
    if not artifacts:
        print("packaged smoke: no non-empty bundle artifacts found")
        return 1
    print(f"packaged smoke: {len(artifacts)} non-empty bundle artifact(s)")
    for item in artifacts[:20]:
        print(f"  - {item.relative_to(REPO_ROOT)} ({item.stat().st_size} bytes)")

    exe_path = _resolve_electron_executable(debug)
    if exe_path is None:
        print("packaged smoke: no unpacked Electron executable found")
        for candidate in _electron_executable_candidates(debug)[:10]:
            print(f"  candidate: {candidate.relative_to(REPO_ROOT)}")
        return 1

    data_parent = DIST_DIR if DIST_DIR.exists() else None
    data_dir = Path(tempfile.mkdtemp(prefix="packaged-smoke-lsat-", dir=str(data_parent) if data_parent else None))
    env = os.environ.copy()
    env.pop("QV_SERVICES_DIR", None)
    env["LSATLAB_DATA_DIR"] = str(data_dir)
    proc = subprocess.Popen(
        [str(exe_path)],
        cwd=exe_path.parent,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    ok = False
    detail = "not run"
    stdout = ""
    stderr = ""
    try:
        ok, detail = _poll_lsat_health(proc)
        if ok:
            print(f"packaged smoke: health verified ({detail})")
            time.sleep(PACKAGED_SMOKE_STARTUP_SETTLE_SECONDS)
        else:
            print(f"packaged smoke: {detail}")
    finally:
        _terminate_process_tree(proc)
        if proc.poll() is not None:
            try:
                stdout, stderr = proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                proc.stdout and proc.stdout.close()
                proc.stderr and proc.stderr.close()
                stdout, stderr = "", "packaged smoke log pipes did not close after process-tree termination"
        else:
            stdout, stderr = "", ""
        if stdout.strip():
            print("packaged smoke stdout tail:")
            print(_tail(stdout))
        if stderr.strip():
            print("packaged smoke stderr tail:")
            print(_tail(stderr))
        shutil.rmtree(data_dir, ignore_errors=True)

    if log_failure := _packaged_smoke_log_failure(stdout, stderr):
        print(f"packaged smoke: {log_failure}")
        return 1
    open_after_cleanup = _wait_for_ports_closed(PACKAGED_SMOKE_PORTS)
    if open_after_cleanup:
        print(f"packaged smoke: ports remained open after cleanup: {open_after_cleanup}")
        return 1
    return 0 if ok else 1


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run StudyVault local release gates.")
    parser.add_argument("_internal", nargs="?", default="")
    parser.add_argument("--timeout", type=int, default=3600, help="Per-step timeout in seconds.")
    parser.add_argument("--output", default=str(DEFAULT_REPORT))
    parser.add_argument("--trust-output", default=str(DEFAULT_TRUST))
    parser.add_argument("--trust-tier", choices=["dev", "release", "packaged"], default="release")
    parser.add_argument("--python", default=_python())
    parser.add_argument("--node", default="node")
    parser.add_argument("--npm", default=_npm())
    parser.add_argument("--npx", default=_npx())
    parser.add_argument("--continue-on-failure", action="store_true")
    parser.add_argument("--skip-e2e", action="store_true")
    parser.add_argument("--skip-electron", action="store_true")
    parser.add_argument("--skip-sidecar-build", action="store_true")
    parser.add_argument("--skip-packaged-smoke", action="store_true")
    parser.add_argument("--electron-debug", action="store_true", help="Use the unpacked Electron build for the desktop leg.")
    parser.add_argument("--dry-run", action="store_true", help="Print the planned labels and exit without writing reports.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if args._internal in {"_packaged_smoke", "_packaged_smoke_debug"}:
        return _packaged_smoke(debug=args._internal == "_packaged_smoke_debug")
    if args._internal:
        raise SystemExit(f"unknown internal command: {args._internal}")

    checks = planned_checks(args, py=args.python, node=args.node, npm=args.npm, npx=args.npx)
    if args.dry_run:
        for check in checks:
            print(check.label)
        return 0

    started_at = datetime.now(timezone.utc)
    started = time.monotonic()
    results: list[dict[str, Any]] = []
    for check in checks:
        print(f"\n== {check.label} ==")
        result = run_check(check, args.timeout)
        results.append(result)
        print(f"{result['status']} in {result['duration_s']}s")
        if result["status"] != "passed" and not args.continue_on_failure:
            break

    options = {
        "skip_e2e": bool(args.skip_e2e),
        "skip_electron": bool(args.skip_electron),
        "skip_sidecar_build": bool(args.skip_sidecar_build),
        "skip_packaged_smoke": bool(args.skip_packaged_smoke),
    }
    report = report_payload(
        checks=results,
        options=options,
        started_at=started_at,
        duration_s=time.monotonic() - started,
        node=args.node,
    )
    report_path = Path(args.output).resolve()
    trust_path = Path(args.trust_output).resolve()
    write_json(report_path, report)
    print(f"\nwrote {report_path}")

    trust_result = write_trust_snapshot(report_path, trust_path, args.trust_tier, args.python, args.timeout)
    if trust_path.exists():
        print(f"wrote {trust_path}")
    if trust_result["exit_code"] != 0:
        print(f"release trust check blocked or failed: {trust_result}")

    return 0 if report["status"] == "passed" and trust_result["exit_code"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
