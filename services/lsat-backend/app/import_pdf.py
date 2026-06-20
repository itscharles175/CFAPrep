"""PDF import wizard: extract text (pymupdf) -> AI structuring pass -> review JSON.

`parse_pdf` returns proposed structure WITHOUT committing. `commit_structure`
persists the (possibly human-edited) structure. The text extractor and the AI
structuring pass are separated so unit tests can monkeypatch the model call.

A tiny synthetic test PDF can be generated with `write_fixture_pdf` (used by tests),
since no real owned PrepTest PDF ships with the repo.
"""
from __future__ import annotations

import json
import re

import fitz  # pymupdf
from sqlmodel import Session, select

from . import llm
from .ai import strip_think
from .dataset_normalizers import clamp_difficulty
from .models import (
    AnswerChoice,
    Annotation,
    Attempt,
    AttemptChoiceEvent,
    EmbeddingVector,
    ErrorLogEntry,
    Explanation,
    Passage,
    PrepTest,
    Question,
    QuestionSource,
    Section,
    SectionType,
    SRSCard,
    SRSReviewLog,
)

_CHOICE_RE = re.compile(r"^\s*\(?([A-E])\)?[\.\)]\s*(.+)$")

# 4.4 — below this many extracted characters per page we treat the PDF as
# scanned/image-only and attempt OCR (a real text PDF yields hundreds+ chars/page).
_OCR_MIN_CHARS_PER_PAGE = 8
# 4.4 — long PrepTests overflow a single model context. We structure the document
# in overlapping windows of this many characters so nothing past the old
# raw_text[:8000] cut is silently dropped.
_CHUNK_CHARS = 7000
_CHUNK_OVERLAP = 800


def _page_text(page) -> str:
    """Text for one page, with basic multi-column layout handling.

    B30: detects two-column layouts by measuring the x-span of text blocks
    relative to page width. When blocks span more than 40% of the page width,
    we cluster them into left/right columns by mean x-center and concatenate
    each column top-to-bottom before the other. This correctly handles the
    common two-column LSAT exam/explanation layout without interleaving lines.

    Limitation: a single block that spans both columns (e.g. a section heading)
    is placed in whichever cluster its x-center falls into. The chunked
    structuring pass is tolerant of minor ordering errors in such cases.

    B31: catches (TypeError, AttributeError, ValueError) so pymupdf API
    variations and missing rect attributes are handled uniformly.
    """
    try:
        raw_blocks = page.get_text("blocks")
        # Each block: (x0, y0, x1, y1, text, block_no, block_type=0 for text)
        text_blocks = [
            (float(b[0]), float(b[1]), float(b[2]), float(b[3]), b[4])
            for b in raw_blocks
            if len(b) > 6 and b[6] == 0 and b[4].strip()
        ]
        if not text_blocks:
            return page.get_text("text", sort=True)

        x_min = min(b[0] for b in text_blocks)
        x_max = max(b[2] for b in text_blocks)
        x_span = x_max - x_min
        # Use page width to judge multi-column; fall back to x_span if unavailable.
        page_width = float(page.rect.width) if (
            hasattr(page, "rect") and page.rect.width > 0
        ) else x_span

        if x_span > 0.4 * page_width:
            # Multi-column: split blocks into left/right clusters by x-center.
            x_centers = [(b[0] + b[2]) / 2.0 for b in text_blocks]
            mean_x = sum(x_centers) / len(x_centers)
            left = sorted(
                [b for b, xc in zip(text_blocks, x_centers) if xc < mean_x],
                key=lambda b: (b[1], b[0]),
            )
            right = sorted(
                [b for b, xc in zip(text_blocks, x_centers) if xc >= mean_x],
                key=lambda b: (b[1], b[0]),
            )
            return "\n".join(b[4] for b in left + right)
        else:
            sorted_blocks = sorted(text_blocks, key=lambda b: (b[1], b[0]))
            return "\n".join(b[4] for b in sorted_blocks)
    except (TypeError, AttributeError, ValueError):
        # B31: broader catch for API differences / missing attrs.
        try:
            return page.get_text("text", sort=True)
        except (TypeError, AttributeError, ValueError):
            return page.get_text()


