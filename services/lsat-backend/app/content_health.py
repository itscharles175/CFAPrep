"""Content health and firewall checks for the vNext cockpit."""
from __future__ import annotations

import hashlib
import json
from collections import Counter, defaultdict
from typing import Any

from sqlalchemy import func
from sqlmodel import Session, select

from . import gen_validators, generation
from .import_dataset import DATASETS
from .models import (
    AnswerChoice,
    ContentVersion,
    LR_TYPES,
    NotebookSource,
    PodcastEpisode,
    Passage,
    RC_TYPES,
    Question,
    QuestionSource,
    Section,
    SectionType,
    SourceRegistry,
    StudyArtifact,
    TransformationRun,
    ValidatorRun,
    utcnow,
)


_REVALIDATION_RUN_SOURCE = "content_health.revalidate"
_REVALIDATION_LOOKBACK = 500


def health_report(session: Session) -> dict[str, Any]:
    questions = session.exec(select(Question)).all()
    total = len(questions)
    by_source = Counter(_source_value(q.source) for q in questions)
    by_type = Counter(q.q_type for q in questions if q.q_type)
    known_types = set(LR_TYPES) | set(RC_TYPES)

    unknown_type = [q.id for q in questions if q.q_type not in known_types]
    low_tag_confidence = [
        q.id for q in questions if (q.tag_confidence or "").lower() == "low"
    ]
    quarantined = [q.id for q in questions if q.quarantined]
    official_training = [
        q.id for q in questions
        if _source_value(q.source) == QuestionSource.official.value
        and q.training_eligible
    ]
    ai_without_validator = [
        q.id for q in questions
        if _source_value(q.source) == QuestionSource.ai_generated.value
        and not gen_validators.has_validator(q.q_type)
    ]
    bad_notebook_artifacts = [
        row.id for row in session.exec(select(StudyArtifact)).all()
        if row.official_firewall and (row.cloud_allowed or row.export_eligible)
    ]
    bad_notebook_sources = [
        row.id for row in session.exec(select(NotebookSource)).all()
        if row.official_firewall and _source_value(row.provider) not in {"local", "ollama", "lmstudio", "deterministic"}
    ]
    bad_transformation_runs = []
    for row in session.exec(select(TransformationRun)).all():
        decision = row.firewall_decision_json or {}
        if (
            decision.get("official_firewall")
            and (decision.get("cloud_allowed") is not False or decision.get("export_eligible") is not False)
        ) or (
            decision.get("official_firewall")
            and _source_value(row.provider) not in {"local", "ollama", "lmstudio", "deterministic"}
        ):
            bad_transformation_runs.append(row.id)
    bad_podcast_runs = []
    for row in session.exec(select(PodcastEpisode)).all():
        decision = row.firewall_decision_json or {}
        if (
            decision.get("official_firewall")
            and (decision.get("cloud_allowed") is not False or decision.get("export_eligible") is not False)
        ) or (
            decision.get("official_firewall")
            and _source_value(row.provider) not in {"local", "ollama", "lmstudio", "deterministic"}
        ):
            bad_podcast_runs.append(row.id)
    bad_notebook_firewall = (
        bad_notebook_artifacts
        + bad_notebook_sources
        + bad_transformation_runs
        + bad_podcast_runs
    )

    active_questions = [q for q in questions if _active_duplicate_question(q)]
    duplicate_hashes = session.exec(
        select(Question.content_hash, func.count(Question.id))
        .where(Question.content_hash.is_not(None))
        .where(Question.deleted_at.is_(None))
        .where(Question.approved == True)  # noqa: E712
        .where(Question.quarantined == False)  # noqa: E712
        .group_by(Question.content_hash)
        .having(func.count(Question.id) > 1)
    ).all()
    duplicates = _duplicate_clusters(active_questions, duplicate_hashes)
    duplicate_question_ids = {
        qid
        for row in duplicates
        for qid in (row.get("question_ids") or [])
    }

    choice_counts = session.exec(
        select(AnswerChoice.question_id, func.count(AnswerChoice.id))
        .group_by(AnswerChoice.question_id)
    ).all()
    choice_count_by_qid = {int(row[0]): int(row[1]) for row in choice_counts}
    bad_choice_count = [
        q.id for q in questions
        if choice_count_by_qid.get(q.id or -1, 0) not in (0, 5)
    ]

    versions = session.exec(select(ContentVersion)).all()
    versions_by_entity: dict[str, int] = defaultdict(int)
    for row in versions:
        versions_by_entity[row.entity] += 1
    sources = session.exec(select(SourceRegistry)).all()
    validator_runs = session.exec(
        select(ValidatorRun).order_by(ValidatorRun.id.desc()).limit(50)
    ).all()
    validator_failures = Counter(
        reason
        for run in validator_runs
        for reason in (run.failure_reasons_json or [])
    )
    provenance_score = _provenance_score(
        questions,
        sources,
        duplicate_question_ids=duplicate_question_ids,
        known_types=known_types,
    )
    revalidation = revalidation_report(session, limit=20)
    # LSAT-7 — cockpit additions: a compact audit-log summary (recent content
    # edits + per-field/entity tallies) and a lexical-leak heatmap (per-source
    # answer-length tells). Both are additive keys on the health dict.
    audit_log_summary = _audit_log_summary(session, limit=20)
    lexical_leak = _lexical_leak_heatmap(session, questions)

    warnings = []
    from . import notebook_os

    index_health = {
        "knowledge_fts": notebook_os.knowledge_index_health(session),
    }
    knowledge_status = index_health["knowledge_fts"].get("status")
    knowledge_detail = index_health["knowledge_fts"].get("detail") or {}
    if official_training:
        warnings.append("official_training_eligible")
    if bad_notebook_firewall:
        warnings.append("notebook_firewall_violation")
    if knowledge_detail.get("official_body_leak_ids"):
        warnings.append("knowledge_fts_official_body_leak")
    elif knowledge_status != "ok":
        warnings.append("knowledge_fts_attention")
    if ai_without_validator:
        warnings.append("ai_generated_type_without_validator")
    if duplicates:
        warnings.append("duplicate_content_hash")
    if bad_choice_count:
        warnings.append("nonstandard_choice_count")
    if provenance_score["status"] != "ok":
        warnings.append("provenance_score_attention")

    score = 100
    score -= min(35, len(quarantined) * 4)
    score -= min(25, len(duplicates) * 8)
    score -= min(20, len(official_training) * 10)
    score -= min(15, len(unknown_type) * 3)
    score -= min(10, len(low_tag_confidence))

    return {
        "total_questions": total,
        "score": max(0, score),
        "status": "ok" if not warnings else "warning",
        "warnings": warnings,
        "by_source": dict(by_source),
        "by_q_type": dict(by_type),
        "tag_confidence": {
            "low": len(low_tag_confidence),
            "low_question_ids": low_tag_confidence[:50],
        },
        "quarantine": {
            "count": len(quarantined),
            "question_ids": quarantined[:50],
        },
        "duplicates": {
            "clusters": duplicates[:50],
            "cluster_count": len(duplicates),
        },
        "official_firewall": {
            "ok": not official_training and not bad_notebook_firewall,
            "training_eligible_official_count": len(official_training),
            "question_ids": official_training[:50],
            "notebook_violations": {
                "artifact_ids": bad_notebook_artifacts[:50],
                "source_ids": bad_notebook_sources[:50],
                "transformation_ids": bad_transformation_runs[:50],
                "podcast_ids": bad_podcast_runs[:50],
            },
        },
        "validator_coverage": {
            "ai_without_validator_count": len(ai_without_validator),
            "ai_without_validator_question_ids": ai_without_validator[:50],
            "known_validator_types": sorted(
                t for t in known_types if gen_validators.has_validator(t)
            ),
        },
        "choice_integrity": {
            "nonstandard_choice_count": len(bad_choice_count),
            "question_ids": bad_choice_count[:50],
        },
        "index_health": index_health,
        "versioning": {
            "snapshots": len(versions),
            "by_entity": dict(versions_by_entity),
        },
        "source_registry": {
            "count": len(sources),
            "sources": [
                {
                    "key": s.key,
                    "label": s.label,
                    "source_type": s.source_type,
                    "license": s.license,
                    "eligibility": s.eligibility_json or {},
                    "firewall": s.firewall_json or {},
                }
                for s in sources[:50]
            ],
        },
        "provenance_score": provenance_score,
        "audit_log_summary": audit_log_summary,
        "lexical_leak": lexical_leak,
        "validator_runs": {
            "recent_count": len(validator_runs),
            "failure_reasons": dict(validator_failures),
            "recent": [
                {
                    "id": r.id,
                    "q_type": r.q_type,
                    "section_type": r.section_type.value if hasattr(r.section_type, "value") else r.section_type,
                    "status": r.status,
                    "score": r.score,
                    "failure_reasons": r.failure_reasons_json or [],
                    "meta": r.meta_json or {},
                    "created_at": r.created_at.isoformat(),
                }
                for r in validator_runs[:20]
            ],
        },
        "revalidation": revalidation,
    }


