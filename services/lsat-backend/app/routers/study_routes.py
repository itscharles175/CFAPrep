"""Study plan + daily plan endpoints (goal-driven studying).

Also hosts the DATA-4a read-only cross-domain progress feed
(``POST /api/sync/progress-updates``): the HOST plane (CFA/Quant/Excel, Dexie)
pushes its review/attempt/mastery snapshots — already projected onto the
canonical cross-domain shapes (mirrors ``src/lib/dataDictionary.ts`` /
``serializers.cross_domain_*``) — and the backend UPSERTS them idempotently for
the LSAT ability/plan engine to read later (LEARN-1/LEARN-3). Strictly host ->
backend: the backend never mutates host data.
"""
from __future__ import annotations

import hashlib
import json
from datetime import date
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from .. import study_plan
from ..db import get_session
from ..models import ActivityEvent, HostProgressSnapshot, utcnow

router = APIRouter(prefix="/study")

# DATA-4a — the host -> backend cross-domain progress feed lives under its own
# /sync prefix (registered alongside `router` in main.py). Kept in this module
# (rather than a new file) so the study/plan + cross-domain-feed surface stays
# co-located for the ability/plan engine that consumes both.
sync_router = APIRouter(prefix="/sync")

# Snapshot kinds the host may push. "lsat" is intentionally NOT an accepted
# plane here — this feed is host -> backend only; LSAT-native progress already
# lives in SRSCard/Attempt and is never round-tripped through this table.
_SNAPSHOT_KINDS = {"review", "attempt", "mastery"}
_HOST_PLANES = {"cfa", "quant", "excel"}


class PlanBody(BaseModel):
    target_score: int = 165
    exam_date: Optional[str] = None     # ISO date "YYYY-MM-DD"
    daily_minutes: int = 60


class TodayFeedbackBody(BaseModel):
    task_id: str = Field(min_length=1, max_length=120)
    task_type: str = Field(default="", max_length=80)
    task_label: str = Field(default="", max_length=240)
    action: Literal["complete", "reopen", "skip"]
    client_day: Optional[str] = Field(default=None, max_length=20)
    minutes: Optional[float] = None
    q_type: Optional[str] = Field(default=None, max_length=80)
    utility_score: Optional[float] = None
    utility_model: Optional[str] = Field(default=None, max_length=120)
    target_difficulty: Optional[float] = None
    tradeoffs: list[str] = Field(default_factory=list)


def _plan_dict(p) -> dict:
    if p is None:
        return {"has_plan": False}
    return {
        "has_plan": True,
        "target_score": p.target_score,
        "exam_date": p.exam_date,
        "daily_minutes": p.daily_minutes,
    }


@router.get("/plan")
def get_plan(session: Session = Depends(get_session)):
    return _plan_dict(study_plan.get_active_plan(session))


@router.put("/plan")
def put_plan(body: PlanBody, session: Session = Depends(get_session)):
    p = study_plan.upsert_plan(
        session, target_score=body.target_score,
        exam_date=body.exam_date, daily_minutes=body.daily_minutes,
    )
    return _plan_dict(p)


@router.get("/today")
def today(session: Session = Depends(get_session)):
    """Today's concrete plan: due reviews + drills on weakest types + forecast."""
    return study_plan.daily_plan(session)


def _activity_payload(row: ActivityEvent) -> dict:
    return {
        "id": row.id,
        "kind": row.kind,
        "status": row.status,
        "title": row.title,
        "detail": row.detail_json,
        "entity": row.entity,
        "entity_id": row.entity_id,
        "progress_pct": row.progress_pct,
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
    }


