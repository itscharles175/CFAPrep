from __future__ import annotations

from sqlmodel import select

from app.models import (
    AnswerChoice,
    ContentVersion,
    Passage,
    Question,
    QuestionSource,
    SchedulerRun,
    Section,
    SectionType,
    ValidatorRun,
)


def test_notebook_pages_links_and_study_sheet(client):
    page = client.post(
        "/api/notebook/pages",
        json={
            "title": "Necessary assumption traps",
            "body": "Watch for answers that merely strengthen. Negation should break the argument.",
            "tags": ["LR", "traps"],
        },
    ).json()
    assert page["slug"] == "necessary-assumption-traps"
    link = client.post(
        f"/api/notebook/pages/{page['id']}/links",
        json={"question_id": 1, "label": "seed NA", "note": "classic gap"},
    ).json()
    assert link["question_id"] == 1
    listed = client.get("/api/notebook/pages?q=negation").json()
    assert any(row["id"] == page["id"] for row in listed)
    sheet = client.get(f"/api/notebook/pages/{page['id']}/study-sheet").json()
    assert "Necessary assumption traps" in sheet["html"]
    assert sheet["linked_types"]


def test_rc_passage_map_and_dashboard(client):
    dash = client.get("/api/rc/dashboard").json()
    assert dash["passages"] >= 1
    maps = client.get("/api/rc/passages").json()
    assert maps and maps[0]["paragraph_roles"]
    passage_id = maps[0]["passage_id"]
    persisted = client.get(f"/api/rc/passages/{passage_id}/map?persist=true").json()
    assert persisted["analysis_id"] > 0
    assert persisted["structure"]["paragraph_count"] >= 1
    assert "tag_coverage" in persisted["structure"]
    assert persisted["structure"]["tag_coverage"]["total_questions"] >= 1
    assert persisted["question_tags"]
    assert {
        "q_type",
        "scope",
        "anchor_ref",
        "requires_evidence",
        "tags",
        "tag_confidence",
    } <= set(persisted["question_tags"][0])
    refreshed = client.get("/api/rc/dashboard").json()
    assert refreshed["tag_coverage"]["total_questions"] >= 1


def test_content_ops_sources_validator_runs_and_versions(client):
    src = client.post(
        "/api/content/sources",
        json={
            "key": "official-user-import",
            "label": "User owned official imports",
            "source_type": "official",
            "license": "user-owned",
            "eligibility": {"score_anchor": True, "export": False},
            "firewall": {"training": False, "cloud": False},
        },
    ).json()
    assert src["firewall"]["cloud"] is False
    assert src["policy_review"]["requires_review"] is False
    assert src["version"]["entity"] == "source_registry"
    val = client.post(
        "/api/content/validator-runs",
        json={
            "q_type": "MainPoint",
            "section_type": "RC",
            "status": "failed",
            "score": 0.4,
            "failure_reasons": ["main_point_unclear"],
            "meta": {"candidate": "demo"},
        },
    ).json()
    assert val["failure_reasons"] == ["main_point_unclear"]
    health = client.get("/api/content/health").json()
    recent = health["validator_runs"]["recent"][0]
    assert recent["meta"]["candidate"] == "demo"
    snap = client.post("/api/content/questions/1/snapshot?reason=test").json()
    assert snap["entity"] == "question"
    versions = client.get("/api/content/versions?entity=question&entity_id=1").json()
    assert versions and versions[0]["version"] >= snap["version"]


