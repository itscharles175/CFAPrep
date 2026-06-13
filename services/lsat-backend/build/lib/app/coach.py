"""Scheduled AI-coach diagnosis snapshot.

Why this exists
---------------
docs/01-architecture.md describes the diagnostician as on-demand *and* a nightly
batch feeding the dashboard. Only on-demand existed. This caches a diagnosis
snapshot that the worker refreshes on a schedule, so the dashboard shows a fresh
coach note without a per-load model call. The diagnoser is injectable for tests.
"""
from __future__ import annotations

import threading
from datetime import datetime, timezone
from typing import Callable, Optional

from sqlmodel import Session, select

from . import ai, analytics, config, embeddings, notebook_os
from .models import AttemptRationale, CoachSnapshot, Explanation, SRSCard

# B37: module-level lock prevents concurrent callers from piling up duplicate
# LLM calls for the same refresh. Non-blocking acquire: a second caller that
# cannot acquire returns the latest cached snapshot immediately rather than
# queuing a second model call.
_refresh_lock = threading.Lock()

# 2.5 — thresholds that decide which next-action the coach recommends. Tuned so a
# real backlog (many SRS due) or a clear concept/timing/calibration weakness wins
# over the generic "drill your worst type" default.
_SRS_DUE_RECOMMEND = 5          # this many cards overdue -> push SRS
_BR_GAP_RECOMMEND = 0.12        # BR beats timed by this much -> a timing problem worth a blind-review pass
_OVERCONFIDENT_GAP = 0.1        # stated confidence exceeds accuracy by this -> review calibration


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def latest_snapshot(session: Session) -> Optional[CoachSnapshot]:
    return session.exec(
        select(CoachSnapshot).order_by(CoachSnapshot.id.desc())
    ).first()


def _due_srs_count(session: Session) -> int:
    """How many SRS cards are due now (read-only; doesn't touch srs.py)."""
    now = datetime.now(timezone.utc)
    cards = session.exec(select(SRSCard)).all()
    return sum(1 for c in cards if _aware(c.due_date) <= now)


def _excerpt(text: str | None, *, limit: int = 180) -> str:
    compact = " ".join((text or "").split())
    if len(compact) <= limit:
        return compact
    return compact[: max(0, limit - 1)].rstrip() + "..."


def _enum_value(value) -> str:
    return value.value if hasattr(value, "value") else str(value)


def _coach_explanation_recall(
    session: Session,
    recent: list[dict],
    *,
    limit: int = 5,
) -> list[dict]:
    """Ground coach prompts in prior local explanations and written rationales."""
    out: list[dict] = []
    seen: set[tuple[int, str]] = set()
    for miss in recent:
        qid = miss.get("question_id")
        if not isinstance(qid, int):
            continue

        exp = session.exec(
            select(Explanation)
            .where(Explanation.question_id == qid)
            .order_by(Explanation.id.desc())
        ).first()
        if exp is not None and exp.body.strip():
            key = (qid, "explanation")
            if key not in seen:
                seen.add(key)
                out.append({
                    "question_id": qid,
                    "kind": "explanation",
                    "source": _enum_value(exp.source),
                    "excerpt": _excerpt(exp.body, limit=220),
                    "created_at": exp.created_at.isoformat(),
                })

        rationale = session.exec(
            select(AttemptRationale)
            .where(AttemptRationale.question_id == qid)
            .order_by(AttemptRationale.id.desc())
        ).first()
        if rationale is not None and rationale.rationale_text.strip():
            key = (qid, "rationale")
            if key not in seen:
                seen.add(key)
                out.append({
                    "question_id": qid,
                    "kind": "rationale",
                    "stage": rationale.stage,
                    "trap_guess": rationale.trap_guess,
                    "excerpt": _excerpt(rationale.rationale_text, limit=220),
                    "created_at": rationale.created_at.isoformat(),
                })

        if len(out) >= limit:
            break
    return out[:limit]


