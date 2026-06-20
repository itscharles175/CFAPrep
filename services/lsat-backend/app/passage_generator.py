"""LSAT-5 — passage-first RC generation orchestration.

The default Tier-B path (``generation.run_job``) emits ONE independent item per
loop iteration. That is wrong for Reading Comprehension: a real RC set is several
varied questions ABOUT ONE coherent passage. This module implements the
passage-first alternative the runner dispatches to when ``GenJob.passage_first``
is set:

  1. Generate ONE coherent passage (``generation._gen_prompt(passage_first=True)``).
  2. Persist it as a real ``Passage`` under the synthetic AI section so the
     attached questions are drillable RC items, and analyze it eagerly
     (``rc_intelligence.analyze_passage(..., persist=True)``) so the structure map
     exists immediately.
  3. Loop a varied set of RC q_types, generating ONE question per type ABOUT that
     fixed passage (``generation._question_prompt``). Each question runs through
     the SAME ``validate_candidate`` gate PLUS the LSAT-5 RC SEMANTIC validators
     (MainPoint coherence / Detail-basis / Inference-support) and is persisted
     attached to the shared ``passage_id``.

Atomicity: if the passage itself fails to generate / parse / clear the RC
authenticity gate, the WHOLE job fails and NO questions are written — there is no
passage to attach them to. Individual questions, by contrast, are validated and
persisted inside their own SAVEPOINT (mirroring ``run_job``'s per-candidate
isolation) so one bad question quarantines itself without losing the others.

The building blocks (prompts, the gate, persistence helpers) are reused verbatim
from ``generation``; this module only sequences them. ``generation.run_job``
imports it lazily to avoid an import cycle.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from sqlmodel import Session

from . import config, gen_validators, llm, rc_intelligence
from .dataset_normalizers import clamp_difficulty
from .models import (
    RC_TYPES,
    AnswerChoice,
    GenCandidate,
    GenJob,
    GenStatus,
    Passage,
    Question,
    ValidatorRun,
)

log = logging.getLogger("lsatlab.passage_generation")

# A passage-first set is 3-4 varied questions (the LSAT-5 goal). ``job.count`` is
# honored as the upper bound, but a single passage rarely sustains more than four
# distinct questions, so we clamp to this ceiling regardless.
_MAX_QUESTIONS_PER_PASSAGE = 4
_MIN_QUESTIONS_PER_PASSAGE = 3

# Default rotation of RC q_types for a varied set. The job's own ``q_type`` is
# always tried first; the remainder fill out the set with a spread that exercises
# the three RC SEMANTIC validators (MainPoint / Detail / Inference) plus a couple
# of structural types. Any q_type not in RC_TYPES is dropped defensively.
_VARIED_RC_ROTATION: tuple[str, ...] = (
    "MainPoint", "Inference", "Detail", "Function", "Attitude", "Structure",
)


def _question_types_for(job: GenJob) -> list[str]:
    """Order the varied RC q_types for this passage-first job.

    The job's ``q_type`` leads (it is the type the coach asked to backfill), then
    the default rotation fills the rest WITHOUT repeats, capped by ``job.count``
    and the per-passage ceiling. Always returns at least one type."""
    desired = max(0, int(job.count or 0))
    target = min(_MAX_QUESTIONS_PER_PASSAGE, max(_MIN_QUESTIONS_PER_PASSAGE, desired or _MIN_QUESTIONS_PER_PASSAGE))
    ordered: list[str] = []
    seen: set[str] = set()

    def _add(qt: str) -> None:
        if qt and qt in RC_TYPES and qt not in seen:
            ordered.append(qt)
            seen.add(qt)

    _add(job.q_type)
    for qt in _VARIED_RC_ROTATION:
        if len(ordered) >= target:
            break
        _add(qt)
    # Fallback: if the job q_type was non-RC and the rotation somehow emptied,
    # guarantee at least MainPoint so the loop always runs.
    if not ordered:
        ordered.append("MainPoint")
    return ordered[:target]


def _provider_models() -> tuple[Optional[str], Optional[str]]:
    """(solver_model, critic_model) provenance for the GenCandidate rows."""
    try:
        pinfo = llm.provider_info()
    except Exception:  # noqa: BLE001
        pinfo = {}
    solver = pinfo.get("gen_model") or config.GEN_MODEL
    try:
        critic = pinfo.get("critic_model") or llm.critic_model_name()
    except Exception:  # noqa: BLE001
        critic = pinfo.get("critic_model")
    return solver, critic


def _rc_semantic_verdict(q_type: str, cand: dict, critic_fn: Callable[[str], str]) -> dict:
    """Run the LSAT-5 RC SEMANTIC validator for ``q_type`` (a clean pass for RC
    types without a dedicated semantic check)."""
    try:
        return gen_validators.validate_rc_semantic(q_type, cand, critic_fn)
    except Exception:  # noqa: BLE001 — a validator bug must never kill the question
        log.warning("LSAT-5: rc_semantic validator raised q_type=%s", q_type, exc_info=True)
        return {"ok": True, "reason": None, "check": "rc_semantic_error"}


def run_passage_first_job(
    session: Session,
    job: GenJob,
    gen_fn: Callable[[str], str],
    critic_fn: Callable[[str], str],
    embed_fn: Callable[[str], list[float]],
    *,
    retry_history: list | None = None,
) -> None:
    """Drive a passage-first RC job to completion on the open ``session``.

    Called by ``generation.run_job`` once it has marked the job ``running``. Owns
    the rest of the job lifecycle (status, counters, validation_report,
    GenCandidate / ValidatorRun rows) exactly like the legacy loop, so the worker
    and the job routes see an identical shape.
    """
    # Imported here (not at module top) to avoid an import cycle: generation
    # imports this module lazily, and this module reuses generation's helpers.
    from . import generation

    retry_history = retry_history if isinstance(retry_history, list) else []
    solver_model, critic_model = _provider_models()
    coaching = generation._coaching_note(session, job.q_type)

    candidates_report: list[dict] = []
    accepted = 0
    quarantined = 0
    produced = 0
    passage_id: Optional[int] = None
    rc_context: dict[str, Any] = {}
    q_types = _question_types_for(job)
    # ``count`` drives the UI progress bar; for a passage-first job the unit of
    # work is the passage + each question, so the denominator is 1 + len(q_types).
    total_steps = 1 + len(q_types)
    step = 0

    def _bump_progress() -> None:
        nonlocal step
        step += 1
        job.produced = produced
        job.accepted = accepted
        job.quarantined = quarantined
        job.progress_pct = round(100 * step / max(1, total_steps), 1)
        job.updated_at = datetime.now(timezone.utc)
        session.add(job)
        session.commit()

    try:
        # --- (1) generate + persist + analyze the ONE shared passage -----------
        passage_prompt = generation._gen_prompt(
            job.q_type, None, [],
            section_type="RC", passage_first=True, coaching_note=coaching,
        )
        passage_raw = gen_fn(passage_prompt)
        passage_obj = generation._extract_json(passage_raw) or {}
        passage_text = str(passage_obj.get("passage", "") or "").strip()

        # Atomic gate: a missing/garbage/too-thin passage fails the WHOLE job; no
        # questions are written because there is nothing to attach them to.
        rc_auth = generation.rc_authenticity(passage_text) if passage_text else {"ok": False, "flags": ["too_short"]}
        if not passage_text or not rc_auth.get("ok", False):
            reason = "passage_unparseable" if not passage_text else (
                "rc_authenticity:" + ((rc_auth.get("flags") or ["unknown"])[0])
            )
            candidates_report.append({
                "passed": False,
                "reason": reason,
                "section_type": "RC",
                "is_passage": True,
                "checks": {"rc_authenticity": rc_auth},
            })
            quarantined += 1
            produced += 1
            job.status = GenStatus.failed
            _finalize(
                session, job, candidates_report,
                produced=produced, accepted=accepted, quarantined=quarantined,
                solver_model=solver_model, critic_model=critic_model,
                retry_history=retry_history,
            )
            return

        produced += 1
        sec = generation._ensure_ai_section(session, "RC")
        passage = Passage(
            section_id=sec.id,
            text=passage_text,
            type=str(passage_obj.get("type") or "single"),
            topic=passage_obj.get("topic"),
        )
        session.add(passage)
        session.flush()
        session.refresh(passage)
        passage_id = passage.id
        # Eager structure map so the attached questions can steer off it and the
        # RC dashboard sees the passage immediately.
        try:
            analysis = rc_intelligence.analyze_passage(session, passage_id, persist=True)
            rc_context = {
                "parent_passage_id": passage_id,
                "passage_type": (analysis.get("structure") or {}).get("passage_type"),
                "paragraph_count": (analysis.get("structure") or {}).get("paragraph_count"),
                "dominant_viewpoint": (analysis.get("structure") or {}).get("dominant_viewpoint"),
                "main_point_hint": (analysis.get("structure") or {}).get("main_point_hint"),
                "paragraph_roles": (analysis.get("paragraph_roles") or [])[:4],
                "evidence_refs": (analysis.get("evidence_refs") or [])[:3],
            }
        except Exception:  # noqa: BLE001 — analysis is best-effort steering
            log.warning("LSAT-5: analyze_passage failed passage_id=%s", passage_id, exc_info=True)
            rc_context = {"parent_passage_id": passage_id}
        session.commit()
        _bump_progress()

        # --- (2) loop q_types, one question per type, attached to the passage --
        prior_prompts: list[str] = []
        for idx, q_type in enumerate(q_types):
            session.refresh(job)
            if (job.validation_report or {}).get("cancel_requested"):
                candidates_report.append({
                    "cancelled": True,
                    "passed": False,
                    "reason": "cancelled",
                    "section_type": "RC",
                })
                job.status = GenStatus.cancelled
                job.cancelled_at = datetime.now(timezone.utc)
                break

            q_prompt = generation._question_prompt(
                q_type, passage_text,
                coaching_note=coaching, rc_context=rc_context,
                other_prompts=prior_prompts,
            )
            raw = gen_fn(q_prompt)
            cand = generation._extract_json(raw)
            produced += 1
            # Attach the SHARED passage so the RC gate (structural / solve /
            # grounding / semantic) reasons over the same text every question is
            # written about. The model's per-question JSON omits the passage on
            # purpose (it was given the passage verbatim in the prompt).
            if cand is not None and not str(cand.get("passage", "") or "").strip():
                cand["passage"] = passage_text
            if not cand:
                candidates_report.append({
                    "passed": False,
                    "reason": "unparseable",
                    "section_type": "RC",
                    "q_type": q_type,
                })
                quarantined += 1
                _bump_progress()
                continue

            try:
                with session.begin_nested():
                    verdict = generation.validate_candidate(
                        cand, config.GEN_SELF_CONSISTENCY_RUNS,
                        solver=gen_fn, critic=critic_fn, q_type=q_type,
                        section_type="RC",
                        session=session, embedder=embed_fn,
                    )
                    # LSAT-5 — additional RC SEMANTIC gate over the shared passage.
                    semantic = _rc_semantic_verdict(q_type, cand, critic_fn)
                    verdict.setdefault("checks", {})["rc_semantic"] = semantic
                    if verdict.get("passed") and not semantic.get("ok", True):
                        verdict["passed"] = False
                        verdict["reason"] = semantic.get("reason") or "rc_semantic"
                    verdict["section_type"] = "RC"
                    verdict["q_type"] = q_type
                    verdict["passage_id"] = passage_id
                    if rc_context:
                        verdict["rc_generation_context"] = rc_context
                    accepted_flag = bool(verdict.get("passed", False))
                    q = _persist_question_for_passage(
                        session, cand, q_type, passage_id, accepted_flag,
                    )
                    verdict["question_id"] = q.id
            except Exception:  # noqa: BLE001 — one question must not kill the job
                log.warning(
                    "LSAT-5: question validate/persist rolled back job_id=%s q_type=%s",
                    job.id, q_type, exc_info=True,
                )
                candidates_report.append({
                    "passed": False,
                    "reason": "persist_error",
                    "section_type": "RC",
                    "q_type": q_type,
                })
                quarantined += 1
                _bump_progress()
                continue

            prior_prompts.append(str(cand.get("prompt", "") or ""))
            verdict["solver_model"] = solver_model
            verdict["critic_model"] = critic_model
            candidates_report.append(verdict)
            if accepted_flag:
                accepted += 1
            else:
                quarantined += 1
            _bump_progress()

        if job.status != GenStatus.cancelled:
            job.status = GenStatus.done
    except Exception as exc:  # noqa: BLE001 — model unreachable etc.
        log.warning("LSAT-5: run_passage_first_job failed job_id=%s", job.id, exc_info=True)
        job.status = GenStatus.failed
        candidates_report.append({"error": str(exc)})

    _finalize(
        session, job, candidates_report,
        produced=produced, accepted=accepted, quarantined=quarantined,
        solver_model=solver_model, critic_model=critic_model,
        retry_history=retry_history,
    )


def _persist_question_for_passage(
    session: Session, cand: dict, q_type: str, passage_id: Optional[int],
    accepted: bool,
) -> Question:
    """Persist one generated RC question attached to the shared ``passage_id``.

    Mirrors ``generation._persist_candidate`` but does NOT create a new passage:
    the passage already exists (created once for the whole set), so every question
    in the set shares its ``passage_id`` and ``section_id``. Uses ``flush`` (not
    ``commit``) so it composes with the caller's per-question SAVEPOINT."""
    section_id: Optional[int] = None
    if passage_id is not None:
        pas = session.get(Passage, passage_id)
        section_id = pas.section_id if pas is not None else None

    from .models import QuestionSource

    q = Question(
        section_id=section_id,
        passage_id=passage_id,
        stem=cand.get("stem", ""),
        prompt=cand.get("prompt", ""),
        correct_answer=cand.get("correct_answer", "A"),
        difficulty=clamp_difficulty(cand.get("difficulty")),
        q_type=q_type,
        source=QuestionSource.ai_generated,
        quarantined=not accepted,
        approved=accepted,
    )
    session.add(q)
    session.flush()
    session.refresh(q)
    for c in cand.get("choices", []):
        session.add(AnswerChoice(
            question_id=q.id,
            label=c.get("label", "?"),
            text=c.get("text", ""),
            is_correct=(c.get("label") == cand.get("correct_answer")),
            trap_type=c.get("trap_type"),
        ))
    session.flush()
    session.refresh(q)
    return q


