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
from collections import defaultdict
from datetime import date, datetime, timezone
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from .. import adaptivity, study_plan
from ..db import get_session
from ..models import ActivityEvent, HostProgressSnapshot, Question, SRSCard, utcnow

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


# --- LEARN-2 unified due-today queue (ability-ranked, read-only) ------------
#
# A cross-domain "what's due right now" feed in the canonical
# ``CrossDomainReviewCard`` shape (mirrors ``src/lib/dataDictionary.ts`` §1 /
# ``lsatSrsCardToCanonical``). Server-side this projects the LSAT plane only:
# the host merges its OWN local Dexie queue with these rows client-side (the
# host's local review items never round-trip through the backend), then ranks
# the combined list with one vocabulary. Strictly read-only — no mutations.


class UnifiedDueCard(BaseModel):
    """One LSAT due card on the canonical cross-domain shape.

    Field names + coercion rules mirror the host's ``CrossDomainReviewCard``
    (``src/lib/dataDictionary.ts`` §1-§2) so the host can rank/merge these with
    its own local cards using one vocabulary. ``difficulty`` is the host 3-bucket
    enum (1-2 -> foundation, 3 -> intermediate, 4-5 -> advanced); ``overdueSeconds``
    is the LEARN-2 ranking primary (how long the card has been due).
    """
    crossId: str
    domain: Literal["lsat"] = "lsat"
    questionCrossId: str
    title: str
    difficulty: Literal["foundation", "intermediate", "advanced"]
    empiricalDifficulty: Optional[float] = None
    dueAt: Optional[str] = None
    itemType: Optional[str] = None
    origin: Optional[str] = None
    # LEARN-2 ranking signals (additive to the canonical card; the host can sort
    # by these or fall back to its own when merging the local queue).
    overdueSeconds: float = 0.0
    utilityScore: Optional[float] = None


class UnifiedDueResponse(BaseModel):
    ok: bool = True
    due_count: int = 0
    items: list[UnifiedDueCard] = Field(default_factory=list)
    utility_model: Optional[str] = None
    review_strategy: dict[str, Any] = Field(default_factory=dict)


def _lsat_difficulty_to_host(
    difficulty: float | None,
) -> Literal["foundation", "intermediate", "advanced"]:
    """LSAT int difficulty (1-5) -> host 3-bucket enum.

    Mirrors ``lsatDifficultyToHost`` in ``src/lib/dataDictionary.ts`` §2 exactly:
    out-of-range / non-numeric collapses to the neutral middle; 1-2 -> foundation,
    3 -> intermediate, 4-5 -> advanced (so the host and backend project an LSAT
    card to the same bucket whether it crosses via the sidecar or this route).
    """
    if difficulty is None:
        return "intermediate"
    try:
        d = round(float(difficulty))
    except (TypeError, ValueError):
        return "intermediate"
    d = max(1, min(5, d))
    if d <= 2:
        return "foundation"
    if d >= 4:
        return "advanced"
    return "intermediate"


def _qtype_interleave(
    items: list[tuple[SRSCard, Question, float]],
) -> list[tuple[SRSCard, Question, float]]:
    """Round-robin a most-overdue-first list across q_types so the queue never
    serves a long run of one type. Mirrors ``srs_routes._interleave_by_qtype``:
    each q_type's first appearance fixes its slot (its head is its most-overdue
    card, so leading types are the most urgent) and ties break by urgency."""
    buckets: dict[str, list[tuple[SRSCard, Question, float]]] = defaultdict(list)
    order: list[str] = []
    for triple in items:
        qt = triple[1].q_type or "?"
        if qt not in buckets:
            order.append(qt)
        buckets[qt].append(triple)
    out: list[tuple[SRSCard, Question, float]] = []
    while any(buckets[qt] for qt in order):
        for qt in order:
            if buckets[qt]:
                out.append(buckets[qt].pop(0))
    return out


@router.get("/due-unified", response_model=UnifiedDueResponse)
def due_unified(session: Session = Depends(get_session)) -> UnifiedDueResponse:
    """LEARN-2 — cross-domain due queue in the canonical ``CrossDomainReviewCard``
    shape, ability-ranked. Sources LSAT due cards the same way ``GET /api/srs/due``
    does (every SRS card whose ``due_date`` has passed), then orders them by:
      1. ``overdueSeconds`` DESC (most overdue first),
      2. q_type round-robin interleave (no single type dominates a run),
      3. ability-weighted utility DESC (the shared Ability Engine selector's
         utility score, so the most productive reviews surface first).

    The host merges its OWN local Dexie review queue with these rows client-side
    and ranks the combined list — the host's local cards never round-trip through
    the backend, so this projects the LSAT plane only. Strictly read-only."""
    selector = adaptivity.ability_selector(session, days=180)
    utility_score = (selector.get("utility") or {}).get("score")
    now = datetime.now(timezone.utc)
    due_triples: list[tuple[SRSCard, Question, float]] = []
    for card in session.exec(select(SRSCard)).all():
        cd = card.due_date
        if cd.tzinfo is None:
            cd = cd.replace(tzinfo=timezone.utc)
        if cd <= now:
            q = session.get(Question, card.question_id)
            if q is not None and q.deleted_at is None:
                due_triples.append((card, q, (now - cd).total_seconds()))
    # 1. most-overdue first, then 2. interleave across q_types. The ability-
    # weighted utility (3) is a single global selector score this run, so it
    # tie-breaks the whole queue uniformly without disturbing the overdue/qtype
    # ordering; it rides on each row as ``utilityScore`` for the host's merge.
    due_triples.sort(key=lambda t: -t[2])
    ordered = _qtype_interleave(due_triples)
    items: list[UnifiedDueCard] = []
    for card, q, overdue_s in ordered:
        native_id = card.id if card.id is not None else q.id
        items.append(
            UnifiedDueCard(
                crossId=f"lsat:review:{native_id}",
                questionCrossId=f"lsat:question:{q.id}",
                title=_unified_title(q),
                difficulty=_lsat_difficulty_to_host(q.difficulty),
                empiricalDifficulty=(
                    float(q.empirical_difficulty)
                    if q.empirical_difficulty is not None
                    else None
                ),
                dueAt=card.due_date.isoformat() if card.due_date else None,
                itemType=q.q_type,
                origin=card.origin,
                overdueSeconds=round(overdue_s, 3),
                utilityScore=utility_score,
            )
        )
    return UnifiedDueResponse(
        ok=True,
        due_count=len(items),
        items=items,
        utility_model=selector.get("utility_model"),
        review_strategy={
            "ordering": "overdue_interleaved_by_qtype_ability_weighted",
            "selector_strategy": selector.get("strategy"),
            "utility_model": selector.get("utility_model"),
            "utility_score": utility_score,
            "planes": ["lsat"],
            "host_merges_local_queue": True,
        },
    )


def _unified_title(q: Question) -> str:
    """A compact, answer-key-free title for a due card (mirrors the host bridge's
    ``titleFor`` / ``lsatTitleFrom``: collapse whitespace, cap at 80 chars with an
    ellipsis, else a stable ``LSAT item <id>`` fallback)."""
    raw = " ".join((q.stem or q.prompt or "").split()).strip()
    if raw:
        return raw if len(raw) <= 80 else f"{raw[:79]}…"
    return f"LSAT item {q.id}"


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
