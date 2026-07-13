"""vNext content health and content-ops cockpit endpoints."""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from .. import audit, content_health
from ..db import get_session
from ..models import ContentVersion, Question, SourceRegistry, ValidatorRun, utcnow
from . import contentops_extensions

router = APIRouter(prefix="/content")

# LSAT-7 — drill-depth endpoints (pacing budgets + weak-type suggestions) live in
# a sibling module and are included here (no prefix on that router) so they compose
# to /api/content/* without touching the shared main.py router list.
router.include_router(contentops_extensions.router)


class SourceBody(BaseModel):
    key: str = Field(min_length=1, max_length=80)
    label: str = Field(default="", max_length=160)
    source_type: str = Field(default="unknown", max_length=60)
    license: str | None = Field(default=None, max_length=160)
    eligibility: dict[str, Any] = Field(default_factory=dict)
    firewall: dict[str, Any] = Field(default_factory=dict)
    reviewed: bool = False
    acknowledged_risks: list[str] = Field(default_factory=list)
    reviewer_note: str = Field(default="", max_length=800)
    reason: str = Field(default="source_policy_review", max_length=120)


class ValidatorRunBody(BaseModel):
    q_type: str = Field(default="", max_length=80)
    section_type: Literal["LR", "RC"] | None = None
    status: str = Field(default="unknown", max_length=40)
    score: float | None = None
    failure_reasons: list[str] = Field(default_factory=list)
    meta: dict[str, Any] = Field(default_factory=dict)


class RevalidationRunBody(BaseModel):
    limit: int = Field(default=25, ge=1, le=100)
    force: bool = False
    apply_quarantine: bool = False
    model_gate: bool = False


class RevalidationRemediationBody(BaseModel):
    action: Literal["quarantine_failed"] = "quarantine_failed"
    reason: str = Field(default="failed_revalidation", max_length=120)


class DuplicateRemediationBody(BaseModel):
    action: Literal["quarantine_duplicates"] = "quarantine_duplicates"
    cluster_key: str = Field(min_length=1, max_length=160)
    canonical_question_id: int = Field(gt=0)
    expected_question_ids: list[int] = Field(default_factory=list)
    reason: str = Field(default="duplicate_cluster_remediation", max_length=120)


class RestoreVersionBody(BaseModel):
    target: Literal["current", "previous"] = "current"
    reviewed: bool = False
    acknowledged_risks: list[str] = Field(default_factory=list)
    reviewer_note: str = Field(default="", max_length=800)
    reason: str = Field(default="content_ops_source_policy_restore", max_length=120)


@router.get("/health")
def health(session: Session = Depends(get_session)):
    return content_health.health_report(session)


@router.get("/audit-log")
def content_audit_log(
    entity: str | None = Query(default=None, max_length=60),
    entity_id: int | None = Query(default=None, gt=0),
    limit: int = Query(default=100, ge=1, le=1000),
    session: Session = Depends(get_session),
):
    """LSAT-7 — recent content edits (the AuditLog feed) for the cockpit's
    audit-log viewer, newest first, optionally scoped to one entity/id. Returns
    the rows plus by-entity/by-field tallies so the viewer can render a summary
    header without a second request."""
    rows = audit.recent_edits(session, entity=entity, entity_id=entity_id, limit=limit)
    from collections import Counter

    by_entity: Counter = Counter(str(r.get("entity") or "unknown") for r in rows)
    by_field: Counter = Counter(str(r.get("field") or "unknown") for r in rows)
    return {
        "count": len(rows),
        "by_entity": dict(by_entity),
        "by_field": dict(by_field),
        "edits": rows,
    }


@router.get("/sources")
def list_sources(session: Session = Depends(get_session)):
    rows = session.exec(select(SourceRegistry).order_by(SourceRegistry.key)).all()
    return [_source_payload(row) for row in rows]


