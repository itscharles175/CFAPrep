"""Study plans: a target score + test date drive a concrete daily plan.

Why this exists
---------------
There was no notion of a goal. The dashboard could say "you're at 158" but not
"you're 7 points from target with 40 days left — here's today." This adds a
StudyPlan and derives a daily plan from it: SRS cards due, the weakest types to
drill, and days remaining. Forecasting (analytics.forecast) sharpens the
"projected on exam day" number.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Optional

from sqlmodel import select
from sqlmodel import Session

from . import adaptivity, analytics, learning_feedback, notebook_os, pedagogy, srs
from .models import HostProgressSnapshot, SharedStudyProfile, SRSCard, StudyPlan

# LEARN-3 — the host study planes whose ability the unified plan folds in. Mirrors
# ``adaptivity._HOST_DOMAINS`` (cfa | quant | excel); host evidence is the DATA-4a
# read-only snapshot mirror, never the host's live Dexie store.
_HOST_PLANES = ("cfa", "quant", "excel")
_PROFILE_KEY = "default"
# A host topic drill is a focused block, same size as an LSAT type drill so the
# merged budget packs uniformly.
_HOST_DRILL_BLOCK_MIN = 12.0


def get_active_plan(session: Session) -> Optional[StudyPlan]:
    return session.exec(
        select(StudyPlan).where(StudyPlan.active == True)  # noqa: E712
        .order_by(StudyPlan.id.desc())
    ).first()


def upsert_plan(session: Session, *, target_score: int,
                exam_date: Optional[str] = None,
                daily_minutes: int = 60) -> StudyPlan:
    """Set the active plan (deactivating any previous one)."""
    for p in session.exec(
        select(StudyPlan).where(StudyPlan.active == True)  # noqa: E712
    ).all():
        p.active = False
        session.add(p)
    plan = StudyPlan(target_score=target_score, exam_date=exam_date,
                     daily_minutes=daily_minutes, active=True)
    session.add(plan)
    session.commit()
    session.refresh(plan)
    return plan


def days_to_exam(exam_date: Optional[str]) -> Optional[int]:
    if not exam_date:
        return None
    try:
        d = date.fromisoformat(exam_date)
    except ValueError:
        return None
    return (d - datetime.now(timezone.utc).date()).days


def _due_count(session: Session) -> int:
    now = datetime.now(timezone.utc)
    n = 0
    for c in session.exec(select(SRSCard)).all():
        cd = c.due_date
        if cd.tzinfo is None:
            cd = cd.replace(tzinfo=timezone.utc)
        if cd <= now:
            n += 1
    return n


# 3.6 — rough per-task time estimates (minutes) used to size the day to the
# plan's daily_minutes budget. SRS is per-card; the rest are per-task blocks.
_MIN_PER_SRS_CARD = 1.0
_MIN_PER_LEECH_CARD = 2.0          # leeches need deliberate remediation, not a flip
_DRILL_BLOCK_MIN = 12.0            # a focused ~5-question type drill
_CONCEPT_GAP_BLOCK_MIN = 10.0      # work the concept-gap queue
_PACING_BLOCK_MIN = 12.0          # a timed pacing drill
_SECTION_MIN = 35.0                # one timed section


def _leech_count(session: Session) -> int:
    return len(srs.leeches(session))


def _intensity(forecast: dict, pacing_weak: bool) -> tuple[str, float, list[str]]:
    """3.6 — scale today's effort from the forecast.

    Returns ``(label, multiplier, rationale_bits)``. A large gap-to-target or a
    behind-pace projection raises intensity (and the minutes budget); being
    comfortably on track lowers it. Low-confidence forecasts nudge UP slightly
    (gather more data) but never to max on noise alone."""
    gap = forecast.get("gap_to_target")
    on_track = forecast.get("on_track")
    low_conf = forecast.get("low_confidence")
    bits: list[str] = []

    score = 0
    if gap is not None:
        if gap >= 7:
            score += 2
            bits.append(f"{gap} pts below target")
        elif gap >= 3:
            score += 1
            bits.append(f"{gap} pts below target")
        elif gap <= 0:
            score -= 1
            bits.append("at or above target")
    if on_track is False:
        score += 1
        bits.append("projected behind on exam day")
    elif on_track is True:
        score -= 1
        bits.append("projected on track")
    if low_conf:
        score += 1
        bits.append("forecast still low-confidence — gather more data")
    if pacing_weak:
        score += 1
        bits.append("pacing/triage needs work")

    if score >= 2:
        return "intense", 1.5, bits
    if score <= -1:
        return "light", 0.75, bits
    return "standard", 1.0, bits


def _weighted_targets(session: Session) -> list[dict]:
    """3.6 — rank types to drill by weakness, frequency, and feedback cohorts.

    Weakness = 1 - mastery (uncertainty-aware posterior, lower-bounded). Leverage =
    how much the type shows up (its attempt share), so a weak-but-rare type doesn't
    outrank a weak-and-common one. Returns the top types with a ``weight`` and the
    fields the existing drill task carries (``q_type``, ``accuracy``)."""
    rows = [r for r in analytics.mastery(session) if r["attempts"] >= 1]
    if not rows:
        return []
    cohorts = learning_feedback.feedback_cohort_summary(session, days=90)
    by_q_type = {
        str(row.get("q_type") or ""): row
        for row in cohorts.get("q_type_cohorts", [])
        if row.get("q_type")
    }
    total_attempts = sum(r["attempts"] for r in rows) or 1
    scored = []
    for r in rows:
        weakness = 1.0 - float(r.get("lower_bound", r.get("mastery", 0.5)))
        leverage = r["attempts"] / total_attempts
        cohort = by_q_type.get(str(r["q_type"])) or {}
        feedback_multiplier = float(cohort.get("drill_sequence_multiplier") or 1.0)
        # Blend frequency in gently (sqrt) so a single dominant type doesn't crowd
        # out genuinely weak rarer types entirely.
        weight = weakness * (0.5 + (leverage ** 0.5)) * feedback_multiplier
        scored.append({
            "q_type": r["q_type"],
            "accuracy": r.get("mastery"),
            "weight": round(weight, 4),
            "weakness": round(weakness, 4),
            "leverage": round(leverage, 4),
            "feedback_sequence_multiplier": round(feedback_multiplier, 4),
            "feedback_cohort": {
                "total": cohort.get("total", 0),
                "completion_rate": cohort.get("completion_rate"),
                "skip_rate": cohort.get("skip_rate"),
                "status": cohort.get("status"),
                "sequencing_hint": cohort.get("sequencing_hint"),
            } if cohort else None,
        })
    return sorted(scored, key=lambda x: -x["weight"])


def _selector_signal(selector: dict, key: str, default: float = 0.0) -> float:
    try:
        return float(((selector.get("utility") or {}).get("signals") or {}).get(key, default))
    except (TypeError, ValueError):
        return default


def _feedback_bucket_for_task(
    selector: dict,
    *,
    kind: str,
    q_type: str | None = None,
) -> dict | None:
    feedback = ((selector.get("utility") or {}).get("feedback") or {})
    if not isinstance(feedback, dict):
        return None
    q_key = str(q_type or "")
    if q_key:
        bucket = (feedback.get("by_q_type") or {}).get(q_key)
        if isinstance(bucket, dict) and bucket.get("total"):
            return bucket
    kind_key = str(kind or "").lower()
    bucket = (feedback.get("by_task_type") or {}).get(kind_key)
    if isinstance(bucket, dict) and bucket.get("total"):
        return bucket
    return feedback if feedback.get("total") else None


def _feedback_adjustment_for_task(
    selector: dict,
    *,
    kind: str,
    q_type: str | None = None,
) -> float:
    bucket = _feedback_bucket_for_task(selector, kind=kind, q_type=q_type)
    if not bucket:
        return 0.0
    try:
        return float(bucket.get("selector_adjustment") or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _feedback_evidence_for_task(selector: dict, task: dict) -> dict | None:
    kind = str(task.get("type") or task.get("kind") or "").lower()
    bucket = _feedback_bucket_for_task(
        selector,
        kind=kind,
        q_type=str(task.get("q_type") or "") or None,
    )
    if not bucket:
        return None
    completion = bucket.get("completion_rate")
    if completion is None:
        label = f"{bucket.get('total', 0)} feedback event(s)"
    else:
        label = f"Accepted {round(float(completion) * 100)}%"
    return {
        "model": "ability_feedback_v1",
        "total": bucket.get("total", 0),
        "complete": bucket.get("complete", 0),
        "skip": bucket.get("skip", 0),
        "reopen": bucket.get("reopen", 0),
        "completion_rate": bucket.get("completion_rate"),
        "skip_rate": bucket.get("skip_rate"),
        "status": bucket.get("status"),
        "selector_adjustment": bucket.get("selector_adjustment"),
        "label": label,
        "impact": ((selector.get("utility") or {}).get("feedback") or {}).get("impact", []),
    }


def _plan_task_utility(
    selector: dict,
    kind: str,
    weight: Optional[float] = None,
    q_type: str | None = None,
) -> float:
    srs_pressure = _selector_signal(selector, "srs_pressure")
    mastery_gap = _selector_signal(selector, "mastery_gap", 0.5)
    uncertainty = _selector_signal(selector, "uncertainty_pressure", 0.5)
    blind_review = _selector_signal(selector, "blind_review_pressure")
    fatigue = _selector_signal(selector, "fatigue_pressure")
    if kind == "srs":
        score = 0.55 + srs_pressure * 0.35
    elif kind == "leech":
        score = 0.66 + srs_pressure * 0.18 + fatigue * 0.08
    elif kind == "concept_gap":
        score = 0.62 + blind_review * 0.28 + mastery_gap * 0.12
    elif kind == "drill":
        weight_bonus = min(0.2, max(0.0, float(weight or 0.0)))
        score = 0.5 + mastery_gap * 0.22 + uncertainty * 0.12 + weight_bonus
    elif kind == "pacing":
        score = 0.54 + fatigue * 0.16
    else:
        score = 0.5
    score += _feedback_adjustment_for_task(selector, kind=kind, q_type=q_type)
    return round(max(0.0, min(1.2, score)), 3)


def _profile_row_exists(session: Session) -> bool:
    """LEARN-3 — whether a DATA-6 ``SharedStudyProfile`` row has been written.

    Pure / read-only. When present, the merged daily plan treats that row as the
    reconciled budget source (``budget_source == "shared_profile"``); otherwise the
    plan's own ``daily_minutes`` drove the budget."""
    return session.exec(
        select(SharedStudyProfile).where(
            SharedStudyProfile.profile_key == _PROFILE_KEY
        )
    ).first() is not None


