"""CONTENT-8 — coverage-driven content factory (LSAT bank).

Why this exists
---------------
The bank can be *thin* in exactly the q_types a student is *weak* in — the worst
combination, because the drill/SRS engines have nothing real to serve there. The
coach can already backfill ONE type on demand (``POST /api/gen/for-type``), but
nothing turns the WHOLE coverage-deficit + weak-topic picture into a prioritized,
bounded batch of generation work.

This module is that planner. It is deliberately **the LSAT bank only** — the
cleanest existing manifest/schema in the codebase: ``generation.coverage`` gives
per-``q_type`` servable/anchor counts, ``analytics.mastery`` gives an
uncertainty-aware weakness posterior per type, and the existing 8-gate
``generation.validate_candidate`` pipeline already fails closed on weak content.
The host CFA/Quant/Excel planes have no comparable in-bank gate wired up, so we
do not touch them here.

Design (fail-closed, offline, reversible)
-----------------------------------------
1. **Plan** (pure, no writes). ``plan_factory`` ranks types that are BOTH below
   the coverage floor AND weak (low mastery lower-bound), skipping any type with
   no real anchors (we never model AI on AI — docs/00-vision.md). Each target
   gets a bounded candidate count. This is a dry run by default — safe to call
   offline with the flag OFF.
2. **Enqueue** (gated, reversible). ``run_factory`` enqueues a normal Tier-B
   ``GenJob`` per target via ``jobs.enqueue`` — the SAME durable queue whose
   worker runs every candidate through ``validate_candidate``. The factory does
   NOT bypass a single gate; it only *schedules* gated work. A
   ``content_factory`` provenance batch row (an ``ActivityEvent``) records the
   plan + the job ids so the run is auditable and **rollback-able**.
3. **Rollback**. ``rollback_factory`` cancels every still-pending job in a batch
   and soft-deletes (``deleted_at``) any questions those jobs already produced —
   reusing the existing soft-delete tombstone so attempts/SRS FKs stay intact and
   the items simply leave coverage/selection. Idempotent.

Nothing here calls a model directly: the worker does, behind the gate. With no
worker/model running (the offline no-op path) jobs sit ``queued`` and the plan +
provenance + rollback all still work.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from sqlmodel import Session, select

from . import analytics, config, generation, jobs
from .models import ActivityEvent, GenCandidate, GenJob, GenStatus, Question, utcnow

# The provenance batch is recorded as an ActivityEvent of this kind (no new
# table needed — mirrors how study_routes records daily-plan feedback).
FACTORY_BATCH_KIND = "content_factory_batch"
# Provenance / citation tag stamped on every plan + batch so the trust cockpit
# and the rollback path can recognise factory-originated work unambiguously.
PROVENANCE_TAG = "content_factory_v1"


def _coverage_floor(floor: Optional[int]) -> int:
    base = config.CONTENT_FACTORY_COVERAGE_FLOOR if floor is None else int(floor)
    return max(1, base)


def _mastery_by_type(session: Session) -> dict[str, dict]:
    """q_type -> its mastery posterior row (weakest signal for ranking).

    ``analytics.mastery`` returns one row per (q_type, section_type); collapse to
    one row per q_type keeping the WEAKEST (lowest ``lower_bound``) so a type
    that's weak in either section surfaces. Pure / read-only."""
    by_type: dict[str, dict] = {}
    for row in analytics.mastery(session):
        qt = str(row.get("q_type") or "")
        if not qt:
            continue
        prev = by_type.get(qt)
        lb = float(row.get("lower_bound", row.get("mastery", 0.5)))
        if prev is None or lb < float(prev.get("lower_bound", prev.get("mastery", 0.5))):
            by_type[qt] = row
    return by_type


def _deficit_priority(*, deficit: int, floor: int, weakness: float) -> float:
    """Rank a target: how thin (deficit/floor) blended with how weak (1-mastery).

    Both terms are 0..1; weakness is weighted a touch higher so a weak-AND-thin
    type outranks a merely-thin strong one. Returns 0..~1."""
    thinness = max(0.0, min(1.0, deficit / floor))
    return round(0.45 * thinness + 0.55 * max(0.0, min(1.0, weakness)), 4)