def revalidation_report(session: Session, *, limit: int = 50) -> dict[str, Any]:
    """Queue approved AI items whose current content lacks fresh validator evidence."""
    targets = _revalidation_targets(session, limit=0, only_due=False)
    due = [row for row in targets if row["needs_revalidation"]]
    failed = [
        row for row in targets
        if str(row.get("latest_status") or "").lower() == "failed"
    ]
    stale = [
        row for row in due
        if row["reasons"] == ["missing_revalidation_run"]
    ]
    return {
        "approved_ai_count": len(targets),
        "due_count": len(due),
        "failed_count": len(failed),
        "rc_count": len([row for row in targets if row["section_type"] == "RC"]),
        "missing_evidence_count": len(stale),
        "queue": due[:limit],
        "recent_failures": failed[:limit],
        "lookback": _REVALIDATION_LOOKBACK,
        "mode": "lightweight",
    }


def remediate_revalidation_failure(
    session: Session,
    question_id: int,
    *,
    action: str = "quarantine_failed",
    reason: str = "failed_revalidation",
) -> dict[str, Any]:
    """Apply a one-click remediation to the latest failed approved-AI validation."""
    if action != "quarantine_failed":
        raise ValueError("unsupported_remediation_action")
    question = session.get(Question, question_id)
    if question is None:
        raise KeyError("question_not_found")
    if _source_value(question.source) != QuestionSource.ai_generated.value:
        raise ValueError("revalidation_remediation_requires_ai_generated")
    if not question.approved or question.quarantined:
        raise ValueError("revalidation_remediation_requires_active_approved_ai")
    latest = _latest_revalidation_runs(session).get(int(question_id))
    if latest is None:
        raise ValueError("missing_revalidation_run")
    if latest.status != "failed":
        raise ValueError("latest_revalidation_not_failed")

    version = _snapshot_question(
        session,
        question,
        reason=reason or "failed_revalidation",
        extra={
            "remediation_action": action,
            "validator_run_id": latest.id,
            "validator_failure_reasons": latest.failure_reasons_json or [],
        },
    )
    now = utcnow()
    question.quarantined = True
    question.approved = False
    question.updated_at = now
    latest.meta_json = {
        **(latest.meta_json or {}),
        "remediation_action": action,
        "remediation_reason": reason,
        "remediation_version_id": version.id,
        "remediated_at": now.isoformat(),
        "applied_quarantine": True,
    }
    session.add(question)
    session.add(latest)
    session.commit()
    session.refresh(question)
    session.refresh(latest)
    session.refresh(version)
    return {
        "ok": True,
        "action": action,
        "question_id": question.id,
        "validator_run_id": latest.id,
        "version": _content_version_payload(version),
        "question": {
            "id": question.id,
            "approved": question.approved,
            "quarantined": question.quarantined,
            "updated_at": question.updated_at.isoformat() if question.updated_at else None,
        },
        "remaining": revalidation_report(session, limit=50),
    }