def _ocr_page_text(page) -> str:
    """OCR one page via pymupdf's Tesseract bridge, or '' if OCR is unavailable.

    ``Page.get_textpage_ocr`` shells out to a Tesseract install (TESSDATA). We
    never hard-fail and never require a system binary to exist: if Tesseract is
    absent the call raises and we return '' so the caller can warn the user
    rather than crash the import."""
    try:
        tp = page.get_textpage_ocr(flags=0, full=True)
        return page.get_text("text", textpage=tp) or ""
    except Exception:
        return ""


def extract_text(pdf_bytes: bytes) -> str:
    """Extract plain text from a PDF byte string (embedded text layer only).

    Kept returning a plain ``str`` (callers + tests rely on it). The OCR-aware
    pipeline is :func:`extract_text_with_ocr`, which this delegates to and then
    drops the warnings."""
    text, _ = extract_text_with_ocr(pdf_bytes)
    return text


def extract_text_with_ocr(pdf_bytes: bytes, *, ocr: bool = True) -> tuple[str, list[str]]:
    """Extract text, falling back to OCR for scanned/image-only PDFs.

    Returns ``(text, warnings)``. When the embedded text layer is empty or
    suspiciously sparse (a scanned PDF), and ``ocr`` is on, we attempt per-page
    OCR. If OCR is unavailable (no Tesseract) we DO NOT fail — we add a clear,
    actionable warning and return whatever text we have, so the import pipeline
    degrades gracefully instead of crashing.
    """
    warnings: list[str] = []
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        page_texts = [_page_text(page) for page in doc]
        raw = "\n".join(page_texts)
        n_pages = max(1, len(page_texts))
        density = len(raw.strip()) / n_pages
        if ocr and density < _OCR_MIN_CHARS_PER_PAGE:
            # Looks scanned/image-only — attempt OCR page by page.
            ocr_texts: list[str] = []
            any_ocr = False
            for page in doc:
                t = _ocr_page_text(page)
                if t.strip():
                    any_ocr = True
                ocr_texts.append(t)
            ocr_raw = "\n".join(ocr_texts)
            if any_ocr and len(ocr_raw.strip()) > len(raw.strip()):
                warnings.append(
                    "PDF had little/no extractable text; used OCR fallback."
                )
                raw = ocr_raw
            else:
                warnings.append(
                    "PDF appears scanned/image-only and no extractable text was "
                    "found. OCR unavailable — install an OCR engine (Tesseract, "
                    "with TESSDATA_PREFIX set) to import scanned PDFs."
                )
        return raw, warnings
    finally:
        doc.close()


# --- AI structuring pass ----------------------------------------------------
def _structure_prompt(raw_text: str) -> str:
    # No more raw_text[:8000] truncation here: callers pass an already-windowed
    # chunk (see _chunk_text), so a long PrepTest is structured in full across
    # chunks instead of being silently cut off at 8000 chars.
    return (
        "You are parsing raw text extracted from an LSAT PrepTest PDF into "
        "structured JSON. Identify sections (LR or RC), passages (RC only), "
        "questions, and answer choices.\n\nRaw text:\n"
        f"{raw_text}\n\n"
        "Respond with ONLY JSON of shape:\n"
        '{"name":"...", "sections":[{"type":"LR","passages":[],'
        '"questions":[{"stem":"...","prompt":"...","q_type":"Weaken",'
        '"difficulty":3,"correct_answer":"B",'
        '"choices":[{"label":"A","text":"..."}]}]}]}'
    )


def _chunk_text(raw_text: str, *, size: int = _CHUNK_CHARS,
                overlap: int = _CHUNK_OVERLAP) -> list[str]:
    """Split raw text into overlapping windows so a long PrepTest isn't truncated.

    Splits on paragraph boundaries where possible (so a question/choice block is
    less likely to be cut mid-line), with an ``overlap`` tail carried into the
    next window. Returns ``[raw_text]`` unchanged when it already fits in one
    window."""
    if len(raw_text) <= size:
        return [raw_text]
    chunks: list[str] = []
    start = 0
    n = len(raw_text)
    while start < n:
        end = min(start + size, n)
        if end < n:
            # Prefer to break on a blank line / newline near the window edge.
            window = raw_text[start:end]
            brk = window.rfind("\n\n")
            if brk == -1:
                brk = window.rfind("\n")
            if brk > size // 2:  # only if the break isn't pathologically early
                end = start + brk
        chunks.append(raw_text[start:end])
        if end >= n:
            break
        start = max(end - overlap, start + 1)
    return chunks


