"""Reading Comprehension structure maps and passage-first analytics."""
from __future__ import annotations

import re
from collections import Counter
from datetime import datetime, timezone
from typing import Any

from sqlmodel import Session, select

from .models import Attempt, Passage, Question, RCPassageAnalysis


_AUTHOR_MARKERS = ("argues", "suggests", "contends", "maintains", "claims")
_CONTRAST_MARKERS = ("however", "nevertheless", "but", "although", "whereas")
_EVIDENCE_MARKERS = ("because", "for example", "for instance", "evidence", "study")
_COMPARATIVE_MARKERS = ("both passages", "passage a", "passage b")
_EXPLICIT_LOCAL_MARKERS = ("paragraph", "sentence", "phrase", "word")
_LOCAL_TASK_MARKERS = ("according to the passage", "states", "indicates", "mentions", "refers")
_GLOBAL_MARKERS = ("main point", "primary purpose", "overall", "passage as a whole")
_SUPPORT_ATTACK_MARKERS = ("strengthen", "weaken", "support", "undermine")
_RC_TAGS_BY_TYPE = {
    "MainPoint": ("global", "main_point"),
    "Attitude": ("viewpoint", "tone"),
    "Detail": ("local", "text_lookup"),
    "Inference": ("support", "local_to_global"),
    "Function": ("structure", "role"),
    "Structure": ("global", "organization"),
    "Application": ("transfer", "principle"),
    "StrengthenWeaken": ("argument_relation", "support_attack"),
    "Comparative": ("comparative", "relationship"),
}
_GUIDANCE_SCOPE_BY_TYPE = {
    "MainPoint": "global",
    "Attitude": "viewpoint",
    "Detail": "local_text",
    "Inference": "support",
    "Function": "local_text",
    "Structure": "global",
    "Application": "transfer",
    "StrengthenWeaken": "support_attack",
    "Comparative": "comparative",
}
_ANCHOR_BY_SCOPE = {
    "comparative": "passage_a_b",
    "global": "whole_passage",
    "line_reference": "local_text",
    "local_text": "local_text",
    "support_attack": "argument_relation",
    "support": "passage_support",
    "transfer": "application_context",
    "viewpoint": "author_viewpoint",
    "type_inferred": "type_inferred",
}
_EVIDENCE_SCOPES = {"line_reference", "local_text", "comparative", "support_attack"}


