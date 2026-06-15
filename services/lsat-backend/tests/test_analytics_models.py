"""ANL-1 — cross-domain analytics route + typed/paged hardening.

Covers three things this slice adds, all of them backward-compatible:

  * The new ``GET /api/analytics/cross-domain`` rollup: study time, accuracy by
    domain, merged weakest types, combined streak, and a 30-day trend — both the
    LSAT-only view and the host-merged view (optional query numbers).
  * BC2/BC3 hardening on the high-traffic list routes (``/by-type``, ``/activity``)
    and the ``/dashboard`` headline: a real ``response_model`` and OPTIONAL
    ``limit``/``offset`` whose default (no params) is byte-identical to the legacy
    full payload, plus the additive ``X-Total-Count`` / ``X-Offset`` meta headers.
  * The OpenAPI spec carries the typed analytics schemas instead of the generic
    ``LegacySuccessResponse`` fallback for these routes.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi.routing import APIRoute

from app import analytics
from app.main import app
from app.models import (
    Attempt,
    AttemptMode,
    Question,
    QuestionSource,
    SessionType,
    StudySession,
)
from app.schemas import (
    ActivityDay,
    ByTypeRow,
    CrossDomainAnalytics,
    DashboardAnalytics,
)


# --- route table assertions -------------------------------------------------
_TYPED_ANALYTICS_ROUTES: dict[tuple[str, str], type] = {
    ("/api/analytics/dashboard", "GET"): DashboardAnalytics,
    ("/api/analytics/by-type", "GET"): list[ByTypeRow],
    ("/api/analytics/activity", "GET"): list[ActivityDay],
    ("/api/analytics/cross-domain", "GET"): CrossDomainAnalytics,
}

_PAGINATED_ANALYTICS_ROUTES = ["/api/analytics/by-type", "/api/analytics/activity"]


def _api_routes() -> list[APIRoute]:
    return [r for r in app.routes if isinstance(r, APIRoute)]


def _route_for(path: str, method: str) -> APIRoute:
    for r in _api_routes():
        if r.path == path and method in r.methods:
            return r
    raise AssertionError(f"route not found: {method} {path}")


def _query_param_names(route: APIRoute) -> set[str]:
    return {p.name for p in route.dependant.query_params}


def test_analytics_routes_declare_response_models():
    for (path, method), model in _TYPED_ANALYTICS_ROUTES.items():
        route = _route_for(path, method)
        assert route.response_model == model, (
            f"{method} {path} response_model is {route.response_model!r}, "
            f"expected {model!r}"
        )


def test_list_analytics_routes_accept_limit_and_offset():
    for path in _PAGINATED_ANALYTICS_ROUTES:
        params = _query_param_names(_route_for(path, "GET"))
        assert {"limit", "offset"} <= params, (
            f"GET {path} missing limit/offset (has {sorted(params)})"
        )


# --- BC: default list payloads unchanged + slicing + headers ----------------
def test_by_type_pagination_is_backward_compatible(client):
    full = client.get("/api/analytics/by-type?source=all").json()
    assert isinstance(full, list) and full
    # Every documented model field is present on the wire (additive model -> the
    # row may also carry extra analytics keys, which is fine and BC).
    assert set(full[0].keys()) >= set(ByTypeRow.model_fields.keys())
    # Default = full list, byte-identical to legacy.
    assert client.get("/api/analytics/by-type?source=all&offset=0").json() == full
    # limit slices from the front; offset skips.
    assert client.get("/api/analytics/by-type?source=all&limit=1").json() == full[:1]
    if len(full) > 1:
        assert (
            client.get("/api/analytics/by-type?source=all&limit=1&offset=1").json()
            == full[1:2]
        )
    # Out-of-range offset -> empty list, never an error.
    assert client.get(f"/api/analytics/by-type?source=all&offset={len(full) + 9}").json() == []


def test_by_type_sets_meta_headers(client):
    full = client.get("/api/analytics/by-type?source=all").json()
    resp = client.get("/api/analytics/by-type?source=all&limit=1")
    assert resp.headers["X-Total-Count"] == str(len(full))
    assert resp.headers["X-Limit"] == "1"
    assert resp.headers["X-Offset"] == "0"
    # No limit -> no X-Limit header, but total/offset still present.
    plain = client.get("/api/analytics/by-type?source=all")
    assert plain.headers["X-Total-Count"] == str(len(full))
    assert "X-Limit" not in plain.headers


def test_activity_pagination_is_backward_compatible(client):
    full = client.get("/api/analytics/activity?days=30").json()
    assert isinstance(full, list) and len(full) == 30
    assert set(full[0].keys()) == set(ActivityDay.model_fields.keys())
    assert client.get("/api/analytics/activity?days=30").json() == full
    assert client.get("/api/analytics/activity?days=30&limit=5").json() == full[:5]
    assert client.get("/api/analytics/activity?days=30&limit=5&offset=5").json() == full[5:10]
    resp = client.get("/api/analytics/activity?days=30&limit=5")
    assert resp.headers["X-Total-Count"] == "30"


def test_dashboard_shape_unchanged_under_response_model(client):
    d = client.get("/api/analytics/dashboard").json()
    for key in ("predicted_score", "score_delta_30d", "trend",
                "weakest_types", "coach", "streak_days"):
        assert key in d
    assert isinstance(d["trend"], list)
    # The coach sub-dict (an additive nested shape) survives intact thanks to
    # the permissive (extra='allow') response model.
    assert "text" in d["coach"] and "recommendation" in d["coach"]
    assert d["coach"]["source"] == "local_coach_context_v1"


# --- cross-domain rollup ----------------------------------------------------
def test_cross_domain_lsat_only_shape(client):
    body = client.get("/api/analytics/cross-domain?days=30").json()
    # Envelope + top-level keys.
    assert set(body.keys()) >= {
        "meta", "study_minutes", "combined_streak_days",
        "accuracy_by_domain", "weakest_types", "trend_30d",
    }
    meta = body["meta"]
    assert meta["model"] == "cross_domain_analytics_v1"
    assert meta["window_days"] == 30
    assert meta["host_provided"] is False  # no host numbers passed
    assert isinstance(meta["weakest_total"], int)

    domains = {d["domain"]: d for d in body["accuracy_by_domain"]}
    assert set(domains) == {"lsat", "host"}
    # Seed bank has LSAT attempts; host side is empty here.
    assert domains["lsat"]["attempts"] >= 1
    assert domains["host"]["attempts"] == 0
    assert domains["host"]["accuracy"] is None

    # 30-day trend is zero-filled per day, host_questions == 0 with no host data.
    assert len(body["trend_30d"]) == 30
    for row in body["trend_30d"]:
        assert row["questions"] == row["lsat_questions"] + row["host_questions"]
        assert row["host_questions"] == 0
    # Weakest types are LSAT-only and ranked weakest-first (ascending accuracy,
    # None last).
    accs = [w["accuracy"] for w in body["weakest_types"] if w["accuracy"] is not None]
    assert accs == sorted(accs)
    assert all(w["domain"] == "lsat" for w in body["weakest_types"])


def test_cross_domain_merges_host_numbers(client):
    body = client.get(
        "/api/analytics/cross-domain"
        "?days=30&host_attempts=40&host_correct=30&host_study_minutes=120&host_streak_days=9"
    ).json()
    meta = body["meta"]
    assert meta["host_provided"] is True

    domains = {d["domain"]: d for d in body["accuracy_by_domain"]}
    assert domains["host"]["attempts"] == 40
    assert domains["host"]["correct"] == 30
    assert domains["host"]["accuracy"] == 0.75
    assert domains["host"]["study_minutes"] == 120.0
    assert domains["host"]["streak_days"] == 9

    # Combined study time folds the host minutes in.
    assert body["study_minutes"] == round(domains["lsat"]["study_minutes"] + 120.0, 1)
    # Combined streak = the longest active run across domains.
    assert body["combined_streak_days"] == max(domains["lsat"]["streak_days"], 9)


def test_cross_domain_weakest_pagination(client):
    full = client.get("/api/analytics/cross-domain?days=120").json()
    total = full["meta"]["weakest_total"]
    assert total == len(full["weakest_types"])
    if total >= 2:
        sliced = client.get("/api/analytics/cross-domain?days=120&weakest_limit=1").json()
        assert len(sliced["weakest_types"]) == 1
        assert sliced["meta"]["weakest_total"] == total  # pre-slice count preserved
        assert sliced["meta"]["weakest_limit"] == 1
        assert sliced["weakest_types"][0] == full["weakest_types"][0]
        # offset skips from the front.
        off = client.get("/api/analytics/cross-domain?days=120&weakest_limit=1&weakest_offset=1").json()
        assert off["weakest_types"][0] == full["weakest_types"][1]


def test_cross_domain_merges_host_weakest_via_function(db_session):
    """The analytics function interleaves host weakest rows (ranked with the LSAT
    ones, weakest-first). Exercised at the function layer because the richer
    host_weakest list is body-shaped (the route exposes only scalar query
    numbers — DATA-4a owns the persisted host->backend feed)."""
    out = analytics.cross_domain(
        db_session,
        days=120,
        host_weakest=[
            {"label": "CFA::Ethics", "accuracy": 0.10, "attempts": 20},
            {"label": "CFA::Derivatives", "accuracy": 0.95, "attempts": 12},
        ],
    )
    labels = [w["label"] for w in out["weakest_types"]]
    assert "CFA::Ethics" in labels and "CFA::Derivatives" in labels
    # The host rows are tagged as host-domain and ranked weakest-first alongside
    # the LSAT rows: the 0.10-accuracy Ethics topic sorts ahead of the
    # 0.95-accuracy Derivatives topic in the merged list.
    ethics = next(w for w in out["weakest_types"] if w["label"] == "CFA::Ethics")
    derivs = next(w for w in out["weakest_types"] if w["label"] == "CFA::Derivatives")
    assert ethics["domain"] == "host" and derivs["domain"] == "host"
    assert labels.index("CFA::Ethics") < labels.index("CFA::Derivatives")
    # The lowest-accuracy entry overall sits at the top (ascending accuracy).
    top_acc = out["weakest_types"][0]["accuracy"]
    assert top_acc is None or top_acc <= ethics["accuracy"]
    assert out["meta"]["host_provided"] is True


def test_cross_domain_streak_counts_recent_attempt(db_session):
    """A fresh LSAT attempt today lights the combined streak even with no host
    data, and the per-day trend reflects today's activity."""
    q = Question(
        stem="A cross-domain streak diagnostic stem with enough descriptive text.",
        prompt="Which answer is best supported?",
        correct_answer="A",
        q_type="CrossDomainStreakType",
        difficulty=3,
        source=QuestionSource.sample,
    )
    sess = StudySession(type=SessionType.drill)
    db_session.add_all([q, sess])
    db_session.commit()
    db_session.refresh(q)
    db_session.refresh(sess)
    now = datetime.now(timezone.utc)
    db_session.add(
        Attempt(
            question_id=q.id,
            session_id=sess.id,
            mode=AttemptMode.drill,
            chosen_answer="A",
            is_correct=True,
            time_ms=60_000,
            created_at=now,
        )
    )
    db_session.commit()

    out = analytics.cross_domain(db_session, days=30)
    assert out["combined_streak_days"] >= 1
    today_key = now.date().isoformat()
    today_row = next(r for r in out["trend_30d"] if r["date"] == today_key)
    assert today_row["lsat_questions"] >= 1
