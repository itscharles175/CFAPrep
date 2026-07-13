"""Ollama integration (Tier A: explain, diagnose, health).

All network access flows through `_chat_stream` / `_chat` so unit tests can
monkeypatch a single seam. qwen3 emits <think>...</think> reasoning blocks which
we strip before showing or persisting.
"""
from __future__ import annotations

import logging
import re
from collections.abc import AsyncIterator
from typing import Optional

import httpx

from . import config, llm
from .observability import time_llm_call

_log = logging.getLogger("lsatlab.ai")
# Bank-expansion plan Wave 1.5 — resolve the preferred explain model once per
# process. The default is ``phi4:14b`` (Tier-A explanation quality lift) but
# laptops without phi4 pulled fall back to ``qwen3:8b`` transparently.
_EXPLAIN_MODEL_RESOLVED: Optional[str] = None


def _model_pulled_sync(name: str) -> bool:
    """Best-effort sync check: is ``name`` listed by ``ollama list``? Returns
    True on probe error so a temporary blip doesn't cause an unnecessary
    fallback for the lifetime of the process."""
    try:
        resp = httpx.get(f"{config.OLLAMA_URL}/api/tags", timeout=5.0)
        resp.raise_for_status()
        models = [m["name"] for m in resp.json().get("models", [])]
    except Exception as exc:
        _log.warning("explain-model probe failed (%s); using configured default", exc)
        return True
    # Ollama tag lookups are exact-prefix-friendly: "phi4:14b" listed as
    # "phi4:14b" or "phi4" (untagged latest) both satisfy the user's intent.
    base = name.split(":", 1)[0]
    for m in models:
        if m == name or m == base or m.startswith(f"{base}:"):
            return True
    return False


def _model_in_list(name: str, models: list[str]) -> bool:
    """True if ``name`` matches an id in ``models`` (exact, or Ollama base/tag —
    'phi4' matches 'phi4:14b'). Used to flag configured-but-absent models on the
    active provider in :func:`health`."""
    base = name.split(":", 1)[0]
    for m in models:
        if m == name or m == base or m.startswith(f"{base}:"):
            return True
    return False


def _recovery_for_missing(mid: str, *, provider: str, key: str,
                          fallback: Optional[str]) -> dict:
    """Build an actionable recovery hint for a configured-but-absent model (BA6).

    Returns ``{model, action, command, fallback}`` so the UI can tell the user
    exactly how to fix a missing model. For Ollama the command is the concrete
    ``ollama pull <id>``; for LMStudio there is no CLI pull, so the action points
    the user at loading the model in the LMStudio UI (``command`` is ``None``).
    ``fallback`` is the configured fallback id for that slot when one exists
    (e.g. the explain model's ``EXPLAIN_FALLBACK_MODEL``), else ``None``.
    """
    if provider == "ollama":
        action = f"Pull '{mid}' into Ollama, or load a substitute model."
        command = f"ollama pull {mid}"
    else:
        action = (
            f"Load '{mid}' in {provider} (the model id must match exactly), "
            "or update the configured model id to one that is loaded."
        )
        command = None
    return {
        "model": mid,
        "action": action,
        "command": command,
        "fallback": fallback or None,
    }


def resolve_explain_model() -> str:
    """Return the effective Tier-A explain model, falling back to
    ``EXPLAIN_FALLBACK_MODEL`` when the preferred one isn't pulled. Cached for
    the lifetime of the process; tests reset it via :func:`reset_resolved_models`.
    """
    global _EXPLAIN_MODEL_RESOLVED
    if _EXPLAIN_MODEL_RESOLVED is not None:
        return _EXPLAIN_MODEL_RESOLVED
    preferred = config.EXPLAIN_MODEL
    # The phi4 -> qwen3 fallback probe queries Ollama's tag list, so it's
    # Ollama-tag specific. With LMStudio the user configures an explicit model
    # id, so use it as-is (no probe).
    if config.LOCAL_PROVIDER != "ollama":
        _EXPLAIN_MODEL_RESOLVED = preferred
        return _EXPLAIN_MODEL_RESOLVED
    fallback = config.EXPLAIN_FALLBACK_MODEL or preferred
    if preferred == fallback or _model_pulled_sync(preferred):
        _EXPLAIN_MODEL_RESOLVED = preferred
    else:
        _log.warning(
            "explain-model '%s' not pulled; falling back to '%s'",
            preferred, fallback,
        )
        _EXPLAIN_MODEL_RESOLVED = fallback
    return _EXPLAIN_MODEL_RESOLVED


