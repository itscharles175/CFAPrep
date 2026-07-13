"""DATA-4b — cross-domain FSRS write-back engine (host -> backend).

DATA-4a feeds the host plane's review/attempt/mastery snapshots into
``HostProgressSnapshot`` read-only. DATA-4b adds the WRITE side: the host pushes
updated per-card FSRS scheduling state (``POST /api/sync/fsrs-write-back``) and
this module merges each write into the matching mirrored snapshot under a
**last-write-wins** rule, recording every accepted / rejected / deduped write in
the ``CrossDomainSyncLog`` ledger.

Design guarantees (all enforced here, none in the route):

* **Confined to the host's own mirror.** The only mutation target is
  ``HostProgressSnapshot.payload['fsrsState']`` (plus its ``sync_revision`` /
  ``last_write_back_at`` bookkeeping). LSAT-native ``SRSCard`` scheduling is never
  read or written, so a malformed or hostile write-back can't corrupt LSAT
  progress.
* **Idempotent by ``write_id``.** A replayed batch (offline reconnect, double
  submit) re-finds its prior ledger row and is a recognised no-op — never a
  double-apply. The dedupe is a single indexed lookup, not a payload diff.
* **Last-write-wins by ``observed_at``.** When a card already holds a newer
  scheduling state than the incoming write, the stored state is kept and the
  write is logged as ``kept_existing``. Out-of-order replay therefore converges.
* **Bidirectional reconcile in one round-trip.** The result carries the
  authoritative post-merge ``fsrsState`` + ``sync_revision`` per card so the host
  can detect when LWW kept a value other than the one it sent — without the
  backend ever reaching into the host's Dexie store (the reverse backend -> host
  *write* stays deferred).
* **Fully degrading per write.** A write whose target card hasn't been fed via
  DATA-4a yet is logged ``no_target`` and skipped; one bad row never fails the
  batch.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from pydantic import BaseModel, Field
from sqlmodel import Session, select

from .models import CrossDomainSyncLog, HostProgressSnapshot, utcnow

# Host planes a write-back may originate from (parsed from the cross_id prefix).
# "lsat" is intentionally absent: this is host -> backend only, and LSAT-native
# scheduling is never round-tripped through here.
_HOST_PLANES = {"cfa", "quant", "excel"}

# The dedicated slot inside the mirrored snapshot's verbatim payload that the
# write-back owns. Keeping FSRS state under its own key means a write-back never
# clobbers the canonical DATA-4a record's other fields.
FSRS_PAYLOAD_KEY = "fsrsState"


class FsrsWriteIn(BaseModel):
    """One per-card FSRS write-back in the request batch.

    Permissive like the DATA-4a feed: only the routing fields (``writeId`` /
    ``crossId``) are required; ``fsrsState`` is carried verbatim (the backend
    stores it without coercion) and ``observedAt`` drives last-write-wins.
    """

    write_id: str = Field(min_length=1, max_length=160, alias="writeId")
    cross_id: str = Field(min_length=1, max_length=240, alias="crossId")
    # The host's scheduling state for this card (stability/difficulty/due/reps/…),
    # carried verbatim. Opaque to the backend by design.
    fsrs_state: dict[str, Any] = Field(default_factory=dict, alias="fsrsState")
    # When the host observed this state (ISO 8601) — the LWW key. Optional: an
    # undated write still applies unless the stored card has a strictly newer
    # dated state (see ``_incoming_wins``).
    observed_at: Optional[str] = Field(default=None, max_length=64, alias="observedAt")

    model_config = {"populate_by_name": True}


class FsrsWriteBackBody(BaseModel):
    """A batch of per-card FSRS write-backs to apply under last-write-wins."""

    writes: list[FsrsWriteIn] = Field(default_factory=list, max_length=2000)


def _plane_of(cross_id: str) -> str:
    """Parse the originating host plane from a ``<plane>:<kind>:<id>`` cross_id.

    Returns ``""`` when the prefix isn't a recognised host plane, so a stray
    ``lsat:*`` id (which must never round-trip here) is recorded with an empty
    source plane rather than mislabelled.
    """
    head = (cross_id.split(":", 1)[0] if cross_id else "").strip().lower()
    return head if head in _HOST_PLANES else ""


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    """Best-effort ISO 8601 -> aware ``datetime`` for last-write-wins ordering.

    Tolerant of a trailing ``Z`` and naive timestamps (assumed UTC). Returns
    ``None`` when the value is missing or unparseable, so the caller falls back to
    its missing-timestamp policy rather than raising on a malformed row.
    """
    if not value or not isinstance(value, str):
        return None
    raw = value.strip()
    if not raw:
        return None
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _incoming_wins(incoming_observed: Optional[str], existing_observed: Optional[str]) -> bool:
    """Last-write-wins decision: should the incoming write replace the stored state?

    * Both timestamps parse -> the incoming write wins on ``>=`` (a tie applies the
      latest writer, which keeps replay idempotent alongside the ``write_id``
      dedupe).
    * Only the stored side is dated -> keep it (don't let an undated replay clobber
      a known-newer state).
    * Otherwise (neither dated, or only the incoming dated) -> the incoming write
      wins. For a single-user local app the host is the source of truth for its own
      cards, so an undated genuine update should still land.
    """
    pi = _parse_iso(incoming_observed)
    pe = _parse_iso(existing_observed)
    if pi and pe:
        return pi >= pe
    if pe and not pi:
        return False
    return True


def _existing_observed(snap: HostProgressSnapshot) -> Optional[str]:
    """The timestamp LWW compares against for an already-mirrored card.

    This is the *observation* time of the currently-stored state — ``observed_at``
    — which an accepted write-back keeps in step with the write it applied (the
    feed sets it too). It is NOT ``last_write_back_at`` (that is wall-clock apply
    bookkeeping, not the host's observation time), so an out-of-order replay is
    compared against the host's clock, not the backend's.
    """
    return snap.observed_at


def _reconciled(cross_id: str, fsrs_state: dict, sync_revision: int, resolution: str,
                observed_at: Optional[str]) -> dict[str, Any]:
    """Shape one per-card entry of the bidirectional reconcile response."""
    return {
        "crossId": cross_id,
        "fsrsState": fsrs_state,
        "syncRevision": sync_revision,
        "resolution": resolution,
        "observedAt": observed_at,
    }


def apply_fsrs_write_back(session: Session, body: FsrsWriteBackBody) -> dict[str, Any]:
    """Apply a batch of FSRS write-backs and return a per-card reconcile + summary.

    Pure orchestration over the engine rules above — see the module docstring for
    the guarantees. Commits once at the end. Never raises on a bad row: it is
    skipped (``no_target``) and the batch continues, mirroring the DATA-4a feed.
    """
    applied = 0
    kept_existing = 0
    deduped = 0
    no_target = 0
    reconciled: list[dict[str, Any]] = []

    for w in body.writes:
        plane = _plane_of(w.cross_id)

        # 1) Idempotency: a write_id we've already accepted is a recognised no-op.
        prior = session.exec(
            select(CrossDomainSyncLog).where(CrossDomainSyncLog.write_id == w.write_id)
        ).first()
        if prior is not None:
            deduped += 1
            snap = session.exec(
                select(HostProgressSnapshot).where(
                    HostProgressSnapshot.cross_id == w.cross_id
                )
            ).first()
            cur = (snap.payload or {}).get(FSRS_PAYLOAD_KEY, {}) if snap else prior.fsrs_after
            rev = snap.sync_revision if snap else 0
            reconciled.append(
                _reconciled(w.cross_id, cur, rev, "noop_dedupe",
                            snap.observed_at if snap else prior.observed_at)
            )
            continue

        # 2) Resolve the target — must already be a DATA-4a-mirrored card.
        snap = session.exec(
            select(HostProgressSnapshot).where(
                HostProgressSnapshot.cross_id == w.cross_id
            )
        ).first()
        if snap is None:
            no_target += 1
            session.add(
                CrossDomainSyncLog(
                    write_id=w.write_id,
                    cross_id=w.cross_id,
                    source_plane=plane,
                    target_plane="lsat",
                    resolution="no_target",
                    fsrs_before={},
                    fsrs_after={},
                    observed_at=w.observed_at,
                )
            )
            reconciled.append(
                _reconciled(w.cross_id, w.fsrs_state, 0, "no_target", w.observed_at)
            )
            continue

        fsrs_before = dict((snap.payload or {}).get(FSRS_PAYLOAD_KEY, {}) or {})

        # 3) Last-write-wins.
        if _incoming_wins(w.observed_at, _existing_observed(snap)):
            new_payload = dict(snap.payload or {})
            new_payload[FSRS_PAYLOAD_KEY] = w.fsrs_state
            snap.payload = new_payload
            snap.sync_revision = (snap.sync_revision or 0) + 1
            snap.last_write_back_at = utcnow()
            if w.observed_at:
                snap.observed_at = w.observed_at
            snap.updated_at = utcnow()
            session.add(snap)
            resolution = "applied"
            fsrs_after = w.fsrs_state
            applied += 1
        else:
            resolution = "kept_existing"
            fsrs_after = fsrs_before
            kept_existing += 1

        session.add(
            CrossDomainSyncLog(
                write_id=w.write_id,
                cross_id=w.cross_id,
                source_plane=plane,
                target_plane="lsat",
                resolution=resolution,
                fsrs_before=fsrs_before,
                fsrs_after=fsrs_after,
                observed_at=w.observed_at,
            )
        )
        reconciled.append(
            _reconciled(w.cross_id, fsrs_after, snap.sync_revision or 0, resolution,
                        snap.observed_at)
        )

    session.commit()
    return {
        "ok": True,
        "received": len(body.writes),
        "applied": applied,
        "kept_existing": kept_existing,
        "deduped": deduped,
        "no_target": no_target,
        "reconciled": reconciled,
    }