def _shared_daily_minutes(session: Session, plan: Optional[StudyPlan]) -> Optional[int]:
    """LEARN-3 — the merged daily-minutes budget from the DATA-6 SharedStudyProfile.

    Returns the reconciled budget the host + LSAT agreed on (the
    ``SharedStudyProfile`` row written by ``PUT /api/study/profile``) when it is
    newer than the active LSAT plan, else the plan's own ``daily_minutes``. Pure /
    read-only; falls back to None so the caller keeps the historical default."""
    row = session.exec(
        select(SharedStudyProfile).where(
            SharedStudyProfile.profile_key == _PROFILE_KEY
        )
    ).first()
    if row is None:
        return plan.daily_minutes if plan else None
    plan_at = getattr(plan, "updated_at", None) if plan else None
    row_at = getattr(row, "updated_at", None)
    # Last-write-wins on the shared scalar (parity with the profile arbiter's
    # reconciliation): the row wins when it carries the newer timestamp, or when
    # there is no active plan to compare against.
    if plan is None or plan_at is None or (row_at is not None and row_at >= plan_at):
        return row.daily_minutes
    return plan.daily_minutes


def _host_weakest_topic(session: Session, *, plane: str) -> Optional[dict]:
    """The weakest host topic for one plane, from the DATA-4a mastery snapshots.

    Reads the read-only ``HostProgressSnapshot`` mirror (kind ``"mastery"``, the
    canonical ``CrossDomainMastery`` shape: ``key`` = objective/topic,
    ``masteryFraction`` 0..1). Returns the lowest-mastery topic (weakest-first) with
    a concrete label so a host drill task can name the objective, or None when the
    host has pushed no mastery rows for this plane. Never mutates."""
    rows = session.exec(
        select(HostProgressSnapshot)
        .where(HostProgressSnapshot.plane == plane)
        .where(HostProgressSnapshot.kind == "mastery")
    ).all()
    weakest: Optional[dict] = None
    for row in rows:
        payload = row.payload if isinstance(row.payload, dict) else {}
        key = str(payload.get("key") or "").strip()
        if not key:
            continue
        try:
            mastery = float(payload.get("masteryFraction"))
        except (TypeError, ValueError):
            continue
        attempts = payload.get("attempts")
        try:
            attempts = int(attempts) if attempts is not None else None
        except (TypeError, ValueError):
            attempts = None
        if weakest is None or mastery < weakest["mastery"]:
            weakest = {"key": key, "mastery": mastery, "attempts": attempts}
    return weakest


