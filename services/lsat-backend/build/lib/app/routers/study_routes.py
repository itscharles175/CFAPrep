"""Study plan + daily plan endpoints (goal-driven studying)."""
from __future__ import annotations

from datetime import date
from typing import Literal, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlmodel import Session

from .. import study_plan
from ..db import get_session
from ..models import ActivityEvent

router = APIRouter(prefix="/study")


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
