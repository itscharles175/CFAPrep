"""Analytics computed from Attempt data.

Rules from the contract:
- Score prediction & "official accuracy" use source == "official" ONLY.
- by-type accepts source=official|all.
- Blind-review 2x2 outcome routing.
"""
from __future__ import annotations

import math
import statistics
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from sqlmodel import Session, select

from . import scoring
from .learning_feedback import feedback_cohort_summary, feedback_outcome_summary
from .pagination import paginate
from .models import (
    AnswerChoice,
    Attempt,
    AttemptChoiceEvent,
    AttemptMode,
    ErrorLogEntry,
    HostProgressSnapshot,
    Question,
    QuestionSource,
    Section,
    SessionType,
    StudySession,
)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _cutoff(days: int | None) -> datetime | None:
    """Window start for ?days= filtering, or None for 'all time'."""
    if not days or days <= 0:
        return None
    return datetime.now(timezone.utc) - timedelta(days=days)


def _all_attempts(session: Session, *, days: int | None = None) -> list[Attempt]:
    """Every attempt, optionally restricted to the last ``days`` (server-side).

    P1: the ``days`` window is pushed into SQL. SQLAlchemy's SQLite ``DateTime``
    normalizes both stored values and the bound cutoff to the same string format,
    so the comparison is chronological and correct (no full-table scan into
    Python just to drop old rows)."""
    stmt = select(Attempt)
    cutoff = _cutoff(days)
    if cutoff is not None:
        stmt = stmt.where(Attempt.created_at >= cutoff)
    return session.exec(stmt).all()


# --- 2x2 blind-review outcome ----------------------------------------------
def blind_review_outcome(timed_correct: bool, br_correct: bool | None) -> str:
    """The 2x2 routing. If no BR answer, fall back to timed-only labels."""
    if br_correct is None:
        return "timed_ok" if timed_correct else "concept_gap"
    if timed_correct and br_correct:
        return "timed_ok"
    if not timed_correct and br_correct:
        return "timing_problem"
    if not timed_correct and not br_correct:
        return "concept_gap"
    return "lucky"  # timed right, BR wrong


# --- helpers ----------------------------------------------------------------
def _question_map(
    session: Session, ids: "set[int] | list[int] | None" = None
) -> dict[int, Question]:
    """Questions keyed by id. P1: when ``ids`` is given, load only those rows
    (the only ones the caller will look up) instead of the whole bank, so a
    windowed analytics call doesn't scan thousands of unrelated questions.

    5.4: soft-deleted (tombstoned) questions are excluded, so an attempt on a
    retired question drops out of every analytic that resolves through this map
    (its ``qmap.get(question_id)`` returns None)."""
    stmt = select(Question).where(Question.deleted_at.is_(None))
    if ids is not None:
        ids = [i for i in ids if i is not None]
        if not ids:
            return {}
        stmt = stmt.where(Question.id.in_(ids))
    return {q.id: q for q in session.exec(stmt).all()}


def _official_attempts(session: Session, *, days: int | None = None) -> list[Attempt]:
    rows = _all_attempts(session, days=days)
    qmap = _question_map(session, {a.question_id for a in rows})
    return [
        a for a in rows
        if qmap.get(a.question_id)
        and qmap[a.question_id].source == QuestionSource.official
    ]


def _timed_attempts(attempts: list[Attempt]) -> list[Attempt]:
    return [a for a in attempts if a.mode == AttemptMode.timed]


# --- dashboard --------------------------------------------------------------
def dashboard(session: Session, *, days: int | None = None) -> dict:
    official_timed = _timed_attempts(_official_attempts(session, days=days))

    raw = sum(1 for a in official_timed if a.is_correct)
    total = len(official_timed)
    predicted = scoring.predict_scaled(raw, total) if total else None

    # 30-day delta + trend by session.
    trend = _score_trend(session, days=days)
    score_delta_30d = None
    if trend:
        now = datetime.now(timezone.utc)
        recent = [t for t in trend if _aware(datetime.fromisoformat(t["date"])) >= now - timedelta(days=30)]
        older = [t for t in trend if _aware(datetime.fromisoformat(t["date"])) < now - timedelta(days=30)]
        if recent and older:
            score_delta_30d = recent[-1]["score"] - older[-1]["score"]
        elif len(recent) >= 2:
            score_delta_30d = recent[-1]["score"] - recent[0]["score"]

    weakest = sorted(
        [t for t in by_type(session, source="official", days=days) if t["attempts"] >= 1],
        key=lambda t: t["accuracy"],
    )[:5]

    return {
        "predicted_score": predicted,
        "score_delta_30d": score_delta_30d,
        "trend": trend,
        "weakest_types": [
            {"q_type": w["q_type"], "accuracy": w["accuracy"],
             "avg_time_ms": w["avg_time_ms"], "trend": w["trend"]}
            for w in weakest
        ],
        "coach": _coach_summary(session, weakest, predicted, days=days),
        "streak_days": _streak_days(session),
    }


def feedback_cohorts(session: Session, *, days: int | None = 90) -> dict:
    """Long-window daily-plan feedback cohorts for Analytics and sequencing."""
    return feedback_cohort_summary(session, days=days)


def feedback_outcomes(
    session: Session,
    *,
    feedback_days: int | None = 90,
    outcome_days: int = 30,
    source: str = "all",
    min_attempts: int = 3,
) -> dict:
    """Post-feedback attempt outcomes gated for future planner weighting."""
    return feedback_outcome_summary(
        session,
        feedback_days=feedback_days,
        outcome_days=outcome_days,
        source=source,
        min_attempts=min_attempts,
    )


def _coach_summary(
    session: Session,
    weakest: list[dict],
    predicted: int | None,
    *,
    days: int | None,
) -> dict:
    """Local, evidence-backed dashboard coach fallback.

    The live snapshot at /api/ai/coach may include model-written prose. This
    fallback stays deterministic and local, but now shares the same grounded
    context and recommendation policy as the scheduled coach so the dashboard is
    useful even before an LLM snapshot exists.
    """
    from . import coach as coach_engine

    ctx = coach_engine.build_coach_context(session, days=days)
    rec = coach_engine.choose_recommendation(ctx)

    if not ctx.get("has_data"):
        return {
            "text": "Not enough data yet. Take a timed section to start your diagnosis.",
            "recommendation": rec,
            "source": "local_coach_context_v1",
            "signals": {
                "has_data": False,
                "predicted_score": predicted,
                "window_days": days,
                "srs_due": ctx.get("srs_due", 0),
            },
        }

    weak = (ctx.get("weak_types") or [{}])[0]
    weakest_type = weak.get("q_type") or (weakest[0]["q_type"] if weakest else None)
    mastery = weak.get("mastery")
    lower_bound = weak.get("lower_bound")
    br = ctx.get("blind_review_gap") or {}
    top_trap = ctx.get("top_trap") or {}
    cal = ctx.get("calibration") or {}

    text_parts: list[str] = []
    if weakest_type:
        mastery_txt = (
            f"local mastery {round(float(mastery) * 100)}%"
            if mastery is not None else "not enough mastery history yet"
        )
        floor_txt = (
            f", reliability floor {round(float(lower_bound) * 100)}%"
            if lower_bound is not None else ""
        )
        text_parts.append(f"Focus first on {weakest_type}: {mastery_txt}{floor_txt}.")
    elif weakest:
        w = weakest[0]
        text_parts.append(
            f"Your weakest official area is {w['q_type']} at {round(w['accuracy'] * 100)}% accuracy."
        )
    if predicted is not None:
        text_parts.append(f"Official timed score anchor: {predicted}.")
    if (br.get("gap") or 0) >= 0.12:
        text_parts.append(
            "Blind Review is outrunning timed work, so the next win is timing control before explanations."
        )
    elif ctx.get("srs_due", 0) >= coach_engine._SRS_DUE_RECOMMEND:
        text_parts.append(f"{ctx['srs_due']} concept cards are due now; clear those before adding more misses.")
    elif top_trap:
        text_parts.append(f"Most repeated trap pattern: {top_trap.get('trap_type')}.")
    elif cal.get("verdict") in {"overconfident", "underconfident"}:
        text_parts.append(f"Confidence calibration is {cal['verdict']}; review answer certainty against outcomes.")
    if not text_parts:
        text_parts.append("Keep building the evidence base with timed official work and written Blind Review.")

    return {
        "text": " ".join(text_parts),
        "recommendation": rec,
        "source": "local_coach_context_v1",
        "signals": {
            "has_data": True,
            "predicted_score": predicted,
            "window_days": days,
            "weakest_type": weakest_type,
            "mastery": mastery,
            "lower_bound": lower_bound,
            "srs_due": ctx.get("srs_due", 0),
            "blind_review_gap": br.get("gap"),
            "top_trap": top_trap.get("trap_type"),
            "calibration": cal.get("verdict"),
            "recent_miss_ids": [
                r.get("question_id")
                for r in (ctx.get("recent_misses") or [])
                if r.get("question_id") is not None
            ],
        },
    }


def _streak_days(session: Session) -> int:
    # B7: limit to 365 days so this never scans the full attempts table.
    cutoff = datetime.now(timezone.utc) - timedelta(days=365)
    rows = session.exec(
        select(Attempt.created_at).where(Attempt.created_at >= cutoff)
    ).all()
    days = {_aware(d).date() for d in rows}
    if not days:
        return 0
    today = datetime.now(timezone.utc).date()
    streak = 0
    d = today
    # allow streak to count even if today has no activity but yesterday does
    if d not in days and (d - timedelta(days=1)) in days:
        d = d - timedelta(days=1)
    while d in days:
        streak += 1
        d -= timedelta(days=1)
    return streak


# --- trend ------------------------------------------------------------------
def _score_trend(session: Session, *, days: int | None = None) -> list[dict]:
    """One scaled point per finished session that has official timed attempts."""
    sessions = session.exec(
        select(StudySession).order_by(StudySession.started)
    ).all()
    attempts = _all_attempts(session, days=days)
    qmap = _question_map(session, {a.question_id for a in attempts})
    by_session: dict[int, list[Attempt]] = defaultdict(list)
    for a in attempts:
        by_session[a.session_id].append(a)

    trend = []
    for s in sessions:
        sa = [
            a for a in by_session.get(s.id, [])
            if a.mode == AttemptMode.timed
            and qmap.get(a.question_id)
            and qmap[a.question_id].source == QuestionSource.official
        ]
        if not sa:
            continue
        raw = sum(1 for a in sa if a.is_correct)
        scaled = s.scaled_score or scoring.predict_scaled(raw, len(sa))
        when = s.ended or s.started
        trend.append({"date": _aware(when).isoformat(), "score": scaled})
    return trend


# --- forecast ---------------------------------------------------------------
# LSAT test-retest standard error of measurement, in scaled points. LSAC reports
# the SEM of a single administration at roughly 2.5 scaled points; we fold it into
# the prediction band so the interval never claims more certainty than the test
# instrument itself supports (even with a perfect fit).
_LSAT_SEM = 2.5
# Realistic ceiling on sustainable improvement so a couple of early-improving
# sessions can't project absurd gains. ~7 scaled points / week (1.0/day) is already
# very aggressive for the LSAT; clamp the regression slope to this in either sign.
_MAX_SLOPE_PER_DAY = 1.0
# Honest-precision floor: below this much evidence we won't emit a false-precise
# point estimate (we return a range + low_confidence instead).
_MIN_SESSION_DAYS = 3
_MIN_OFFICIAL_Q = 25
# t-ish multiplier for the ~95% band. We don't pull in scipy for a per-df Student-t
# quantile; ~2.0 is the large-sample normal value and is intentionally a touch
# conservative for the small dfs we operate at (a real t_{.975} is larger), which
# is the safe direction for an honesty-first band.
_BAND_Z = 2.0


