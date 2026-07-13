from __future__ import annotations

import json
import os
from pathlib import Path

# QA-3 — per-route response-schema snapshot. The committed baseline freezes the
# resolved 2xx response *field set* of the typed (BC2) routes the host reads via
# the generated client (src/domains/lsat/lib/api.gen.ts → lsatBackend.ts /
# lsatReviewBridge.ts). DATA-1's drift gate (scripts/export-lsat-openapi.mjs)
# already guards path/method/field removals across the WHOLE spec at build time;
# this in-process test is the per-route, field-level safety net that runs inside
# the normal pytest gate, so a backend-only PR that narrows a typed payload fails
# locally before it ever reaches the OpenAPI drift step.
_SCHEMA_BASELINE = Path(__file__).with_name("schemas-baseline.json")

# Every route that declares a real (non-dict) response model is guarded: typed
# implies guarded. A field present in the baseline but missing from the live
# spec is a BREAKING removal for an existing host caller; adding fields is
# always compatible. When typing a new route, add it here and re-snapshot with
# UPDATE_SCHEMA_BASELINE=1 in the SAME commit (the baseline-membership assert
# below fails otherwise).
_GUARDED_ROUTES: tuple[tuple[str, str], ...] = (
    # BC2 first floor
    ("/api/health", "get"),
    ("/api/preptests", "get"),
    ("/api/sessions", "get"),
    ("/api/bank/sources", "get"),
    ("/api/bank/stats", "get"),
    ("/api/adaptivity/next", "post"),
    ("/api/study/today", "get"),
    # Wave 2 — adaptivity + readiness
    ("/api/adaptivity/ability", "get"),
    ("/api/adaptivity/plan", "post"),
    ("/api/adaptivity/recompute-item-stats", "post"),
    ("/api/readiness", "get"),
    # Wave 2 — study / sync
    ("/api/study/profile", "get"),
    ("/api/study/profile", "put"),
    ("/api/study/simulate", "post"),
    ("/api/study/due-unified", "get"),
    ("/api/sync/progress-updates", "post"),
    ("/api/sync/fsrs-write-back", "post"),
    ("/api/sync/fsrs-write-back/log", "get"),
    # Wave 2 — SRS
    ("/api/srs/params", "get"),
    ("/api/srs/due", "get"),
    ("/api/srs/leeches", "get"),
    ("/api/srs/concept-gap-queue", "get"),
    ("/api/srs/cards", "post"),
    ("/api/srs/concept-gap-cards", "post"),
    ("/api/srs/optimize", "post"),
    ("/api/srs/{card_id}/review", "post"),
    ("/api/srs/attempts/{attempt_id}/blind-review-note", "post"),
    # Wave 2 — analytics
    ("/api/analytics/dashboard", "get"),
    ("/api/analytics/by-type", "get"),
    ("/api/analytics/activity", "get"),
    ("/api/analytics/calibration", "get"),
    ("/api/analytics/cross-domain", "get"),
    ("/api/analytics/weakness-index", "get"),
    ("/api/analytics/blind-review-gap", "get"),
    # Wave 2 — search / settings / AI health
    ("/api/search/questions", "get"),
    ("/api/settings", "get"),
    ("/api/settings", "put"),
    ("/api/ai/health", "get"),
    # Wave 2 — trust cockpit + scheduler + benchmarks
    ("/api/observability/trust", "get"),
    ("/api/release/trust", "get"),
    ("/api/observability/diagnostics", "get"),
    ("/api/observability/scheduled-tasks", "get"),
    ("/api/observability/scheduled-tasks", "post"),
    ("/api/observability/scheduled-tasks/defaults", "post"),
    ("/api/observability/scheduled-tasks/run-due", "post"),
    ("/api/observability/scheduled-tasks/{key}/run", "post"),
    ("/api/observability/scheduler-runs", "get"),
    ("/api/observability/migrations/dry-run", "get"),
    ("/api/observability/migrations/pre-upgrade-backup", "post"),
    ("/api/observability/benchmarks", "get"),
    ("/api/observability/benchmarks", "post"),
    ("/api/observability/benchmarks/smoke", "post"),
    # Wave 2 — observability
    ("/api/observability/status", "get"),
    ("/api/ready", "get"),
    ("/api/observability/metrics", "get"),
    ("/api/observability/cloud-budget", "get"),
    ("/api/observability/runtime-evidence", "get"),
    ("/api/observability/sqlite-health", "get"),
    ("/api/observability/trust-status", "get"),
    ("/api/observability/health-aggregated", "get"),
    ("/api/observability/schema-versions", "get"),
    ("/api/observability/relocation-status", "get"),
    # Wave 2 — unified export/import (create_backup stays deliberately untyped:
    # polymorphic encrypted-blob | plaintext-envelope response)
    ("/api/export/validate", "post"),
    ("/api/export/import", "post"),
    ("/api/export/list", "get"),
    ("/api/export/history", "get"),
    # Wave 2 — generation quality (typed in an earlier slice, now guarded)
    ("/api/gen/generation-quality", "post"),
    ("/api/gen/generation/quality-metrics", "get"),
    ("/api/gen/generation/audit-log", "get"),
    # Content factory + study artifacts (typed earlier, now guarded)
    ("/api/content-factory/plan", "post"),
    ("/api/content-factory/batches", "get"),
    ("/api/study-artifacts", "post"),
    ("/api/study-artifacts", "get"),
    ("/api/study-artifacts/{artifact_id}", "get"),
    ("/api/study-artifacts/{artifact_id}", "put"),
    ("/api/study-artifacts/{artifact_id}", "delete"),
)


