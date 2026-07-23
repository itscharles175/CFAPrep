"""Analytics endpoints (thin wrappers over app.analytics).

All time-series endpoints accept an optional ``?days=`` window applied
server-side (the frontend previously filtered client-side only).

BC3 — query budget: these routes delegate to ``app.analytics``, which already
fetches attempts/questions in a fixed number of set-based queries (the ``days``
window is pushed into SQL and ``_question_map`` loads only the referenced ids)
rather than issuing one query per attempt/section. ``tests/test_query_budget.py``
guards the ``/analytics/dashboard`` path against query-count regressions so a
re-introduced N+1 loop fails CI.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, ConfigDict
from sqlmodel import Session

from .. import analytics
from ..db import get_session
from ..pagination import LimitQuery, OffsetQuery, paginate
from ..schemas import (
    ActivityDay,
    ByTypeRow,
    CrossDomainAnalytics,
    DashboardAnalytics,
)

router = APIRouter(prefix="/analytics")


# ANL-3 — inline response_model for the cross-domain blind-review gap. Every field
# is Optional so the BACKWARD-COMPATIBLE default branch (no ``?domain=`` ->
# ``analytics.blind_review_gap``, which has no ``meta``/``by_domain``) is not
# stripped, while the cross-domain branch's extra fields validate cleanly. The
# nested blocks stay open dicts (the per-domain ``_br_block`` shape) so adding a
# diagnostic key later doesn't require a schema bump.
class BlindReviewGapResponse(BaseModel):
    timed_accuracy: float
    br_accuracy: float
    gap: float
    by_type: list[dict]
    lucky_rate_by_type: dict[str, float]
    # Cross-domain-only additions (present only when ``?domain=`` is supplied).
    meta: Optional[dict] = None
    outcomes: Optional[dict] = None
    careless_rate: Optional[float] = None
    concept_gap_rate: Optional[float] = None
    lucky_rate: Optional[float] = None
    by_domain: Optional[dict] = None

# ANL-2 — inline response_model for the unified weakness index. ``meta`` carries
# the pagination + provenance envelope; ``items`` is the ranked weakness list. The
# item rows stay an open dict list (the merged LSAT-mastery / host-accuracy shape)
# so adding a diagnostic field later doesn't require a schema bump — same idiom as
# ``BlindReviewGapResponse`` above.
class WeaknessIndexResponse(BaseModel):
    meta: dict
    items: list[dict]


_Days = Query(None, ge=1, le=730, description="restrict to the last N days")


def _set_list_meta(response: Response, *, total: int,
                   limit: Optional[int], offset: Optional[int]) -> None:
    """BC3 — surface the list-pagination meta envelope on response HEADERS.

    Headers are additive: the JSON body stays the exact bare list the host +
    existing tests consume (wrapping the list in a ``{data, meta}`` envelope would
    break that bare-list contract — see ``app.pagination``). ``X-Total-Count`` is
    the full (pre-slice) length; ``X-Limit``/``X-Offset`` echo the applied window
    so a paging client can compute "has more" without a separate count call."""
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Offset"] = str(offset or 0)
    if limit is not None:
        response.headers["X-Limit"] = str(limit)


@router.get("/dashboard", response_model=DashboardAnalytics)
def dashboard(days: Optional[int] = _Days, session: Session = Depends(get_session)):
    return analytics.dashboard(session, days=days)


@router.get("/by-type", response_model=list[ByTypeRow])
def by_type(response: Response,
            source: str = Query("all", pattern="^(official|all)$"),
            days: Optional[int] = _Days,
            limit: Optional[int] = LimitQuery,
            offset: Optional[int] = OffsetQuery,
            session: Session = Depends(get_session)):
    rows = analytics.by_type(session, source=source, days=days)
    _set_list_meta(response, total=len(rows), limit=limit, offset=offset)
    return paginate(rows, limit=limit, offset=offset)


@router.get("/timing/{session_id}")
def timing(session_id: int, session: Session = Depends(get_session)):
    return analytics.timing(session, session_id)


@router.get("/blind-review-gap", response_model=BlindReviewGapResponse)
def blind_review_gap(
    days: Optional[int] = _Days,
    domain: Optional[str] = Query(
        None,
        pattern="^(lsat|host|all|cfa|quant|excel)$",
        description=(
            "ANL-3 — evidence plane for the careless-vs-concept blind-review gap. "
            "Omit (or 'lsat') for the unchanged LSAT-only view; 'host' for the host "
            "planes; 'all' to merge both; or a specific host plane (cfa|quant|excel)."
        ),
    ),
    session: Session = Depends(get_session),
):
    """Blind-review gap (timed vs Blind-Review accuracy).

    BACKWARD-COMPATIBLE: with no ``?domain=`` this returns the LSAT-native
    ``analytics.blind_review_gap`` exactly as before. Supplying ``?domain=`` opts
    into the ANL-3 cross-domain merge (LSAT `Attempt` BR data + host BR attempts
    mirrored via DATA-4a's `HostProgressSnapshot`), adding the 2x2 outcome
    distribution, careless/concept/lucky rates, and per-domain blocks."""
    if domain is None:
        return analytics.blind_review_gap(session, days=days)
    return analytics.blind_review_gap_cross_domain(session, domain=domain, days=days)


@router.get("/traps")
def traps(days: Optional[int] = _Days, session: Session = Depends(get_session)):
    return analytics.traps(session, days=days)


@router.get("/by-difficulty")
def by_difficulty(source: str = Query("all", pattern="^(official|all)$"),
                  days: Optional[int] = _Days,
                  session: Session = Depends(get_session)):
    return analytics.by_difficulty(session, source=source, days=days)


@router.get("/mastery")
def mastery(source: str = Query("all", pattern="^(official|all)$"),
            days: Optional[int] = _Days,
            session: Session = Depends(get_session)):
    """Recency-weighted, difficulty-adjusted mastery per type (weakest first)."""
    return analytics.mastery(session, source=source, days=days)


@router.get("/activity", response_model=list[ActivityDay])
def activity(response: Response,
             days: int = Query(120, ge=1, le=730),
             limit: Optional[int] = LimitQuery,
             offset: Optional[int] = OffsetQuery,
             session: Session = Depends(get_session)):
    rows = analytics.activity(session, days=days)
    _set_list_meta(response, total=len(rows), limit=limit, offset=offset)
    return paginate(rows, limit=limit, offset=offset)


@router.get("/cross-domain", response_model=CrossDomainAnalytics)
def cross_domain(
    days: int = Query(30, ge=1, le=730,
                      description="trend / accuracy window (default 30 days)"),
    host_attempts: Optional[int] = Query(
        None, ge=0, description="optional host-side (CFA/Quant) attempt count"),
    host_correct: Optional[int] = Query(
        None, ge=0, description="optional host-side correct count"),
    host_study_minutes: Optional[float] = Query(
        None, ge=0, description="optional host-side study minutes in the window"),
    host_streak_days: Optional[int] = Query(
        None, ge=0, description="optional host-side current streak (days)"),
    weakest_limit: Optional[int] = Query(
        None, ge=1, le=1000,
        description="optional: cap the merged weakest-types list (default: all)"),
    weakest_offset: Optional[int] = Query(
        None, ge=0, description="optional: skip this many weakest-types rows"),
    session: Session = Depends(get_session),
):
    """ANL-1 — bidirectional cross-domain study rollup the HOST pulls and merges
    with its own Dexie analytics: combined study time, accuracy by domain, merged
    weakest types, the longest active streak across domains, and a 30-day activity
    trend. Host numbers are OPTIONAL (DATA-4a owns the persisted host->backend
    feed); omit them for the LSAT-only view (``meta.host_provided`` = False) and
    let the host merge its CFA/Quant numbers client-side."""
    return analytics.cross_domain(
        session,
        days=days,
        host_attempts=host_attempts,
        host_correct=host_correct,
        host_study_minutes=host_study_minutes,
        host_streak_days=host_streak_days,
        weakest_limit=weakest_limit,
        weakest_offset=weakest_offset,
    )


@router.get("/weakness-index", response_model=WeaknessIndexResponse)
def weakness_index(
    response: Response,
    domain: Optional[str] = Query(
        None,
        pattern="^(lsat|host|all|cfa|quant|excel)$",
        description=(
            "ANL-2 — evidence plane for the unified weakness index. Omit (or 'all') "
            "to merge LSAT + every host plane; 'lsat' for LSAT only; 'host' for the "
            "host planes; or a specific host plane (cfa|quant|excel)."
        ),
    ),
    days: Optional[int] = _Days,
    limit: Optional[int] = LimitQuery,
    offset: Optional[int] = OffsetQuery,
    session: Session = Depends(get_session),
):
    """ANL-2 — unified weakness index: LSAT per-type mastery + host per-topic
    accuracy merged into ONE list ranked by the ~95% credible LOWER bound (a
    confidently-weak area outranks a tiny noisy one), each row carrying recent-miss
    ids and a host-mountable recommended-drill deep-link. Honors the shared
    ``?days=`` window; ``?domain=`` selects the plane; ``?limit=``/``?offset=`` page
    the ranked list (the full count is echoed on ``X-Total-Count`` and in
    ``meta.total``)."""
    result = analytics.weakness_index(
        session, domain=domain, days=days, limit=limit, offset=offset,
    )
    _set_list_meta(
        response,
        total=int(result.get("meta", {}).get("total", len(result.get("items", [])))),
        limit=limit,
        offset=offset,
    )
    return result


@router.get("/feedback-cohorts")
def feedback_cohorts(days: Optional[int] = Query(90, ge=7, le=730),
                     session: Session = Depends(get_session)):
    """Longer-window daily-plan feedback cohorts for drill sequencing."""
    return analytics.feedback_cohorts(session, days=days)


@router.get("/feedback-outcomes")
def feedback_outcomes(
    feedback_days: Optional[int] = Query(90, ge=7, le=730),
    outcome_days: int = Query(30, ge=1, le=180),
    source: str = Query("all", pattern="^(official|all)$"),
    min_attempts: int = Query(3, ge=1, le=100),
    session: Session = Depends(get_session),
):
    """Source-filtered post-feedback outcomes for planner-weight readiness."""
    return analytics.feedback_outcomes(
        session,
        feedback_days=feedback_days,
        outcome_days=outcome_days,
        source=source,
        min_attempts=min_attempts,
    )


@router.get("/forecast")
def forecast(exam_date: Optional[str] = Query(None),
             target_score: Optional[int] = Query(None, ge=120, le=180),
             days: Optional[int] = _Days,
             session: Session = Depends(get_session)):
    """Project the score trend to the exam date with a confidence band."""
    return analytics.forecast(session, exam_date=exam_date,
                              target_score=target_score, days=days)


@router.get("/report")
def report(days: int = Query(120, ge=1, le=730),
           session: Session = Depends(get_session)):
    """Everything in one payload for a printable/exportable progress report."""
    return analytics.report(session, days=days)


@router.get("/type/{q_type}")
def type_analytics(q_type: str, days: Optional[int] = _Days,
                   session: Session = Depends(get_session)):
    """One payload for the TypeAnalytics page: accuracy/timing/trend, BR-gap
    slice, traps, and recent misses for a single question type."""
    return analytics.type_analytics(session, q_type, days=days)


@router.get("/focus/{session_id}")
def focus_quality(session_id: int, session: Session = Depends(get_session)):
    """Backend-derived focus-quality score for one session."""
    return analytics.focus_quality(session, session_id)


class CalibrationBandOut(BaseModel):
    """One confidence band from ``analytics.confidence_calibration`` — all five
    keys are always emitted (``accuracy`` is ``null`` on an empty band).
    ``extra="allow"`` keeps future additive band keys on the wire."""

    model_config = ConfigDict(extra="allow")

    confidence: str
    attempts: int
    correct: int
    accuracy: float | None = None
    nominal_confidence: float


class CalibrationOut(BaseModel):
    """Envelope for GET /api/analytics/calibration. Every key is present on all
    branches; the rate/gap fields are ``null`` (not absent) when there is no
    rated history, so they serialize as explicit nulls unchanged."""

    model_config = ConfigDict(extra="allow")

    bands: list[CalibrationBandOut]
    n: int
    overall_accuracy: float | None = None
    mean_nominal_confidence: float | None = None
    calibration_gap: float | None = None
    verdict: str
    sure_but_wrong_rate: float | None = None
    guess_but_right_rate: float | None = None


@router.get(
    "/calibration",
    response_model=CalibrationOut,
    response_model_exclude_unset=True,
)
def calibration(source: Optional[str] = Query(None, pattern="^(official|all)$"),
                days: Optional[int] = _Days,
                session: Session = Depends(get_session)):
    """1.3 — confidence calibration: per-band accuracy, over/under-confidence,
    sure-but-wrong & guess-but-right rates."""
    return analytics.confidence_calibration(session, days=days, source=source)


@router.get("/regressions")
def regressions(
    source: Optional[str] = Query(None, pattern="^(official|all)$"),
    recent_days: int = Query(7, ge=1, le=90),
    baseline_days: int = Query(30, ge=1, le=365),
    min_attempts: int = Query(6, ge=1, le=100),
    min_drop: float = Query(0.15, ge=0.01, le=0.9),
    session: Session = Depends(get_session),
):
    """C6 — silent regression alerts: rolling recent window vs baseline."""
    return analytics.regression_alerts(
        session,
        source=source,
        recent_days=recent_days,
        baseline_days=baseline_days,
        min_attempts=min_attempts,
        min_drop=min_drop,
    )


@router.get("/error-reasons")
def error_reasons(days: Optional[int] = _Days,
                  session: Session = Depends(get_session)):
    """1.4 — error-reason trends: counts overall, by q_type, earlier-vs-recent."""
    return analytics.error_reason_trends(session, days=days)


@router.get("/elimination")
def elimination(days: Optional[int] = _Days,
                session: Session = Depends(get_session)):
    """1.2 — process-of-elimination readout from captured choice events."""
    return analytics.elimination_insight(session, days=days)


@router.get("/pacing")
def pacing(source: Optional[str] = Query(None, pattern="^(official|all)$"),
           days: Optional[int] = _Days,
           session: Session = Depends(get_session)):
    """3.7 — pacing & triage: clock-bleeders, within-section thirds (accuracy +
    median time), per-q_type time benchmark, and a time-on-right-vs-wrong score."""
    return analytics.pacing(session, days=days, source=source)


@router.get("/fatigue")
def fatigue(session: Session = Depends(get_session)):
    """3.8 — section-fatigue / endurance curve: accuracy + median time per section
    POSITION (1st vs 2nd vs ...) across full-exam sittings."""
    return analytics.fatigue(session)
