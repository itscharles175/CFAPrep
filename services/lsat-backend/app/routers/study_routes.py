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
from ..models import (
    ActivityEvent,
    HostProgressSnapshot,
    Question,
    SharedStudyProfile,
    SRSCard,
    StudyPlan,
    utcnow,
)

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
def today(
    include_host: bool = False,
    session: Session = Depends(get_session),
):
    """Today's concrete plan: due reviews + drills on weakest types + forecast.

    LEARN-3 — ``include_host=true`` ALSO folds in the host's weakest-by-ability
    planes (CFA/Quant/Excel, via ``adaptivity.ability_estimate(domain=...)``) as
    ``host_drill`` tasks, reranks the WHOLE list (LSAT + host) by one cross-domain
    utility score, and packs to the merged DATA-6 ``SharedStudyProfile`` budget;
    the response then carries the additive ``include_host`` / ``planes_merged`` /
    ``host_task_count`` / ``budget_source`` / ``cross_domain`` keys. The default
    (``include_host=false``) returns the unchanged LSAT-only body."""
    return study_plan.daily_plan(session, include_host=include_host)


# --- DATA-6 shared study-profile arbiter ------------------------------------
#
# Reconciles the LSAT ``StudyPlan`` (target_score / exam_date / daily_minutes)
# and the host's ``StudyPlanSettings`` (targetLevel / dailyTargetMinutes /
# examDate, in Dexie) into ONE ``SharedStudyProfile`` — the single source of
# truth LEARN-3 (daily plan) and ANL-4 (readiness) consume next.
#
# - ``GET /api/study/profile`` returns the reconciled profile (idempotent; never
#   mutates). It merges the active LSAT ``StudyPlan`` with the persisted
#   ``SharedStudyProfile`` row (host-owned fields), most-recent ``updated_at``
#   winning per scalar — last-write-wins.
# - ``PUT /api/study/profile`` writes it: updates the LSAT ``StudyPlan`` row with
#   the reconciled scalars AND mirrors the full profile (incl. host-owned fields)
#   into the single ``SharedStudyProfile`` row. The host persists its own Dexie
#   copy via the degrading-fetch bridge (``src/lib/studyProfileBridge.ts``).
#
# Conflict policy: last-write-wins by ``updated_at``. The writer stamps a fresh
# ``updated_at``; a GET that reconciles two sides keeps whichever scalar was
# touched most recently. Single-user app: one ``SharedStudyProfile`` row keyed by
# ``"default"`` (UNIQUE index ``ux_sharedstudyprofile_key``, migration 24).

_PROFILE_KEY = "default"
# Sane bounds mirroring the host's ``saveStudyPlanSettings`` clamps so a bad
# write from either side can't poison the shared source of truth.
_DAILY_MIN_MIN = 5
_DAILY_MIN_MAX = 600
_TARGET_SCORE_MIN = 120
_TARGET_SCORE_MAX = 180


class StudyProfileBody(BaseModel):
    """A write to the shared study profile (``PUT /api/study/profile``).

    Every field is optional so either side can write only what it owns: the LSAT
    UI sends the scalars (``target_score`` / ``exam_date`` / ``daily_minutes``);
    the host bridge can additionally send the host-owned ``target_level`` /
    ``rest_days`` / ``mock_cadence_days`` / ``topic_weights``. Unsent fields keep
    their current reconciled value rather than being zeroed.
    """
    target_score: Optional[int] = None
    exam_date: Optional[str] = None          # ISO date "YYYY-MM-DD"
    daily_minutes: Optional[int] = None
    target_level: Optional[str] = None
    rest_days: Optional[list[int]] = None
    mock_cadence_days: Optional[int] = None
    topic_weights: Optional[dict[str, float]] = None
    # Provenance hint for last-write-wins arbitration ("lsat" | "host" | "merge").
    # Informational only — the timestamp decides; defaults to "host" because the
    # bridge is the primary PUT caller.
    last_writer: Optional[str] = None