def plan_factory(
    session: Session,
    *,
    coverage_floor: Optional[int] = None,
    max_per_type: Optional[int] = None,
    max_types: Optional[int] = None,
    q_types: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Build (but do NOT enqueue) the coverage-driven generation plan.

    A target is a q_type that is BOTH below the coverage floor (a deficit) AND has
    real anchors to generate from. Targets are ranked by a blend of thinness and
    weakness (weak-topic analytics), capped at ``max_types``; each target's
    candidate count is the deficit, clamped to ``max_per_type``. Pure / no writes —
    safe offline and used both as the dry-run preview and as ``run_factory``'s plan.

    ``q_types`` optionally restricts the plan to an explicit allow-list (still
    subject to the deficit + anchor + weakness gating).
    """
    floor = _coverage_floor(coverage_floor)
    per_type_cap = max(1, config.CONTENT_FACTORY_MAX_PER_TYPE
                       if max_per_type is None else int(max_per_type))
    types_cap = max(1, config.CONTENT_FACTORY_MAX_TYPES
                    if max_types is None else int(max_types))
    allow = {str(t) for t in q_types} if q_types else None

    coverage = generation.coverage(session)
    mastery = _mastery_by_type(session)

    targets: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for row in coverage:
        qt = str(row.get("q_type") or "")
        if not qt or qt == "Unknown":
            continue
        if allow is not None and qt not in allow:
            continue
        servable = int(row.get("servable") or 0)
        anchors = int(row.get("anchors") or 0)
        deficit = floor - servable
        if deficit <= 0:
            continue  # already covered
        if anchors <= 0:
            # No real anchor questions — refuse (never model AI on AI).
            skipped.append({
                "q_type": qt, "servable": servable, "anchors": 0,
                "deficit": deficit, "reason": "no_real_anchors",
            })
            continue
        m = mastery.get(qt) or {}
        mastery_val = float(m.get("mastery", 0.5))
        lower_bound = float(m.get("lower_bound", mastery_val))
        attempts = int(m.get("attempts") or 0)
        weakness = round(1.0 - lower_bound, 4)
        count = max(1, min(deficit, per_type_cap))
        targets.append({
            "q_type": qt,
            "servable": servable,
            "anchors": anchors,
            "quarantined": int(row.get("quarantined") or 0),
            "coverage_floor": floor,
            "deficit": deficit,
            "count": count,
            "mastery": round(mastery_val, 4),
            "mastery_lower_bound": round(lower_bound, 4),
            "weakness": weakness,
            "attempts": attempts,
            "priority": _deficit_priority(deficit=deficit, floor=floor,
                                          weakness=weakness),
            # Citation: exactly which signals justified this target. Provenance
            # the trust cockpit/UI can show ("why is this being generated?").
            "citations": [
                f"coverage:{qt} servable={servable} < floor={floor}",
                f"mastery:{qt} lower_bound={round(lower_bound, 3)} "
                f"(n={attempts})",
            ],
        })

    # Weakest+thinnest first; stable secondary sort by q_type for determinism.
    targets.sort(key=lambda t: (-t["priority"], t["q_type"]))
    targets = targets[:types_cap]

    total_candidates = sum(t["count"] for t in targets)
    return {
        "provenance": PROVENANCE_TAG,
        "coverage_floor": floor,
        "max_per_type": per_type_cap,
        "max_types": types_cap,
        "enabled": bool(config.CONTENT_FACTORY_ENABLED),
        "domain": "lsat",
        "targets": targets,
        "skipped": skipped,
        "target_count": len(targets),
        "total_candidates": total_candidates,
        # The gate is NEVER bypassed: enqueued jobs run the full validate_candidate
        # pipeline. Surfaced so the caller/UI can state the guarantee.
        "gate": "validate_candidate",
        "gate_bypassed": False,
    }


def _batch_event(session: Session, batch_id: int) -> Optional[ActivityEvent]:
    row = session.get(ActivityEvent, batch_id)
    if row is None or row.kind != FACTORY_BATCH_KIND:
        return None
    return row


def run_factory(
    session: Session,
    *,
    coverage_floor: Optional[int] = None,
    max_per_type: Optional[int] = None,
    max_types: Optional[int] = None,
    q_types: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Enqueue the gated generation plan and record a rollback-able batch.

    Fail-closed: when ``config.CONTENT_FACTORY_ENABLED`` is OFF this does NOT
    enqueue — it returns the plan with ``enqueued=False`` and a ``disabled``
    reason, so a caller that forgot to flip the flag previews rather than mutates.

    When enabled, one ``GenJob`` is enqueued per target via ``jobs.enqueue`` (the
    SAME durable queue + 8-gate worker the manual path uses — no gate is skipped),
    then a single ``ActivityEvent`` of kind ``content_factory_batch`` records the
    plan + the enqueued job ids so the run is auditable and reversible. With no
    worker running, the jobs sit ``queued``; the gate still runs when the worker
    drains them. Returns the batch id + the job ids.
    """
    plan = plan_factory(
        session,
        coverage_floor=coverage_floor,
        max_per_type=max_per_type,
        max_types=max_types,
        q_types=q_types,
    )
    if not config.CONTENT_FACTORY_ENABLED:
        return {
            **plan,
            "enqueued": False,
            "reason": "content_factory_disabled",
            "batch_id": None,
            "jobs": [],
        }
    if not plan["targets"]:
        return {
            **plan,
            "enqueued": False,
            "reason": "no_coverage_deficits",
            "batch_id": None,
            "jobs": [],
        }

    enqueued: list[dict[str, Any]] = []
    for target in plan["targets"]:
        jid = jobs.enqueue(
            session,
            target["q_type"],
            target["count"],
            status=GenStatus.queued,
            # Low priority so factory backfill never starves a user-requested job.
            priority=-10,
        )
        enqueued.append({
            "job_id": jid,
            "q_type": target["q_type"],
            "count": target["count"],
            "priority": target["priority"],
        })

    now = utcnow()
    detail = {
        "provenance": PROVENANCE_TAG,
        "domain": "lsat",
        "coverage_floor": plan["coverage_floor"],
        "gate": plan["gate"],
        "gate_bypassed": False,
        "targets": plan["targets"],
        "skipped": plan["skipped"],
        "job_ids": [e["job_id"] for e in enqueued],
        "jobs": enqueued,
        "rolled_back": False,
        "created_at": now.isoformat(),
    }
    batch = ActivityEvent(
        kind=FACTORY_BATCH_KIND,
        status="running",
        title=(
            f"Content factory: {len(enqueued)} type(s), "
            f"{plan['total_candidates']} gated candidate(s)"
        ),
        detail_json=detail,
        entity="content_factory",
        entity_id=None,
        progress_pct=0.0,
    )
    session.add(batch)
    session.commit()
    session.refresh(batch)

    return {
        **plan,
        "enqueued": True,
        "reason": None,
        "batch_id": batch.id,
        "jobs": enqueued,
    }


def rollback_factory(session: Session, batch_id: int) -> dict[str, Any]:
    """Reverse a factory batch: cancel pending jobs + soft-delete produced items.

    Idempotent and reversible-by-design:
      * Every job in the batch that is still ``planned``/``queued``/``running`` is
        cancelled via ``jobs.cancel_job`` (the worker honours the cancel flag).
      * Every ``Question`` produced by those jobs (looked up through their
        ``GenCandidate`` rows) is soft-deleted (``deleted_at`` stamped) so it
        leaves coverage/selection while attempt/SRS FKs stay intact — the same
        tombstone the manual retire path uses. Already-tombstoned rows are left
        as-is, so a second rollback call is a clean no-op.

    The batch ``ActivityEvent`` is marked ``rolled_back`` with counts. Returns the
    cancellation + soft-delete tallies."""
    batch = _batch_event(session, batch_id)
    if batch is None:
        return {"ok": False, "reason": "batch_not_found"}

    detail = dict(batch.detail_json or {})
    job_ids = [int(j) for j in (detail.get("job_ids") or [])]

    cancelled = 0
    already_terminal = 0
    for jid in job_ids:
        result = jobs.cancel_job(session, jid)
        if result.get("ok"):
            cancelled += 1
        else:
            already_terminal += 1

    # Soft-delete any questions these jobs already produced (gate-accepted items
    # land in the bank as GenCandidate rows with a question_id).
    soft_deleted = 0
    already_deleted = 0
    if job_ids:
        cand_rows = session.exec(
            select(GenCandidate).where(GenCandidate.gen_job_id.in_(job_ids))
        ).all()
        now = utcnow()
        for cand in cand_rows:
            if cand.question_id is None:
                continue
            q = session.get(Question, cand.question_id)
            if q is None:
                continue
            if q.deleted_at is not None:
                already_deleted += 1
                continue
            q.deleted_at = now
            q.updated_at = now
            session.add(q)
            soft_deleted += 1

    detail["rolled_back"] = True
    detail["rollback"] = {
        "at": utcnow().isoformat(),
        "jobs_cancelled": cancelled,
        "jobs_already_terminal": already_terminal,
        "questions_soft_deleted": soft_deleted,
        "questions_already_deleted": already_deleted,
    }
    batch.detail_json = detail
    batch.status = "rolled_back"
    batch.progress_pct = 100.0
    batch.updated_at = utcnow()
    session.add(batch)
    session.commit()

    return {
        "ok": True,
        "batch_id": batch_id,
        "jobs_cancelled": cancelled,
        "jobs_already_terminal": already_terminal,
        "questions_soft_deleted": soft_deleted,
        "questions_already_deleted": already_deleted,
    }


def list_batches(session: Session, *, limit: int = 50) -> list[dict[str, Any]]:
    """Recent factory batches (newest first) for the trust cockpit / UI."""
    rows = session.exec(
        select(ActivityEvent)
        .where(ActivityEvent.kind == FACTORY_BATCH_KIND)
        .order_by(ActivityEvent.id.desc())
        .limit(max(1, min(int(limit), 500)))
    ).all()
    out: list[dict[str, Any]] = []
    for row in rows:
        detail = row.detail_json or {}
        out.append({
            "batch_id": row.id,
            "status": row.status,
            "title": row.title,
            "provenance": detail.get("provenance", PROVENANCE_TAG),
            "gate_bypassed": bool(detail.get("gate_bypassed", False)),
            "rolled_back": bool(detail.get("rolled_back", False)),
            "job_ids": detail.get("job_ids", []),
            "targets": detail.get("targets", []),
            "rollback": detail.get("rollback"),
            "created_at": row.created_at.isoformat(),
            "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        })
    return out