def test_content_revalidation_queue_and_run_records_validator(client, db_session):
    q = Question(
        stem=(
            "A local council argues that its new recycling program caused waste "
            "collection costs to fall because costs fell after the program began."
        ),
        prompt="Which one of the following most weakens the argument?",
        correct_answer="B",
        difficulty=3,
        q_type="Weaken",
        source=QuestionSource.ai_generated,
        approved=True,
        quarantined=False,
    )
    db_session.add(q)
    db_session.commit()
    db_session.refresh(q)
    for label, trap in [
        ("A", "out_of_scope"),
        ("B", "none"),
        ("C", "reversal"),
        ("D", "degree"),
        ("E", "half_right"),
    ]:
        db_session.add(
            AnswerChoice(
                question_id=q.id,
                label=label,
                text=f"Choice {label} gives a plausible recycling-program response with enough detail.",
                is_correct=label == "B",
                trap_type=trap,
            )
        )
    db_session.commit()

    queue = client.get("/api/content/revalidation").json()
    assert queue["approved_ai_count"] >= 1
    assert queue["due_count"] >= 1
    assert any(row["question_id"] == q.id for row in queue["queue"])

    result = client.post(
        "/api/content/revalidation/run",
        json={"limit": 10},
    ).json()

    assert result["validated"] >= 1
    assert result["failed"] == 0
    row = db_session.exec(
        select(ValidatorRun).order_by(ValidatorRun.id.desc())
    ).first()
    assert row.status == "passed"
    assert row.meta_json["source"] == "content_health.revalidate"
    assert row.meta_json["question_id"] == q.id
    assert row.meta_json["content_fingerprint"]


def test_content_revalidation_can_quarantine_failed_item(client, db_session):
    q = Question(
        stem="Too short.",
        prompt="Which one of the following most weakens the argument?",
        correct_answer="B",
        difficulty=3,
        q_type="Weaken",
        source=QuestionSource.ai_generated,
        approved=True,
        quarantined=False,
    )
    db_session.add(q)
    db_session.commit()
    db_session.refresh(q)

    result = client.post(
        "/api/content/revalidation/run",
        json={"limit": 10, "apply_quarantine": True},
    ).json()
    db_session.refresh(q)

    assert result["failed"] >= 1
    assert q.quarantined is True
    assert q.approved is False


def test_content_revalidation_failed_row_can_be_remediated(client, db_session):
    q = Question(
        stem="A generated argument with a known failed validator trace.",
        prompt="Which one of the following most weakens the argument?",
        correct_answer="B",
        difficulty=3,
        q_type="Weaken",
        source=QuestionSource.ai_generated,
        approved=True,
        quarantined=False,
    )
    db_session.add(q)
    db_session.commit()
    db_session.refresh(q)
    run = ValidatorRun(
        q_type="Weaken",
        section_type=SectionType.LR,
        status="failed",
        score=0.2,
        failure_reasons_json=["weak_distractors"],
        meta_json={
            "source": "content_health.revalidate",
            "question_id": q.id,
            "content_fingerprint": "failed-fingerprint",
        },
    )
    db_session.add(run)
    db_session.commit()
    db_session.refresh(run)

    result = client.post(
        f"/api/content/revalidation/{q.id}/remediate",
        json={
            "action": "quarantine_failed",
            "reason": "test_failed_revalidation",
        },
    ).json()
    db_session.refresh(q)
    db_session.refresh(run)
    version = db_session.exec(
        select(ContentVersion)
        .where(ContentVersion.entity == "question")
        .where(ContentVersion.entity_id == q.id)
        .order_by(ContentVersion.version.desc())
    ).first()

    assert result["ok"] is True
    assert result["question"]["quarantined"] is True
    assert q.quarantined is True
    assert q.approved is False
    assert version is not None
    assert version.reason == "test_failed_revalidation"
    assert version.snapshot_json["approved"] is True
    assert version.snapshot_json["quarantined"] is False
    assert version.snapshot_json["remediation_action"] == "quarantine_failed"
    assert run.meta_json["remediation_action"] == "quarantine_failed"
    assert run.meta_json["remediation_version_id"] == version.id
    assert result["remaining"]["failed_count"] == 0
    history = client.get(
        "/api/content/versions",
        params={
            "reason_contains": "revalidation",
            "source_key": "ai_generated",
        },
    ).json()
    assert history[0]["id"] == version.id
    assert history[0]["snapshot"]["validator_run_id"] == run.id

    retry = client.post(
        f"/api/content/revalidation/{q.id}/remediate",
        json={"action": "quarantine_failed"},
    )
    assert retry.status_code == 400