def _collect_field_names(node, schemas, into, seen_refs):
    """Mirror of scripts/export-lsat-openapi.mjs `collectFieldNames`: walk a schema
    node, resolving `$ref`s into ``components.schemas``, and collect every object
    property name reachable from it. ``allOf``/``oneOf``/``anyOf``, array ``items``
    and ``additionalProperties`` are descended; ``$ref`` cycles are guarded."""
    if not isinstance(node, dict):
        if isinstance(node, list):
            for item in node:
                _collect_field_names(item, schemas, into, seen_refs)
        return
    ref = node.get("$ref")
    if isinstance(ref, str):
        if ref in seen_refs:
            return
        seen_refs.add(ref)
        name = ref.replace("#/components/schemas/", "")
        _collect_field_names(schemas.get(name), schemas, into, seen_refs)
        return
    props = node.get("properties")
    if isinstance(props, dict):
        for prop in props:
            into.add(prop)
        for value in props.values():
            _collect_field_names(value, schemas, into, seen_refs)
    for key in ("allOf", "oneOf", "anyOf"):
        if isinstance(node.get(key), list):
            _collect_field_names(node[key], schemas, into, seen_refs)
    if node.get("items"):
        _collect_field_names(node["items"], schemas, into, seen_refs)
    add_props = node.get("additionalProperties")
    if isinstance(add_props, dict):
        _collect_field_names(add_props, schemas, into, seen_refs)


def _response_fields(op, schemas):
    """Field-name set of one operation's 2xx response body — the host-read
    surface. Matches the drift script's `responseFields`."""
    into: set[str] = set()
    for code, resp in (op.get("responses") or {}).items():
        if not (len(code) == 3 and code[0] == "2" and code.isdigit()):
            continue
        for media in (resp.get("content") or {}).values():
            _collect_field_names(media.get("schema"), schemas, into, set())
    return into


def _snapshot_guarded_fields(spec):
    """{"METHOD path": sorted[field, …]} for every guarded route present in the
    live spec. Sorted lists keep the committed JSON stable / diff-friendly."""
    schemas = (spec.get("components") or {}).get("schemas") or {}
    paths = spec.get("paths") or {}
    snapshot: dict[str, list[str]] = {}
    for path, method in _GUARDED_ROUTES:
        op = (paths.get(path) or {}).get(method)
        if op is None:
            continue
        key = f"{method.upper()} {path}"
        snapshot[key] = sorted(_response_fields(op, schemas))
    return snapshot


