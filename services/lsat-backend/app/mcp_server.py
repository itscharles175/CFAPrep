"""MCP server exposing study analytics + a few scoped mutations to Jarvis
(docs/04-roadmap Phase 5).

Local-first. The original 7 tools are strictly READ-ONLY analytics. R7 7.5 adds
a small set of carefully-scoped MUTATING tools (enqueue a generation job, tag-
review a question, soft-delete a near-duplicate, set the study target / note) so
Jarvis can act, not just report. Every mutation is provenance-guarded:

  * No tool EVER returns official (copyrighted) question TEXT — they return ids,
    types, difficulties, counts; never ``stem``/``prompt``/choice text.
  * Curation (soft-delete) is allowed ONLY for non-official sources
    (``ai_generated`` / ``research``); it REFUSES ``official`` / ``sample``.
  * Generation reuses the durable queue and refuses a type with no real anchor
    (we never model AI on AI).

Run as a stdio MCP server:

    uv run python -m app.mcp_server

The tool bodies are plain importable callables (``tool_*``) so they can be unit
tested without the MCP transport; ``build_server`` wires them onto a FastMCP
instance (importing ``mcp`` lazily so the rest of the app never depends on it).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlmodel import Session

from . import analytics, audit, coach, generation, jobs, study_plan
from .bank_bootstrap import bank_stats
from .db import engine, init_db
from .models import GenStatus, Question, QuestionSource, Setting

# Sources we will NEVER soft-delete via MCP: official is copyrighted + feeds
# score prediction; sample is the curated seed bank. Only ai_generated/research
# are app-owned and safe to curate (and redistribute).
_CURATABLE_SOURCES = {QuestionSource.ai_generated, QuestionSource.research}
# Persisted key for the free-text study-plan note (generic Setting key/value).
_STUDY_NOTE_KEY = "study_plan_note"


def _query(fn):
    with Session(engine) as s:
        return fn(s)


def _mutate(fn):
    """Run ``fn(session)`` in a session and return its result (commits inside)."""
    with Session(engine) as s:
        return fn(s)


def tool_dashboard() -> dict:
    """Score, trend, weakest types, streak, coach card."""
    return _query(analytics.dashboard)


def tool_by_type(source: str = "all") -> list:
    """Accuracy + timing by question type (source: 'all' | 'official')."""
    return _query(lambda s: analytics.by_type(s, source=source))


def tool_mastery() -> list:
    """Recency-weighted, difficulty-adjusted mastery per type (weakest first)."""
    return _query(analytics.mastery)


def tool_forecast(exam_date: Optional[str] = None,
                  target_score: Optional[int] = None) -> dict:
    """Projected exam-day score with a confidence band."""
    return _query(lambda s: analytics.forecast(s, exam_date=exam_date, target_score=target_score))


def tool_blind_review_gap() -> dict:
    """Timed-vs-blind-review accuracy gap (the key diagnostic number)."""
    return _query(analytics.blind_review_gap)


def tool_bank_stats() -> dict:
    """Question-bank size by source and type."""
    def f(s: Session) -> dict:
        st = bank_stats(s)
        return {"total": st.total, "by_source": st.by_source, "by_q_type": st.by_q_type}
    return _query(f)


def tool_coach() -> dict:
    """Latest cached AI coach diagnosis (no model call)."""
    def f(s: Session) -> dict:
        snap = coach.latest_snapshot(s)
        if snap is None:
            return {"available": False}
        return {"available": True, "text": snap.text,
                "recommendation": snap.recommendation_json}
    return _query(f)


# --- 7.5 read-write tools (provenance-guarded) ------------------------------
def tool_enqueue_generation(q_type: str, count: int = 5) -> dict:
    """Queue a Tier-B generation job for a (usually weak) ``q_type``.

    Reuses the durable generation queue. Refuses a type with no real anchor
    questions — we never model AI on AI (docs/00-vision.md). Returns the job id +
    counts only; never any question text.
    """
    def f(s: Session) -> dict:
        parents = generation._eligible_parents(s, q_type)
        if not parents:
            return {"enqueued": False,
                    "reason": "no real anchor questions for this type",
                    "q_type": q_type}
        n = max(1, min(int(count), 50))
        jid = jobs.enqueue(s, q_type, n, status=GenStatus.queued)
        return {
            "enqueued": True,
            "job_id": jid,
            "status": GenStatus.queued.value,
            "q_type": q_type,
            "count": n,
            "anchors": len(parents),
        }
    return _mutate(f)


def tool_tag_review_question(question_id: int, q_type: Optional[str] = None,
                             difficulty: Optional[int] = None) -> dict:
    """Re-tag a question: set its ``q_type`` and/or ``difficulty`` (1-5).

    Writes an AuditLog row per changed field via the existing audit path (which
    also bumps ``Question.updated_at``). Provenance-safe: returns ids/types only,
    never question text, so re-tagging an official item never exposes its stem.
    Source is immutable (DB trigger) and is not touched here.
    """
    def f(s: Session) -> dict:
        q = s.get(Question, question_id)
        if q is None:
            return {"ok": False, "reason": "question_not_found",
                    "question_id": question_id}
        changes: list[str] = []
        if q_type is not None and q_type != q.q_type:
            audit.record_edit(s, entity="question", entity_id=question_id,
                              field="q_type", old_value=q.q_type, new_value=q_type)
            q.q_type = q_type
            changes.append("q_type")
        if difficulty is not None:
            new_diff = max(1, min(int(difficulty), 5))
            if new_diff != q.difficulty:
                audit.record_edit(s, entity="question", entity_id=question_id,
                                  field="difficulty", old_value=q.difficulty,
                                  new_value=new_diff)
                q.difficulty = new_diff
                changes.append("difficulty")
        if changes:
            s.add(q)
            s.commit()
            s.refresh(q)
        return {
            "ok": True,
            "question_id": question_id,
            "changed": changes,
            "q_type": q.q_type,
            "difficulty": q.difficulty,
        }
    return _mutate(f)


def tool_soft_delete_duplicate(question_id: int) -> dict:
    """Soft-delete (tombstone) a near-duplicate question.

    PROVENANCE GUARD: only ``ai_generated`` / ``research`` items may be removed.
    ``official`` (copyrighted + score-affecting) and ``sample`` (curated seed)
    are REFUSED. Soft-delete only — the row stays (FKs/history intact) but is
    retired from future selection. Returns ids/source only, never question text.
    """
    def f(s: Session) -> dict:
        q = s.get(Question, question_id)
        if q is None:
            return {"ok": False, "reason": "question_not_found",
                    "question_id": question_id}
        if q.source not in _CURATABLE_SOURCES:
            return {
                "ok": False,
                "reason": "provenance_protected",
                "detail": (
                    f"refusing to soft-delete a '{q.source.value}' question; "
                    "only ai_generated/research items may be curated"
                ),
                "question_id": question_id,
                "source": q.source.value,
            }
        if q.deleted_at is not None:
            return {"ok": True, "already_deleted": True,
                    "question_id": question_id, "source": q.source.value}
        q.deleted_at = datetime.now(timezone.utc)
        s.add(q)
        s.commit()
        return {
            "ok": True,
            "question_id": question_id,
            "source": q.source.value,
            "deleted_at": q.deleted_at.isoformat(),
        }
    return _mutate(f)


def tool_set_study_target(target_score: int, exam_date: Optional[str] = None,
                          daily_minutes: int = 60, note: Optional[str] = None) -> dict:
    """Set the active study plan's target score / exam date / daily minutes, and
    optionally attach a free-text note. Returns the resulting plan summary.

    The note is stored in the generic Setting key/value store (no question text
    is involved, so this is provenance-trivial)."""
    def f(s: Session) -> dict:
        plan = study_plan.upsert_plan(
            s, target_score=int(target_score), exam_date=exam_date,
            daily_minutes=max(1, int(daily_minutes)),
        )
        saved_note = None
        if note is not None:
            row = s.get(Setting, _STUDY_NOTE_KEY)
            if row is None:
                row = Setting(key=_STUDY_NOTE_KEY, value=note)
            else:
                row.value = note
            s.add(row)
            s.commit()
            saved_note = note
        else:
            existing = s.get(Setting, _STUDY_NOTE_KEY)
            saved_note = existing.value if existing else None
        return {
            "ok": True,
            "target_score": plan.target_score,
            "exam_date": plan.exam_date,
            "daily_minutes": plan.daily_minutes,
            "note": saved_note,
        }
    return _mutate(f)


# name -> callable, for registration and tests.
TOOLS = {
    # read-only analytics (unchanged)
    "get_dashboard": tool_dashboard,
    "get_accuracy_by_type": tool_by_type,
    "get_mastery": tool_mastery,
    "get_score_forecast": tool_forecast,
    "get_blind_review_gap": tool_blind_review_gap,
    "get_bank_stats": tool_bank_stats,
    "get_coach": tool_coach,
    # 7.5 read-write (provenance-guarded)
    "enqueue_generation": tool_enqueue_generation,
    "tag_review_question": tool_tag_review_question,
    "soft_delete_duplicate": tool_soft_delete_duplicate,
    "set_study_target": tool_set_study_target,
}


def build_server():
    """Construct the FastMCP server with all read-only tools registered.

    B23: mcp is a required dependency (pyproject.toml); the try/except
    ModuleNotFoundError stub has been removed. If mcp is absent the import
    fails loudly at startup rather than silently creating a broken stub server.
    """
    from mcp.server.fastmcp import FastMCP

    server = FastMCP("LSAT Lab")
    for name, fn in TOOLS.items():
        server.tool(name=name)(fn)
    return server


def main() -> None:  # pragma: no cover - stdio transport entrypoint
    init_db()
    build_server().run()


if __name__ == "__main__":  # pragma: no cover
    main()