@router.post("/sources")
def upsert_source(body: SourceBody, session: Session = Depends(get_session)):
    row = session.exec(select(SourceRegistry).where(SourceRegistry.key == body.key)).first()
    previous = _source_payload(row) if row else None
    counts = content_health.health_report(session).get("by_source", {})
    review = _source_policy_review(
        body,
        existing=previous,
        question_count=int(counts.get(body.key, 0) or 0),
    )
    missing = review["missing_acknowledgements"]
    if review["requires_review"] and (not body.reviewed or missing):
        raise HTTPException(
            status_code=409,
            detail={
                "error": "source_policy_review_required",
                "message": "Review and acknowledge source policy risks before saving.",
                "review": review,
            },
        )
    if row is None:
        row = SourceRegistry(key=body.key)
        session.add(row)
        session.flush()
    row.label = body.label
    row.source_type = body.source_type
    row.license = body.license
    row.eligibility_json = body.eligibility
    row.firewall_json = body.firewall
    row.updated_at = utcnow()
    session.add(row)
    session.flush()
    version = _snapshot_source_policy(
        session,
        row,
        previous=previous,
        review=review,
        reason=body.reason,
        reviewer_note=body.reviewer_note,
    )
    session.commit()
    session.refresh(row)
    payload = _source_payload(row)
    payload["policy_review"] = review
    payload["version"] = _version_payload(version)
    return payload


@router.get("/validator-runs")
def validator_runs(
    limit: int = Query(default=50, ge=1, le=200),
    session: Session = Depends(get_session),
):
    rows = session.exec(
        select(ValidatorRun).order_by(ValidatorRun.created_at.desc()).limit(limit)
    ).all()
    return [_validator_payload(row) for row in rows]