def _host_drill_candidates(
    session: Session, selector: dict, *, max_planes: int = 3,
) -> list[tuple[dict, float]]:
    """LEARN-3 — host weakest-by-ability drill candidates, one per evidenced plane.

    For each host plane (cfa | quant | excel) calls
    ``adaptivity.ability_estimate(domain=plane)`` (LEARN-1) to score the plane's
    weakness (``1 - mastery``); skips planes with no host evidence. The weakest
    host topic (from the DATA-4a mastery mirror) names the drill when available.
    Each candidate carries the SAME ``utility_score`` vocabulary the LSAT drills do
    (``_plan_task_utility`` with the drill kind, weighted by host weakness) so the
    merged plan can rerank LSAT + host tasks by ONE cross-domain utility. The
    candidates are returned weakest-plane-first with a uniform block estimate; the
    caller reranks the merged list and packs to the budget. Read-only."""
    scored: list[tuple[dict, float, float]] = []  # (task, est_minutes, weakness)
    for plane in _HOST_PLANES:
        ability = adaptivity.ability_estimate(session, domain=plane)
        if int(ability.get("evidence_n") or 0) < 1:
            continue  # no host evidence for this plane — nothing to fold in
        mastery = float(ability.get("mastery") or 0.5)
        weakness = round(1.0 - mastery, 4)
        topic = _host_weakest_topic(session, plane=plane)
        topic_key = topic["key"] if topic else None
        if topic_key:
            label = f"Drill {plane.upper()} · {topic_key}"
        else:
            label = f"Drill weakest {plane.upper()} topic"
        task = {
            "type": "host_drill",
            "domain": plane,
            "label": label,
            "topic": topic_key,
            "host_mastery": round(mastery, 4),
            "host_weakness": weakness,
            "host_evidence_n": int(ability.get("evidence_n") or 0),
            "accuracy": ability.get("accuracy"),
            "target_difficulty": (selector.get("zpd") or {}).get("target_difficulty"),
            "selector_strategy": selector.get("strategy"),
            "utility_model": "ability_engine_v2",
            "selector_utility_model": selector.get("utility_model"),
            # Reuse the LSAT drill utility math, weighting by host weakness so a
            # weaker host plane outranks a stronger one in the merged rerank.
            "utility_score": _plan_task_utility(selector, "drill", weakness),
        }
        scored.append((task, _HOST_DRILL_BLOCK_MIN, weakness))
    # Weakest plane first (most productive to drill); the merged rerank below uses
    # utility, but this keeps a stable, intuitive order among equal-utility hosts.
    scored.sort(key=lambda t: -t[2])
    return [(task, est) for task, est, _ in scored[:max_planes]]


