"""Local adaptive engine for vNext.

The design is deliberately humble: LSATLab is a single-user, local-first app, so
we use transparent IRT/Elo-style estimates rather than pretending to have a
large calibration population. The output is good enough to pick productive next
questions, surface readiness, and persist an auditable ability history.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlmodel import Session, select

from . import analytics, embeddings, notebook_os, serializers, srs
from .learning_feedback import (
    bucket_feedback as _bucket_feedback,
    daily_plan_feedback_summary as _daily_plan_feedback_summary,
)
from .models import (
    AbilitySnapshot,
    Attempt,
    AttemptMode,
    AttemptRationale,
    Confidence,
    Passage,
    Question,
    QuestionConversation,
    QuestionItemStats,
    QuestionSource,
    ReadinessSnapshot,
    Section,
    SectionType,
    SRSCard,
    StudyPlan,
    TutorTurn,
)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _source_value(source: Any) -> str:
    return source.value if hasattr(source, "value") else str(source)


def _section_type_for(session: Session, q: Question) -> SectionType:
    if q.passage_id is not None:
        return SectionType.RC
    if q.section_id:
        sec = session.get(Section, q.section_id)
        if sec is not None:
            return sec.type
    return SectionType.LR


def _confidence_weight(confidence: Confidence | str | None) -> float:
    value = confidence.value if hasattr(confidence, "value") else confidence
    return {"sure": 1.12, "likely": 1.0, "guess": 0.84}.get(str(value or ""), 1.0)


def _difficulty_to_b(difficulty: float | None) -> float:
    return ((difficulty or 3.0) - 3.0) * 0.65


def _b_to_difficulty(b: float) -> float:
    return _bounded((b / 0.65) + 3.0, 1.0, 5.0)


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-max(-8.0, min(8.0, x))))


def _bounded(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


_ABILITY_ENGINE_MODEL = "ability_engine_v2"
_UTILITY_PACKET_MODEL = "ability_engine_v2_utility_v1"
_UTILITY_WEIGHTS = {
    "srs": 0.34,
    "weak_type": 0.3,
    "uncertainty": 0.18,
    "blind_review": 0.12,
    "fatigue": 0.06,
}
_FEEDBACK_WINDOW_DAYS = 28
_FEEDBACK_SCORE_LIMIT = 0.08


def _numeric(v: Any, default: float = 0.0) -> float:
    try:
        if v is None:
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _feedback_impact(
    signals: dict[str, Any],
    feedback: dict[str, Any],
    score: float,
) -> list[dict[str, Any]]:
    completion_rate = _numeric(feedback.get("completion_rate"), 0.0)
    skip_rate = _numeric(feedback.get("skip_rate"), 0.0)
    slope = _numeric(signals.get("mastery_slope_per_week"), 0.0)
    return [
        {
            "key": "mastery",
            "status": "improving" if slope > 0.005 else "needs_more_signal",
            "value": round(slope, 4),
            "detail": "recent mastery slope after accepted plan work",
        },
        {
            "key": "cadence",
            "status": "reinforced" if completion_rate >= 0.5 else "needs_consistency",
            "value": round(completion_rate, 4),
            "detail": "share of accepted daily-plan tasks completed",
        },
        {
            "key": "readiness",
            "status": "supported" if score >= 0.45 and skip_rate <= 0.35 else "watch",
            "value": round(score, 4),
            "detail": "selector utility after feedback adjustment",
        },
    ]


def _selector_utility_packet(
    ability: dict[str, Any],
    srs_evidence: dict[str, Any],
    *,
    days: int | None,
    feedback: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Shared Ability Engine utility evidence for drills, SRS, plan, readiness."""
    evidence_n = int(_numeric(ability.get("evidence_n"), 0.0))
    mastery = _bounded(_numeric(ability.get("mastery"), 0.5), 0.0, 1.0)
    uncertainty = _bounded(_numeric(ability.get("uncertainty"), 1.0), 0.0, 1.0)
    velocity = ability.get("learning_velocity") or {}
    slope = _numeric(velocity.get("slope_per_week"), 0.0)
    plateau = bool(ability.get("plateau"))
    outcomes = (ability.get("components") or {}).get("blind_review_outcomes") or {}
    br_total = sum(
        int(v)
        for v in outcomes.values()
        if isinstance(v, (int, float)) and v > 0
    )
    br_gaps = int(outcomes.get("concept_gap") or 0) + int(
        outcomes.get("timing_problem") or 0
    )
    srs_due = int(srs_evidence.get("due") or 0)
    srs_total = int(srs_evidence.get("total") or 0)
    weak_type_pressure = _bounded(1.0 - mastery, 0.0, 1.0)
    srs_pressure = _bounded(srs_due / 20.0, 0.0, 1.0)
    blind_review_pressure = _bounded(br_gaps / max(1, br_total), 0.0, 1.0)
    cadence_pressure = _bounded((24 - min(evidence_n, 24)) / 24.0, 0.0, 1.0)
    slope_pressure = 1.0 if plateau or slope <= 0 else _bounded(0.04 - slope, 0.0, 0.04) / 0.04
    fatigue_pressure = _bounded((srs_due / 40.0) + max(0.0, -slope) * 2.0, 0.0, 1.0)
    signals = {
        "theta": round(_numeric(ability.get("ability"), 0.0), 4),
        "mastery": round(mastery, 4),
        "mastery_gap": round(weak_type_pressure, 4),
        "uncertainty": round(uncertainty, 4),
        "uncertainty_pressure": round(uncertainty, 4),
        "evidence_n": evidence_n,
        "cadence_pressure": round(cadence_pressure, 4),
        "mastery_slope_per_week": round(slope, 4),
        "slope_pressure": round(slope_pressure, 4),
        "plateau": plateau,
        "srs_due": srs_due,
        "srs_total": srs_total,
        "srs_pressure": round(srs_pressure, 4),
        "blind_review_pressure": round(blind_review_pressure, 4),
        "fatigue_pressure": round(fatigue_pressure, 4),
    }
    feedback = feedback or _bucket_feedback([])
    feedback_adjustment = _numeric(feedback.get("selector_adjustment"), 0.0)
    signals.update({
        "feedback_events": int(_numeric(feedback.get("total"), 0.0)),
        "feedback_completion_rate": feedback.get("completion_rate"),
        "feedback_skip_rate": feedback.get("skip_rate"),
        "feedback_reopen_rate": feedback.get("reopen_rate"),
        "feedback_selector_adjustment": round(feedback_adjustment, 4),
    })
    if feedback.get("q_type_summary"):
        q_feedback = feedback.get("q_type_summary") or {}
        signals["feedback_q_type_events"] = int(_numeric(q_feedback.get("total"), 0.0))
        signals["feedback_q_type_completion_rate"] = q_feedback.get("completion_rate")
    score = (
        _UTILITY_WEIGHTS["srs"] * srs_pressure
        + _UTILITY_WEIGHTS["weak_type"] * weak_type_pressure
        + _UTILITY_WEIGHTS["uncertainty"] * uncertainty
        + _UTILITY_WEIGHTS["blind_review"] * blind_review_pressure
        + _UTILITY_WEIGHTS["fatigue"] * fatigue_pressure
    )
    adjusted_score = _bounded(score + feedback_adjustment, 0.0, 1.0)
    effective_weights = {
        **_UTILITY_WEIGHTS,
        "feedback_acceptance": round(abs(feedback_adjustment), 4),
    }
    feedback = {
        **feedback,
        "impact": _feedback_impact(signals, feedback, adjusted_score),
    }
    return {
        "model": _UTILITY_PACKET_MODEL,
        "days": days,
        "weights": dict(_UTILITY_WEIGHTS),
        "effective_weights": effective_weights,
        "signals": signals,
        "score": round(adjusted_score, 4),
        "base_score": round(_bounded(score, 0.0, 1.0), 4),
        "feedback": feedback,
        "cadence": {
            "attempts": evidence_n,
            "window_days": days,
            "evidence_density": round(evidence_n / max(1, int(days or 1)), 4),
        },
    }


