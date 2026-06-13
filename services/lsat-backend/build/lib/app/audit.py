"""Bank quality audit + near-duplicate detection.

Why this exists
---------------
As the bank grows (research imports + generation), quality drifts: untagged
items, generic placeholder types, answer-length tells, missing trap tags, and
near-duplicate questions from overlapping sources. ``content_hash`` catches exact
dups; this adds a quality report and embedding-based *near*-duplicate clustering
so the user can spot and clean problems.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Optional

from sqlmodel import Session, select

from . import config, embeddings
from .models import (
    AnswerChoice,
    Attempt,
    AttemptMode,
    AuditLog,
    Question,
    QuestionSource,
)

# Generic labels the importer assigns before tagging.
_GENERIC_TYPES = {"Inference", "Detail"}


# --- 5.4 audit trail --------------------------------------------------------
def _str(v) -> Optional[str]:
    if v is None:
        return None
    return v.value if hasattr(v, "value") else str(v)


def record_edit(session: Session, *, entity: str, entity_id: int, field: str,
                old_value, new_value, commit: bool = False) -> Optional[AuditLog]:
    """Write one AuditLog row for a content edit (no row if the value is
    unchanged). For ``entity == "question"`` also bumps ``Question.updated_at``
    so the item's last-edited time tracks any tag/difficulty/approval change.

    Caller usually batches several edits then commits once; pass
    ``commit=True`` for a standalone write."""
    old_s, new_s = _str(old_value), _str(new_value)
    if old_s == new_s:
        return None
    row = AuditLog(
        entity=entity, entity_id=entity_id, field=field,
        old_value=old_s, new_value=new_s,
    )
    session.add(row)
    if entity == "question":
        q = session.get(Question, entity_id)
        if q is not None:
            q.updated_at = datetime.now(timezone.utc)
            session.add(q)
    if commit:
        session.commit()
    return row


def recent_edits(session: Session, *, entity: Optional[str] = None,
                 entity_id: Optional[int] = None, limit: int = 100) -> list[dict]:
    """Recent content edits, newest first, optionally filtered by entity/id
    (the GET /api/bank/audit-log feed)."""
    stmt = select(AuditLog)
    if entity:
        stmt = stmt.where(AuditLog.entity == entity)
    if entity_id is not None:
        stmt = stmt.where(AuditLog.entity_id == entity_id)
    stmt = stmt.order_by(AuditLog.id.desc()).limit(max(1, min(limit, 1000)))
    return [
        {
            "id": r.id,
            "entity": r.entity,
            "entity_id": r.entity_id,
            "field": r.field,
            "old_value": r.old_value,
            "new_value": r.new_value,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in session.exec(stmt).all()
    ]


def _has_length_tell(choices: list[AnswerChoice], correct: str) -> bool:
    lengths = {c.label: len(c.text or "") for c in choices}
    if not lengths:
        return False
    longest = max(lengths, key=lengths.get)
    shortest = min(lengths, key=lengths.get)
    longest_unique = list(lengths.values()).count(lengths[longest]) == 1
    shortest_unique = list(lengths.values()).count(lengths[shortest]) == 1
    return (correct == longest and longest_unique) or (correct == shortest and shortest_unique)


def quality_report(session: Session) -> dict:
    """Counts of common quality issues across the whole bank."""
    questions = session.exec(select(Question)).all()
    choices_by_q: dict[int, list[AnswerChoice]] = defaultdict(list)
    for c in session.exec(select(AnswerChoice)).all():
        choices_by_q[c.question_id].append(c)

    by_source: Counter = Counter()
    missing_q_type = generic_placeholder = length_tell = missing_trap_tags = 0
    for q in questions:
        by_source[q.source.value if hasattr(q.source, "value") else str(q.source)] += 1
        if not q.q_type:
            missing_q_type += 1
        elif q.q_type in _GENERIC_TYPES and q.source == QuestionSource.research:
            generic_placeholder += 1
        cs = choices_by_q.get(q.id, [])
        if cs and _has_length_tell(cs, q.correct_answer):
            length_tell += 1
        wrong = [c for c in cs if not c.is_correct]
        if wrong and all((c.trap_type in (None, "none")) for c in wrong):
            missing_trap_tags += 1

    return {
        "total": len(questions),
        "by_source": dict(by_source),
        "missing_q_type": missing_q_type,
        "generic_placeholder": generic_placeholder,
        "length_tell": length_tell,
        "missing_trap_tags": missing_trap_tags,
        "embedded": len(embeddings._question_vectors(session)),
    }


def duplicate_clusters(session: Session, *, threshold: float = 0.95,
                       max_clusters: Optional[int] = 50) -> list[dict]:
    """Cluster near-duplicate questions by embedding cosine >= ``threshold``.

    Wave 4.3 — O(n*k) top-k scan via ``VectorStore`` instead of O(n^2) pairwise.
    """
    store = embeddings.vector_store(session)
    vectors = list(store.all_for(embeddings.QUESTION).items())
    parent = {qid: qid for qid, _ in vectors}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for qid_i, vi in vectors:
        for qid_j, score in store.cosine_top_k(vi, k=6, exclude_id=qid_i):
            if score >= threshold:
                union(qid_i, qid_j)

    groups: dict[int, list[int]] = defaultdict(list)
    for qid, _ in vectors:
        groups[find(qid)].append(qid)

    clusters = []
    for members in groups.values():
        if len(members) < 2:
            continue
        qs = [session.get(Question, qid) for qid in members]
        clusters.append({
            "question_ids": sorted(members),
            "size": len(members),
            "sample_stem": next((q.stem[:160] for q in qs if q and q.stem), ""),
        })
    clusters.sort(key=lambda c: -c["size"])
    return clusters[:max_clusters] if max_clusters else clusters


# --- 2.8 empirical difficulty calibration -----------------------------------
def accuracy_to_difficulty(accuracy: float) -> float:
    """Map observed live accuracy (0-1) to a difficulty on the 1-5 scale.

    Lower accuracy => harder => higher difficulty. Linear and inverse:
    accuracy 1.0 -> 1.0 (easiest), 0.5 -> 3.0, 0.0 -> 5.0. Clamped to [1, 5] and
    rounded to one decimal so the value stays comparable to the integer
    model-asserted ``difficulty`` without pretending to more precision than the
    sample supports.
    """
    acc = min(1.0, max(0.0, accuracy))
    return round(min(5.0, max(1.0, 1.0 + 4.0 * (1.0 - acc))), 1)


def calibrate_difficulty(session: Session, *, min_attempts: Optional[int] = None,
                         commit: bool = True) -> dict:
    """Recompute ``Question.empirical_difficulty`` from observed live accuracy.

    Counts non-blind-review attempts per question; for questions with at least
    ``min_attempts`` attempts, sets ``empirical_difficulty`` from
    :func:`accuracy_to_difficulty`. The model-asserted integer ``difficulty`` is
    left intact (this is an additive, empirical signal). Returns a summary
    (how many were updated/skipped + the threshold) for the endpoint/worker.

    AI items are included: empirical difficulty is descriptive of the drill
    experience and never feeds score prediction, so calibrating generated items
    is safe and useful for the bank audit.
    """
    if min_attempts is None:
        min_attempts = config.CALIBRATION_MIN_ATTEMPTS
    min_attempts = max(1, min_attempts)

    agg: dict[int, list[int]] = defaultdict(lambda: [0, 0])  # qid -> [correct, total]
    for a in session.exec(select(Attempt)).all():
        if a.mode == AttemptMode.blind_review:
            continue
        agg[a.question_id][1] += 1
        if a.is_correct:
            agg[a.question_id][0] += 1

    updated = 0
    skipped_insufficient = 0
    changed_rows: list[Question] = []
    for qid, (correct, total) in agg.items():
        if total < min_attempts:
            skipped_insufficient += 1
            continue
        q = session.get(Question, qid)
        if q is None or q.deleted_at is not None:
            continue
        new_val = accuracy_to_difficulty(correct / total)
        if q.empirical_difficulty != new_val:
            q.empirical_difficulty = new_val
            changed_rows.append(q)
        updated += 1

    if commit and changed_rows:
        for q in changed_rows:
            session.add(q)
        session.commit()

    return {
        "min_attempts": min_attempts,
        "questions_with_attempts": len(agg),
        "calibrated": updated,
        "changed": len(changed_rows),
        "skipped_insufficient_attempts": skipped_insufficient,
    }
