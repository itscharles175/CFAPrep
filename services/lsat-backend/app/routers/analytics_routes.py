"""Analytics endpoints (thin wrappers over app.analytics).

All time-series endpoints accept an optional ``?days=`` window applied
server-side (the frontend previously filtered client-side only).
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlmodel import Session

from .. import analytics
from ..db import get_session

router = APIRouter(prefix="/analytics")

_Days = Query(None, ge=1, le=730, description="restrict to the last N days")


@router.get("/dashboard")
def dashboard(days: Optional[int] = _Days, session: Session = Depends(get_session)):
    return analytics.dashboard(session, days=days)


@router.get("/by-type")
def by_type(source: str = Query("all", pattern="^(official|all)$"),
            days: Optional[int] = _Days,
            session: Session = Depends(get_session)):
    return analytics.by_type(session, source=source, days=days)


@router.get("/timing/{session_id}")
def timing(session_id: int, session: Session = Depends(get_session)):
    return analytics.timing(session, session_id)


@router.get("/blind-review-gap")
def blind_review_gap(days: Optional[int] = _Days,
                     session: Session = Depends(get_session)):
    return analytics.blind_review_gap(session, days=days)


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


@router.get("/activity")
def activity(days: int = Query(120, ge=1, le=730),
             session: Session = Depends(get_session)):
    return analytics.activity(session, days=days)


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


@router.get("/calibration")
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
