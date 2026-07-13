"""Full question-bank JSON export / import for backup.

Why this exists
---------------
Until now the only "export" in the app was a partial dashboard dump. The bank
itself — PrepTests, sections, passages, questions, answer choices, attempts,
error log entries, SRS cards — lived in a single SQLite file that the user had
no portable way to back up before reinstalling.

Design choices
--------------
- One self-contained JSON document. Easy to read, easy to diff, easy to ship.
- Schema version stamped (`schema_version`) so future imports can migrate or
  reject incompatible payloads.
- Imports are *idempotent* on PrepTests by name: re-importing the same export
  produces no duplicates, just refreshes per-question fields. Attempt and
  SRS-card history are appended only when the parent question already exists.
- AI-generated and research items are exported with their provenance intact.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from sqlmodel import Session, select

from . import backup, config
from .dataset_normalizers import clamp_difficulty
from .models import (
    AnswerChoice,
    Annotation,
    Attempt,
    AttemptMode,
    EmbeddingVector,
    ErrorLogEntry,
    ErrorReason,
    Explanation,
    ExplanationFeedback,
    Passage,
    Playlist,
    PrepTest,
    Question,
    QuestionSource,
    Reflection,
    Setting,
    SRSCard,
    Section,
    SectionType,
    SessionType,
    StudyPlan,
    StudySession,
)

# Bumped to 2 in R7 Wave 4a (5.5): the portable JSON now carries the full set of
# the USER's data — StudyPlan, Setting, Reflection, ExplanationFeedback,
# Annotation, EmbeddingVector, Playlist — in addition to the bank + history.
# Older v1 payloads still import (the new sections are simply absent).
SCHEMA_VERSION = 2


# --- export ----------------------------------------------------------------
def _serialize_question(session: Session, q: Question) -> dict[str, Any]:
    choices = session.exec(
        select(AnswerChoice).where(AnswerChoice.question_id == q.id)
    ).all()
    explanation = session.exec(
        select(Explanation)
        .where(Explanation.question_id == q.id)
        .order_by(Explanation.id.desc())
    ).first()
    out: dict[str, Any] = {
        "stem": q.stem,
        "prompt": q.prompt,
        "correct_answer": q.correct_answer,
        "difficulty": q.difficulty,
        "q_type": q.q_type,
        "source": q.source.value if hasattr(q.source, "value") else str(q.source),
        "external_id": q.external_id,
        "content_hash": q.content_hash,
        "quarantined": q.quarantined,
        "approved": q.approved,
        "choices": [
            {
                "label": c.label,
                "text": c.text,
                "is_correct": c.is_correct,
                "trap_type": c.trap_type,
            }
            for c in sorted(choices, key=lambda c: c.label)
        ],
    }
    if explanation is not None:
        out["explanation"] = {
            "body": explanation.body,
            "per_choice": explanation.per_choice_json or {},
            "source": (
                explanation.source.value
                if hasattr(explanation.source, "value")
                else str(explanation.source)
            ),
        }
    return out


def _is_official_question(q: Question) -> bool:
    """True for copyrighted, imported real-test content (never exportable)."""
    src = q.source.value if hasattr(q.source, "value") else str(q.source)
    return src == QuestionSource.official.value


def _is_servable(q: Question) -> bool:
    """5.4: soft-deleted (tombstoned) questions are excluded from exports."""
    return getattr(q, "deleted_at", None) is None


def export_bank(
    session: Session,
    *,
    include_history: bool = True,
    include_official: bool = False,
) -> dict[str, Any]:
    """Return a JSON-ready dict containing the bank.

    ``include_history=False`` strips attempts/error log/SRS so the bundle is
    purely content — useful for sharing the structure without your study trace.

    ``include_official`` defaults to **False** — a hard provenance firewall.
    Copyrighted ``official`` content (the questions you imported from PrepTest
    PDFs you own) is NEVER written into this portable/shareable JSON: it is
    excluded both at the PrepTest level (``is_official``) and per-question
    (``source == official``) as defense in depth. Full local backup of official
    content is the SQLite snapshot in ``app/backup.py``, which never leaves the
    machine. The HTTP export endpoint hardcodes ``include_official=False`` so the
    boundary cannot be crossed over the wire; the parameter exists only for
    in-process local tooling that already has full disk access to the DB.
    """
    out: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "preptests": [],
    }

    preptests = session.exec(select(PrepTest)).all()
    for pt in preptests:
        # Provenance firewall: copyrighted official PrepTests never enter a
        # portable export (their passages + questions ARE the imported real test).
        if not include_official and pt.is_official:
            continue
        sections = session.exec(
            select(Section)
            .where(Section.preptest_id == pt.id)
            .order_by(Section.order)
        ).all()
        sec_payload = []
        for sec in sections:
            passages = session.exec(
                select(Passage).where(Passage.section_id == sec.id)
            ).all()
            questions = session.exec(
                select(Question).where(Question.section_id == sec.id)
            ).all()
            # 5.4: tombstoned questions never enter an export.
            questions = [q for q in questions if _is_servable(q)]
            if not include_official:
                # Defense in depth: drop any official question even if it somehow
                # hangs off a non-official PrepTest.
                questions = [q for q in questions if not _is_official_question(q)]
            # Provenance firewall for passages: a Passage has no source column of
            # its own (it inherits official-ness only from its parent PrepTest), so
            # emit ONLY passages referenced by an exportable question. Otherwise a
            # copyrighted official RC passage could leak via a non-official PrepTest
            # even though that section's official questions were stripped above.
            if include_official:
                export_passages = list(passages)
            else:
                referenced = {q.passage_id for q in questions if q.passage_id is not None}
                export_passages = [p for p in passages if p.id in referenced]
            passage_by_id: dict[int, int] = {
                p.id: idx for idx, p in enumerate(export_passages)
            }
            sec_payload.append({
                "type": sec.type.value if isinstance(sec.type, SectionType) else str(sec.type),
                "order": sec.order,
                "time_limit_sec": sec.time_limit_sec,
                "passages": [
                    {"text": p.text, "type": p.type, "topic": p.topic}
                    for p in export_passages
                ],
                "questions": [
                    {
                        **_serialize_question(session, q),
                        "passage_index": passage_by_id.get(q.passage_id),
                    }
                    for q in questions
                ],
            })
        out["preptests"].append({
            "name": pt.name,
            "source": pt.source,
            "date_admin": pt.date_admin,
            "is_official": pt.is_official,
            "sections": sec_payload,
        })

    # Orphan ai_generated/research items live without a section — drill bank,
    # quarantine queue. Include them so re-import preserves the drill pool.
    orphans = session.exec(
        select(Question).where(Question.section_id.is_(None))
    ).all()
    orphans = [q for q in orphans if _is_servable(q)]  # 5.4: skip tombstoned
    if not include_official:
        orphans = [q for q in orphans if not _is_official_question(q)]
    if orphans:
        out["unsectioned_questions"] = [
            _serialize_question(session, q) for q in orphans
        ]

    # --- 5.5 full-fidelity USER data ---------------------------------------
    # Build the question lookups once (no per-row re-fetch): a cross-DB key map
    # so question-referencing rows survive a restore into a fresh DB, plus the
    # set of question ids a user row is allowed to reference (servable AND, when
    # official content is excluded, non-official — the embedding/annotation
    # firewall).
    all_questions = session.exec(select(Question)).all()
    qkey: dict[int, Optional[str]] = {}
    exportable_qids: set[int] = set()
    for q in all_questions:
        qkey[q.id] = q.external_id or q.content_hash
        if not _is_servable(q):
            continue
        if not include_official and _is_official_question(q):
            continue
        exportable_qids.add(q.id)

    def _q_exportable(qid: int) -> bool:
        return qid in exportable_qids

    attempts_all = session.exec(select(Attempt)).all()
    exportable_attempts_all = [a for a in attempts_all if _q_exportable(a.question_id)]
    portable_attempts = [a for a in exportable_attempts_all if qkey.get(a.question_id)]
    exportable_attempt_ids = {
        a.id for a in exportable_attempts_all if a.id is not None
    }
    sessions_with_attempts = {a.session_id for a in attempts_all}
    exportable_session_ids = {a.session_id for a in exportable_attempts_all}

    def _attempt_exportable(attempt_id: int) -> bool:
        return attempt_id in exportable_attempt_ids

    def _session_exportable(session_id: int) -> bool:
        # Keep sessions with no question attempts: they may be generic notebook
        # or planning reflections. Sessions tied only to official questions are
        # dropped from portable exports with their answer-key-bearing attempts.
        return session_id in exportable_session_ids or session_id not in sessions_with_attempts

    # Study plans (goal: target score + date). Standalone user config.
    plans = session.exec(select(StudyPlan)).all()
    out["study_plans"] = [
        {
            "target_score": p.target_score,
            "exam_date": p.exam_date,
            "daily_minutes": p.daily_minutes,
            "active": p.active,
            "created_at": p.created_at.isoformat() if p.created_at else None,
        }
        for p in plans
    ]

    # Runtime settings (key/value). Secrets are never stored here (see model).
    settings = session.exec(select(Setting)).all()
    out["settings"] = [{"key": s.key, "value": s.value} for s in settings]

    # Saved replayable problem sets ("smart sets").
    playlists = session.exec(select(Playlist)).all()
    out["playlists"] = [
        {
            "name": pl.name,
            "kind": pl.kind,
            "criteria": pl.criteria_json or {},
            # Translate pinned local ids -> external keys so a manual playlist
            # re-anchors after a restore.
            "question_external_ids": [
                qkey.get(qid) for qid in (pl.question_ids_json or [])
                if _q_exportable(qid) and qkey.get(qid)
            ],
            "created_at": pl.created_at.isoformat() if pl.created_at else None,
            "updated_at": pl.updated_at.isoformat() if pl.updated_at else None,
        }
        for pl in playlists
    ]

    # Highlights / margin notes. Question-scoped marks travel by external key;
    # attempt-scoped marks keep their (non-portable) attempt ref for completeness.
    annotations = session.exec(select(Annotation)).all()
    ann_out: list[dict] = []
    for a in annotations:
        if a.scope == "question":
            if not _q_exportable(a.ref_id):
                continue
            ann_out.append({
                "scope": "question",
                "question_external_id": qkey.get(a.ref_id),
                "data": a.data_json or {},
                "updated_at": a.updated_at.isoformat() if a.updated_at else None,
            })
        elif a.scope == "attempt":
            if not _attempt_exportable(a.ref_id):
                continue
            ann_out.append({
                "scope": a.scope,
                "ref_id": a.ref_id,
                "data": a.data_json or {},
                "updated_at": a.updated_at.isoformat() if a.updated_at else None,
            })
    out["annotations"] = ann_out

    # Local embeddings. FIREWALL: a question embedding derives from the
    # (possibly copyrighted) question text, so when official content is excluded
    # we drop every kind=="question" vector whose ref is an official question.
    embeddings_rows = session.exec(select(EmbeddingVector)).all()
    emb_out: list[dict] = []
    for ev in embeddings_rows:
        if ev.kind == "question":
            if not _q_exportable(ev.ref_id):
                continue
            emb_out.append({
                "kind": "question",
                "question_external_id": qkey.get(ev.ref_id),
                "model": ev.model,
                "dim": ev.dim,
                "vector": list(ev.vector_json or []),
            })
        elif ev.kind == "note":
            # Note vectors reference an ErrorLogEntry id. Drop vectors for notes
            # attached to official-question attempts: embeddings are derived
            # artifacts and can carry information about local-only material.
            err = session.get(ErrorLogEntry, ev.ref_id)
            if err is None or not _attempt_exportable(err.attempt_id):
                continue
            emb_out.append({
                "kind": ev.kind,
                "ref_id": ev.ref_id,
                "model": ev.model,
                "dim": ev.dim,
                "vector": list(ev.vector_json or []),
            })
    out["embeddings"] = emb_out

    if include_history:
        sessions = session.exec(select(StudySession)).all()
        out["study_sessions"] = [
            {
                "id": s.id,
                "type": s.type.value if hasattr(s.type, "value") else str(s.type),
                "started": s.started.isoformat() if s.started else None,
                "ended": s.ended.isoformat() if s.ended else None,
                "scaled_score": s.scaled_score,
                "config": s.config_json or {},
            }
            for s in sessions
            if s.id is not None and _session_exportable(s.id)
        ]
        out["attempts"] = [
            {
                "id": a.id,
                "question_external_id": qkey.get(a.question_id),
                "session_id": a.session_id,
                "mode": a.mode.value if hasattr(a.mode, "value") else str(a.mode),
                "chosen_answer": a.chosen_answer,
                "br_answer": a.br_answer,
                "is_correct": a.is_correct,
                "br_correct": a.br_correct,
                "time_ms": a.time_ms,
                "flagged": a.flagged,
                "confidence": (
                    a.confidence.value if hasattr(a.confidence, "value")
                    else (a.confidence if a.confidence else None)
                ),
                "created_at": a.created_at.isoformat() if a.created_at else None,
            }
            for a in portable_attempts
        ]
        errors = session.exec(select(ErrorLogEntry)).all()
        out["error_log"] = [
            {
                "id": e.id,
                "attempt_id": e.attempt_id,
                "reason": e.reason.value if hasattr(e.reason, "value") else str(e.reason),
                "user_note": e.user_note,
                "ai_diagnosis": e.ai_diagnosis,
            }
            for e in errors
            if _attempt_exportable(e.attempt_id)
        ]
        cards = session.exec(select(SRSCard)).all()
        out["srs_cards"] = [
            {
                "question_external_id": qkey.get(c.question_id),
                "fsrs_state": c.fsrs_state or {},
                "due_date": c.due_date.isoformat() if c.due_date else None,
                "lapses": c.lapses,
                "origin": c.origin,
                "leech": c.leech,
                "last_reviewed": c.last_reviewed.isoformat() if c.last_reviewed else None,
            }
            for c in cards
            if _q_exportable(c.question_id) and qkey.get(c.question_id)
        ]
        # Study reflections (journal entries attached to a session).
        reflections = session.exec(select(Reflection)).all()
        out["reflections"] = [
            {
                "session_id": r.session_id,
                "text": r.text,
                "prompts": r.prompts_json or [],
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "updated_at": r.updated_at.isoformat() if r.updated_at else None,
            }
            for r in reflections
            if _session_exportable(r.session_id)
        ]
        # Explanation thumbs up/down (+ note). Travels by question external key;
        # firewall drops feedback on official questions.
        feedback = session.exec(select(ExplanationFeedback)).all()
        out["explanation_feedback"] = [
            {
                "question_external_id": qkey.get(f.question_id),
                "helpful": f.helpful,
                "note": f.note,
                "created_at": f.created_at.isoformat() if f.created_at else None,
            }
            for f in feedback
            if _q_exportable(f.question_id)
        ]
    return out


def _question_external_key(session: Session, qid: int) -> Optional[str]:
    """Stable cross-DB key for a Question: external_id, then content_hash."""
    q = session.get(Question, qid)
    if q is None:
        return None
    return q.external_id or q.content_hash


# --- import ----------------------------------------------------------------
def _ensure_preptest(session: Session, payload: dict[str, Any]) -> PrepTest:
    name = payload.get("name", "Imported PrepTest")
    pt = session.exec(select(PrepTest).where(PrepTest.name == name)).first()
    if pt is None:
        pt = PrepTest(
            name=name,
            source=payload.get("source", "imported"),
            date_admin=payload.get("date_admin"),
            is_official=bool(payload.get("is_official", False)),
        )
        session.add(pt)
        # B4a atomicity: flush (not commit) so the whole import_bank rolls back
        # as one unit if a later record is malformed.
        session.flush()
        session.refresh(pt)
    return pt


def _section_key(section: Section) -> str:
    return f"{section.type.value}:{section.order}"


def _ensure_section(session: Session, preptest_id: int,
                    payload: dict[str, Any]) -> Section:
    existing = session.exec(
        select(Section)
        .where(Section.preptest_id == preptest_id)
        .where(Section.type == SectionType(payload.get("type", "LR")))
        .where(Section.order == int(payload.get("order", 0)))
    ).first()
    if existing is not None:
        return existing
    section = Section(
        preptest_id=preptest_id,
        type=SectionType(payload.get("type", "LR")),
        order=int(payload.get("order", 0)),
        time_limit_sec=int(payload.get("time_limit_sec", 2100) or 2100),
    )
    session.add(section)
    session.flush()  # B4a atomicity: id without committing the open transaction
    session.refresh(section)
    return section


def _resolve_existing_question(session: Session,
                               payload: dict[str, Any]) -> Optional[Question]:
    ext = payload.get("external_id")
    if ext:
        q = session.exec(
            select(Question).where(Question.external_id == ext)
        ).first()
        if q is not None:
            return q
    h = payload.get("content_hash")
    if h:
        q = session.exec(
            select(Question).where(Question.content_hash == h)
        ).first()
        if q is not None:
            return q
    return None


def _clamp_import_source(raw: Any) -> QuestionSource:
    """Resolve a payload ``source`` to a QuestionSource for the OVER-THE-WIRE
    import path, clamping any incoming ``official`` to a non-official value.

    swarm #46: ``source='official'`` marks copyrighted, score-affecting real-test
    content. The portable import path (``import_bank`` / ``import-backup``) must
    NOT be able to mint official rows from a crafted payload — only the in-process
    dataset importer is trusted to set ``official``. So a payload claiming
    ``official`` is demoted to ``sample`` here; unknown values also fall back to
    ``sample`` (matching the prior ``QuestionSource(..., 'sample')`` default).
    """
    try:
        src = QuestionSource(raw) if raw is not None else QuestionSource.sample
    except (TypeError, ValueError):
        return QuestionSource.sample
    if src == QuestionSource.official:
        return QuestionSource.sample
    return src


def _commit_question(session: Session, payload: dict[str, Any], *,
                     section_id: Optional[int], passage_id: Optional[int]) -> Question:
    existing = _resolve_existing_question(session, payload)
    if existing is not None:
        # Refresh mutable fields without reinserting choices/explanation.
        existing.section_id = existing.section_id or section_id
        existing.passage_id = existing.passage_id or passage_id
        existing.q_type = payload.get("q_type", existing.q_type)
        existing.difficulty = clamp_difficulty(payload.get("difficulty"), existing.difficulty)
        existing.quarantined = bool(payload.get("quarantined", existing.quarantined))
        existing.approved = bool(payload.get("approved", existing.approved))
        # swarm #46: the existing-row path deliberately never writes ``source`` —
        # a payload can neither promote a row TO official nor demote a legitimate
        # in-process official row. (Minting via the new-row path is blocked by
        # _clamp_import_source below.)
        session.add(existing)
        session.flush()  # B4a atomicity: stay inside the import transaction
        return existing

    q = Question(
        section_id=section_id,
        passage_id=passage_id,
        stem=payload.get("stem", ""),
        prompt=payload.get("prompt", ""),
        correct_answer=payload.get("correct_answer", "A"),
        difficulty=clamp_difficulty(payload.get("difficulty")),
        q_type=payload.get("q_type", "Inference"),
        source=_clamp_import_source(payload.get("source", "sample")),
        external_id=payload.get("external_id"),
        content_hash=payload.get("content_hash"),
        quarantined=bool(payload.get("quarantined", False)),
        approved=bool(payload.get("approved", True)),
    )
    session.add(q)
    session.flush()  # B4a atomicity: get q.id without committing
    session.refresh(q)
    for c in payload.get("choices", []):
        session.add(AnswerChoice(
            question_id=q.id,
            label=c.get("label", "?"),
            text=c.get("text", ""),
            is_correct=bool(c.get("is_correct", False)),
            trap_type=c.get("trap_type"),
        ))
    session.flush()
    return q


def import_bank(session: Session, payload: dict[str, Any]) -> dict[str, int]:
    """Apply a bank export back to the DB. Returns insertion counts."""
    schema = payload.get("schema_version")
    if schema is not None and int(schema) > SCHEMA_VERSION:
        raise ValueError(
            f"Bank export schema_version={schema} is newer than this build "
            f"(supports up to {SCHEMA_VERSION}). Upgrade LSAT Lab to import it."
        )

    counts = {"preptests": 0, "questions": 0, "questions_existing": 0,
              "unsectioned": 0}

    # B4a (Codex #3): the ENTIRE import is one transaction. Helpers flush (never
    # commit) so a malformed later record cannot leave a half-written bank — any
    # exception rolls back ALL of it. ``begin_nested`` opens a SAVEPOINT (the same
    # atomic-import pattern import_dataset/import_pdf use); the trailing commit
    # makes it durable only once every record landed.
    try:
        with session.begin_nested():
            for pt_payload in payload.get("preptests", []):
                pt = _ensure_preptest(session, pt_payload)
                counts["preptests"] += 1
                for sec_payload in pt_payload.get("sections", []):
                    section = _ensure_section(session, pt.id, sec_payload)
                    passage_ids: list[int] = []
                    for p in sec_payload.get("passages", []):
                        pas = Passage(
                            section_id=section.id,
                            text=p.get("text", ""),
                            type=p.get("type"),
                            topic=p.get("topic"),
                        )
                        session.add(pas)
                        session.flush()
                        session.refresh(pas)
                        passage_ids.append(pas.id)
                    for q_payload in sec_payload.get("questions", []):
                        idx = q_payload.get("passage_index")
                        passage_id = (
                            passage_ids[idx]
                            if idx is not None and 0 <= idx < len(passage_ids)
                            else None
                        )
                        pre_existing = _resolve_existing_question(session, q_payload)
                        _commit_question(
                            session, q_payload,
                            section_id=section.id, passage_id=passage_id,
                        )
                        if pre_existing is None:
                            counts["questions"] += 1
                        else:
                            counts["questions_existing"] += 1

            for q_payload in payload.get("unsectioned_questions", []):
                pre_existing = _resolve_existing_question(session, q_payload)
                _commit_question(session, q_payload, section_id=None, passage_id=None)
                if pre_existing is None:
                    counts["unsectioned"] += 1
                    counts["questions"] += 1
                else:
                    counts["questions_existing"] += 1

            # --- 5.5 full-fidelity USER data (idempotent) ------------------
            _import_user_data(session, payload, counts)
    except Exception:
        session.rollback()
        raise

    session.commit()
    return counts


def _question_by_external_key(session: Session, key: Optional[str]) -> Optional[Question]:
    """Resolve an exported question external key (external_id, then content_hash)
    back to a local Question."""
    if not key:
        return None
    q = session.exec(select(Question).where(Question.external_id == key)).first()
    if q is not None:
        return q
    return session.exec(select(Question).where(Question.content_hash == key)).first()


def _parse_dt(value: Any) -> Optional[datetime]:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:
        return None


def _dt_key(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value.isoformat(timespec="microseconds")


def _enum_value(enum_cls, value: Any, default):
    try:
        return enum_cls(value)
    except (TypeError, ValueError):
        return default


def _same_jsonish(a: Any, b: Any) -> bool:
    return (a or {}) == (b or {})


def _import_user_data(session: Session, payload: dict[str, Any],
                      counts: dict[str, int]) -> None:
    """Idempotently restore the 5.5 USER-data tables. Each block matches on a
    natural key so re-importing the same payload is a no-op (no duplicates)."""
    for k in ("study_plans", "settings", "playlists", "annotations",
              "embeddings", "study_sessions", "attempts", "error_log",
              "srs_cards", "reflections", "explanation_feedback"):
        counts.setdefault(k, 0)

    # Study plans: dedup by (target_score, exam_date, daily_minutes, created_at).
    for p in payload.get("study_plans", []) or []:
        exists = session.exec(
            select(StudyPlan)
            .where(StudyPlan.target_score == int(p.get("target_score", 165)))
            .where(StudyPlan.exam_date == p.get("exam_date"))
            .where(StudyPlan.daily_minutes == int(p.get("daily_minutes", 60)))
        ).first()
        if exists is not None:
            continue
        session.add(StudyPlan(
            target_score=int(p.get("target_score", 165)),
            exam_date=p.get("exam_date"),
            daily_minutes=int(p.get("daily_minutes", 60)),
            active=bool(p.get("active", True)),
        ))
        counts["study_plans"] += 1

    # Settings: upsert by key.
    for s in payload.get("settings", []) or []:
        key = s.get("key")
        if not key:
            continue
        row = session.get(Setting, key)
        if row is None:
            session.add(Setting(key=key, value=s.get("value", "")))
            counts["settings"] += 1
        else:
            row.value = s.get("value", "")
            session.add(row)

    # Playlists: dedup by (name, kind); re-anchor pinned question ids by key.
    for pl in payload.get("playlists", []) or []:
        name = pl.get("name")
        if not name:
            continue
        exists = session.exec(
            select(Playlist)
            .where(Playlist.name == name)
            .where(Playlist.kind == pl.get("kind", "smart"))
        ).first()
        if exists is not None:
            continue
        qids: list[int] = []
        for key in pl.get("question_external_ids", []) or []:
            q = _question_by_external_key(session, key)
            if q is not None:
                qids.append(q.id)
        session.add(Playlist(
            name=name,
            kind=pl.get("kind", "smart"),
            criteria_json=pl.get("criteria", {}) or {},
            question_ids_json=qids,
        ))
        counts["playlists"] += 1

    # B4a: flush (not commit) — _import_user_data now runs inside import_bank's
    # single transaction, so every block stays atomic with the bank import.
    session.flush()

    session_id_map: dict[int, int] = {}
    attempt_id_map: dict[int, int] = {}
    error_id_map: dict[int, int] = {}

    # Study sessions: map exported ids to existing/new local ids by stable
    # session shape, never by raw primary key alone.
    for payload_session in payload.get("study_sessions", []) or []:
        exported_id = payload_session.get("id")
        session_type = _enum_value(
            SessionType, payload_session.get("type", "drill"), SessionType.drill
        )
        started = _parse_dt(payload_session.get("started")) or datetime.now(timezone.utc)
        ended = _parse_dt(payload_session.get("ended"))
        scaled = payload_session.get("scaled_score")
        config_json = payload_session.get("config", {}) or {}
        existing = None
        for row in session.exec(select(StudySession)).all():
            if (
                row.type == session_type
                and _dt_key(row.started) == _dt_key(started)
                and _dt_key(row.ended) == _dt_key(ended)
                and row.scaled_score == scaled
                and _same_jsonish(row.config_json, config_json)
            ):
                existing = row
                break
        if existing is None:
            existing = StudySession(
                type=session_type,
                started=started,
                ended=ended,
                scaled_score=scaled,
                config_json=config_json,
            )
            session.add(existing)
            session.flush()  # B4a: id within the import transaction
            session.refresh(existing)
            counts["study_sessions"] += 1
        if exported_id is not None and existing.id is not None:
            session_id_map[int(exported_id)] = existing.id

    # Attempts: re-anchor by question external key + remapped session. This
    # restores answer history only for questions present in the portable bundle.
    for payload_attempt in payload.get("attempts", []) or []:
        exported_id = payload_attempt.get("id")
        q = _question_by_external_key(session, payload_attempt.get("question_external_id"))
        old_sid = payload_attempt.get("session_id")
        local_sid = session_id_map.get(int(old_sid)) if old_sid is not None else None
        if q is None or local_sid is None:
            continue
        created_at = _parse_dt(payload_attempt.get("created_at")) or datetime.now(timezone.utc)
        mode = _enum_value(AttemptMode, payload_attempt.get("mode", "timed"), AttemptMode.timed)
        existing = None
        for row in session.exec(
            select(Attempt)
            .where(Attempt.question_id == q.id)
            .where(Attempt.session_id == local_sid)
        ).all():
            if (
                row.mode == mode
                and row.chosen_answer == payload_attempt.get("chosen_answer")
                and row.br_answer == payload_attempt.get("br_answer")
                and row.is_correct == bool(payload_attempt.get("is_correct", False))
                and row.br_correct == payload_attempt.get("br_correct")
                and row.time_ms == int(payload_attempt.get("time_ms", 0) or 0)
                and _dt_key(row.created_at) == _dt_key(created_at)
            ):
                existing = row
                break
        if existing is None:
            existing = Attempt(
                question_id=q.id,
                session_id=local_sid,
                mode=mode,
                chosen_answer=payload_attempt.get("chosen_answer"),
                br_answer=payload_attempt.get("br_answer"),
                is_correct=bool(payload_attempt.get("is_correct", False)),
                br_correct=payload_attempt.get("br_correct"),
                time_ms=int(payload_attempt.get("time_ms", 0) or 0),
                flagged=bool(payload_attempt.get("flagged", False)),
                confidence=payload_attempt.get("confidence"),
                created_at=created_at,
            )
            session.add(existing)
            session.flush()  # B4a: id within the import transaction
            session.refresh(existing)
            counts["attempts"] += 1
        if exported_id is not None and existing.id is not None:
            attempt_id_map[int(exported_id)] = existing.id

    # Error-log entries: remap via imported attempts. Old v2 payloads without an
    # attempt id map safely skip here rather than creating orphaned rows.
    for err in payload.get("error_log", []) or []:
        old_aid = err.get("attempt_id")
        local_aid = attempt_id_map.get(int(old_aid)) if old_aid is not None else None
        if local_aid is None:
            continue
        reason = _enum_value(ErrorReason, err.get("reason", "trap"), ErrorReason.trap)
        candidates = session.exec(
            select(ErrorLogEntry)
            .where(ErrorLogEntry.attempt_id == local_aid)
            .where(ErrorLogEntry.reason == reason)
        ).all()
        existing = next(
            (
                row for row in candidates
                if row.user_note == err.get("user_note")
                and row.ai_diagnosis == err.get("ai_diagnosis")
            ),
            None,
        )
        if existing is None:
            existing = ErrorLogEntry(
                attempt_id=local_aid,
                reason=reason,
                user_note=err.get("user_note"),
                ai_diagnosis=err.get("ai_diagnosis"),
            )
            session.add(existing)
            session.flush()  # B4a: id within the import transaction
            session.refresh(existing)
            counts["error_log"] += 1
        if err.get("id") is not None and existing.id is not None:
            error_id_map[int(err["id"])] = existing.id

    # SRS cards: one active card per restored question is enough for a portable
    # restore. Re-import updates state rather than duplicating due cards.
    for card in payload.get("srs_cards", []) or []:
        q = _question_by_external_key(session, card.get("question_external_id"))
        if q is None:
            continue
        existing = session.exec(
            select(SRSCard).where(SRSCard.question_id == q.id)
        ).first()
        due_date = _parse_dt(card.get("due_date")) or datetime.now(timezone.utc)
        if existing is None:
            session.add(SRSCard(
                question_id=q.id,
                fsrs_state=card.get("fsrs_state", {}) or {},
                due_date=due_date,
                lapses=int(card.get("lapses", 0) or 0),
                origin=card.get("origin"),
                leech=bool(card.get("leech", False)),
                last_reviewed=_parse_dt(card.get("last_reviewed")),
            ))
            counts["srs_cards"] += 1
        else:
            existing.fsrs_state = card.get("fsrs_state", {}) or {}
            existing.due_date = due_date
            existing.lapses = int(card.get("lapses", 0) or 0)
            existing.origin = card.get("origin", existing.origin)
            existing.leech = bool(card.get("leech", existing.leech))
            existing.last_reviewed = _parse_dt(card.get("last_reviewed"))
            session.add(existing)

    session.flush()  # B4a: checkpoint within the import transaction

    # Annotations: (scope, ref_id) is UNIQUE -> upsert. Question-scoped marks
    # re-anchor by external key; attempt-scoped marks need a still-valid ref.
    for a in payload.get("annotations", []) or []:
        scope = a.get("scope", "question")
        if scope == "question":
            q = _question_by_external_key(session, a.get("question_external_id"))
            if q is None:
                continue
            ref_id = q.id
        elif scope == "attempt":
            old_ref_id = a.get("ref_id")
            ref_id = attempt_id_map.get(int(old_ref_id)) if old_ref_id is not None else None
            if ref_id is None:
                continue  # the referenced attempt isn't present — skip
        else:
            continue
        row = session.exec(
            select(Annotation)
            .where(Annotation.scope == scope)
            .where(Annotation.ref_id == ref_id)
        ).first()
        if row is None:
            session.add(Annotation(scope=scope, ref_id=ref_id,
                                   data_json=a.get("data", {}) or {}))
            counts["annotations"] += 1
        else:
            row.data_json = a.get("data", {}) or {}
            session.add(row)

    # Embeddings: (kind, ref_id) is UNIQUE -> upsert. Question vectors re-anchor
    # by external key (firewall already dropped official ones on export).
    for ev in payload.get("embeddings", []) or []:
        kind = ev.get("kind", "question")
        if kind == "question":
            q = _question_by_external_key(session, ev.get("question_external_id"))
            if q is None:
                continue
            ref_id = q.id
        elif kind == "note":
            exported_ref = ev.get("ref_id")
            ref_id = error_id_map.get(int(exported_ref)) if exported_ref is not None else None
            if ref_id is None:
                continue
        else:
            ref_id = ev.get("ref_id")
            if ref_id is None:
                continue
        row = session.exec(
            select(EmbeddingVector)
            .where(EmbeddingVector.kind == kind)
            .where(EmbeddingVector.ref_id == ref_id)
        ).first()
        vec = list(ev.get("vector", []) or [])
        if row is None:
            session.add(EmbeddingVector(
                kind=kind, ref_id=ref_id, model=ev.get("model", ""),
                dim=int(ev.get("dim", len(vec)) or len(vec)), vector_json=vec,
            ))
            counts["embeddings"] += 1
        else:
            row.vector_json = vec
            row.model = ev.get("model", row.model)
            row.dim = int(ev.get("dim", len(vec)) or len(vec))
            session.add(row)

    # Reflections: FK -> session. Best-effort: only restore when the referenced
    # session id resolves in the target DB (avoids creating orphaned rows).
    for r in payload.get("reflections", []) or []:
        sid = r.get("session_id")
        if sid is None or session.get(StudySession, sid) is None:
            continue
        exists = session.exec(
            select(Reflection)
            .where(Reflection.session_id == sid)
            .where(Reflection.text == r.get("text", ""))
        ).first()
        if exists is not None:
            continue
        session.add(Reflection(
            session_id=sid, text=r.get("text", ""),
            prompts_json=r.get("prompts", []) or [],
        ))
        counts["reflections"] += 1

    # Explanation feedback: re-anchor by question external key; dedup on
    # (question_id, helpful, note).
    for f in payload.get("explanation_feedback", []) or []:
        q = _question_by_external_key(session, f.get("question_external_id"))
        if q is None:
            continue
        exists = session.exec(
            select(ExplanationFeedback)
            .where(ExplanationFeedback.question_id == q.id)
            .where(ExplanationFeedback.helpful == bool(f.get("helpful", True)))
            .where(ExplanationFeedback.note == f.get("note"))
        ).first()
        if exists is not None:
            continue
        session.add(ExplanationFeedback(
            question_id=q.id, helpful=bool(f.get("helpful", True)),
            note=f.get("note"),
        ))
        counts["explanation_feedback"] += 1

    # B4a: flush only — import_bank owns the final commit so the whole restore
    # (bank + all USER-data tables) lands atomically or not at all.
    session.flush()


def verify_restore(session: Session, payload: dict[str, Any]) -> dict[str, Any]:
    """5.5 — after an import, sanity-check that the restore is internally
    consistent and that the expected user-data made it in.

    Returns ``{"ok": bool, "checks": {...}, "issues": [...]}``. Checks are
    deliberately cheap (counts + a referential-integrity probe) so this can run
    inline after every import as a guard rail, not a full re-diff."""
    issues: list[str] = []

    # Referential integrity of what we just wrote (reuse the orphan sweep shape).
    dangling = {
        "answerchoice": session.exec(
            select(AnswerChoice).where(
                AnswerChoice.question_id.not_in(select(Question.id))
            )
        ).all(),
    }
    n_dangling_choices = len(dangling["answerchoice"])
    if n_dangling_choices:
        issues.append(f"{n_dangling_choices} answer choices reference a missing question")

    # Settings should all be present (they upsert by key, so this must be exact).
    want_settings = {s.get("key") for s in (payload.get("settings") or []) if s.get("key")}
    have_settings = {s.key for s in session.exec(select(Setting)).all()}
    missing_settings = sorted(want_settings - have_settings)
    if missing_settings:
        issues.append(f"settings missing after restore: {missing_settings}")

    # swarm #47: the in-session probe above only catches dangling answer choices.
    # Fold the full referential-integrity sweep (backup.orphan_report covers every
    # FK relationship — attempts, srs cards, error log, embeddings, annotations,
    # reflections, …) so a restore that left ANY orphan is reported, not just the
    # answer-choice case. orphan_report reads the committed DB file directly and
    # already returns total=0 for a missing/empty DB; a transient read error must
    # not crash this post-import guard rail.
    orphan_total = 0
    try:
        orphans = backup.orphan_report(config.DB_PATH)
        orphan_total = int(orphans.get("total", 0) or 0)
        if orphan_total > 0:
            by_rel = orphans.get("by_relationship", {})
            issues.append(f"{orphan_total} orphaned rows after restore: {by_rel}")
    except Exception:  # noqa: BLE001 — verify must never raise; report best-effort
        pass

    checks = {
        "preptests": len(session.exec(select(PrepTest)).all()),
        "questions": len(session.exec(select(Question)).all()),
        "study_plans": len(session.exec(select(StudyPlan)).all()),
        "settings": len(have_settings),
        "playlists": len(session.exec(select(Playlist)).all()),
        "annotations": len(session.exec(select(Annotation)).all()),
        "embeddings": len(session.exec(select(EmbeddingVector)).all()),
        "dangling_answer_choices": n_dangling_choices,
        "orphan_rows": orphan_total,
    }
    return {"ok": not issues, "checks": checks, "issues": issues}