def remediate_duplicate_cluster(
    session: Session,
    *,
    cluster_key: str,
    canonical_question_id: int,
    expected_question_ids: list[int] | None = None,
    action: str = "quarantine_duplicates",
    reason: str = "duplicate_cluster_remediation",
) -> dict[str, Any]:
    """Retire duplicate rows while preserving a canonical question and audit trail."""
    if action != "quarantine_duplicates":
        raise ValueError("unsupported_remediation_action")
    questions = session.exec(select(Question)).all()
    active_questions = [q for q in questions if _active_duplicate_question(q)]
    duplicate_hashes = session.exec(
        select(Question.content_hash, func.count(Question.id))
        .where(Question.content_hash.is_not(None))
        .where(Question.deleted_at.is_(None))
        .where(Question.approved == True)  # noqa: E712
        .where(Question.quarantined == False)  # noqa: E712
        .group_by(Question.content_hash)
        .having(func.count(Question.id) > 1)
    ).all()
    clusters = _duplicate_clusters(active_questions, duplicate_hashes)
    cluster = next(
        (
            row
            for row in clusters
            if row.get("cluster_key") == cluster_key
            or row.get("content_hash") == cluster_key
        ),
        None,
    )
    if cluster is None:
        raise KeyError("duplicate_cluster_not_found")
    cluster_ids = [int(qid) for qid in cluster.get("question_ids") or []]
    if len(cluster_ids) < 2:
        raise ValueError("duplicate_cluster_requires_multiple_questions")
    if expected_question_ids:
        expected = {int(qid) for qid in expected_question_ids}
        if expected != set(cluster_ids):
            raise ValueError("duplicate_cluster_changed")
    if canonical_question_id not in cluster_ids:
        raise ValueError("canonical_question_not_in_cluster")

    canonical = session.get(Question, canonical_question_id)
    if canonical is None or not _active_duplicate_question(canonical):
        raise ValueError("canonical_question_not_active")
    duplicate_ids = [qid for qid in cluster_ids if qid != canonical_question_id]
    now = utcnow()
    versions: list[ContentVersion] = [
        _snapshot_question(
            session,
            canonical,
            reason=reason or "duplicate_cluster_remediation",
            extra={
                "remediation_action": action,
                "duplicate_cluster_key": cluster["cluster_key"],
                "duplicate_kind": cluster.get("duplicate_kind"),
                "cluster_question_ids": cluster_ids,
                "canonical_question_id": canonical_question_id,
                "quarantined_question_ids": duplicate_ids,
                "kept_as_canonical": True,
            },
        )
    ]
    quarantined_ids: list[int] = []
    for qid in duplicate_ids:
        question = session.get(Question, qid)
        if question is None or not _active_duplicate_question(question):
            raise ValueError("duplicate_question_not_active")
        versions.append(
            _snapshot_question(
                session,
                question,
                reason=reason or "duplicate_cluster_remediation",
                extra={
                    "remediation_action": action,
                    "duplicate_cluster_key": cluster["cluster_key"],
                    "duplicate_kind": cluster.get("duplicate_kind"),
                    "cluster_question_ids": cluster_ids,
                    "canonical_question_id": canonical_question_id,
                    "quarantined_question_ids": duplicate_ids,
                    "retired_as_duplicate": True,
                },
            )
        )
        question.quarantined = True
        question.approved = False
        question.deleted_at = now
        question.updated_at = now
        session.add(question)
        quarantined_ids.append(qid)
    session.commit()
    for row in versions:
        session.refresh(row)
    return {
        "ok": True,
        "action": action,
        "cluster_key": cluster["cluster_key"],
        "duplicate_kind": cluster.get("duplicate_kind"),
        "canonical_question_id": canonical_question_id,
        "quarantined_question_ids": quarantined_ids,
        "versions": [_content_version_payload(row) for row in versions],
        "remaining": health_report(session),
    }


