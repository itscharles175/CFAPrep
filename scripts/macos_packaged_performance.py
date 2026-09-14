#!/usr/bin/env python3
"""Measure the real packaged StudyVault process on an isolated macOS profile.

Production defaults are acceptance thresholds, not convenient smoke-test values:
the idle CPU window is two minutes and the RSS soak is thirty minutes. Shorter
durations require ``--test-mode`` and are marked non-authoritative in the report.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence
from urllib import error as urlerror
from urllib import request as urlrequest


SCHEMA = "studyvault.packaged-performance.v1"
REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_APP = REPO_ROOT / "release-personal" / "mac-arm64" / "StudyVault.app"
DEFAULT_REPORT = REPO_ROOT / "release-personal" / "evidence" / "packaged-performance.json"
SIDECAR_PORTS = (8000, 5055, 8100)
LSAT_HEALTH_URL = "http://127.0.0.1:8100/api/health"


class HarnessError(RuntimeError):
    """An acceptance invariant could not be proven."""


@dataclass(frozen=True)
class Limits:
    visible_seconds: float = 5.0
    sidecar_seconds: float = 15.0
    idle_cpu_seconds: float = 120.0
    idle_cpu_percent: float = 3.0
    rss_soak_seconds: float = 1800.0
    rss_growth_percent: float = 15.0
    settle_seconds: float = 15.0
    sample_interval_seconds: float = 5.0
    shutdown_seconds: float = 20.0


@dataclass(frozen=True)
class ProcessSample:
    elapsed_seconds: float
    process_count: int
    aggregate_cpu_percent: float
    aggregate_rss_bytes: int


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def resolve_app_executable(app: Path) -> Path:
    candidate = app / "Contents" / "MacOS" / "StudyVault" if app.suffix == ".app" else app
    if not candidate.is_file():
        raise HarnessError(f"packaged StudyVault executable does not exist: {candidate}")
    if not os.access(candidate, os.X_OK):
        raise HarnessError(f"packaged StudyVault executable is not executable: {candidate}")
    return candidate.resolve()


def resolve_app_bundle(app: Path, executable: Path) -> Path:
    candidates = (app.resolve(), *executable.parents)
    for candidate in candidates:
        if candidate.suffix == ".app" and candidate.is_dir():
            return candidate
    raise HarnessError("native Quit evidence requires an exact .app bundle path")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def bundle_tree_digest(app_bundle: Path) -> tuple[str, int, int]:
    digest = hashlib.sha256()
    total_bytes = 0
    file_count = 0
    files = sorted(path for path in app_bundle.rglob("*") if path.is_file() and not path.is_symlink())
    for path in files:
        size = path.stat().st_size
        relative = path.relative_to(app_bundle).as_posix()
        digest.update(f"{relative}\0{sha256_file(path)}\0{size}\n".encode())
        total_bytes += size
        file_count += 1
    if not files:
        raise HarnessError("packaged application bundle contains no files")
    return digest.hexdigest(), file_count, total_bytes


def git_state() -> tuple[str, bool]:
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, check=False, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    if commit.returncode != 0 or not commit.stdout.strip():
        raise HarnessError(f"could not identify release commit: {commit.stdout.strip()}")
    status = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=normal"], cwd=REPO_ROOT,
        check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    if status.returncode != 0:
        raise HarnessError(f"could not inspect release working tree: {status.stdout.strip()}")
    return commit.stdout.strip(), not bool(status.stdout.strip())


def verify_arm64_macho(executable: Path, *, runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run) -> str:
    result = runner(["file", "-b", str(executable)], check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    description = result.stdout.strip()
    if result.returncode != 0 or "Mach-O" not in description or "arm64" not in description:
        raise HarnessError(f"expected an arm64 Mach-O application executable; found: {description or 'unidentified file'}")
    return description


def ensure_production_durations(limits: Limits, *, test_mode: bool) -> None:
    if test_mode:
        for name in ("visible_seconds", "sidecar_seconds", "idle_cpu_seconds", "rss_soak_seconds", "sample_interval_seconds"):
            if getattr(limits, name) <= 0:
                raise HarnessError(f"{name} must be positive")
        return
    minimums = {
        "visible_seconds": 5.0,
        "sidecar_seconds": 15.0,
        "idle_cpu_seconds": 120.0,
        "rss_soak_seconds": 1800.0,
    }
    shortened = [f"{name}={getattr(limits, name):g} (minimum {minimum:g})" for name, minimum in minimums.items() if getattr(limits, name) < minimum]
    if shortened:
        raise HarnessError("production acceptance durations cannot be shortened: " + ", ".join(shortened))


def port_is_open(port: int, timeout: float = 0.2) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(timeout)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def occupied_ports(ports: Iterable[int] = SIDECAR_PORTS) -> list[int]:
    return [port for port in ports if port_is_open(port)]


def parse_ps_rows(output: str) -> dict[int, tuple[int, float, int]]:
    rows: dict[int, tuple[int, float, int]] = {}
    for raw in output.splitlines():
        fields = raw.strip().split(None, 4)
        if len(fields) < 4:
            continue
        try:
            pid, ppid = int(fields[0]), int(fields[1])
            cpu, rss_kib = float(fields[2]), int(fields[3])
        except ValueError:
            continue
        rows[pid] = (ppid, cpu, rss_kib)
    return rows


def descendant_pids(rows: dict[int, tuple[int, float, int]], root_pid: int) -> set[int]:
    found = {root_pid} if root_pid in rows else set()
    changed = True
    while changed:
        changed = False
        for pid, (ppid, _cpu, _rss) in rows.items():
            if pid not in found and ppid in found:
                found.add(pid)
                changed = True
    return found


def sample_process_tree(root_pid: int, elapsed: float) -> tuple[ProcessSample, set[int]]:
    result = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,%cpu=,rss=,command="],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if result.returncode != 0:
        raise HarnessError(f"could not sample process tree: {result.stdout.strip()}")
    rows = parse_ps_rows(result.stdout)
    pids = descendant_pids(rows, root_pid)
    if root_pid not in pids:
        raise HarnessError("packaged application exited during performance sampling")
    cpu = sum(rows[pid][1] for pid in pids)
    rss_bytes = sum(rows[pid][2] for pid in pids) * 1024
    return ProcessSample(round(elapsed, 3), len(pids), round(cpu, 3), rss_bytes), pids


def _endpoint_hosts(endpoint: str) -> list[str]:
    text = endpoint.split(" ", 1)[0]
    hosts: list[str] = []
    for half in text.split("->"):
        if half.startswith("[") and "]:" in half:
            hosts.append(half[1 : half.index("]:")])
        elif ":" in half:
            hosts.append(half.rsplit(":", 1)[0])
        else:
            hosts.append(half)
    return hosts


def endpoint_is_loopback(endpoint: str) -> bool:
    allowed = {"127.0.0.1", "::1", "localhost"}
    hosts = _endpoint_hosts(endpoint)
    return bool(hosts) and all(host.lower() in allowed for host in hosts)


def tcp_endpoints_for_pids(pids: Iterable[int]) -> list[dict[str, Any]]:
    endpoints: list[dict[str, Any]] = []
    for pid in sorted(set(pids)):
        result = subprocess.run(
            ["lsof", "-nP", "-a", "-p", str(pid), "-iTCP", "-FnT"],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        if result.returncode not in (0, 1):
            raise HarnessError(f"lsof failed for process {pid}: {result.stdout.strip()}")
        current_name: str | None = None
        current_state: str | None = None
        for line in [*result.stdout.splitlines(), "n"]:
            if line.startswith("n"):
                if current_name is not None:
                    endpoints.append({"pid": pid, "endpoint": current_name, "state": current_state})
                current_name = line[1:] or None
                current_state = None
            elif line.startswith("TST="):
                current_state = line.removeprefix("TST=")
    return endpoints


def assert_loopback_only(endpoints: Sequence[dict[str, Any]]) -> None:
    external = [row for row in endpoints if not endpoint_is_loopback(str(row.get("endpoint", "")))]
    if external:
        examples = ", ".join(str(row["endpoint"]) for row in external[:5])
        raise HarnessError(f"packaged process tree opened non-loopback TCP sockets: {examples}")


def visible_window_probe(pid: int) -> bool:
    script = (
        'tell application "System Events" to tell '
        f'(first application process whose unix id is {pid}) to return '
        '(exists (first window whose visible is true))'
    )
    result = subprocess.run(
        ["osascript", "-e", script],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if result.returncode != 0:
        raise HarnessError(
            "visible-window proof failed; System Events must be able to inspect the launched StudyVault process: "
            + result.stdout.strip()
        )
    return result.stdout.strip().lower() == "true"


def wait_for_visible_window(pid: int, timeout: float, probe: Callable[[int], bool] = visible_window_probe) -> float:
    started = time.monotonic()
    deadline = started + timeout
    while time.monotonic() <= deadline:
        if probe(pid):
            return time.monotonic() - started
        time.sleep(min(0.1, max(timeout / 20, 0.01)))
    raise HarnessError(f"no visible StudyVault window appeared within {timeout:g}s")


def wait_for_lsat_health(timeout: float) -> tuple[float, str]:
    started = time.monotonic()
    deadline = started + timeout
    last_error = "health endpoint was not reached"
    while time.monotonic() <= deadline:
        try:
            with urlrequest.urlopen(LSAT_HEALTH_URL, timeout=min(0.75, max(timeout, 0.05))) as response:
                payload = json.loads(response.read().decode("utf-8", errors="replace"))
            if payload.get("ok") is True and payload.get("service") == "lsat-backend" and str(payload.get("version") or "").strip():
                return time.monotonic() - started, str(payload["version"])
            last_error = "health response did not identify a ready lsat-backend"
        except (OSError, TimeoutError, urlerror.URLError, json.JSONDecodeError) as error:
            last_error = str(error)
        time.sleep(min(0.2, max(timeout / 20, 0.01)))
    raise HarnessError(f"LSAT sidecar was not healthy within {timeout:g}s: {last_error}")


def summarize_samples(samples: Sequence[ProcessSample], limits: Limits) -> dict[str, Any]:
    if not samples:
        raise HarnessError("performance sampling produced no evidence")
    cpu_samples = [sample for sample in samples if sample.elapsed_seconds <= limits.idle_cpu_seconds]
    if not cpu_samples:
        raise HarnessError("idle CPU sampling window produced no evidence")
    average_cpu = sum(sample.aggregate_cpu_percent for sample in cpu_samples) / len(cpu_samples)
    baseline = samples[0].aggregate_rss_bytes
    final = samples[-1].aggregate_rss_bytes
    if baseline <= 0:
        raise HarnessError("RSS baseline was zero")
    growth = ((final - baseline) / baseline) * 100
    return {
        "average_idle_cpu_percent": round(average_cpu, 3),
        "rss_baseline_bytes": baseline,
        "rss_final_bytes": final,
        "rss_peak_bytes": max(sample.aggregate_rss_bytes for sample in samples),
        "rss_growth_percent": round(growth, 3),
        "samples": len(samples),
    }


def wait_for_ports_closed(timeout: float, ports: Iterable[int] = SIDECAR_PORTS) -> list[int]:
    deadline = time.monotonic() + timeout
    while time.monotonic() <= deadline:
        open_ports = occupied_ports(ports)
        if not open_ports:
            return []
        time.sleep(0.2)
    return occupied_ports(ports)


def native_application_quit(
    app_bundle: Path,
    process: subprocess.Popen[bytes],
    timeout: float,
    *,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> tuple[bool, str]:
    """Request Quit through the exact bundle's Apple event interface."""
    if process.poll() is not None:
        return False, "application exited before native Quit was requested"
    escaped = str(app_bundle).replace("\\", "\\\\").replace('"', '\\"')
    script = f'tell application "{escaped}" to quit'
    result = runner(
        ["osascript", "-e", script],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=min(timeout, 10),
    )
    if result.returncode != 0:
        return False, f"native Quit Apple event failed: {result.stdout.strip()}"
    try:
        process.wait(timeout=timeout)
        return True, "native Quit Apple event completed and the application exited"
    except subprocess.TimeoutExpired:
        return False, "application did not exit after the native Quit Apple event"