def reset_resolved_models() -> None:
    """Test hook: clear the cached explain-model resolution so the next call
    re-probes Ollama. Production code never needs this."""
    global _EXPLAIN_MODEL_RESOLVED
    _EXPLAIN_MODEL_RESOLVED = None

_REASONING_TAGS = ("thinking", "reasoning", "thought", "think")
_TAG_ALT = "|".join(_REASONING_TAGS)
_ANY_REASONING_TAG_RE = re.compile(rf"<(/?)(?:{_TAG_ALT})\b[^>]*>", re.IGNORECASE)
_OPEN_TO_END_RE = re.compile(rf"<(?:{_TAG_ALT})\b[^>]*>[\s\S]*$", re.IGNORECASE)
_STRAY_TAG_RE = re.compile(rf"</?(?:{_TAG_ALT})\b[^>]*>", re.IGNORECASE)
_LEADING_FENCE_RE = re.compile(
    rf"^\s*```(?:{_TAG_ALT})[^\n]*\n[\s\S]*?(?:```|$)",
    re.IGNORECASE,
)
_LEADING_FENCE_HEADER_RE = re.compile(rf"^\s*```(?:{_TAG_ALT})[^\n]*\n", re.IGNORECASE)


def strip_think(text: str) -> str:
    """Remove reasoning traces from completed model text."""
    if not isinstance(text, str) or not text:
        return ""
    out = _LEADING_FENCE_RE.sub("", text)
    out = _remove_balanced_reasoning(out)
    out = _OPEN_TO_END_RE.sub("", out)
    out = _STRAY_TAG_RE.sub("", out)
    return out.strip()


def _remove_balanced_reasoning(text: str) -> str:
    result: list[str] = []
    cursor = 0
    depth = 0
    region_start = -1
    for match in _ANY_REASONING_TAG_RE.finditer(text):
        is_close = match.group(1) == "/"
        if not is_close:
            if depth == 0:
                result.append(text[cursor:match.start()])
                region_start = match.start()
            depth += 1
        elif depth > 0:
            depth -= 1
            if depth == 0:
                cursor = match.end()
                region_start = -1
    if depth > 0 and region_start >= 0:
        result.append(text[region_start:])
    else:
        result.append(text[cursor:])
    return "".join(result)


def _find_next_reasoning_tag(text: str) -> re.Match[str] | None:
    return _ANY_REASONING_TAG_RE.search(text)


def _potential_reasoning_tag_prefix(text: str, index: int) -> bool:
    tail = text[index:].lower()
    if not tail.startswith("<") or ">" in tail:
        return False
    rest = tail[1:]
    if rest.startswith("/"):
        rest = rest[1:]
    if not rest:
        return True
    for tag in _REASONING_TAGS:
        if tag.startswith(rest):
            return True
        if rest.startswith(tag):
            next_char = rest[len(tag):len(tag) + 1]
            if not next_char or next_char.isspace() or next_char == "/":
                return True
    return False


def _find_potential_reasoning_tag_prefix(text: str) -> int:
    index = text.rfind("<")
    while index >= 0:
        if _potential_reasoning_tag_prefix(text, index):
            return index
        index = text.rfind("<", 0, index)
    return -1


def _split_outside_reasoning(text: str) -> tuple[str, str]:
    partial = _find_potential_reasoning_tag_prefix(text)
    if partial < 0:
        return text, ""
    return text[:partial], text[partial:]


def _keep_possible_closing_fence(text: str) -> str:
    if text.endswith("``"):
        return "``"
    if text.endswith("`"):
        return "`"
    return ""


def _potential_leading_fence_prefix(text: str) -> bool:
    tail = re.sub(r"^\s+", "", text).lower()
    if not tail:
        return True
    if not tail.startswith("```"):
        return ("`" * min(len(tail), 3)).startswith(tail)
    header = tail[3:]
    if not header:
        return True
    line_end = header.find("\n")
    header_part = header[:line_end] if line_end >= 0 else header
    if not header_part:
        return True
    return any(
        tag.startswith(header_part) or (line_end < 0 and header_part.startswith(tag))
        for tag in _REASONING_TAGS
    )