def run_revalidation(
    session: Session,
    *,
    limit: int = 25,
    force: bool = False,
    apply_quarantine: bool = False,
    model_gate: bool = False,
    solver=None,
    critic=None,
    multi_model_solver=None,
) -> dict[str, Any]:
    """Re-run current validators for approved AI content and persist evidence.

    The default scheduled/manual mode is deterministic and offline: it exercises
    structural checks, trap metadata, RC authenticity, and type shape without
    pretending a lightweight stub is a live model adjudication. A caller can opt
    into ``model_gate=True`` to use the normal generation gate model calls.
    """
    selected = _revalidation_targets(
        session,
        limit=max(1, limit),
        only_due=not force,
    )[: max(1, limit)]
    validated: list[dict[str, Any]] = []
    quarantined_ids: list[int] = []
    for target in selected:
        question = session.get(Question, int(target["question_id"]))
        if question is None:
            continue
        cand = _candidate_from_question(session, question)
        solve_fn = solver
        critic_fn = critic
        multi_fn = multi_model_solver
        if not model_gate:
            solve_fn = solver or _lightweight_solver(question.correct_answer)
            critic_fn = critic or _lightweight_critic(question.correct_answer)
            multi_fn = multi_model_solver or (
                lambda _model, _prompt, answer=question.correct_answer: answer
            )
        verdict = generation.validate_candidate(
            cand,
            runs=3,
            solver=solve_fn or generation._generate,
            critic=critic_fn or generation._generate,
            q_type=question.q_type,
            section_type=str(target["section_type"] or ""),
            permutation_invariant=False if not model_gate else None,
            informativity=False if not model_gate else None,
            distractor_quality_enabled=False if not model_gate else None,
            multi_model_solver=multi_fn,
        )
        verdict["question_id"] = question.id
        verdict["section_type"] = target["section_type"]
        status = "passed" if verdict.get("passed") else "failed"
        run = ValidatorRun(
            q_type=question.q_type,
            section_type=_section_enum(target["section_type"]),
            status=status,
            score=generation._validator_score(verdict),
            failure_reasons_json=generation._validator_failure_reasons(verdict),
            meta_json={
                "source": _REVALIDATION_RUN_SOURCE,
                "question_id": question.id,
                "content_fingerprint": target["content_fingerprint"],
                "revalidation_reasons": target["reasons"],
                "model_gate": bool(model_gate),
                "applied_quarantine": False,
                "previous_validator_run_id": target.get("latest_run_id"),
                "verdict_reason": verdict.get("reason"),
            },
        )
        session.add(run)
        if apply_quarantine and not verdict.get("passed"):
            question.quarantined = True
            question.approved = False
            question.updated_at = utcnow()
            session.add(question)
            quarantined_ids.append(int(question.id or 0))
            run.meta_json = {**(run.meta_json or {}), "applied_quarantine": True}
        session.commit()
        session.refresh(run)
        validated.append({
            "question_id": question.id,
            "validator_run_id": run.id,
            "status": status,
            "score": run.score,
            "failure_reasons": run.failure_reasons_json or [],
            "model_gate": bool(model_gate),
            "quarantined": question.id in quarantined_ids,
        })
    passed = len([row for row in validated if row["status"] == "passed"])
    failed = len([row for row in validated if row["status"] == "failed"])
    return {
        "ok": failed == 0,
        "validated": len(validated),
        "passed": passed,
        "failed": failed,
        "quarantined": len(quarantined_ids),
        "quarantined_question_ids": quarantined_ids,
        "model_gate": bool(model_gate),
        "apply_quarantine": bool(apply_quarantine),
        "force": bool(force),
        "runs": validated,
        "remaining": revalidation_report(session, limit=limit),
    }


def _snapshot_question(
    session: Session,
    question: Question,
    *,
    reason: str,
    extra: dict[str, Any] | None = None,
) -> ContentVersion:
    question_id = int(question.id or 0)
    latest = session.exec(
        select(ContentVersion)
        .where(ContentVersion.entity == "question")
        .where(ContentVersion.entity_id == question_id)
        .order_by(ContentVersion.version.desc())
    ).first()
    row = ContentVersion(
        entity="question",
        entity_id=question_id,
        version=(latest.version if latest else 0) + 1,
        reason=reason,
        snapshot_json={
            "id": question.id,
            "stem": question.stem,
            "prompt": question.prompt,
            "correct_answer": question.correct_answer,
            "difficulty": question.difficulty,
            "q_type": question.q_type,
            "source": _source_value(question.source),
            "quarantined": question.quarantined,
            "approved": question.approved,
            "tag_confidence": question.tag_confidence,
            **(extra or {}),
        },
    )
    session.add(row)
    session.flush()
    return row


def _content_version_payload(row: ContentVersion) -> dict[str, Any]:
    return {
        "id": row.id,
        "entity": row.entity,
        "entity_id": row.entity_id,
        "version": row.version,
        "reason": row.reason,
        "snapshot": row.snapshot_json or {},
        "created_at": row.created_at.isoformat(),
    }


def _source_value(source) -> str:
    return source.value if hasattr(source, "value") else str(source)


def _active_duplicate_question(q: Question) -> bool:
    return q.deleted_at is None and q.approved and not q.quarantined


