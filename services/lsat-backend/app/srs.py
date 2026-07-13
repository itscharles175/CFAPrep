"""Spaced repetition via py-fsrs (package `fsrs`).

We persist the FSRS Card as a dict in SRSCard.fsrs_state and recompute scheduling
through a single module-level Scheduler. Falls back to a minimal scheduler if fsrs
is unavailable for any reason.

3.2 — Personalization
---------------------
A bare ``Scheduler()`` uses stock weights and a fixed 0.9 retention, which throws
away FSRS's main value. We now:

- Build the module Scheduler from a runtime ``desired_retention`` setting
  (``config.SRS_DESIRED_RETENTION``) and from per-user optimized weights when we
  have them (persisted as a ``Setting`` row, key ``fsrs_params``).
- Log every review (``SRSReviewLog``) — that history is what the optimizer needs.
- Optimize the FSRS weights from the user's own log via py-fsrs's ``Optimizer``
  when enough history exists AND the optional optimizer deps (torch/pandas) are
  installed; otherwise fall back gracefully to the current/default weights.
- Flag leeches (too many lapses) for a remediation queue.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from sqlalchemy import func
from sqlmodel import Session, select

from . import config
from .models import HostProgressSnapshot, Setting, SRSCard, SRSReviewLog

try:
    from fsrs import Card, Rating, Scheduler

    _HAVE_FSRS = True
except Exception:  # pragma: no cover - fsrs is a hard dependency, this is defensive
    _HAVE_FSRS = False

# Setting key under which optimized FSRS weights (a JSON list of 21 floats) live.
_PARAMS_SETTING_KEY = "fsrs_params"

# Module Scheduler + a memo of the (retention, params) it was built from so we can
# cheaply detect when a live retention/weights change requires a rebuild.
_SCHEDULER = None
_SCHEDULER_KEY: tuple | None = None
# Optimized weights applied to the Scheduler, if any (else None = stock weights).
_OPTIMIZED_PARAMS: list[float] | None = None


def _build_scheduler():
    """(Re)build the module Scheduler from the current retention + optimized
    weights. Cached; only rebuilds when retention or weights actually change."""
    global _SCHEDULER, _SCHEDULER_KEY
    if not _HAVE_FSRS:
        _SCHEDULER = None
        return None
    retention = float(getattr(config, "SRS_DESIRED_RETENTION", 0.9) or 0.9)
    retention = max(0.70, min(0.99, retention))
    params = tuple(_OPTIMIZED_PARAMS) if _OPTIMIZED_PARAMS else None
    key = (retention, params)
    if _SCHEDULER is not None and key == _SCHEDULER_KEY:
        return _SCHEDULER
    try:
        if params is not None:
            _SCHEDULER = Scheduler(parameters=list(params), desired_retention=retention)
        else:
            _SCHEDULER = Scheduler(desired_retention=retention)
    except Exception:
        # Bad persisted params (out of bounds, wrong length): fall back to stock.
        _SCHEDULER = Scheduler(desired_retention=retention)
    _SCHEDULER_KEY = key
    return _SCHEDULER


def _scheduler():
    return _build_scheduler()


def rebuild_scheduler() -> None:
    """Force the next ``review`` to rebuild (call after retention/weights change)."""
    global _SCHEDULER_KEY
    _SCHEDULER_KEY = None


def load_optimized_params(session: Session) -> list[float] | None:
    """Load persisted optimized FSRS weights (if any) and apply to the Scheduler.

    Called at startup (alongside settings_store.apply_saved_settings) so the
    module Scheduler reflects the user's own optimized weights from the start."""
    global _OPTIMIZED_PARAMS
    row = session.get(Setting, _PARAMS_SETTING_KEY)
    if row is None or not row.value:
        return None
    try:
        params = json.loads(row.value)
        if isinstance(params, list) and params:
            _OPTIMIZED_PARAMS = [float(x) for x in params]
            rebuild_scheduler()
            return _OPTIMIZED_PARAMS
    except (ValueError, TypeError):
        pass
    return None


