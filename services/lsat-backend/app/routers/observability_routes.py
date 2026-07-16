"""Observability status (H6/A13) for the Settings trust strip."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from sqlmodel import Session, select

from .. import ai, backup, config, jobs, llm, migrations, observability, relocation, trust
from ..db import engine, get_session
from ..models import CoachSnapshot, EmbeddingVector, GenJob, GenStatus, Question

router = APIRouter()


# ---------------------------------------------------------------------------
# Response models (wire-exact, permissive) — endpoint-local convention, see
# UnifiedAbilityEstimate in adaptivity_routes.py. Every model allows extra keys
# (extra="allow") so additive payload fields keep serializing without a
# contract break, and every route pairs its model with
# ``response_model_exclude_unset=True`` so keys a handler didn't set stay
# absent instead of serializing as ``null``. Dynamically-keyed or
# provider-dependent sub-shapes (the provider capability matrix, PRAGMA maps,
# parsed-log-line events, the full readiness tree) deliberately stay
# ``dict[str, Any]`` — never enumerate their keys.
# ---------------------------------------------------------------------------


class ObsCloudTokensOut(BaseModel):
    """In-RAM cloud token counters (``observability.cloud_token_totals``)."""

    model_config = ConfigDict(extra="allow")

    input_tokens: int
    output_tokens: int
    total_tokens: int


class ObservabilityStatusOut(BaseModel):
    """GET /observability/status — live backend health for the trust strip."""

    model_config = ConfigDict(extra="allow")

    gen_queued: int
    gen_running: int
    worker_alive: bool
    last_coach_refresh_ms: int | None = None
    explain_p50_ms: float | None = None
    embed_coverage_pct: float
    # llm.provider_info(): capabilities.matrix is dynamically keyed by provider.
    models: dict[str, Any]
    llm_cache: dict[str, Any]
    cloud_tokens: ObsCloudTokensOut
    cloud_monthly_budget_usd: float | None = None
    cloud_spend_mtd_usd: float
    cloud_budget_within: bool
    cloud_budget_remaining_usd: float | None = None
    explain_p50_ms_persisted: float | None = None
    backend_ready: bool
    db_ready: bool
    worker_ready: bool
    backup_status: str
    # Full observability.backend_readiness() tree (db.pragmas is PRAGMA-keyed).
    readiness: dict[str, Any]


class ReadyAiOut(BaseModel):
    """AI-provider block of GET /ready (partly provider-dependent)."""

    model_config = ConfigDict(extra="allow", protected_namespaces=())

    ready: bool
    provider_reachable: bool
    ollama_reachable: bool
    models: list[str]
    expected_models: dict[str, str]
    model_available: dict[str, bool]
    provider: str | None = None
    realtime_provider: str | None = None
    # {realtime, offline, matrix} — matrix is dynamically keyed by provider.
    capabilities: dict[str, Any]


class ReadyOut(BaseModel):
    """GET /ready — launch readiness for sidecar smoke tests."""

    model_config = ConfigDict(extra="allow")

    ok: bool
    status: str
    generated_at: str
    request_id: str | None = None
    db: dict[str, Any]
    worker: dict[str, Any]
    backup: dict[str, Any]
    ai: ReadyAiOut
    errors: list[str]
    warnings: list[str]


class MetricsRecentCallOut(BaseModel):
    """One ``UsageLedger`` tail row on GET /observability/metrics."""

    model_config = ConfigDict(extra="allow")

    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float
    created_at: str | None = None


class MetricsCloudOut(BaseModel):
    """``cloud`` block of GET /observability/metrics (budget status + pricing)."""

    model_config = ConfigDict(extra="allow")

    spend_usd: float
    budget_usd: float | None = None
    within_budget: bool
    remaining_usd: float | None = None
    input_cost_per_mtok_usd: float
    output_cost_per_mtok_usd: float
    recent_calls: list[MetricsRecentCallOut]


class MetricsOut(BaseModel):
    """GET /observability/metrics — persisted latency + cloud-spend reads."""

    model_config = ConfigDict(extra="allow")

    task: str
    window: int
    latency_p50_ms: float | None = None
    cloud: MetricsCloudOut


class CloudBudgetPricingOut(BaseModel):
    """``pricing`` block of ``llm.cloud_budget_dry_run``."""

    model_config = ConfigDict(extra="allow")

    input_cost_per_mtok_usd: float
    output_cost_per_mtok_usd: float


class CloudBudgetNextCallOut(BaseModel):
    """``next_call`` dry-run forecast of ``llm.cloud_budget_dry_run``."""

    model_config = ConfigDict(extra="allow")

    input_tokens: int
    output_tokens: int
    estimated_cost_usd: float
    would_exceed_budget: bool


class CloudBudgetDryRunOut(BaseModel):
    """``cloud`` block of GET /observability/cloud-budget."""

    model_config = ConfigDict(extra="allow")

    spend_usd: float
    budget_usd: float | None = None
    within_budget: bool
    remaining_usd: float | None = None
    cloud_enabled: bool
    cloud_configured: bool
    cloud_egress_allowed: bool
    dry_run: bool
    pricing: CloudBudgetPricingOut
    next_call: CloudBudgetNextCallOut


class VoiceCacheStatusOut(BaseModel):
    """``voice`` block of GET /observability/cloud-budget
    (``observability.whisper_cache_status``)."""

    model_config = ConfigDict(extra="allow", protected_namespaces=())

    model_id: str
    cache_dir: str
    cache_dir_exists: bool
    downloaded: bool
    file_count: int
    size_bytes: int
    browser_cached: bool
    note: str


class CloudBudgetOut(BaseModel):
    """GET /observability/cloud-budget — budget picture + voice cache."""

    model_config = ConfigDict(extra="allow")

    cloud: CloudBudgetDryRunOut
    voice: VoiceCacheStatusOut


class RuntimeEvidenceOut(BaseModel):
    """GET /observability/runtime-evidence
    (``observability.runtime_evidence_summary``)."""

    model_config = ConfigDict(extra="allow")

    ok: bool
    status: str
    generated_at: str
    log_dir: str
    log_dir_exists: bool
    log_dir_writable: bool
    log_file_count: int
    # Per-file payloads / parsed-log-line events carry variable keys.
    log_files: list[dict[str, Any]]
    recent_error_count: int
    stale_error_count: int
    recent_error_window_hours: int
    recent_errors: list[dict[str, Any]]
    last_request_error: dict[str, Any] | None = None
    metrics: dict[str, Any]
    crash_free_window: dict[str, Any]


class SqliteHealthOut(BaseModel):
    """GET /observability/sqlite-health (``observability.sqlite_health``)."""

    model_config = ConfigDict(extra="allow")

    # PRAGMA-name-keyed, mixed str/int values — must stay open.
    pragmas: dict[str, Any]
    busy_retries: int
    wal_estimate_if_cheap: int | None = None


class ObsTrustStatusOut(BaseModel):
    """GET /observability/trust-status (``trust.trust_status``)."""

    model_config = ConfigDict(extra="allow")

    status: str
    tier: str
    generated_at: str
    cache_ttl_seconds: int
    # Three fixed check keys today, but each check's inner shape is
    # check-specific (status/summary/detail/action with polymorphic detail).
    checks: dict[str, dict[str, Any]]


class HealthAggregatedOut(BaseModel):
    """GET /observability/health-aggregated — consolidated System Health."""

    model_config = ConfigDict(extra="allow")

    status: str
    ok: bool
    generated_at: str
    reasons: list[str]
    backend_ready: bool
    db_ready: bool
    worker_ready: bool
    backup_status: str
    gen_queued: int
    gen_running: int
    explain_p50_ms: float | None = None
    cloud_tokens: ObsCloudTokensOut
    cloud_monthly_budget_usd: float | None = None
    cloud_spend_mtd_usd: float
    cloud_budget_within: bool
    sqlite_health: SqliteHealthOut
    # {realtime, offline, matrix} — matrix is dynamically keyed by provider.
    provider_capabilities: dict[str, Any]
    # Full backend_readiness tree (same shape as /observability/status).
    readiness: dict[str, Any]


class SchemaVersionsOut(BaseModel):
    """GET /observability/schema-versions — cross-domain version handshake."""

    model_config = ConfigDict(extra="allow")

    cross_domain_schema_version: int
    db_user_version: int
    latest_migration_version: int
    host_min_supported: int
    generated_at: str


class RelocationStatusOut(BaseModel):
    """GET /observability/relocation-status (``relocation.relocation_status``).

    Field names are the HOST-FACING camelCase contract — tests assert exact
    key-SET equality on the wire payload, so never rename/alias these."""

    model_config = ConfigDict(extra="allow")

    status: str
    generated_at: str
    orphaned: bool
    oldPath: str | None = None
    newPath: str | None = None
    oldExists: bool
    newExists: bool
    sizeBytes: int | None = None
    samePath: bool


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _provider_capabilities_from_health(ai_health: dict[str, Any]) -> dict[str, Any]:
    capabilities = ai_health.get("capabilities")
    if isinstance(capabilities, dict):
        return capabilities
    realtime = (
        ai_health.get("provider")
        or ai_health.get("realtime_provider")
        or config.LOCAL_PROVIDER
    )
    offline = ai_health.get("offline_provider") or llm.offline_provider_name()
    return {
        "realtime": llm.provider_capabilities(realtime),
        "offline": llm.provider_capabilities(offline),
        "matrix": llm.provider_capability_matrix(),
    }


@router.get(
    "/observability/status",
    response_model=ObservabilityStatusOut,
    response_model_exclude_unset=True,
)
def status(session: Session = Depends(get_session)) -> dict[str, Any]:
    """Live backend health: gen queue depth, worker liveness, coach freshness,
    explain latency p50, and embedding coverage."""
    gen_jobs = session.exec(select(GenJob)).all()
    gen_queued = sum(1 for j in gen_jobs if j.status == GenStatus.queued)
    gen_running = sum(1 for j in gen_jobs if j.status == GenStatus.running)

    worker = jobs.get_worker()
    worker_alive = worker._thread is not None and worker._thread.is_alive()

    snap = session.exec(
        select(CoachSnapshot).order_by(CoachSnapshot.id.desc())
    ).first()
    last_coach_refresh_ms = None
    if snap is not None:
        age = (datetime.now(timezone.utc) - _aware(snap.created_at)).total_seconds()
        last_coach_refresh_ms = round(age * 1000)

    q_total = len(session.exec(select(Question.id)).all())
    embedded = len(session.exec(
        select(EmbeddingVector.id).where(EmbeddingVector.kind == "question")
    ).all())
    embed_coverage_pct = round(100 * embedded / q_total, 1) if q_total else 0.0

    tokens = observability.cloud_token_totals()
    budget = config.CLOUD_MONTHLY_BUDGET_USD
    # 7.3 — durable, month-to-date spend (from UsageLedger) + its budget status.
    budget_status = llm.cloud_budget_status()
    integrity = backup.integrity_report()
    readiness = observability.backend_readiness(
        integrity_report=integrity,
        gen_queued=gen_queued,
        gen_running=gen_running,
    )
    return {
        "gen_queued": gen_queued,
        "gen_running": gen_running,
        "worker_alive": worker_alive,
        "last_coach_refresh_ms": last_coach_refresh_ms,
        "explain_p50_ms": observability.latency_p50("explain_stream"),
        "embed_coverage_pct": embed_coverage_pct,
        "models": llm.provider_info(),
        # BACK-1 — deterministic LLM response cache hit-rate counter (hits/misses/
        # stores + hit_rate + LRU size). RAM-only gauge, resets on restart like the
        # latency/contention gauges.
        "llm_cache": llm.cache_stats(),
        "cloud_tokens": tokens,
        "cloud_monthly_budget_usd": budget if budget > 0 else None,
        # --- 7.3 additive keys (existing keys above are preserved verbatim) ---
        # Month-to-date cloud spend in USD and whether the budget still allows a
        # cloud call. ``cloud_spend_mtd_usd`` is the persisted figure (survives a
        # restart, unlike the in-RAM token counters above).
        "cloud_spend_mtd_usd": budget_status["spend_usd"],
        "cloud_budget_within": budget_status["within_budget"],
        "cloud_budget_remaining_usd": budget_status["remaining_usd"],
        # Persisted explain p50 (durable equivalent of explain_p50_ms above).
        "explain_p50_ms_persisted": observability.persisted_latency_p50(
            "explain_stream", session=session
        ),
        # Backend-local readiness: DB integrity/catalog checks, backup freshness,
        # and worker liveness. Full details remain on /backup/integrity.
        "backend_ready": readiness["ok"],
        "db_ready": readiness["db"]["ready"],
        "worker_ready": readiness["worker"]["ready"],
        "backup_status": readiness["backup"]["status"],
        "readiness": readiness,
    }


@router.get("/ready", response_model=ReadyOut, response_model_exclude_unset=True)
async def ready(session: Session = Depends(get_session)) -> dict[str, Any]:
    """Launch readiness for sidecar smoke tests and operator diagnostics."""
    gen_jobs = session.exec(select(GenJob)).all()
    gen_queued = sum(1 for j in gen_jobs if j.status == GenStatus.queued)
    gen_running = sum(1 for j in gen_jobs if j.status == GenStatus.running)
    integrity = backup.integrity_report()
    readiness = observability.backend_readiness(
        integrity_report=integrity,
        gen_queued=gen_queued,
        gen_running=gen_running,
    )
    ai_health = await ai.health()
    model_names = set(ai_health.get("models") or [])
    expected_models = {
        "explain": config.EXPLAIN_MODEL,
        "explain_fallback": config.EXPLAIN_FALLBACK_MODEL,
        "diagnose": config.DIAGNOSE_MODEL,
        "generation": config.GEN_MODEL,
        "embedding": config.EMBED_MODEL,
    }
    model_available = {
        role: bool(
            name in model_names
            or name.split(":", 1)[0] in model_names
            or any(m.startswith(f"{name.split(':', 1)[0]}:") for m in model_names)
        )
        for role, name in expected_models.items()
    }
    explain_ready = (
        model_available["explain"] or model_available["explain_fallback"]
    )
    # Provider-agnostic reachability (mirrors doctor.build_report): gate on the
    # generic ``ok`` so a reachable LM Studio isn't reported as not-ready, and
    # name the active provider in the warning instead of always saying "ollama".
    provider_reachable = bool(ai_health.get("ok", ai_health.get("ollama")))
    active_provider = (
        ai_health.get("provider") or ai_health.get("realtime_provider") or "ollama"
    )
    capabilities = _provider_capabilities_from_health(ai_health)
    ai_ready = (
        provider_reachable
        and explain_ready
        and model_available["diagnose"]
        and model_available["generation"]
    )
    ai_warnings = []
    if not provider_reachable:
        ai_warnings.append(f"{active_provider}_unreachable")
    for role, available in model_available.items():
        if not available and not (role == "explain" and model_available["explain_fallback"]):
            ai_warnings.append(f"model_missing:{role}")
    warnings = readiness["warnings"] + ([] if ai_ready else ["ai_not_ready"]) + ai_warnings
    status_value = "error" if not readiness["ok"] else (
        "warning" if warnings else "ok"
    )
    return {
        "ok": readiness["ok"],
        "status": status_value,
        "generated_at": readiness["generated_at"],
        "request_id": observability.request_id_var.get(),
        "db": readiness["db"],
        "worker": readiness["worker"],
        "backup": readiness["backup"],
        "ai": {
            "ready": ai_ready,
            "provider_reachable": provider_reachable,
            "ollama_reachable": bool(ai_health.get("ollama")),
            "models": ai_health.get("models") or [],
            "expected_models": expected_models,
            "model_available": model_available,
            "provider": ai_health.get("offline_provider"),
            "realtime_provider": ai_health.get("realtime_provider"),
            "capabilities": capabilities,
        },
        "errors": readiness["errors"],
        "warnings": warnings,
    }


@router.get(
    "/observability/metrics",
    response_model=MetricsOut,
    response_model_exclude_unset=True,
)
def metrics(task: str = "explain_stream", window: int = 200,
            session: Session = Depends(get_session)) -> dict[str, Any]:
    """7.3 — historical/persisted observability reads (survive restarts).

    Backed by ``MetricSample`` (LLM latency p50 over a window) and ``UsageLedger``
    (cloud spend month-to-date + a small recent-call tail). Separate from
    /observability/status (live gauges) so the Diagnostics panel can show trends
    without bloating the status payload.
    """
    from ..models import UsageLedger

    recent = session.exec(
        select(UsageLedger).order_by(UsageLedger.id.desc()).limit(20)
    ).all()
    return {
        "task": task,
        "window": window,
        "latency_p50_ms": observability.persisted_latency_p50(
            task, window=window, session=session
        ),
        "cloud": {
            **llm.cloud_budget_status(),
            "input_cost_per_mtok_usd": config.CLOUD_INPUT_COST_PER_MTOK,
            "output_cost_per_mtok_usd": config.CLOUD_OUTPUT_COST_PER_MTOK,
            "recent_calls": [
                {
                    "model": r.model,
                    "input_tokens": r.input_tokens,
                    "output_tokens": r.output_tokens,
                    "cost_usd": round(r.cost_usd, 6),
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                }
                for r in recent
            ],
        },
    }


@router.get(
    "/observability/cloud-budget",
    response_model=CloudBudgetOut,
    response_model_exclude_unset=True,
)
def cloud_budget(
    input_tokens: int | None = None,
    output_tokens: int | None = None,
) -> dict[str, Any]:
    """BB4 — read-only cloud-budget picture + a NEXT-CALL dry-run cost estimate,
    plus local Whisper/voice model cache status.

    ``cloud`` carries month-to-date spend, the configured monthly budget, the
    remaining headroom, and a forecast of what the *next* cloud call would cost —
    priced identically to the real pre-call guard, but WITHOUT invoking any
    provider. Pass ``input_tokens``/``output_tokens`` to price a specific call;
    they default to the representative ``CLOUD_DRY_RUN_*`` token counts.

    ``voice`` reports the configured Whisper model id, the on-disk cache dir, and
    a best-effort presence check so the UI can show "downloaded / not downloaded"
    (the authoritative in-browser cache check lives on the host). Everything here
    is best-effort and never raises — a missing budget/metrics store or cache dir
    degrades softly to a visible-but-empty gauge.
    """
    return {
        "cloud": llm.cloud_budget_dry_run(input_tokens, output_tokens),
        "voice": observability.whisper_cache_status(),
    }


@router.get(
    "/observability/runtime-evidence",
    response_model=RuntimeEvidenceOut,
    response_model_exclude_unset=True,
)
def runtime_evidence(session: Session = Depends(get_session)) -> dict[str, Any]:
    """Local log/metric evidence for the native Reliability Console."""
    return observability.runtime_evidence_summary(session)


@router.get(
    "/observability/sqlite-health",
    response_model=SqliteHealthOut,
    response_model_exclude_unset=True,
)
def sqlite_health() -> dict[str, Any]:
    """BC4 — SQLite contention/PRAGMA snapshot.

    Returns the live connection PRAGMA values, the observed SQLITE_BUSY/LOCKED
    retry count since process start, and a cheap WAL-size estimate (``None`` when
    the WAL sidecar is absent or unreadable). O(1): no DB rows are read.
    """
    return observability.sqlite_health()


@router.get(
    "/observability/trust-status",
    response_model=ObsTrustStatusOut,
    response_model_exclude_unset=True,
)
def trust_status(
    tier: Literal["dev", "release", "packaged"] = "dev",
    refresh: bool = False,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """BC4 — cached lightweight trust verdict for the Settings trust strip.

    Runs only the content-health, privacy-firewall, and model-readiness checks
    (NOT the full release manifest) and rolls them up into a single
    ``ok`` | ``warning`` | ``blocked`` status. Cached ~1h; pass ``refresh=true``
    to recompute. The full manifest stays on /observability/trust.
    """
    return trust.trust_status(session, tier=tier, force_refresh=refresh)


@router.get(
    "/observability/health-aggregated",
    response_model=HealthAggregatedOut,
    response_model_exclude_unset=True,
)
def health_aggregated(session: Session = Depends(get_session)) -> dict[str, Any]:
    """OPS-3 — one consolidated System-Health roll-up for the host header badge
    and Runtime Metrics tab.

    Folds the *backend-local* signals already exposed piecemeal across this
    router — backend_readiness (DB integrity / worker liveness / backup
    freshness), sqlite_health (PRAGMA / WAL / SQLITE_BUSY contention), the
    in-RAM cloud token counters, the gen-queue depth, and the live LLM explain
    p50 — into a single ``ok`` | ``degraded`` | ``error`` verdict so the host
    doesn't have to fan out four requests just to draw a header badge.

    ADDITIVE: every underlying read already has its own endpoint; this one only
    reuses them. The verdict mirrors the readiness convention used by ``/ready``
    (``error`` when the backend isn't ready, ``degraded`` when it's ready but has
    warnings, ``ok`` otherwise). The host's own sidecar roll-up (the native
    Electron sidecar aggregate) layers process supervision on
    top of this; this endpoint speaks only for the LSAT backend's own health.

    O(1)-ish and never raises: each component read degrades softly on its own, so
    a missing WAL file or an unstarted worker yields a visible-but-degraded badge
    rather than a 500.
    """
    gen_jobs = session.exec(select(GenJob)).all()
    gen_queued = sum(1 for j in gen_jobs if j.status == GenStatus.queued)
    gen_running = sum(1 for j in gen_jobs if j.status == GenStatus.running)

    integrity = backup.integrity_report()
    readiness = observability.backend_readiness(
        integrity_report=integrity,
        gen_queued=gen_queued,
        gen_running=gen_running,
    )
    db_health = observability.sqlite_health()
    tokens = observability.cloud_token_totals()
    budget = config.CLOUD_MONTHLY_BUDGET_USD
    budget_status = llm.cloud_budget_status()
    provider_capabilities = _provider_capabilities_from_health({
        "realtime_provider": config.LOCAL_PROVIDER,
        "offline_provider": llm.offline_provider_name(),
    })

    # Single rolled-up verdict. backend_readiness already classifies itself as
    # ok/warning/error; map "warning" → "degraded" for the host badge vocabulary
    # and fold an over-budget cloud spend into "degraded" too (a soft signal —
    # local study is unaffected, but the operator should see it).
    over_budget = bool(budget and budget > 0 and not budget_status["within_budget"])
    if not readiness["ok"]:
        verdict = "error"
    elif readiness["status"] == "warning" or over_budget:
        verdict = "degraded"
    else:
        verdict = "ok"

    reasons = list(readiness["errors"]) + list(readiness["warnings"])
    if over_budget:
        reasons.append("cloud_over_budget")

    return {
        "status": verdict,
        "ok": readiness["ok"],
        "generated_at": readiness["generated_at"],
        "reasons": reasons,
        # Component roll-ups (each already individually exposed elsewhere).
        "backend_ready": readiness["ok"],
        "db_ready": readiness["db"]["ready"],
        "worker_ready": readiness["worker"]["ready"],
        "backup_status": readiness["backup"]["status"],
        "gen_queued": gen_queued,
        "gen_running": gen_running,
        "explain_p50_ms": observability.latency_p50("explain_stream"),
        # Runtime-metric trends source: live cloud token counters + MTD spend.
        "cloud_tokens": tokens,
        "cloud_monthly_budget_usd": budget if budget > 0 else None,
        "cloud_spend_mtd_usd": budget_status["spend_usd"],
        "cloud_budget_within": budget_status["within_budget"],
        # DB health: PRAGMA / WAL / SQLITE_BUSY contention snapshot.
        "sqlite_health": db_health,
        "provider_capabilities": provider_capabilities,
        # Full nested readiness for drill-down (same shape as /observability/status).
        "readiness": readiness,
    }


@router.get(
    "/observability/schema-versions",
    response_model=SchemaVersionsOut,
    response_model_exclude_unset=True,
)
def schema_versions() -> dict[str, Any]:
    """DATA-3 — the cross-domain schema-version handshake.

    Reports the version of the SHARED cross-domain field-semantics contract this
    backend speaks (recorded in SQLite by migration 22, pinned by
    docs/DATA-DICTIONARY.md), alongside the SQLite ``PRAGMA user_version`` and the
    latest recorded migration version for diagnostics. The host reads this on boot
    and disables CROSS-DOMAIN writes (host->LSAT / LSAT->host) — NOT local writes —
    when the versions are incompatible, surfaced as the "data planes aligned"
    check on System Health. The cheapest guard against an old SQLite + new Dexie
    silently losing data on a cross-plane write.

    O(1) and never raises: a DB that pre-dates migration 22 still reports the
    code-default version rather than erroring."""
    with engine.begin() as conn:
        cross_domain_version = migrations.read_cross_domain_schema_version(conn)
        try:
            user_version = int(conn.exec_driver_sql("PRAGMA user_version").fetchone()[0] or 0)
        except Exception:  # pragma: no cover - PRAGMA always available
            user_version = 0
    latest_migration = max((m[0] for m in migrations.MIGRATIONS), default=0)
    return {
        "cross_domain_schema_version": cross_domain_version,
        "db_user_version": user_version,
        "latest_migration_version": latest_migration,
        "host_min_supported": migrations.CROSS_DOMAIN_HOST_MIN_SUPPORTED,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


@router.get(
    "/observability/relocation-status",
    response_model=RelocationStatusOut,
    response_model_exclude_unset=True,
)
def relocation_status() -> dict[str, Any]:
    """DATA-7 — app-data relocation guard status (read-only).

    A bundle-id / app-data-dir change can orphan the LSAT SQLite store under the
    OLD OS app-data dir (``%APPDATA%/LSATLab`` on Windows). DATA-3 only versions
    the cross-domain contract; it never moves stores. This endpoint reports
    whether a recoverable store sits at the old path while the active (NEW) store
    is absent/empty, so the host can prompt the user / surface a "data found at
    old location" affordance.

    Folds ``relocation.relocation_status`` into a single ``status``
    (``ok`` | ``orphaned``) verdict plus the resolved old/new paths and existence
    flags. O(1)-ish (a couple of ``stat`` calls) and never raises: an
    unresolvable OS base or an unreadable dir degrades to a visible-but-empty
    field rather than a 500. No DB writes."""
    return relocation.relocation_status()