def _section_enum(value: Any) -> SectionType | None:
    raw = value.value if hasattr(value, "value") else value
    if raw in ("LR", "RC"):
        return SectionType(raw)
    return None


def _latest_revalidation_runs(session: Session) -> dict[int, ValidatorRun]:
    rows = session.exec(
        select(ValidatorRun).order_by(ValidatorRun.created_at.desc()).limit(
            _REVALIDATION_LOOKBACK
        )
    ).all()
    by_question: dict[int, ValidatorRun] = {}
    for row in rows:
        meta = row.meta_json or {}
        if meta.get("source") != _REVALIDATION_RUN_SOURCE:
            continue
        qid = meta.get("question_id")
        if isinstance(qid, int) and qid not in by_question:
            by_question[qid] = row
    return by_question


def _question_section_type(session: Session, q: Question) -> str:
    if q.passage_id:
        return "RC"
    if q.section_id:
        section = session.get(Section, q.section_id)
        if section is not None:
            value = section.type.value if hasattr(section.type, "value") else section.type
            if value in ("LR", "RC"):
                return str(value)
    return "RC" if q.q_type in RC_TYPES and q.q_type not in LR_TYPES else "LR"


def _question_choices(session: Session, q: Question) -> list[AnswerChoice]:
    return session.exec(
        select(AnswerChoice)
        .where(AnswerChoice.question_id == q.id)
        .order_by(AnswerChoice.label)
    ).all()


def _question_passage_text(session: Session, q: Question) -> str:
    if not q.passage_id:
        return ""
    passage = session.get(Passage, q.passage_id)
    return passage.text if passage is not None else ""