def test_typed_route_response_schemas_have_no_silent_field_removals(client):
    """QA-3 — snapshot the resolved 2xx response field set of the BC2-typed routes
    and assert the live spec never DROPS a field the baseline guaranteed (additive
    changes are fine). Re-snapshot intentionally with ``UPDATE_SCHEMA_BASELINE=1``.

    Pairs with the DATA-1 drift gate (whole-spec, build-time) by giving the same
    field-removal guarantee per-route inside the in-process pytest suite."""
    spec = client.get("/openapi.json").json()
    live = _snapshot_guarded_fields(spec)

    # Every guarded route must actually exist in the live spec (otherwise a route
    # rename/removal would silently shrink coverage instead of failing).
    for path, method in _GUARDED_ROUTES:
        key = f"{method.upper()} {path}"
        assert key in live, f"guarded route {key} is missing from the live OpenAPI spec"
        assert live[key], f"guarded route {key} resolved to an empty response field set"

    if os.environ.get("UPDATE_SCHEMA_BASELINE") == "1" or not _SCHEMA_BASELINE.exists():
        _SCHEMA_BASELINE.write_text(
            json.dumps(live, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        # When (re)writing we still assert internal consistency above; nothing to diff.
        return

    baseline = json.loads(_SCHEMA_BASELINE.read_text(encoding="utf-8"))

    # Guard-extension completeness: a route added to _GUARDED_ROUTES without a
    # baseline re-snapshot would be silently unguarded (the removal loop below
    # iterates baseline entries only). Fail loudly instead.
    missing_from_baseline = [
        f"{method.upper()} {path}"
        for path, method in _GUARDED_ROUTES
        if f"{method.upper()} {path}" not in baseline
    ]
    assert missing_from_baseline == [], (
        "Guarded route(s) missing from the committed schemas-baseline.json — "
        "re-snapshot with UPDATE_SCHEMA_BASELINE=1 pytest tests/test_openapi_contract.py "
        "in the same commit:\n  - " + "\n  - ".join(missing_from_baseline)
    )

    removed: list[str] = []
    for key, fields in baseline.items():
        live_fields = set(live.get(key, []))
        for field in fields:
            if field not in live_fields:
                removed.append(f'{key}: removed response field "{field}"')

    assert removed == [], (
        "Typed-route response schema(s) dropped a field the baseline guaranteed "
        "(a breaking change for the host client):\n  - "
        + "\n  - ".join(removed)
        + "\n\nIf this removal is intentional, update the host client + regenerate "
        "api.gen.ts, then re-snapshot with UPDATE_SCHEMA_BASELINE=1 pytest "
        "tests/test_openapi_contract.py (and re-baseline the DATA-1 contract)."
    )


def test_launch_readiness_routes_have_openapi_response_schemas(client):
    spec = client.get("/openapi.json").json()
    assert "ErrorEnvelope" in spec["components"]["schemas"]
    assert "LegacySuccessResponse" in spec["components"]["schemas"]
    assert "HealthResponse" in spec["components"]["schemas"]
    expected = [
        ("/api/health", "get"),
        ("/api/ready", "get"),
        ("/api/backup/integrity", "get"),
        ("/api/observability/status", "get"),
    ]
    for path, method in expected:
        op = spec["paths"][path][method]
        schema = (
            op["responses"]["200"]["content"]["application/json"]
            .get("schema")
        )
        assert schema, f"{method.upper()} {path} lacks a 200 response schema"
        assert "422" in op["responses"]
        assert (
            op["responses"]["422"]["content"]["application/json"]["schema"]["$ref"]
            == "#/components/schemas/ErrorEnvelope"
        )


def test_launch_health_response_schema_includes_sidecar_identity(client):
    spec = client.get("/openapi.json").json()
    schema = (
        spec["paths"]["/api/health"]["get"]["responses"]["200"]["content"]
        ["application/json"]["schema"]
    )
    assert schema["$ref"] == "#/components/schemas/HealthResponse"
    props = spec["components"]["schemas"]["HealthResponse"]["properties"]
    assert set(props) >= {"ok", "service", "version"}
    assert props["service"]["type"] == "string"
    assert props["version"]["type"] == "string"


def test_all_api_routes_have_success_and_error_schemas(client):
    spec = client.get("/openapi.json").json()
    missing_success = []
    missing_error = []
    for path, methods in spec["paths"].items():
        if not path.startswith("/api/"):
            continue
        for method, op in methods.items():
            responses = op.get("responses", {})
            if method.lower() != "delete" and "200" in responses:
                schema = (
                    responses["200"]["content"]["application/json"].get("schema")
                )
                if not schema:
                    missing_success.append((method.upper(), path))
            for code in ("400", "404", "422", "500"):
                schema = (
                    responses.get(code, {})
                    .get("content", {})
                    .get("application/json", {})
                    .get("schema")
                )
                if not schema:
                    missing_error.append((method.upper(), path, code))
    assert missing_success == []
    assert missing_error == []
