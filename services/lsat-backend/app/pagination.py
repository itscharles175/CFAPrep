"""BC2 — shared limit/offset slicing helper for list endpoints.

Adds *optional* pagination to high-traffic bare-list endpoints without changing
their default behavior or response shape. The contract is deliberately tiny:

  * When BOTH ``limit`` and ``offset`` are omitted (``None``), the full list is
    returned exactly as before — byte-identical to the legacy payload. This keeps
    the host (``src/lib/lsatBackend.ts``) and existing tests passing unchanged.
  * When a caller passes ``offset`` and/or ``limit``, the list is sliced in
    Python AFTER the route has built it. Slicing the already-materialized list
    issues ZERO extra SQL, so query-budget gates (``tests/test_query_budget.py``)
    stay flat.

These endpoints already build their full result set in a fixed, batched number
of queries (the bank is personal-scale), so in-memory slicing is the simplest
correct approach and never wraps the payload in a paginated envelope — which
would break the existing bare-list contract.
"""
from __future__ import annotations

from typing import Optional, TypeVar

from fastapi import Query

T = TypeVar("T")

# Reusable FastAPI ``Query`` declarations so every paginated list endpoint shows
# the same parameter docs/validation in the OpenAPI schema. Both default to
# ``None`` so an absent param means "return everything" (legacy behavior).
LimitQuery = Query(
    None,
    ge=1,
    le=1000,
    description="Optional: cap the number of items returned (default: all).",
)
OffsetQuery = Query(
    None,
    ge=0,
    description="Optional: skip this many items from the start (default: 0).",
)


def paginate(
    items: list[T],
    *,
    limit: Optional[int] = None,
    offset: Optional[int] = None,
) -> list[T]:
    """Return an optionally-sliced view of ``items``.

    ``limit``/``offset`` are the values from :data:`LimitQuery` / :data:`OffsetQuery`.
    When both are ``None`` the input list is returned unchanged (same object), so
    the default response is identical to the pre-pagination behavior. Otherwise
    a slice ``items[start:end]`` is returned where ``start = offset or 0`` and
    ``end = start + limit`` (or the list end when ``limit`` is ``None``).
    """
    if limit is None and offset is None:
        return items
    start = offset or 0
    if limit is None:
        return items[start:]
    return items[start : start + limit]