def _linfit(xs: list[float], ys: list[float]) -> tuple[float, float]:
    """Ordinary least squares -> (slope, intercept).

    Retained as the unweighted special case of :func:`_wls` (all weights 1) so
    existing direct callers keep their exact (slope, intercept) contract; the
    forecast itself now uses information-weighted ``_wls``.
    """
    return _wls(xs, ys, [1.0] * len(xs))


def _wls(xs: list[float], ys: list[float],
         ws: list[float]) -> tuple[float, float]:
    """Weighted least squares -> (slope, intercept).

    Each point carries weight ``w`` (here: its official-question count), so a
    50-question exam dominates a 5-question drill instead of counting equally.
    Falls back to the weighted mean (slope 0) when x has no spread.
    """
    sw = sum(ws)
    if sw <= 0:
        return 0.0, (sum(ys) / len(ys) if ys else 0.0)
    mx = sum(w * x for w, x in zip(ws, xs)) / sw
    my = sum(w * y for w, y in zip(ws, ys)) / sw
    sxx = sum(w * (x - mx) ** 2 for w, x in zip(ws, xs))
    sxy = sum(w * (x - mx) * (y - my) for w, x, y in zip(ws, xs, ys))
    if sxx == 0:
        return 0.0, my
    slope = sxy / sxx
    intercept = my - slope * mx
    return slope, intercept


def _clamp_score(v: float) -> int:
    return int(max(120, min(180, round(v))))


def _forecast_points(session: Session, *, days: int | None) -> list[tuple[datetime, float, int]]:
    """(when, scaled_score, official_question_count) per finished session that has
    official timed attempts. The third element is the WLS information weight: how
    many official questions backed that session's score (a drill must not weigh as
    much as a full section/exam)."""
    sessions = session.exec(
        select(StudySession).order_by(StudySession.started)
    ).all()
    attempts = _all_attempts(session, days=days)
    qmap = _question_map(session, {a.question_id for a in attempts})
    by_session: dict[int, list[Attempt]] = defaultdict(list)
    for a in attempts:
        by_session[a.session_id].append(a)

    pts: list[tuple[datetime, float, int]] = []
    for s in sessions:
        sa = [
            a for a in by_session.get(s.id, [])
            if a.mode == AttemptMode.timed
            and qmap.get(a.question_id)
            and qmap[a.question_id].source == QuestionSource.official
        ]
        if not sa:
            continue
        raw = sum(1 for a in sa if a.is_correct)
        scaled = s.scaled_score or scoring.predict_scaled(raw, len(sa))
        if scaled is None:
            continue
        when = s.ended or s.started
        pts.append((_aware(when), float(scaled), len(sa)))
    return pts


def _add_percentile_fields(out: dict) -> None:
    """C1 — Fill ``projected_percentile`` and ``percentile_band`` in-place.

    Uses ``scoring.scaled_to_percentile`` to map the projected score and the
    confidence band endpoints.  Both fields stay None when there is no
    projected score or confidence band yet."""
    ps = out.get("projected_score")
    if ps is not None:
        out["projected_percentile"] = scoring.scaled_to_percentile(int(ps))
    conf = out.get("confidence")
    if conf is not None:
        out["percentile_band"] = {
            "low": scoring.scaled_to_percentile(conf["low"]),
            "high": scoring.scaled_to_percentile(conf["high"]),
        }


def _add_required_slope(out: dict, *, target_score: int | None,
                        days_to_exam: int | None,
                        actual_slope_per_week: float) -> None:
    """C2 — Fill required-slope inversion fields in-place.

    ``required_slope_per_week``: scaled points/week the student needs to reach
    target_score in the remaining days.
    ``required_vs_actual_ratio``: required / actual (> 1 = behind pace).
    ``trajectory_feasible``: False when the required weekly rate exceeds the
    realistic ceiling (``_MAX_SLOPE_PER_DAY * 7``).

    Guard conditions: skipped entirely when target_score or days_to_exam is
    missing, or when the exam is today/past (days_to_exam <= 0).  The
    current_score may be None when there are no data points yet, in which case
    the fields remain None as well."""
    current = out.get("current_score")
    if target_score is None or days_to_exam is None or days_to_exam <= 0:
        return
    if current is None:
        return
    weeks_remaining = days_to_exam / 7.0
    # weeks_remaining > 0 because days_to_exam > 0, so no divide-by-zero here.
    req = (target_score - current) / weeks_remaining
    out["required_slope_per_week"] = round(req, 2)
    # Ratio: how much faster than actual trend the student needs to improve.
    # Guard: actual slope == 0 means we can't form a meaningful ratio; emit
    # None rather than ±inf/NaN so the frontend never has to special-case those.
    # B25: use tolerance guard instead of exact float zero to avoid ±inf/NaN.
    if abs(actual_slope_per_week) > 1e-4:
        out["required_vs_actual_ratio"] = round(req / actual_slope_per_week, 2)
    # Feasibility: the slope needed must not exceed the sane per-week ceiling.
    max_weekly = _MAX_SLOPE_PER_DAY * 7
    out["trajectory_feasible"] = req <= max_weekly


def forecast(session: Session, *, exam_date: str | None = None,
             target_score: int | None = None, days: int | None = None) -> dict:
    """Project the score trend to the exam date with a calibrated, honest band.

    Method (``method`` key reflects which branch ran):
    - **Information-weighted least squares on elapsed days.** Each finished
      official-timed session is one point, weighted by its official-question count
      (a 5-question drill must not equal a 50-question exam), and regressed on
      *actual days elapsed* (not session index) so cadence matters and projecting
      to a real ``exam_date`` is meaningful.
    - **Bounded extrapolation.** The fitted slope is clamped to a realistic
      improvement rate (``_MAX_SLOPE_PER_DAY``) and the projected score to the
      120-180 scale, so a few early-improving sessions can't project absurd gains.
    - **Honest prediction interval.** Band half-width is
      ``z * s * sqrt(1 + 1/n + (x0 - x̄)² / Sxx)`` (weighted forms of n, x̄, Sxx),
      which *widens with horizon* (distance of the projection x0 from the data),
      with the LSAT test-retest SEM folded in via quadrature so it never collapses
      to ~0 with few points.
    - **Data floor.** Below ``_MIN_SESSION_DAYS`` distinct session-days OR
      ``_MIN_OFFICIAL_Q`` official questions we do NOT emit a false-precise point:
      ``projected_score`` is the latest estimate, ``confidence`` is a wide range,
      and ``low_confidence`` is True.

    Score-prediction rules still hold: only official attempts feed the trend, and
    per-session scoring still flows through ``scoring.predict_scaled`` (read-only).
    """
    pts = _forecast_points(session, days=days)
    current = int(pts[-1][1]) if pts else None
    n_points = len(pts)
    # Distinct calendar days of evidence + total official questions behind the fit.
    distinct_days = len({p[0].date() for p in pts})
    total_official_q = sum(p[2] for p in pts)

    days_to_exam = None
    if exam_date:
        try:
            d = date.fromisoformat(exam_date)
            days_to_exam = (d - datetime.now(timezone.utc).date()).days
        except ValueError:
            days_to_exam = None

    out: dict = {
        "current_score": current,
        "projected_score": current,
        "slope_per_week": 0.0,
        "confidence": None,
        "target_score": target_score,
        "gap_to_target": (target_score - current) if (target_score is not None and current is not None) else None,
        "on_track": None,
        "days_to_exam": days_to_exam,
        "n_points": n_points,
        # New (additive) honesty signals — see CRITICAL compatibility rule.
        "low_confidence": True,
        "method": "insufficient_data",
        "n_official_questions": total_official_q,
        "n_session_days": distinct_days,
        # C1 — percentile mapping (None until a projected_score is set below).
        "projected_percentile": None,
        "percentile_band": None,
        # C2 — required-slope inversion (None when no active plan with target/date).
        "required_slope_per_week": None,
        "required_vs_actual_ratio": None,
        "trajectory_feasible": None,
    }

    if n_points == 0:
        return out

    # Horizon: where on the day-axis we're projecting to.
    x0_dt = pts[0][0]
    xs = [float((p[0] - x0_dt).days) for p in pts]
    ys = [p[1] for p in pts]
    ws = [float(p[2]) for p in pts]

    target_x = xs[-1]
    if days_to_exam is not None:
        today_x = (datetime.now(timezone.utc) - x0_dt).days
        target_x = today_x + max(0, days_to_exam)

    have_floor = distinct_days >= _MIN_SESSION_DAYS and total_official_q >= _MIN_OFFICIAL_Q

    # Weighted summary stats reused by both branches.
    sw = sum(ws) or 1.0
    xbar = sum(w * x for w, x in zip(ws, xs)) / sw
    sxx = sum(w * (x - xbar) ** 2 for w, x in zip(ws, xs))

    if not have_floor or n_points < 2 or sxx == 0:
        # Too little (or temporally flat) evidence to trust a slope: report the
        # latest estimate as a wide RANGE rather than a confident point.
        out["low_confidence"] = True
        out["method"] = "latest_estimate_range"
        # Band: SEM plus a spread reflecting how noisy the (few) points are.
        spread = statistics.pstdev(ys) if n_points >= 2 else 0.0
        half = _BAND_Z * (_LSAT_SEM ** 2 + spread ** 2) ** 0.5
        # Floor the half-width so a single point still shows real uncertainty.
        half = max(half, _BAND_Z * _LSAT_SEM)
        base = float(current)
        out["projected_score"] = _clamp_score(base)
        out["confidence"] = {
            "low": _clamp_score(base - half),
            "high": _clamp_score(base + half),
        }
        if target_score is not None and current is not None:
            out["on_track"] = current >= target_score
        # C1 — percentile fields even in the low-confidence branch.
        _add_percentile_fields(out)
        # C2 — required slope uses slope_per_week=0 in the low-confidence branch
        # (no meaningful trend to report).
        _add_required_slope(out, target_score=target_score,
                            days_to_exam=days_to_exam,
                            actual_slope_per_week=out["slope_per_week"])
        return out

    # --- enough evidence: weighted least squares on elapsed days --------------
    raw_slope, intercept = _wls(xs, ys, ws)
    slope = max(-_MAX_SLOPE_PER_DAY, min(_MAX_SLOPE_PER_DAY, raw_slope))
    # If the slope was clamped, re-anchor the intercept on the weighted centroid so
    # the line still passes through the data's center of mass at the bounded rate.
    if slope != raw_slope:
        ybar = sum(w * y for w, y in zip(ws, ys)) / sw
        intercept = ybar - slope * xbar

    out["slope_per_week"] = round(slope * 7, 2)
    projected = _clamp_score(slope * target_x + intercept)
    out["projected_score"] = projected
    out["low_confidence"] = False
    out["method"] = "weighted_least_squares"
    if target_score is not None:
        out["on_track"] = projected >= target_score

    # Weighted residual standard error about the (bounded) line. Use effective
    # sample size from the weights; guard the dof so n=2 doesn't divide by zero.
    fitted = [slope * x + intercept for x in xs]
    wsse = sum(w * (y - f) ** 2 for w, y, f in zip(ws, ys, fitted))
    dof = max(n_points - 2, 1)
    s = (wsse / dof) ** 0.5
    # Prediction interval that GROWS with distance of target_x from the data center.
    # Weighted leverage term: 1/n_eff + (x0-x̄)²/Sxx, with n_eff = number of points.
    leverage = 1.0 / n_points + (target_x - xbar) ** 2 / sxx
    pred_se = s * (1.0 + leverage) ** 0.5
    # Fold in irreducible LSAT measurement error (SEM) in quadrature so the band
    # never collapses to ~0 even with a tight fit.
    half = _BAND_Z * (pred_se ** 2 + _LSAT_SEM ** 2) ** 0.5
    out["confidence"] = {
        "low": _clamp_score(projected - half),
        "high": _clamp_score(projected + half),
    }
    # C1 — percentile mapping on the WLS projection + confidence band.
    _add_percentile_fields(out)
    # C2 — required-slope inversion using the (clamped) fitted weekly slope.
    _add_required_slope(out, target_score=target_score,
                        days_to_exam=days_to_exam,
                        actual_slope_per_week=out["slope_per_week"])
    return out