def test_content_health_provenance_score_seeds_source_policy(client, db_session):
    q = Question(
        stem="Researchers sampled only one neighborhood before generalizing citywide.",
        prompt="Which flaw is present?",
        correct_answer="A",
        difficulty=3,
        q_type="Flaw",
        source=QuestionSource.research,
        external_id="agieval-lsat-lr:unit-1",
        content_hash="agieval-unit-1",
    )
    q2 = Question(
        stem="Researchers sampled only one neighborhood before generalizing citywide.",
        prompt="Which flaw is present?",
        correct_answer="A",
        difficulty=3,
        q_type="Flaw",
        source=QuestionSource.research,
        external_id="agieval-lsat-lr:unit-2",
        content_hash="agieval-unit-2",
    )
    db_session.add(q)
    db_session.add(q2)
    db_session.commit()

    health = client.get("/api/content/health").json()
    score = health["provenance_score"]
    by_key = {row["key"]: row for row in score["sources"]}
    duplicate = health["duplicates"]["clusters"][0]

    assert score["score"] >= 90
    assert by_key["official"]["status"] == "ok"
    assert by_key["agieval-lsat-lr"]["seeded_from"] == "dataset_spec"
    assert by_key["agieval-lsat-lr"]["license"] == "MIT"
    assert by_key["agieval-lsat-lr"]["question_count"] == 2
    assert by_key["agieval-lsat-lr"]["score"] >= 90
    assert duplicate["duplicate_kind"] == "normalized_text"
    assert duplicate["cluster_key"].startswith("text:")
    assert set(duplicate["question_ids"]) == {q.id, q2.id}
    assert duplicate["source_mix"]["agieval-lsat-lr"] == 2
    assert duplicate["q_type_mix"]["Flaw"] == 2
    assert "Researchers sampled" in duplicate["sample"]


def test_content_duplicate_cluster_can_be_remediated(client, db_session):
    q = Question(
        stem="A city sampled one neighborhood and generalized to every resident.",
        prompt="Which flaw is present?",
        correct_answer="A",
        difficulty=3,
        q_type="Flaw",
        source=QuestionSource.research,
        external_id="agieval-lsat-lr:dupe-canonical",
        content_hash="duplicate-cluster-unit-1",
    )
    duplicate = Question(
        stem="A city sampled one neighborhood and generalized to every resident.",
        prompt="Which flaw is present?",
        correct_answer="A",
        difficulty=3,
        q_type="Flaw",
        source=QuestionSource.research,
        external_id="agieval-lsat-lr:dupe-retire",
        content_hash="duplicate-cluster-unit-2",
    )
    db_session.add(q)
    db_session.add(duplicate)
    db_session.commit()
    db_session.refresh(q)
    db_session.refresh(duplicate)

    before = client.get("/api/content/health").json()
    cluster = next(
        row
        for row in before["duplicates"]["clusters"]
        if row["duplicate_kind"] == "normalized_text"
        and set(row["question_ids"]) == {q.id, duplicate.id}
    )

    result = client.post(
        "/api/content/duplicates/remediate",
        json={
            "action": "quarantine_duplicates",
            "cluster_key": cluster["cluster_key"],
            "canonical_question_id": q.id,
            "expected_question_ids": cluster["question_ids"],
            "reason": "test_duplicate_remediation",
        },
    ).json()
    db_session.refresh(q)
    db_session.refresh(duplicate)
    versions = db_session.exec(
        select(ContentVersion)
        .where(ContentVersion.entity == "question")
        .where(ContentVersion.entity_id.in_([q.id, duplicate.id]))
        .order_by(ContentVersion.entity_id)
    ).all()

    assert result["ok"] is True
    assert result["canonical_question_id"] == q.id
    assert result["quarantined_question_ids"] == [duplicate.id]
    assert q.deleted_at is None
    assert q.quarantined is False
    assert duplicate.deleted_at is not None
    assert duplicate.quarantined is True
    assert duplicate.approved is False
    assert len(versions) == 2
    assert versions[0].snapshot_json["kept_as_canonical"] is True
    assert versions[1].snapshot_json["retired_as_duplicate"] is True
    assert result["remaining"]["duplicates"]["cluster_count"] == 0
    history = client.get(
        "/api/content/versions",
        params={
            "reason_contains": "duplicate",
            "source_key": "research",
            "limit": 10,
        },
    ).json()
    assert {row["entity_id"] for row in history} == {q.id, duplicate.id}

    retry = client.post(
        "/api/content/duplicates/remediate",
        json={
            "cluster_key": cluster["cluster_key"],
            "canonical_question_id": q.id,
            "expected_question_ids": cluster["question_ids"],
        },
    )
    assert retry.status_code == 404