def _save_optimized_params(session: Session, params: list[float]) -> None:
    global _OPTIMIZED_PARAMS
    sval = json.dumps([float(x) for x in params])
    row = session.get(Setting, _PARAMS_SETTING_KEY)
    if row is None:
        row = Setting(key=_PARAMS_SETTING_KEY, value=sval)
    else:
        row.value = sval
    session.add(row)
    session.commit()
    _OPTIMIZED_PARAMS = [float(x) for x in params]
    rebuild_scheduler()


def new_card_state() -> dict:
    """Initial FSRS state for a freshly created card."""
    if _HAVE_FSRS:
        return Card().to_dict()
    return {"stability": 0.0, "difficulty": 5.0,
            "due": datetime.now(timezone.utc).isoformat(), "state": 1}


def _minimal_review(state: dict, rating: int) -> tuple[dict, datetime, int]:
    """Tiny fallback: doubling intervals, reset on Again."""
    now = datetime.now(timezone.utc)
    prev = float(state.get("interval_days", 0) or 0)
    if rating == 1:
        interval = 0
    elif prev <= 0:
        interval = {2: 1, 3: 1, 4: 4}[rating]
    else:
        interval = max(1, int(prev * {2: 1.2, 3: 2.0, 4: 3.0}[rating]))
    due = now.fromtimestamp(now.timestamp() + interval * 86400, tz=timezone.utc)
    new_state = {"interval_days": interval, "due": due.isoformat()}
    return new_state, due, interval


def review(state: dict, rating: int) -> tuple[dict, datetime, int]:
    """Apply a review rating (1=again..4=easy). Returns (new_state, due, interval_days)."""
    if not _HAVE_FSRS:
        return _minimal_review(state, rating)
    try:
        card = Card.from_dict(state) if state else Card()
    except Exception:
        card = Card()
    sched = _scheduler()
    new_card, _log = sched.review_card(card, Rating(rating))
    due = new_card.due
    if due.tzinfo is None:
        due = due.replace(tzinfo=timezone.utc)
    interval_days = max(0, (due - datetime.now(timezone.utc)).days)
    return new_card.to_dict(), due, interval_days


def predicted_intervals(state: dict) -> dict[str, int]:
    """Preview interval_days for each FSRS rating without mutating the live card."""
    previews: dict[str, int] = {}
    base_state = dict(state or {})
    for rating in (1, 2, 3, 4):
        _new_state, _due, interval_days = review(base_state, rating)
        previews[str(rating)] = int(interval_days)
    return previews


# --- card lifecycle helpers (1.1 — outcome routing) -------------------------
def get_card(session: Session, question_id: int) -> SRSCard | None:
    """The SRS card for a question, if one exists (one card per question)."""
    return session.exec(
        select(SRSCard).where(SRSCard.question_id == question_id)
    ).first()


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def ensure_card(
    session: Session,
    question_id: int,
    *,
    origin: str,
    due: datetime | None = None,
    commit: bool = True,
) -> tuple[SRSCard, bool]:
    """Idempotently ensure a card exists for ``question_id``.

    Returns ``(card, created)``. One card per question (matches the existing
    ``/srs/cards`` and seed invariant), so a question already in SRS is never
    duplicated. ``origin`` is only stamped on creation; an existing manual/seed
    card keeps its origin (we don't relabel a card the user added by hand)."""
    card = get_card(session, question_id)
    if card is not None:
        return card, False
    card = SRSCard(
        question_id=question_id,
        fsrs_state=new_card_state(),
        due_date=due or datetime.now(timezone.utc),
        lapses=0,
        origin=origin,
    )
    session.add(card)
    if commit:
        session.commit()
        session.refresh(card)
    return card, True


def pull_due_sooner(
    session: Session, card: SRSCard, *, within: timedelta = timedelta(hours=12),
    commit: bool = True,
) -> bool:
    """Move a card's due date earlier (never later) to ``now + within``.

    Used for ``lucky`` outcomes: knowledge that was guessed-right is fragile and
    should resurface soon. Returns True if the due date actually moved."""
    target = datetime.now(timezone.utc) + within
    if _aware(card.due_date) <= target:
        return False
    card.due_date = target
    session.add(card)
    if commit:
        session.commit()
    return True


