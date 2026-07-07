"""R7 Wave 4a — storage integrity, full backup, and import robustness.

Covers:
- 5.3 complete cascade on PrepTest delete (no orphaned Attempt/SRSCard/etc.),
  the integrity-check orphan sweep, and the v8 cleanup migration.
- 5.4 soft-deleted questions excluded from section view / export / analytics,
  and the AuditLog written on bulk_tag (+ the audit-log endpoint).
- 5.5 full-fidelity backup round-trip (new user-data tables), still excluding
  official content AND official-question embeddings, idempotent re-import, and
  the verify-restore step.
- 4.4 OCR-fallback trigger logic + chunked structuring of long PrepTests.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from sqlmodel import Session, select

from app import analytics, backup, bank_export, import_pdf, serializers
from app.db import engine
from app.models import (
    Annotation,
    AnswerChoice,
    Attempt,
    AttemptChoiceEvent,
    AttemptMode,
    AuditLog,
    EmbeddingVector,
    ErrorLogEntry,
    ExplanationFeedback,
    Passage,
    Playlist,
    PrepTest,
    Question,
    QuestionSource,
    Reflection,
    Section,
    SectionType,
    Setting,
    SRSCard,
    SRSReviewLog,
    StudyPlan,
    StudySession,
)


# --- helpers ----------------------------------------------------------------
def _make_preptest_with_dependents(s: Session, *, official: bool = False) -> dict:
    """Build a PrepTest -> section -> question with EVERY kind of dependent row
    pointing at the question, so the cascade can be proven complete."""
    src = "official" if official else "sample"
    pt = PrepTest(name=f"Cascade PT {src}", source=src, is_official=official)
    s.add(pt)
    s.commit()
    s.refresh(pt)
    sec = Section(preptest_id=pt.id, type=SectionType.LR, order=0)
    s.add(sec)
    s.commit()
    s.refresh(sec)
    passage = Passage(section_id=sec.id, text="passage text")
    s.add(passage)
    s.commit()
    s.refresh(passage)
    q = Question(
        section_id=sec.id, passage_id=passage.id, stem="cascade stem",
        prompt="p?", correct_answer="A", q_type="Flaw",
        source=QuestionSource.official if official else QuestionSource.sample,
        external_id=f"cascade:{src}:1", content_hash=f"cascade-hash-{src}",
    )
    s.add(q)
    s.commit()
    s.refresh(q)
    for lbl in "ABCDE":
        s.add(AnswerChoice(question_id=q.id, label=lbl, text=lbl,
                           is_correct=(lbl == "A")))
    sess = StudySession(type="section")
    s.add(sess)
    s.commit()
    s.refresh(sess)
    att = Attempt(question_id=q.id, session_id=sess.id, mode=AttemptMode.timed,
                  chosen_answer="B", is_correct=False)
    s.add(att)
    s.commit()
    s.refresh(att)
    s.add(ErrorLogEntry(attempt_id=att.id, reason="trap"))
    s.add(AttemptChoiceEvent(attempt_id=att.id, label="B", action="select"))
    s.add(Annotation(scope="attempt", ref_id=att.id, data_json={"x": 1}))
    s.add(Annotation(scope="question", ref_id=q.id, data_json={"y": 2}))
    s.add(EmbeddingVector(kind="question", ref_id=q.id, model="m", dim=2,
                          vector_json=[0.1, 0.2]))
    card = SRSCard(question_id=q.id, origin="manual")
    s.add(card)
    s.commit()
    s.refresh(card)
    s.add(SRSReviewLog(card_id=card.id, question_id=q.id, rating=3))
    s.commit()
    return {"preptest_id": pt.id, "section_id": sec.id, "question_id": q.id,
            "attempt_id": att.id, "card_id": card.id}


# --- 5.3 complete cascade ---------------------------------------------------
def test_delete_preptest_cascade_leaves_no_orphans(db_session):
    ids = _make_preptest_with_dependents(db_session)
    qid, aid, cid = ids["question_id"], ids["attempt_id"], ids["card_id"]

    import_pdf._delete_preptest(db_session, ids["preptest_id"])

    # The question and EVERY dependent row are gone.
    assert db_session.get(Question, qid) is None
    assert db_session.get(Attempt, aid) is None
    assert db_session.get(SRSCard, cid) is None
    assert db_session.exec(
        select(AnswerChoice).where(AnswerChoice.question_id == qid)
    ).all() == []
    assert db_session.exec(
        select(ErrorLogEntry).where(ErrorLogEntry.attempt_id == aid)
    ).all() == []
    assert db_session.exec(
        select(AttemptChoiceEvent).where(AttemptChoiceEvent.attempt_id == aid)
    ).all() == []
    assert db_session.exec(
        select(SRSReviewLog).where(SRSReviewLog.question_id == qid)
    ).all() == []
    assert db_session.exec(
        select(Annotation).where(Annotation.scope == "question")
        .where(Annotation.ref_id == qid)
    ).all() == []
    assert db_session.exec(
        select(Annotation).where(Annotation.scope == "attempt")
        .where(Annotation.ref_id == aid)
    ).all() == []
    assert db_session.exec(
        select(EmbeddingVector).where(EmbeddingVector.kind == "question")
        .where(EmbeddingVector.ref_id == qid)
    ).all() == []
    # Section + passage + preptest gone too.
    assert db_session.get(Section, ids["section_id"]) is None
    assert db_session.get(PrepTest, ids["preptest_id"]) is None


def test_integrity_orphan_sweep_detects_and_migration_cleans(db_session):
    # Manually create orphans the OLD incomplete delete would have left: drop
    # the question rows out from under their dependents via raw SQL (bypassing
    # the cascade) so dangling FKs exist.
    ids = _make_preptest_with_dependents(db_session)
    qid = ids["question_id"]
    with engine.begin() as conn:
        conn.exec_driver_sql(f"DELETE FROM question WHERE id = {qid}")

    # The orphan sweep reports the dangling rows.
    report = backup.orphan_report()
    assert report["total"] > 0
    rel = report["by_relationship"]
    assert rel.get("answerchoice", 0) >= 1
    assert rel.get("attempt_question", 0) >= 1
    assert rel.get("srscard", 0) >= 1
    assert rel.get("embeddingvector_question", 0) >= 1
    assert rel.get("annotation_question", 0) >= 1

    # Re-running migration v8 cleans them up (children-before-parents).
    from app.migrations import _m008_clean_orphan_fks
    with engine.begin() as conn:
        _m008_clean_orphan_fks(conn)

    after = backup.orphan_report()
    assert after["total"] == 0


# --- 5.4 soft-delete is honored everywhere ----------------------------------
def _seed_session_with_attempt(s: Session, q: Question) -> None:
    sess = StudySession(type="section")
    s.add(sess)
    s.commit()
    s.refresh(sess)
    s.add(Attempt(question_id=q.id, session_id=sess.id, mode=AttemptMode.timed,
                  chosen_answer=q.correct_answer, is_correct=True, time_ms=1000))
    s.commit()


def test_soft_deleted_question_excluded_from_section_export_analytics(client, db_session):
    # Pick a real seeded section + question, attach an attempt, then soft-delete.
    sec = db_session.exec(select(Section)).first()
    q = db_session.exec(
        select(Question).where(Question.section_id == sec.id)
    ).first()
    _seed_session_with_attempt(db_session, q)

    # Before delete: present in the section view.
    before = client.get(f"/api/sections/{sec.id}").json()
    assert any(item["id"] == q.id for item in before["questions"])

    # Soft-delete it.
    q.deleted_at = datetime.now(timezone.utc)
    db_session.add(q)
    db_session.commit()

    # 1) Section view excludes it.
    after = client.get(f"/api/sections/{sec.id}").json()
    assert all(item["id"] != q.id for item in after["questions"])

    # 2) Export excludes it (search by stem text across the payload).
    payload = bank_export.export_bank(db_session)
    assert q.stem not in json.dumps(payload)

    # 3) Analytics: the question is dropped from the question map, so its
    #    attempt no longer contributes.
    qmap = analytics._question_map(db_session, {q.id})
    assert q.id not in qmap

    # The shared filter helper agrees.
    assert serializers.is_servable(q) is False
    servable_ids = {
        x.id for x in db_session.exec(serializers.servable_questions()).all()
    }
    assert q.id not in servable_ids


# --- 5.4 audit trail --------------------------------------------------------
def test_bulk_tag_writes_audit_log_and_bumps_updated_at(client, db_session):
    q = db_session.exec(select(Question)).first()
    old_type, old_diff = q.q_type, q.difficulty
    new_type = "Parallel" if old_type != "Parallel" else "Method"
    new_diff = 5 if old_diff != 5 else 1

    r = client.post("/api/bank/bulk-tag", json={
        "question_ids": [q.id], "q_type": new_type, "difficulty": new_diff,
    })
    assert r.status_code == 200
    assert r.json()["updated"] == 1

    # AuditLog rows written for both fields, with before/after values.
    logs = db_session.exec(
        select(AuditLog).where(AuditLog.entity == "question")
        .where(AuditLog.entity_id == q.id)
    ).all()
    fields = {log.field: (log.old_value, log.new_value) for log in logs}
    assert fields["q_type"] == (old_type, new_type)
    assert fields["difficulty"] == (str(old_diff), str(new_diff))

    # updated_at bumped.
    db_session.refresh(q)
    assert q.updated_at is not None

    # The endpoint surfaces the edits, filterable by entity_id.
    feed = client.get(f"/api/bank/audit-log?entity=question&entity_id={q.id}").json()
    assert "edits" in feed
    assert {e["field"] for e in feed["edits"]} >= {"q_type", "difficulty"}


def test_bulk_tag_no_audit_when_value_unchanged(client, db_session):
    q = db_session.exec(select(Question)).first()
    # Re-apply the SAME q_type/difficulty -> no audit rows, no spurious update.
    r = client.post("/api/bank/bulk-tag", json={
        "question_ids": [q.id], "q_type": q.q_type, "difficulty": q.difficulty,
    })
    assert r.status_code == 200
    logs = db_session.exec(
        select(AuditLog).where(AuditLog.entity_id == q.id)
    ).all()
    assert logs == []


# --- 5.5 full-fidelity backup ----------------------------------------------
def _seed_user_data(s: Session) -> Question:
    q = s.exec(select(Question)).first()
    q.external_id = q.external_id or f"portable-history-q-{q.id}"
    q.content_hash = q.content_hash or f"portable-history-hash-{q.id}"
    s.add(q)
    s.commit()
    s.refresh(q)
    s.add(StudyPlan(target_score=172, exam_date="2026-11-14", daily_minutes=75))
    s.add(Setting(key="desired_retention", value="0.93"))
    s.add(Playlist(name="My Flaw set", kind="manual", question_ids_json=[q.id]))
    s.add(Annotation(scope="question", ref_id=q.id, data_json={"hl": [1, 2]}))
    s.add(EmbeddingVector(kind="question", ref_id=q.id, model="m", dim=3,
                          vector_json=[0.4, 0.5, 0.6]))
    sess = StudySession(
        type="drill",
        started=datetime(2026, 5, 20, 12, 0, tzinfo=timezone.utc),
        ended=datetime(2026, 5, 20, 12, 12, tzinfo=timezone.utc),
        config_json={"portable_history": True},
    )
    s.add(sess)
    s.commit()
    s.refresh(sess)
    attempt = Attempt(
        question_id=q.id,
        session_id=sess.id,
        mode=AttemptMode.drill,
        chosen_answer=q.correct_answer,
        is_correct=True,
        time_ms=42000,
        created_at=datetime(2026, 5, 20, 12, 1, tzinfo=timezone.utc),
    )
    s.add(attempt)
    s.commit()
    s.refresh(attempt)
    s.add(ErrorLogEntry(attempt_id=attempt.id, reason="careless", user_note="portable note"))
    s.add(SRSCard(question_id=q.id, origin="manual", fsrs_state={"stability": 2.5}, lapses=1))
    s.add(Annotation(scope="attempt", ref_id=attempt.id, data_json={"mark": "review"}))
    s.add(Reflection(session_id=sess.id, text="solid focus today"))
    s.add(ExplanationFeedback(question_id=q.id, helpful=True, note="clear"))
    s.commit()
    return q


def test_full_backup_round_trip_includes_new_tables(db_session):
    _seed_user_data(db_session)

    payload = bank_export.export_bank(db_session)
    assert payload["schema_version"] == bank_export.SCHEMA_VERSION >= 2
    for key in ("study_plans", "settings", "playlists", "annotations",
                "embeddings", "study_sessions", "attempts", "error_log",
                "srs_cards", "reflections", "explanation_feedback"):
        assert key in payload, f"missing export section {key}"
        assert len(payload[key]) >= 1, f"empty export section {key}"

    # Re-importing into the SAME db is idempotent for the user-data tables.
    counts = bank_export.import_bank(db_session, payload)
    for key in ("study_plans", "settings", "playlists", "annotations",
                "embeddings", "study_sessions", "attempts", "error_log",
                "srs_cards", "reflections", "explanation_feedback"):
        assert counts.get(key, 0) == 0, f"{key} duplicated on re-import"

    # The verify-restore step passes.
    report = bank_export.verify_restore(db_session, payload)
    assert report["ok"] is True
    assert report["issues"] == []
    assert report["checks"]["settings"] >= 1


def test_full_backup_import_into_fresh_db_reanchors_by_external_key(db_session):
    """Export from the seeded DB, then import into a clean DB and confirm the
    user-data re-anchors (settings upsert, plans/playlists created).

    Takes the ``db_session`` fixture purely for its reset-and-seed (so this test
    starts from a clean, seeded DB regardless of test ordering)."""
    from sqlmodel import SQLModel

    from app import embeddings
    from app import seed as seed_mod
    from app.db import init_db

    # Source DB: seed + user data (db_session already reset+seeded for us).
    with Session(engine) as s:
        _seed_user_data(s)
        payload = bank_export.export_bank(s)

    # Fresh DB.
    SQLModel.metadata.drop_all(engine)
    with engine.begin() as conn:
        conn.exec_driver_sql("DROP TABLE IF EXISTS schema_migrations")
    init_db()
    embeddings.reset_cache()
    seed_mod.seed(reset=False)

    with Session(engine) as s:
        counts = bank_export.import_bank(s, payload)
        # Settings, plan, playlist, and history land in the fresh DB.
        assert s.exec(
            select(Setting).where(Setting.key == "desired_retention")
        ).first().value == "0.93"
        assert s.exec(
            select(StudyPlan).where(StudyPlan.target_score == 172)
        ).first() is not None
        assert s.exec(
            select(Playlist).where(Playlist.name == "My Flaw set")
        ).first() is not None
        assert counts["study_sessions"] >= 1
        assert counts["attempts"] >= 1
        assert counts["error_log"] >= 1
        assert counts["srs_cards"] >= 1
        assert s.exec(select(Attempt).where(Attempt.time_ms == 42000)).first() is not None
        assert s.exec(
            select(ErrorLogEntry).where(ErrorLogEntry.user_note == "portable note")
        ).first() is not None
        assert s.exec(select(SRSCard).where(SRSCard.lapses == 1)).first() is not None
        report = bank_export.verify_restore(s, payload)
        assert report["ok"] is True


# --- 5.5 firewall stays airtight (incl. embeddings) -------------------------
OFFICIAL_SENTINEL = "COPYRIGHTED-OFFICIAL-R7-WAVE4A-LEAK-9c2b"


def _add_official_question_with_embedding(s: Session) -> Question:
    pt = PrepTest(name="PT 99 (official)", source="official", is_official=True)
    s.add(pt)
    s.commit()
    s.refresh(pt)
    sec = Section(preptest_id=pt.id, type=SectionType.LR, order=1)
    s.add(sec)
    s.commit()
    s.refresh(sec)
    q = Question(
        section_id=sec.id, stem=OFFICIAL_SENTINEL, prompt="p?",
        correct_answer="C", q_type="NecessaryAssumption",
        source=QuestionSource.official, approved=True,
        external_id="off:99:1", content_hash="off-hash-99",
    )
    s.add(q)
    s.commit()
    s.refresh(q)
    for lbl in "ABCDE":
        s.add(AnswerChoice(question_id=q.id, label=lbl,
                           text=f"{OFFICIAL_SENTINEL} {lbl}", is_correct=(lbl == "C")))
    # Embedding derived from the copyrighted text — must NEVER be exported.
    s.add(EmbeddingVector(kind="question", ref_id=q.id, model="m", dim=3,
                          vector_json=[111.0, 222.0, 333.0]))
    sess = StudySession(
        type="section",
        scaled_score=180,
        config_json={"official_session_secret": OFFICIAL_SENTINEL},
    )
    s.add(sess)
    s.commit()
    s.refresh(sess)
    attempt = Attempt(
        question_id=q.id,
        session_id=sess.id,
        mode=AttemptMode.timed,
        chosen_answer="C",
        br_answer="C",
        is_correct=True,
        br_correct=True,
        time_ms=61000,
    )
    s.add(attempt)
    s.commit()
    s.refresh(attempt)
    err = ErrorLogEntry(
        attempt_id=attempt.id,
        reason="trap",
        user_note=f"{OFFICIAL_SENTINEL} error note",
        ai_diagnosis=f"{OFFICIAL_SENTINEL} diagnosis",
    )
    s.add(err)
    s.commit()
    s.refresh(err)
    s.add(EmbeddingVector(kind="note", ref_id=err.id, model="m", dim=3,
                          vector_json=[444.0, 555.0, 666.0]))
    s.add(Annotation(scope="question", ref_id=q.id,
                     data_json={"quote": OFFICIAL_SENTINEL}))
    s.add(Annotation(scope="attempt", ref_id=attempt.id,
                     data_json={"rationale": OFFICIAL_SENTINEL}))
    s.add(SRSCard(question_id=q.id, origin="manual",
                  fsrs_state={"official_secret": OFFICIAL_SENTINEL}))
    s.add(Reflection(session_id=sess.id, text=f"{OFFICIAL_SENTINEL} reflection"))
    s.add(Playlist(name="Official pinned set", kind="manual",
                   question_ids_json=[q.id]))
    s.commit()
    return q


def test_full_backup_excludes_official_content_and_embeddings(db_session):
    _add_official_question_with_embedding(db_session)
    payload = bank_export.export_bank(db_session)  # default include_official=False

    blob = json.dumps(payload)
    # Text firewall (the existing P0 guarantee).
    assert OFFICIAL_SENTINEL not in blob
    assert "off:99:1" not in blob
    assert "off-hash-99" not in blob
    # Embedding firewall (new in 5.5): no official-question vector leaks.
    assert "111.0" not in blob and "222.0" not in blob
    assert "444.0" not in blob and "555.0" not in blob
    emb_keys = {e.get("question_external_id") for e in payload.get("embeddings", [])}
    assert "off:99:1" not in emb_keys
    assert all(row.get("question_external_id") != "off:99:1" for row in payload.get("attempts", []))
    assert all(row.get("question_external_id") != "off:99:1" for row in payload.get("srs_cards", []))
    assert all("off:99:1" not in (row.get("question_external_ids") or []) for row in payload.get("playlists", []))


def test_full_backup_include_official_opt_in_keeps_embeddings(db_session):
    _add_official_question_with_embedding(db_session)
    # The in-process-only flag (never exposed over HTTP) may include official
    # content + its embeddings for a local full backup.
    payload = bank_export.export_bank(db_session, include_official=True)
    blob = json.dumps(payload)
    assert OFFICIAL_SENTINEL in blob
    emb_keys = {e.get("question_external_id") for e in payload.get("embeddings", [])}
    assert "off:99:1" in emb_keys
    assert any(row.get("question_external_id") == "off:99:1" for row in payload.get("attempts", []))


def test_import_backup_endpoint_returns_verify(client):
    exported = client.get("/api/bank/export").json()
    r = client.post(
        "/api/bank/import-backup",
        json={"payload": exported, "force_commit": True},
    )
    assert r.status_code == 200
    body = r.json()
    # Existing count keys preserved (frontend contract) + new verify block.
    assert "preptests" in body
    assert "verify" in body
    assert body["verify"]["ok"] is True


# --- 4.4 OCR fallback + chunked structuring ---------------------------------
def test_ocr_fallback_attempted_on_empty_text(monkeypatch):
    """When the embedded text layer is empty, OCR is ATTEMPTED. We mock the
    per-page OCR so no real Tesseract engine is required in the test."""
    import fitz

    # An image-only page: a black rectangle, no text layer.
    doc = fitz.open()
    page = doc.new_page()
    page.draw_rect(fitz.Rect(40, 40, 300, 300), fill=(0, 0, 0))
    pdf_bytes = doc.tobytes()
    doc.close()

    calls = {"ocr": 0}

    def fake_ocr(page):
        calls["ocr"] += 1
        return "Question 1\nOCR-RECOVERED stem.\nWhich weakens?\n" \
               "(A) a\n(B) b\n(C) c\n(D) d\n(E) e\nAnswer: B\n"

    monkeypatch.setattr(import_pdf, "_ocr_page_text", fake_ocr)
    text, warnings = import_pdf.extract_text_with_ocr(pdf_bytes)
    assert calls["ocr"] >= 1                       # OCR was attempted
    assert "OCR-RECOVERED" in text                 # OCR text used
    assert any("OCR fallback" in w for w in warnings)


def test_ocr_unavailable_warns_without_failing():
    """No OCR engine available -> no crash, a clear actionable warning, and the
    pipeline still returns (empty) instead of raising."""
    import fitz

    doc = fitz.open()
    page = doc.new_page()
    page.draw_rect(fitz.Rect(40, 40, 300, 300), fill=(0, 0, 0))
    pdf_bytes = doc.tobytes()
    doc.close()

    # _ocr_page_text already returns "" when Tesseract is absent (no monkeypatch).
    text, warnings = import_pdf.extract_text_with_ocr(pdf_bytes)
    assert text.strip() == ""
    assert any("OCR unavailable" in w for w in warnings)
    # parse_pdf surfaces the same situation without raising.
    parsed, warns = import_pdf.parse_pdf(pdf_bytes)
    assert parsed["sections"] == []
    assert warns  # at least the OCR/extraction warning


def test_chunked_structuring_handles_long_input():
    """A document longer than the old 8000-char cut is structured in full: the
    injected structurer is called once per chunk and the merged result keeps
    questions from BEYOND the first 8000 chars."""
    # Build text > 8000 chars where a UNIQUE marker lives near the very end.
    filler = ("Question N\nStim line for filler question.\nWhich weakens?\n"
              "(A) a\n(B) b\n(C) c\n(D) d\n(E) e\nAnswer: B\n") * 150
    tail_marker = "ZZ_TAIL_QUESTION_BEYOND_8000_ZZ"
    long_text = filler + f"\nQuestion 999\n{tail_marker} stem.\nWhich follows?\n" \
                         "(A) a\n(B) b\n(C) c\n(D) d\n(E) e\nAnswer: C\n"
    assert len(long_text) > 8000

    chunks = import_pdf._chunk_text(long_text)
    assert len(chunks) > 1
    # The tail marker survives chunking (it is NOT dropped at 8000 chars).
    assert any(tail_marker in c for c in chunks)

    seen_chunks: list[str] = []

    def structurer(chunk: str) -> dict:
        seen_chunks.append(chunk)
        has_tail = tail_marker in chunk
        return {
            "name": "Long PT",
            "sections": [{
                "type": "LR", "order": 0, "passages": [],
                "questions": [{
                    "stem": (tail_marker if has_tail else f"q{len(seen_chunks)}"),
                    "prompt": "q?", "q_type": "Weaken", "difficulty": 3,
                    "correct_answer": "B",
                    "choices": [{"label": x, "text": x} for x in "ABCDE"],
                }],
            }],
        }

    merged = import_pdf._ai_structure(long_text, structurer=structurer)
    assert len(seen_chunks) == len(chunks)  # one structurer call per chunk
    # All same-type sections merged into one.
    assert len(merged["sections"]) == 1
    stems = {q["stem"] for q in merged["sections"][0]["questions"]}
    assert tail_marker in stems  # content past 8000 chars made it through


def test_chunk_text_single_window_when_short():
    short = "Question 1\nstem\n(A) a\n(B) b\n(C) c\n(D) d\n(E) e\nAnswer: A\n"
    assert import_pdf._chunk_text(short) == [short]