def daily_plan(session: Session, *, include_host: bool = False) -> dict:
    """Today's adaptive, closed-loop plan.

    3.6 — reads the forecast to scale intensity, sizes tasks to the plan's
    ``daily_minutes`` budget, weights type targeting by (weakness x frequency), and
    folds in SRS-due, leech remediation, the concept-gap queue, and a pacing item
    when pacing is weak. Existing keys are preserved; ``intensity``,
    ``minutes_budget`` and ``rationale`` are added.

    LEARN-3 — when ``include_host`` is True the plan ALSO folds in the host's
    weakest-by-ability topics (``adaptivity.ability_estimate(domain=cfa|quant|excel)``,
    LEARN-1) as ``host_drill`` candidates, reranks the WHOLE candidate list
    (LSAT + host) by the one cross-domain utility score, and packs to the merged
    ``daily_minutes`` budget read from the DATA-6 ``SharedStudyProfile``. The
    default (``include_host=False``) is byte-for-byte the historical LSAT-only
    plan — no new caller behaviour unless the flag is set."""
    plan = get_active_plan(session)
    dash = analytics.dashboard(session)
    forecast = analytics.forecast(session, exam_date=plan.exam_date if plan else None,
                                  target_score=plan.target_score if plan else None)
    # Preserve the existing weakest_types shape (dashboard's top-3).
    weak = dash.get("weakest_types", [])[:3]
    due = _due_count(session)
    leeches_n = _leech_count(session)
    concept_gap = pedagogy.concept_gap_queue(session)
    pacing_q = pedagogy.pacing_queue(session, limit=50)
    selector = adaptivity.ability_selector(session, days=180)
    selector_target = (selector.get("zpd") or {}).get("target_difficulty")
    selector_strategy = selector.get("strategy")
    selector_utility_model = selector.get("utility_model")
    selector_utility_score = (selector.get("utility") or {}).get("score")

    # Is pacing/triage weak? Use the triage score (lower = worse) plus any
    # outstanding timing-problem queue as the signal.
    pacing = analytics.pacing(session)
    triage_score = (pacing.get("triage") or {}).get("score")
    pacing_weak = bool(pacing_q) or (triage_score is not None and triage_score < 70)

    intensity, mult, rationale_bits = _intensity(forecast, pacing_weak)

    # LEARN-3 — when merging the host plane, size the day to the merged
    # daily_minutes budget from the DATA-6 SharedStudyProfile (the host + LSAT
    # agreed budget); the LSAT-only path keeps the plan's own daily_minutes.
    budget_source = "study_plan"
    if include_host:
        shared_minutes = _shared_daily_minutes(session, plan)
        base_minutes = shared_minutes or (plan.daily_minutes if plan else 60) or 60
        # The shared profile is the budget source whenever a DATA-6 row exists —
        # it is the reconciled single source of truth the merged plan reads (the
        # PUT keeps it and the plan in sync, so a value match isn't a meaningful
        # discriminator). With no row, the plan's own minutes drove the budget.
        if _profile_row_exists(session):
            budget_source = "shared_profile"
    else:
        base_minutes = (plan.daily_minutes if plan else 60) or 60
    minutes_budget = int(round(base_minutes * mult))

    # Build candidate tasks in priority order, each with a rough minute estimate,
    # then pack to the budget. SRS (due) and leech remediation come first (spaced
    # repetition is time-sensitive), then concept-gap, then weighted drills, then
    # a pacing item, then a section as a data-gathering fallback.
    weighted = _weighted_targets(session)
    candidates: list[tuple[dict, float]] = []

    if due:
        srs_min = round(min(due, minutes_budget) * _MIN_PER_SRS_CARD, 1)
        candidates.append((
            {
                "type": "srs",
                "label": f"Review {due} due card(s)",
                "count": due,
                "selector_strategy": selector_strategy,
                "utility_model": "ability_engine_v2",
                "selector_utility_model": selector_utility_model,
                "utility_score": _plan_task_utility(selector, "srs"),
            },
            srs_min,
        ))
    if leeches_n:
        candidates.append((
            {"type": "leech", "label": f"Remediate {leeches_n} leech card(s)",
             "count": leeches_n,
             "selector_strategy": selector_strategy,
             "utility_model": "ability_engine_v2",
             "selector_utility_model": selector_utility_model,
             "utility_score": _plan_task_utility(selector, "leech")},
            round(min(leeches_n, 5) * _MIN_PER_LEECH_CARD, 1),
        ))
    if concept_gap:
        candidates.append((
            {"type": "concept_gap",
             "label": f"Work {len(concept_gap)} concept-gap item(s)",
             "count": len(concept_gap),
             "selector_strategy": selector_strategy,
             "utility_model": "ability_engine_v2",
             "selector_utility_model": selector_utility_model,
             "utility_score": _plan_task_utility(selector, "concept_gap")},
            _CONCEPT_GAP_BLOCK_MIN,
        ))
    # Weighted type drills (fall back to the dashboard's weakest_types if mastery
    # produced nothing). More intense days schedule more drill blocks.
    n_drills = {"light": 1, "standard": 2, "intense": 3}[intensity]
    drill_src = weighted[:n_drills] if weighted else [
        {"q_type": w["q_type"], "accuracy": w["accuracy"], "weight": None}
        for w in weak[:n_drills]
    ]
    for d in drill_src:
        candidates.append((
            {"type": "drill", "label": f"Drill {d['q_type']}",
             "q_type": d["q_type"], "accuracy": d.get("accuracy"),
             "weight": d.get("weight"),
             "target_difficulty": selector_target,
             "selector_strategy": selector_strategy,
             "utility_model": "ability_engine_v2",
             "selector_utility_model": selector_utility_model,
             "utility_score": _plan_task_utility(
                 selector,
                 "drill",
                 d.get("weight"),
                 q_type=str(d.get("q_type") or "") or None,
             )},
            _DRILL_BLOCK_MIN,
        ))
    if pacing_weak and pacing_q:
        candidates.append((
            {"type": "pacing",
             "label": f"Timed pacing drill ({len(pacing_q)} timing-problem item(s))",
             "count": len(pacing_q),
             "target_difficulty": selector_target,
             "selector_strategy": selector_strategy,
             "utility_model": "ability_engine_v2",
             "selector_utility_model": selector_utility_model,
             "utility_score": _plan_task_utility(selector, "pacing")},
            _PACING_BLOCK_MIN,
        ))

    # LEARN-3 — fold in the host's weakest-by-ability planes when asked. Each host
    # candidate already carries the SAME ``utility_score`` vocabulary the LSAT
    # tasks do (``_plan_task_utility`` with the drill kind, weighted by host
    # weakness), so after appending them we rerank the WHOLE candidate list by
    # that one cross-domain utility — the most productive task across LSAT + host
    # surfaces first regardless of which domain it came from. ``include_host=False``
    # skips both the merge and the rerank, so the insertion-ordered LSAT-only path
    # below stays byte-for-byte identical to the historical plan.
    host_candidates: list[tuple[dict, float]] = []
    planes_merged: list[str] = []
    if include_host:
        host_candidates = _host_drill_candidates(session, selector)
        planes_merged = [str(task.get("domain")) for task, _ in host_candidates]
        candidates.extend(host_candidates)
        # Stable rerank by cross-domain utility DESC. ``sorted`` is stable, so
        # equal-utility tasks keep their original insertion order (SRS/leech still
        # lead on ties, host drills keep their weakest-plane-first ordering).
        candidates.sort(key=lambda c: -float(c[0].get("utility_score") or 0.0))

    # Pack to the minutes budget (always keep at least the first/most-urgent task
    # so a tiny budget still produces an actionable plan).
    tasks: list[dict] = []
    spent = 0.0
    for task, est in candidates:
        task = {**task, "est_minutes": round(est, 1)}
        if tasks and spent + est > minutes_budget:
            continue
        tasks.append(task)
        spent += est

    if not tasks:
        tasks.append({"type": "section",
                      "label": "Take a timed section to gather data",
                      "est_minutes": _SECTION_MIN,
                      "target_difficulty": selector_target,
                      "selector_strategy": selector_strategy,
                      "utility_model": "ability_engine_v2",
                      "selector_utility_model": selector_utility_model,
                      "utility_score": _plan_task_utility(selector, "section")})
        spent = _SECTION_MIN

    q_types = sorted({
        str(task.get("q_type"))
        for task in tasks
        if task.get("q_type")
    })
    labels = [str(task.get("label") or "") for task in tasks]
    try:
        notebook_context = notebook_os.study_context_for_targets(
            session, q_types=q_types, labels=labels, limit=6,
        )
    except Exception:
        notebook_context = {"count": 0, "notes": [], "items": [], "refs": []}
    for task in tasks:
        task_context = {"count": 0, "notes": [], "items": [], "refs": []}
        try:
            task_context = notebook_os.study_context_for_targets(
                session,
                q_types=[str(task["q_type"])] if task.get("q_type") else [],
                labels=[str(task.get("label") or "")],
                limit=3,
            )
        except Exception:
            pass
        if task_context.get("count"):
            task["notebook_context"] = task_context
        feedback_evidence = _feedback_evidence_for_task(selector, task)
        if feedback_evidence:
            task["feedback_evidence"] = feedback_evidence

    rationale = (
        f"{intensity.capitalize()} day"
        + (f" — {'; '.join(rationale_bits)}" if rationale_bits else "")
        + f". Budget {minutes_budget} min."
    )

    result = {
        "has_plan": plan is not None,
        "target_score": plan.target_score if plan else None,
        "exam_date": plan.exam_date if plan else None,
        "daily_minutes": plan.daily_minutes if plan else None,
        "days_to_exam": days_to_exam(plan.exam_date) if plan else None,
        "predicted_score": dash.get("predicted_score"),
        "forecast": forecast,
        "due_count": due,
        "weakest_types": weak,
        "tasks": tasks,
        "notebook_context": notebook_context,
        # New (additive, 3.6).
        "intensity": intensity,
        "minutes_budget": minutes_budget,
        "estimated_minutes": round(spent, 1),
        "leech_count": leeches_n,
        "concept_gap_count": len(concept_gap),
        "rationale": rationale,
        "ability_selector": selector,
        "utility_model": "ability_engine_v2",
        "utility": selector.get("utility"),
        "selector_summary": {
            "target_difficulty": selector_target,
            "strategy": selector_strategy,
            "srs_due": (selector.get("srs") or {}).get("due"),
            "utility_model": selector_utility_model,
            "utility_score": selector_utility_score,
            "feedback": ((selector.get("utility") or {}).get("feedback") or None),
        },
    }

    # LEARN-3 — only attach the cross-domain summary when the host plane was
    # merged. ``include_host=False`` returns the historical body untouched (no new
    # keys), so existing LSAT-only callers see no change at all.
    if include_host:
        packed_host = [t for t in tasks if t.get("type") == "host_drill"]
        result["include_host"] = True
        result["planes_merged"] = planes_merged
        result["host_task_count"] = len(packed_host)
        # The cross-domain budget source actually used to size the day (the DATA-6
        # SharedStudyProfile budget when it decided the number, else the LSAT plan).
        result["budget_source"] = budget_source
        result["cross_domain"] = {
            "planes": planes_merged,
            "host_candidate_count": len(host_candidates),
            "host_task_count": len(packed_host),
            "ranking": "cross_domain_utility_desc",
            "utility_model": "ability_engine_v2",
            "base_minutes": int(round(base_minutes)),
        }

    return result
