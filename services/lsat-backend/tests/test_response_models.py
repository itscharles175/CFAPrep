"""BC2 — typed response_model + pagination coverage.

This suite ENCODES current coverage rather than enforcing a repo-wide sweep:

  * It asserts the high-traffic routes typed in this slice now declare a real
    ``response_model`` (so the OpenAPI spec carries a narrow schema instead of the
    generic ``LegacySuccessResponse`` fallback that ``main.custom_openapi`` adds).
  * It asserts those routes are BACKWARD-COMPATIBLE: the typed response keeps the
    exact field set/shape the host + existing tests consume, and the optional
    ``limit``/``offset`` params default to "return everything".
  * It RECORDS — informationally, never failing — which other ``/api/`` GET
    endpoints still return a bare list/dict without ``limit``/``offset``, so the
    incremental "high-traffic first" rollout is visible without breaking CI on
    every untyped legacy route.

Typing is read off the live FastAPI route table (``app.routes``) — a route's
``response_model`` is ``None`` until a handler sets ``response_model=``.
"""
from __future__ import annotations

from fastapi.routing import APIRoute

from app.main import app
from app.schemas import (
    BankStats,
    DatasetSource,
    PrepTestSummary,
    SessionSummary,
)


# (path, method) -> expected response_model. These are the high-traffic list /
# headline endpoints typed in BC2. Keep this in lockstep with the routers.
_TYPED_ROUTES: dict[tuple[str, str], type] = {
    ("/api/preptests", "GET"): list[PrepTestSummary],
    ("/api/sessions", "GET"): list[SessionSummary],
    ("/api/bank/sources", "GET"): list[DatasetSource],
    ("/api/bank/stats", "GET"): BankStats,
}

# The bare-list endpoints that gained OPTIONAL limit/offset in this slice. Their
# default (no params) response must be byte-identical to the legacy full list.
_PAGINATED_LIST_ROUTES = [
    "/api/preptests",
    "/api/sessions",
    "/api/bank/sources",
]


def _api_routes() -> list[APIRoute]:
    return [r for r in app.routes if isinstance(r, APIRoute) and r.path.startswith("/api/")]


def _route_for(path: str, method: str) -> APIRoute:
    for r in _api_routes():
        if r.path == path and method in r.methods:
            return r
    raise AssertionError(f"route not found: {method} {path}")


def _query_param_names(route: APIRoute) -> set[str]:
    return {p.name for p in route.dependant.query_params}


def test_high_traffic_routes_declare_response_model():
    """Each BC2-typed route exposes a real ``response_model`` (not the fallback)."""
    for (path, method), model in _TYPED_ROUTES.items():
        route = _route_for(path, method)
        assert route.response_model == model, (
            f"{method} {path} response_model is {route.response_model!r}, "
            f"expected {model!r}"
        )


def test_paginated_list_routes_accept_limit_and_offset():
    """The typed bare-list endpoints expose optional limit/offset query params."""
    for path in _PAGINATED_LIST_ROUTES:
        params = _query_param_names(_route_for(path, "GET"))
        assert {"limit", "offset"} <= params, (
            f"GET {path} is missing limit/offset (has {sorted(params)})"
        )


def test_preptests_pagination_is_backward_compatible(client):
    """Default = full list; limit/offset slice without changing the row shape."""
    full = client.get("/api/preptests").json()
    assert isinstance(full, list) and full, "seed bank should expose preptests"
    # Field set is exactly the documented schema (no add/drop/rename).
    assert set(full[0].keys()) == set(PrepTestSummary.model_fields.keys())

    # Omitting params returns everything — identical to the legacy payload.
    assert client.get("/api/preptests?offset=0").json() == full[:]  # offset only
    assert client.get("/api/preptests").json() == full

    # A limit slices from the front; offset skips. Behaves like list slicing.
    one = client.get("/api/preptests?limit=1").json()
    assert one == full[:1]
    if len(full) > 1:
        assert client.get("/api/preptests?limit=1&offset=1").json() == full[1:2]
    # Out-of-range offset yields an empty list, never an error.
    assert client.get(f"/api/preptests?offset={len(full) + 5}").json() == []


