"""BC2 — shared Pydantic response models for high-traffic list endpoints.

Each model EXACTLY mirrors the JSON a route already returns (field names, types,
and nullability). They are attached to routes via ``response_model=`` so the
OpenAPI spec carries a real schema instead of the generic ``LegacySuccessResponse``
fallback — WITHOUT changing the bytes on the wire. The host
(``src/lib/lsatBackend.ts``) and the existing route tests consume these payloads,
so the models are intentionally permissive where the source data is optional
(``None``) and never add, drop, or rename a field.

Typing is rolled out incrementally, "high-traffic first" (per the roadmap):
bare-list endpoints (preptests, sessions, dataset sources) plus the bank-stats
headline. Endpoints whose payloads are opaque analytics dicts or vary by
serializer mode keep the legacy fallback for now and are recorded as remaining
coverage in ``tests/test_response_models.py``.
"""
from __future__ import annotations

from pydantic import BaseModel


class PrepTestSummary(BaseModel):
    """One row of ``GET /api/preptests`` (the PrepTest list view).

    Mirrors the dict built in ``routers.content.list_preptests`` from
    ``queries.bulk_preptest_stats``. ``id``/``date_admin`` are nullable because
    the underlying ``PrepTest`` columns are ``Optional``.
    """

    id: int | None
    name: str
    source: str
    date_admin: str | None
    is_official: bool
    section_count: int
    completed_sections: int


class SessionSummary(BaseModel):
    """One row of ``GET /api/sessions`` (the enriched study-session history).

    Mirrors the dict built in ``routers.sessions.list_sessions``. Several fields
    are ``None`` when the session has no relevant attempts (e.g. no blind-review
    answers, no official timed questions) or has not ended yet.
    """

    id: int | None
    type: str
    started: str
    ended: str | None
    scaled_score: int | None
    question_count: int
    duration_sec: int | None
    br_accuracy: float | None
    official_only_score: int | None


class DatasetSource(BaseModel):
    """One entry of ``GET /api/bank/sources`` (the research-dataset registry).

    Mirrors the dict built in ``routers.dataset_routes.sources`` from each
    ``import_dataset.DatasetSpec``.
    """

    key: str
    hf_dataset: str
    hf_split: str
    section_type: str
    preptest_name: str
    license: str
    expected_fields: list[str]
    question_source: str
    requires_local_path: bool
    requires_nc_acknowledgement: bool


class BankStats(BaseModel):
    """``GET /api/bank/stats`` — the Bank UI headline counts.

    Mirrors the dict built in ``routers.dataset_routes.stats`` from
    ``bank_bootstrap.bank_stats``.
    """

    total: int
    by_source: dict[str, int]
    by_q_type: dict[str, int]
    available_sources: list[str]


# --- ANL-1 — analytics response models --------------------------------------
# These mirror the dicts ``app.analytics`` already returns for the high-traffic
# analytics routes the host reads via the generated client (api.gen.ts ->
# api.ts: ``dashboard`` / ``byType`` / ``activity``). Attaching them as
# ``response_model=`` carries a real schema into the OpenAPI spec instead of the
# ``LegacySuccessResponse`` fallback, WITHOUT changing a byte on the wire. Models
# are intentionally permissive (``extra='allow'``) so additive analytics keys
# (e.g. a future ``coach`` signal) never need a schema bump and the response
# stays byte-identical — FastAPI serializes the route's returned dict, not a
# narrowed projection of it.


class _AdditiveModel(BaseModel):
    """Base for the analytics response models: allow (and serialize) any extra
    keys the underlying analytics dict carries, so the wire payload is unchanged
    and additive analytics fields don't require a schema edit."""

    model_config = {"extra": "allow"}


class ByTypeRow(_AdditiveModel):
    """One row of ``GET /api/analytics/by-type`` (mirrors ``analytics.by_type``)."""

    q_type: str
    section_type: str
    attempts: int
    accuracy: float
    avg_time_ms: int
    trend: str
    efficiency_band: str


class ActivityDay(_AdditiveModel):
    """One day of ``GET /api/analytics/activity`` (mirrors ``analytics.activity``)."""

    date: str
    questions: int
    minutes: float
    correct: int
    sessions: int


class DashboardAnalytics(_AdditiveModel):
    """``GET /api/analytics/dashboard`` (mirrors ``analytics.dashboard``).

    ``trend``/``weakest_types``/``coach`` are left as open shapes here because
    each is itself an additive analytics sub-dict; pinning only the headline
    scalar keys keeps the schema honest without freezing nested analytics that
    still evolve. ``extra='allow'`` carries everything else through unchanged.
    """

    predicted_score: int | None
    score_delta_30d: int | None
    trend: list[dict]
    weakest_types: list[dict]
    coach: dict
    streak_days: int


class CrossDomainDomainStat(_AdditiveModel):
    """Per-domain rollup inside ``GET /api/analytics/cross-domain``."""

    domain: str
    attempts: int
    correct: int
    accuracy: float | None
    study_minutes: float
    streak_days: int


class CrossDomainWeakType(_AdditiveModel):
    """One merged weakest-type entry across both domains."""

    domain: str
    label: str
    accuracy: float | None
    attempts: int


class CrossDomainTrendPoint(_AdditiveModel):
    """One day of the combined 30-day activity trend."""

    date: str
    lsat_questions: int
    host_questions: int
    questions: int


class CrossDomainMeta(_AdditiveModel):
    """BC2/BC3 meta envelope for the cross-domain payload (window + pagination +
    provenance), kept as a sibling so the data fields stay additive."""

    model: str
    window_days: int
    host_provided: bool
    generated_at: str
    weakest_total: int
    weakest_limit: int | None
    weakest_offset: int


class CrossDomainAnalytics(_AdditiveModel):
    """``GET /api/analytics/cross-domain`` — bidirectional study rollup.

    Aggregates LSAT-side study time, accuracy-by-domain, merged weakest types,
    a combined streak, and a 30-day activity trend. Host-side numbers (CFA/Quant)
    can be merged in via query params; when omitted the payload is the LSAT-only
    view and ``meta.host_provided`` is False (the host then merges its own Dexie
    analytics with this payload client-side — DATA-4a owns the persisted feed)."""

    meta: CrossDomainMeta
    study_minutes: float
    combined_streak_days: int
    accuracy_by_domain: list[CrossDomainDomainStat]
    weakest_types: list[CrossDomainWeakType]
    trend_30d: list[CrossDomainTrendPoint]