def _question_fingerprint(
    q: Question,
    choices: list[AnswerChoice],
    passage_text: str,
) -> str:
    payload = {
        "stem": q.stem,
        "prompt": q.prompt,
        "correct_answer": q.correct_answer,
        "difficulty": q.difficulty,
        "q_type": q.q_type,
        "passage": passage_text,
        "choices": [
            {
                "label": row.label,
                "text": row.text,
                "is_correct": bool(row.is_correct),
                "trap_type": row.trap_type,
            }
            for row in choices
        ],
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _candidate_from_question(session: Session, q: Question) -> dict[str, Any]:
    choices = _question_choices(session, q)
    return {
        "stem": q.stem,
        "prompt": q.prompt,
        "correct_answer": q.correct_answer,
        "passage": _question_passage_text(session, q),
        "choices": [
            {"label": row.label, "text": row.text, "trap_type": row.trap_type}
            for row in choices
        ],
    }


def _revalidation_targets(
    session: Session,
    *,
    limit: int,
    only_due: bool,
) -> list[dict[str, Any]]:
    latest_by_question = _latest_revalidation_runs(session)
    rows = session.exec(
        select(Question)
        .where(Question.source == QuestionSource.ai_generated)
        .where(Question.approved == True)  # noqa: E712
        .where(Question.quarantined == False)  # noqa: E712
        .order_by(Question.id)
    ).all()
    targets: list[dict[str, Any]] = []
    known_types = set(LR_TYPES) | set(RC_TYPES)
    for q in rows:
        choices = _question_choices(session, q)
        passage = _question_passage_text(session, q)
        fingerprint = _question_fingerprint(q, choices, passage)
        section_type = _question_section_type(session, q)
        latest = latest_by_question.get(int(q.id or 0))
        meta = latest.meta_json if latest else {}
        latest_fingerprint = (meta or {}).get("content_fingerprint")
        reasons: list[str] = []
        if latest is None:
            reasons.append("missing_revalidation_run")
        elif latest_fingerprint != fingerprint:
            reasons.append("content_changed")
        if latest is not None and latest.status == "failed":
            reasons.append("last_revalidation_failed")
        if q.updated_at and latest is not None and latest.created_at < q.updated_at:
            reasons.append("updated_after_revalidation")
        if len(choices) != 5:
            reasons.append("nonstandard_choice_count")
        if q.q_type not in known_types:
            reasons.append("unknown_question_type")
        elif not gen_validators.has_validator(q.q_type):
            reasons.append("missing_type_validator")
        if section_type == "RC" and not passage.strip():
            reasons.append("rc_missing_passage")
        target = {
            "question_id": q.id,
            "q_type": q.q_type,
            "section_type": section_type,
            "source": _source_value(q.source),
            "content_fingerprint": fingerprint,
            "latest_run_id": latest.id if latest else None,
            "latest_status": latest.status if latest else None,
            "latest_created_at": latest.created_at.isoformat() if latest else None,
            "needs_revalidation": bool(reasons),
            "reasons": reasons,
            "choice_count": len(choices),
            "has_passage": bool(passage.strip()),
            "updated_at": q.updated_at.isoformat() if q.updated_at else None,
        }
        if not only_due or target["needs_revalidation"]:
            targets.append(target)
    targets.sort(
        key=lambda row: (
            0 if row["needs_revalidation"] else 1,
            row["latest_created_at"] or "",
            row["question_id"] or 0,
        )
    )
    return targets[:limit] if limit > 0 else targets


def _lightweight_solver(answer: str):
    def solve(_prompt: str) -> str:
        return f"The answer is {answer}."

    return solve


def _lightweight_critic(answer: str):
    def critique(prompt: str) -> str:
        if "distractor-quality reviewer" in prompt:
            labels = [label for label in ("A", "B", "C", "D", "E") if label != answer]
            return json.dumps({
                "distractors_plausible": True,
                "plausible_labels": labels,
                "weak_distractors": [],
            })
        if "strict LSAT item reviewer" in prompt:
            return json.dumps({
                "single_defensible": True,
                "defensible_letters": [answer],
            })
        if "Respond ONLY with JSON" in prompt:
            return json.dumps({
                "negation_breaks_argument": True,
                "argument_depends_on_it": True,
                "conclusion_follows_when_added": True,
                "same_argument_form": True,
                "stimulus_is_flawed": True,
                "same_flaw": True,
                "has_tension": True,
                "choice_resolves_tension": True,
                "strengthens": True,
                "weakens": True,
                "credited_supported_by_passage": True,
                "requires_outside_knowledge": False,
                "single_best_answer": True,
                "distractor_flaws": [
                    {"label": label, "flaw": "not supported by the passage", "clear": True}
                    for label in ("A", "B", "C", "D", "E")
                    if label != answer
                ],
            })
        return f"The answer is {answer}."

    return critique


def _question_source_key(q: Question) -> str:
    external_id = q.external_id or ""
    for key in DATASETS:
        if external_id.startswith(f"{key}:"):
            return key
    return _source_value(q.source)


def _duplicate_clusters(
    questions: list[Question],
    duplicate_hashes: list[Any],
) -> list[dict[str, Any]]:
    counts_by_hash = {
        str(row[0]): int(row[1])
        for row in duplicate_hashes
        if row[0]
    }
    if not counts_by_hash:
        hash_clusters: list[dict[str, Any]] = []
    else:
        by_hash: dict[str, list[Question]] = defaultdict(list)
        for q in questions:
            if q.content_hash in counts_by_hash:
                by_hash[str(q.content_hash)].append(q)

        hash_clusters = []
        for content_hash, count in counts_by_hash.items():
            rows = sorted(by_hash.get(content_hash, []), key=lambda q: q.id or 0)
            hash_clusters.append(_duplicate_cluster_payload(
                key=content_hash,
                rows=rows,
                count=count,
                duplicate_kind="content_hash",
            ))

    clustered_ids = {
        qid
        for cluster in hash_clusters
        for qid in (cluster.get("question_ids") or [])
    }
    by_text: dict[str, list[Question]] = defaultdict(list)
    for q in questions:
        normalized = _duplicate_text_key(q)
        if normalized:
            by_text[normalized].append(q)

    text_clusters: list[dict[str, Any]] = []
    for normalized, rows in by_text.items():
        unique_rows = [
            q for q in sorted(rows, key=lambda item: item.id or 0)
            if q.id not in clustered_ids
        ]
        if len(unique_rows) < 2:
            continue
        digest = hashlib.sha1(normalized.encode("utf-8")).hexdigest()[:12]
        text_clusters.append(_duplicate_cluster_payload(
            key=f"text:{digest}",
            rows=unique_rows,
            count=len(unique_rows),
            duplicate_kind="normalized_text",
        ))

    clusters = hash_clusters + text_clusters
    clusters.sort(key=lambda row: (-int(row["count"]), row["cluster_key"]))
    return clusters


def _duplicate_text_key(q: Question) -> str:
    text = " ".join((q.stem or "", q.prompt or "")).strip().lower()
    text = " ".join(text.split())
    return text if len(text) >= 40 else ""


def _duplicate_cluster_payload(
    *,
    key: str,
    rows: list[Question],
    count: int,
    duplicate_kind: str,
) -> dict[str, Any]:
    source_mix = Counter(_question_source_key(q) for q in rows)
    q_type_mix = Counter(q.q_type or "unknown" for q in rows)
    canonical = min(rows, key=_duplicate_canonical_sort_key) if rows else None
    question_ids = [q.id for q in rows if q.id is not None][:25]
    sample = ""
    for q in rows:
        sample = (q.stem or q.prompt or "").strip()
        if sample:
            break
    return {
        "cluster_key": key,
        "content_hash": key,
        "duplicate_kind": duplicate_kind,
        "count": count,
        "question_ids": question_ids,
        "recommended_canonical_id": canonical.id if canonical else None,
        "quarantine_candidate_ids": [
            qid for qid in question_ids if canonical is None or qid != canonical.id
        ],
        "source_mix": dict(source_mix),
        "q_type_mix": dict(q_type_mix),
        "sample": sample[:240],
    }


def _duplicate_canonical_sort_key(q: Question) -> tuple[int, int, int]:
    source_rank = {
        QuestionSource.official.value: 0,
        QuestionSource.sample.value: 1,
        QuestionSource.research.value: 2,
        QuestionSource.reclor.value: 3,
        QuestionSource.ai_generated.value: 4,
    }.get(_source_value(q.source), 5)
    return (source_rank, 0 if q.training_eligible else 1, int(q.id or 0))


def _source_defaults(key: str) -> dict[str, Any]:
    if key in DATASETS:
        spec = DATASETS[key]
        export_allowed = not spec.requires_nc_acknowledgement
        return {
            "key": key,
            "label": spec.preptest_name or key,
            "source_type": _source_value(spec.question_source),
            "license": spec.license or None,
            "eligibility": {
                "export": export_allowed,
                "training": export_allowed,
                "score_anchor": False,
                "requires_nc_acknowledgement": spec.requires_nc_acknowledgement,
            },
            "firewall": {
                "cloud": export_allowed,
                "training": export_allowed,
                "official_firewall": False,
            },
            "seeded_from": "dataset_spec",
        }
    if key == QuestionSource.official.value:
        return {
            "key": key,
            "label": "Official/user-owned LSAT content",
            "source_type": "official",
            "license": "user-owned personal study",
            "eligibility": {"export": False, "training": False, "score_anchor": True},
            "firewall": {"cloud": False, "training": False, "official_firewall": True},
            "seeded_from": "builtin",
        }
    if key == QuestionSource.sample.value:
        return {
            "key": key,
            "label": "Sample content",
            "source_type": "sample",
            "license": "app-sample",
            "eligibility": {"export": True, "training": True, "score_anchor": False},
            "firewall": {"cloud": True, "training": True, "official_firewall": False},
            "seeded_from": "builtin",
        }
    if key == QuestionSource.ai_generated.value:
        return {
            "key": key,
            "label": "AI-generated local content",
            "source_type": "ai_generated",
            "license": "local-generated",
            "eligibility": {"export": True, "training": True, "score_anchor": False},
            "firewall": {"cloud": True, "training": True, "official_firewall": False},
            "seeded_from": "builtin",
        }
    if key == QuestionSource.reclor.value:
        return {
            "key": key,
            "label": "ReClor research content",
            "source_type": "reclor",
            "license": "Non-commercial / personal research only",
            "eligibility": {
                "export": False,
                "training": False,
                "score_anchor": False,
                "requires_nc_acknowledgement": True,
            },
            "firewall": {"cloud": False, "training": False, "official_firewall": False},
            "seeded_from": "builtin",
        }
    if key == QuestionSource.research.value:
        return {
            "key": key,
            "label": "Unregistered research content",
            "source_type": "research",
            "license": None,
            "eligibility": {"export": False, "training": False, "score_anchor": False},
            "firewall": {"cloud": False, "training": False, "official_firewall": False},
            "seeded_from": "builtin",
        }
    return {
        "key": key,
        "label": key,
        "source_type": "unknown",
        "license": None,
        "eligibility": {},
        "firewall": {},
        "seeded_from": "unknown",
    }


def _merge_registry(default: dict[str, Any], row: SourceRegistry | None) -> dict[str, Any]:
    if row is None:
        return default
    return {
        **default,
        "label": row.label or default["label"],
        "source_type": row.source_type or default["source_type"],
        "license": row.license if row.license is not None else default.get("license"),
        "eligibility": {**(default.get("eligibility") or {}), **(row.eligibility_json or {})},
        "firewall": {**(default.get("firewall") or {}), **(row.firewall_json or {})},
        "seeded_from": "registry_override",
    }


def _policy_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        val = value.strip().lower()
        if val in {"true", "allow", "allowed", "yes", "y"}:
            return True
        if val in {"false", "deny", "denied", "blocked", "no", "n"}:
            return False
    return None


def _source_score(row: dict[str, Any], quality: dict[str, int]) -> tuple[int, str, list[str]]:
    score = 100
    reasons: list[str] = []
    license_text = str(row.get("license") or "").lower()
    source_type = str(row.get("source_type") or "").lower()
    eligibility = row.get("eligibility") or {}
    firewall = row.get("firewall") or {}
    cloud_allowed = _policy_bool(firewall.get("cloud"))
    training_allowed = _policy_bool(firewall.get("training"))
    export_allowed = _policy_bool(eligibility.get("export"))
    if export_allowed is None:
        export_allowed = _policy_bool(firewall.get("export"))
    is_official = source_type == "official" or row.get("key") == QuestionSource.official.value
    is_noncommercial = "non-commercial" in license_text or "noncommercial" in license_text

    if not row.get("license"):
        score -= 12
        reasons.append("license_missing")
    if row.get("seeded_from") == "unknown":
        score -= 18
        reasons.append("registry_missing")
    if is_official and cloud_allowed is not False:
        score -= 25
        reasons.append("official_cloud_not_blocked")
    if is_official and training_allowed is not False:
        score -= 25
        reasons.append("official_training_not_blocked")
    if is_official and export_allowed is not False:
        score -= 15
        reasons.append("official_export_not_blocked")
    if is_noncommercial and export_allowed:
        score -= 20
        reasons.append("noncommercial_export_allowed")
    if is_noncommercial and training_allowed:
        score -= 15
        reasons.append("noncommercial_training_allowed")
    if quality["unknown_type"]:
        score -= min(15, quality["unknown_type"] * 3)
        reasons.append("unknown_question_type")
    if quality["low_tag_confidence"]:
        score -= min(10, quality["low_tag_confidence"])
        reasons.append("low_tag_confidence")
    if quality["quarantined"]:
        score -= min(20, quality["quarantined"] * 4)
        reasons.append("quarantined_questions")
    if quality["duplicate_questions"]:
        score -= min(18, quality["duplicate_questions"] * 3)
        reasons.append("duplicate_content_hash")

    score = max(0, score)
    if score >= 90:
        status = "ok"
    elif score >= 70:
        status = "warning"
    else:
        status = "blocked"
    return score, status, reasons


def _audit_log_summary(session: Session, *, limit: int = 20) -> dict[str, Any]:
    """LSAT-7 — compact audit-log summary for the cockpit's audit-log viewer.

    Wraps :func:`audit.recent_edits` (the existing AuditLog feed) and adds tallies
    by entity and by field so the cockpit can show "what changed recently" without
    a second query path. Best-effort: never raises (the cockpit degrades to empty).
    """
    from . import audit

    try:
        recent = audit.recent_edits(session, limit=max(1, min(limit, 200)))
    except Exception:
        recent = []
    by_entity: Counter = Counter()
    by_field: Counter = Counter()
    for row in recent:
        by_entity[str(row.get("entity") or "unknown")] += 1
        by_field[str(row.get("field") or "unknown")] += 1
    return {
        "total_recent": len(recent),
        "by_entity": dict(by_entity),
        "by_field": dict(by_field),
        "recent": recent[:limit],
    }


def _lexical_leak_heatmap(
    session: Session, questions: list[Question]
) -> dict[str, Any]:
    """LSAT-7 — lexical-leak heatmap: per-source answer-length tells.

    A length tell (the credited choice being the uniquely longest/shortest option)
    is the classic verbatim/format leak the generation validators screen for. This
    aggregates it per source so the cockpit can render a heatmap of where leaks
    concentrate. Reuses :func:`audit._has_length_tell` for the exact same rule.
    """
    from . import audit

    choices_by_q: dict[int, list[AnswerChoice]] = defaultdict(list)
    for c in session.exec(select(AnswerChoice)).all():
        choices_by_q[c.question_id].append(c)
    leak_counts: Counter = Counter()
    totals: Counter = Counter()
    for q in questions:
        key = _question_source_key(q)
        totals[key] += 1
        cs = choices_by_q.get(q.id or -1, [])
        if cs and audit._has_length_tell(cs, q.correct_answer):
            leak_counts[key] += 1
    cells = sorted(
        (
            {
                "source": key,
                "length_tell": leak_counts[key],
                "total": totals[key],
                "rate": round(leak_counts[key] / totals[key], 3) if totals[key] else 0.0,
            }
            for key in totals
        ),
        key=lambda row: (-row["length_tell"], -row["rate"], row["source"]),
    )
    return {
        "total_length_tells": sum(leak_counts.values()),
        "sources_with_leaks": len([c for c in cells if c["length_tell"]]),
        "cells": cells,
    }


def _provenance_score(
    questions: list[Question],
    sources: list[SourceRegistry],
    *,
    duplicate_question_ids: set[int],
    known_types: set[str],
) -> dict[str, Any]:
    registry_by_key = {row.key: row for row in sources}
    source_keys = (
        {_question_source_key(q) for q in questions}
        | set(registry_by_key)
        | set(DATASETS)
        | {
            QuestionSource.official.value,
            QuestionSource.sample.value,
            QuestionSource.ai_generated.value,
            QuestionSource.research.value,
            QuestionSource.reclor.value,
        }
    )
    counts = Counter(_question_source_key(q) for q in questions)
    quality_by_key: dict[str, dict[str, int]] = defaultdict(
        lambda: {
            "unknown_type": 0,
            "low_tag_confidence": 0,
            "quarantined": 0,
            "duplicate_questions": 0,
        }
    )
    for q in questions:
        key = _question_source_key(q)
        if q.q_type not in known_types:
            quality_by_key[key]["unknown_type"] += 1
        if (q.tag_confidence or "").lower() == "low":
            quality_by_key[key]["low_tag_confidence"] += 1
        if q.quarantined:
            quality_by_key[key]["quarantined"] += 1
        if q.id in duplicate_question_ids:
            quality_by_key[key]["duplicate_questions"] += 1

    rows = []
    for key in sorted(source_keys):
        default = _source_defaults(key)
        row = _merge_registry(default, registry_by_key.get(key))
        quality = quality_by_key[key]
        score, status, reasons = _source_score(row, quality)
        rows.append({
            "key": key,
            "label": row["label"],
            "source_type": row["source_type"],
            "license": row.get("license"),
            "question_count": counts.get(key, 0),
            "score": score,
            "status": status,
            "reasons": reasons,
            "eligibility": row.get("eligibility") or {},
            "firewall": row.get("firewall") or {},
            "seeded_from": row.get("seeded_from"),
            "quality": dict(quality),
        })

    weighted = [row for row in rows if row["question_count"] > 0]
    if weighted:
        numerator = sum(row["score"] * row["question_count"] for row in weighted)
        denominator = sum(row["question_count"] for row in weighted)
        overall = round(numerator / max(1, denominator))
    else:
        overall = 100
    score_affecting = [
        row for row in rows
        if row["question_count"] > 0 or row["seeded_from"] == "registry_override"
    ]
    blocked = [row["key"] for row in score_affecting if row["status"] == "blocked"]
    warnings = [row["key"] for row in score_affecting if row["status"] == "warning"]
    status = "blocked" if blocked else ("warning" if warnings or overall < 90 else "ok")
    return {
        "score": overall,
        "status": status,
        "summary": (
            f"{len([row for row in rows if row['question_count'] > 0])} active sources, "
            f"{len(blocked)} blocked, {len(warnings)} warnings"
        ),
        "blocked_source_keys": blocked,
        "warning_source_keys": warnings,
        "sources": rows,
    }
