"""Optional per-run token gate for the local FastAPI sidecar.

The backend stays backward compatible by default: no token is required unless
``LSATLAB_LOCAL_API_TOKEN`` is set by the launcher. Once set, callers send the
token as ``Authorization: Bearer <token>``; ``X-LSATLAB-API-Token`` is accepted
as a narrow fallback for local clients that cannot easily set Authorization.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterable
from hmac import compare_digest

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.responses import Response

from . import config, observability

LOCAL_API_TOKEN_HEADER = "X-LSATLAB-API-Token"
_AUTH_PREFIX = "bearer "
_UNAUTHENTICATED_API_PATHS = frozenset({"/api/health"})


def configured_local_api_token() -> str:
    return str(getattr(config, "LOCAL_API_TOKEN", "") or "").strip()


def _candidate_tokens(request: Request) -> Iterable[str]:
    authorization = request.headers.get("authorization", "")
    if authorization.lower().startswith(_AUTH_PREFIX):
        yield authorization[len(_AUTH_PREFIX):].strip()

    header_token = request.headers.get(LOCAL_API_TOKEN_HEADER)
    if header_token:
        yield header_token.strip()


def _has_valid_token(request: Request, expected: str) -> bool:
    return any(
        candidate and compare_digest(candidate, expected)
        for candidate in _candidate_tokens(request)
    )


def _requires_local_api_token(request: Request) -> bool:
    if request.method.upper() == "OPTIONS":
        return False
    path = request.url.path
    if path in _UNAUTHENTICATED_API_PATHS:
        return False
    return path.startswith("/api/") and bool(configured_local_api_token())


async def local_api_token_middleware(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
) -> Response:
    expected = configured_local_api_token()
    if not _requires_local_api_token(request) or _has_valid_token(request, expected):
        return await call_next(request)

    return JSONResponse(
        status_code=401,
        headers={"WWW-Authenticate": "Bearer"},
        content={
            "code": "local_api_token_required",
            "message": "Local API token required",
            "detail": {
                "header": "Authorization",
                "scheme": "Bearer",
                "fallback_header": LOCAL_API_TOKEN_HEADER,
            },
            "request_id": observability.request_id_var.get(),
            "retryable": False,
        },
    )