# --- 3.2 review logging + leeches -------------------------------------------
def log_review(
    session: Session, card: SRSCard, rating: int, *,
    reviewed_at: datetime | None = None, commit: bool = True,
) -> SRSReviewLog:
    """Append an SRSReviewLog row and stamp ``card.last_reviewed``.

    This append-only history is the data the FSRS optimizer consumes; the live
    card only carries its *current* state, not the sequence the optimizer needs."""
    when = reviewed_at or datetime.now(timezone.utc)
    log = SRSReviewLog(
        card_id=card.id,
        question_id=card.question_id,
        rating=int(rating),
        reviewed_at=when,
    )
    session.add(log)
    card.last_reviewed = when
    session.add(card)
    if commit:
        session.commit()
        session.refresh(log)
    return log


def flag_leech_if_needed(card: SRSCard) -> bool:
    """Set ``card.leech`` once lapses reach the threshold. Returns True if it
    transitioned to a leech on this call (so the caller can persist it)."""
    threshold = int(getattr(config, "SRS_LEECH_THRESHOLD", 8))
    if not card.leech and card.lapses >= threshold:
        card.leech = True
        return True
    return False


def leeches(session: Session) -> list[SRSCard]:
    """All cards currently flagged as leeches, most-lapsed first."""
    rows = session.exec(select(SRSCard).where(SRSCard.leech == True)).all()  # noqa: E712
    return sorted(rows, key=lambda c: (-c.lapses, c.id or 0))


# --- LEARN-5 leech + concept-gap unification (host projection) --------------
# The host (CFA/Quant/Excel) mirrors its review cards onto HostProgressSnapshot
# (kind="review") using the canonical cross-domain vocabulary (CrossDomainReviewCard;
# src/lib/dataDictionary.ts / serializers.cross_domain_review_card). LEARN-5 appends
# the optional ``origin`` / ``lapses`` / ``leech`` fields to that shape, so a host
# review snapshot can self-describe as a leech (too many lapses) or a concept gap
# (an origin reason that marks unfinished understanding). These helpers read those
# snapshots back — READ-ONLY, never mutating HostProgressSnapshot — and project them
# onto the SAME canonical shape the LSAT ``/leeches`` and ``/concept-gap-queue`` rows
# carry, so the unified UI merges both planes with one vocabulary.

# Host review-card origins that mark a concept gap (vs. a routine due review). These
# mirror the host ReviewReason vocabulary (src/lib/learningTypes.ts) plus the LSAT
# native "concept_gap" origin; anything else (e.g. "due-review") is not a gap.
_HOST_GAP_ORIGINS = frozenset({
    "concept_gap",
    "concept_gap_cloze",
    "weak-objective",
    "missed-question",
    "rubric-miss",
    "skill-lab-gap",
})


def _coerce_int(value: object, default: int = 0) -> int:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _host_review_snapshot_payload(row: HostProgressSnapshot) -> dict:
    """The verbatim canonical CrossDomainReviewCard the host POSTed, with the
    LEARN-5 leech fields coerced to sane types (a drifted/partial row degrades to
    safe defaults rather than raising). Read-only — never mutates the row."""
    payload = dict(row.payload) if isinstance(row.payload, dict) else {}
    payload["lapses"] = _coerce_int(payload.get("lapses"), 0)
    payload["leech"] = bool(payload.get("leech"))
    # Keep the canonical identity/domain honest even when the host omitted them.
    payload.setdefault("crossId", row.cross_id)
    payload.setdefault("domain", row.plane)
    return payload