@router.post("/today/feedback")
def today_feedback(body: TodayFeedbackBody, session: Session = Depends(get_session)):
    """Persist daily-plan task feedback for Ability Engine learning loops."""
    detail = body.model_dump()
    detail["source"] = "today_plan"
    detail["client_day"] = body.client_day or date.today().isoformat()
    row = ActivityEvent(
        kind="daily_plan_task_feedback",
        status="done",
        title=f"{body.action}: {body.task_label or body.task_id}",
        detail_json=detail,
        entity="study_plan",
        entity_id=None,
        progress_pct=100.0,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return _activity_payload(row)


# --- DATA-4a cross-domain progress feed (host -> backend, read-only) --------


class ProgressSnapshotIn(BaseModel):
    """One host snapshot in the canonical cross-domain shape.

    Mirrors the host's ``CrossDomainReviewCard`` / ``CrossDomainAttempt`` /
    ``CrossDomainMastery`` (``src/lib/dataDictionary.ts`` §1-§4) — read
    permissively: only the routing fields (``crossId`` / ``domain`` / ``kind``)
    are required; the rest of the canonical record is carried verbatim in
    ``payload`` so the engine reads the host's exact vocabulary without lossy
    re-projection here.
    """
    cross_id: str = Field(min_length=1, max_length=240, alias="crossId")
    domain: str = Field(min_length=1, max_length=40)
    kind: Literal["review", "attempt", "mastery"]
    observed_at: Optional[str] = Field(default=None, max_length=64, alias="observedAt")
    # The full canonical record (everything beyond the routing fields). Optional:
    # a minimal push (id + domain + kind only) is still a valid, idempotent row.
    payload: dict[str, Any] = Field(default_factory=dict)

    model_config = {"populate_by_name": True}


class ProgressUpdatesBody(BaseModel):
    """A batch of host progress snapshots to UPSERT."""
    snapshots: list[ProgressSnapshotIn] = Field(default_factory=list, max_length=2000)


def _dedupe_key(snap: ProgressSnapshotIn) -> str:
    """Stable content fingerprint of a snapshot for idempotent re-POSTs.

    A re-POST whose canonical record is byte-identical yields the same key, so
    the upsert can recognise an unchanged row as a no-op (the row's
    ``updated_at`` is only bumped when the fingerprint actually changes). The
    payload is dumped with sorted keys so dict ordering never perturbs the hash.
    """
    basis = json.dumps(
        {
            "cross_id": snap.cross_id,
            "kind": snap.kind,
            "domain": snap.domain,
            "observed_at": snap.observed_at,
            "payload": snap.payload,
        },
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()


@sync_router.post("/progress-updates")
def post_progress_updates(body: ProgressUpdatesBody, session: Session = Depends(get_session)):
    """DATA-4a — UPSERT a batch of HOST cross-domain progress snapshots.

    Idempotent by ``cross_id`` (the host's namespaced ``<plane>:<kind>:<nativeId>``):
    a re-POST of the same logical row updates it in place rather than inserting a
    duplicate (UNIQUE index ``ux_hostprogresssnapshot_cross_id``, migration 23).
    An unchanged re-POST (same ``dedupe_key``) is a recognised no-op — the row is
    left untouched, so ``updated_at`` only moves on a genuine change.

    Strictly host -> backend: this NEVER writes back into host data and never
    mutates LSAT-native progress. Snapshots whose ``kind`` is unknown or whose
    ``domain`` is not a host plane (e.g. a stray ``lsat`` row) are skipped rather
    than rejected, so a single bad row never fails an offline-replayed batch.
    """
    upserted = 0
    skipped = 0
    unchanged = 0
    for snap in body.snapshots:
        plane = (snap.domain or "").strip().lower()
        if snap.kind not in _SNAPSHOT_KINDS or plane not in _HOST_PLANES:
            skipped += 1
            continue
        key = _dedupe_key(snap)
        existing = session.exec(
            select(HostProgressSnapshot).where(
                HostProgressSnapshot.cross_id == snap.cross_id
            )
        ).first()
        if existing is None:
            session.add(
                HostProgressSnapshot(
                    cross_id=snap.cross_id,
                    kind=snap.kind,
                    plane=plane,
                    dedupe_key=key,
                    payload=snap.payload,
                    observed_at=snap.observed_at,
                )
            )
            upserted += 1
        elif existing.dedupe_key == key:
            # Byte-identical re-POST — a true no-op (don't bump updated_at).
            unchanged += 1
        else:
            existing.kind = snap.kind
            existing.plane = plane
            existing.dedupe_key = key
            existing.payload = snap.payload
            existing.observed_at = snap.observed_at
            existing.updated_at = utcnow()
            session.add(existing)
            upserted += 1
    session.commit()
    received = len(body.snapshots)
    return {
        "ok": True,
        "received": received,
        "upserted": upserted,
        "unchanged": unchanged,
        "skipped": skipped,
    }