# --- by type ----------------------------------------------------------------
# C3 — Efficiency-quadrant thresholds.
# Accuracy threshold separating "high" from "low" accuracy performers.
_EFFICIENCY_ACCURACY_THRESHOLD = 0.65
# Per-section-type fallback time benchmarks (milliseconds per question).
# LR: ~90 s / question on a timed section (35 q in 35 min).
# RC: ~120 s / question (27 q in 35 min).  These are used when the student has
# too few attempts in a type to compute a reliable per-type average from ``pacing``.
_EFFICIENCY_TIME_BENCHMARKS_MS: dict[str, int] = {
    "LR": 90_000,
    "RC": 120_000,
}


def _efficiency_band(accuracy: float, avg_time_ms: int, sec_type: str) -> str:
    """C3 — Classify a (q_type, section_type) cell into one of four quadrants.

    Quadrant labels and decision boundaries:
    - accuracy >= _EFFICIENCY_ACCURACY_THRESHOLD  AND  avg_time <= benchmark -> "mastered"
    - accuracy >= _EFFICIENCY_ACCURACY_THRESHOLD  AND  avg_time >  benchmark -> "costly_right"
    - accuracy <  _EFFICIENCY_ACCURACY_THRESHOLD  AND  avg_time <= benchmark -> "cheap_wrong"
    - accuracy <  _EFFICIENCY_ACCURACY_THRESHOLD  AND  avg_time >  benchmark -> "struggling"
    """
    benchmark = _EFFICIENCY_TIME_BENCHMARKS_MS.get(sec_type,
                                                    _EFFICIENCY_TIME_BENCHMARKS_MS["LR"])
    high_acc = accuracy >= _EFFICIENCY_ACCURACY_THRESHOLD
    within_time = avg_time_ms <= benchmark
    if high_acc and within_time:
        return "mastered"
    if high_acc and not within_time:
        return "costly_right"
    if not high_acc and within_time:
        return "cheap_wrong"
    return "struggling"


def by_type(session: Session, source: str = "all", *, days: int | None = None) -> list[dict]:
    attempts = _all_attempts(session, days=days)
    qmap = _question_map(session, {a.question_id for a in attempts})
    timed = [a for a in attempts if a.mode in (AttemptMode.timed, AttemptMode.drill)]

    groups: dict[tuple[str, str], list[Attempt]] = defaultdict(list)
    for a in timed:
        q = qmap.get(a.question_id)
        if not q:
            continue
        if source == "official" and q.source != QuestionSource.official:
            continue
        sec_type = "RC" if q.passage_id else "LR"
        groups[(q.q_type, sec_type)].append(a)

    out = []
    for (q_type, sec_type), items in groups.items():
        items_sorted = sorted(items, key=lambda a: _aware(a.created_at))
        correct = sum(1 for a in items_sorted if a.is_correct)
        avg_time = round(sum(a.time_ms for a in items_sorted) / len(items_sorted))
        acc = round(correct / len(items_sorted), 4)
        out.append({
            "q_type": q_type,
            "section_type": sec_type,
            "attempts": len(items_sorted),
            "accuracy": acc,
            "avg_time_ms": avg_time,
            "trend": _split_trend([a.is_correct for a in items_sorted]),
            # C3 — efficiency quadrant label.
            "efficiency_band": _efficiency_band(acc, avg_time, sec_type),
        })
    return sorted(out, key=lambda r: (-r["attempts"], r["q_type"]))


def _split_trend(corrects: list[bool]) -> str:
    """'up'|'down'|'flat' comparing first half vs second half accuracy."""
    if len(corrects) < 4:
        return "flat"
    mid = len(corrects) // 2
    first = sum(corrects[:mid]) / mid
    second = sum(corrects[mid:]) / (len(corrects) - mid)
    if second - first > 0.1:
        return "up"
    if first - second > 0.1:
        return "down"
    return "flat"


# --- mastery ----------------------------------------------------------------
# Beta-Binomial prior. A weak prior centered at 0.5 (alpha0 == beta0) of strength
# ``_MASTERY_PRIOR_STRENGTH`` pseudo-attempts: tiny samples are shrunk toward 0.5
# so a 2-attempt type can't masquerade as the "weakest" (or strongest) type beside
# a 200-attempt one. ~4 pseudo-attempts is gentle — it stops dominating once a type
# has a dozen+ real (time-weighted) attempts.
_MASTERY_PRIOR_STRENGTH = 4.0
_MASTERY_PRIOR_MEAN = 0.5
# Recency: time-based exponential decay with this half-life (days). An attempt
# 30 days old counts half as much as a fresh one. Replaces the old attempt-INDEX
# decay so cadence (calendar time), not how many questions you happen to have done
# since, governs how stale evidence is.
_MASTERY_HALFLIFE_DAYS = 30.0
# z for the ~95% credible-interval lower bound (normal approx to the Beta posterior).
_MASTERY_CI_Z = 1.96


def mastery(session: Session, source: str = "all", *, days: int | None = None) -> list[dict]:
    """Per-type mastery as an uncertainty-aware Beta-Binomial posterior.

    Replaces the old recency-decay x difficulty-multiplier estimator (which could
    push mastery ABOVE observed accuracy, decayed by attempt index, and ranked a
    2-attempt type beside a 200-attempt one). Now:

    - **Time-decayed Beta-Binomial.** Each attempt contributes a time-decayed
      weight ``0.5 ** (age_days / half_life)``; effective successes/failures feed a
      Beta(alpha0, beta0) prior. ``mastery`` = posterior mean, which is bounded by
      the data and shrinks small samples toward the 0.5 prior. Difficulty no longer
      multiplies mastery above observed accuracy (it's reported, not applied).
    - **Uncertainty.** ``lower_bound`` is the lower edge of a ~95% credible interval
      (``ci`` = [low, high]); ``n`` is the (rounded) effective sample size. Weakest
      types are ranked by ``lower_bound`` so a tiny noisy sample can't top the list.

    Existing keys are preserved (``q_type``, ``section_type``, ``attempts``,
    ``mastery``, ``weighted_accuracy``, ``recent_accuracy``, ``avg_difficulty``,
    ``trend``); ``lower_bound``/``ci``/``n``/``posterior_mean``/``prior_mean`` are new.
    """
    attempts = _all_attempts(session, days=days)
    qmap = _question_map(session, {a.question_id for a in attempts})
    practice = [a for a in attempts if a.mode in (AttemptMode.timed, AttemptMode.drill)]

    groups: dict[tuple[str, str], list] = defaultdict(list)
    for a in practice:
        q = qmap.get(a.question_id)
        if q is None:
            continue
        if source == "official" and q.source != QuestionSource.official:
            continue
        sec = "RC" if q.passage_id else "LR"
        groups[(q.q_type, sec)].append((a, q))

    a0 = _MASTERY_PRIOR_STRENGTH * _MASTERY_PRIOR_MEAN
    b0 = _MASTERY_PRIOR_STRENGTH * (1.0 - _MASTERY_PRIOR_MEAN)

    out = []
    for (q_type, sec), items in groups.items():
        # Sort oldest -> newest; break exact-timestamp ties by attempt id so that
        # "recent counts more" still holds for same-instant batches (decay alone
        # can't distinguish them).
        items.sort(key=lambda t: (_aware(t[0].created_at), t[0].id or 0))
        n = len(items)

        # Time-decayed weight per attempt (newest = weight 1.0).
        newest = _aware(items[-1][0].created_at)
        decay_w: list[float] = []
        for i, (a, _q) in enumerate(items):
            age_days = (newest - _aware(a.created_at)).total_seconds() / 86400.0
            w = 0.5 ** (max(0.0, age_days) / _MASTERY_HALFLIFE_DAYS)
            # Tie-break: when timestamps collapse to one instant, give later
            # attempts a hair more weight so recency is still expressed.
            w *= 1.0 + 1e-3 * (i / max(1, n - 1))
            decay_w.append(w)
        wsum = sum(decay_w) or 1.0

        succ = sum(w for w, (a, _q) in zip(decay_w, items) if a.is_correct)
        # Time-weighted ("recency-weighted") accuracy — preserved output key.
        weighted_acc = succ / wsum

        # Beta-Binomial posterior from the time-weighted effective counts.
        alpha = a0 + succ
        beta = b0 + (wsum - succ)
        post_mean = alpha / (alpha + beta)
        post_var = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1.0))
        post_sd = post_var ** 0.5
        ci_low = max(0.0, post_mean - _MASTERY_CI_Z * post_sd)
        ci_high = min(1.0, post_mean + _MASTERY_CI_Z * post_sd)

        avg_diff = sum(q.difficulty for _a, q in items) / n
        recent = items[-5:]
        recent_acc = sum(1 for a, _q in recent if a.is_correct) / len(recent)

        out.append({
            "q_type": q_type,
            "section_type": sec,
            "attempts": n,
            # mastery = posterior mean: bounded by data, shrunk toward prior.
            "mastery": round(post_mean, 4),
            "weighted_accuracy": round(weighted_acc, 4),
            "recent_accuracy": round(recent_acc, 4),
            "avg_difficulty": round(avg_diff, 2),
            "trend": _split_trend([a.is_correct for a, _q in items]),
            # New uncertainty signals (additive).
            "posterior_mean": round(post_mean, 4),
            "lower_bound": round(ci_low, 4),
            "ci": [round(ci_low, 4), round(ci_high, 4)],
            "n": round(wsum, 2),
            "prior_mean": _MASTERY_PRIOR_MEAN,
        })
    # Weakest-first by the credible-interval LOWER BOUND, so a confidently-low type
    # outranks a tiny noisy one. Tie-break on posterior mean then attempts.
    return sorted(out, key=lambda r: (r["lower_bound"], r["mastery"], -r["attempts"]))


# --- coach summary ----------------------------------------------------------
def recent_type_summary(session: Session, limit: int = 50, *,
                         days: int | None = None) -> dict:
    """Compact 'accuracy by type over recent attempts' for the AI coach.

    Shared by the live /ai/diagnose endpoint and the scheduled snapshot so both
    describe performance the same way.
    """
    cutoff = _cutoff(days)
    stmt = select(Attempt).order_by(Attempt.id.desc())
    if cutoff is not None:
        stmt = stmt.where(Attempt.created_at >= cutoff)
    attempts = session.exec(stmt.limit(limit)).all()
    qmap = _question_map(session, {a.question_id for a in attempts})
    by_type: dict[str, list[bool]] = defaultdict(list)
    for a in attempts:
        q = qmap.get(a.question_id)
        if q is not None:
            by_type[q.q_type].append(a.is_correct)
    lines = [
        f"{t}: {sum(v)}/{len(v)} correct ({round(100 * sum(v) / len(v))}%)"
        for t, v in by_type.items()
    ]
    summary = ("Recent attempt accuracy by question type:\n" + "\n".join(lines)) if lines else ""
    worst = (
        min(by_type.items(), key=lambda kv: sum(kv[1]) / len(kv[1]))[0]
        if by_type else None
    )
    return {"summary": summary, "by_type": dict(by_type), "worst": worst,
            "n": len(attempts)}


# --- timing -----------------------------------------------------------------
def timing(session: Session, session_id: int) -> list[dict]:
    attempts = session.exec(
        select(Attempt)
        .where(Attempt.session_id == session_id)
        .where(Attempt.mode != AttemptMode.blind_review)
        .order_by(Attempt.id)
    ).all()
    qmap = _question_map(session, {a.question_id for a in attempts})
    out = []
    for i, a in enumerate(attempts, start=1):
        q = qmap.get(a.question_id)
        out.append({
            "question_order": i,
            "time_ms": a.time_ms,
            "is_correct": a.is_correct,
            "difficulty": q.difficulty if q else None,
        })
    return out


# --- pacing & triage (3.7) --------------------------------------------------
# A "clock-bleeder" is a WRONG question whose time exceeds this multiple of its
# q_type's average time benchmark (i.e. you bled the clock AND still missed it).
_BLEEDER_TIME_FACTOR = 1.5