def _run_structurer(chunk: str, structurer=None) -> dict:
    """Structure one chunk into the parsed shape (single model/structurer call)."""
    if structurer is not None:
        return structurer(chunk)
    text = strip_think(llm.offline_generate(_structure_prompt(chunk)))
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1:
        try:
            return json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            pass
    return {"name": "Imported PrepTest", "sections": []}


def _question_dedup_key(q: dict) -> tuple:
    """Stable identity for a parsed question so overlapping-chunk duplicates
    (the carried-over tail) collapse to one."""
    stem = (q.get("stem") or "").strip()
    prompt = (q.get("prompt") or "").strip()
    choice_texts = tuple(
        (c.get("text") or "").strip() for c in (q.get("choices") or [])
    )
    return (stem, prompt, choice_texts)


def _merge_structures(parts: list[dict]) -> dict:
    """Merge per-chunk structures into one, concatenating questions by section
    type and de-duplicating questions repeated across the overlap windows.

    Sections are merged BY TYPE+ORDER so a section spanning two chunks isn't
    split into two; questions keep their first-seen order and duplicates from the
    overlap are dropped."""
    name = "Imported PrepTest"
    for p in parts:
        nm = (p or {}).get("name")
        if nm and nm != "Imported PrepTest":
            name = nm
            break

    merged_sections: list[dict] = []
    index: dict[tuple, dict] = {}      # (type, order) -> section dict
    seen_q: set[tuple] = set()
    for p in parts:
        for si, sec in enumerate((p or {}).get("sections", []) or []):
            stype = sec.get("type", "LR")
            sorder = sec.get("order", si)
            key = (stype, sorder)
            target = index.get(key)
            if target is None:
                target = {
                    "type": stype,
                    "order": sorder,
                    "passages": list(sec.get("passages", []) or []),
                    "questions": [],
                }
                if "time_limit_sec" in sec:
                    target["time_limit_sec"] = sec["time_limit_sec"]
                index[key] = target
                merged_sections.append(target)
            else:
                # Extend passages we haven't already captured.
                for pas in sec.get("passages", []) or []:
                    if pas not in target["passages"]:
                        target["passages"].append(pas)
            for q in sec.get("questions", []) or []:
                qk = _question_dedup_key(q)
                if qk in seen_q:
                    continue
                seen_q.add(qk)
                target["questions"].append(q)
    return {"name": name, "sections": merged_sections}


def _ai_structure(raw_text: str, structurer=None) -> dict:
    """Structure raw text into the parsed shape. `structurer` injectable for tests.

    Chunks long input into overlapping windows (so a full PrepTest isn't cut at
    8000 chars), structures each window, then merges the results. PDF structuring
    is an offline tier, so the live path uses the offline provider (cloud when
    configured, else the local gen model) via the resilient LLM layer.
    """
    chunks = _chunk_text(raw_text)
    if len(chunks) == 1:
        return _run_structurer(chunks[0], structurer=structurer)
    parts = [_run_structurer(c, structurer=structurer) for c in chunks]
    return _merge_structures(parts)


