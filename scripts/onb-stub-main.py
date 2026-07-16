"""
Tiny FastAPI stub that proves the PyInstaller bundle path works end-to-end
without dragging the full open-notebook dep tree into the build.

The stub exposes the same `/health` route the real backend does so the
Electron supervisor's readiness probe can `GET /health` and succeed. Other
routes return 503 with a clear "not bundled" message — the production
build replaces this file with `spike/open-notebook/api/main.py`.

Run with:
    python scripts/onb-stub-main.py            # dev
    pyinstaller --onefile scripts/onb-stub-main.py
                       --name open-notebook    # bundle

Output: `dist/open-notebook(.exe)` lands in the same slot the real
binary will, so the supervisor + integration tests can exercise the
sidecar without ever needing the full backend installed.
"""

from __future__ import annotations

import os

try:
    from fastapi import FastAPI
    import uvicorn
except ImportError as exc:  # pragma: no cover - bundle integrity check
    raise SystemExit(
        "Missing dependency. Run: python -m pip install fastapi uvicorn"
    ) from exc


app = FastAPI(title="open-notebook stub", version="0.1.0")


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "status": "ok",
        "build": "pyinstaller-stub",
        "message": "QuantVault open-notebook stub — replace with full backend for production.",
    }


@app.get("/")
def root() -> dict[str, str]:
    return {"backend": "stub", "see": "/health"}


@app.get("/api/{path:path}")
@app.post("/api/{path:path}")
def not_bundled(path: str) -> tuple[dict[str, str], int]:
    return (
        {
            "error": "not-bundled",
            "path": path,
            "hint": "This is the lightweight stub. Run the full open-notebook backend "
            "for source / chat / transformation endpoints.",
        },
        503,
    )


def main() -> None:
    port = int(os.environ.get("ONB_PORT", "5055"))
    host = os.environ.get("ONB_HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