def build_coach_context(
    session: Session,
    *,
    recent_misses: int = 5,
    days: int | None = None,
) -> dict:
    """2.5 — a structured, grounded snapshot of the student's state for the coach.

    Pulls from analytics that already exist (we only READ analytics.py) so the
    coach can TUTOR — cite weak types by mastery lower-bound, name specific recent
    missed question_ids (with q_type) it can reference, see the blind-review gap,
    trap susceptibility, the forecast gap / on-track flag, confidence calibration,
    and the SRS backlog. Returns ``{"summary": <prose for the LLM>, ...structured}``
    so both the snapshot recommendation and ``coach_chat`` ground on the same data.
    """
    base = analytics.recent_type_summary(session, days=days)
    by_type = base.get("by_type") or {}

    if not by_type:
        return {
            "has_data": False,
            "summary": "",
            "worst": None,
            "weak_types": [],
            "recent_misses": [],
            "blind_review_gap": None,
            "top_trap": None,
            "forecast": {},
            "calibration": {},
            "srs_due": _due_srs_count(session),
            "trap_similar_misses": [],
            "explanation_recall": [],
            "notebook_context": {"count": 0, "notes": [], "items": [], "refs": []},
            "n": base.get("n", 0),
        }

    mastery = analytics.mastery(session, days=days)    # weakest-first by lower_bound
    weak_types = [
        {"q_type": m["q_type"], "section_type": m["section_type"],
         "mastery": m["mastery"], "lower_bound": m["lower_bound"],
         "attempts": m["attempts"]}
        for m in mastery[:3]
    ]
    worst_type = weak_types[0]["q_type"] if weak_types else base.get("worst")

    br = analytics.blind_review_gap(session, days=days)
    traps = analytics.traps(session, days=days)
    top_trap = next((t for t in traps if t["trap_type"] != "none"), None)
    fc = analytics.forecast(session)
    cal = analytics.confidence_calibration(session, days=days)
    srs_due = _due_srs_count(session)

    # A handful of SPECIFIC recent misses (id + q_type) the coach can point at.
    recent: list[dict] = []
    if worst_type:
        ta = analytics.type_analytics(
            session,
            worst_type,
            days=days,
            recent_misses=recent_misses,
        )
        for m in ta.get("recent_misses", [])[:recent_misses]:
            recent.append({"question_id": m["question_id"], "q_type": worst_type,
                           "chosen_answer": m.get("chosen_answer"),
                           "correct_answer": m.get("correct_answer")})

    trap_similar_misses: list[dict] = []
    seen_trap_matches: set[tuple[int, str]] = set()
    for miss in recent:
        qid = miss.get("question_id")
        if qid is None:
            continue
        try:
            rows = embeddings.trap_similar_misses_for_question(
                session,
                int(qid),
                chosen_answer=miss.get("chosen_answer"),
                limit=3,
            )
        except Exception:
            rows = []
        for row in rows:
            key = (int(row.get("question_id") or 0), str(row.get("trap_type") or ""))
            if key in seen_trap_matches:
                continue
            seen_trap_matches.add(key)
            trap_similar_misses.append(row)
            if len(trap_similar_misses) >= 5:
                break
        if len(trap_similar_misses) >= 5:
            break

    explanation_recall = _coach_explanation_recall(
        session,
        recent,
        limit=5,
    )

    # Build grounding prose for the LLM (extends the flat by-type accuracy summary
    # with the structured signals above).
    lines = [base["summary"]] if base.get("summary") else []
    if weak_types:
        wl = ", ".join(
            f"{w['q_type']} (mastery ~{round(w['mastery'] * 100)}%, "
            f"floor {round(w['lower_bound'] * 100)}%, n={w['attempts']})"
            for w in weak_types
        )
        lines.append(f"Weakest types by reliable mastery: {wl}.")
    if recent:
        rl = ", ".join(
            f"Q{r['question_id']} (chose {r['chosen_answer'] or '?'}, "
            f"correct {r['correct_answer'] or '?'})"
            for r in recent
        )
        lines.append(f"Specific recent {worst_type} misses you can reference: {rl}.")
    if br and br.get("gap") is not None:
        lines.append(
            f"Blind-review gap: timed {round((br['timed_accuracy'] or 0) * 100)}% vs "
            f"blind-review {round((br['br_accuracy'] or 0) * 100)}% "
            f"(gap {round(br['gap'] * 100)} pts -> "
            f"{'timing, not concept' if br['gap'] > 0 else 'concept'} is the bottleneck)."
        )
    if top_trap:
        lines.append(
            f"Most-fallen-for trap: {top_trap['trap_type']} "
            f"({top_trap['times_fell_for']} times, {round(top_trap['pct'] * 100)}% of misses)."
        )
    if trap_similar_misses:
        tm = " | ".join(
            f"Q{m['question_id']} {m['trap_type']}: "
            f"{m.get('note_excerpt') or 'no written note'}"
            for m in trap_similar_misses[:3]
        )
        lines.append(f"Trap-similar miss retrieval: {tm}.")
    if explanation_recall:
        recall = " | ".join(
            f"Q{item['question_id']} {item['kind']}: {item['excerpt']}"
            for item in explanation_recall[:3]
            if item.get("excerpt")
        )
        if recall:
            lines.append(f"Prior explanation/rationale recall: {recall}.")
    if fc.get("projected_score") is not None:
        gap_txt = (f", {abs(fc['gap_to_target'])} pts "
                   f"{'below' if (fc.get('gap_to_target') or 0) > 0 else 'above'} target"
                   if fc.get("gap_to_target") is not None else "")
        lines.append(
            f"Forecast: projected ~{fc['projected_score']}"
            f"{gap_txt}; on_track={fc.get('on_track')}."
        )
    if cal.get("verdict") and cal["verdict"] != "unknown":
        lines.append(
            f"Confidence calibration: {cal['verdict']} "
            f"(gap {cal.get('calibration_gap')})."
        )
    if srs_due:
        lines.append(f"SRS review queue: {srs_due} cards due now.")
    try:
        notebook_context = notebook_os.study_context_for_targets(
            session,
            question_ids=[
                int(row["question_id"])
                for row in recent
                if row.get("question_id")
            ],
            q_types=[row["q_type"] for row in weak_types if row.get("q_type")],
            labels=[f"{worst_type} coach context"] if worst_type else [],
            limit=5,
        )
    except Exception:
        notebook_context = {"count": 0, "notes": [], "items": [], "refs": []}
    if notebook_context.get("notes"):
        lines.append(
            "Notebook context: "
            + " | ".join(str(note) for note in notebook_context["notes"][:3])
        )

    return {
        "has_data": True,
        "summary": "\n".join(lines),
        "worst": worst_type,
        "weak_types": weak_types,
        "recent_misses": recent,
        "blind_review_gap": br,
        "top_trap": top_trap,
        "forecast": fc,
        "calibration": cal,
        "srs_due": srs_due,
        "trap_similar_misses": trap_similar_misses,
        "explanation_recall": explanation_recall,
        "notebook_context": notebook_context,
        "n": base.get("n", 0),
    }