def _median_ms(times: list[int]) -> int | None:
    return round(statistics.median(times)) if times else None


def pacing(session: Session, *, days: int | None = None,
           source: str | None = None) -> dict:
    """Pacing & triage analytics across practice attempts.

    Returns:
    - ``clock_bleeders``: WRONG questions that also ran long (time above
      ``_BLEEDER_TIME_FACTOR`` x that q_type's average time) — time spent without
      a payoff. Each: ``question_id``, ``session_id``, ``time_ms``, ``q_type``,
      ``benchmark_ms``.
    - ``thirds``: first / second / last third of each section (split per session by
      attempt order, then pooled) with ``accuracy`` AND ``median_time_ms`` so
      pace/accuracy decay *within* a section is visible.
    - ``by_q_type_time``: per-q_type average time benchmark (``avg_time_ms``, ``n``).
    - ``triage``: did time get spent on the questions you got right vs wrong —
      mean/median time on correct vs incorrect, the wrong/correct time ratio, and a
      0-100 ``score`` (higher = you invest your time where it pays off).

    Honors the shared ``days`` window and ``source`` (official/all) conventions;
    within a session, attempts are ordered by attempt order (id)."""
    attempts = _all_attempts(session, days=days)
    qmap = _question_map(session, {a.question_id for a in attempts})
    practice = [a for a in attempts if a.mode in (AttemptMode.timed, AttemptMode.drill)]
    if source == "official":
        practice = [
            a for a in practice
            if qmap.get(a.question_id)
            and qmap[a.question_id].source == QuestionSource.official
        ]
    practice = [a for a in practice if qmap.get(a.question_id) is not None]

    def _qtype(a: Attempt) -> str:
        return qmap[a.question_id].q_type

    # Per-q_type average time benchmark.
    by_qt: dict[str, list[int]] = defaultdict(list)
    for a in practice:
        by_qt[_qtype(a)].append(a.time_ms)
    by_q_type_time = sorted(
        [
            {"q_type": qt, "avg_time_ms": round(sum(ts) / len(ts)), "n": len(ts)}
            for qt, ts in by_qt.items()
        ],
        key=lambda r: -r["avg_time_ms"],
    )
    bench = {r["q_type"]: r["avg_time_ms"] for r in by_q_type_time}

    # Clock-bleeders: wrong AND ran past 1.5x the q_type benchmark.
    clock_bleeders = []
    for a in practice:
        if a.is_correct:
            continue
        qt = _qtype(a)
        b = bench.get(qt, 0)
        if b and a.time_ms > _BLEEDER_TIME_FACTOR * b:
            clock_bleeders.append({
                "question_id": a.question_id,
                "session_id": a.session_id,
                "time_ms": a.time_ms,
                "q_type": qt,
                "benchmark_ms": b,
            })
    clock_bleeders.sort(key=lambda r: -r["time_ms"])

    # Within-section thirds: split EACH session's ordered attempts into 3 buckets,
    # then pool. (Per-session so a long study history doesn't smear section shape.)
    by_session: dict[int, list[Attempt]] = defaultdict(list)
    for a in practice:
        by_session[a.session_id].append(a)
    third_correct = [0, 0, 0]
    third_total = [0, 0, 0]
    third_times: list[list[int]] = [[], [], []]
    for sid, items in by_session.items():
        items = sorted(items, key=lambda a: a.id or 0)
        m = len(items)
        if m == 0:
            continue
        for idx, a in enumerate(items):
            # Map position -> third (0,1,2). Robust for small m (m<3 still works).
            t = min(2, idx * 3 // m)
            third_total[t] += 1
            third_correct[t] += 1 if a.is_correct else 0
            third_times[t].append(a.time_ms)
    labels = ["first", "second", "last"]
    thirds = [
        {
            "third": labels[t],
            "attempts": third_total[t],
            "accuracy": round(third_correct[t] / third_total[t], 4) if third_total[t] else None,
            "median_time_ms": _median_ms(third_times[t]),
        }
        for t in range(3)
    ]

    # Triage: time on correct vs wrong answers.
    correct_times = [a.time_ms for a in practice if a.is_correct]
    wrong_times = [a.time_ms for a in practice if not a.is_correct]
    mean_correct = round(sum(correct_times) / len(correct_times)) if correct_times else None
    mean_wrong = round(sum(wrong_times) / len(wrong_times)) if wrong_times else None
    # Ratio of mean time spent on wrong vs correct. >1 means you over-invest in
    # questions you end up missing (poor triage); <1 means you let losers go.
    ratio = (
        round(mean_wrong / mean_correct, 3)
        if (mean_correct and mean_wrong and mean_correct > 0) else None
    )
    # Score: 100 when wrong<=correct time (good triage), decaying as you pour more
    # time into misses. Clamped 0-100. None when we can't compute the ratio.
    if ratio is None:
        triage_score = None
    else:
        triage_score = round(max(0.0, min(100.0, 100.0 - 50.0 * max(0.0, ratio - 1.0))), 1)
    triage = {
        "mean_time_correct_ms": mean_correct,
        "mean_time_wrong_ms": mean_wrong,
        "median_time_correct_ms": _median_ms(correct_times),
        "median_time_wrong_ms": _median_ms(wrong_times),
        "wrong_to_correct_time_ratio": ratio,
        "score": triage_score,
    }

    return {
        "n": len(practice),
        "clock_bleeders": clock_bleeders,
        "thirds": thirds,
        "by_q_type_time": by_q_type_time,
        "triage": triage,
    }


# --- section fatigue / endurance curve (3.8) -------------------------------
def fatigue(session: Session) -> dict:
    """Section-fatigue / endurance curve across full-exam sittings.

    For every ``SessionType.full_exam`` session, sections are ordered by
    ``Section.order``; each attempt is mapped to its section's *position* in the
    sitting (1st, 2nd, 3rd, 4th...). Accuracy and median time are aggregated per
    position across all sittings so stamina decay across a sitting is visible
    (e.g. section 4 slower / less accurate than section 1).

    ``positions`` is ordered by section position. Each entry:
    ``position`` (1-based), ``section_types`` (which types appeared there),
    ``accuracy``, ``median_time_ms``, ``attempts``, ``n_sittings``."""
    exams = session.exec(
        select(StudySession).where(StudySession.type == SessionType.full_exam)
    ).all()
    exam_ids = [s.id for s in exams]
    if not exam_ids:
        return {"n_sittings": 0, "positions": []}

    attempts = session.exec(
        select(Attempt)
        .where(Attempt.session_id.in_(exam_ids))
        .where(Attempt.mode != AttemptMode.blind_review)
    ).all()
    qmap = _question_map(session, {a.question_id for a in attempts})

    # Map each section_id -> its 1-based position within ITS preptest, and its type.
    sec_ids = {q.section_id for q in qmap.values() if q.section_id is not None}
    sections = (
        session.exec(select(Section).where(Section.id.in_(sec_ids))).all()
        if sec_ids else []
    )
    # Build per-preptest ordering so "position" is the order within a sitting.
    by_pt: dict[int, list[Section]] = defaultdict(list)
    for sec in sections:
        by_pt[sec.preptest_id].append(sec)
    sec_position: dict[int, int] = {}
    sec_type: dict[int, str] = {}
    for pt_id, secs in by_pt.items():
        for pos, sec in enumerate(sorted(secs, key=lambda s: (s.order, s.id or 0)), start=1):
            sec_position[sec.id] = pos
            sec_type[sec.id] = sec.type.value if hasattr(sec.type, "value") else str(sec.type)

    # Aggregate per position across sittings.
    pos_correct: dict[int, int] = defaultdict(int)
    pos_total: dict[int, int] = defaultdict(int)
    pos_times: dict[int, list[int]] = defaultdict(list)
    pos_types: dict[int, set[str]] = defaultdict(set)
    pos_sessions: dict[int, set[int]] = defaultdict(set)
    for a in attempts:
        q = qmap.get(a.question_id)
        if q is None or q.section_id is None:
            continue
        pos = sec_position.get(q.section_id)
        if pos is None:
            continue
        pos_total[pos] += 1
        pos_correct[pos] += 1 if a.is_correct else 0
        pos_times[pos].append(a.time_ms)
        pos_types[pos].add(sec_type.get(q.section_id, "?"))
        pos_sessions[pos].add(a.session_id)

    positions = [
        {
            "position": p,
            "section_types": sorted(pos_types[p]),
            "attempts": pos_total[p],
            "accuracy": round(pos_correct[p] / pos_total[p], 4) if pos_total[p] else None,
            "median_time_ms": _median_ms(pos_times[p]),
            "n_sittings": len(pos_sessions[p]),
        }
        for p in sorted(pos_total)
    ]
    return {"n_sittings": len(exam_ids), "positions": positions}


# --- blind review gap -------------------------------------------------------
# C4 — Minimum BR-sample size per type before emitting a lucky-rate estimate.
# Below this count a single lucky answer would dominate the rate reading.
_LUCKY_MIN_BR_SAMPLE = 3


def blind_review_gap(session: Session, *, days: int | None = None) -> dict:
    attempts = _all_attempts(session, days=days)
    qmap = _question_map(session, {a.question_id for a in attempts})
    # Only attempts that actually have a BR answer contribute to the gap.
    with_br = [a for a in attempts if a.br_answer is not None]

    def acc(items, key):
        if not items:
            return 0.0
        return round(sum(1 for a in items if key(a)) / len(items), 4)

    timed_acc = acc(with_br, lambda a: a.is_correct)
    br_acc = acc(with_br, lambda a: bool(a.br_correct))

    groups: dict[str, list[Attempt]] = defaultdict(list)
    for a in with_br:
        q = qmap.get(a.question_id)
        if q:
            groups[q.q_type].append(a)
    by_t = [
        {
            "q_type": t,
            "timed_accuracy": acc(items, lambda a: a.is_correct),
            "br_accuracy": acc(items, lambda a: bool(a.br_correct)),
            "gap": round(acc(items, lambda a: bool(a.br_correct))
                         - acc(items, lambda a: a.is_correct), 4),
        }
        for t, items in groups.items()
    ]
    # C4 — Lucky-rate surveillance: per q_type with enough BR data, fraction of
    # attempts where the student was timed-correct but BR-wrong ("lucky" outcome
    # in the 2x2).  Only included for types with at least _LUCKY_MIN_BR_SAMPLE
    # attempts with a BR answer, to avoid noise from tiny samples.
    lucky_rate_by_type: dict[str, float] = {}
    for q_type, items in groups.items():
        if len(items) < _LUCKY_MIN_BR_SAMPLE:
            continue
        lucky_count = sum(
            1 for a in items
            if a.is_correct and a.br_correct is not None and not a.br_correct
        )
        lucky_rate_by_type[q_type] = round(lucky_count / len(items), 4)

    return {
        "timed_accuracy": timed_acc,
        "br_accuracy": br_acc,
        "gap": round(br_acc - timed_acc, 4),
        "by_type": sorted(by_t, key=lambda r: -r["gap"]),
        # C4 — lucky rate (timed-right / BR-wrong fraction) per type with >=3 BR attempts.
        "lucky_rate_by_type": lucky_rate_by_type,
    }


# --- cross-domain blind-review gap (ANL-3) ----------------------------------
# The 2x2 blind-review outcome (`blind_review_outcome`) and the gap analytic
# above are LSAT-native. ANL-3 lifts them to a CROSS-DOMAIN read so the host
# (CFA/Quant/Excel) can see careless-vs-concept signal next to LSAT's. Host
# attempts arrive via DATA-4a's read-only `HostProgressSnapshot` mirror; the host
# blind-review capture (optional `brAnswer`/`brCorrect` on the canonical
# `CrossDomainAttempt`) rides in each attempt snapshot's verbatim payload, so this
# stays additive — a snapshot with no BR fields simply doesn't contribute.

# The 2x2 routing labels (mirrors `blind_review_outcome`), so the cross-domain
# distribution and the LSAT ability `blind_review_outcomes` describe outcomes
# with one shared vocabulary.
_BR_OUTCOMES = ("timed_ok", "timing_problem", "concept_gap", "lucky")


def _host_br_attempts(
    session: Session, *, plane: str | None, days: int | None,
) -> list[dict]:
    """Host blind-review attempts from the DATA-4a snapshot mirror.

    Reads `HostProgressSnapshot` attempt rows whose verbatim `CrossDomainAttempt`
    payload carries a host blind-review answer (`brAnswer`), pairing the timed
    correctness (`correct`) with the BR correctness (`brCorrect`). Read-only — it
    never mutates the host mirror. ``plane`` restricts to one host plane
    (cfa|quant|excel) or all of them when None. Returns rows shaped like the LSAT
    side: ``{q_type, timed_correct, br_correct}`` (br_correct may be None when the
    host logged a BR answer without grading it)."""
    stmt = select(HostProgressSnapshot).where(HostProgressSnapshot.kind == "attempt")
    if plane:
        stmt = stmt.where(HostProgressSnapshot.plane == plane)
    cutoff = _cutoff(days)
    if cutoff is not None:
        stmt = stmt.where(HostProgressSnapshot.created_at >= cutoff)
    rows = session.exec(stmt).all()

    out: list[dict] = []
    for row in rows:
        payload = row.payload if isinstance(row.payload, dict) else {}
        # Only attempts that actually captured a host BR answer contribute (mirrors
        # the LSAT-side `a.br_answer is not None` gate).
        if payload.get("brAnswer") is None:
            continue
        br_correct = payload.get("brCorrect")
        out.append({
            # The host canonical attempt has no q_type; group by plane so the host
            # "type" axis is the domain (cfa/quant/excel) rather than inventing one.
            "q_type": row.plane,
            "timed_correct": bool(payload.get("correct")),
            "br_correct": (bool(br_correct) if br_correct is not None else None),
        })
    return out


def _lsat_br_rows(session: Session, *, days: int | None) -> list[dict]:
    """LSAT attempts that carry a BR answer, shaped like the host rows above so the
    cross-domain merge feeds one uniform list. ``q_type`` is the LSAT question
    type (falls back to "LSAT" when the question can't be resolved)."""
    attempts = _all_attempts(session, days=days)
    qmap = _question_map(session, {a.question_id for a in attempts})
    rows: list[dict] = []
    for a in attempts:
        if a.br_answer is None:
            continue
        q = qmap.get(a.question_id)
        rows.append({
            "q_type": q.q_type if q else "LSAT",
            "timed_correct": bool(a.is_correct),
            "br_correct": a.br_correct,
        })
    return rows


def _br_rate(items: list[dict], key) -> float:
    if not items:
        return 0.0
    return round(sum(1 for it in items if key(it)) / len(items), 4)


def _br_block(items: list[dict]) -> dict:
    """The shared per-bucket BR block: timed/BR accuracy, gap, the 2x2 outcome
    distribution, plus careless-rate (timed-wrong but BR-right where the timed slip
    looks careless rather than a true concept gap) and lucky-rate (timed-right but
    BR-wrong) — the careless-vs-concept split this analytic exists to surface."""
    n = len(items)
    timed_acc = _br_rate(items, lambda it: it["timed_correct"])
    br_acc = _br_rate(items, lambda it: bool(it["br_correct"]))

    outcomes = {k: 0 for k in _BR_OUTCOMES}
    for it in items:
        outcomes[blind_review_outcome(it["timed_correct"], it["br_correct"])] += 1

    # careless = timed-wrong / BR-right ("timing_problem" in the 2x2): you knew it,
    # so the miss was a careless/timing slip, not a concept gap. concept = both wrong.
    careless = outcomes["timing_problem"]
    concept = outcomes["concept_gap"]
    lucky = outcomes["lucky"]
    return {
        "attempts": n,
        "timed_accuracy": timed_acc,
        "br_accuracy": br_acc,
        "gap": round(br_acc - timed_acc, 4),
        "outcomes": outcomes,
        "careless_rate": round(careless / n, 4) if n else 0.0,
        "concept_gap_rate": round(concept / n, 4) if n else 0.0,
        "lucky_rate": round(lucky / n, 4) if n else 0.0,
    }


def blind_review_gap_cross_domain(
    session: Session,
    *,
    domain: str | None = None,
    days: int | None = None,
) -> dict:
    """ANL-3 — cross-domain blind-review gap (careless vs concept).

    Merges LSAT `Attempt(br_answer/br_correct)` with HOST blind-review attempts
    (the optional `brAnswer`/`brCorrect` fields the host now captures on its
    canonical `CrossDomainAttempt`, mirrored read-only via DATA-4a's
    `HostProgressSnapshot`). For the combined pool and per-domain it reports the
    2x2 outcome distribution (timed_ok / timing_problem / concept_gap / lucky),
    accuracy-by-type, the BR gap, and the careless-vs-concept rates.

    ``domain`` selects the evidence plane and is BACKWARD-COMPATIBLE:
    - ``None`` / ``"lsat"`` -> LSAT-only (the default).
    - ``"host"`` -> host planes only (all of cfa/quant/excel).
    - ``"all"`` -> both planes merged.
    - a specific host plane (``"cfa"`` | ``"quant"`` | ``"excel"``) -> that plane.
    """
    plane = (domain or "").strip().lower() or None

    include_lsat = plane in (None, "lsat", "all")
    include_host = plane in ("host", "all", "cfa", "quant", "excel")
    host_plane = plane if plane in ("cfa", "quant", "excel") else None

    lsat_rows = _lsat_br_rows(session, days=days) if include_lsat else []
    host_rows = (
        _host_br_attempts(session, plane=host_plane, days=days) if include_host else []
    )

    all_rows = lsat_rows + host_rows

    # Per-type accuracy + gap over the combined pool (q_type = LSAT type or host
    # plane), ranked widest-gap first like the LSAT-native `blind_review_gap`.
    by_type_groups: dict[str, list[dict]] = defaultdict(list)
    for it in all_rows:
        by_type_groups[it["q_type"]].append(it)
    by_type = sorted(
        [
            {
                "q_type": t,
                "timed_accuracy": _br_rate(items, lambda it: it["timed_correct"]),
                "br_accuracy": _br_rate(items, lambda it: bool(it["br_correct"])),
                "gap": round(
                    _br_rate(items, lambda it: bool(it["br_correct"]))
                    - _br_rate(items, lambda it: it["timed_correct"]),
                    4,
                ),
                "attempts": len(items),
            }
            for t, items in by_type_groups.items()
        ],
        key=lambda r: -r["gap"],
    )

    # Lucky-rate surveillance per type with enough BR data (reuses the LSAT-side
    # _LUCKY_MIN_BR_SAMPLE floor so a single lucky answer can't dominate).
    lucky_rate_by_type: dict[str, float] = {}
    for t, items in by_type_groups.items():
        if len(items) < _LUCKY_MIN_BR_SAMPLE:
            continue
        lucky = sum(
            1 for it in items
            if it["timed_correct"] and it["br_correct"] is not None and not it["br_correct"]
        )
        lucky_rate_by_type[t] = round(lucky / len(items), 4)

    combined = _br_block(all_rows)
    return {
        "meta": {
            "model": "cross_domain_blind_review_v1",
            "domain": plane or "lsat",
            "window_days": days,
            "lsat_attempts": len(lsat_rows),
            "host_attempts": len(host_rows),
            "generated_at": datetime.now(timezone.utc).isoformat(),
        },
        # Combined-pool top-line (back-compatible keys mirror `blind_review_gap`).
        "timed_accuracy": combined["timed_accuracy"],
        "br_accuracy": combined["br_accuracy"],
        "gap": combined["gap"],
        "outcomes": combined["outcomes"],
        "careless_rate": combined["careless_rate"],
        "concept_gap_rate": combined["concept_gap_rate"],
        "lucky_rate": combined["lucky_rate"],
        "by_type": by_type,
        "lucky_rate_by_type": lucky_rate_by_type,
        # Per-domain blocks so the UI can show LSAT vs host side by side.
        "by_domain": {
            "lsat": _br_block(lsat_rows),
            "host": _br_block(host_rows),
        },
    }


# --- unified weakness index (ANL-2) -----------------------------------------
# How many recent miss ids to attach per weakness row (the "drill these first"
# pointer the Dashboard card surfaces). Kept small so the payload stays compact.
_WEAKNESS_RECENT_MISS_LIMIT = 5
# Beta-Binomial lower-bound parameters for the HOST side, mirroring the LSAT
# `mastery()` estimator so both planes rank on the SAME credible-lower-bound
# scale (a 2-attempt host topic can't masquerade as the weakest beside a
# 200-attempt LSAT type). Same weak 0.5-centered prior + ~95% z as `mastery()`.
_WEAKNESS_PRIOR_STRENGTH = _MASTERY_PRIOR_STRENGTH
_WEAKNESS_PRIOR_MEAN = _MASTERY_PRIOR_MEAN
_WEAKNESS_CI_Z = _MASTERY_CI_Z


def _beta_lower_bound(successes: float, n: float) -> tuple[float, float, float]:
    """(posterior_mean, lower_bound, ci_high) for a Beta-Binomial posterior with
    the shared weak 0.5 prior. Used for the HOST side so its accuracy is ranked on
    the same credible-lower-bound scale as the LSAT `mastery()` rows."""
    a0 = _WEAKNESS_PRIOR_STRENGTH * _WEAKNESS_PRIOR_MEAN
    b0 = _WEAKNESS_PRIOR_STRENGTH * (1.0 - _WEAKNESS_PRIOR_MEAN)
    alpha = a0 + successes
    beta = b0 + (n - successes)
    post_mean = alpha / (alpha + beta)
    post_var = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1.0))
    post_sd = post_var ** 0.5
    low = max(0.0, post_mean - _WEAKNESS_CI_Z * post_sd)
    high = min(1.0, post_mean + _WEAKNESS_CI_Z * post_sd)
    return post_mean, low, high