def _heuristic_structure(raw_text: str) -> dict:
    """Tolerant fallback parser: split on 'Question N' markers and (A)-(E) lines.

    Used when the AI pass is unavailable so the endpoint still produces something.
    """
    name = "Imported PrepTest"
    first_line = raw_text.strip().splitlines()[0] if raw_text.strip() else ""
    if first_line:
        name = first_line[:80]

    questions = []
    blocks = re.split(r"(?im)^\s*Question\s+\d+\s*$", raw_text)
    for block in blocks[1:]:
        lines = [ln.rstrip() for ln in block.splitlines() if ln.strip()]
        if not lines:
            continue
        choices = []
        stem_lines = []
        correct = None
        for ln in lines:
            cm = _CHOICE_RE.match(ln)
            am = re.match(r"(?i)^\s*answer\s*[:=]\s*([A-E])", ln)
            if am:
                correct = am.group(1).upper()
                continue
            if cm:
                choices.append({"label": cm.group(1), "text": cm.group(2).strip()})
            else:
                stem_lines.append(ln)
        if not choices:
            continue
        stem = " ".join(stem_lines).strip()
        prompt = ""
        # last sentence ending in '?' is usually the prompt
        qm = re.findall(r"[^.?!]*\?", stem)
        if qm:
            prompt = qm[-1].strip()
            stem = stem[: stem.rfind(prompt)].strip() or stem
        questions.append({
            "stem": stem,
            "prompt": prompt or "Which one of the following is most accurate?",
            "q_type": "Inference",
            "difficulty": 3,
            # D1: never silently guess the key. Leave it empty when no "Answer:"
            # line was found so the commit gate forces a reconcile against the
            # official key instead of shipping a wrong answer.
            "correct_answer": correct or "",
            "choices": choices,
        })
    return {
        "name": name,
        "sections": [{"type": "LR", "passages": [], "questions": questions}],
    }


def parse_pdf(pdf_bytes: bytes, structurer=None) -> tuple[dict, list[str]]:
    """Return (parsed_structure, warnings). Does NOT commit."""
    raw, warnings = extract_text_with_ocr(pdf_bytes)
    if not raw.strip():
        warnings.append("No extractable text found in PDF.")
        return {"name": "Imported PrepTest", "sections": []}, warnings

    parsed = None
    if structurer is not None:
        try:
            parsed = _ai_structure(raw, structurer=structurer)
        except Exception as exc:
            warnings.append(f"AI structuring failed ({exc}); used heuristic parser.")
    else:
        # Try live model; on any failure fall back to the tolerant heuristic.
        try:
            parsed = _ai_structure(raw)
            if not parsed.get("sections"):
                warnings.append("AI returned no sections; used heuristic parser.")
                parsed = None
        except Exception as exc:
            warnings.append(f"AI structuring unavailable ({exc}); used heuristic parser.")

    if not parsed:
        parsed = _heuristic_structure(raw)

    # Validation warnings.
    for si, sec in enumerate(parsed.get("sections", [])):
        for qi, q in enumerate(sec.get("questions", [])):
            n = len(q.get("choices", []))
            if n != 5:
                warnings.append(f"Section {si+1} Q{qi+1}: {n} choices (expected 5).")
            if not q.get("correct_answer"):
                warnings.append(f"Section {si+1} Q{qi+1}: missing correct_answer.")
    if not parsed.get("sections"):
        warnings.append("No sections detected.")
    return parsed, warnings


# --- answer-key reconcile ---------------------------------------------------
def _flatten_questions(parsed: dict) -> list[dict]:
    """All questions across sections, in reading order."""
    out: list[dict] = []
    for sec in parsed.get("sections", []):
        out.extend(sec.get("questions", []))
    return out


def reconcile_answer_key(parsed: dict, answer_key: list[str], *,
                         apply: bool = False) -> dict:
    """Validate parsed correct answers against an official key (flat, in
    question order) and flag mismatches — the import pipeline's step 5.

    With ``apply=True`` the official key wins: parsed answers are rewritten to
    match it (the returned ``parsed`` is the corrected structure).
    """
    questions = _flatten_questions(parsed)
    mismatches: list[dict] = []
    matched = 0
    for i, q in enumerate(questions):
        if i >= len(answer_key):
            break  # question past the key's end — NOT validated (see below)
        key_ans = (answer_key[i] or "").strip().upper()
        parsed_ans = (q.get("correct_answer") or "").strip().upper()
        if not key_ans:
            continue  # blank key slot: nothing to validate against
        if key_ans != parsed_ans:
            mismatches.append({
                "index": i,
                "parsed": parsed_ans,
                "key": key_ans,
                "prompt": (q.get("prompt") or "")[:80],
            })
            if apply:
                q["correct_answer"] = key_ans
        else:
            matched += 1
    # Questions BEYOND the key's length were never compared, so they must not be
    # reported as "matched": a short/misaligned pasted key previously returned a
    # full match_count with zero mismatches, giving false confidence on
    # unvalidated official answers. Surface the gap explicitly instead.
    uncovered = max(0, len(questions) - len(answer_key))
    return {
        "total_questions": len(questions),
        "key_length": len(answer_key),
        "covered_questions": min(len(questions), len(answer_key)),
        "uncovered_questions": uncovered,
        "key_too_short": uncovered > 0,
        "mismatches": mismatches,
        # Only questions actually validated against the key AND agreeing.
        "match_count": matched,
        "applied": apply,
        "parsed": parsed,
    }