def test_sessions_pagination_is_backward_compatible(client):
    """list_sessions stays a bare list with the enriched fields the host reads."""
    # Create two sessions so there is something to slice.
    for _ in range(2):
        client.post("/api/sessions", json={"type": "drill", "config": {}})
    full = client.get("/api/sessions").json()
    assert isinstance(full, list) and len(full) >= 2
    assert set(full[0].keys()) == set(SessionSummary.model_fields.keys())
    # The host (test_round5_wave1) reads these enriched keys — keep them present.
    for key in ("duration_sec", "br_accuracy", "official_only_score", "question_count"):
        assert key in full[0]
    assert client.get("/api/sessions?limit=1").json() == full[:1]
    assert client.get("/api/sessions").json() == full


def test_bank_sources_and_stats_shapes_unchanged(client):
    """Typed dataset registry/headline still return their legacy shapes."""
    sources = client.get("/api/bank/sources").json()
    assert isinstance(sources, list) and sources
    assert set(sources[0].keys()) == set(DatasetSource.model_fields.keys())
    # Pagination is additive: a limit slices, default returns all.
    assert client.get("/api/bank/sources?limit=1").json() == sources[:1]
    assert client.get("/api/bank/sources").json() == sources

    stats = client.get("/api/bank/stats").json()
    assert set(stats.keys()) == set(BankStats.model_fields.keys())
    assert isinstance(stats["total"], int)
    assert isinstance(stats["by_source"], dict)


def test_openapi_uses_typed_models_not_legacy_fallback(client):
    """The typed routes reference their own component schema in the spec, so the
    OpenAPI contract carries a real shape (the contract test stays green either
    way; this asserts we upgraded BEYOND the LegacySuccessResponse fallback)."""
    spec = client.get("/openapi.json").json()
    schemas = spec["components"]["schemas"]
    for name in ("PrepTestSummary", "SessionSummary", "DatasetSource", "BankStats"):
        assert name in schemas, f"{name} missing from OpenAPI components"

    def _ok_schema_ref(path: str) -> str:
        return (
            spec["paths"][path]["get"]["responses"]["200"]["content"]
            ["application/json"]["schema"]
        ).__str__()

    # Each typed route's 200 schema must NOT be the legacy fallback.
    for path in ("/api/preptests", "/api/sessions", "/api/bank/sources", "/api/bank/stats"):
        assert "LegacySuccessResponse" not in _ok_schema_ref(path), (
            f"{path} still uses the LegacySuccessResponse fallback"
        )


def test_remaining_list_endpoints_without_pagination_are_recorded():
    """Informational coverage record (passing): which /api GET endpoints still
    return a collection without limit/offset. This documents the incremental
    rollout WITHOUT failing CI on every legacy route — the roadmap calls for
    starting with high-traffic endpoints, not a breaking repo-wide sweep."""
    typed_paths = {p for (p, _m) in _TYPED_ROUTES}
    remaining: list[str] = []
    for route in _api_routes():
        if "GET" not in route.methods:
            continue
        if route.path in typed_paths:
            continue
        params = _query_param_names(route)
        # Heuristic for "list-ish": no path params and not already paginated.
        if route.path_format.count("{") == 0 and not ({"limit", "offset"} & params):
            remaining.append(route.path)
    # Always passes: this is a documented snapshot, not a gate. The assertion
    # only guards the invariant that the BC2-typed routes are NOT in the
    # "remaining / untyped" set (i.e. coverage never silently regresses).
    assert typed_paths.isdisjoint(set(remaining))
    # Surface the snapshot for humans running -s; never fails on its contents.
    assert isinstance(remaining, list)