def _topic_from_cross_id(cross_id: str | None) -> str | None:
    """Pull the native topic/objective key out of a `<plane>:question:<native>`
    cross-id (DATA-2 §1). Returns None when the shape doesn't parse so the caller
    can fall back to the plane."""
    if not cross_id or not isinstance(cross_id, str):
        return None
    parts = cross_id.split(":", 2)
    if len(parts) == 3 and parts[2]:
        return parts[2]
    return None


def _lsat_drill_path(q_type: str) -> str:
    """Host-mountable deep-link into the LSAT type-analytics / drill view for a
    q_type (the LSAT app's `/analytics/type/:qType` mounted under `/lsat`)."""
    from urllib.parse import quote

    return f"/lsat/analytics/type/{quote(q_type, safe='')}"


def _host_drill_path(plane: str, topic: str | None) -> str:
    """Host-mountable deep-link into a plane's drills, optionally scoped to a
    topic. Mirrors the host's `/<plane>/drills` route (see src/data/catalog)."""
    from urllib.parse import quote

    base = f"/{quote(plane, safe='')}/drills"
    if topic:
        return f"{base}?topic={quote(topic, safe='')}"
    return base


def _lsat_weakness_rows(
    session: Session, *, days: int | None,
) -> list[dict]:
    """LSAT weakness rows from `mastery()` (already ranked weakest-first by the
    credible lower bound) plus the most recent miss question_ids per q_type."""
    rows = mastery(session, days=days)
    if not rows:
        return []

    # Recent miss ids per q_type: one windowed pass over practice attempts,
    # newest-first, capped per type — reuses the same windowed attempt fetch the
    # rest of analytics uses (no per-type query).
    attempts = _all_attempts(session, days=days)
    qmap = _question_map(session, {a.question_id for a in attempts})
    misses_by_type: dict[str, list[int]] = defaultdict(list)
    practice = [a for a in attempts if a.mode in (AttemptMode.timed, AttemptMode.drill)]
    practice.sort(key=lambda a: (_aware(a.created_at), a.id or 0), reverse=True)
    for a in practice:
        if a.is_correct:
            continue
        q = qmap.get(a.question_id)
        if q is None:
            continue
        bucket = misses_by_type[q.q_type]
        if len(bucket) < _WEAKNESS_RECENT_MISS_LIMIT and a.question_id is not None:
            bucket.append(a.question_id)

    out: list[dict] = []
    for m in rows:
        if m["attempts"] < 1:
            continue
        q_type = m["q_type"]
        out.append({
            "domain": "lsat",
            "key": q_type,
            "label": q_type,
            "section_type": m.get("section_type"),
            "accuracy": m.get("weighted_accuracy"),
            "mastery": m.get("mastery"),
            "lower_bound": m.get("lower_bound"),
            "attempts": m["attempts"],
            "trend": m.get("trend"),
            "recent_miss_ids": [str(i) for i in misses_by_type.get(q_type, [])],
            "drill_path": _lsat_drill_path(q_type),
        })
    return out


