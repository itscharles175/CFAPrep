"""One-command backend launch gate.

Run from ``backend/``:

    python scripts/backend_gate.py

The gate intentionally shells out to the same commands a release engineer would
run by hand so failures preserve familiar output.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _run(label: str, args: list[str]) -> int:
    print(f"\n== {label} ==")
    proc = subprocess.run(args, cwd=ROOT)
    if proc.returncode:
        print(f"{label} failed with exit code {proc.returncode}")
    return proc.returncode


def main() -> int:
    py = sys.executable
    checks = [
        ("compileall", [py, "-m", "compileall", "-q", "app"]),
        (
            "route import",
            [
                py,
                "-c",
                "from app.main import app; "
                "spec=app.openapi(); "
                "assert '/api/ready' in spec['paths']; "
                "assert '/api/adaptivity/ability' in spec['paths']; "
                "assert '/api/readiness' in spec['paths']; "
                "assert '/api/content/health' in spec['paths']; "
                "assert 'ErrorEnvelope' in spec['components']['schemas']; "
                "print(len(app.routes), 'routes')",
            ],
        ),
        ("pytest", [py, "-m", "pytest", "-q", "--durations=25"]),
        ("doctor", [py, "-m", "app.doctor", "--soft"]),
    ]
    for label, args in checks:
        code = _run(label, args)
        if code:
            return code
    print("\nbackend gate passed")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