@router.post("/validator-runs")
def record_validator_run(body: ValidatorRunBody, session: Session = Depends(get_session)):
    row = ValidatorRun(
        q_type=body.q_type,
        section_type=body.section_type,
        status=body.status,
        score=body.score,
        failure_reasons_json=body.failure_reasons,
        meta_json=body.meta,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return _validator_payload(row)


@router.get("/revalidation")
def revalidation_queue(
    limit: int = Query(default=50, ge=1, le=200),
    session: Session = Depends(get_session),
):
    return content_health.revalidation_report(session, limit=limit)


@router.post("/revalidation/run")
def run_revalidation(
    body: RevalidationRunBody,
    session: Session = Depends(get_session),
):
    return content_health.run_revalidation(
        session,
        limit=body.limit,
        force=body.force,
        apply_quarantine=body.apply_quarantine,
        model_gate=body.model_gate,
    )


@router.post("/revalidation/{question_id}/remediate")
def remediate_revalidation(
    question_id: int,
    body: RevalidationRemediationBody,
    session: Session = Depends(get_session),
):
    try:
        return content_health.remediate_revalidation_failure(
            session,
            question_id,
            action=body.action,
            reason=body.reason,
        )
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/duplicates/remediate")
def remediate_duplicate_cluster(
    body: DuplicateRemediationBody,
    session: Session = Depends(get_session),
):
    try:
        return content_health.remediate_duplicate_cluster(
            session,
            cluster_key=body.cluster_key,
            canonical_question_id=body.canonical_question_id,
            expected_question_ids=body.expected_question_ids,
            action=body.action,
            reason=body.reason,
        )
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/versions")
def list_versions(
    entity: str | None = Query(default=None, max_length=60),
    entity_id: int | None = Query(default=None, gt=0),
    reason: str | None = Query(default=None, max_length=120),
    reason_contains: str | None = Query(default=None, max_length=120),
    source_key: str | None = Query(default=None, max_length=80),
    risk_code: str | None = Query(default=None, max_length=80),
    risk_severity: str | None = Query(default=None, max_length=40),
    changed_field: str | None = Query(default=None, max_length=40),
    limit: int = Query(default=100, ge=1, le=500),
    session: Session = Depends(get_session),
):
    stmt = select(ContentVersion).order_by(ContentVersion.created_at.desc())
    if entity:
        stmt = stmt.where(ContentVersion.entity == entity)
    if entity_id:
        stmt = stmt.where(ContentVersion.entity_id == entity_id)
    if reason:
        stmt = stmt.where(ContentVersion.reason == reason)
    if reason_contains:
        stmt = stmt.where(ContentVersion.reason.contains(reason_contains))
    needs_snapshot_filter = bool(source_key or risk_code or risk_severity or changed_field)
    rows = session.exec(stmt.limit(500 if needs_snapshot_filter else limit)).all()
    if needs_snapshot_filter:
        rows = [
            row
            for row in rows
            if _version_matches_snapshot_filters(
                row,
                source_key=source_key,
                risk_code=risk_code,
                risk_severity=risk_severity,
                changed_field=changed_field,
            )
        ][:limit]
    return [_version_payload(row) for row in rows[:limit]]


@router.post("/versions/{version_id}/restore")
def restore_version(
    version_id: int,
    body: RestoreVersionBody,
    session: Session = Depends(get_session),
):
    row = session.get(ContentVersion, version_id)
    if row is None:
        raise HTTPException(404, "Content version not found")
    if row.entity != "source_registry":
        raise HTTPException(
            400,
            "Only source registry policy snapshots can be restored from Content Ops.",
        )

    snapshot = _as_dict(row.snapshot_json)
    target = _as_dict(snapshot.get(body.target))
    if not target:
        raise HTTPException(400, f"Version does not include a {body.target} source snapshot")
    key = str(target.get("key") or "").strip()
    if not key:
        raise HTTPException(400, "Version source snapshot is missing its source key")

    source = session.get(SourceRegistry, row.entity_id)
    if source is None or source.key != key:
        source = session.exec(select(SourceRegistry).where(SourceRegistry.key == key)).first()
    previous = _source_payload(source) if source else None

    restore_body = SourceBody(
        key=key,
        label=str(target.get("label") or key),
        source_type=str(target.get("source_type") or "unknown"),
        license=target.get("license") if isinstance(target.get("license"), str) else None,
        eligibility=_as_dict(target.get("eligibility")),
        firewall=_as_dict(target.get("firewall")),
        reviewed=body.reviewed,
        acknowledged_risks=body.acknowledged_risks,
        reviewer_note=body.reviewer_note,
        reason=body.reason,
    )
    counts = content_health.health_report(session).get("by_source", {})
    review = _source_policy_review(
        restore_body,
        existing=previous,
        question_count=int(counts.get(key, 0) or 0),
    )
    missing = review["missing_acknowledgements"]
    if review["requires_review"] and (not body.reviewed or missing):
        raise HTTPException(
            status_code=409,
            detail={
                "error": "source_policy_restore_review_required",
                "message": "Review and acknowledge source policy risks before restoring.",
                "review": review,
                "version": _version_payload(row),
            },
        )

    if source is None:
        source = SourceRegistry(key=key)
        session.add(source)
        session.flush()
    source.label = restore_body.label
    source.source_type = restore_body.source_type
    source.license = restore_body.license
    source.eligibility_json = restore_body.eligibility
    source.firewall_json = restore_body.firewall
    source.updated_at = utcnow()
    session.add(source)
    session.flush()
    version = _snapshot_source_policy(
        session,
        source,
        previous=previous,
        review=review,
        reason=body.reason,
        reviewer_note=body.reviewer_note,
        restore={
            "from_version_id": row.id,
            "from_version": row.version,
            "target": body.target,
        },
    )
    session.commit()
    session.refresh(source)
    payload = _source_payload(source)
    payload["policy_review"] = review
    payload["version"] = _version_payload(version)
    return payload


@router.post("/questions/{question_id}/snapshot")
def snapshot_question(
    question_id: int,
    reason: str = Query(default="manual", max_length=120),
    session: Session = Depends(get_session),
):
    question = session.get(Question, question_id)
    if question is None:
        raise HTTPException(404, "Question not found")
    latest = session.exec(
        select(ContentVersion)
        .where(ContentVersion.entity == "question")
        .where(ContentVersion.entity_id == question_id)
        .order_by(ContentVersion.version.desc())
    ).first()
    version = (latest.version if latest else 0) + 1
    row = ContentVersion(
        entity="question",
        entity_id=question_id,
        version=version,
        reason=reason,
        snapshot_json={
            "id": question.id,
            "stem": question.stem,
            "prompt": question.prompt,
            "correct_answer": question.correct_answer,
            "difficulty": question.difficulty,
            "q_type": question.q_type,
            "source": question.source.value if hasattr(question.source, "value") else str(question.source),
            "quarantined": question.quarantined,
            "approved": question.approved,
            "tag_confidence": question.tag_confidence,
        },
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return _version_payload(row)


def _source_payload(row: SourceRegistry) -> dict[str, Any]:
    return {
        "id": row.id,
        "key": row.key,
        "label": row.label,
        "source_type": row.source_type,
        "license": row.license,
        "eligibility": row.eligibility_json or {},
        "firewall": row.firewall_json or {},
        "updated_at": row.updated_at.isoformat(),
    }


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _version_matches_snapshot_filters(
    row: ContentVersion,
    *,
    source_key: str | None,
    risk_code: str | None,
    risk_severity: str | None,
    changed_field: str | None,
) -> bool:
    snapshot = _as_dict(row.snapshot_json)
    if source_key and _snapshot_source_key(row, snapshot) != source_key:
        return False
    if risk_code or risk_severity:
        risks = _snapshot_policy_risks(snapshot)
        if not any(
            (risk_code is None or risk.get("code") == risk_code)
            and (risk_severity is None or risk.get("severity") == risk_severity)
            for risk in risks
        ):
            return False
    if changed_field and changed_field not in _source_policy_changed_fields(snapshot):
        return False
    return True


def _snapshot_source_key(row: ContentVersion, snapshot: dict[str, Any]) -> str | None:
    if row.entity == "question":
        source = snapshot.get("source")
        return str(source) if source else None
    current = _as_dict(snapshot.get("current"))
    previous = _as_dict(snapshot.get("previous"))
    review = _as_dict(snapshot.get("policy_review"))
    key = current.get("key") or previous.get("key") or review.get("source_key")
    return str(key) if key else None


def _snapshot_policy_risks(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    review = _as_dict(snapshot.get("policy_review"))
    risks = review.get("risks")
    if not isinstance(risks, list):
        return []
    return [risk for risk in risks if isinstance(risk, dict)]


def _source_policy_changed_fields(snapshot: dict[str, Any]) -> set[str]:
    previous = _as_dict(snapshot.get("previous"))
    current = _as_dict(snapshot.get("current"))
    if not current:
        return set()
    changed: set[str] = set()
    for key in ["label", "source_type", "license"]:
        if previous.get(key) != current.get(key):
            changed.add(key)
    for key in ["cloud", "training", "export"]:
        if _policy_value(previous, key) != _policy_value(current, key):
            changed.add(key)
    return changed


def _policy_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"true", "allow", "allowed", "yes", "y"}:
            return True
        if text in {"false", "deny", "denied", "blocked", "no", "n"}:
            return False
    return None


def _policy_value(source: dict[str, Any] | SourceBody, key: str) -> bool | None:
    if isinstance(source, SourceBody):
        eligibility = source.eligibility
        firewall = source.firewall
    else:
        eligibility = source.get("eligibility") or {}
        firewall = source.get("firewall") or {}
    if key == "export":
        value = _policy_bool(eligibility.get("export"))
        if value is None:
            value = _policy_bool(firewall.get("export"))
        return value
    return _policy_bool(firewall.get(key))


def _risk(code: str, severity: str, detail: str) -> dict[str, str]:
    return {"code": code, "severity": severity, "detail": detail}


def _source_policy_review(
    body: SourceBody,
    *,
    existing: dict[str, Any] | None,
    question_count: int,
) -> dict[str, Any]:
    risks: list[dict[str, str]] = []
    source_type = body.source_type.strip().lower()
    license_text = (body.license or "").strip().lower()
    is_official = source_type == "official" or body.key == "official"
    is_noncommercial = "non-commercial" in license_text or "noncommercial" in license_text
    cloud_allowed = _policy_value(body, "cloud")
    training_allowed = _policy_value(body, "training")
    export_allowed = _policy_value(body, "export")

    if not body.license:
        risks.append(_risk(
            "license_missing",
            "warning",
            "Source policy does not name a license.",
        ))
    if is_official and cloud_allowed is not False:
        risks.append(_risk(
            "official_cloud_not_blocked",
            "blocker",
            "Official content must be blocked from cloud providers.",
        ))
    if is_official and training_allowed is not False:
        risks.append(_risk(
            "official_training_not_blocked",
            "blocker",
            "Official content must be blocked from training/export reuse.",
        ))
    if is_official and export_allowed is not False:
        risks.append(_risk(
            "official_export_not_blocked",
            "blocker",
            "Official content must not be export eligible.",
        ))
    if is_noncommercial and export_allowed is True:
        risks.append(_risk(
            "noncommercial_export_allowed",
            "blocker",
            "Non-commercial sources cannot be marked export eligible.",
        ))
    if is_noncommercial and training_allowed is True:
        risks.append(_risk(
            "noncommercial_training_allowed",
            "blocker",
            "Non-commercial sources cannot be marked training eligible.",
        ))
    if body.license is None and (cloud_allowed is True or training_allowed is True):
        risks.append(_risk(
            "reuse_without_license",
            "warning",
            "Cloud or training reuse should not be enabled without license evidence.",
        ))

    if existing:
        for key, code, detail in [
            ("cloud", "cloud_policy_loosened", "Cloud firewall changes from blocked to allowed."),
            ("training", "training_policy_loosened", "Training firewall changes from blocked to allowed."),
            ("export", "export_policy_loosened", "Export eligibility changes from blocked to allowed."),
        ]:
            previous = _policy_value(existing, key)
            proposed = _policy_value(body, key)
            if previous is False and proposed is True:
                risks.append(_risk(code, "warning", detail))

    acknowledged = set(body.acknowledged_risks or [])
    required_codes = [risk["code"] for risk in risks]
    missing = [code for code in required_codes if code not in acknowledged]
    return {
        "source_key": body.key,
        "question_count": question_count,
        "requires_review": bool(risks),
        "risks": risks,
        "acknowledged_risks": sorted(acknowledged),
        "missing_acknowledgements": missing,
        "reviewed": bool(body.reviewed and not missing),
        "reviewer_note": body.reviewer_note.strip(),
    }


def _snapshot_source_policy(
    session: Session,
    source: SourceRegistry,
    *,
    previous: dict[str, Any] | None,
    review: dict[str, Any],
    reason: str,
    reviewer_note: str = "",
    restore: dict[str, Any] | None = None,
) -> ContentVersion:
    latest = session.exec(
        select(ContentVersion)
        .where(ContentVersion.entity == "source_registry")
        .where(ContentVersion.entity_id == source.id)
        .order_by(ContentVersion.version.desc())
    ).first()
    version = (latest.version if latest else 0) + 1
    row = ContentVersion(
        entity="source_registry",
        entity_id=int(source.id or 0),
        version=version,
        reason=reason or "source_policy_review",
        snapshot_json={
            "previous": previous,
            "current": _source_payload(source),
            "policy_review": review,
            "reviewer_note": reviewer_note.strip(),
            **({"restore": restore} if restore else {}),
        },
    )
    session.add(row)
    session.flush()
    return row


def _validator_payload(row: ValidatorRun) -> dict[str, Any]:
    return {
        "id": row.id,
        "q_type": row.q_type,
        "section_type": row.section_type.value if hasattr(row.section_type, "value") else row.section_type,
        "status": row.status,
        "score": row.score,
        "failure_reasons": row.failure_reasons_json or [],
        "meta": row.meta_json or {},
        "created_at": row.created_at.isoformat(),
    }


def _version_payload(row: ContentVersion) -> dict[str, Any]:
    return {
        "id": row.id,
        "entity": row.entity,
        "entity_id": row.entity_id,
        "version": row.version,
        "reason": row.reason,
        "snapshot": row.snapshot_json or {},
        "created_at": row.created_at.isoformat(),
    }
