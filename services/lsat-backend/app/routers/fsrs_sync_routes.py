"""DATA-4b — cross-domain FSRS write-back routes (host -> backend).

The WRITE complement of the DATA-4a read-only feed (``study_routes.sync_router``).
The host pushes updated per-card FSRS scheduling state and the backend merges it
into the DATA-4a mirror under last-write-wins, logging every write to the
``CrossDomainSyncLog`` ledger. All the rules (idempotency, LWW, no-target
handling, the bidirectional reconcile) live in ``cross_domain_sync``; this module
is the thin HTTP adapter.

Routes (mounted under ``/api`` in ``main.py`` via its own ``/sync`` prefix,
alongside ``study_routes.sync_router``):

* ``POST /api/sync/fsrs-write-back`` — apply a batch of write-backs; returns the
  per-card reconciled authoritative state + a summary.
* ``GET  /api/sync/fsrs-write-back/log`` — read the ledger (optionally for one
  ``cross_id``) for diagnostics / the trust cockpit.
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, Query
from sqlmodel import Session, select

from ..cross_domain_sync import FsrsWriteBackBody, apply_fsrs_write_back
from ..db import get_session
from ..models import CrossDomainSyncLog

# Shares the ``/sync`` prefix with the DATA-4a feed (FastAPI happily mounts two
# routers under the same prefix); kept in its own module so the HIGH-risk
# write-back surface is isolated from the read-only feed.
router = APIRouter(prefix="/sync")


@router.post("/fsrs-write-back")
def post_fsrs_write_back(
    body: FsrsWriteBackBody, session: Session = Depends(get_session)
) -> dict[str, Any]:
    """Apply a batch of cross-domain FSRS write-backs (idempotent, last-write-wins).

    Strictly host -> backend and confined to the DATA-4a mirror — LSAT-native
    ``SRSCard`` scheduling is never touched. Idempotent by ``writeId`` (a replay is
    a no-op) and last-write-wins by ``observedAt`` (a stale out-of-order write is
    kept-existing). The response carries the reconciled authoritative ``fsrsState``
    + ``syncRevision`` per card so the host can reconcile its own store. See
    ``cross_domain_sync`` for the full contract.
    """
    return apply_fsrs_write_back(session, body)


@router.get("/fsrs-write-back/log")
def get_fsrs_write_back_log(
    cross_id: Optional[str] = Query(default=None, max_length=240),
    limit: int = Query(default=100, ge=1, le=1000),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    """Read the write-back ledger (most-recent first), optionally for one card.

    Read-only diagnostics for the trust cockpit / debugging — surfaces how each
    write resolved (applied / kept_existing / noop_dedupe / no_target) without
    exposing any host data the backend doesn't already mirror.
    """
    stmt = select(CrossDomainSyncLog)
    if cross_id:
        stmt = stmt.where(CrossDomainSyncLog.cross_id == cross_id)
    stmt = stmt.order_by(CrossDomainSyncLog.id.desc()).limit(limit)
    rows = session.exec(stmt).all()
    return {
        "ok": True,
        "count": len(rows),
        "entries": [
            {
                "id": r.id,
                "writeId": r.write_id,
                "crossId": r.cross_id,
                "sourcePlane": r.source_plane,
                "targetPlane": r.target_plane,
                "resolution": r.resolution,
                "fsrsBefore": r.fsrs_before,
                "fsrsAfter": r.fsrs_after,
                "observedAt": r.observed_at,
                "createdAt": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ],
    }