def _host_weakness_rows(
    session: Session, *, plane: str | None, days: int | None,
) -> list[dict]:
    """HOST weakness rows from the DATA-4a `HostProgressSnapshot` attempt mirror.

    Groups host attempt snapshots by topic (parsed from the canonical
    `questionCrossId`, falling back to the plane), computes a windowed accuracy +
    a Beta-Binomial credible lower bound (same scale as LSAT `mastery()`), and the
    most recent miss `crossId`s per topic. Read-only — never mutates the mirror.
    ``plane`` restricts to one host plane or all of them when None."""
    stmt = select(HostProgressSnapshot).where(HostProgressSnapshot.kind == "attempt")
    if plane:
        stmt = stmt.where(HostProgressSnapshot.plane == plane)
    cutoff = _cutoff(days)
    if cutoff is not None:
        stmt = stmt.where(HostProgressSnapshot.created_at >= cutoff)
    rows = session.exec(stmt).all()

    # Group attempts by (plane, topic). Each entry carries enough to compute the
    # accuracy + recent misses.
    groups: dict[tuple[str, str], list[tuple[HostProgressSnapshot, dict]]] = defaultdict(list)
    for row in rows:
        payload = row.payload if isinstance(row.payload, dict) else {}
        topic = _topic_from_cross_id(payload.get("questionCrossId")) or row.plane
        groups[(row.plane, topic)].append((row, payload))

    out: list[dict] = []
    for (row_plane, topic), items in groups.items():
        n = len(items)
        if not n:
            continue
        correct = sum(1 for _r, p in items if bool(p.get("correct")))
        accuracy = round(correct / n, 4)
        _mean, low, _high = _beta_lower_bound(float(correct), float(n))
        # Recent miss ids: newest-first by the snapshot's observed/created order.
        items_sorted = sorted(
            items,
            key=lambda rp: (_aware(rp[0].created_at), rp[0].id or 0),
            reverse=True,
        )
        recent_miss_ids = [
            str(r.cross_id)
            for r, p in items_sorted
            if not bool(p.get("correct"))
        ][:_WEAKNESS_RECENT_MISS_LIMIT]
        label = topic if topic != row_plane else row_plane.upper()
        out.append({
            "domain": row_plane,
            "key": topic,
            "label": label,
            "section_type": None,
            "accuracy": accuracy,
            "mastery": accuracy,
            "lower_bound": round(low, 4),
            "attempts": n,
            "trend": None,
            "recent_miss_ids": recent_miss_ids,
            "drill_path": _host_drill_path(row_plane, topic if topic != row_plane else None),
        })
    return out


def weakness_index(
    session: Session,
    *,
    domain: str | None = None,
    days: int | None = None,
    limit: int | None = None,
    offset: int | None = None,
) -> dict:
    """ANL-2 — unified weakness index across LSAT + host content.

    Merges the LSAT per-type `mastery()` (ranked by its ~95% credible LOWER bound)
    with HOST per-topic accuracy (derived from the DATA-4a `HostProgressSnapshot`
    attempt mirror, scored on the SAME Beta-Binomial lower-bound scale so the two
    planes are comparable) into ONE ranked list. Each row carries the recent-miss
    ids (LSAT `question_id` / host `crossId`) and a host-mountable
    ``drill_path`` deep-link so the Dashboard card can send the user straight to
    the weakest area.

    Ranking: ascending by ``lower_bound`` (a confidently-low area outranks a tiny
    noisy one), tie-broken by accuracy then by more attempts — identical in spirit
    to `mastery()`'s weakest-first ordering.

    ``domain`` selects the evidence plane and is BACKWARD-COMPATIBLE additive:
    - ``None`` / ``"all"`` -> LSAT + every host plane merged (the default view).
    - ``"lsat"`` -> LSAT only.
    - ``"host"`` -> host planes only (all of cfa/quant/excel).
    - a specific host plane (``"cfa"`` | ``"quant"`` | ``"excel"``) -> that plane.

    ``limit``/``offset`` page the ranked list (the full pre-slice count is in
    ``meta.total``); omit them for the whole list.
    """
    plane = (domain or "").strip().lower() or None

    include_lsat = plane in (None, "all", "lsat")
    include_host = plane in (None, "all", "host", "cfa", "quant", "excel")
    host_plane = plane if plane in ("cfa", "quant", "excel") else None

    lsat_rows = _lsat_weakness_rows(session, days=days) if include_lsat else []
    host_rows = (
        _host_weakness_rows(session, plane=host_plane, days=days) if include_host else []
    )

    merged = lsat_rows + host_rows
    # Weakest-first by credible lower bound; tie-break on accuracy then attempts.
    merged.sort(
        key=lambda r: (
            r["lower_bound"] if r["lower_bound"] is not None else 1.0,
            r["accuracy"] if r["accuracy"] is not None else 1.0,
            -r["attempts"],
        )
    )
    total = len(merged)
    page = paginate(merged, limit=limit, offset=offset)

    return {
        "meta": {
            "model": "weakness_index_v1",
            "domain": plane or "all",
            "window_days": days,
            "total": total,
            "limit": limit,
            "offset": offset or 0,
            "lsat_count": len(lsat_rows),
            "host_count": len(host_rows),
            "generated_at": datetime.now(timezone.utc).isoformat(),
        },
        "items": page,
    }


# --- traps ------------------------------------------------------------------
def traps(session: Session, *, days: int | None = None) -> list[dict]:
    """How often the student fell for each trap type (chose a wrong choice that
    carries that trap_type)."""
    attempts = _all_attempts(session, days=days)
    wrong = [a for a in attempts if not a.is_correct and a.chosen_answer]
    # Index only the choices of wrong-answered questions by (question_id, label).
    wrong_qids = {a.question_id for a in wrong}
    choices = (
        session.exec(
            select(AnswerChoice).where(AnswerChoice.question_id.in_(wrong_qids))
        ).all()
        if wrong_qids
        else []
    )
    cidx: dict[tuple[int, str], AnswerChoice] = {
        (c.question_id, c.label): c for c in choices
    }

    counts: dict[str, int] = defaultdict(int)
    total_wrong = 0
    for a in wrong:
        c = cidx.get((a.question_id, a.chosen_answer))
        if not c:
            continue
        total_wrong += 1
        tt = c.trap_type or "none"
        counts[tt] += 1

    out = [
        {
            "trap_type": tt,
            "times_fell_for": n,
            "pct": round(n / total_wrong, 4) if total_wrong else 0.0,
        }
        for tt, n in counts.items()
    ]
    return sorted(out, key=lambda r: -r["times_fell_for"])


# --- by difficulty (difficulty curve) ---------------------------------------
def by_difficulty(session: Session, source: str = "all", *,
                  days: int | None = None) -> list[dict]:
    """Accuracy & avg time per difficulty band (1-5) for the difficulty curve."""
    attempts = _all_attempts(session, days=days)
    qmap = _question_map(session, {a.question_id for a in attempts})
    practice = [a for a in attempts if a.mode in (AttemptMode.timed, AttemptMode.drill)]

    groups: dict[int, list[Attempt]] = defaultdict(list)
    for a in practice:
        q = qmap.get(a.question_id)
        if not q or q.difficulty is None:
            continue
        if source == "official" and q.source != QuestionSource.official:
            continue
        groups[q.difficulty].append(a)

    out = []
    for diff in sorted(groups):
        items = groups[diff]
        correct = sum(1 for a in items if a.is_correct)
        out.append({
            "difficulty": diff,
            "attempts": len(items),
            "accuracy": round(correct / len(items), 4),
            "avg_time_ms": round(sum(a.time_ms for a in items) / len(items)),
        })
    return out


# --- activity (study calendar / contribution heatmap) -----------------------
def activity(session: Session, days: int = 120) -> list[dict]:
    """Per-day study activity for the contribution heatmap, oldest -> newest.

    One entry for every day in the window (zero-filled), so the frontend can
    render a continuous calendar grid without gap logic.
    """
    days = max(1, min(days, 730))
    today = datetime.now(timezone.utc).date()
    start = today - timedelta(days=days - 1)

    start_dt = datetime(start.year, start.month, start.day, tzinfo=timezone.utc)
    # "questions" = real practice attempts (timed + drill), not the BR redo pass.
    practice = session.exec(
        select(Attempt)
        .where(Attempt.mode != AttemptMode.blind_review)
        .where(Attempt.created_at >= start_dt)
    ).all()

    per_day_q: dict = defaultdict(int)
    per_day_ms: dict = defaultdict(int)
    per_day_correct: dict = defaultdict(int)
    for a in practice:
        d = _aware(a.created_at).date()
        if d < start or d > today:
            continue
        per_day_q[d] += 1
        per_day_ms[d] += a.time_ms or 0
        if a.is_correct:
            per_day_correct[d] += 1

    sessions = session.exec(
        select(StudySession).where(StudySession.started >= start_dt)
    ).all()
    per_day_sessions: dict = defaultdict(int)
    for s in sessions:
        d = _aware(s.started).date()
        if start <= d <= today:
            per_day_sessions[d] += 1

    out = []
    d = start
    while d <= today:
        out.append({
            "date": d.isoformat(),
            "questions": per_day_q.get(d, 0),
            "minutes": round(per_day_ms.get(d, 0) / 60000, 1),
            "correct": per_day_correct.get(d, 0),
            "sessions": per_day_sessions.get(d, 0),
        })
        d += timedelta(days=1)
    return out


# --- cross-domain rollup (ANL-1) --------------------------------------------
def _host_accuracy(host_correct: int | None, host_attempts: int | None) -> float | None:
    """Accuracy from host-provided counts, or None when no host attempts."""
    if host_attempts and host_attempts > 0:
        return round((host_correct or 0) / host_attempts, 4)
    return None