def cleanup_process_group(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass


def isolated_environment(root: Path) -> tuple[dict[str, str], Path]:
    home = root / "home"
    user_data = root / "user-data"
    temp = root / "tmp"
    for directory in (home, user_data, temp):
        directory.mkdir(parents=True, exist_ok=False)
    env = os.environ.copy()
    for name in (
        "QV_SERVICES_DIR", "QV_OPEN_NOTEBOOK_DEV_DIR", "QV_ALLOW_UV_DEVELOPMENT_FALLBACK",
        "LSATLAB_DATA_DIR", "LSATLAB_DB_KEY_B64", "LSATLAB_LOCAL_API_TOKEN",
        "VITE_DEV_SERVER_URL", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS",
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
    ):
        env.pop(name, None)
    env.update({
        "HOME": str(home),
        "TMPDIR": str(temp) + os.sep,
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_CACHE_HOME": str(home / ".cache"),
        "NO_PROXY": "localhost,127.0.0.1,::1",
        "no_proxy": "localhost,127.0.0.1,::1",
    })
    return env, user_data


def run_harness(app: Path, report_path: Path, limits: Limits, *, test_mode: bool = False) -> dict[str, Any]:
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise HarnessError("packaged performance acceptance requires Apple Silicon macOS")
    for command in ("file", "lsof", "osascript", "ps"):
        if shutil.which(command) is None:
            raise HarnessError(f"required macOS measurement tool is unavailable: {command}")
    ensure_production_durations(limits, test_mode=test_mode)
    executable = resolve_app_executable(app)
    app_bundle = resolve_app_bundle(app, executable)
    macho = verify_arm64_macho(executable)
    tree_sha256, bundle_file_count, bundle_bytes = bundle_tree_digest(app_bundle)
    commit, working_tree_clean = git_state()
    if not test_mode and not working_tree_clean:
        raise HarnessError("authoritative packaged performance evidence requires a clean final commit")
    busy = occupied_ports()
    if busy:
        raise HarnessError(f"configured sidecar ports are already occupied; refusing to launch or kill them: {busy}")

    report_path.parent.mkdir(parents=True, exist_ok=True)
    log_path = report_path.with_name("packaged-performance-process.log")
    isolation_root = Path(tempfile.mkdtemp(prefix="studyvault-performance-"))
    process: subprocess.Popen[bytes] | None = None
    failure: BaseException | None = None
    native_quit_succeeded = False
    ports_after: list[int] = []
    try:
        env, user_data = isolated_environment(isolation_root)
        command = [str(executable), f"--user-data-dir={user_data}"]
        started = time.monotonic()
        with log_path.open("wb") as process_log:
            process = subprocess.Popen(
                command,
                cwd=executable.parent,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=process_log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            visible = wait_for_visible_window(process.pid, limits.visible_seconds)
            if visible > limits.visible_seconds:
                raise HarnessError(
                    f"visible StudyVault window took {visible:.3f}s, above the {limits.visible_seconds:g}s limit"
                )
            sidecar, sidecar_version = wait_for_lsat_health(limits.sidecar_seconds)
            if sidecar > limits.sidecar_seconds:
                raise HarnessError(
                    f"LSAT sidecar health took {sidecar:.3f}s, above the {limits.sidecar_seconds:g}s limit"
                )
            time.sleep(limits.settle_seconds)
            sampling_started = time.monotonic()
            samples: list[ProcessSample] = []
            endpoint_set: dict[tuple[int, str, str | None], dict[str, Any]] = {}
            while True:
                elapsed = time.monotonic() - sampling_started
                sample, pids = sample_process_tree(process.pid, elapsed)
                samples.append(sample)
                endpoints = tcp_endpoints_for_pids(pids)
                assert_loopback_only(endpoints)
                for row in endpoints:
                    endpoint_set[(row["pid"], row["endpoint"], row["state"])] = row
                if elapsed >= limits.rss_soak_seconds:
                    break
                time.sleep(min(limits.sample_interval_seconds, limits.rss_soak_seconds - elapsed))
            metrics = summarize_samples(samples, limits)
            if metrics["average_idle_cpu_percent"] >= limits.idle_cpu_percent:
                raise HarnessError(
                    f"average idle CPU {metrics['average_idle_cpu_percent']:.3f}% did not remain below {limits.idle_cpu_percent:g}%"
                )
            if metrics["rss_growth_percent"] > limits.rss_growth_percent:
                raise HarnessError(
                    f"RSS grew {metrics['rss_growth_percent']:.3f}%, above the {limits.rss_growth_percent:g}% ceiling"
                )
            payload = {
                "schema": SCHEMA,
                "generated_at": utc_now(),
                "authoritative": not test_mode,
                "test_mode": test_mode,
                "status": "pass",
                "source": {"commit": commit, "working_tree_clean": working_tree_clean},
                "artifact": {
                    "name": app_bundle.name,
                    "executable": "Contents/MacOS/StudyVault",
                    "file": macho,
                    "executable_sha256": sha256_file(executable),
                    "bundle_tree_sha256": tree_sha256,
                    "bundle_file_count": bundle_file_count,
                    "bundle_bytes": bundle_bytes,
                },
                "isolation": {"fresh_home": True, "fresh_user_data": True, "live_profile_used": False},
                "startup": {
                    "window_visible_seconds": round(visible, 3),
                    "window_limit_seconds": limits.visible_seconds,
                    "lsat_healthy_seconds": round(sidecar, 3),
                    "lsat_limit_seconds": limits.sidecar_seconds,
                    "lsat_version": sidecar_version,
                },
                "performance": {**metrics, "limits": asdict(limits)},
                "network": {
                    "policy": "loopback-only",
                    "observed_tcp_endpoints": sorted(endpoint_set.values(), key=lambda row: (row["pid"], row["endpoint"])),
                    "non_loopback_count": 0,
                },
                "shutdown": {
                    "request": "native-apple-event-quit",
                    "native_quit": None,
                    "detail": None,
                    "owned_ports_closed": None,
                },
                "process_log": log_path.name,
                "measurement_seconds": round(time.monotonic() - started, 3),
            }
        assert process is not None
        native_quit_succeeded, quit_detail = native_application_quit(app_bundle, process, limits.shutdown_seconds)
        ports_after = wait_for_ports_closed(limits.shutdown_seconds)
        payload["shutdown"] = {
            "request": "native-apple-event-quit",
            "native_quit": native_quit_succeeded,
            "detail": quit_detail,
            "owned_ports_closed": not ports_after,
            "open_ports": ports_after,
        }
        if not native_quit_succeeded:
            raise HarnessError(quit_detail)
        if ports_after:
            raise HarnessError(f"owned sidecar ports remained open after normal quit: {ports_after}")
        report_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        return payload
    except BaseException as error:
        failure = error
        report_path.write_text(
            json.dumps(
                {
                    "schema": SCHEMA,
                    "generated_at": utc_now(),
                    "authoritative": not test_mode,
                    "test_mode": test_mode,
                    "status": "fail",
                    "error": str(error),
                    "isolation": {"fresh_home": True, "fresh_user_data": True, "live_profile_used": False},
                    "process_log": log_path.name,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        raise
    finally:
        if process is not None and (process.poll() is None or not native_quit_succeeded):
            cleanup_process_group(process)
        if failure is not None:
            wait_for_ports_closed(5)
        shutil.rmtree(isolation_root, ignore_errors=True)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, default=DEFAULT_APP)
    parser.add_argument("--output", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--test-mode", action="store_true", help="mark evidence non-authoritative and allow shortened durations")
    parser.add_argument("--visible-seconds", type=float, default=Limits.visible_seconds)
    parser.add_argument("--sidecar-seconds", type=float, default=Limits.sidecar_seconds)
    parser.add_argument("--idle-cpu-seconds", type=float, default=Limits.idle_cpu_seconds)
    parser.add_argument("--rss-soak-seconds", type=float, default=Limits.rss_soak_seconds)
    parser.add_argument("--settle-seconds", type=float, default=Limits.settle_seconds)
    parser.add_argument("--sample-interval-seconds", type=float, default=Limits.sample_interval_seconds)
    parser.add_argument("--shutdown-seconds", type=float, default=Limits.shutdown_seconds)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    limits = Limits(
        visible_seconds=args.visible_seconds,
        sidecar_seconds=args.sidecar_seconds,
        idle_cpu_seconds=args.idle_cpu_seconds,
        rss_soak_seconds=args.rss_soak_seconds,
        settle_seconds=args.settle_seconds,
        sample_interval_seconds=args.sample_interval_seconds,
        shutdown_seconds=args.shutdown_seconds,
    )
    try:
        payload = run_harness(args.app, args.output, limits, test_mode=args.test_mode)
    except HarnessError as error:
        print(f"macos-packaged-performance: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"status": payload["status"], "authoritative": payload["authoritative"], "report": str(args.output)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