class SharedStudyProfileOut(BaseModel):
    """The reconciled shared study profile (inline ``response_model``).

    Mirrors the host's ``SharedStudyProfile`` TS type
    (``src/lib/types/StudyProfile.ts``): the reconciled scalars plus the
    host-owned fields, the winning side, and the timestamp the arbiter ordered
    by. ``has_plan`` stays true when an active LSAT ``StudyPlan`` exists (parity
    with ``GET /api/study/plan``)."""
    has_plan: bool = False
    target_score: int = 165
    exam_date: Optional[str] = None
    daily_minutes: int = 60
    target_level: Optional[str] = None
    rest_days: list[int] = Field(default_factory=list)
    mock_cadence_days: Optional[int] = None
    topic_weights: dict[str, float] = Field(default_factory=dict)
    last_writer: str = "merge"
    updated_at: Optional[str] = None


def _as_aware(dt: Optional[datetime]) -> Optional[datetime]:
    """Coerce a naive DB timestamp to UTC-aware for safe comparison."""
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _get_profile_row(session: Session) -> Optional[SharedStudyProfile]:
    return session.exec(
        select(SharedStudyProfile).where(
            SharedStudyProfile.profile_key == _PROFILE_KEY
        )
    ).first()


def _reconcile_profile(
    plan: Optional[StudyPlan], row: Optional[SharedStudyProfile]
) -> SharedStudyProfileOut:
    """Last-write-wins reconciliation of the LSAT ``StudyPlan`` scalars with the
    persisted ``SharedStudyProfile`` row (host-owned fields + mirrored scalars).

    For the three shared scalars, whichever side carries the more recent
    ``updated_at`` wins; host-only fields come from the row. When only one side
    exists, that side is returned verbatim. Pure / read-only — used by both GET
    (idempotent) and PUT (to echo the merged result)."""
    plan_at = _as_aware(getattr(plan, "updated_at", None)) if plan else None
    row_at = _as_aware(getattr(row, "updated_at", None)) if row else None
    # Prefer the side with the newer timestamp for the shared scalars; a missing
    # timestamp loses to a present one. With neither timestamp, the LSAT plan
    # (the historical source) wins for scalars.
    row_wins_scalars = (
        row is not None
        and row_at is not None
        and (plan is None or plan_at is None or row_at >= plan_at)
    )
    if plan is not None and not row_wins_scalars:
        target_score = plan.target_score
        exam_date = plan.exam_date
        daily_minutes = plan.daily_minutes
    elif row is not None:
        target_score = row.target_score
        exam_date = row.exam_date
        daily_minutes = row.daily_minutes
    else:
        target_score, exam_date, daily_minutes = 165, None, 60

    latest = max([t for t in (plan_at, row_at) if t is not None], default=None)
    last_writer = "merge"
    if row is not None and (plan is None or (row_at is not None and (plan_at is None or row_at >= plan_at))):
        last_writer = row.last_writer or "merge"
    elif plan is not None:
        last_writer = "lsat"

    return SharedStudyProfileOut(
        has_plan=plan is not None,
        target_score=target_score,
        exam_date=exam_date,
        daily_minutes=daily_minutes,
        target_level=row.target_level if row else None,
        rest_days=list(row.rest_days) if row and isinstance(row.rest_days, list) else [],
        mock_cadence_days=row.mock_cadence_days if row else None,
        topic_weights=(
            dict(row.topic_weights) if row and isinstance(row.topic_weights, dict) else {}
        ),
        last_writer=last_writer,
        updated_at=latest.isoformat() if latest is not None else None,
    )


