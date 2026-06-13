"""Background pass that pre-generates explanations for un-explained questions.

Why this exists
---------------
Explanations were generated on demand and cached, so the first time a student
revealed a generated drill or freshly imported question they waited ~20s for the
model. This pass fills the cache ahead of time (run from the worker / a button),
so the study loop never blocks. The generator is injectable so tests don't call
the model.
"""
from __future__ import annotations

import inspect
from collections.abc import Callable
from typing import Optional

from sqlmodel import Session, select

from . import ai, config, embeddings
from .models import AnswerChoice, Explanation, ExplanationSource, Passage, Question, QuestionSource

# (stem, prompt, choices, correct) -> explanation body
Generator = Callable[..., str]


def _accepts_kw(generator: Generator, name: str) -> bool:
    params = inspect.signature(generator).parameters
    return name in params or any(
        p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()
    )


def _generate_checked(generator: Generator, stem: str, prompt: str,
                      choice_dicts: list[dict], correct: str,
                      exemplar: Optional[dict],
                      passage_text: Optional[str] = None,
                      passage_topic: Optional[str] = None) -> Optional[tuple[str, bool, str]]:
    """Generate an explanation, SELF-CHECK its asserted answer, regenerate once on
    a contradiction, and report ``(body, answer_checked, confidence)``.

    2.6 self-check flow (cached/sync path):
    1. Generate. Verify the letter the explanation ASSERTS is correct == ``correct``.
    2. On a contradiction, regenerate ONCE (sampling can recover).
    3. If it still contradicts, return the better attempt flagged
       ``answer_checked=False`` / ``confidence="low"`` so the caller does NOT cache
       it as authoritative. ``confidence`` is "high" when verified, "medium" when
       the explanation simply named no letter (nothing to contradict).

    Returns ``None`` when generation produced nothing usable at all.
    """
    best: Optional[tuple[str, bool, str]] = None
    # B27: introspect the generator's signature to decide whether to forward
    # optional kwargs. Using inspect.signature avoids catching TypeError which can
    # mask genuine bugs in the generator itself.
    optional_kwargs = {}
    if _accepts_kw(generator, "exemplar"):
        optional_kwargs["exemplar"] = exemplar
    if _accepts_kw(generator, "passage_text"):
        optional_kwargs["passage_text"] = passage_text
    if _accepts_kw(generator, "passage_topic"):
        optional_kwargs["passage_topic"] = passage_topic
    for attempt in range(2):
        try:
            body = generator(stem, prompt, choice_dicts, correct, **optional_kwargs)
        except Exception:
            break
        if not body or not body.strip():
            continue
        checked, confidence = ai.check_explanation(body, correct)
        if checked:
            return body, checked, confidence
        # Keep the first non-empty attempt as the flagged fallback.
        if best is None:
            best = (body, checked, confidence)
    return best


def pregenerate_explanations(session: Session, *, limit: int = 20,
                             sources: Optional[list[str]] = None,
                             generator: Optional[Generator] = None,
                             cache_unverified: bool = False) -> dict:
    """Generate + cache explanations for up to ``limit`` questions that lack one.

    2.6: each explanation is self-checked against the question's real answer and
    regenerated once on a contradiction. A still-contradictory explanation is NOT
    cached as authoritative (it's counted in ``flagged`` instead), unless
    ``cache_unverified=True`` (then it is stored with ``answer_checked=False`` /
    ``confidence="low"`` so the UI can warn). ``model_used``/``confidence``/
    ``answer_checked`` are populated on every write.
    """
    generator = generator or ai.explain_sync
    have = {e.question_id for e in session.exec(select(Explanation)).all()}

    todo: list[Question] = []
    for q in session.exec(select(Question)).all():
        if q.id in have:
            continue
        if q.source == QuestionSource.ai_generated and (q.quarantined or not q.approved):
            continue
        src = q.source.value if hasattr(q.source, "value") else str(q.source)
        if sources is not None and src not in sources:
            continue
        todo.append(q)

    explained = 0
    flagged = 0
    # B28: batch commits every 25 explanations instead of per-loop to reduce
    # SQLite write contention and I/O overhead during large pregenerate runs.
    _COMMIT_BATCH = 25
    for q in todo[:max(0, limit)]:
        choices = sorted(
            session.exec(select(AnswerChoice).where(AnswerChoice.question_id == q.id)).all(),
            key=lambda c: c.label,
        )
        choice_dicts = [{"label": c.label, "text": c.text} for c in choices]
        # 2.7 — best-effort worked exemplar (no-op when nothing similar/embeddings
        # absent). Never blocks the batch.
        try:
            exemplar = embeddings.exemplar_for_question(session, q.id)
        except Exception:
            exemplar = None
        passage_text = None
        passage_topic = None
        if q.passage_id is not None:
            passage = session.get(Passage, q.passage_id)
            if passage is not None:
                passage_text = passage.text
                passage_topic = passage.topic
        result = _generate_checked(generator, q.stem, q.prompt, choice_dicts,
                                   q.correct_answer, exemplar,
                                   passage_text=passage_text,
                                   passage_topic=passage_topic)
        if result is None:
            continue
        body, answer_checked, confidence = result
        if not answer_checked and not cache_unverified:
            # Contradictory after a regenerate: don't enshrine it as canonical.
            flagged += 1
            continue
        per = ai.parse_per_choice(body, [c.label for c in choices])
        session.add(Explanation(
            question_id=q.id, body=body,
            source=ExplanationSource.ai, per_choice_json=per,
            model_used=config.EXPLAIN_MODEL,
            confidence=confidence,
            answer_checked=answer_checked,
        ))
        explained += 1
        if explained % _COMMIT_BATCH == 0:
            session.commit()
    session.commit()  # flush remaining rows in the last partial batch

    return {"explained": explained, "flagged": flagged,
            "remaining": max(0, len(todo) - explained - flagged)}