_VALID_ANSWERS = {"A", "B", "C", "D", "E"}


def commit_issues(parsed: dict) -> list[dict]:
    """Blocking data-integrity problems that must be resolved before commit (D1).

    A wrong/missing answer key on *official* content silently corrupts score
    prediction, so commit refuses until these are fixed (typically by running
    ``reconcile_answer_key`` against the official key) or the caller explicitly
    forces. Returns an empty list when the structure is safe to commit."""
    issues: list[dict] = []
    sections = parsed.get("sections", [])
    if not sections:
        issues.append({"kind": "no_sections", "detail": "No sections detected."})
    n_questions = 0
    for si, sec in enumerate(sections):
        for qi, q in enumerate(sec.get("questions", [])):
            n_questions += 1
            loc = f"Section {si + 1} Q{qi + 1}"
            ans = (q.get("correct_answer") or "").strip().upper()
            choices = q.get("choices", []) or []
            label_list = [(c.get("label") or "").strip().upper() for c in choices]
            labels = set(label_list)
            # audit H2 — `labels` is a SET, so five choices all labelled "A" used
            # to collapse to {"A"} and pass `ans in labels` + len==5, then
            # commit_structure marked EVERY label-matching choice is_correct=True,
            # silently corrupting official scoring. Flag duplicate labels so a
            # malformed OCR parse can't enter the scored bank without an explicit
            # force + visible issue.
            if len(labels) != len(label_list):
                issues.append({
                    "kind": "duplicate_labels", "where": loc,
                    "detail": f"{loc}: choices have duplicate labels "
                              f"({', '.join(label_list) or 'none'}); each of A–E must appear once.",
                })
            if ans not in _VALID_ANSWERS:
                issues.append({
                    "kind": "missing_answer", "where": loc,
                    "detail": f"{loc}: correct_answer is missing or invalid "
                              f"({ans or 'empty'}); reconcile against the answer key.",
                })
            elif ans not in labels:
                issues.append({
                    "kind": "answer_not_in_choices", "where": loc,
                    "detail": f"{loc}: correct_answer {ans} is not one of the choices.",
                })
            if len(choices) != 5:
                issues.append({
                    "kind": "choice_count", "where": loc,
                    "detail": f"{loc}: {len(choices)} choices (expected 5).",
                })
    if sections and n_questions == 0:
        issues.append({"kind": "no_questions", "detail": "No questions detected."})
    return issues


# --- collisions / replace (F8) ---------------------------------------------
def find_collision(session: Session, name: str | None) -> dict | None:
    """If a PrepTest with this name already exists, describe it so the importer
    can offer keep/replace on re-import."""
    if not name:
        return None
    pt = session.exec(select(PrepTest).where(PrepTest.name == name)).first()
    if pt is None:
        return None
    secs = session.exec(select(Section).where(Section.preptest_id == pt.id)).all()
    qcount = sum(
        len(session.exec(select(Question.id).where(Question.section_id == s.id)).all())
        for s in secs
    )
    return {"preptest_id": pt.id, "name": pt.name,
            "section_count": len(secs), "question_count": qcount}