class _ThinkFilter:
    """Streaming filter that suppresses reasoning tags split across chunks."""

    def __init__(self) -> None:
        self._buf = ""
        self._depth = 0
        self._at_start = True
        self._dropping_leading_fence = False

    def _process_leading_fence(self) -> str:
        if not self._at_start or self._depth > 0:
            return "none"
        if self._dropping_leading_fence:
            close_index = self._buf.find("```")
            if close_index < 0:
                self._buf = _keep_possible_closing_fence(self._buf)
                return "hold"
            self._buf = re.sub(r"^\r?\n", "", self._buf[close_index + 3:])
            self._dropping_leading_fence = False
            self._at_start = False
            return "handled"
        header = _LEADING_FENCE_HEADER_RE.match(self._buf)
        if header:
            self._buf = self._buf[header.end():]
            self._dropping_leading_fence = True
            return "handled"
        if _potential_leading_fence_prefix(self._buf):
            return "hold"
        self._at_start = False
        return "none"

    def feed(self, chunk: str) -> str:
        if not isinstance(chunk, str) or not chunk:
            return ""
        self._buf += chunk
        out: list[str] = []
        while self._buf:
            fence_state = self._process_leading_fence()
            if fence_state == "hold":
                break
            if fence_state == "handled":
                continue

            tag = _find_next_reasoning_tag(self._buf)
            if self._depth > 0:
                if not tag:
                    partial = _find_potential_reasoning_tag_prefix(self._buf)
                    self._buf = self._buf[partial:] if partial >= 0 else ""
                    break
                self._depth += -1 if tag.group(1) == "/" else 1
                if self._depth < 0:
                    self._depth = 0
                self._buf = self._buf[tag.end():]
                continue

            if not tag:
                safe, hold = _split_outside_reasoning(self._buf)
                out.append(safe)
                self._buf = hold
                break

            out.append(self._buf[:tag.start()])
            self._buf = self._buf[tag.end():]
            if tag.group(1) != "/":
                self._depth = 1
            else:
                # Stray close tags are markup, not user-facing content.
                continue
        return "".join(out)

    def flush(self) -> str:
        if self._dropping_leading_fence or self._depth > 0:
            self._buf = ""
            self._depth = 0
            self._at_start = False
            self._dropping_leading_fence = False
            return ""
        if self._at_start and _potential_leading_fence_prefix(self._buf):
            self._buf = ""
            self._at_start = False
            return ""
        safe, _hold = _split_outside_reasoning(self._buf)
        self._buf = ""
        self._at_start = False
        return safe


async def _chat_stream(model: str, messages: list[dict], timeout: float) -> AsyncIterator[str]:
    """Yield raw content deltas from Ollama (think tags NOT stripped).

    Delegates transport (retry-on-connect, concurrency cap) to the provider.
    """
    prov = llm.local_provider()
    with time_llm_call("explain_stream", provider=prov.name, model=model):
        async for delta in prov.chat_stream(model, messages, timeout):
            yield delta


async def _chat(model: str, messages: list[dict], timeout: float) -> str:
    """Non-streaming chat completion; returns content with think stripped."""
    prov = llm.local_provider()
    with time_llm_call("chat", provider=prov.name, model=model):
        content = await prov.chat(model, messages, timeout)
    return strip_think(content)


# --- Prompts ----------------------------------------------------------------
_MAX_PASSAGE_PROMPT_CHARS = 5_000


def _trim_passage_for_prompt(text: str, limit: int = _MAX_PASSAGE_PROMPT_CHARS) -> str:
    """Keep RC passage grounding useful without letting it dominate the prompt."""
    cleaned = (text or "").strip()
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[:limit].rstrip() + "\n[Passage truncated for prompt length.]"


