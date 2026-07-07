"""PyInstaller entry point for the bundled LSAT Lab backend sidecar.

When the desktop app ships, there is no system Python or `uv` available, so we
cannot rely on `python -m uvicorn app.main:app`. Instead PyInstaller freezes
*this* module into a single self-contained executable (see ``lsatlab.spec``)
that boots uvicorn programmatically against the existing FastAPI app.

The Tauri shell launches the frozen binary as a sidecar (``externalBin``). It is
deliberately tiny and import-light at module scope so the frozen process starts
fast; the heavy FastAPI app is imported inside ``main()`` after argument
parsing.

Configuration (host/port/log level) is taken from CLI flags first, then
environment variables, then sensible local-first defaults. The defaults match
the dev launcher (127.0.0.1:8000) so a packaged build behaves identically to
``start-dev.ps1``.

This file is *only* an entry point — it is intentionally excluded from the
backend's product-logic test/coverage scope and contains no app behaviour of
its own.
"""
from __future__ import annotations

import argparse
import os
import sys


def _default_port() -> int:
    """Resolve the listen port from the env, falling back to 8000."""
    raw = os.environ.get("LSATLAB_PORT", "8000")
    try:
        return int(raw)
    except ValueError:
        return 8000


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="lsatlab-backend",
        description="LSAT Lab local FastAPI backend (frozen sidecar).",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("LSATLAB_HOST", "127.0.0.1"),
        help="Interface to bind (default: 127.0.0.1 — local only).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=_default_port(),
        help="TCP port to listen on (default: 8000 or $LSATLAB_PORT).",
    )
    parser.add_argument(
        "--log-level",
        default=os.environ.get("LSATLAB_LOG_LEVEL", "info").lower(),
        help="uvicorn log level (default: info or $LSATLAB_LOG_LEVEL).",
    )
    return parser.parse_args(argv)


_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)

    # The local API serves private study data and official-content previews. It
    # is unauthenticated unless LSATLAB_LOCAL_API_TOKEN is set by the launcher,
    # and even then the token is a local-process secret, not a remote-service
    # hardening story. Binding to a non-loopback interface would expose the API
    # to the network, so refuse unless the user has explicitly opted in.
    # (Default 127.0.0.1 is unaffected.)
    allow_remote = os.environ.get("LSATLAB_ALLOW_REMOTE_API", "0").lower() in (
        "1", "true", "yes", "on",
    )
    if args.host not in _LOOPBACK_HOSTS and not allow_remote:
        sys.stderr.write(
            f"lsatlab-backend: refusing to bind to non-loopback host "
            f"{args.host!r}; the local API is unauthenticated. Set "
            f"LSATLAB_ALLOW_REMOTE_API=1 to override at your own risk.\n"
        )
        return 2

    # Import here (not at module scope) so the frozen process starts quickly and
    # so a syntax/import error in the app surfaces with a clear traceback rather
    # than during PyInstaller's bootstrap.
    import uvicorn

    # Import the app object directly rather than passing the "app.main:app"
    # import string. In a frozen build there is no source tree for uvicorn's
    # reloader/import machinery to walk, so handing it the concrete ASGI object
    # is the reliable path. (No reload/workers in a packaged single-user app.)
    from app.main import app

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level=args.log_level,
        # Single local user + single GPU: one worker, no reload.
        workers=1,
        reload=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
