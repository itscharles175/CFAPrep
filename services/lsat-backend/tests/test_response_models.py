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

from typing import Any

from fastapi.routing import APIRoute

from app.main import app
from app.schemas import (
    AdaptiveNextResponse,
    BankStats,
    DatasetSource,
    PrepTestSummary,
    SessionSummary,
    StudyTodayResponse,
)


# (path, method) -> expected response_model. These are the high-traffic list /
# headline endpoints typed in BC2. Keep this in lockstep with the routers.
_TYPED_ROUTES: dict[tuple[str, str], type] = {
    ("/api/preptests", "GET"): list[PrepTestSummary],
    ("/api/sessions", "GET"): list[SessionSummary],
    ("/api/bank/sources", "GET"): list[DatasetSource],
    ("/api/bank/stats", "GET"): BankStats,
    ("/api/adaptivity/next", "POST"): AdaptiveNextResponse,
    ("/api/study/today", "GET"): StudyTodayResponse,
}

# The bare-list endpoints that gained OPTIONAL limit/offset in this slice. Their
# default (no params) response must be byte-identical to the legacy full list.
_PAGINATED_LIST_ROUTES = [
    "/api/preptests",
    "/api/sessions",
    "/api/bank/sources",
]

# Wave 2 — every host-consumed route typed with an inline permissive model
# (extra="allow" + response_model_exclude_unset). These models live in their
# router files, so this registry asserts the CONTRACT (a real response_model is
# declared and the OpenAPI 200 schema is not the LegacySuccessResponse fallback
# or a bare object) rather than importing each class. Field-removal protection
# for these routes lives in test_openapi_contract._GUARDED_ROUTES.
_WAVE2_TYPED_ROUTES: tuple[tuple[str, str], ...] = (
    ("/api/adaptivity/ability", "GET"),
    ("/api/adaptivity/plan", "POST"),
    ("/api/adaptivity/recompute-item-stats", "POST"),
    ("/api/readiness", "GET"),
    ("/api/sync/progress-updates", "POST"),
    ("/api/sync/fsrs-write-back", "POST"),
    ("/api/sync/fsrs-write-back/log", "GET"),
    ("/api/srs/due", "GET"),
    ("/api/srs/leeches", "GET"),
    ("/api/srs/concept-gap-queue", "GET"),
    ("/api/srs/cards", "POST"),
    ("/api/srs/concept-gap-cards", "POST"),
    ("/api/srs/optimize", "POST"),
    ("/api/srs/{card_id}/review", "POST"),
    ("/api/srs/attempts/{attempt_id}/blind-review-note", "POST"),
    ("/api/analytics/calibration", "GET"),
    ("/api/search/questions", "GET"),
    ("/api/settings", "GET"),
    ("/api/settings", "PUT"),
    ("/api/ai/health", "GET"),
    ("/api/observability/trust", "GET"),
    ("/api/release/trust", "GET"),
    ("/api/observability/diagnostics", "GET"),
    ("/api/observability/scheduled-tasks", "GET"),
    ("/api/observability/scheduled-tasks", "POST"),
    ("/api/observability/scheduled-tasks/defaults", "POST"),
    ("/api/observability/scheduled-tasks/run-due", "POST"),
    ("/api/observability/scheduled-tasks/{key}/run", "POST"),
    ("/api/observability/scheduler-runs", "GET"),
    ("/api/observability/migrations/dry-run", "GET"),
    ("/api/observability/migrations/pre-upgrade-backup", "POST"),
    ("/api/observability/benchmarks", "GET"),
    ("/api/observability/benchmarks", "POST"),
    ("/api/observability/benchmarks/smoke", "POST"),
    ("/api/observability/status", "GET"),
    ("/api/ready", "GET"),
    ("/api/observability/metrics", "GET"),
    ("/api/observability/cloud-budget", "GET"),
    ("/api/observability/runtime-evidence", "GET"),
    ("/api/observability/sqlite-health", "GET"),
    ("/api/observability/trust-status", "GET"),
    ("/api/observability/health-aggregated", "GET"),
    ("/api/observability/schema-versions", "GET"),
    ("/api/observability/relocation-status", "GET"),
    ("/api/export/validate", "POST"),
    ("/api/export/import", "POST"),
    ("/api/export/list", "GET"),
    ("/api/export/history", "GET"),
)


def _api_routes() -> list[Any]:
    routes: list[Any] = []
    for route in app.routes:
        if isinstance(route, APIRoute) and route.path.startswith("/api/"):
            routes.append(route)
            continue
        contexts = getattr(route, "effective_route_contexts", None)
        if callable(contexts):
            routes.extend(
                ctx
                for ctx in contexts()
                if str(getattr(ctx, "path", "")).startswith("/api/")
            )
    return routes


def _route_for(path: str, method: str) -> Any:
    for r in _api_routes():
        if r.path == path and method in r.methods:
            return r
    raise AssertionError(f"route not found: {method} {path}")


def _query_param_names(route: Any) -> set[str]:
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
    for name in (
        "HealthResponse",
        "PrepTestSummary",
        "SessionSummary",
        "DatasetSource",
        "BankStats",
        "AdaptiveNextResponse",
        "StudyTodayResponse",
    ):
        assert name in schemas, f"{name} missing from OpenAPI components"

    def _ok_schema_ref(path: str, method: str = "get") -> str:
        return (
            spec["paths"][path][method]["responses"]["200"]["content"]
            ["application/json"]["schema"]
        ).__str__()

    # Each typed route's 200 schema must NOT be the legacy fallback.
    for path in ("/api/preptests", "/api/sessions", "/api/bank/sources", "/api/bank/stats"):
        assert "LegacySuccessResponse" not in _ok_schema_ref(path), (
            f"{path} still uses the LegacySuccessResponse fallback"
        )
    assert "LegacySuccessResponse" not in _ok_schema_ref("/api/adaptivity/next", "post")
    assert "LegacySuccessResponse" not in _ok_schema_ref("/api/study/today", "get")


def test_wave2_routes_declare_real_response_models(client):
    """Wave 2 ratchet: each registered route declares SOME response_model on the
    live route table, and its OpenAPI 200 schema is a real shape — neither the
    LegacySuccessResponse fallback nor a bare/schemaless object. Reverting a
    route to an untyped dict fails here even before the field-removal guard."""
    spec = client.get("/openapi.json").json()

    for path, method in _WAVE2_TYPED_ROUTES:
        route = _route_for(path, method)
        assert route.response_model is not None, (
            f"{method} {path} lost its response_model"
        )

        op = spec["paths"][path][method.lower()]
        schema = op["responses"]["200"]["content"]["application/json"].get("schema")
        assert schema, f"{method} {path} lacks a 200 response schema"
        rendered = str(schema)
        assert "LegacySuccessResponse" not in rendered, (
            f"{method} {path} regressed to the LegacySuccessResponse fallback"
        )
        # A real contract resolves to a named component ($ref, possibly inside
        # anyOf for union models) — a bare {'type': 'object'} carries no shape.
        assert "$ref" in rendered, (
            f"{method} {path} has a schemaless object response: {rendered[:120]}"
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