def _explain_prompt(stem: str, prompt: str, choices: list[dict],
                    correct: str, chosen: str | None,
                    context_notes: list[str] | None = None,
                    user_message: str | None = None,
                    focus_choice: str | None = None,
                    exemplar: dict | None = None,
                    passage_text: str | None = None,
                    passage_topic: str | None = None,
                    socratic_context: dict | None = None,
                    trap_misses: list[dict] | None = None) -> list[dict]:
    choice_lines = "\n".join(f"({c['label']}) {c['text']}" for c in choices)
    is_rc = bool((passage_text or "").strip())
    sys = (
        "You are an expert LSAT tutor. Explain clearly and concisely why the "
        "correct answer is right and why each wrong answer is a trap. Be specific "
        "about the logical structure. State your confidence honestly: if a choice "
        "is genuinely close or the reasoning is subtle, say so rather than feigning "
        "certainty. Never assert a correct answer other than the one given."
    )
    if is_rc:
        sys += (
            " For Reading Comprehension, ground every factual claim in the passage; "
            "do not use outside knowledge, and treat unsupported or overbroad answer "
            "choices as traps."
        )
    passage_block = ""
    if is_rc:
        topic = f"Topic: {passage_topic.strip()}\n" if passage_topic else ""
        passage_block = (
            "Reading Comprehension passage:\n"
            f"{topic}{_trim_passage_for_prompt(passage_text or '')}\n\n"
        )
    user = (
        f"Question type context.\n\n{passage_block}Stimulus:\n{stem}\n\nPrompt: {prompt}\n\n"
        f"Answer choices:\n{choice_lines}\n\n"
        f"The correct answer is ({correct}).\n"
    )
    if chosen and chosen != correct:
        user += f"The student chose ({chosen}), which is wrong.\n"
    if exemplar and exemplar.get("explanation"):
        # 2.7 — a worked exemplar: how a SIMILAR (real) question is explained, so
        # style/structure/rigor transfer. Never the same question.
        ex_body = str(exemplar["explanation"]).strip()
        if len(ex_body) > 1200:
            ex_body = ex_body[:1200] + " ..."
        user += (
            "\nHere is how a similar question is explained well — match this style, "
            f"structure, and rigor (do NOT copy its content):\n{ex_body}\n"
        )
    if context_notes:
        joined = "\n".join(f"- {n}" for n in context_notes)
        user += (
            "\nThe student previously wrote these notes on similar questions they "
            f"missed; reinforce any relevant lesson:\n{joined}\n"
        )
    if trap_misses:
        # LSAT-2 — name the recurring trap shapes the student keeps falling
        # for so the explanation can call out the pattern directly
        # ("you fell for this reversal on Q31, Q18").
        trap_lines = []
        for m in trap_misses[:5]:
            qid = m.get("question_id")
            trap = m.get("trap_type") or "unknown"
            picked = m.get("chosen_answer")
            note = (m.get("note_excerpt") or "").strip()
            line = f"- Q{qid}: trap '{trap}'"
            if picked:
                line += f", you chose ({picked})"
            if note:
                line += f" — your note: {note}"
            trap_lines.append(line)
        if trap_lines:
            user += (
                "\nCommon traps you've fallen for on similar questions — call "
                "out the recurring pattern by name if this question shares it:\n"
                + "\n".join(trap_lines)
                + "\n"
            )
    if socratic_context:
        lines: list[str] = []
        if socratic_context.get("timed_answer"):
            lines.append(f"- Timed prediction: ({socratic_context['timed_answer']})")
        if socratic_context.get("blind_review_answer"):
            lines.append(
                f"- Blind Review answer: ({socratic_context['blind_review_answer']})"
            )
        rationale = socratic_context.get("rationale") or {}
        if rationale.get("answer"):
            lines.append(f"- Saved rationale answer: ({rationale['answer']})")
        if rationale.get("trap_guess"):
            lines.append(f"- Student trap guess: {rationale['trap_guess']}")
        if rationale.get("text"):
            lines.append(f"- Student rationale: {rationale['text']}")
        turns = socratic_context.get("recent_turns") or []
        if turns:
            turn_lines = [
                f"  {row.get('role')}: {row.get('content')}"
                for row in turns[:4]
                if row.get("content")
            ]
            if turn_lines:
                lines.append("- Recent Socratic turns:\n" + "\n".join(turn_lines))
        if lines:
            user += (
                "\nBefore revealing, the student captured this Socratic reasoning "
                "trail. Contrast it with the credited reasoning directly and "
                "kindly; name the first move that would have corrected the path:\n"
                + "\n".join(lines)
                + "\n"
            )
    if focus_choice:
        user += f"\nFocus your explanation on answer choice ({focus_choice}).\n"
    if user_message:
        # A follow-up turn: answer the student's question directly rather than
        # re-emitting the full per-choice breakdown.
        user += f'\nThe student asks a follow-up: "{user_message}"\n'
        if is_rc:
            user += (
                "Answer it directly and concisely, grounded in the passage, stimulus, "
                "and answer choices. Don't repeat the whole breakdown unless asked."
            )
        else:
            user += (
                "Answer it directly and concisely, grounded in the stimulus and the "
                "answer choices. Don't repeat the whole breakdown unless asked."
            )
    else:
        user += (
            "\nWrite a short overall explanation paragraph, then a one-line note for "
            "EACH choice (A-E) explaining why it is right or what trap it represents. "
            "Format the per-choice notes as lines like 'A: ...'."
        )
    return [{"role": "system", "content": sys}, {"role": "user", "content": user}]


