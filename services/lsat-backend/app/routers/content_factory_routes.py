"""CONTENT-8 — coverage-driven content factory endpoints.

A thin, typed HTTP surface over ``app.content_factory``:

  * ``POST /api/content-factory/plan``      — preview OR enqueue the gated plan.
  * ``POST /api/content-factory/{id}/rollback`` — reverse a batch.
  * ``GET  /api/content-factory/batches``   — recent batches (audit/trust).

The factory targets the LSAT bank only (the cleanest in-bank manifest + the only
plane with the 8-gate generation pipeline wired up). It NEVER bypasses a gate: it
schedules normal Tier-B ``GenJob`` work whose worker runs ``validate_candidate``
on every candidate; weak content fails closed and is quarantined, never served.
Flag-gated (``config.CONTENT_FACTORY_ENABLED``) and fully offline: the preview is
a pure no-write dry run that works with no worker/model running.
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlmodel import Session

from .. import config, content_factory
from ..db import get_session

router = APIRouter(prefix="/content-factory")


class FactoryPlanBody(BaseModel):
    """A request to plan (and optionally enqueue) coverage-driven generation."""

    # Preview-only by default. ``activate=true`` enqueues gated jobs, but ONLY
    # when ``config.CONTENT_FACTORY_ENABLED`` is set — otherwise it still previews
    # (fail-closed: a forgotten flag can't quietly start generating).
    activate: bool = False
    # Optional overrides for the planner's bounds (else config defaults apply).
    coverage_floor: Optional[int] = Field(default=None, ge=1, le=1000)
    max_per_type: Optional[int] = Field(default=None, ge=1, le=50)
    max_types: Optional[int] = Field(default=None, ge=1, le=50)
    # Optional allow-list restricting the plan to specific q_types.
    q_types: Optional[list[str]] = Field(default=None, max_length=100)


class FactoryTarget(BaseModel):
    q_type: str
    servable: int
    anchors: int
    quarantined: int = 0
    coverage_floor: int
    deficit: int
    count: int
    mastery: float
    mastery_lower_bound: float
    weakness: float
    attempts: int = 0
    priority: float
    citations: list[str] = Field(default_factory=list)


class FactorySkip(BaseModel):
    q_type: str
    servable: int = 0
    anchors: int = 0
    deficit: int = 0
    reason: str


class FactoryEnqueuedJob(BaseModel):
    job_id: int
    q_type: str
    count: int
    priority: float


class FactoryPlanResponse(BaseModel):
    """The plan + (when activated) the enqueued, gated batch."""

    provenance: str
    domain: str = "lsat"
    enabled: bool
    coverage_floor: int
    max_per_type: int
    max_types: int
    gate: str
    # The factory NEVER bypasses the generation gates — always False.
    gate_bypassed: bool = False
    targets: list[FactoryTarget] = Field(default_factory=list)
    skipped: list[FactorySkip] = Field(default_factory=list)
    target_count: int = 0
    total_candidates: int = 0
    # Enqueue outcome (False on a dry-run preview or a disabled flag).
    enqueued: bool = False
    reason: Optional[str] = None
    batch_id: Optional[int] = None
    jobs: list[FactoryEnqueuedJob] = Field(default_factory=list)


class FactoryRollbackResponse(BaseModel):
    ok: bool
    batch_id: Optional[int] = None
    jobs_cancelled: int = 0
    jobs_already_terminal: int = 0
    questions_soft_deleted: int = 0
    questions_already_deleted: int = 0
    reason: Optional[str] = None


class FactoryBatch(BaseModel):
    batch_id: int
    status: str
    title: str
    provenance: str
    gate_bypassed: bool = False
    rolled_back: bool = False
    job_ids: list[int] = Field(default_factory=list)
    targets: list[dict[str, Any]] = Field(default_factory=list)
    rollback: Optional[dict[str, Any]] = None
    created_at: str
    updated_at: Optional[str] = None


class FactoryBatchList(BaseModel):
    batches: list[FactoryBatch] = Field(default_factory=list)
    enabled: bool


@router.post("/plan", response_model=FactoryPlanResponse)
def content_factory_plan(
    body: FactoryPlanBody | None = None,
    session: Session = Depends(get_session),
) -> FactoryPlanResponse:
    """Preview (or, with ``activate=true`` + the flag ON, enqueue) the gated plan.

    Without ``activate`` this is a PURE dry run: it ranks coverage deficits by
    thinness x weak-topic analytics, attaches per-target citations, and writes
    nothing — safe offline. With ``activate=true`` AND
    ``config.CONTENT_FACTORY_ENABLED`` it enqueues one gated ``GenJob`` per target
    (the worker runs ``validate_candidate`` on every candidate; no gate is
    skipped) and records a rollback-able provenance batch.
    """
    body = body or FactoryPlanBody()
    if body.activate:
        result = content_factory.run_factory(
            session,
            coverage_floor=body.coverage_floor,
            max_per_type=body.max_per_type,
            max_types=body.max_types,
            q_types=body.q_types,
        )
    else:
        plan = content_factory.plan_factory(
            session,
            coverage_floor=body.coverage_floor,
            max_per_type=body.max_per_type,
            max_types=body.max_types,
            q_types=body.q_types,
        )
        result = {**plan, "enqueued": False, "reason": "preview",
                  "batch_id": None, "jobs": []}
    return FactoryPlanResponse(**result)


@router.post("/{batch_id}/rollback", response_model=FactoryRollbackResponse)
def content_factory_rollback(
    batch_id: int, session: Session = Depends(get_session),
) -> FactoryRollbackResponse:
    """Reverse a factory batch: cancel pending jobs + soft-delete produced items.

    Idempotent: a second call is a clean no-op (already-terminal jobs and
    already-tombstoned questions are counted but left alone)."""
    result = content_factory.rollback_factory(session, batch_id)
    if not result.get("ok") and result.get("reason") == "batch_not_found":
        raise HTTPException(404, "Content factory batch not found")
    return FactoryRollbackResponse(**result)


@router.get("/batches", response_model=FactoryBatchList)
def content_factory_batches(
    limit: int = Query(default=50, ge=1, le=500),
    session: Session = Depends(get_session),
) -> FactoryBatchList:
    """Recent factory batches (newest first) for the trust cockpit / UI."""
    return FactoryBatchList(
        batches=[FactoryBatch(**b) for b in content_factory.list_batches(session, limit=limit)],
        enabled=bool(config.CONTENT_FACTORY_ENABLED),
    )