def test_content_health_provenance_score_flags_bad_official_policy(client):
    blocked = client.post(
        "/api/content/sources",
        json={
            "key": "official",
            "label": "Official override",
            "source_type": "official",
            "license": "official",
            "eligibility": {"export": True},
            "firewall": {"training": True, "cloud": True},
        },
    )
    assert blocked.status_code == 409
    review = blocked.json()["detail"]["review"]
    risk_codes = [risk["code"] for risk in review["risks"]]
    assert "official_cloud_not_blocked" in risk_codes
    assert "official_training_not_blocked" in risk_codes
    src = client.post(
        "/api/content/sources",
        json={
            "key": "official",
            "label": "Official override",
            "source_type": "official",
            "license": "official",
            "eligibility": {"export": True},
            "firewall": {"training": True, "cloud": True},
            "reviewed": True,
            "acknowledged_risks": risk_codes,
            "reason": "test_reviewed_bad_policy",
        },
    ).json()
    assert src["firewall"]["cloud"] is True
    assert src["policy_review"]["reviewed"] is True
    assert src["version"]["reason"] == "test_reviewed_bad_policy"
    history = client.get(
        "/api/content/versions",
        params={
            "entity": "source_registry",
            "source_key": "official",
            "risk_code": "official_cloud_not_blocked",
            "risk_severity": "blocker",
            "changed_field": "cloud",
        },
    ).json()
    assert history[0]["id"] == src["version"]["id"]
    assert history[0]["snapshot"]["policy_review"]["reviewed"] is True

    health = client.get("/api/content/health").json()
    score = health["provenance_score"]
    official = next(row for row in score["sources"] if row["key"] == "official")

    assert score["status"] in {"warning", "blocked"}
    assert official["status"] == "blocked"
    assert "official_cloud_not_blocked" in official["reasons"]
    assert "provenance_score_attention" in health["warnings"]


def test_content_version_restore_rolls_back_source_policy_and_requires_review(client):
    safe = client.post(
        "/api/content/sources",
        json={
            "key": "official",
            "label": "Official safe",
            "source_type": "official",
            "license": "official",
            "eligibility": {"export": False},
            "firewall": {"training": False, "cloud": False, "export": False},
            "reviewer_note": "Initial safe source policy.",
        },
    ).json()
    assert safe["policy_review"]["requires_review"] is False

    blocked = client.post(
        "/api/content/sources",
        json={
            "key": "official",
            "label": "Official temporary exception",
            "source_type": "official",
            "license": "official",
            "eligibility": {"export": False},
            "firewall": {"training": False, "cloud": True, "export": False},
            "reviewer_note": "Temporary exception preview.",
        },
    )
    assert blocked.status_code == 409
    risk_codes = [
        risk["code"]
        for risk in blocked.json()["detail"]["review"]["risks"]
    ]
    assert "official_cloud_not_blocked" in risk_codes

    risky = client.post(
        "/api/content/sources",
        json={
            "key": "official",
            "label": "Official temporary exception",
            "source_type": "official",
            "license": "official",
            "eligibility": {"export": False},
            "firewall": {"training": False, "cloud": True, "export": False},
            "reviewed": True,
            "acknowledged_risks": risk_codes,
            "reviewer_note": "Temporary local-only audit approval.",
            "reason": "test_reviewed_restore_source_policy",
        },
    ).json()
    version_id = risky["version"]["id"]
    assert risky["firewall"]["cloud"] is True
    assert risky["version"]["snapshot"]["reviewer_note"] == "Temporary local-only audit approval."

    rolled_back = client.post(
        f"/api/content/versions/{version_id}/restore",
        json={
            "target": "previous",
            "reviewer_note": "Rollback to safe source policy.",
        },
    ).json()
    assert rolled_back["firewall"]["cloud"] is False
    assert rolled_back["label"] == "Official safe"
    assert rolled_back["version"]["reason"] == "content_ops_source_policy_restore"
    assert rolled_back["version"]["snapshot"]["reviewer_note"] == "Rollback to safe source policy."
    assert rolled_back["version"]["snapshot"]["restore"] == {
        "from_version_id": version_id,
        "from_version": risky["version"]["version"],
        "target": "previous",
    }

    blocked_restore = client.post(
        f"/api/content/versions/{version_id}/restore",
        json={"target": "current"},
    )
    assert blocked_restore.status_code == 409
    restore_review = blocked_restore.json()["detail"]["review"]
    assert restore_review["requires_review"] is True
    assert "official_cloud_not_blocked" in restore_review["missing_acknowledgements"]

    restored = client.post(
        f"/api/content/versions/{version_id}/restore",
        json={
            "target": "current",
            "reviewed": True,
            "acknowledged_risks": [
                risk["code"] for risk in restore_review["risks"]
            ],
            "reviewer_note": "Restore reviewed source policy snapshot.",
        },
    ).json()
    assert restored["firewall"]["cloud"] is True
    assert restored["policy_review"]["reviewed"] is True
    assert (
        restored["version"]["snapshot"]["reviewer_note"]
        == "Restore reviewed source policy snapshot."
    )