def parse_per_choice(text: str, labels: list[str]) -> dict[str, str]:
    """Best-effort extraction of 'A: ...' style per-choice notes."""
    per: dict[str, str] = {}
    for line in text.splitlines():
        m = re.match(r"^\s*\(?([A-E])\)?\s*[:.\)-]\s*(.+)$", line.strip())
        if m and m.group(1) in labels:
            per[m.group(1)] = m.group(2).strip()
    return per


# 2.6 — phrases by which an explanation ASSERTS which letter is correct, so we can
# verify the model's stated answer matches the question's true ``correct_answer``.
_ASSERTS_CORRECT_RE = re.compile(
    r"(?:correct\s+answer\s+is|correct\s+choice\s+is|answer\s+is|"
    r"correct\s+answer:?)\s*\(?([A-E])\)?",
    re.IGNORECASE,
)


def asserted_letter(text: str) -> str | None:
    """The letter the explanation claims is correct, or None if it doesn't say.

    Looks for an explicit "the correct answer is (X)" style assertion first; if
    none is found, falls back to the choice the per-choice notes mark as
    "correct" (e.g. a line ``A: Correct ...``). Used by the self-check to catch an
    explanation that argues for a DIFFERENT letter than the real answer.
    """
    if not text:
        return None
    m = _ASSERTS_CORRECT_RE.search(text)
    if m:
        return m.group(1).upper()
    # Fallback: a per-choice line that flags itself as the correct one.
    for line in text.splitlines():
        pm = re.match(r"^\s*\(?([A-E])\)?\s*[:.\)-]\s*(.+)$", line.strip())
        if pm and re.match(r"\s*correct\b", pm.group(2), re.IGNORECASE):
            return pm.group(1).upper()
    return None


def check_explanation(text: str, correct: str) -> tuple[bool, str]:
    """Self-check an explanation against the true answer.

    Returns ``(answer_checked, confidence)``:
    - asserted letter matches ``correct``      -> (True,  "high")
    - explanation asserts NO letter explicitly -> (True,  "medium")  (nothing to contradict)
    - asserted letter CONTRADICTS ``correct``  -> (False, "low")

    "medium" is the honest default when the model never named a letter: we can't
    confirm it, but it isn't actively wrong. "low"/``answer_checked=False`` is the
    contradiction signal callers use to regenerate or refuse to cache as canonical.
    """
    asserted = asserted_letter(text)
    if asserted is None:
        return True, "medium"
    if asserted == (correct or "").upper():
        return True, "high"
    return False, "low"


