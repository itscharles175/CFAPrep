"""Shared LLM-provider plumbing: errors, retry policy, concurrency guards.

Why this exists
---------------
Every model call used to be a bare ``httpx`` request: no retry when Ollama was
briefly unreachable (still loading a model after a cold start), no cap on how
many calls could hit the single local GPU at once, and no common error type for
callers to catch. This module centralises that so the local Ollama provider and
the optional cloud provider behave consistently.

Design notes
------------
- We retry *connection-level* blips (refused/reset/connect-timeout, 5xx) but NOT
  read timeouts: a slow model should fail once, not queue another full timeout.
- Concurrency guards cap simultaneous calls to the local GPU. They are a safety
  net against a runaway caller (e.g. a UI firing many explain requests); the
  single-user realtime path is naturally ~1 at a time.
- The async semaphore is created lazily per running loop so tests that spin up a
  fresh event loop per ``TestClient`` never hit "bound to a different loop".
"""
from __future__ import annotations

import asyncio
import random
import threading
import time
import weakref
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TypeVar

import httpx

from .. import config

T = TypeVar("T")


class LLMError(RuntimeError):
    """Any provider failure (network, timeout, bad status), normalised."""


class LLMOOMError(LLMError):
    """The local model ran out of VRAM/memory. Subclasses LLMError so existing
    handling still treats it as a provider failure, but it is NOT retried and the
    caller can catch it specifically to suggest a smaller model."""


class CloudBudgetExceeded(LLMError):
    """7.3 — a cloud Tier-B call was refused because month-to-date spend would
    exceed ``CLOUD_MONTHLY_BUDGET_USD``. Subclasses LLMError so existing
    generation error handling treats it as a (recoverable) provider failure; the
    facade catches it first to fall back to the local model instead of failing."""

    def __init__(self, spend_usd: float, budget_usd: float) -> None:
        self.spend_usd = spend_usd
        self.budget_usd = budget_usd
        super().__init__(
            f"cloud monthly budget exceeded: spent ${spend_usd:.4f} "
            f"of ${budget_usd:.2f}"
        )


_RETRYABLE = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.NetworkError,
    httpx.PoolTimeout,
)

# Markers that identify an out-of-VRAM/allocation failure in a local model's 5xx
# body. Kept precise to avoid false positives on unrelated server errors.
_OOM_MARKERS = (
    "out of memory",
    "failed to allocate",
    "cudamalloc",
    "insufficient memory",
    "cannot allocate memory",
)


def _is_oom(exc: BaseException) -> bool:
    """True when an LLM error is an out-of-VRAM/allocation failure (the local
    server returns a 5xx whose body names it). Must NOT be retried — a retry just
    burns another full timeout and can worsen contention — and should surface
    distinctly so the UI can suggest a smaller model."""
    if isinstance(exc, httpx.HTTPStatusError):
        try:
            body = (exc.response.text or "").lower()
        except Exception:
            body = ""
        return any(m in body for m in _OOM_MARKERS)
    return False


def is_transient(exc: BaseException) -> bool:
    """True for connection blips worth retrying. Read timeouts AND OOM are excluded."""
    if _is_oom(exc):
        return False
    if isinstance(exc, _RETRYABLE):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code >= 500
    return False


@dataclass(frozen=True)
class RetryPolicy:
    attempts: int = 3          # total tries = 1 initial + (attempts-1) retries
    base_s: float = 0.5
    max_s: float = 8.0

    def backoff(self, attempt: int) -> float:
        """Exponential backoff with a little jitter. ``attempt`` is 0-based."""
        return min(self.max_s, self.base_s * (2 ** attempt)) + random.uniform(0, 0.25)


def default_policy() -> RetryPolicy:
    return RetryPolicy(attempts=max(1, config.LLM_MAX_RETRIES + 1))


# --- concurrency guards -----------------------------------------------------
_sync_sema = threading.Semaphore(max(1, config.LLM_MAX_CONCURRENCY))
# B21: WeakKeyDictionary so semaphores for closed event loops are GC'd
# automatically instead of accumulating indefinitely (e.g. one per TestClient
# invocation in the test suite).
_async_semas: weakref.WeakKeyDictionary[
    asyncio.AbstractEventLoop, asyncio.Semaphore
] = weakref.WeakKeyDictionary()


def sync_guard() -> threading.Semaphore:
    return _sync_sema


def get_async_guard() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    sema = _async_semas.get(loop)
    if sema is None:
        sema = asyncio.Semaphore(max(1, config.LLM_MAX_CONCURRENCY))
        _async_semas[loop] = sema
    return sema


def retry_sync(fn: Callable[[], T], *, policy: RetryPolicy | None = None) -> T:
    policy = policy or default_policy()
    last: BaseException | None = None
    for attempt in range(policy.attempts):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 - normalised into LLMError below
            last = exc
            if attempt == policy.attempts - 1 or not is_transient(exc):
                break
            time.sleep(policy.backoff(attempt))
    raise (LLMOOMError(str(last)) if _is_oom(last) else LLMError(str(last))) from last


async def retry_async(coro_factory: Callable[[], Awaitable[T]], *,
                      policy: RetryPolicy | None = None) -> T:
    policy = policy or default_policy()
    last: BaseException | None = None
    for attempt in range(policy.attempts):
        try:
            return await coro_factory()
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt == policy.attempts - 1 or not is_transient(exc):
                break
            await asyncio.sleep(policy.backoff(attempt))
    raise (LLMOOMError(str(last)) if _is_oom(last) else LLMError(str(last))) from last