def analyze_passage(session: Session, passage_id: int, *, persist: bool = True) -> dict[str, Any]:
    passage = session.get(Passage, passage_id)
    if passage is None:
        raise ValueError("passage_not_found")
    paragraphs = _paragraphs(passage.text)
    roles = [_role_for(i, p, len(paragraphs)) for i, p in enumerate(paragraphs)]
    evidence_refs = _evidence_refs(paragraphs)
    questions = session.exec(select(Question).where(Question.passage_id == passage_id)).all()
    timing = _timing(session, [q.id for q in questions if q.id is not None])
    question_tags = _question_tags(questions)
    structure = {
        "paragraph_count": len(paragraphs),
        "passage_type": passage.type or "single",
        "topic": passage.topic,
        "main_point_hint": _main_point_hint(paragraphs),
        "question_mix": dict(Counter(q.q_type for q in questions)),
        "line_reference_density": _line_reference_density(questions),
        "viewpoint_count": len({
            role["viewpoint"]["label"]
            for role in roles
            if role.get("viewpoint")
        }),
        "dominant_viewpoint": _dominant_viewpoint(roles),
        "evidence_anchor_count": len(evidence_refs),
        "tag_coverage": _tag_coverage(question_tags),
    }
    payload = {
        "passage_id": passage_id,
        "topic": passage.topic,
        "structure": structure,
        "paragraph_roles": roles,
        "evidence_refs": evidence_refs,
        "question_tags": question_tags,
        "timing": timing,
        "generated_by": "local_heuristic_v1",
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    if persist:
        row = session.exec(
            select(RCPassageAnalysis).where(RCPassageAnalysis.passage_id == passage_id)
        ).first()
        now = datetime.now(timezone.utc)
        if row is None:
            row = RCPassageAnalysis(passage_id=passage_id, created_at=now)
        row.topic = passage.topic
        row.structure_json = structure
        row.paragraph_roles_json = roles
        row.timing_json = timing
        row.generated_by = "local_heuristic_v1"
        row.updated_at = now
        session.add(row)
        session.commit()
        session.refresh(row)
        payload["analysis_id"] = row.id
    return payload


def list_passage_maps(session: Session, *, limit: int = 50) -> list[dict[str, Any]]:
    passages = session.exec(select(Passage).order_by(Passage.id.desc()).limit(limit)).all()
    return [analyze_passage(session, p.id, persist=False) for p in passages if p.id is not None]


def rc_dashboard(session: Session) -> dict[str, Any]:
    passages = session.exec(select(Passage)).all()
    rc_questions = session.exec(select(Question).where(Question.passage_id.is_not(None))).all()
    analyses = session.exec(select(RCPassageAnalysis)).all()
    qids = [q.id for q in rc_questions if q.id is not None]
    timing = _timing(session, qids)
    by_type = Counter(q.q_type for q in rc_questions)
    tag_rows = _question_tags(rc_questions)
    return {
        "passages": len(passages),
        "questions": len(rc_questions),
        "mapped_passages": len(analyses),
        "coverage": (len(analyses) / len(passages)) if passages else 0,
        "by_q_type": dict(by_type),
        "tag_coverage": _tag_coverage(tag_rows),
        "timing": timing,
        "next_actions": _rc_next_actions(passages, analyses, timing, tag_rows),
    }


def _paragraphs(text: str) -> list[str]:
    chunks = [p.strip() for p in re.split(r"\n\s*\n+", text or "") if p.strip()]
    if len(chunks) <= 1:
        chunks = [p.strip() for p in re.split(r"(?<=[.!?])\s+(?=[A-Z])", text or "") if p.strip()]
    return chunks[:12]


def _role_for(index: int, paragraph: str, total: int) -> dict[str, Any]:
    lower = paragraph.lower()
    if index == 0:
        role = "setup"
    elif any(m in lower for m in _CONTRAST_MARKERS):
        role = "contrast_or_shift"
    elif any(m in lower for m in _EVIDENCE_MARKERS):
        role = "evidence_or_example"
    elif index == total - 1:
        role = "synthesis"
    else:
        role = "development"
    return {
        "index": index + 1,
        "line_ref": f"P{index + 1}",
        "role": role,
        "author_attitude": _attitude(paragraph),
        "claim_density": _claim_density(paragraph),
        "viewpoint": _viewpoint(paragraph, role),
        "evidence_markers": _marker_hits(paragraph, _EVIDENCE_MARKERS),
        "text_preview": paragraph[:220],
    }


def _attitude(paragraph: str) -> str:
    lower = paragraph.lower()
    if any(word in lower for word in ("surprisingly", "problematic", "doubt", "critic")):
        return "skeptical_or_concerned"
    if any(word in lower for word in ("important", "promising", "useful", "valuable")):
        return "positive_or_interested"
    if any(marker in lower for marker in _AUTHOR_MARKERS):
        return "argumentative"
    return "neutral_descriptive"


def _claim_density(paragraph: str) -> float:
    sentences = max(1, len(re.findall(r"[.!?]", paragraph)) or 1)
    markers = sum(paragraph.lower().count(m) for m in ("therefore", "thus", "because", "however", "suggests"))
    return round(min(1.0, markers / sentences), 2)


def _marker_hits(text: str, markers: tuple[str, ...]) -> list[str]:
    lower = text.lower()
    return [marker for marker in markers if marker in lower]


def _viewpoint(paragraph: str, role: str) -> dict[str, Any]:
    lower = paragraph.lower()
    markers = _marker_hits(paragraph, _AUTHOR_MARKERS + _CONTRAST_MARKERS)
    attitude = _attitude(paragraph)
    if role == "contrast_or_shift":
        label = "qualified_or_opposing_view"
        stance = "shift"
    elif any(marker in lower for marker in _AUTHOR_MARKERS):
        label = "author_claim"
        stance = "assertive"
    elif attitude == "skeptical_or_concerned":
        label = "skeptical_view"
        stance = "skeptical"
    elif attitude == "positive_or_interested":
        label = "supportive_view"
        stance = "supportive"
    elif role == "evidence_or_example":
        label = "evidence_support"
        stance = "supporting"
    else:
        label = "background_context"
        stance = "neutral"
    return {
        "label": label,
        "stance": stance,
        "signals": markers[:4],
    }


def _sentence_with_marker(paragraph: str, marker: str) -> str:
    sentences = [
        sentence.strip()
        for sentence in re.split(r"(?<=[.!?])\s+", paragraph.strip())
        if sentence.strip()
    ]
    for sentence in sentences:
        if marker.lower() in sentence.lower():
            return sentence[:220]
    return (sentences[0] if sentences else paragraph.strip())[:220]


def _evidence_refs(paragraphs: list[str]) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    for idx, paragraph in enumerate(paragraphs):
        evidence_markers = _marker_hits(paragraph, _EVIDENCE_MARKERS)
        contrast_markers = _marker_hits(paragraph, _CONTRAST_MARKERS)
        author_markers = _marker_hits(paragraph, _AUTHOR_MARKERS)
        for marker_group, evidence_type in (
            (evidence_markers, "support"),
            (contrast_markers, "contrast"),
            (author_markers, "viewpoint"),
        ):
            if not marker_group:
                continue
            marker = marker_group[0]
            refs.append({
                "paragraph_index": idx + 1,
                "line_ref": f"P{idx + 1}",
                "marker": marker,
                "evidence_type": evidence_type,
                "text_preview": _sentence_with_marker(paragraph, marker),
            })
            break
    return refs[:8]


def _dominant_viewpoint(roles: list[dict[str, Any]]) -> str | None:
    labels = [
        str((role.get("viewpoint") or {}).get("label") or "")
        for role in roles
        if (role.get("viewpoint") or {}).get("label")
    ]
    if not labels:
        return None
    return Counter(labels).most_common(1)[0][0]


def _main_point_hint(paragraphs: list[str]) -> str:
    if not paragraphs:
        return ""
    candidates = paragraphs[-2:] if len(paragraphs) > 1 else paragraphs
    text = " ".join(candidates)
    sentence = re.split(r"(?<=[.!?])\s+", text.strip())[0]
    return sentence[:320]


def _line_reference_density(questions: list[Question]) -> float:
    if not questions:
        return 0.0
    refs = sum(1 for q in questions if re.search(r"\bline[s]?\s+\d+", q.prompt, re.I))
    return round(refs / len(questions), 2)


def scope_for_text(
    q_type: str,
    prompt: str = "",
    stem: str = "",
    passage: str = "",
) -> str:
    text = f"{prompt or ''} {stem or ''}".lower()
    passage_text = str(passage or "").lower()
    if any(marker in text or marker in passage_text for marker in _COMPARATIVE_MARKERS):
        return "comparative"
    if re.search(r"\bline[s]?\s+\d+", text):
        return "line_reference"
    if any(word in text for word in _EXPLICIT_LOCAL_MARKERS):
        return "local_text"
    if any(word in text for word in _GLOBAL_MARKERS):
        return "global"
    if any(word in text for word in _LOCAL_TASK_MARKERS):
        return "local_text"
    return "type_inferred"


def guidance_for_q_type(q_type: str) -> dict[str, Any]:
    """Return passage-map guidance for a target RC type before a prompt exists."""
    q_type = q_type or "Unknown"
    scope = _GUIDANCE_SCOPE_BY_TYPE.get(q_type, "type_inferred")
    tags = list(_RC_TAGS_BY_TYPE.get(q_type, ("untagged",)))
    if scope not in tags:
        tags.append(scope)
    return {
        "q_type": q_type,
        "scope": scope,
        "anchor_ref": _ANCHOR_BY_SCOPE.get(scope, "type_inferred"),
        "requires_evidence": scope in _EVIDENCE_SCOPES,
        "tags": tags,
        "tag_confidence": 1.0 if q_type in _RC_TAGS_BY_TYPE else 0.35,
    }


def _anchor_ref_for_text(text: str, scope: str) -> str:
    match = re.search(r"\bline[s]?\s+(\d+(?:\s*[-–]\s*\d+)?)", text, re.I)
    if match:
        return f"lines {match.group(1).replace(' ', '')}"
    match = re.search(r"\bparagraph\s+(\d+)", text, re.I)
    if match:
        return f"P{match.group(1)}"
    return _ANCHOR_BY_SCOPE.get(scope, "type_inferred")


def validate_scope_anchor(
    q_type: str,
    prompt: str = "",
    stem: str = "",
    passage: str = "",
) -> dict[str, Any]:
    scope = scope_for_text(q_type, prompt, stem, passage)
    guidance = guidance_for_q_type(q_type)
    text = f"{prompt or ''} {stem or ''}"
    tags = list(guidance.get("tags") or [])
    if scope != "type_inferred" and scope not in tags:
        tags.append(scope)
    detail = {
        "q_type": q_type,
        "scope": scope,
        "anchor_ref": _anchor_ref_for_text(text, scope),
        "requires_evidence": scope in _EVIDENCE_SCOPES,
        "tags": tags,
        "tag_confidence": guidance.get("tag_confidence", 0.35),
        "guidance_scope": guidance.get("scope"),
        "guidance_anchor_ref": guidance.get("anchor_ref"),
    }
    if q_type == "Comparative" and scope != "comparative":
        return {
            "ok": False,
            "reason": "rc_scope_mismatch",
            "expected_scope": "comparative",
            **detail,
        }
    if q_type in ("Detail", "Function") and scope not in ("line_reference", "local_text"):
        return {
            "ok": False,
            "reason": "rc_scope_mismatch",
            "expected_scope": "local_text",
            **detail,
        }
    if q_type in ("MainPoint", "Structure") and scope in ("line_reference", "local_text"):
        return {
            "ok": False,
            "reason": "rc_scope_mismatch",
            "expected_scope": "global",
            **detail,
        }
    if q_type == "StrengthenWeaken":
        text = f"{prompt or ''} {stem or ''}".lower()
        if not any(marker in text for marker in _SUPPORT_ATTACK_MARKERS):
            return {
                "ok": False,
                "reason": "rc_scope_mismatch",
                "expected_scope": "support_attack",
                **detail,
            }
    return {"ok": True, **detail}


def _scope_for_question(q: Question) -> str:
    return scope_for_text(q.q_type or "", q.prompt or "", q.stem or "")


def _anchor_ref_for_question(q: Question, scope: str) -> str:
    text = f"{q.prompt or ''} {q.stem or ''}"
    return _anchor_ref_for_text(text, scope)


def _question_tags(questions: list[Question]) -> list[dict[str, Any]]:
    rows = []
    for q in sorted(questions, key=lambda item: item.id or 0):
        q_type = q.q_type or "Unknown"
        base_tags = list(_RC_TAGS_BY_TYPE.get(q_type, ("untagged",)))
        scope = _scope_for_question(q)
        if scope not in base_tags:
            base_tags.append(scope)
        anchor_ref = _anchor_ref_for_question(q, scope)
        rows.append({
            "question_id": q.id or 0,
            "q_type": q_type,
            "scope": scope,
            "anchor_ref": anchor_ref,
            "requires_evidence": scope in _EVIDENCE_SCOPES,
            "tags": base_tags,
            "tag_confidence": 1.0 if q_type in _RC_TAGS_BY_TYPE else 0.35,
        })
    return rows


def _tag_coverage(question_tags: list[dict[str, Any]]) -> dict[str, Any]:
    if not question_tags:
        return {
            "tagged_questions": 0,
            "total_questions": 0,
            "coverage": 0.0,
            "low_confidence": 0,
            "by_scope": {},
        }
    tagged = [row for row in question_tags if row.get("tag_confidence", 0) >= 0.75]
    by_scope = Counter(str(row.get("scope") or "unknown") for row in question_tags)
    return {
        "tagged_questions": len(tagged),
        "total_questions": len(question_tags),
        "coverage": round(len(tagged) / len(question_tags), 3),
        "low_confidence": len(question_tags) - len(tagged),
        "by_scope": dict(by_scope),
    }


def _timing(session: Session, qids: list[int]) -> dict[str, Any]:
    if not qids:
        return {"attempts": 0, "avg_time_ms": None, "accuracy": None, "by_q_type": {}}
    questions = {q.id: q for q in session.exec(select(Question).where(Question.id.in_(qids))).all()}
    attempts = session.exec(select(Attempt).where(Attempt.question_id.in_(qids))).all()
    if not attempts:
        return {"attempts": 0, "avg_time_ms": None, "accuracy": None, "by_q_type": {}}
    by_type: dict[str, list[Attempt]] = {}
    for attempt in attempts:
        q = questions.get(attempt.question_id)
        if q:
            by_type.setdefault(q.q_type, []).append(attempt)
    return {
        "attempts": len(attempts),
        "avg_time_ms": round(sum(a.time_ms for a in attempts) / len(attempts), 1),
        "accuracy": round(sum(1 for a in attempts if a.is_correct) / len(attempts), 3),
        "by_q_type": {
            qtype: {
                "attempts": len(rows),
                "avg_time_ms": round(sum(a.time_ms for a in rows) / len(rows), 1),
                "accuracy": round(sum(1 for a in rows if a.is_correct) / len(rows), 3),
            }
            for qtype, rows in by_type.items()
        },
    }


def _rc_next_actions(
    passages: list[Passage],
    analyses: list[RCPassageAnalysis],
    timing: dict[str, Any],
    question_tags: list[dict[str, Any]],
) -> list[str]:
    actions: list[str] = []
    if len(analyses) < len(passages):
        actions.append("Generate structure maps for unmapped RC passages.")
    coverage = _tag_coverage(question_tags)
    if coverage["low_confidence"]:
        actions.append("Review RC q_type tags before using these passages for generation.")
    if timing.get("avg_time_ms") and timing["avg_time_ms"] > 120_000:
        actions.append("Prioritize passage-role drills before detail questions.")
    if not actions:
        actions.append("Keep RC maps fresh after each import and timed section.")
    return actions