def _utility_signal(selector: dict[str, Any], key: str, default: float = 0.0) -> float:
    return _numeric(((selector.get("utility") or {}).get("signals") or {}).get(key), default)


def _task_utility(
    selector: dict[str, Any],
    kind: str,
    *,
    mastery: float | None = None,
    uncertainty: float | None = None,
) -> float:
    srs_pressure = _utility_signal(selector, "srs_pressure")
    br_pressure = _utility_signal(selector, "blind_review_pressure")
    cadence_pressure = _utility_signal(selector, "cadence_pressure")
    weak_pressure = _utility_signal(
        selector,
        "mastery_gap",
        1.0 - _numeric(mastery, _utility_signal(selector, "mastery", 0.5)),
    )
    uncertainty_pressure = _numeric(
        uncertainty,
        _utility_signal(selector, "uncertainty_pressure", 0.5),
    )
    if kind == "srs":
        score = 0.55 + srs_pressure * 0.35
    elif kind == "leech":
        score = 0.66 + srs_pressure * 0.18 + _utility_signal(selector, "fatigue_pressure") * 0.08
    elif kind == "concept_gap":
        score = 0.62 + br_pressure * 0.28 + weak_pressure * 0.12
    elif kind == "adaptive_drill":
        score = 0.5 + weak_pressure * 0.3 + uncertainty_pressure * 0.15
    elif kind == "blind_review":
        score = 0.48 + br_pressure * 0.22 + cadence_pressure * 0.12
    else:
        score = 0.5
    score += _utility_signal(selector, "feedback_selector_adjustment")
    return round(_bounded(score, 0.0, 1.2), 3)


def _question_utility(
    selector: dict[str, Any],
    *,
    expected_success: float,
    information: float,
    review_bonus: float,
    official_bonus: float,
) -> dict[str, float]:
    window = ((selector.get("zpd") or {}).get("target_success_window") or [0.42, 0.78])
    lo, hi = float(window[0]), float(window[1])
    midpoint = (lo + hi) / 2.0
    half_width = max(0.01, (hi - lo) / 2.0)
    zpd_fit = _bounded(1.0 - abs(expected_success - midpoint) / half_width, 0.0, 1.0)
    utility_score = (
        0.58 * information
        + 0.24 * zpd_fit
        + review_bonus
        + official_bonus
        + 0.03 * _utility_signal(selector, "uncertainty_pressure")
        + 0.02 * _utility_signal(selector, "mastery_gap")
    )
    return {
        "utility_score": round(_bounded(utility_score, 0.0, 1.0), 4),
        "zpd_fit": round(zpd_fit, 4),
    }