def choose_recommendation(ctx: dict) -> dict:
    """2.5 — pick a VARIED next action from the grounded context (not always
    "Drill {worst}"). Preserves the ``{label, action:{type, payload}}`` shape the
    DockedCoach reads. Priority: clear out a real SRS backlog, then fix a timing
    bottleneck via blind review, then review a calibration gap, else drill the
    weakest type (the sensible default).
    """
    if not ctx.get("has_data"):
        return {"label": "Take a section",
                "action": {"type": "start_section", "payload": {}}}

    srs_due = ctx.get("srs_due") or 0
    if srs_due >= _SRS_DUE_RECOMMEND:
        return {"label": f"Review {srs_due} due cards",
                "action": {"type": "srs", "payload": {"due": srs_due}}}

    br = ctx.get("blind_review_gap") or {}
    if (br.get("gap") or 0) >= _BR_GAP_RECOMMEND:
        worst_gap = (br.get("by_type") or [{}])[0]
        return {
            "label": f"Blind-review your timing on {worst_gap.get('q_type') or ctx['worst']}",
            "action": {"type": "blind_review",
                       "payload": {"q_type": worst_gap.get("q_type") or ctx["worst"]}},
        }

    cal = ctx.get("calibration") or {}
    if cal.get("verdict") == "overconfident" and (cal.get("calibration_gap") or 0) >= _OVERCONFIDENT_GAP:
        return {"label": "Review your confidence calibration",
                "action": {"type": "analytics", "payload": {"view": "calibration"}}}

    # Default: drill the weakest type, optionally aimed at its top trap.
    worst = ctx["worst"]
    payload: dict = {"q_type": worst}
    top_trap = ctx.get("top_trap")
    if top_trap:
        payload["trap_type"] = top_trap["trap_type"]
    return {"label": f"Drill {worst}",
            "action": {"type": "drill", "payload": payload}}


def refresh_snapshot(session: Session, *,
                     diagnoser: Optional[Callable[[str], str]] = None) -> CoachSnapshot:
    # B37: non-blocking mutex so concurrent callers (worker thread + HTTP
    # request) don't pile up duplicate LLM calls. If the lock is already held,
    # return the most-recent cached snapshot; if none exists yet, fall through
    # and wait for the first refresh to complete.
    if not _refresh_lock.acquire(blocking=False):
        cached = latest_snapshot(session)
        if cached is not None:
            return cached
        # No snapshot yet — wait for the in-progress refresh to finish.
        _refresh_lock.acquire(blocking=True)
    try:
        diagnoser = diagnoser or ai.diagnose_sync
        ctx = build_coach_context(session)
        if not ctx["has_data"]:
            text = "No attempts yet. Take a timed section to begin your diagnosis."
            rec = choose_recommendation(ctx)
        else:
            try:
                text = diagnoser(ctx["summary"])
            except Exception:
                text = (f"Your weakest type is {ctx['worst']}. Drill it and use blind "
                        "review to separate timing from concept gaps.")
            rec = choose_recommendation(ctx)
        snap = CoachSnapshot(text=text, recommendation_json=rec)
        session.add(snap)
        session.commit()
        session.refresh(snap)
        return snap
    finally:
        _refresh_lock.release()


def maybe_refresh(engine, *, max_age_s: Optional[float] = None,
                  diagnoser: Optional[Callable[[str], str]] = None) -> bool:
    """Refresh only if there is no snapshot or the latest is stale. Returns
    whether a refresh ran. Called from the worker's idle ticks."""
    max_age_s = max_age_s if max_age_s is not None else config.DIAGNOSIS_MAX_AGE_S
    with Session(engine) as session:
        latest = latest_snapshot(session)
        if latest is not None:
            age = (datetime.now(timezone.utc) - _aware(latest.created_at)).total_seconds()
            if age < max_age_s:
                return False
        refresh_snapshot(session, diagnoser=diagnoser)
        return True
