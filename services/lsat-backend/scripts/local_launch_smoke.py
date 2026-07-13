"""Start the backend, probe launch endpoints, and shut it down cleanly."""
from __future__ import annotations

import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx


ROOT = Path(__file__).resolve().parents[1]


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def main() -> int:
    port = _free_port()
    base = f"http://127.0.0.1:{port}"
    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
        ],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        with httpx.Client(timeout=10.0) as client:
            deadline = time.time() + 30
            while time.time() < deadline:
                try:
                    r = client.get(f"{base}/api/health")
                    if r.status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                if proc.poll() is not None:
                    raise RuntimeError("backend exited before health check")
                time.sleep(0.5)
            else:
                raise RuntimeError("backend did not become healthy within 30s")

            checks = ["/api/health", "/api/ready", "/api/ai/health"]
            for path in checks:
                resp = client.get(f"{base}{path}")
                print(path, resp.status_code)
                if resp.status_code >= 500:
                    raise RuntimeError(f"{path} failed with {resp.status_code}")
        print(f"local launch smoke passed at {base}")
        return 0
    except Exception as exc:
        print(f"local launch smoke failed: {exc}", file=sys.stderr)
        if proc.stdout is not None:
            print(proc.stdout.read(), file=sys.stderr)
        return 1
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