def _learning_velocity(dated_signals: list[tuple[datetime, float]]) -> dict[str, Any]:
    """Small, transparent learning-curve proxy over the local attempt stream."""
    if len(dated_signals) < 4:
        return {
            "slope_per_week": 0.0,
            "window": "insufficient_data",
            "early_signal": None,
            "recent_signal": None,
        }
    ordered = sorted(dated_signals, key=lambda row: row[0])
    split = max(2, len(ordered) // 2)
    early = [s for _dt, s in ordered[:split]]
    recent = [s for _dt, s in ordered[-split:]]
    early_avg = sum(early) / len(early)
    recent_avg = sum(recent) / len(recent)
    days = max(1.0, (ordered[-1][0] - ordered[0][0]).total_seconds() / 86400.0)
    slope = (recent_avg - early_avg) / max(1.0, days / 7.0)
    return {
        "slope_per_week": round(slope, 4),
        "window": "local_attempt_history",
        "early_signal": round(early_avg, 4),
        "recent_signal": round(recent_avg, 4),
        "days": round(days, 1),
    }


def _mastery_eta_days(*, mastery: float, slope_per_week: float,
                      target: float = 0.82) -> int | None:
    if mastery >= target:
        return 0
    if slope_per_week <= 0:
        return None
    # Convert rough ability-signal slope to mastery-space days. This is a
    # directional ETA, not a psychometric promise.
    weekly_mastery_gain = max(0.005, slope_per_week * 0.18)
    return int(math.ceil(((target - mastery) / weekly_mastery_gain) * 7))


def _attempt_signal(a: Attempt, q: Question) -> tuple[float, float]:
    """Return (weighted signal, weight) for one attempt."""
    result = 1.0 if a.is_correct else 0.0
    # Blind Review is not a second correctness vote; it tells us whether the
    # underlying concept was available once time pressure was removed.
    if a.br_correct is True and not a.is_correct:
        result += 0.22
    elif a.br_correct is False and a.is_correct:
        result -= 0.18
    result = _bounded(result, 0.0, 1.0)

    difficulty_bonus = ((q.empirical_difficulty or q.difficulty or 3) - 3.0) * 0.11
    timing_penalty = 0.0
    if a.time_ms and a.time_ms > 105_000:
        timing_penalty = min(0.16, (a.time_ms - 105_000) / 240_000)
    signal = (result - 0.5) * 2.0 + difficulty_bonus - timing_penalty
    return signal, _confidence_weight(a.confidence)


def refresh_question_stats(
    session: Session,
    question_id: int,
    *,
    commit: bool = True,
) -> QuestionItemStats | None:
    """Recompute one question's observed item stats from attempts."""
    q = session.get(Question, question_id)
    if q is None:
        return None
    attempts = session.exec(
        select(Attempt)
        .where(Attempt.question_id == question_id)
        .where(Attempt.mode != AttemptMode.blind_review)
    ).all()
    row = session.exec(
        select(QuestionItemStats).where(QuestionItemStats.question_id == question_id)
    ).first()
    if row is None:
        row = QuestionItemStats(question_id=question_id)
    row.attempts = len(attempts)
    row.correct = sum(1 for a in attempts if a.is_correct)
    br = [a for a in attempts if a.br_answer is not None]
    row.br_attempts = len(br)
    row.br_correct = sum(1 for a in br if a.br_correct)
    timed = [a.time_ms for a in attempts if a.time_ms and a.time_ms > 0]
    row.avg_time_ms = round(sum(timed) / len(timed), 1) if timed else None
    if attempts:
        acc = row.correct / len(attempts)
        # Blend authored difficulty with observed accuracy. Harder observed
        # items move upward; easy observed items move downward, clamped 1..5.
        row.difficulty_estimate = round(
            _bounded((q.difficulty or 3) + (0.62 - acc) * 2.0, 1.0, 5.0), 3
        )
        row.discrimination = round(abs(acc - 0.5) * 2.0, 3)
    else:
        row.difficulty_estimate = float(q.empirical_difficulty or q.difficulty or 3)
        row.discrimination = None
    row.updated_at = datetime.now(timezone.utc)
    session.add(row)
    if commit:
        session.commit()
        session.refresh(row)
    return row


def refresh_all_item_stats(session: Session) -> dict[str, int]:
    qids = session.exec(select(Question.id).where(Question.deleted_at.is_(None))).all()
    updated = 0
    for qid in qids:
        if refresh_question_stats(session, int(qid), commit=False) is not None:
            updated += 1
    session.commit()
    return {"updated": updated}


def ability_estimate(
    session: Session,
    *,
    q_type: str | None = None,
    section_type: SectionType | None = None,
    days: int | None = None,
    persist: bool = False,
) -> dict[str, Any]:
    """Compute a transparent local ability estimate for one slice."""
    stmt = select(Attempt).where(Attempt.mode != AttemptMode.blind_review)
    if days:
        stmt = stmt.where(Attempt.created_at >= datetime.now(timezone.utc) - timedelta(days=days))
    attempts = session.exec(stmt).all()
    qids = {a.question_id for a in attempts}
    qmap = {
        q.id: q for q in session.exec(
            select(Question).where(Question.id.in_(qids or {-1}))
        ).all()
        if q.deleted_at is None
    }
    signals: list[float] = []
    weights: list[float] = []
    dated_signals: list[tuple[datetime, float]] = []
    correct = 0
    times: list[int] = []
    by_outcome = {"timed_ok": 0, "timing_problem": 0, "concept_gap": 0, "lucky": 0}

    for a in attempts:
        q = qmap.get(a.question_id)
        if q is None:
            continue
        if q_type and q.q_type != q_type:
            continue
        st = _section_type_for(session, q)
        if section_type and st != section_type:
            continue
        sig, weight = _attempt_signal(a, q)
        signals.append(sig)
        weights.append(weight)
        dated_signals.append((_aware(a.created_at), sig))
        correct += 1 if a.is_correct else 0
        if a.time_ms:
            times.append(a.time_ms)
        if a.br_answer is not None:
            outcome = analytics.blind_review_outcome(a.is_correct, a.br_correct)
            by_outcome[outcome] = by_outcome.get(outcome, 0) + 1

    evidence_n = len(signals)
    if evidence_n:
        sw = sum(weights) or 1.0
        ability = sum(s * w for s, w in zip(signals, weights)) / sw
        accuracy = correct / evidence_n
        uncertainty = 1.0 / math.sqrt(evidence_n + 1)
    else:
        ability = 0.0
        accuracy = None
        uncertainty = 1.0
    mastery = _sigmoid(ability)
    avg_time = round(sum(times) / len(times), 1) if times else None
    velocity = _learning_velocity(dated_signals)
    plateau = evidence_n >= 10 and abs(velocity["slope_per_week"]) < 0.015
    mastery_eta_days = _mastery_eta_days(
        mastery=mastery,
        slope_per_week=velocity["slope_per_week"],
        target=0.82,
    )
    payload = {
        "q_type": q_type,
        "section_type": section_type.value if section_type else None,
        "ability": round(ability, 4),
        "mastery": round(mastery, 4),
        "uncertainty": round(uncertainty, 4),
        "evidence_n": evidence_n,
        "accuracy": round(accuracy, 4) if accuracy is not None else None,
        "avg_time_ms": avg_time,
        "model": "local_irt_elo_v2",
        "learning_velocity": velocity,
        "plateau": plateau,
        "mastery_eta_days": mastery_eta_days,
        "components": {
            "blind_review_outcomes": by_outcome,
            "days": days,
            "model": "local_irt_elo_v2",
            "uses_official_score_anchor_only": True,
        },
    }
    if persist:
        snap = AbilitySnapshot(
            q_type=q_type,
            section_type=section_type,
            ability=payload["ability"],
            mastery=payload["mastery"],
            uncertainty=payload["uncertainty"],
            evidence_n=evidence_n,
            accuracy=payload["accuracy"],
            avg_time_ms=avg_time,
            components_json=payload["components"],
        )
        session.add(snap)
        session.commit()
        session.refresh(snap)
        payload["snapshot_id"] = snap.id
        payload["created_at"] = snap.created_at.isoformat()
    return payload


def ability_matrix(session: Session, *, days: int | None = None,
                   persist: bool = False) -> dict[str, Any]:
    q_types = sorted({
        q.q_type for q in session.exec(
            select(Question).where(Question.deleted_at.is_(None))
        ).all()
        if q.q_type
    })
    by_type = [
        ability_estimate(session, q_type=qt, days=days, persist=persist)
        for qt in q_types
    ]
    overall = ability_estimate(session, days=days, persist=persist)
    return {
        "overall": overall,
        "by_type": by_type,
        "weakest": sorted(by_type, key=lambda r: (r["mastery"], -r["evidence_n"]))[:5],
        "selector": selector_from_ability(session, overall, days=days),
    }


def _srs_selector_evidence(session: Session) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    cards = session.exec(select(SRSCard)).all()
    due = [
        c for c in cards
        if _aware(c.due_date) <= now
    ]
    return {
        "total": len(cards),
        "due": len(due),
        "concept_gap": sum(1 for c in cards if c.origin == "concept_gap"),
        "leech": sum(1 for c in cards if c.leech),
    }


def selector_from_ability(
    session: Session,
    ability: dict[str, Any],
    *,
    days: int | None = 180,
) -> dict[str, Any]:
    theta = float(ability.get("ability") or 0.0)
    uncertainty = float(ability.get("uncertainty") or 1.0)
    # Higher uncertainty widens the productive band so the selector gathers
    # evidence before over-specializing.
    zpd_width = 0.48 + min(0.42, uncertainty * 0.35)
    zpd = {
        "target_difficulty": round(_b_to_difficulty(theta), 2),
        "lower_difficulty": round(_b_to_difficulty(theta - zpd_width), 2),
        "upper_difficulty": round(_b_to_difficulty(theta + zpd_width), 2),
        "target_success_window": [0.42, 0.78],
    }
    srs_evidence = _srs_selector_evidence(session)
    if srs_evidence["due"] >= 10:
        strategy = "srs_first"
    elif uncertainty >= 0.55:
        strategy = "evidence_building"
    elif float(ability.get("mastery") or 0.5) < 0.62:
        strategy = "zpd_repair"
    else:
        strategy = "zpd_stretch"
    feedback = _daily_plan_feedback_summary(
        session,
        days=min(int(days or _FEEDBACK_WINDOW_DAYS), _FEEDBACK_WINDOW_DAYS),
        q_type=ability.get("q_type"),
    )
    utility = _selector_utility_packet(ability, srs_evidence, days=days, feedback=feedback)
    return {
        "model": _ABILITY_ENGINE_MODEL,
        "theta": round(theta, 4),
        "q_type": ability.get("q_type"),
        "section_type": ability.get("section_type"),
        "days": days,
        "zpd": zpd,
        "srs": srs_evidence,
        "strategy": strategy,
        "utility_model": _UTILITY_PACKET_MODEL,
        "utility_weights": dict(_UTILITY_WEIGHTS),
        "utility": utility,
        "evidence": {
            "attempts": ability.get("evidence_n", 0),
            "mastery": ability.get("mastery"),
            "uncertainty": ability.get("uncertainty"),
            "learning_velocity": ability.get("learning_velocity"),
        },
        "ability": ability,
    }


def ability_selector(
    session: Session,
    *,
    q_type: str | None = None,
    section_type: SectionType | None = None,
    days: int | None = 180,
) -> dict[str, Any]:
    ability = ability_estimate(
        session, q_type=q_type, section_type=section_type, days=days, persist=False
    )
    return selector_from_ability(session, ability, days=days)


def _eligible_questions(
    session: Session,
    *,
    q_type: str | None,
    section_type: SectionType | None,
    source: str,
) -> list[Question]:
    rows = session.exec(select(Question).where(Question.deleted_at.is_(None))).all()
    out: list[Question] = []
    for q in rows:
        if q_type and q.q_type != q_type:
            continue
        if section_type and _section_type_for(session, q) != section_type:
            continue
        if _source_value(q.source) == QuestionSource.ai_generated.value and (
            q.quarantined or not q.approved
        ):
            continue
        if source == "real" and _source_value(q.source) == QuestionSource.ai_generated.value:
            continue
        if source == "ai" and _source_value(q.source) != QuestionSource.ai_generated.value:
            continue
        out.append(q)
    return out


def _recent_attempts(session: Session, *, days: int = 7) -> dict[int, Attempt]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    rows = session.exec(
        select(Attempt)
        .where(Attempt.created_at >= cutoff)
        .where(Attempt.mode != AttemptMode.blind_review)
        .order_by(Attempt.id.desc())
    ).all()
    out: dict[int, Attempt] = {}
    for a in rows:
        out.setdefault(a.question_id, a)
    return out


def next_questions(
    session: Session,
    *,
    count: int = 5,
    q_type: str | None = None,
    section_type: SectionType | None = None,
    source: str = "real",
    include_recent: bool = False,
) -> dict[str, Any]:
    """Rank next questions by expected learning information."""
    selector = ability_selector(
        session, q_type=q_type, section_type=section_type, days=180
    )
    ability = selector["ability"]
    theta = float(ability["ability"])
    recent = _recent_attempts(session, days=7)
    pool = _eligible_questions(
        session, q_type=q_type, section_type=section_type, source=source
    )
    scored: list[tuple[float, dict, Question]] = []
    for q in pool:
        if not include_recent and q.id in recent:
            continue
        stats = session.exec(
            select(QuestionItemStats).where(QuestionItemStats.question_id == q.id)
        ).first()
        diff = (
            stats.difficulty_estimate if stats and stats.difficulty_estimate is not None
            else q.empirical_difficulty if q.empirical_difficulty is not None
            else q.difficulty
        )
        expected_success = _sigmoid(theta - _difficulty_to_b(diff))
        info = expected_success * (1.0 - expected_success)
        prior = recent.get(q.id)
        review_bonus = 0.0
        if prior and (not prior.is_correct or prior.br_correct is False):
            review_bonus = 0.08
        official_bonus = 0.03 if _source_value(q.source) == QuestionSource.official.value else 0.0
        utility = _question_utility(
            selector,
            expected_success=expected_success,
            information=info,
            review_bonus=review_bonus,
            official_bonus=official_bonus,
        )
        score = utility["utility_score"]
        reason = "maximum_information"
        if expected_success < 0.42:
            reason = "stretch"
        elif expected_success > 0.78:
            reason = "fluency_check"
        if review_bonus:
            reason = "recent_gap_review"
        scored.append((
            score,
            {
                "question_id": q.id,
                "q_type": q.q_type,
                "difficulty": q.difficulty,
                "difficulty_estimate": round(float(diff or 3), 3),
                "expected_success": round(expected_success, 4),
                "information_score": round(score, 4),
                "raw_information": round(info, 4),
                "utility_score": utility["utility_score"],
                "zpd_fit": utility["zpd_fit"],
                "reason": reason,
                "source": _source_value(q.source),
                "selector_strategy": selector.get("strategy"),
            },
            q,
        ))
    scored.sort(key=lambda row: (-row[0], row[2].id or 0))
    selected = scored[: max(1, min(count, 25))]
    return {
        "ability": ability,
        "selector": selector,
        "count": len(selected),
        "recommendations": [
            {**meta, "question": serializers.question_test_mode(session, q)}
            for _score, meta, q in selected
        ],
        "guardrails": {
            "source": source,
            "include_recent": include_recent,
            "recent_exclusion_days": 7,
            "answer_key_hidden": True,
        },
    }


def daily_plan(session: Session, *, minutes: int = 60) -> dict[str, Any]:
    matrix = ability_matrix(session, days=180, persist=False)
    selector = matrix["selector"]
    weakest = matrix["weakest"]
    tasks = []
    concept_gap_count = sum(
        1 for c in session.exec(select(SRSCard)).all()
        if c.origin == "concept_gap"
    )
    leech_count = sum(
        1 for c in session.exec(select(SRSCard)).all()
        if c.leech
    )
    if concept_gap_count:
        tasks.append({
            "kind": "concept_gap",
            "label": "Repair concept-gap cards",
            "minutes": min(20, max(8, concept_gap_count * 3)),
            "count": concept_gap_count,
            "utility": _task_utility(selector, "concept_gap"),
            "utility_model": selector.get("utility_model"),
            "why": "missed both timed and Blind Review answers",
        })
    if leech_count:
        tasks.append({
            "kind": "leech",
            "label": "Break leech patterns",
            "minutes": min(20, max(8, leech_count * 4)),
            "count": leech_count,
            "utility": _task_utility(selector, "leech"),
            "utility_model": selector.get("utility_model"),
            "why": "repeated lapses need targeted remediation",
        })
    if weakest:
        primary = weakest[0]
        tasks.append({
            "kind": "adaptive_drill",
            "label": f"Adaptive {primary['q_type']} set",
            "q_type": primary["q_type"],
            "minutes": min(25, max(10, minutes // 3)),
            "count": 8,
            "target_difficulty": selector["zpd"]["target_difficulty"],
            "utility": _task_utility(
                selector,
                "adaptive_drill",
                mastery=float(primary.get("mastery") or 0.5),
                uncertainty=float(primary.get("uncertainty") or 0.0),
            ),
            "utility_model": selector.get("utility_model"),
            "why": "lowest local mastery inside the shared ZPD selector",
        })
    due_cards = session.exec(select(SRSCard)).all()
    due_now = 0
    now = datetime.now(timezone.utc)
    for card in due_cards:
        due_at = _aware(card.due_date)
        if due_at <= now:
            due_now += 1
    if due_now:
        tasks.append({
            "kind": "srs",
            "label": "Review due concept cards",
            "minutes": min(20, max(8, due_now * 2)),
            "count": due_now,
            "utility": _task_utility(selector, "srs"),
            "utility_model": selector.get("utility_model"),
            "why": "due local FSRS cards",
        })
    tasks.append({
        "kind": "blind_review",
        "label": "Write rationales for recent misses",
        "minutes": max(10, minutes - sum(t["minutes"] for t in tasks)),
        "utility": _task_utility(selector, "blind_review"),
        "utility_model": selector.get("utility_model"),
        "why": "turn answers into diagnosis before reading explanations",
    })
    tasks.sort(key=lambda row: (-float(row.get("utility", 0)), row["kind"]))
    return {
        "minutes": minutes,
        "ability": matrix["overall"],
        "ability_selector": selector,
        "weakest": weakest,
        "tasks": tasks,
        "utility_model": _ABILITY_ENGINE_MODEL,
        "utility": selector.get("utility"),
        "concept_gap_count": concept_gap_count,
        "leech_count": leech_count,
        "guardrails": {
            "generated_content_excluded_from_score_prediction": True,
            "official_timed_work_reserved": True,
            "fatigue_guardrail_minutes": min(minutes, 120),
        },
    }


def _active_study_plan(session: Session) -> StudyPlan | None:
    return session.exec(
        select(StudyPlan)
        .where(StudyPlan.active == True)  # noqa: E712
        .order_by(StudyPlan.id.desc())
    ).first()


def _readiness_check(
    *,
    key: str,
    label: str,
    ok: bool,
    detail: str,
    value: Any = None,
    threshold: str | None = None,
    action: str | None = None,
    severity: str = "blocker",
) -> dict[str, Any]:
    return {
        "key": key,
        "label": label,
        "status": "ok" if ok else severity,
        "ok": ok,
        "detail": detail,
        "value": value,
        "threshold": threshold,
        "action": None if ok else action,
    }


def _exam_readiness_simulation(
    *,
    plan: StudyPlan | None,
    forecast: dict[str, Any],
    readiness_score: float,
    ability: dict[str, Any],
    attempts_90d: int,
    br_gap: float,
    due_srs: int,
    pacing_report: dict[str, Any],
    calibration: dict[str, Any],
) -> dict[str, Any]:
    """C8 — explicit exam-day readiness contract over existing local signals."""
    target = plan.target_score if plan else forecast.get("target_score")
    exam_date = plan.exam_date if plan else None
    days_to_exam = forecast.get("days_to_exam")
    projected = forecast.get("projected_score")
    current = forecast.get("current_score")
    trajectory_feasible = forecast.get("trajectory_feasible")
    on_track = forecast.get("on_track")
    triage = pacing_report.get("triage") or {}
    triage_score = triage.get("score")
    cal_gap = calibration.get("calibration_gap")
    cal_verdict = str(calibration.get("verdict") or "unknown")
    mastery = float(ability.get("mastery") or 0.0)
    plateau = bool(ability.get("plateau"))

    checks: list[dict[str, Any]] = []
    has_goal = bool(target and exam_date and days_to_exam is not None and days_to_exam > 0)
    checks.append(_readiness_check(
        key="goal",
        label="Dated goal",
        ok=has_goal,
        detail=(
            f"Target {target} on {exam_date} ({days_to_exam} days)"
            if has_goal
            else "Set a target score and future exam date"
        ),
        value={"target_score": target, "exam_date": exam_date, "days_to_exam": days_to_exam},
        threshold="target score plus future exam date",
        action="Set a study target with an exam date before treating readiness as final.",
    ))

    forecast_ok = bool(has_goal and on_track is True and trajectory_feasible is not False)
    forecast_watch = bool(has_goal and forecast.get("low_confidence") and projected is not None)
    checks.append(_readiness_check(
        key="forecast",
        label="Forecast to target",
        ok=forecast_ok,
        detail=(
            f"Projected {projected} vs target {target}"
            if projected is not None and target is not None
            else "Forecast needs more official timed evidence"
        ),
        value={
            "current_score": current,
            "projected_score": projected,
            "target_score": target,
            "low_confidence": forecast.get("low_confidence"),
            "trajectory_feasible": trajectory_feasible,
            "required_slope_per_week": forecast.get("required_slope_per_week"),
        },
        threshold="projected score reaches target with feasible slope",
        action="Add official timed sections or adjust the exam target/date until the glide path is feasible.",
        severity="watch" if forecast_watch else "blocker",
    ))

    checks.append(_readiness_check(
        key="mastery",
        label="Ability floor",
        ok=readiness_score >= 78 and mastery >= 0.62,
        detail=f"Readiness {round(readiness_score)} / 100, mastery {round(mastery * 100)}%",
        value={"readiness_score": readiness_score, "mastery": round(mastery, 4)},
        threshold="readiness >= 78 and mastery >= 62%",
        action="Keep the daily plan focused on the weakest ZPD band before test day.",
    ))
    checks.append(_readiness_check(
        key="evidence",
        label="Evidence depth",
        ok=attempts_90d >= 80,
        detail=f"{attempts_90d} practice attempts in the last 90 days",
        value=attempts_90d,
        threshold="80+ attempts in 90 days",
        action="Run timed sections or calibrated drills to reduce readiness uncertainty.",
        severity="watch" if attempts_90d >= 40 else "blocker",
    ))
    checks.append(_readiness_check(
        key="blind_review",
        label="Blind Review control",
        ok=br_gap <= 0.08,
        detail=f"Timed/BR gap {round(br_gap * 100)} pts",
        value=round(br_gap, 4),
        threshold="gap <= 8 pts",
        action="Use Blind Review on recent misses until timing and understanding converge.",
        severity="watch" if br_gap <= 0.14 else "blocker",
    ))
    calibration_ok = cal_verdict != "overconfident" or (
        isinstance(cal_gap, (int, float)) and cal_gap < 0.1
    )
    checks.append(_readiness_check(
        key="calibration",
        label="Confidence calibration",
        ok=calibration_ok and calibration.get("n", 0) >= 8,
        detail=(
            f"{cal_verdict} (gap {cal_gap})"
            if cal_verdict != "unknown"
            else "Not enough confidence-rated attempts"
        ),
        value={
            "verdict": cal_verdict,
            "calibration_gap": cal_gap,
            "rated_attempts": calibration.get("n", 0),
        },
        threshold="not overconfident, 8+ rated attempts",
        action="Log confidence before reveal and review sure-but-wrong misses.",
        severity="watch" if cal_verdict == "unknown" or calibration.get("n", 0) < 8 else "blocker",
    ))
    triage_ok = isinstance(triage_score, (int, float)) and triage_score >= 70
    checks.append(_readiness_check(
        key="pacing",
        label="Pacing triage",
        ok=triage_ok,
        detail=(
            f"Triage score {triage_score}/100"
            if triage_score is not None
            else "No pacing triage signal yet"
        ),
        value=triage_score,
        threshold="triage score >= 70",
        action="Practice cutting losses on clock-bleeder questions.",
        severity="watch" if triage_score is None or triage_score >= 55 else "blocker",
    ))
    checks.append(_readiness_check(
        key="srs",
        label="SRS backlog",
        ok=due_srs <= 5,
        detail=f"{due_srs} cards due",
        value=due_srs,
        threshold="<= 5 due cards",
        action="Clear due concept cards before adding more timed volume.",
        severity="watch" if due_srs <= 20 else "blocker",
    ))
    checks.append(_readiness_check(
        key="plateau",
        label="Learning curve",
        ok=not (plateau and mastery < 0.75),
        detail=(
            "Plateau detected below mastery target"
            if plateau and mastery < 0.75
            else "No low-mastery plateau detected"
        ),
        value={"plateau": plateau, "mastery_eta_days": ability.get("mastery_eta_days")},
        threshold="no sub-75% mastery plateau",
        action="Change stimulus mix or review strategy; more of the same is unlikely to move the curve.",
        severity="watch",
    ))

    blockers = [row for row in checks if row["status"] == "blocker"]
    warnings = [row for row in checks if row["status"] == "watch"]
    exam_ready = not blockers and readiness_score >= 78
    if not has_goal:
        status = "setup_needed"
    elif exam_ready:
        status = "ready"
    elif blockers:
        status = "not_ready"
    else:
        status = "at_risk"
    return {
        "model": "exam_readiness_v1",
        "exam_ready": exam_ready,
        "status": status,
        "target_score": target,
        "exam_date": exam_date,
        "horizon_days": days_to_exam,
        "current_score": current,
        "projected_score": projected,
        "readiness_score": readiness_score,
        "checks": checks,
        "blockers": blockers,
        "warnings": warnings,
        "summary": (
            "Exam-ready on current evidence."
            if exam_ready
            else f"{len(blockers)} blocker(s), {len(warnings)} watch item(s)"
        ),
    }


def readiness(session: Session, *, section_type: SectionType | None = None,
              days: int | None = None, persist: bool = True) -> dict[str, Any]:
    ability_days = days if days is not None else 180
    evidence_days = days if days is not None else 90
    ability = ability_estimate(session, section_type=section_type, days=ability_days)
    selector = selector_from_ability(session, ability, days=ability_days)
    by_type = analytics.by_type(session, source="all", days=evidence_days)
    if section_type:
        by_type = [r for r in by_type if r.get("section_type") == section_type.value]
    attempts = sum(int(r.get("attempts", 0)) for r in by_type)
    acc_vals = [float(r["accuracy"]) for r in by_type if r.get("attempts", 0)]
    accuracy = sum(acc_vals) / len(acc_vals) if acc_vals else None
    gap = analytics.blind_review_gap(session, days=evidence_days)
    br_component = 1.0 - min(0.35, max(0.0, float(gap.get("gap") or 0.0))) / 0.35
    evidence_component = min(1.0, attempts / 120)
    mastery_component = float(ability["mastery"])
    acc_component = accuracy if accuracy is not None else mastery_component
    # `srs` has no public due-card helper; keep a cheap local count.
    now = datetime.now(timezone.utc)
    due = sum(
        1 for c in session.exec(select(SRSCard)).all()
        if _aware(c.due_date) <= now
    )
    srs_component = 1.0 if due <= 5 else max(0.0, 1.0 - (due - 5) / 40)
    score = round(100 * (
        0.34 * mastery_component
        + 0.28 * acc_component
        + 0.18 * br_component
        + 0.14 * evidence_component
        + 0.06 * srs_component
    ), 1)
    status = "ready" if score >= 78 else "building" if score >= 55 else "needs_foundation"
    plan = _active_study_plan(session)
    fc = analytics.forecast(
        session,
        exam_date=plan.exam_date if plan else None,
        target_score=plan.target_score if plan else None,
        days=days,
    )
    target = fc.get("target_score")
    current = fc.get("current_score")
    gap_to_target = (
        int(target) - int(current)
        if target is not None and current is not None else None
    )
    days_to_exam = fc.get("days_to_exam")
    required_weekly_slope = None
    if gap_to_target is not None and days_to_exam and days_to_exam > 0:
        required_weekly_slope = round(gap_to_target / max(1.0, days_to_exam / 7.0), 3)
    velocity = ability.get("learning_velocity") or {}
    pacing_report = analytics.pacing(session, days=evidence_days)
    calibration = analytics.confidence_calibration(session, days=evidence_days)
    exam_simulation = _exam_readiness_simulation(
        plan=plan,
        forecast=fc,
        readiness_score=score,
        ability=ability,
        attempts_90d=attempts,
        br_gap=float(gap.get("gap") or 0.0),
        due_srs=due,
        pacing_report=pacing_report,
        calibration=calibration,
    )
    payload = {
        "section_type": section_type.value if section_type else None,
        "readiness_score": score,
        "status": status,
        "on_track": bool(score >= 70) if attempts else None,
        "exam_ready": exam_simulation["exam_ready"],
        "predicted_scaled_score": fc.get("current_score"),
        "mastery_eta_days": ability.get("mastery_eta_days"),
        "plateau": bool(ability.get("plateau")),
        "required_weekly_slope": required_weekly_slope,
        "components": {
            "mastery": round(mastery_component, 4),
            "accuracy": round(acc_component, 4) if acc_component is not None else None,
            "blind_review_control": round(br_component, 4),
            "evidence": round(evidence_component, 4),
            "srs_load": round(srs_component, 4),
            "attempts_90d": attempts,
            "evidence_days": evidence_days,
            "ability_days": ability_days,
            "due_srs": due,
            "learning_velocity": velocity,
            "gap_to_target": gap_to_target,
            "days_to_exam": days_to_exam,
            "official_score_anchor_only": True,
            "generated_content_excluded": True,
            "zpd_target_difficulty": selector["zpd"]["target_difficulty"],
            "ability_selector_model": selector["model"],
            "utility_model": selector.get("utility_model"),
            "utility_score": (selector.get("utility") or {}).get("score"),
            "exam_ready": exam_simulation["exam_ready"],
            "exam_simulation_status": exam_simulation["status"],
        },
        "ability": ability,
        "ability_selector": selector,
        "utility": selector.get("utility"),
        "exam_simulation": exam_simulation,
    }
    if persist:
        snap = ReadinessSnapshot(
            section_type=section_type,
            readiness_score=score,
            predicted_scaled_score=fc.get("current_score"),
            status=status,
            on_track=payload["on_track"],
            components_json=payload["components"],
        )
        session.add(snap)
        session.commit()
        session.refresh(snap)
        payload["snapshot_id"] = snap.id
        payload["created_at"] = snap.created_at.isoformat()
    return payload


def save_rationale(
    session: Session,
    *,
    attempt_id: int,
    stage: str,
    answer: str | None,
    confidence: Confidence | None,
    rationale_text: str,
    trap_guess: str | None = None,
) -> AttemptRationale:
    attempt = session.get(Attempt, attempt_id)
    if attempt is None:
        raise ValueError("attempt_not_found")
    row = AttemptRationale(
        attempt_id=attempt_id,
        question_id=attempt.question_id,
        stage=stage,
        answer=answer,
        confidence=confidence,
        rationale_text=rationale_text,
        trap_guess=trap_guess,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def why_loop_state(session: Session, *, attempt_id: int,
                   reveal: bool = False) -> dict[str, Any]:
    """State machine for the Socratic Blind Review loop."""
    attempt = session.get(Attempt, attempt_id)
    if attempt is None:
        raise ValueError("attempt_not_found")
    q = session.get(Question, attempt.question_id)
    rationales = session.exec(
        select(AttemptRationale)
        .where(AttemptRationale.attempt_id == attempt_id)
        .order_by(AttemptRationale.id)
    ).all()
    conversations = session.exec(
        select(QuestionConversation)
        .where(QuestionConversation.attempt_id == attempt_id)
        .order_by(QuestionConversation.updated_at.desc())
    ).all()
    latest = rationales[-1] if rationales else None
    has_revision = any(r.stage == "revision" for r in rationales)
    steps = [
        {
            "key": "prediction",
            "complete": attempt.chosen_answer is not None,
            "value": attempt.chosen_answer,
        },
        {
            "key": "confidence",
            "complete": attempt.confidence is not None,
            "value": attempt.confidence.value if attempt.confidence else None,
        },
        {
            "key": "written_rationale",
            "complete": latest is not None and bool(latest.rationale_text.strip()),
            "value": latest.rationale_text if latest else None,
        },
        {
            "key": "trap_guess",
            "complete": latest is not None and bool(latest.trap_guess),
            "value": latest.trap_guess if latest else None,
        },
        {
            "key": "socratic_hint",
            "complete": any(c.mode == "socratic" for c in conversations),
            "value": conversations[0].id if conversations else None,
        },
        {
            "key": "revised_answer",
            "complete": has_revision or attempt.br_answer is not None,
            "value": attempt.br_answer if attempt.br_answer is not None else (
                latest.answer if has_revision and latest else None
            ),
        },
        {
            "key": "reveal_contrast",
            "complete": reveal,
            "value": {
                "timed_answer": attempt.chosen_answer,
                "blind_review_answer": attempt.br_answer,
                "correct_answer": q.correct_answer if reveal and q else None,
            } if reveal else None,
        },
    ]
    next_step = next((s["key"] for s in steps if not s["complete"]), "explanation")
    return {
        "attempt_id": attempt_id,
        "question_id": attempt.question_id,
        "q_type": q.q_type if q else None,
        "mode": "socratic_blind_review",
        "answer_key_hidden": not reveal,
        "next_step": next_step,
        "steps": steps,
        "rationales": [
            {
                "id": r.id,
                "stage": r.stage,
                "answer": r.answer,
                "confidence": r.confidence.value if r.confidence else None,
                "trap_guess": r.trap_guess,
                "created_at": r.created_at.isoformat(),
            }
            for r in rationales
        ],
        "local_evidence": {
            "prior_miss": not attempt.is_correct,
            "blind_review_correct": attempt.br_correct,
            "conversation_count": len(conversations),
            "rationale_count": len(rationales),
        },
    }


def create_concept_gap_cards_from_rationale(
    session: Session,
    *,
    attempt_id: int,
) -> dict[str, Any]:
    """Generate local SRS remediation from a missed attempt rationale."""
    attempt = session.get(Attempt, attempt_id)
    if attempt is None:
        raise ValueError("attempt_not_found")
    rationale = _latest_rationale(session, attempt_id)
    if attempt.is_correct and attempt.br_correct is not False:
        return {"created": 0, "skipped": 1, "reason": "attempt_not_a_gap"}
    if rationale is None:
        return {"created": 0, "skipped": 1, "reason": "missing_rationale"}
    origin = "concept_gap"
    if rationale.trap_guess:
        origin = "trap_recognition"
    card, created = srs.ensure_card(
        session,
        attempt.question_id,
        origin=origin,
        commit=True,
    )
    return {
        "created": 1 if created else 0,
        "skipped": 0 if created else 1,
        "origin": card.origin,
        "card_id": card.id,
        "reason": "created_from_rationale" if created else "card_already_exists",
    }


def start_conversation(
    session: Session,
    *,
    question_id: int,
    attempt_id: int | None = None,
    title: str | None = None,
    mode: str = "socratic",
) -> QuestionConversation:
    q = session.get(Question, question_id)
    if q is None:
        raise ValueError("question_not_found")
    if attempt_id is not None and session.get(Attempt, attempt_id) is None:
        raise ValueError("attempt_not_found")
    conv = QuestionConversation(
        question_id=question_id,
        attempt_id=attempt_id,
        mode=mode,
        title=title or f"{q.q_type} tutor loop",
    )
    session.add(conv)
    session.commit()
    session.refresh(conv)
    return conv


def _latest_rationale(session: Session, attempt_id: int | None) -> AttemptRationale | None:
    if attempt_id is None:
        return None
    return session.exec(
        select(AttemptRationale)
        .where(AttemptRationale.attempt_id == attempt_id)
        .order_by(AttemptRationale.id.desc())
    ).first()


def _excerpt(text: str | None, *, limit: int = 160) -> str:
    compact = " ".join((text or "").split())
    if len(compact) <= limit:
        return compact
    return compact[: max(0, limit - 1)].rstrip() + "..."


def _recent_turn_context(
    session: Session,
    conversation_id: int | None,
    *,
    limit: int = 4,
) -> tuple[int, list[dict[str, Any]]]:
    if conversation_id is None:
        return 0, []
    rows = session.exec(
        select(TutorTurn)
        .where(TutorTurn.conversation_id == conversation_id)
        .order_by(TutorTurn.id)
    ).all()
    return len(rows), [
        {
            "role": row.role,
            "content": _excerpt(row.content, limit=140),
        }
        for row in rows[-max(1, limit):]
    ]


def _latest_rationale_for_attempt(
    session: Session,
    attempt_id: int | None,
) -> AttemptRationale | None:
    if attempt_id is None:
        return None
    return session.exec(
        select(AttemptRationale)
        .where(AttemptRationale.attempt_id == attempt_id)
        .order_by(AttemptRationale.id.desc())
    ).first()


def _cached_similarity_scores(
    session: Session,
    question_id: int,
    candidate_ids: set[int],
) -> dict[int, float]:
    """Score against cached question vectors without triggering embedding calls."""
    if not candidate_ids:
        return {}
    try:
        vectors = embeddings._question_vectors(session)
        target = vectors.get(question_id)
        if not target:
            return {}
        out: dict[int, float] = {}
        for qid in candidate_ids:
            vec = vectors.get(qid)
            if not vec:
                continue
            score = embeddings.cosine(target, vec)
            if score > 0:
                out[qid] = round(float(score), 4)
        return out
    except Exception:
        return {}


def _question_context(
    session: Session,
    conv: QuestionConversation,
    *,
    rationale: AttemptRationale | None = None,
) -> dict[str, Any]:
    q = session.get(Question, conv.question_id)
    if q is None:
        return {
            "question_id": conv.question_id,
            "attempt_id": conv.attempt_id,
        }

    section_type = _section_type_for(session, q).value
    attempt = session.get(Attempt, conv.attempt_id) if conv.attempt_id else None
    passage = session.get(Passage, q.passage_id) if q.passage_id else None
    selected_answer = (
        rationale.answer
        if rationale is not None and rationale.answer
        else attempt.chosen_answer if attempt is not None else None
    )
    return {
        "question_id": q.id,
        "attempt_id": conv.attempt_id,
        "q_type": q.q_type,
        "section_type": section_type,
        "stem_excerpt": _excerpt(q.stem, limit=220),
        "prompt_excerpt": _excerpt(q.prompt, limit=220),
        "selected_answer": selected_answer,
        "trap_guess": rationale.trap_guess if rationale else None,
        "passage_id": q.passage_id,
        "passage_topic": passage.topic if passage else None,
        "passage_excerpt": _excerpt(passage.text, limit=420) if passage else None,
    }


def _normalise_trap_miss(record: dict[str, Any]) -> dict[str, Any]:
    out = dict(record)
    if out.get("trap_guess") is None and out.get("trap_type"):
        out["trap_guess"] = out.get("trap_type")
    if out.get("rationale_excerpt") is None and out.get("note_excerpt"):
        out["rationale_excerpt"] = out.get("note_excerpt")
    if out.get("missed_at") is None and out.get("created_at"):
        out["missed_at"] = out.get("created_at")
    out.setdefault("source", "trap_similar")
    return out


def _trap_similar_miss_evidence(
    session: Session,
    conv: QuestionConversation,
    *,
    rationale: AttemptRationale | None = None,
    limit: int = 3,
) -> list[dict[str, Any]]:
    trap_type = rationale.trap_guess if rationale and rationale.trap_guess else None
    if not trap_type:
        return []
    attempt = session.get(Attempt, conv.attempt_id) if conv.attempt_id else None
    chosen_answer = (
        rationale.answer
        if rationale is not None and rationale.answer
        else attempt.chosen_answer if attempt is not None else None
    )
    try:
        rows = embeddings.trap_similar_misses_for_question(
            session,
            conv.question_id,
            chosen_answer=chosen_answer,
            trap_type=trap_type,
            limit=limit,
        )
    except Exception:
        rows = []
    return [_normalise_trap_miss(row) for row in rows]


def _semantic_similar_miss_evidence(
    session: Session,
    conv: QuestionConversation,
    *,
    limit: int = 3,
) -> list[dict[str, Any]]:
    q = session.get(Question, conv.question_id)
    q_type = q.q_type if q else None
    miss_rows = session.exec(
        select(Attempt)
        .where(Attempt.is_correct == False)  # noqa: E712
        .where(Attempt.question_id != conv.question_id)
        .order_by(Attempt.id.desc())
        .limit(40)
    ).all()
    candidate_ids = {row.question_id for row in miss_rows}
    scores = _cached_similarity_scores(session, conv.question_id, candidate_ids)

    ranked: list[tuple[int, float, int, dict[str, Any]]] = []
    seen: set[int] = set()
    for attempt in miss_rows:
        if attempt.question_id in seen:
            continue
        seen.add(attempt.question_id)
        missed_q = session.get(Question, attempt.question_id)
        if missed_q is None:
            continue
        same_type = bool(q_type and missed_q.q_type == q_type)
        similarity = scores.get(attempt.question_id)
        if not same_type and similarity is None:
            continue
        rationale = _latest_rationale_for_attempt(session, attempt.id)
        matched_by = "semantic" if similarity is not None else "q_type"
        record = {
            "attempt_id": attempt.id,
            "question_id": missed_q.id,
            "q_type": missed_q.q_type,
            "matched_by": matched_by,
            "similarity": similarity,
            "trap_guess": rationale.trap_guess if rationale else None,
            "rationale_excerpt": _excerpt(
                rationale.rationale_text if rationale else None,
                limit=180,
            ),
            "missed_at": attempt.created_at.isoformat(),
            "source": "semantic_history",
        }
        ranked.append((
            1 if similarity is not None else 0,
            float(similarity or 0.0),
            int(attempt.id or 0),
            record,
        ))

    ranked.sort(key=lambda row: (row[0], row[1], row[2]), reverse=True)
    return [record for *_rank, record in ranked[: max(1, limit)]]


def _similar_miss_evidence(
    session: Session,
    conv: QuestionConversation,
    *,
    rationale: AttemptRationale | None = None,
    limit: int = 3,
) -> list[dict[str, Any]]:
    trap_matches = _trap_similar_miss_evidence(
        session,
        conv,
        rationale=rationale,
        limit=limit,
    )
    fallback_matches = _semantic_similar_miss_evidence(session, conv, limit=limit)
    out: list[dict[str, Any]] = []
    seen: set[int] = set()
    for record in [*trap_matches, *fallback_matches]:
        qid = record.get("question_id")
        if qid in seen:
            continue
        if isinstance(qid, int):
            seen.add(qid)
        out.append(record)
        if len(out) >= max(1, limit):
            break
    return out


def _socratic_context(
    session: Session,
    conv: QuestionConversation,
) -> dict[str, Any]:
    prior_turn_count, recent_turns = _recent_turn_context(session, conv.id)
    rationale = _latest_rationale(session, conv.attempt_id)
    question_context = _question_context(session, conv, rationale=rationale)
    similar_misses = _similar_miss_evidence(session, conv, rationale=rationale)
    q = session.get(Question, conv.question_id)
    try:
        notebook_context = notebook_os.study_context_for_targets(
            session,
            question_ids=[conv.question_id],
            q_types=[q.q_type] if q is not None and q.q_type else [],
            labels=[conv.title],
            limit=4,
        )
    except Exception:
        notebook_context = {"count": 0, "notes": [], "items": [], "refs": []}
    return {
        "answer_key_hidden": True,
        "prior_turn_count": prior_turn_count,
        "recent_turns": recent_turns,
        "question_context": question_context,
        "similar_misses": similar_misses,
        "notebook_context": notebook_context,
    }


def _socratic_reply(session: Session, conv: QuestionConversation,
                    user_text: str,
                    context: dict[str, Any] | None = None) -> str:
    q = session.get(Question, conv.question_id)
    rationale = _latest_rationale(session, conv.attempt_id)
    q_type = q.q_type if q else "this question"
    trap = rationale.trap_guess if rationale and rationale.trap_guess else None
    context = context or {}
    similar = (context.get("similar_misses") or [])
    recent_turns = (context.get("recent_turns") or [])
    previous_user = next(
        (
            row.get("content")
            for row in reversed(recent_turns)
            if row.get("role") == "user" and row.get("content")
        ),
        None,
    )
    similar_clause = ""
    if similar:
        first = similar[0]
        miss_type = first.get("q_type") or "question"
        miss_trap = first.get("trap_guess") or first.get("trap_type")
        trap_phrase = f" where the trap looked like {miss_trap}" if miss_trap else ""
        similar_clause = (
            f" This resembles a recent {miss_type} miss{trap_phrase}; compare "
            "the exact wording that made the old answer attractive before you "
            "commit here."
        )
    question_context = context.get("question_context") or {}
    rc_clause = ""
    if question_context.get("section_type") == SectionType.RC.value:
        rc_clause = (
            " For RC, anchor the move to the passage role or line of support "
            "before judging the answer."
        )
    notebook_clause = ""
    notebook_items = ((context.get("notebook_context") or {}).get("items") or [])
    if notebook_items:
        title = notebook_items[0].get("title")
        if title:
            notebook_clause = (
                f" Also compare your move with your Notebook note '{title}' "
                "before deciding."
            )
    previous_clause = ""
    if previous_user:
        previous_clause = (
            f" Keep your earlier frame ('{previous_user}') in view, but make it "
            "testable against the stimulus."
        )
    if trap:
        return (
            f"Before revealing anything, test the {trap} possibility: "
            f"which exact words in the stimulus make your choice necessary, not "
            f"merely attractive? For {q_type}, name the conclusion, the support, "
            f"and the gap in one sentence.{similar_clause}{rc_clause}"
            f"{notebook_clause}{previous_clause}"
        )
    if "why" in user_text.lower() or "stuck" in user_text.lower():
        return (
            f"For {q_type}, slow the move down: what must be true if the credited "
            f"choice is right, and what would still be unresolved if it were wrong?"
            f"{similar_clause}{rc_clause}{notebook_clause}{previous_clause}"
        )
    return (
        f"Good. Now make it falsifiable: write the shortest reason your current "
        f"answer could be wrong, then compare that reason against the stimulus."
        f"{similar_clause}{rc_clause}{notebook_clause}{previous_clause}"
    )


def add_tutor_turn(
    session: Session,
    *,
    conversation_id: int,
    role: str,
    content: str,
    auto_reply: bool = True,
) -> dict[str, Any]:
    conv = session.get(QuestionConversation, conversation_id)
    if conv is None:
        raise ValueError("conversation_not_found")
    socratic_context = (
        _socratic_context(session, conv)
        if auto_reply and role == "user"
        else None
    )
    turn = TutorTurn(
        conversation_id=conversation_id,
        role=role,
        content=content,
        meta_json={"local_only": True},
    )
    session.add(turn)
    conv.updated_at = datetime.now(timezone.utc)
    session.add(conv)
    reply = None
    if auto_reply and role == "user":
        reply = TutorTurn(
            conversation_id=conversation_id,
            role="assistant",
            content=_socratic_reply(
                session,
                conv,
                content,
                context=socratic_context,
            ),
            meta_json={
                "local_only": True,
                "model": "deterministic_socratic_v2",
                "socratic_context": socratic_context,
            },
        )
        session.add(reply)
    session.commit()
    session.refresh(turn)
    if reply is not None:
        session.refresh(reply)
    return {
        "turn": _turn_payload(turn),
        "reply": _turn_payload(reply) if reply is not None else None,
    }


def conversation_payload(session: Session, conv: QuestionConversation) -> dict[str, Any]:
    turns = session.exec(
        select(TutorTurn)
        .where(TutorTurn.conversation_id == conv.id)
        .order_by(TutorTurn.id)
    ).all()
    return {
        "id": conv.id,
        "question_id": conv.question_id,
        "attempt_id": conv.attempt_id,
        "mode": conv.mode,
        "title": conv.title,
        "created_at": conv.created_at.isoformat(),
        "updated_at": conv.updated_at.isoformat(),
        "turns": [_turn_payload(t) for t in turns],
    }


def _turn_payload(turn: TutorTurn | None) -> dict[str, Any] | None:
    if turn is None:
        return None
    return {
        "id": turn.id,
        "conversation_id": turn.conversation_id,
        "role": turn.role,
        "content": turn.content,
        "meta": turn.meta_json or {},
        "created_at": turn.created_at.isoformat(),
    }