def delete_questions_cascade(session: Session, question_ids: "list[int]") -> None:
    """5.3 — delete a set of questions and EVERY dependent row, in FK-safe order.

    The old per-PrepTest delete only removed AnswerChoice + Explanation, ORPHANING
    Attempt, SRSCard, Annotation, ErrorLogEntry, EmbeddingVector,
    AttemptChoiceEvent and SRSReviewLog rows that referenced the deleted
    questions. This removes them all so no dangling FK is left behind.

    Order (children before parents):
      ErrorLogEntry, AttemptChoiceEvent, attempt-scoped Annotation -> Attempt
      SRSReviewLog -> SRSCard
      question-scoped Annotation, EmbeddingVector(question)
      AnswerChoice, Explanation -> Question
    """
    qids = [q for q in question_ids if q is not None]
    if not qids:
        return

    # 1) Attempts (and everything that hangs off them).
    attempts = session.exec(
        select(Attempt).where(Attempt.question_id.in_(qids))
    ).all()
    attempt_ids = [a.id for a in attempts]
    if attempt_ids:
        for e in session.exec(
            select(ErrorLogEntry).where(ErrorLogEntry.attempt_id.in_(attempt_ids))
        ).all():
            session.delete(e)
        for ev in session.exec(
            select(AttemptChoiceEvent)
            .where(AttemptChoiceEvent.attempt_id.in_(attempt_ids))
        ).all():
            session.delete(ev)
        for an in session.exec(
            select(Annotation)
            .where(Annotation.scope == "attempt")
            .where(Annotation.ref_id.in_(attempt_ids))
        ).all():
            session.delete(an)
        session.flush()
        for a in attempts:
            session.delete(a)

    # 2) SRS cards + their append-only review log.
    cards = session.exec(
        select(SRSCard).where(SRSCard.question_id.in_(qids))
    ).all()
    card_ids = [c.id for c in cards]
    # SRSReviewLog references either the card (FK) or the question (soft ref).
    review_logs = session.exec(
        select(SRSReviewLog).where(SRSReviewLog.question_id.in_(qids))
    ).all()
    if card_ids:
        review_logs += session.exec(
            select(SRSReviewLog).where(SRSReviewLog.card_id.in_(card_ids))
        ).all()
    for rl in {r.id: r for r in review_logs}.values():
        session.delete(rl)
    session.flush()
    for c in cards:
        session.delete(c)

    # 3) Question-scoped annotations + question embeddings.
    for an in session.exec(
        select(Annotation)
        .where(Annotation.scope == "question")
        .where(Annotation.ref_id.in_(qids))
    ).all():
        session.delete(an)
    for ev in session.exec(
        select(EmbeddingVector)
        .where(EmbeddingVector.kind == "question")
        .where(EmbeddingVector.ref_id.in_(qids))
    ).all():
        session.delete(ev)

    # 4) Direct children of the questions, then the questions themselves.
    for c in session.exec(
        select(AnswerChoice).where(AnswerChoice.question_id.in_(qids))
    ).all():
        session.delete(c)
    for e in session.exec(
        select(Explanation).where(Explanation.question_id.in_(qids))
    ).all():
        session.delete(e)
    for q in session.exec(select(Question).where(Question.id.in_(qids))).all():
        session.delete(q)


def _delete_preptest(
    session: Session,
    preptest_id: int,
    *,
    commit: bool = True,
) -> None:
    """Delete a PrepTest and ALL dependents (complete cascade, 5.3).

    Removes sections/passages/questions and every row that referenced those
    questions (attempts, SRS cards + review logs, annotations, error-log entries,
    embeddings, choice events) so no orphaned FK survives the delete."""
    secs = session.exec(select(Section).where(Section.preptest_id == preptest_id)).all()
    all_qids: list[int] = []
    for s in secs:
        all_qids.extend(
            session.exec(
                select(Question.id).where(Question.section_id == s.id)
            ).all()
        )
    delete_questions_cascade(session, all_qids)
    for s in secs:
        for p in session.exec(select(Passage).where(Passage.section_id == s.id)).all():
            session.delete(p)
        session.delete(s)
    pt = session.get(PrepTest, preptest_id)
    if pt is not None:
        session.delete(pt)
    if commit:
        session.commit()