def cross_domain(
    session: Session,
    *,
    days: int = 30,
    host_attempts: int | None = None,
    host_correct: int | None = None,
    host_study_minutes: float | None = None,
    host_streak_days: int | None = None,
    host_daily_questions: dict[str, int] | None = None,
    host_weakest: list[dict] | None = None,
    weakest_limit: int | None = None,
    weakest_offset: int | None = None,
) -> dict:
    """Bidirectional cross-domain study rollup so the host can pull LSAT analytics
    and merge them with its own (CFA/Quant/Excel) numbers in ONE call.

    Aggregates, over the trailing ``days`` window:
    - **study time** (combined minutes: LSAT practice minutes + any host minutes),
    - **accuracy by domain** (LSAT computed here; host taken from the optional
      ``host_attempts``/``host_correct``),
    - **merged weakest types** (LSAT weakest from :func:`mastery`, ranked by the
      credible-interval lower bound, interleaved with any ``host_weakest`` rows),
    - **combined streak** (the larger of the LSAT attempt streak and the optional
      host streak — the user's longest active cross-domain run),
    - a **30-day activity trend** (per-day LSAT questions, host questions, and the
      combined total) for a single cross-domain sparkline.

    Host numbers are OPTIONAL (DATA-4a owns the persisted host->backend feed). When
    none are passed this returns the LSAT-only view and ``meta.host_provided`` is
    False; the host then merges its local Dexie analytics with this payload
    client-side. All keys are additive and backward-compatible.
    """
    window = max(1, min(int(days or 30), 730))

    # --- LSAT side (computed locally from attempts) --------------------------
    lsat_practice = _attempts_for(session, days=window, source=None)
    lsat_attempts = len(lsat_practice)
    lsat_correct = sum(1 for a in lsat_practice if a.is_correct)
    lsat_accuracy = round(lsat_correct / lsat_attempts, 4) if lsat_attempts else None
    lsat_minutes = round(sum(a.time_ms or 0 for a in lsat_practice) / 60000, 1)
    lsat_streak = _streak_days(session)

    # Per-day LSAT activity over the window (reuse the zero-filled calendar).
    lsat_activity = activity(session, days=window)
    lsat_daily = {row["date"]: int(row["questions"]) for row in lsat_activity}

    # --- host side (optional, from query/body) -------------------------------
    host_provided = any(
        v is not None
        for v in (
            host_attempts, host_correct, host_study_minutes,
            host_streak_days, host_daily_questions, host_weakest,
        )
    )
    host_acc = _host_accuracy(host_correct, host_attempts)
    host_minutes = round(float(host_study_minutes), 1) if host_study_minutes else 0.0
    host_streak = int(host_streak_days) if host_streak_days else 0
    host_daily = host_daily_questions or {}

    # --- accuracy by domain --------------------------------------------------
    accuracy_by_domain = [
        {
            "domain": "lsat",
            "attempts": lsat_attempts,
            "correct": lsat_correct,
            "accuracy": lsat_accuracy,
            "study_minutes": lsat_minutes,
            "streak_days": lsat_streak,
        },
        {
            "domain": "host",
            "attempts": int(host_attempts) if host_attempts else 0,
            "correct": int(host_correct) if host_correct else 0,
            "accuracy": host_acc,
            "study_minutes": host_minutes,
            "streak_days": host_streak,
        },
    ]

    # --- merged weakest types ------------------------------------------------
    # LSAT weakest: reuse the mastery ranking (weakest-first by lower bound).
    lsat_weak = [
        {
            "domain": "lsat",
            "label": m["q_type"],
            "accuracy": m.get("weighted_accuracy"),
            "attempts": m["attempts"],
        }
        for m in mastery(session, days=window)
        if m["attempts"] >= 1
    ]
    host_weak = [
        {
            "domain": "host",
            "label": str(w.get("label") or w.get("topic") or w.get("q_type") or "?"),
            "accuracy": (
                round(float(w["accuracy"]), 4)
                if isinstance(w.get("accuracy"), (int, float)) else None
            ),
            "attempts": int(w.get("attempts") or 0),
        }
        for w in (host_weakest or [])
    ]
    # Rank the combined list weakest-first (lowest accuracy on top); None accuracy
    # (no signal) sorts last so it never masquerades as "weakest".
    merged_weak = sorted(
        lsat_weak + host_weak,
        key=lambda r: (r["accuracy"] is None, r["accuracy"] if r["accuracy"] is not None else 1.0),
    )
    weakest_total = len(merged_weak)
    merged_weak = paginate(merged_weak, limit=weakest_limit, offset=weakest_offset)

    # --- combined 30-day trend ----------------------------------------------
    trend_30d = []
    for row in lsat_activity:
        d = row["date"]
        lq = int(row["questions"])
        hq = int(host_daily.get(d, 0))
        trend_30d.append({
            "date": d,
            "lsat_questions": lq,
            "host_questions": hq,
            "questions": lq + hq,
        })

    return {
        "meta": {
            "model": "cross_domain_analytics_v1",
            "window_days": window,
            "host_provided": host_provided,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "weakest_total": weakest_total,
            "weakest_limit": weakest_limit,
            "weakest_offset": weakest_offset or 0,
        },
        # Combined study time across both domains (minutes).
        "study_minutes": round(lsat_minutes + host_minutes, 1),
        # Combined streak = the longest currently-active run across domains.
        "combined_streak_days": max(lsat_streak, host_streak),
        "accuracy_by_domain": accuracy_by_domain,
        "weakest_types": merged_weak,
        "trend_30d": trend_30d,
    }


# --- consolidated report ----------------------------------------------------
def report(session: Session, *, days: int = 120) -> dict:
    """One bundle of every analytic for a printable/exportable progress report."""
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "window_days": days,
        "dashboard": dashboard(session, days=days),
        "by_type": by_type(session, source="all", days=days),
        "by_difficulty": by_difficulty(session, source="all", days=days),
        "mastery": mastery(session, days=days),
        "blind_review_gap": blind_review_gap(session, days=days),
        "traps": traps(session, days=days),
        "forecast": forecast(session),
        "activity": activity(session, days=days),
    }


# --- single-type deep dive (TypeAnalytics page) -----------------------------
def type_analytics(session: Session, q_type: str, *, days: int | None = None,
                   recent_misses: int = 10) -> dict:
    """One payload for the TypeAnalytics page: overall accuracy/timing/trend,
    per-section split, BR-gap slice, traps fallen for, and recent misses — so
    the page makes ONE request instead of 4-5."""
    attempts = _all_attempts(session, days=days)
    qmap = _question_map(session, {a.question_id for a in attempts})
    type_qids = {qid for qid, q in qmap.items() if q.q_type == q_type}
    type_attempts = [a for a in attempts if a.question_id in type_qids]
    practice = [a for a in type_attempts if a.mode in (AttemptMode.timed, AttemptMode.drill)]
    practice_sorted = sorted(practice, key=lambda a: _aware(a.created_at))

    n = len(practice)
    correct = sum(1 for a in practice if a.is_correct)
    overall = {
        "q_type": q_type,
        "attempts": n,
        "accuracy": round(correct / n, 4) if n else 0.0,
        "avg_time_ms": round(sum(a.time_ms for a in practice) / n) if n else 0,
        "trend": _split_trend([a.is_correct for a in practice_sorted]),
    }

    by_section: dict[str, dict] = {}
    sec_groups: dict[str, list[Attempt]] = defaultdict(list)
    for a in practice:
        q = qmap.get(a.question_id)
        if q is None:
            continue
        sec_groups["RC" if q.passage_id else "LR"].append(a)
    for sec, items in sec_groups.items():
        c = sum(1 for a in items if a.is_correct)
        by_section[sec] = {"attempts": len(items),
                           "accuracy": round(c / len(items), 4) if items else 0.0}

    with_br = [a for a in type_attempts if a.br_answer is not None]

    def _acc(items, key):
        return round(sum(1 for a in items if key(a)) / len(items), 4) if items else 0.0

    gap = {
        "timed_accuracy": _acc(with_br, lambda a: a.is_correct),
        "br_accuracy": _acc(with_br, lambda a: bool(a.br_correct)),
        "gap": round(_acc(with_br, lambda a: bool(a.br_correct))
                     - _acc(with_br, lambda a: a.is_correct), 4),
        "n": len(with_br),
    }

    practice_qids = {a.question_id for a in practice}
    choices = (
        session.exec(
            select(AnswerChoice).where(AnswerChoice.question_id.in_(practice_qids))
        ).all()
        if practice_qids
        else []
    )
    cidx = {(c.question_id, c.label): c for c in choices}
    trap_counts: dict[str, int] = defaultdict(int)
    total_wrong = 0
    for a in practice:
        if a.is_correct or not a.chosen_answer:
            continue
        c = cidx.get((a.question_id, a.chosen_answer))
        if not c:
            continue
        total_wrong += 1
        trap_counts[c.trap_type or "none"] += 1
    traps_list = sorted(
        [{"trap_type": t, "times_fell_for": cnt,
          "pct": round(cnt / total_wrong, 4) if total_wrong else 0.0}
         for t, cnt in trap_counts.items()],
        key=lambda r: -r["times_fell_for"],
    )

    misses = [a for a in reversed(practice_sorted) if not a.is_correct][:recent_misses]
    recent = [
        {
            "question_id": a.question_id,
            "chosen_answer": a.chosen_answer,
            "correct_answer": qmap[a.question_id].correct_answer if qmap.get(a.question_id) else None,
            "time_ms": a.time_ms,
            "created_at": _aware(a.created_at).isoformat(),
        }
        for a in misses
    ]

    return {"q_type": q_type, "overall": overall, "by_section": by_section,
            "gap": gap, "traps": traps_list, "recent_misses": recent}


# --- confidence calibration (1.3) -------------------------------------------
# Nominal confidence each band asserts, for the over/under-confidence gap.
_CONFIDENCE_LEVEL = {"sure": 0.9, "likely": 0.65, "guess": 0.3}
_CONFIDENCE_ORDER = ["sure", "likely", "guess"]


def _attempts_for(session: Session, *, days: int | None, source: str | None) -> list[Attempt]:
    """Practice attempts (timed/drill), optionally restricted to official-source
    questions, honoring the shared ``days`` window + ``source`` convention."""
    attempts = _all_attempts(session, days=days)
    practice = [a for a in attempts if a.mode in (AttemptMode.timed, AttemptMode.drill)]
    if source == "official":
        qmap = _question_map(session, {a.question_id for a in practice})
        practice = [
            a for a in practice
            if qmap.get(a.question_id)
            and qmap[a.question_id].source == QuestionSource.official
        ]
    return practice


def confidence_calibration(session: Session, *, days: int | None = None,
                           source: str | None = None) -> dict:
    """How well stated confidence matches actual correctness.

    Returns per-band accuracy + counts, an over/under-confidence summary
    (nominal asserted confidence minus realized accuracy; positive =
    overconfident), the "sure-but-wrong" rate (overconfidence on the high band)
    and the "guess-but-right" rate (underconfidence on the low band)."""
    practice = _attempts_for(session, days=days, source=source)
    rated = [a for a in practice if a.confidence is not None]

    bands: list[dict] = []
    weighted_conf_sum = 0.0
    for band in _CONFIDENCE_ORDER:
        items = [a for a in rated if (
            a.confidence.value if hasattr(a.confidence, "value") else a.confidence
        ) == band]
        n = len(items)
        correct = sum(1 for a in items if a.is_correct)
        acc = round(correct / n, 4) if n else None
        bands.append({
            "confidence": band,
            "attempts": n,
            "correct": correct,
            "accuracy": acc,
            "nominal_confidence": _CONFIDENCE_LEVEL[band],
        })
        weighted_conf_sum += _CONFIDENCE_LEVEL[band] * n

    n_rated = len(rated)
    overall_acc = (
        round(sum(1 for a in rated if a.is_correct) / n_rated, 4) if n_rated else None
    )
    mean_nominal = round(weighted_conf_sum / n_rated, 4) if n_rated else None
    # gap > 0 => stated confidence exceeds realized accuracy (overconfident).
    calibration_gap = (
        round(mean_nominal - overall_acc, 4)
        if (mean_nominal is not None and overall_acc is not None) else None
    )
    if calibration_gap is None:
        verdict = "unknown"
    elif calibration_gap > 0.05:
        verdict = "overconfident"
    elif calibration_gap < -0.05:
        verdict = "underconfident"
    else:
        verdict = "calibrated"

    sure = [a for a in rated if _conf_val(a) == "sure"]
    guess = [a for a in rated if _conf_val(a) == "guess"]
    sure_but_wrong = (
        round(sum(1 for a in sure if not a.is_correct) / len(sure), 4) if sure else None
    )
    guess_but_right = (
        round(sum(1 for a in guess if a.is_correct) / len(guess), 4) if guess else None
    )

    return {
        "bands": bands,
        "n": n_rated,
        "overall_accuracy": overall_acc,
        "mean_nominal_confidence": mean_nominal,
        "calibration_gap": calibration_gap,
        "verdict": verdict,
        "sure_but_wrong_rate": sure_but_wrong,
        "guess_but_right_rate": guess_but_right,
    }


def _conf_val(a: Attempt) -> str | None:
    c = a.confidence
    if c is None:
        return None
    return c.value if hasattr(c, "value") else c


