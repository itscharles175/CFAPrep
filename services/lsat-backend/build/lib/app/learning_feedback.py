"""Daily-plan feedback loops shared by adaptivity, analytics, and study plans."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlmodel import Session, select

from .models import ActivityEvent, Attempt, AttemptMode, Question, QuestionSource

FEEDBACK_WINDOW_DAYS = 28
FEEDBACK_SCORE_LIMIT = 0.08
FEEDBACK_COHORT_WINDOW_DAYS = 90


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _bounded(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _numeric(v: Any, default: float = 0.0) -> float:
    try:
        if v is None:
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def bucket_feedback(events: list[ActivityEvent]) -> dict[str, Any]:
    actions = {"complete": 0, "skip": 0, "reopen": 0}
    minutes_completed = 0.0
    utility_sum = 0.0
    utility_n = 0
    newest: str | None = None
    for row in events:
        detail = row.detail_json if isinstance(row.detail_json, dict) else {}
        action = str(detail.get("action") or "").lower()
        if action not in actions:
            continue
        actions[action] += 1
        row_created = _aware(row.created_at).isoformat()
        if newest is None or row_created > newest:
            newest = row_created
        if action == "complete":
            minutes_completed += _numeric(detail.get("minutes"), 0.0)
        score = detail.get("utility_score")
        if score is not None:
            utility_sum += _numeric(score, 0.0)
            utility_n += 1
    actionable = actions["complete"] + actions["skip"]
    total = sum(actions.values())
    completion_rate = actions["complete"] / max(1, actionable)
    skip_rate = actions["skip"] / max(1, actionable)
    reopen_rate = actions["reopen"] / max(1, total)
    adjustment = _bounded(
        (completion_rate - skip_rate - reopen_rate * 0.35) * FEEDBACK_SCORE_LIMIT,
        -FEEDBACK_SCORE_LIMIT,
        FEEDBACK_SCORE_LIMIT,
    )
    if total == 0:
        status = "no_feedback"
    elif adjustment >= 0.035:
        status = "reinforcing"
    elif adjustment <= -0.025:
        status = "cooling"
    else:
        status = "neutral"
    return {
        "total": total,
        "complete": actions["complete"],
        "skip": actions["skip"],
        "reopen": actions["reopen"],
        "completion_rate": round(completion_rate, 4) if actionable else None,
        "skip_rate": round(skip_rate, 4) if actionable else None,
        "reopen_rate": round(reopen_rate, 4) if total else None,
        "minutes_completed": round(minutes_completed, 1),
        "avg_utility_score": round(utility_sum / utility_n, 4) if utility_n else None,
        "selector_adjustment": round(adjustment, 4),
        "status": status,
        "latest_at": newest,
    }


def _feedback_rows(
    session: Session,
    *,
    days: int | None,
) -> tuple[list[ActivityEvent], int]:
    stmt = (
        select(ActivityEvent)
        .where(ActivityEvent.kind == "daily_plan_task_feedback")
        .order_by(ActivityEvent.id.desc())
    )
    if days:
        stmt = stmt.where(
            ActivityEvent.created_at >= datetime.now(timezone.utc) - timedelta(days=days)
        )
    rows = session.exec(stmt).all()
    filtered: list[ActivityEvent] = []
    for row in rows:
        detail = row.detail_json if isinstance(row.detail_json, dict) else {}
        if str(detail.get("source") or "") != "today_plan":
            continue
        action = str(detail.get("action") or "").lower()
        if action not in {"complete", "skip", "reopen"}:
            continue
        filtered.append(row)
    return filtered, len(rows)


def _group_feedback(
    events: list[ActivityEvent],
) -> tuple[dict[str, list[ActivityEvent]], dict[str, list[ActivityEvent]]]:
    by_task_type: dict[str, list[ActivityEvent]] = {}
    by_q_type: dict[str, list[ActivityEvent]] = {}
    for row in events:
        detail = row.detail_json if isinstance(row.detail_json, dict) else {}
        task_type = str(detail.get("task_type") or "").lower()
        if task_type:
            by_task_type.setdefault(task_type, []).append(row)
        q_type = str(detail.get("q_type") or "")
        if q_type:
            by_q_type.setdefault(q_type, []).append(row)
    return by_task_type, by_q_type


def daily_plan_feedback_summary(
    session: Session,
    *,
    days: int = FEEDBACK_WINDOW_DAYS,
    q_type: str | None = None,
) -> dict[str, Any]:
    """Aggregate utility-ranked task feedback without adding a new schema."""
    filtered, rows_seen = _feedback_rows(session, days=days)
    by_task_type, by_q_type = _group_feedback(filtered)
    summary = bucket_feedback(filtered)
    q_bucket = bucket_feedback(by_q_type.get(str(q_type or ""), [])) if q_type else None
    return {
        "model": "ability_feedback_v1",
        "window_days": days,
        "total_events_seen": rows_seen,
        **summary,
        "q_type": q_type,
        "q_type_summary": q_bucket,
        "by_task_type": {
            key: bucket_feedback(value)
            for key, value in sorted(by_task_type.items())
        },
        "by_q_type": {
            key: bucket_feedback(value)
            for key, value in sorted(by_q_type.items())
        },
    }


def _sequence_hint(bucket: dict[str, Any], multiplier: float) -> str:
    total = int(_numeric(bucket.get("total"), 0.0))
    if total < 2:
        return "thin_signal"
    if multiplier >= 1.05:
        return "sequence_forward"
    if multiplier <= 0.95:
        return "cool_down"
    return "hold_position"


def _sequence_multiplier(bucket: dict[str, Any]) -> float:
    adjustment = _numeric(bucket.get("selector_adjustment"), 0.0)
    return round(_bounded(1.0 + adjustment * 1.5, 0.85, 1.12), 4)


def _question_map(
    session: Session,
    ids: set[int],
) -> dict[int, Question]:
    if not ids:
        return {}
    stmt = select(Question).where(
        Question.id.in_(ids),
        Question.deleted_at.is_(None),
    )
    return {q.id: q for q in session.exec(stmt).all()}


def _accuracy(rows: list[Attempt]) -> float | None:
    if not rows:
        return None
    return round(sum(1 for row in rows if row.is_correct) / len(rows), 4)


def _avg_time_ms(rows: list[Attempt]) -> float | None:
    times = [row.time_ms for row in rows if row.time_ms and row.time_ms > 0]
    if not times:
        return None
    return round(sum(times) / len(times), 1)


def _empty_acceptance_outcome(status: str) -> dict[str, Any]:
    return {
        "model": "ability_feedback_outcomes_v1",
        "status": status,
        "accepted_feedback_events": 0,
        "attempts_after_acceptance": 0,
        "correct_after_acceptance": 0,
        "accuracy_after_acceptance": None,
        "avg_time_ms_after_acceptance": None,
        "baseline_attempts": 0,
        "baseline_accuracy": None,
        "delta_accuracy": None,
        "outcome_window_days": None,
        "min_attempts": None,
        "outcome_min_met": False,
        "baseline_min_met": False,
        "planner_weight_eligible": False,
        "first_accepted_at": None,
        "latest_attempt_at": None,
    }


def _selector_policy(
    bucket: dict[str, Any],
    *,
    days: int | None,
    multiplier: float,
    hint: str,
) -> dict[str, Any]:
    return {
        "model": "ability_feedback_policy_v1",
        "window_days": days,
        "base_multiplier": 1.0,
        "drill_sequence_multiplier": multiplier,
        "selector_adjustment": bucket.get("selector_adjustment"),
        "sequencing_hint": hint,
        "evidence_events": int(_numeric(bucket.get("total"), 0.0)),
        "accepted_events": int(_numeric(bucket.get("complete"), 0.0)),
        "skipped_events": int(_numeric(bucket.get("skip"), 0.0)),
        "status": bucket.get("status"),
    }


def _attempts_by_q_type(
    session: Session,
    *,
    q_types: set[str],
    start_at: datetime | None = None,
    end_at: datetime | None = None,
    source: str = "all",
) -> dict[str, list[Attempt]]:
    if not q_types:
        return {}
    stmt = select(Attempt).where(Attempt.mode != AttemptMode.blind_review)
    if start_at is not None:
        stmt = stmt.where(Attempt.created_at >= start_at)
    if end_at is not None:
        stmt = stmt.where(Attempt.created_at <= end_at)
    attempts = session.exec(stmt).all()
    qmap = _question_map(session, {row.question_id for row in attempts})
    attempts_by_q_type: dict[str, list[Attempt]] = {}
    for row in attempts:
        question = qmap.get(row.question_id)
        if not question or question.q_type not in q_types:
            continue
        if source == "official" and question.source != QuestionSource.official:
            continue
        attempts_by_q_type.setdefault(question.q_type, []).append(row)
    return attempts_by_q_type


def _outcome_comparison(
    candidates: list[Attempt],
    feedback_at: datetime,
    *,
    outcome_days: int | None,
    min_attempts: int,
) -> dict[str, Any]:
    outcome_start = _aware(feedback_at)
    baseline_start = (
        outcome_start - timedelta(days=outcome_days)
        if outcome_days and outcome_days > 0 else None
    )
    outcome_end = (
        outcome_start + timedelta(days=outcome_days)
        if outcome_days and outcome_days > 0 else None
    )
    sorted_candidates = sorted(candidates, key=lambda row: _aware(row.created_at))
    baseline = [
        row
        for row in sorted_candidates
        if _aware(row.created_at) < outcome_start
        and (baseline_start is None or _aware(row.created_at) >= baseline_start)
    ]
    later = [
        row
        for row in sorted_candidates
        if _aware(row.created_at) > outcome_start
        and (outcome_end is None or _aware(row.created_at) <= outcome_end)
    ]
    later_accuracy = _accuracy(later)
    baseline_accuracy = _accuracy(baseline)
    delta = (
        round(later_accuracy - baseline_accuracy, 4)
        if later_accuracy is not None and baseline_accuracy is not None
        else None
    )
    outcome_min_met = len(later) >= min_attempts
    baseline_min_met = len(baseline) >= min_attempts
    planner_weight_eligible = bool(outcome_min_met and baseline_min_met and delta is not None)
    if not later:
        status = "needs_more_attempts"
    elif not outcome_min_met:
        status = "insufficient_outcomes"
    elif not baseline:
        status = "needs_baseline"
    elif not baseline_min_met:
        status = "thin_baseline"
    elif delta is not None and delta >= 0.05:
        status = "improving"
    elif delta is not None and delta <= -0.05:
        status = "watch"
    else:
        status = "stable"
    return {
        "status": status,
        "outcome_attempts": len(later),
        "correct_outcomes": sum(1 for row in later if row.is_correct),
        "outcome_accuracy": later_accuracy,
        "avg_time_ms": _avg_time_ms(later),
        "baseline_attempts": len(baseline),
        "baseline_accuracy": baseline_accuracy,
        "delta_accuracy": delta,
        "outcome_window_days": outcome_days,
        "min_attempts": min_attempts,
        "outcome_min_met": outcome_min_met,
        "baseline_min_met": baseline_min_met,
        "planner_weight_eligible": planner_weight_eligible,
        "latest_attempt_at": _aware(later[-1].created_at).isoformat() if later else None,
    }


def _feedback_outcomes_by_q_type(
    session: Session,
    by_q_type: dict[str, list[ActivityEvent]],
    *,
    days: int | None,
    outcome_days: int | None = None,
    min_attempts: int = 1,
    source: str = "all",
) -> dict[str, dict[str, Any]]:
    anchors: dict[str, list[ActivityEvent]] = {}
    for q_type, events in by_q_type.items():
        accepted = []
        for row in events:
            detail = row.detail_json if isinstance(row.detail_json, dict) else {}
            if str(detail.get("task_type") or "").lower() != "drill":
                continue
            if str(detail.get("action") or "").lower() != "complete":
                continue
            accepted.append(row)
        if accepted:
            anchors[q_type] = accepted

    if not by_q_type:
        return {}

    if not anchors:
        return {
            q_type: _empty_acceptance_outcome("needs_acceptance")
            for q_type in by_q_type
        }

    window_days = days if days and days > 0 else FEEDBACK_COHORT_WINDOW_DAYS
    comparison_days = (
        outcome_days if outcome_days and outcome_days > 0 else window_days
    )
    all_anchor_times = [
        _aware(row.created_at) for rows in anchors.values() for row in rows
    ]
    earliest = min(all_anchor_times)
    latest = max(all_anchor_times)
    attempts_by_q_type = _attempts_by_q_type(
        session,
        q_types=set(by_q_type),
        start_at=earliest - timedelta(days=comparison_days),
        end_at=latest + timedelta(days=comparison_days),
        source=source,
    )

    out: dict[str, dict[str, Any]] = {}
    for q_type in by_q_type:
        accepted = sorted(anchors.get(q_type, []), key=lambda row: _aware(row.created_at))
        if not accepted:
            out[q_type] = _empty_acceptance_outcome("needs_acceptance")
            continue

        first_accepted = _aware(accepted[0].created_at)
        comparison = _outcome_comparison(
            attempts_by_q_type.get(q_type, []),
            first_accepted,
            outcome_days=outcome_days,
            min_attempts=min_attempts,
        )
        out[q_type] = {
            "model": "ability_feedback_outcomes_v1",
            "status": comparison["status"],
            "accepted_feedback_events": len(accepted),
            "attempts_after_acceptance": comparison["outcome_attempts"],
            "correct_after_acceptance": comparison["correct_outcomes"],
            "accuracy_after_acceptance": comparison["outcome_accuracy"],
            "avg_time_ms_after_acceptance": comparison["avg_time_ms"],
            "baseline_attempts": comparison["baseline_attempts"],
            "baseline_accuracy": comparison["baseline_accuracy"],
            "delta_accuracy": comparison["delta_accuracy"],
            "outcome_window_days": outcome_days,
            "min_attempts": min_attempts,
            "outcome_min_met": comparison["outcome_min_met"],
            "baseline_min_met": comparison["baseline_min_met"],
            "planner_weight_eligible": comparison["planner_weight_eligible"],
            "first_accepted_at": first_accepted.isoformat(),
            "latest_attempt_at": comparison["latest_attempt_at"],
        }
    return out


def _overall_outcome_summary(
    q_type_cohorts: list[dict[str, Any]],
) -> dict[str, Any]:
    outcomes = [
        row.get("outcome_evidence")
        for row in q_type_cohorts
        if isinstance(row.get("outcome_evidence"), dict)
    ]
    attempts = sum(int(_numeric(row.get("attempts_after_acceptance"), 0.0)) for row in outcomes)
    correct = sum(int(_numeric(row.get("correct_after_acceptance"), 0.0)) for row in outcomes)
    return {
        "model": "ability_feedback_outcomes_v1",
        "status": "observed" if attempts else "insufficient_data",
        "attempts_after_acceptance": attempts,
        "correct_after_acceptance": correct,
        "accuracy_after_acceptance": round(correct / attempts, 4) if attempts else None,
        "q_types_with_outcomes": sum(
            1 for row in outcomes if _numeric(row.get("attempts_after_acceptance"), 0.0) > 0
        ),
    }


def feedback_outcome_summary(
    session: Session,
    *,
    feedback_days: int | None = FEEDBACK_COHORT_WINDOW_DAYS,
    outcome_days: int = 30,
    source: str = "all",
    min_attempts: int = 3,
) -> dict[str, Any]:
    """Source-filtered post-feedback outcome cohorts for future planner weights."""
    source = "official" if source == "official" else "all"
    outcome_days = max(1, int(outcome_days or 30))
    min_attempts = max(1, int(min_attempts or 1))
    filtered, rows_seen = _feedback_rows(session, days=feedback_days)

    grouped: dict[tuple[str, str], list[ActivityEvent]] = {}
    for row in filtered:
        detail = row.detail_json if isinstance(row.detail_json, dict) else {}
        if str(detail.get("task_type") or "").lower() != "drill":
            continue
        action = str(detail.get("action") or "").lower()
        if action not in {"complete", "skip"}:
            continue
        q_type = str(detail.get("q_type") or "")
        if not q_type:
            continue
        grouped.setdefault((q_type, action), []).append(row)

    q_types = {q_type for q_type, _action in grouped}
    anchor_times = [
        _aware(row.created_at)
        for rows in grouped.values()
        for row in rows
    ]
    attempts_by_q_type: dict[str, list[Attempt]] = {}
    if anchor_times:
        attempts_by_q_type = _attempts_by_q_type(
            session,
            q_types=q_types,
            start_at=min(anchor_times) - timedelta(days=outcome_days),
            end_at=max(anchor_times) + timedelta(days=outcome_days),
            source=source,
        )

    cohorts: list[dict[str, Any]] = []
    for (q_type, action), events in sorted(grouped.items()):
        ordered = sorted(events, key=lambda row: _aware(row.created_at))
        first_feedback = _aware(ordered[0].created_at)
        latest_feedback = _aware(ordered[-1].created_at)
        comparison = _outcome_comparison(
            attempts_by_q_type.get(q_type, []),
            first_feedback,
            outcome_days=outcome_days,
            min_attempts=min_attempts,
        )
        cohorts.append({
            "q_type": q_type,
            "action": action,
            "feedback_events": len(events),
            "first_feedback_at": first_feedback.isoformat(),
            "latest_feedback_at": latest_feedback.isoformat(),
            **comparison,
        })

    cohorts.sort(
        key=lambda row: (
            not bool(row.get("planner_weight_eligible")),
            -_numeric(row.get("delta_accuracy"), -9.0),
            -_numeric(row.get("outcome_attempts"), 0.0),
            str(row.get("q_type") or ""),
            str(row.get("action") or ""),
        )
    )
    planner_ready = [
        row for row in cohorts if bool(row.get("planner_weight_eligible"))
    ]
    best_lift = max(
        planner_ready,
        key=lambda row: _numeric(row.get("delta_accuracy"), -9.0),
        default=None,
    )
    by_q_type: dict[str, dict[str, Any]] = {}
    for row in cohorts:
        q_type = str(row.get("q_type") or "")
        bucket = by_q_type.setdefault(
            q_type,
            {"q_type": q_type, "actions": {}, "planner_weight_eligible": False},
        )
        bucket["actions"][str(row.get("action") or "")] = row
        if row.get("planner_weight_eligible"):
            bucket["planner_weight_eligible"] = True

    return {
        "model": "daily_plan_feedback_outcomes_v1",
        "feedback_window_days": feedback_days,
        "outcome_window_days": outcome_days,
        "source": source,
        "min_attempts": min_attempts,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_feedback_events_seen": rows_seen,
        "qualifying_feedback_events": sum(
            int(_numeric(row.get("feedback_events"), 0.0)) for row in cohorts
        ),
        "cohorts": cohorts,
        "by_q_type": by_q_type,
        "summary": {
            "status": "planner_ready" if planner_ready else (
                "insufficient_data" if cohorts else "no_feedback"
            ),
            "cohort_count": len(cohorts),
            "planner_ready_cohorts": len(planner_ready),
            "best_lift_q_type": best_lift.get("q_type") if best_lift else None,
            "best_lift_action": best_lift.get("action") if best_lift else None,
            "best_lift_delta": best_lift.get("delta_accuracy") if best_lift else None,
        },
    }


def feedback_cohort_summary(
    session: Session,
    *,
    days: int | None = FEEDBACK_COHORT_WINDOW_DAYS,
) -> dict[str, Any]:
    """Longer-window cohorts for accepted/skipped daily-plan work."""
    filtered, rows_seen = _feedback_rows(session, days=days)
    by_task_type, by_q_type = _group_feedback(filtered)
    overall = bucket_feedback(filtered)
    outcomes_by_q_type = _feedback_outcomes_by_q_type(session, by_q_type, days=days)

    q_type_cohorts: list[dict[str, Any]] = []
    for q_type, events in sorted(by_q_type.items()):
        bucket = bucket_feedback(events)
        multiplier = _sequence_multiplier(bucket)
        hint = _sequence_hint(bucket, multiplier)
        q_type_cohorts.append({
            "q_type": q_type,
            **bucket,
            "drill_sequence_multiplier": multiplier,
            "sequencing_hint": hint,
            "rank_score": round(
                _numeric(bucket.get("total"), 0.0)
                * _numeric(bucket.get("completion_rate"), 0.0)
                * multiplier,
                4,
            ),
            "selector_policy": _selector_policy(
                bucket,
                days=days,
                multiplier=multiplier,
                hint=hint,
            ),
            "outcome_evidence": outcomes_by_q_type.get(q_type),
        })
    q_type_cohorts.sort(
        key=lambda row: (
            -_numeric(row.get("rank_score"), 0.0),
            -_numeric(row.get("total"), 0.0),
            str(row.get("q_type") or ""),
        )
    )

    task_type_cohorts = [
        {"task_type": key, **bucket_feedback(value)}
        for key, value in sorted(by_task_type.items())
    ]
    return {
        "model": "daily_plan_feedback_cohorts_v1",
        "window_days": days,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_events_seen": rows_seen,
        **overall,
        "by_task_type": {
            key: bucket_feedback(value)
            for key, value in sorted(by_task_type.items())
        },
        "by_q_type": {
            key: bucket_feedback(value)
            for key, value in sorted(by_q_type.items())
        },
        "outcome_evidence": _overall_outcome_summary(q_type_cohorts),
        "task_type_cohorts": task_type_cohorts,
        "q_type_cohorts": q_type_cohorts,
        "top_q_type": q_type_cohorts[0] if q_type_cohorts else None,
    }