# --- commit -----------------------------------------------------------------
def commit_structure(session: Session, parsed: dict,
                     source: str = "official", replace: bool = False,
                     *,
                     training_eligible: bool = False,
                     training_role: Optional[str] = None,
                     training_notes: Optional[str] = None) -> int:
    """Persist a (possibly edited) parsed structure. Returns preptest_id.

    With ``replace=True`` an existing PrepTest of the same name is deleted first
    (re-import replace), instead of creating a duplicate.

    The ``training_*`` kwargs (Wave 1.6) flag every question as training-corpus
    material by default. Individual questions can override via a
    ``training_eligible`` (and optional ``training_role`` / ``training_notes``)
    field in their parsed dict — useful for excluding noisy-OCR items in the
    verification step.
    """
    name = parsed.get("name", "Imported PrepTest")
    try:
        with session.begin_nested():
            if replace:
                existing = session.exec(
                    select(PrepTest).where(PrepTest.name == name)
                ).first()
                if existing is not None:
                    _delete_preptest(session, existing.id, commit=False)

            is_official = source == "official"
            pt = PrepTest(
                name=name,
                source=source,
                is_official=is_official,
            )
            session.add(pt)
            session.flush()

            src = QuestionSource.official if is_official else QuestionSource.sample
            default_role = training_role
            if training_eligible and not default_role:
                default_role = "both"

            for order, sec in enumerate(parsed.get("sections", [])):
                section = Section(
                    preptest_id=pt.id,
                    type=SectionType(sec.get("type", "LR")),
                    order=order,
                    time_limit_sec=sec.get("time_limit_sec", 2100),
                )
                session.add(section)
                session.flush()

                passage_ids: list[int] = []
                for p in sec.get("passages", []):
                    passage = Passage(
                        section_id=section.id,
                        text=p.get("text", ""),
                        type=p.get("type"),
                        topic=p.get("topic"),
                    )
                    session.add(passage)
                    session.flush()
                    passage_ids.append(passage.id)

                for q in sec.get("questions", []):
                    pid = None
                    pref = q.get("passage_index")
                    if pref is not None and 0 <= pref < len(passage_ids):
                        pid = passage_ids[pref]
                    # Per-question training override: a parsed dict may set its own
                    # ``training_eligible`` (typically False) to opt a noisy item out
                    # of an otherwise training-flagged PDF.
                    if "training_eligible" in q:
                        q_training_eligible = bool(q.get("training_eligible"))
                        q_training_role = q.get("training_role")
                        if q_training_eligible and not q_training_role:
                            q_training_role = default_role or "both"
                        q_training_notes = q.get("training_notes", training_notes)
                    else:
                        q_training_eligible = training_eligible
                        q_training_role = default_role
                        q_training_notes = training_notes
                    question = Question(
                        section_id=section.id,
                        passage_id=pid,
                        stem=q.get("stem", ""),
                        prompt=q.get("prompt", ""),
                        correct_answer=q.get("correct_answer", "A"),
                        difficulty=clamp_difficulty(q.get("difficulty")),
                        q_type=q.get("q_type", "Inference"),
                        source=src,
                        approved=True,
                        training_eligible=q_training_eligible,
                        training_role=q_training_role,
                        training_notes=q_training_notes,
                    )
                    session.add(question)
                    session.flush()
                    for c in q.get("choices", []):
                        session.add(AnswerChoice(
                            question_id=question.id,
                            label=c.get("label", "?"),
                            text=c.get("text", ""),
                            is_correct=((c.get("label") or "").strip().upper()
                                        == (q.get("correct_answer") or "").strip().upper()),
                            trap_type=c.get("trap_type"),
                        ))
            preptest_id = pt.id
        session.commit()
        return int(preptest_id)
    except Exception:
        session.rollback()
        raise


# --- test fixture -----------------------------------------------------------
def write_fixture_pdf(path: str) -> str:
    """Write a tiny synthetic LSAT-style PDF for tests. Returns the path."""
    doc = fitz.open()
    page = doc.new_page()
    text = (
        "Synthetic Practice Test\n\n"
        "Question 1\n"
        "A study found that towns with more libraries have higher literacy. "
        "Therefore building libraries causes literacy to rise.\n"
        "Which one of the following most weakens the argument?\n"
        "(A) Libraries are expensive to maintain.\n"
        "(B) Towns that value literacy tend to build more libraries.\n"
        "(C) Some libraries are rarely used.\n"
        "(D) Literacy can be measured in several ways.\n"
        "(E) Online resources also improve literacy.\n"
        "Answer: B\n"
    )
    page.insert_text((72, 72), text, fontsize=11)
    doc.save(path)
    doc.close()
    return path
