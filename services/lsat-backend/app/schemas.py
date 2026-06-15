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
