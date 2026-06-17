"""LSAT-7 — Content-Ops drill/playlist depth endpoints.

These extend the content-trust cockpit with two drill-depth signals that don't
belong on the existing health/duplicate routes:

* ``GET  /api/content/pacing-budget`` — per-type pacing budgets: the section
  benchmark (LR 90s / RC 120s), the student's observed average, and any saved
  override, so a drill or playlist can show a per-type time budget.
* ``POST /api/content/pacing-budget`` — set or clear a per-type override (stored
  as one JSON ``Setting`` row; no migration).
* ``GET  /api/content/weak-type-suggestions`` — ranked weak-type drill
  suggestions (lowest mastery, then accuracy) with a ready-to-submit DrillBody.

All endpoints are additive and best-effort: analytics that can't be computed
degrade to empty/None rather than failing the request. Mounted under ``/content``
to sit beside ``content_health_routes`` in the ``/api`` namespace.
"""
from __future__ import annotations

import json
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from .. import adaptivity, analytics
from ..analytics import _EFFICIENCY_TIME_BENCHMARKS_MS
from ..db import get_session
from ..models import LR_TYPES, RC_TYPES, Setting

# No prefix: this router is INCLUDED INTO ``content_health_routes.router`` (which
# already carries the ``/content`` prefix and is mounted at ``/api``), so the final
# paths are ``/api/content/pacing-budget`` etc. Including it there (rather than
# mounting separately) keeps the shared ``main.py`` router list untouched.
router = APIRouter()

# One JSON Setting row holds all per-type pacing overrides: {q_type: target_ms}.
_PACING_BUDGET_KEY = "content_ops.pacing_budgets"


def _section_for_type(q_type: str) -> str:
    """RC when the type is RC-only, else LR (mirrors the drill section heuristic)."""
    if q_type in RC_TYPES and q_type not in LR_TYPES:
        return "RC"
    return "LR"


def _benchmark_ms(section_type: str) -> int:
    return _EFFICIENCY_TIME_BENCHMARKS_MS.get(
        section_type, _EFFICIENCY_TIME_BENCHMARKS_MS["LR"]
    )


def _load_overrides(session: Session) -> dict[str, int]:
    row = session.get(Setting, _PACING_BUDGET_KEY)
    if row is None or not row.value:
        return {}
    try:
        data = json.loads(row.value)
    except (ValueError, TypeError):
        return {}
    out: dict[str, int] = {}
    if isinstance(data, dict):
        for key, val in data.items():
            try:
                ms = int(val)
            except (ValueError, TypeError):
                continue
            if ms > 0:
                out[str(key)] = ms
    return out


def _save_overrides(session: Session, overrides: dict[str, int]) -> None:
    row = session.get(Setting, _PACING_BUDGET_KEY)
    payload = json.dumps(overrides, sort_keys=True, separators=(",", ":"))
    if row is None:
        row = Setting(key=_PACING_BUDGET_KEY, value=payload)
    else:
        row.value = payload
    session.add(row)
    session.commit()


class PacingBudgetBody(BaseModel):
    q_type: str = Field(min_length=1, max_length=80)
    # Target seconds per question. None clears the override (revert to benchmark).
    target_seconds: Optional[int] = Field(default=None, ge=10, le=900)


def _pacing_rows(session: Session, source: str) -> list[dict[str, Any]]:
    overrides = _load_overrides(session)
    try:
        by_type = analytics.by_type(session, source=source)
    except Exception:
        by_type = []
    observed = {row["q_type"]: row for row in by_type}
    # Union of types we have analytics for + types with a saved override, so an
    # override survives even before the student has attempts in that type.
    keys = sorted(set(observed) | set(overrides))
    rows: list[dict[str, Any]] = []
    for q_type in keys:
        obs = observed.get(q_type)
        section_type = obs["section_type"] if obs else _section_for_type(q_type)
        benchmark_ms = _benchmark_ms(section_type)
        override_ms = overrides.get(q_type)
        avg_ms = obs["avg_time_ms"] if obs else None
        budget_ms = override_ms if override_ms is not None else benchmark_ms
        over_budget = bool(avg_ms is not None and avg_ms > budget_ms)
        rows.append({
            "q_type": q_type,
            "section_type": section_type,
            "benchmark_ms": benchmark_ms,
            "override_ms": override_ms,
            "budget_ms": budget_ms,
            "avg_time_ms": avg_ms,
            "attempts": obs["attempts"] if obs else 0,
            "accuracy": obs["accuracy"] if obs else None,
            "efficiency_band": obs.get("efficiency_band") if obs else None,
            "over_budget": over_budget,
        })
    rows.sort(key=lambda r: (0 if r["over_budget"] else 1, -(r["attempts"] or 0), r["q_type"]))
    return rows


@router.get("/pacing-budget")
def pacing_budget(
    source: Literal["official", "all"] = "all",
    session: Session = Depends(get_session),
):
    """Per-type pacing budgets: section benchmark, observed average, and override."""
    rows = _pacing_rows(session, source)
    return {
        "source": source,
        "benchmarks_ms": dict(_EFFICIENCY_TIME_BENCHMARKS_MS),
        "over_budget_count": len([r for r in rows if r["over_budget"]]),
        "budgets": rows,
    }


@router.post("/pacing-budget")
def set_pacing_budget(
    body: PacingBudgetBody,
    session: Session = Depends(get_session),
):
    """Set (or, with ``target_seconds=null``, clear) a per-type pacing override."""
    overrides = _load_overrides(session)
    if body.target_seconds is None:
        overrides.pop(body.q_type, None)
    else:
        overrides[body.q_type] = int(body.target_seconds) * 1000
    _save_overrides(session, overrides)
    rows = _pacing_rows(session, "all")
    return {
        "ok": True,
        "q_type": body.q_type,
        "override_ms": overrides.get(body.q_type),
        "budgets": rows,
    }


@router.get("/weak-type-suggestions")
def weak_type_suggestions(
    limit: int = Query(default=5, ge=1, le=20),
    session: Session = Depends(get_session),
):
    """Ranked weak-type drill suggestions (lowest mastery first) with a
    ready-to-submit DrillBody for each. Drives the cockpit's weak-type recommender
    and the Drills page's smart weak-type drills."""
    try:
        matrix = adaptivity.ability_matrix(session, days=180)
    except Exception:
        matrix = {"weakest": []}
    suggestions: list[dict[str, Any]] = []
    for row in (matrix.get("weakest") or [])[:limit]:
        q_type = row.get("q_type")
        if not q_type:
            continue
        section_type = row.get("section_type") or _section_for_type(q_type)
        suggestions.append({
            "q_type": q_type,
            "section_type": section_type,
            "mastery": row.get("mastery"),
            "accuracy": row.get("accuracy"),
            "evidence_n": row.get("evidence_n"),
            "avg_time_ms": row.get("avg_time_ms"),
            # A DrillBody the client can POST to /api/drills verbatim.
            "drill": {
                "q_type": q_type,
                "section_type": section_type,
                "count": 10,
                "source": "any",
                "timed": True,
                "weak_type_remediation": True,
            },
        })
    return {
        "count": len(suggestions),
        "suggestions": suggestions,
    }