async def stream_explanation(stem: str, prompt: str, choices: list[dict],
                             correct: str, chosen: str | None,
                             context_notes: list[str] | None = None,
                             user_message: str | None = None,
                             focus_choice: str | None = None,
                             exemplar: dict | None = None,
                             passage_text: str | None = None,
                             passage_topic: str | None = None,
                             socratic_context: dict | None = None,
                             trap_misses: list[dict] | None = None) -> AsyncIterator[str]:
    """Yield think-filtered explanation tokens for a question.

    ``context_notes`` (optional) are the student's own past notes on similar
    questions, retrieved via embeddings, woven into the prompt for continuity.
    ``exemplar`` (optional, 2.7) is a worked explanation of a SIMILAR real
    question so style/structure transfer. ``user_message``/``focus_choice``
    support follow-up turns (A1).
    """
    messages = _explain_prompt(
        stem, prompt, choices, correct, chosen,
        context_notes=context_notes,
        user_message=user_message,
        focus_choice=focus_choice,
        exemplar=exemplar,
        passage_text=passage_text,
        passage_topic=passage_topic,
        socratic_context=socratic_context,
        trap_misses=trap_misses,
    )
    flt = _ThinkFilter()
    async for delta in _chat_stream(resolve_explain_model(), messages,
                                    config.EXPLAIN_REQUEST_TIMEOUT_S):
        out = flt.feed(delta)
        if out:
            yield out
    tail = flt.flush()
    if tail:
        yield tail


_DIAGNOSE_SYS = (
    "You are an LSAT performance coach. Given a summary of a student's recent "
    "attempts, give a short, actionable diagnosis (2-4 sentences) and one "
    "concrete next step. Be direct and specific."
)


async def diagnose(summary: str) -> str:
    """Plain-English diagnosis of recent performance for the Coach card."""
    messages = [
        {"role": "system", "content": _DIAGNOSE_SYS},
        {"role": "user", "content": summary},
    ]
    return await _chat(config.DIAGNOSE_MODEL, messages, config.EXPLAIN_REQUEST_TIMEOUT_S)


def diagnose_sync(summary: str) -> str:
    """Synchronous diagnosis (for the scheduled coach snapshot in worker threads)."""
    prompt = f"{_DIAGNOSE_SYS}\n\n{summary}"
    prov = llm.local_provider()
    with time_llm_call("diagnose_sync", provider=prov.name, model=config.DIAGNOSE_MODEL):
        raw = prov.generate(config.DIAGNOSE_MODEL, prompt,
                            timeout=config.EXPLAIN_REQUEST_TIMEOUT_S)
    return strip_think(raw)


_COACH_CHAT_SYS = (
    "You are an LSAT performance coach and tutor chatting with a student. You're "
    "given a grounded summary of their recent performance — weak question types, "
    "specific recent missed questions (by id), their blind-review gap, trap "
    "susceptibility, score forecast, and confidence calibration. Answer directly "
    "and practically in 2-5 sentences. Reference their actual data — cite specific "
    "question ids and weak types when relevant, and propose a concrete next step "
    "(a targeted drill, a blind-review pass, clearing SRS, or fixing pacing). "
    "Never invent scores; if the data doesn't say, be honest."
)