def host_leech_and_gap_rows(session: Session) -> tuple[list[dict], list[dict]]:
    """Read host review snapshots (DATA-4a, kind="review") and split them into the
    canonical leech + concept-gap rows the unified queues append when
    ``include_host=true``.

    A host row is a LEECH when it self-reports ``leech=true`` OR its ``lapses``
    reach ``config.SRS_LEECH_THRESHOLD`` (identical rule to
    ``flag_leech_if_needed``); it is a GAP when its ``origin`` is one of
    ``_HOST_GAP_ORIGINS``. The two sets overlap freely (a leech can also be a
    concept gap). Leeches are sorted most-lapsed first to match the LSAT order.
    Returns ``([], [])`` when there is no host review data."""
    threshold = int(getattr(config, "SRS_LEECH_THRESHOLD", 8))
    rows = session.exec(
        select(HostProgressSnapshot).where(HostProgressSnapshot.kind == "review")
    ).all()
    leech_rows: list[dict] = []
    gap_rows: list[dict] = []
    for row in rows:
        payload = _host_review_snapshot_payload(row)
        if payload["leech"] or payload["lapses"] >= threshold:
            leech_rows.append(payload)
        if str(payload.get("origin") or "") in _HOST_GAP_ORIGINS:
            gap_rows.append(payload)
    leech_rows.sort(key=lambda p: -_coerce_int(p.get("lapses"), 0))
    return leech_rows, gap_rows


# --- 3.2 weight optimization ------------------------------------------------
def _optimizer_available() -> bool:
    """Whether py-fsrs's optional Optimizer (torch/pandas/tqdm) is importable."""
    if not _HAVE_FSRS:
        return False
    try:
        import fsrs

        fsrs.Optimizer  # triggers the lazy import in fsrs/__init__
        # The real Optimizer requires torch; the stub raises on init. Probe deps
        # directly so we never even build the (heavy) optimizer object pointlessly.
        import importlib.util as _u

        return all(
            _u.find_spec(m) is not None for m in ("torch", "pandas")
        )
    except Exception:
        return False


def _review_logs_for_fsrs(session: Session):
    """Build py-fsrs ReviewLog objects from our persisted SRSReviewLog rows,
    oldest-first. py-fsrs needs a per-card chronological sequence."""
    from fsrs import ReviewLog as FsrsReviewLog
    from fsrs import Rating as FsrsRating

    rows = session.exec(
        select(SRSReviewLog).order_by(SRSReviewLog.reviewed_at, SRSReviewLog.id)
    ).all()
    logs = []
    for r in rows:
        when = _aware(r.reviewed_at)
        # py-fsrs requires UTC tz-aware datetimes.
        when = when.astimezone(timezone.utc)
        logs.append(
            FsrsReviewLog(
                card_id=r.card_id,
                rating=FsrsRating(int(r.rating)),
                review_datetime=when,
                review_duration=None,
            )
        )
    return logs, len(rows)


def optimize_parameters(session: Session) -> dict:
    """Optimize FSRS weights from the user's own review log and persist them.

    Robust + graceful: returns a small status dict. ``ran`` is True only when we
    actually fit and persisted new weights; otherwise ``reason`` explains why we
    fell back (thin history, optimizer deps missing, or fsrs unavailable). The
    module Scheduler is rebuilt with the new weights when we do run.
    """
    n = session.exec(select(func.count()).select_from(SRSReviewLog)).one()
    min_reviews = int(getattr(config, "SRS_OPTIMIZE_MIN_REVIEWS", 200))

    if n < min_reviews:
        return {"ran": False, "reason": "insufficient_history", "n_reviews": n,
                "min_reviews": min_reviews, "optimizer_available": _optimizer_available()}
    if not _HAVE_FSRS:
        return {"ran": False, "reason": "fsrs_unavailable", "n_reviews": n,
                "optimizer_available": False}
    if not _optimizer_available():
        # The optimizer needs torch/pandas, which aren't installed in this
        # environment. Don't crash — keep the current (stock/optimized) weights.
        return {"ran": False, "reason": "optimizer_deps_missing", "n_reviews": n,
                "optimizer_available": False}

    try:
        from fsrs import Optimizer

        logs, _count = _review_logs_for_fsrs(session)
        optimizer = Optimizer(logs)
        params = optimizer.compute_optimal_parameters()
        if not params:
            return {"ran": False, "reason": "no_parameters", "n_reviews": n,
                    "optimizer_available": True}
        _save_optimized_params(session, list(params))
        return {"ran": True, "n_reviews": n, "n_parameters": len(params),
                "optimizer_available": True}
    except Exception as exc:  # pragma: no cover - defensive (heavy optional path)
        return {"ran": False, "reason": f"error:{type(exc).__name__}",
                "n_reviews": n, "optimizer_available": True}