def _finalize(
    session: Session,
    job: GenJob,
    candidates_report: list[dict],
    *,
    produced: int,
    accepted: int,
    quarantined: int,
    solver_model: Optional[str],
    critic_model: Optional[str],
    retry_history: list,
) -> None:
    """Write the job's final counters + validation_report + per-candidate rows.

    Same shape as the tail of ``generation.run_job`` so downstream consumers
    (quality metrics, audit log, triage, the job routes) treat passage-first jobs
    identically to single-candidate jobs."""
    from . import generation

    job.produced = produced
    job.accepted = accepted
    job.quarantined = quarantined
    if job.status == GenStatus.done:
        job.progress_pct = 100.0
    job.updated_at = datetime.now(timezone.utc)

    provider_info: dict = {}
    try:
        provider_info = llm.provider_info()
    except Exception:  # noqa: BLE001
        provider_info = {}
    job.validation_report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "candidate_generator_model": job.model,
        "solver_model": solver_model,
        "critic_model": critic_model,
        "explain_model": provider_info.get("explain_model"),
        "passage_first": True,
        "retry_count": job.retry_count,
        "max_retries": job.max_retries,
        "retry_history": retry_history,
        "candidates": candidates_report[:50],
    }
    session.add(job)
    for idx, verdict in enumerate(candidates_report):
        session.add(GenCandidate(
            gen_job_id=job.id,
            question_id=verdict.get("question_id"),
            candidate_index=idx,
            verdict="accepted" if verdict.get("passed") else "quarantined",
            verdict_reason=verdict.get("reason"),
            gate_scores=verdict.get("checks") or {},
            solver_model=verdict.get("solver_model") or solver_model,
            critic_model=verdict.get("critic_model") or critic_model,
            training_anchor_id=verdict.get("training_anchor_id"),
        ))
        session.add(generation._validator_run_from_verdict(
            job=job,
            verdict=verdict,
            candidate_index=idx,
        ))
    session.commit()