def _coach_chat_messages(
    summary: str,
    user_message: str,
    history: list[dict] | None = None,
) -> list[dict]:
    messages = [
        {"role": "system", "content": _COACH_CHAT_SYS},
        {"role": "user", "content": f"My recent performance:\n{summary}"},
    ]
    for h in (history or [])[-6:]:
        role = h.get("role")
        content = (h.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": user_message})
    return messages


async def coach_chat(summary: str, user_message: str,
                     history: list[dict] | None = None) -> str:
    """A grounded coach Q&A turn (X3). ``history`` is recent [{role, content}]."""
    messages = _coach_chat_messages(summary, user_message, history)
    return await _chat(config.DIAGNOSE_MODEL, messages,
                       config.EXPLAIN_REQUEST_TIMEOUT_S)


def _hint_prompt(stem: str, prompt: str, choices: list[dict]) -> list[dict]:
    """A short Socratic nudge that does NOT reveal or eliminate any choice (A10)."""
    ch = "\n".join(f"({c['label']}) {c['text']}" for c in choices)
    sys = "You are an LSAT tutor giving a gentle hint, never the answer."
    user = (
        f"Stimulus:\n{stem}\n\nPrompt: {prompt}\n\nChoices:\n{ch}\n\n"
        "Give ONE hint (1-2 sentences) nudging the student toward the right "
        "approach. Do NOT reveal the answer or say which choices are wrong."
    )
    return [{"role": "system", "content": sys}, {"role": "user", "content": user}]


async def hint(stem: str, prompt: str, choices: list[dict]) -> str:
    """A short Socratic nudge that does NOT reveal or eliminate any choice (A10)."""
    return await _chat(
        resolve_explain_model(),
        _hint_prompt(stem, prompt, choices),
        config.EXPLAIN_REQUEST_TIMEOUT_S,
    )


def error_diagnosis_sync(stem: str, reason: str, note: str,
                         chosen: str | None, correct: str) -> str:
    """Short root-cause diagnosis for an error-log entry (A6, runs in a thread)."""
    prompt = (
        f"A student missed an LSAT question. Reason category: {reason}. "
        f"Their note: {note or '(none)'}. They chose {chosen or '?'}; the correct "
        f"answer is {correct}.\n\nStimulus:\n{stem}\n\n"
        "In 2 sentences, diagnose the likely root cause and give one corrective tip."
    )
    prov = llm.local_provider()
    with time_llm_call("error_diagnosis", provider=prov.name, model=config.DIAGNOSE_MODEL):
        raw = prov.generate(config.DIAGNOSE_MODEL, prompt,
                            timeout=config.EXPLAIN_REQUEST_TIMEOUT_S)
    return strip_think(raw)


def explain_sync(stem: str, prompt: str, choices: list[dict], correct: str,
                 chosen: str | None = None,
                 context_notes: list[str] | None = None,
                 exemplar: dict | None = None,
                 passage_text: str | None = None,
                 passage_topic: str | None = None) -> str:
    """Synchronous explanation (for batch pre-generation in worker threads)."""
    msgs = _explain_prompt(
        stem, prompt, choices, correct, chosen,
        context_notes=context_notes,
        exemplar=exemplar,
        passage_text=passage_text,
        passage_topic=passage_topic,
    )
    combined = "\n\n".join(m["content"] for m in msgs)
    model = resolve_explain_model()
    prov = llm.local_provider()
    with time_llm_call("explain_sync", provider=prov.name, model=model):
        raw = prov.generate(model, combined,
                            timeout=config.EXPLAIN_REQUEST_TIMEOUT_S)
    return strip_think(raw)


async def health() -> dict:
    """Ping the active local provider; report available models + routing for the
    UI. ``ok``/``provider`` are the generic fields; ``ollama`` is kept for
    backward compatibility (true only when Ollama is the active local provider)."""
    prov = llm.local_provider()
    try:
        models = await prov.list_models()
        ok = True
    except Exception:
        models = []
        ok = False
    info = llm.provider_info()
    # Surface configured model ids the active provider doesn't list — common right
    # after switching to LMStudio, whose model ids differ from Ollama tags (e.g.
    # the phi4:14b explain default). Lets the UI prompt for a loaded model instead
    # of only failing at call time. Empty when unreachable (can't tell) or all present.
    #
    # BA6: each missing entry is an actionable recovery object
    # ``{model, action, command, fallback}`` (e.g. command="ollama pull phi4:14b")
    # so the UI can tell the user exactly how to fix it, not just that it's gone.
    # The fallback id is per-slot (only the explain slot has a configured fallback).
    missing: list[dict] = []
    if ok and models:
        keys = ["explain_model", "gen_model", "diagnose_model", "embed_model"]
        # The gate's critic is only a local model when offline generation is
        # local; under cloud generation it's a cloud slug, so don't flag it
        # against the local model list.
        if not info.get("cloud_enabled"):
            keys.append("critic_model")
        fallback_by_key = {"explain_model": info.get("explain_model_fallback")}
        seen: set[str] = set()
        for key in keys:
            mid = info.get(key)
            if mid and mid not in seen and not _model_in_list(mid, models):
                seen.add(mid)
                missing.append(
                    _recovery_for_missing(
                        mid,
                        provider=prov.name,
                        key=key,
                        fallback=fallback_by_key.get(key),
                    )
                )
        missing.sort(key=lambda m: m["model"])
    return {
        "ok": ok,
        "provider": prov.name,
        "models": models,
        "ollama": ok if prov.name == "ollama" else False,
        # Backward-compatible: missing_models stays a sorted list of STRING ids
        # (the host lsatBackend client + existing tests consume strings). BA6's
        # actionable recovery objects {model, action, command, fallback} are
        # exposed alongside under missing_models_recovery for the UI.
        "missing_models": sorted(m["model"] for m in missing),
        "missing_models_recovery": missing,
        **info,
    }