# --- silent regression alerts (C6) ------------------------------------------
def _two_proportion_z(
    *,
    recent_correct: int,
    recent_n: int,
    baseline_correct: int,
    baseline_n: int,
) -> float | None:
    if recent_n <= 0 or baseline_n <= 0:
        return None
    pooled = (recent_correct + baseline_correct) / (recent_n + baseline_n)
    denom = math.sqrt(pooled * (1.0 - pooled) * ((1.0 / recent_n) + (1.0 / baseline_n)))
    if denom <= 0:
        return None
    recent_acc = recent_correct / recent_n
    baseline_acc = baseline_correct / baseline_n
    return (recent_acc - baseline_acc) / denom


def regression_alerts(
    session: Session,
    *,
    recent_days: int = 7,
    baseline_days: int = 30,
    min_attempts: int = 6,
    min_drop: float = 0.15,
    source: str | None = None,
) -> dict:
    """C6 — detect quiet per-type accuracy dips.

    Compares the most recent window against the immediately preceding baseline
    window for each ``q_type``/section pair. The returned alerts are practical
    local-study alerts: a material drop is surfaced even when small sample sizes
    make the z-test a "watch" rather than a statistically confident regression.
    """
    recent_days = max(1, min(int(recent_days), 90))
    baseline_days = max(1, min(int(baseline_days), 365))
    min_attempts = max(1, min(int(min_attempts), 100))
    min_drop = max(0.01, min(float(min_drop), 0.9))

    now = datetime.now(timezone.utc)
    recent_start = now - timedelta(days=recent_days)
    baseline_start = recent_start - timedelta(days=baseline_days)
    attempts = _attempts_for(
        session,
        days=recent_days + baseline_days + 1,
        source=source,
    )
    qmap = _question_map(session, {a.question_id for a in attempts})
    groups: dict[tuple[str, str], dict[str, list[Attempt]]] = defaultdict(
        lambda: {"recent": [], "baseline": []}
    )
    for attempt in attempts:
        q = qmap.get(attempt.question_id)
        if q is None:
            continue
        created = _aware(attempt.created_at)
        if created < baseline_start:
            continue
        section_type = "RC" if q.passage_id else "LR"
        key = (q.q_type, section_type)
        if created >= recent_start:
            groups[key]["recent"].append(attempt)
        elif created < recent_start:
            groups[key]["baseline"].append(attempt)

    alerts: list[dict] = []
    checked_types = 0
    insufficient: list[dict] = []
    for (q_type, section_type), windows in sorted(groups.items()):
        recent = windows["recent"]
        baseline = windows["baseline"]
        if recent or baseline:
            checked_types += 1
        if len(recent) < min_attempts or len(baseline) < min_attempts:
            insufficient.append({
                "q_type": q_type,
                "section_type": section_type,
                "recent_attempts": len(recent),
                "baseline_attempts": len(baseline),
            })
            continue
        recent_correct = sum(1 for a in recent if a.is_correct)
        baseline_correct = sum(1 for a in baseline if a.is_correct)
        recent_acc = recent_correct / len(recent)
        baseline_acc = baseline_correct / len(baseline)
        delta = recent_acc - baseline_acc
        if delta > -min_drop:
            continue
        z = _two_proportion_z(
            recent_correct=recent_correct,
            recent_n=len(recent),
            baseline_correct=baseline_correct,
            baseline_n=len(baseline),
        )
        significant = z is not None and z <= -1.64
        if significant and abs(delta) >= 0.25:
            severity = "high"
        elif significant:
            severity = "medium"
        else:
            severity = "watch"
        alerts.append({
            "q_type": q_type,
            "section_type": section_type,
            "recent_attempts": len(recent),
            "baseline_attempts": len(baseline),
            "recent_correct": recent_correct,
            "baseline_correct": baseline_correct,
            "recent_accuracy": round(recent_acc, 4),
            "baseline_accuracy": round(baseline_acc, 4),
            "delta": round(delta, 4),
            "z_score": round(z, 4) if z is not None else None,
            "statistically_significant": significant,
            "severity": severity,
            "reason": "recent_accuracy_drop",
        })

    severity_rank = {"high": 0, "medium": 1, "watch": 2}
    alerts.sort(
        key=lambda row: (
            severity_rank.get(row["severity"], 9),
            row["delta"],
            row["q_type"],
        )
    )
    status = "regression" if any(a["severity"] != "watch" for a in alerts) else (
        "watch" if alerts else "ok"
    )
    if not checked_types:
        status = "insufficient_data"
    return {
        "model": "silent_regression_v1",
        "source": source or "all",
        "recent_days": recent_days,
        "baseline_days": baseline_days,
        "min_attempts": min_attempts,
        "min_drop": round(min_drop, 4),
        "status": status,
        "alerts": alerts,
        "summary": {
            "alert_count": len(alerts),
            "checked_types": checked_types,
            "insufficient_types": len(insufficient),
            "recent_window_start": recent_start.isoformat(),
            "baseline_window_start": baseline_start.isoformat(),
        },
        "insufficient": insufficient[:20],
    }


# --- error-reason trends (1.4) ----------------------------------------------
def error_reason_trends(session: Session, *, days: int | None = None) -> dict:
    """Aggregate ErrorLogEntry.reason codes overall, by q_type, and split into
    earlier-vs-recent halves (so you can see whether e.g. 'timing' errors are
    trending down). Reasons: misread|trap|concept|timing|careless."""
    stmt = select(ErrorLogEntry).order_by(ErrorLogEntry.id)
    cutoff = _cutoff(days)
    if cutoff is not None:
        stmt = stmt.where(ErrorLogEntry.created_at >= cutoff)
    entries = session.exec(stmt).all()

    # Map each entry -> its question's q_type via the attempt.
    attempt_ids = {e.attempt_id for e in entries}
    amap = {
        a.id: a for a in session.exec(
            select(Attempt).where(Attempt.id.in_(attempt_ids or [-1]))
        ).all()
    }
    qmap = _question_map(session, {a.question_id for a in amap.values()})

    overall: dict[str, int] = defaultdict(int)
    by_type: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    ordered_reasons: list[str] = []
    for e in entries:
        reason = e.reason.value if hasattr(e.reason, "value") else str(e.reason)
        overall[reason] += 1
        ordered_reasons.append(reason)
        a = amap.get(e.attempt_id)
        q = qmap.get(a.question_id) if a else None
        if q is not None:
            by_type[q.q_type][reason] += 1

    # earlier-vs-recent split by entry order (oldest..newest), same spirit as
    # _split_trend: first half = earlier, second half = recent.
    n = len(ordered_reasons)
    mid = n // 2
    earlier: dict[str, int] = defaultdict(int)
    recent: dict[str, int] = defaultdict(int)
    for i, r in enumerate(ordered_reasons):
        (earlier if i < mid else recent)[r] += 1

    reasons_seen = sorted(overall)
    trend = {
        r: {
            "earlier": earlier.get(r, 0),
            "recent": recent.get(r, 0),
            "direction": _count_direction(earlier.get(r, 0), recent.get(r, 0)),
        }
        for r in reasons_seen
    }

    return {
        "n": n,
        "overall": dict(overall),
        "by_type": {t: dict(c) for t, c in by_type.items()},
        "trend": trend,
        "top_reason": (max(overall.items(), key=lambda kv: kv[1])[0] if overall else None),
    }


def _count_direction(earlier: int, recent: int) -> str:
    """'up'|'down'|'flat' for a raw count comparison (more errors recently = up)."""
    if recent > earlier:
        return "up"
    if recent < earlier:
        return "down"
    return "flat"


# --- elimination insight (1.2) ----------------------------------------------
def elimination_insight(session: Session, *, days: int | None = None) -> dict:
    """Process-of-elimination readout from AttemptChoiceEvent.

    For attempts that carry a choice trace AND were answered correctly, how often
    was the (correct) chosen answer eliminated at some point before being selected
    — i.e. you talked yourself out of the right answer first? Also: how often the
    trap (a wrong choice) was the LAST thing eliminated, a classic 'down to two'
    failure pattern."""
    attempts = _all_attempts(session, days=days)
    amap = {a.id: a for a in attempts}
    events = session.exec(
        select(AttemptChoiceEvent)
        .where(AttemptChoiceEvent.attempt_id.in_(list(amap) or [-1]))
        .order_by(AttemptChoiceEvent.attempt_id,
                  AttemptChoiceEvent.order_index, AttemptChoiceEvent.id)
    ).all()

    by_attempt: dict[int, list[AttemptChoiceEvent]] = defaultdict(list)
    for e in events:
        by_attempt[e.attempt_id].append(e)

    qmap = _question_map(session, {a.question_id for a in amap.values()})

    n_traced = 0
    correct_eliminated_first = 0     # correct answer was eliminated before chosen
    n_correct_traced = 0
    trap_eliminated_last = 0
    n_with_eliminations = 0
    for aid, evs in by_attempt.items():
        a = amap.get(aid)
        q = qmap.get(a.question_id) if a else None
        if a is None or q is None:
            continue
        n_traced += 1
        correct_label = q.correct_answer

        # Did the correct answer get eliminated at any point, then later selected?
        elim_order = [e for e in evs if e.action == "eliminate"]
        if a.is_correct:
            n_correct_traced += 1
            # the correct answer appears in an 'eliminate' event before any
            # 'select'/'restore' of it.
            elim_idx = next(
                (e.order_index for e in evs
                 if e.label == correct_label and e.action == "eliminate"), None
            )
            chose_idx = next(
                (e.order_index for e in evs
                 if e.label == correct_label and e.action in ("select", "restore")),
                None,
            )
            if elim_idx is not None and (chose_idx is None or elim_idx < chose_idx):
                correct_eliminated_first += 1

        if elim_order:
            n_with_eliminations += 1
            last_elim = elim_order[-1]
            # "trap eliminated last": the final elimination was a wrong choice
            # (you were down to the correct answer + a trap and killed the trap last).
            if last_elim.label != correct_label:
                trap_eliminated_last += 1

    return {
        "n_traced_attempts": n_traced,
        "correct_eliminated_first": correct_eliminated_first,
        "correct_eliminated_first_rate": (
            round(correct_eliminated_first / n_correct_traced, 4)
            if n_correct_traced else None
        ),
        "trap_eliminated_last": trap_eliminated_last,
        "trap_eliminated_last_rate": (
            round(trap_eliminated_last / n_with_eliminations, 4)
            if n_with_eliminations else None
        ),
    }


# --- focus quality (per session) --------------------------------------------
def focus_quality(session: Session, session_id: int) -> dict:
    """Backend-derived focus score (0-100) for a session from real signals:
    pacing consistency (low time variance), flag rate, and timing-problem rate
    (timed-wrong / BR-right). Replaces the cosmetic client measure."""
    attempts = session.exec(
        select(Attempt)
        .where(Attempt.session_id == session_id)
        .where(Attempt.mode != AttemptMode.blind_review)
        .order_by(Attempt.id)
    ).all()
    n = len(attempts)
    if n == 0:
        return {"score": None, "components": {}, "n": 0}

    times = [a.time_ms for a in attempts if a.time_ms]
    flag_rate = sum(1 for a in attempts if a.flagged) / n
    timing_prob_rate = sum(
        1 for a in attempts if (not a.is_correct) and a.br_correct
    ) / n
    if len(times) >= 2 and statistics.mean(times) > 0:
        cov = statistics.pstdev(times) / statistics.mean(times)
    else:
        cov = 0.0
    consistency = max(0.0, 1.0 - min(cov, 1.0))
    score = 100 * (0.5 * consistency + 0.25 * (1 - flag_rate) + 0.25 * (1 - timing_prob_rate))
    return {
        "score": round(score, 1),
        "components": {
            "pacing_consistency": round(consistency, 3),
            "flag_rate": round(flag_rate, 3),
            "timing_problem_rate": round(timing_prob_rate, 3),
        },
        "n": n,
    }