def test_scheduler_execution_benchmark_and_migration_preview(client, db_session):
    defaults = client.post("/api/observability/scheduled-tasks/defaults").json()
    assert "daily_backup" in defaults["keys"]
    assert "content_revalidation" in defaults["keys"]
    run = client.post("/api/observability/scheduled-tasks/content_health_audit/run").json()
    assert run["ok"] is True
    revalidation = client.post(
        "/api/observability/scheduled-tasks/content_revalidation/run"
    ).json()
    assert revalidation["ok"] is True
    assert revalidation["result"]["model_gate"] is False
    assert db_session.exec(select(SchedulerRun)).first() is not None
    smoke = client.post("/api/observability/benchmarks/smoke").json()
    assert smoke["status"] == "ok"
    assert "content_health_ms" in smoke["metrics"]
    assert smoke["metrics"]["generation_quality_failed_cases"] == 0.0
    assert smoke["metrics"]["generation_quality_clean_pass"] == 1.0
    assert smoke["evidence"]["generation_quality"]["ok"] is True
    preview = client.get("/api/observability/migrations/dry-run").json()
    assert preview["latest_expected_version"] >= 17
    assert preview["pending_count"] == 0


def test_type_complete_validators_surface_in_content_health(client):
    health = client.get("/api/content/health").json()
    known = set(health["validator_coverage"]["known_validator_types"])
    assert {"Method", "Evaluate", "Detail", "Function", "Attitude"}.issubset(known)
    assert health["index_health"]["knowledge_fts"]["detail"]["available"] is True


def test_rc_map_handles_new_mult_paragraph_passage(client, db_session):
    sec = Section(preptest_id=1, type=SectionType.RC, order=9)
    db_session.add(sec)
    db_session.commit()
    db_session.refresh(sec)
    passage = Passage(
        section_id=sec.id,
        text=(
            "The author introduces a debate about legal interpretation.\n\n"
            "However, a recent study complicates the old view because judges vary by context.\n\n"
            "Thus the passage suggests a more modest synthesis."
        ),
        topic="law",
    )
    db_session.add(passage)
    db_session.commit()
    db_session.refresh(passage)
    q = Question(
        section_id=sec.id,
        passage_id=passage.id,
        stem="According to the passage, judges vary by context.",
        prompt="According to the passage, which detail is true?",
        correct_answer="A",
        q_type="Detail",
    )
    db_session.add(q)
    db_session.commit()
    mapped = client.get(f"/api/rc/passages/{passage.id}/map").json()
    assert mapped["paragraph_roles"][1]["role"] == "contrast_or_shift"
    assert mapped["paragraph_roles"][1]["line_ref"] == "P2"
    assert mapped["paragraph_roles"][1]["viewpoint"]["label"] == "qualified_or_opposing_view"
    assert "because" in mapped["paragraph_roles"][1]["evidence_markers"]
    assert mapped["structure"]["evidence_anchor_count"] >= 1
    assert mapped["structure"]["dominant_viewpoint"]
    assert any(ref["line_ref"] == "P2" for ref in mapped["evidence_refs"])
    assert mapped["question_tags"][0]["anchor_ref"] == "local_text"
    assert mapped["question_tags"][0]["requires_evidence"] is True