@router.get("/profile", response_model=SharedStudyProfileOut)
def get_profile(session: Session = Depends(get_session)) -> SharedStudyProfileOut:
    """DATA-6 — the reconciled shared study profile (idempotent, read-only).

    Merges the active LSAT ``StudyPlan`` with the persisted ``SharedStudyProfile``
    row by last-write-wins (most recent ``updated_at`` wins per shared scalar);
    host-owned fields (target_level / rest_days / mock_cadence_days /
    topic_weights) come from the profile row. Never mutates — two consecutive GETs
    return the identical body. This is the single source of truth LEARN-3 (daily
    plan) and ANL-4 (readiness) read."""
    plan = study_plan.get_active_plan(session)
    row = _get_profile_row(session)
    return _reconcile_profile(plan, row)


@router.put("/profile", response_model=SharedStudyProfileOut)
def put_profile(
    body: StudyProfileBody, session: Session = Depends(get_session)
) -> SharedStudyProfileOut:
    """DATA-6 — write the shared study profile (last-write-wins).

    Updates the active LSAT ``StudyPlan`` row with the reconciled scalars (reusing
    ``study_plan.upsert_plan`` so the single-active-plan invariant holds) AND
    upserts the single ``SharedStudyProfile`` row with the full profile — incl. the
    host-owned fields the ``StudyPlan`` has no column for. The writer stamps a
    fresh ``updated_at`` on both, so a later GET resolves this as the winning
    write. Unsent fields keep their current reconciled value (no zeroing).

    The host persists its own Dexie copy via the degrading-fetch bridge; this PUT
    is the backend half of the dual-write. Backward-compatible: the existing
    ``GET/PUT /api/study/plan`` routes are untouched and keep working."""
    plan = study_plan.get_active_plan(session)
    row = _get_profile_row(session)
    current = _reconcile_profile(plan, row)

    # Merge the patch over the current reconciled view (only sent keys change).
    def _clamp(value: int, lo: int, hi: int) -> int:
        return max(lo, min(hi, value))

    target_score = (
        _clamp(int(body.target_score), _TARGET_SCORE_MIN, _TARGET_SCORE_MAX)
        if body.target_score is not None
        else current.target_score
    )
    daily_minutes = (
        _clamp(int(body.daily_minutes), _DAILY_MIN_MIN, _DAILY_MIN_MAX)
        if body.daily_minutes is not None
        else current.daily_minutes
    )
    exam_date = body.exam_date if body.exam_date is not None else current.exam_date
    target_level = (
        body.target_level if body.target_level is not None else current.target_level
    )
    rest_days = (
        [int(d) for d in body.rest_days if 0 <= int(d) <= 6]
        if body.rest_days is not None
        else current.rest_days
    )
    mock_cadence_days = (
        _clamp(int(body.mock_cadence_days), 1, 90)
        if body.mock_cadence_days is not None
        else current.mock_cadence_days
    )
    topic_weights = (
        {str(k): float(v) for k, v in body.topic_weights.items()}
        if body.topic_weights is not None
        else current.topic_weights
    )
    last_writer = (body.last_writer or "host").strip().lower()
    if last_writer not in {"lsat", "host", "merge"}:
        last_writer = "host"

    now = utcnow()
    # 1) Update the LSAT StudyPlan (single active row) with the reconciled
    # scalars, then stamp its updated_at so the arbiter sees this write.
    plan = study_plan.upsert_plan(
        session,
        target_score=target_score,
        exam_date=exam_date,
        daily_minutes=daily_minutes,
    )
    plan.updated_at = now
    session.add(plan)

    # 2) Upsert the single SharedStudyProfile row (host-owned fields + mirror).
    if row is None:
        row = SharedStudyProfile(profile_key=_PROFILE_KEY, created_at=now)
    row.target_score = target_score
    row.exam_date = exam_date
    row.daily_minutes = daily_minutes
    row.target_level = target_level
    row.rest_days = rest_days
    row.mock_cadence_days = mock_cadence_days
    row.topic_weights = topic_weights
    row.last_writer = last_writer
    row.updated_at = now
    session.add(row)
    session.commit()
    session.refresh(plan)
    session.refresh(row)

    return _reconcile_profile(plan, row)


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
