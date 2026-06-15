"""Local embeddings + retrieval — the RAG layer docs/01-architecture.md promised.

Why this exists
---------------
The architecture specifies ``nomic-embed-text`` -> a vector store so the explainer
can pull the student's own past notes on *similar* questions, and so drills/dedup
can use semantic similarity. None of it existed. This builds it locally:
embeddings come from the local embed model via the LLM provider; vectors live in
the ``EmbeddingVector`` table as JSON and are compared with brute-force cosine.

Why brute force (not sqlite-vec)
--------------------------------
A single user's bank is a few thousand items; cosine over a few thousand vectors
is well under 50 ms and needs no native SQLite extension to load (fiddly on
Windows, awkward in CI). Callers go through this module, so a sqlite-vec backend
could drop in later without changing them.

Everything here is synchronous (embeddings run in worker threads / batch passes)
and the embedder is injectable so tests never touch the network.
"""
from __future__ import annotations

import logging
import math
import struct
import threading
from collections.abc import Callable
from typing import Optional, Protocol, runtime_checkable

from sqlmodel import Session, select

from . import config, llm
from .llm.base import sync_guard
from .models import (
    AnswerChoice,
    Attempt,
    AttemptRationale,
    EmbeddingVector,
    ErrorLogEntry,
    Explanation,
    Passage,
    Question,
    QuestionSource,
)

Embedder = Callable[[str], list[float]]

QUESTION = "question"
NOTE = "note"

_log = logging.getLogger("lsatlab.embeddings")


# Bank-expansion plan Wave 2.5 — abstract the vector layer so a future backend
# swap (sqlite-vec, FAISS, a Rust-side store, or just the Wave 3.5 numpy
# matrix rewrite) drops in without touching call sites. The default
# implementation (``SQLiteVectorStore``) is what the rest of this module wraps;
# downstream callers only know the Protocol.
@runtime_checkable
class VectorStore(Protocol):
    """The minimum vector-store surface the bank-expansion plan relies on."""

    def upsert(self, kind: str, ref_id: int, vector: list[float], model: str) -> None:
        """Insert or replace the vector for ``(kind, ref_id)``."""

    def all_for(self, kind: str) -> dict[int, list[float]]:
        """All stored vectors of ``kind`` as a ``{ref_id: vector}`` map.

        The current implementation caches this; callers may treat the returned
        dict as a snapshot and may mutate their local copy without affecting
        the store.
        """

    def cosine_top_k(self, query: list[float], k: int = 5, *,
                     kind: str = QUESTION,
                     exclude_id: Optional[int] = None) -> list[tuple[int, float]]:
        """Top-``k`` nearest stored vectors of ``kind`` by cosine similarity."""

    def reset_cache(self) -> None:
        """Drop any in-process caches (used after a DB reset)."""

# P3 — in-process cache of question vectors. Brute-force cosine is fast, but
# re-reading every EmbeddingVector row on every similarity call is the real cost
# at scale. Cache the map and invalidate it whenever a question vector is
# upserted (or the DB is reset, via reset_cache()).
# B15: guarded by an RLock so concurrent worker + request threads don't race on
# cache reads/writes. RLock (re-entrant) is used so embed_question → _upsert →
# reset_cache is safe even when called from within _question_vectors.
_vec_cache: "dict[int, list[float]] | None" = None
_vec_cache_lock = threading.RLock()
# BA7 — the embed model the live cache was built under. The cached question
# vectors are only comparable to a query embedded by the SAME model; if
# config.EMBED_MODEL changes at runtime (via /settings) the cache silently mixes
# vectors from two models. Track the build-time model name here and invalidate
# the cache before use whenever it diverges from config.EMBED_MODEL. Guarded by
# the same RLock as _vec_cache.
_vec_cache_model: "str | None" = None


def reset_cache() -> None:
    global _vec_cache, _vec_cache_model
    with _vec_cache_lock:
        _vec_cache = None
        _vec_cache_model = None


def _invalidate_cache_if_model_changed() -> None:
    """BA7 — drop the question-vector cache when the embed model has changed.

    Called at the top of every cache-using path. Compares the model the cache
    was built under (``_vec_cache_model``) against the live ``config.EMBED_MODEL``;
    on a mismatch (and only when a cache actually exists) it logs the
    invalidation and resets the cache so it rebuilds under the new model. Holding
    the RLock keeps the check-and-reset atomic against concurrent readers.
    """
    global _vec_cache, _vec_cache_model
    with _vec_cache_lock:
        if _vec_cache is not None and _vec_cache_model != config.EMBED_MODEL:
            _log.warning(
                "Embed model changed (%r -> %r); invalidating question-vector "
                "cache (%d entries) so it rebuilds under the new model.",
                _vec_cache_model, config.EMBED_MODEL, len(_vec_cache),
            )
            _vec_cache = None
            _vec_cache_model = None


class SQLiteVectorStore:
    """Default ``VectorStore`` implementation: rows in the ``EmbeddingVector``
    table, brute-force cosine, dict cache. Wave 3.5 swaps the JSON-on-disk
    representation for ``BLOB`` and the dict cache for a stacked numpy matrix;
    until then this class wraps the existing module-level functions so callers
    upgrade to the protocol without behaviour drift.

    Bound to a SQLModel ``Session``: the caller controls transactional scope.
    """

    def __init__(self, session: Session) -> None:
        self._session = session

    def upsert(self, kind: str, ref_id: int, vector: list[float],
               model: str) -> None:
        _upsert(self._session, kind, ref_id, list(vector), model)

    def all_for(self, kind: str) -> dict[int, list[float]]:
        if kind == QUESTION:
            return dict(_question_vectors(self._session))
        # No cache for other kinds yet — they're tiny (one row per note).
        return {
            r.ref_id: _row_vector(r)
            for r in self._session.exec(
                select(EmbeddingVector).where(EmbeddingVector.kind == kind)
            ).all()
            if _row_vector(r)
        }

    def cosine_top_k(self, query: list[float], k: int = 5, *,
                     kind: str = QUESTION,
                     exclude_id: Optional[int] = None) -> list[tuple[int, float]]:
        if not query:
            return []
        # BA7: ensure a stale-model cache is dropped before this cache-using path
        # reads it. (all_for -> _question_vectors also checks, but doing it here
        # keeps the guard at the top of the documented cache-using entry point.)
        _invalidate_cache_if_model_changed()
        vectors = self.all_for(kind)
        scored: list[tuple[int, float]] = []
        for ref_id, vec in vectors.items():
            if exclude_id is not None and ref_id == exclude_id:
                continue
            # B3: a stored vector of a different dimension can't be compared to
            # this query (different embed model) — skip it instead of scoring a
            # bogus 0.0 that would still occupy a top-k slot.
            if not _comparable(query, vec):
                continue
            scored.append((ref_id, cosine(query, vec)))
        scored.sort(key=lambda t: -t[1])
        return scored[: max(0, k)]

    def reset_cache(self) -> None:
        reset_cache()


_VEC_AVAILABLE: "bool | None" = None


def _sqlite_vec_available() -> bool:
    """Cached check: can we load the sqlite-vec extension on this build? The
    pure-Python cosine path is always correct, so a False here is never fatal —
    it just means we use the slower fallback."""
    global _VEC_AVAILABLE
    if _VEC_AVAILABLE is not None:
        return _VEC_AVAILABLE
    try:
        import sqlite3
        import sqlite_vec
        con = sqlite3.connect(":memory:")
        try:
            con.enable_load_extension(True)
            sqlite_vec.load(con)
            con.execute("SELECT vec_version()").fetchone()
        finally:
            con.close()
        _VEC_AVAILABLE = True
    except Exception:
        _VEC_AVAILABLE = False
    return _VEC_AVAILABLE


class SqliteVecStore(SQLiteVectorStore):
    """``VectorStore`` whose ``cosine_top_k`` uses sqlite-vec's native
    ``vec_distance_cosine`` over the stored ``vector_blob`` (a fast C scan) instead
    of the pure-Python loop — the win at 10k+ vectors. Reads via a short-lived
    private sqlite3 connection (extension loaded per call, so it's thread-safe and
    never touches the shared engine connections). Falls back to the pure-Python
    parent on ANY failure, so correctness/behaviour is preserved.

    Cosine parity: ``vec_distance_cosine`` returns cosine DISTANCE (1 - similarity)
    in float32; ascending distance == descending similarity, so the top-k ranking
    matches the pure-Python path (similarity = 1 - distance)."""

    def cosine_top_k(self, query: list[float], k: int = 5, *,
                     kind: str = QUESTION,
                     exclude_id: Optional[int] = None) -> list[tuple[int, float]]:
        if not query:
            return []
        rows = self._vec_top_k(query, k, kind=kind, exclude_id=exclude_id)
        if rows is None:  # sqlite-vec unavailable or errored -> pure-Python cosine
            return super().cosine_top_k(query, k, kind=kind, exclude_id=exclude_id)
        return rows

    @staticmethod
    def _vec_top_k(query: list[float], k: int, *, kind: str,
                   exclude_id: Optional[int]) -> "list[tuple[int, float]] | None":
        if not _sqlite_vec_available():
            return None
        import sqlite3
        import sqlite_vec
        qvec = list(query)
        qblob = _pack_vector(qvec)
        # B3: only scan rows dimension-comparable to this query. A stored vector
        # of a different dimension (a prior embed model) would make
        # vec_distance_cosine return a meaningless distance (or raise), silently
        # corrupting the ranking; constrain by the query's dimension so a model
        # switch never mixes incompatible vectors.
        sql = (
            "SELECT ref_id, vec_distance_cosine(vector_blob, ?) AS d "
            "FROM embeddingvector WHERE kind = ? AND vector_blob IS NOT NULL "
            "AND dim = ?"
        )
        params: list = [qblob, kind, len(qvec)]
        if exclude_id is not None:
            sql += " AND ref_id != ?"
            params.append(int(exclude_id))
        sql += " ORDER BY d ASC LIMIT ?"
        params.append(max(0, int(k)))
        con = None
        try:
            con = sqlite3.connect(str(config.DB_PATH))
            # B16: apply WAL + busy_timeout so this short-lived read connection
            # doesn't conflict with the main engine under write contention.
            con.execute("PRAGMA journal_mode=WAL")
            con.execute(f"PRAGMA busy_timeout={max(0, int(config.SQLITE_BUSY_TIMEOUT_MS))}")
            con.enable_load_extension(True)
            sqlite_vec.load(con)
            con.enable_load_extension(False)
            return [
                (int(rid), 1.0 - float(d))
                for rid, d in con.execute(sql, params).fetchall()
            ]
        except Exception:
            return None  # any sqlite-vec error -> caller falls back to cosine
        finally:
            if con is not None:
                con.close()


def vector_store(session: Session) -> VectorStore:
    """Process-wide accessor for the current ``VectorStore`` implementation.

    Selects the sqlite-vec-accelerated backend when configured + loadable
    (``config.VECTOR_BACKEND`` "auto"/"sqlite-vec"), else the pure-Python cosine
    store. Returning a fresh instance is fine: the cache is module-global, so two
    stores bound to two sessions still share the same in-process snapshot.
    """
    backend = (config.VECTOR_BACKEND or "auto").lower()
    if backend in ("auto", "sqlite-vec") and _sqlite_vec_available():
        return SqliteVecStore(session)
    return SQLiteVectorStore(session)


def _pack_vector(vec: list[float]) -> bytes:
    return struct.pack(f"{len(vec)}f", *[float(x) for x in vec])


def _unpack_vector(blob: bytes, dim: int = 0) -> list[float]:
    n = dim or (len(blob) // 4)
    if n <= 0:
        return []
    return list(struct.unpack(f"{n}f", blob))


def _row_vector(row: EmbeddingVector) -> list[float]:
    if row.vector_blob:
        return _unpack_vector(row.vector_blob, row.dim or 0)
    return list(row.vector_json or [])


# BA7 — session-scoped embed-model fallback decision. Once the primary
# EMBED_MODEL embed fails and EMBED_MODEL_FALLBACK succeeds, we stick with the
# fallback for the rest of the process instead of paying the (failing) primary
# call's latency on every subsequent embed. The flag is set under its own lock so
# the one-time warning is logged exactly once even under concurrent embedders.
_embed_fallback_active = False
_embed_fallback_lock = threading.Lock()


def _embed_once(text: str, model: Optional[str] = None) -> list[float]:
    """One embed call through the GPU concurrency guard.

    B18: throttle embedding calls through the same GPU concurrency guard used by
    generate/critique so embeddings don't saturate the GPU concurrently with
    other LLM calls. ``model=None`` uses ``config.EMBED_MODEL`` (llm.embed_sync's
    own default), so the primary path is byte-for-byte the historical call.
    """
    with sync_guard():
        return llm.embed_sync(text) if model is None else llm.embed_sync(text, model=model)


def _default_embedder(text: str) -> list[float]:
    """Embed ``text`` with the primary embed model, falling back ONCE per session
    to ``config.EMBED_MODEL_FALLBACK`` when the primary fails.

    BA7: when a fallback is configured and the primary EMBED_MODEL embed raises,
    try the fallback model exactly once; if it succeeds we latch that decision for
    the rest of the session (subsequent calls go straight to the fallback) and log
    a warning. With no fallback configured — or when the fallback also fails — the
    original exception-propagation contract is preserved unchanged, so callers'
    existing graceful no-op handling keeps the bank drillable.
    """
    global _embed_fallback_active
    fallback = (config.EMBED_MODEL_FALLBACK or "").strip()

    # Once latched this session, go straight to the fallback model.
    if fallback and _embed_fallback_active:
        return _embed_once(text, model=fallback)

    try:
        return _embed_once(text)
    except Exception as primary_exc:
        if not fallback:
            raise  # no fallback configured -> preserve original behaviour
        try:
            vec = _embed_once(text, model=fallback)
        except Exception:
            # Both models failed: re-raise the PRIMARY error so the caller's
            # existing try/except (graceful no-op) behaves exactly as before.
            raise primary_exc
        # Fallback worked — latch it for the session and warn once on the switch.
        with _embed_fallback_lock:
            if not _embed_fallback_active:
                _embed_fallback_active = True
                _log.warning(
                    "Primary embed model %r failed (%s); falling back to "
                    "EMBED_MODEL_FALLBACK %r for the rest of this session.",
                    config.EMBED_MODEL, primary_exc, fallback,
                )
        return vec


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


# B3 — embed-model-switch corruption guard.
# When the embed model (or local provider) changes at runtime via /settings, the
# previously-stored vectors can have a DIFFERENT dimension than vectors freshly
# embedded for a query. Cosine over mismatched-dimension vectors is meaningless
# (cosine() returns 0.0 on a length mismatch, which would still occupy a top-k
# slot, and the native sqlite-vec path can raise). So the compare/dedup/RAG paths
# EXCLUDE any stored vector that isn't dimension-comparable to the live query
# (and the native query constrains on `dim`). The startup backfill/purge
# (``backfill_question_embeddings``) still removes stale-version rows; this is the
# read-time safety net so a switch never silently corrupts similarity even before
# that backfill runs. (We deliberately do NOT filter on the stored model id here:
# the raw vector accessors must stay model-agnostic, and a real model change
# almost always changes the dimension, which the length check already catches.)
def _comparable(query: list[float], vec: list[float]) -> bool:
    """Whether ``vec`` (a stored vector) can be compared to ``query``: both must
    be non-empty and share a dimension. Never raises."""
    return bool(query) and bool(vec) and len(query) == len(vec)


def question_text(session: Session, q: Question) -> str:
    """Text we embed for a question: passage + stem + prompt + choices.

    LR questions usually have no ``passage_id``, so this remains the historical
    stem/prompt/choices shape. RC questions need the passage included or
    similarity/dedup misses the actual semantic object being tested.
    """
    passage_text = ""
    if q.passage_id is not None:
        passage = session.get(Passage, q.passage_id)
        if passage is not None:
            passage_text = passage.text or ""
    choices = session.exec(
        select(AnswerChoice).where(AnswerChoice.question_id == q.id)
    ).all()
    ch = " ".join(c.text for c in sorted(choices, key=lambda c: c.label))
    return f"{passage_text}\n{q.stem}\n{q.prompt}\n{ch}".strip()


def _upsert(session: Session, kind: str, ref_id: int,
            vector: list[float], model: str, *, commit: bool = True) -> EmbeddingVector:
    row = session.exec(
        select(EmbeddingVector)
        .where(EmbeddingVector.kind == kind)
        .where(EmbeddingVector.ref_id == ref_id)
    ).first()
    if row is None:
        row = EmbeddingVector(kind=kind, ref_id=ref_id)
    # B17: BLOB is the canonical store; clear vector_json so we don't carry the
    # redundant JSON column once the BLOB backfill (m010) has run.
    row.vector_blob = _pack_vector(list(vector))
    row.vector_json = None
    row.dim = len(vector)
    row.model = f"{model}@{config.EMBED_MODEL_VERSION}"
    session.add(row)
    if commit:
        session.commit()
    else:
        session.flush()
    session.refresh(row)
    if kind == QUESTION:
        reset_cache()  # P3: a changed question vector invalidates the cache
    return row


def embed_question(session: Session, q: Question, *,
                   embedder: Optional[Embedder] = None,
                   commit: bool = True) -> EmbeddingVector:
    embedder = embedder or _default_embedder
    vec = embedder(question_text(session, q))
    return _upsert(session, QUESTION, q.id, vec, config.EMBED_MODEL, commit=commit)


def backfill_question_embeddings(session: Session, *, limit: int = 200,
                                 embedder: Optional[Embedder] = None) -> dict:
    """Embed questions that don't have an embedding yet. Returns counts."""
    embedder = embedder or _default_embedder
    version_tag = f"@{config.EMBED_MODEL_VERSION}"
    # Purge vectors from an older embed-model version (Wave 3.5).
    stale = session.exec(
        select(EmbeddingVector).where(EmbeddingVector.kind == QUESTION)
    ).all()
    for row in stale:
        if row.model and version_tag not in row.model:
            session.delete(row)
    session.commit()
    reset_cache()
    have = {
        r.ref_id for r in session.exec(
            select(EmbeddingVector).where(EmbeddingVector.kind == QUESTION)
        ).all()
    }
    all_qs = session.exec(select(Question)).all()
    todo = [q for q in all_qs if q.id not in have and q.deleted_at is None]
    embedded = 0
    for q in todo[:max(0, limit)]:
        embed_question(session, q, embedder=embedder)
        embedded += 1
    return {
        "embedded": embedded,
        "remaining": max(0, len(todo) - embedded),
        "total_questions": len(all_qs),
    }


def _question_vectors(session: Session) -> dict[int, list[float]]:
    global _vec_cache, _vec_cache_model
    # BA7: drop a cache built under a now-stale embed model before reading it, so
    # we never mix vectors from two models in one snapshot.
    _invalidate_cache_if_model_changed()
    # B15: protect both the read check and the write with the RLock.
    with _vec_cache_lock:
        if _vec_cache is None:
            _vec_cache = {
                r.ref_id: _row_vector(r)
                for r in session.exec(
                    select(EmbeddingVector).where(EmbeddingVector.kind == QUESTION)
                ).all()
                if _row_vector(r)
            }
            # BA7: stamp the model this snapshot was built under so a later
            # EMBED_MODEL change invalidates it (see _invalidate_cache_if_model_changed).
            _vec_cache_model = config.EMBED_MODEL
        return _vec_cache


def similar_questions(session: Session, question_id: int, *, k: int = 5,
                      embedder: Optional[Embedder] = None) -> list[dict]:
    """Top-k semantically nearest questions (excluding the query). Embeds the
    query on the fly if it isn't stored yet."""
    vectors = _question_vectors(session)
    target = vectors.get(question_id)
    if target is None:
        q = session.get(Question, question_id)
        if q is None:
            return []
        row = embed_question(session, q, embedder=embedder)
        target = _row_vector(row)
        vectors[question_id] = target

    # B3: only compare stored vectors that share the query's dimension. A vector
    # left over from a different embed model would otherwise score a bogus 0.0
    # and still appear in the ranking.
    scored = [
        (ref_id, cosine(target, vec))
        for ref_id, vec in vectors.items()
        if ref_id != question_id and _comparable(target, vec)
    ]
    scored.sort(key=lambda t: -t[1])
    out: list[dict] = []
    for ref_id, score in scored[:max(1, k)]:
        q = session.get(Question, ref_id)
        if q is None:
            continue
        out.append({
            "question_id": ref_id,
            "score": round(score, 4),
            "q_type": q.q_type,
            "source": q.source.value if hasattr(q.source, "value") else str(q.source),
            "stem": (q.stem or "")[:200],
        })
    return out


def nearest_existing(session: Session, text: str, *,
                     embedder: Optional[Embedder] = None,
                     exclude_id: Optional[int] = None) -> Optional[dict]:
    """R7 2.9 — find the bank question most similar to ``text`` (a generation
    candidate, embedded on the fly), for the generation-time dedup gate.

    Returns ``{"question_id", "score"}`` for the single nearest stored question,
    or ``None`` when there is nothing to compare against OR embedding is
    unavailable (returns an empty/failed vector). Reuses the same brute-force
    cosine over the cached question vectors as :func:`similar_questions`, so the
    gate's dedup decision matches the post-hoc audit's clustering. Never raises:
    a flaky/absent embedder must degrade to "no duplicate", not crash a job.
    """
    embedder = embedder or _default_embedder
    # Check the bank FIRST: if there is nothing to compare against, skip embedding
    # the candidate entirely (no model/network call). This keeps the dedup gate
    # free on a freshly-seeded bank and lets it no-op without touching Ollama.
    vectors = _question_vectors(session)
    candidates = [(rid, v) for rid, v in vectors.items()
                  if not (exclude_id is not None and rid == exclude_id)]
    if not candidates:
        return None
    try:
        target = embedder(text)
    except Exception:
        return None
    if not target:
        return None
    best_id: Optional[int] = None
    best_score = -1.0
    for ref_id, vec in candidates:
        # B3: skip stored vectors whose dimension doesn't match this query (a
        # prior embed model) so the dedup gate never fires on a bogus 0.0 score.
        if not _comparable(target, vec):
            continue
        score = cosine(target, vec)
        if score > best_score:
            best_score = score
            best_id = ref_id
    if best_id is None:
        return None
    return {"question_id": best_id, "score": round(best_score, 4)}


# INT-3 — cross-domain chunk grounding.
# The host (CFA/Quant/Excel) ships its curriculum chunks; this function ranks
# them against an LSAT query so host material can be unioned into LSAT/Notebook
# retrieval — the mirror of the host-side union in localRag.ts. It is fully
# self-contained (no DB rows, no caches): the host owns the chunk text, we only
# embed + cosine-rank. Embeddings reuse the SAME injectable embedder as the rest
# of this module, so a model switch stays consistent across both planes, and the
# embedder is injectable so tests never touch the network. Never raises: a flaky
# or absent embedder degrades to an empty ranking (host-only retrieval upstream),
# matching the OPS-5 optional-sidecar contract.
def rank_host_chunks(
    query: str,
    chunks: list[dict],
    *,
    k: int = 5,
    min_score: float = 0.0,
    embedder: Optional[Embedder] = None,
) -> list[dict]:
    """Rank externally-supplied host curriculum ``chunks`` against ``query``.

    Each chunk is a mapping with at least ``text``; optional ``id``, ``locator``,
    ``domain``, ``level``, and ``topic`` are echoed back on the scored record so
    the caller can render citations. Returns up to ``k`` records sorted by
    descending cosine similarity, each ``{**chunk_metadata, "score": float}``,
    dropping any below ``min_score``.

    Returns ``[]`` (and embeds nothing) when there is no query or no chunk text,
    so the cross-domain union is free when the host sends nothing. The query is
    embedded once; each chunk is embedded on the fly. Any embedding failure
    degrades to an empty ranking rather than raising.
    """
    text_value = (query or "").strip()
    usable = [c for c in chunks if isinstance(c, dict) and (c.get("text") or "").strip()]
    if not text_value or not usable:
        return []
    embedder = embedder or _default_embedder
    try:
        target = embedder(text_value)
    except Exception:
        return []  # degrade to host-only retrieval upstream
    if not target:
        return []

    scored: list[tuple[float, dict]] = []
    for chunk in usable:
        try:
            vec = embedder(str(chunk.get("text") or ""))
        except Exception:
            continue
        # B3 parity: only score chunks whose embedding is dimension-comparable to
        # the query (a different embed model would make cosine meaningless).
        if not _comparable(target, vec):
            continue
        score = cosine(target, vec)
        if score <= min_score:
            continue
        record = {
            "id": chunk.get("id"),
            "documentId": chunk.get("documentId") or chunk.get("document_id"),
            "domain": chunk.get("domain"),
            "level": chunk.get("level"),
            "topic": chunk.get("topic"),
            "locator": chunk.get("locator") or "",
            "text": str(chunk.get("text") or ""),
            "score": round(float(score), 4),
        }
        scored.append((score, record))
    scored.sort(key=lambda t: -t[0])
    return [record for _score, record in scored[: max(1, k)]]


def _noted_question_notes(session: Session) -> dict[int, str]:
    """question_id -> the user's most recent error-log note for it."""
    entries = session.exec(
        select(ErrorLogEntry).order_by(ErrorLogEntry.id.desc())
    ).all()
    out: dict[int, str] = {}
    for e in entries:
        a = session.get(Attempt, e.attempt_id)
        if a is None:
            continue
        note = e.user_note or e.ai_diagnosis
        if note and a.question_id not in out:
            out[a.question_id] = note
    return out


def context_notes_for_question(session: Session, question_id: int, *,
                               k: int = 3,
                               embedder: Optional[Embedder] = None) -> list[str]:
    """The student's own past notes on the most *similar* questions they've
    logged errors on — RAG context for the explainer.

    Returns [] (and makes NO model call) when there is nothing to retrieve, so
    the realtime explain path never pays for embeddings it can't use.
    """
    noted = _noted_question_notes(session)
    noted.pop(question_id, None)
    if not noted:
        return []
    vectors = _question_vectors(session)
    candidates = [(qid, vectors[qid]) for qid in noted if qid in vectors]
    if not candidates:
        return []
    target = vectors.get(question_id)
    if target is None:
        q = session.get(Question, question_id)
        if q is None:
            return []
        target = _row_vector(embed_question(session, q, embedder=embedder))
    # B3: only score notes whose question vector shares the query's dimension; a
    # vector from a prior embed model is incomparable and must be excluded.
    scored = sorted(
        ((qid, cosine(target, vec)) for qid, vec in candidates
         if _comparable(target, vec)),
        key=lambda t: -t[1],
    )
    return [noted[qid] for qid, score in scored[:max(1, k)] if score > 0.0]


def _choice_trap_type(
    session: Session,
    question_id: int,
    label: str | None,
) -> str | None:
    if not label:
        return None
    choice = session.exec(
        select(AnswerChoice)
        .where(AnswerChoice.question_id == question_id)
        .where(AnswerChoice.label == label)
    ).first()
    if choice is None or choice.is_correct:
        return None
    trap = (choice.trap_type or "").strip()
    return trap if trap and trap != "none" else None


def _wrong_choice_trap_types(session: Session, question_id: int) -> set[str]:
    choices = session.exec(
        select(AnswerChoice).where(AnswerChoice.question_id == question_id)
    ).all()
    return {
        str(c.trap_type).strip()
        for c in choices
        if not c.is_correct
        and c.trap_type
        and str(c.trap_type).strip()
        and str(c.trap_type).strip() != "none"
    }


def _latest_attempt_note(session: Session, attempt_id: int) -> str:
    rationale = session.exec(
        select(AttemptRationale)
        .where(AttemptRationale.attempt_id == attempt_id)
        .order_by(AttemptRationale.id.desc())
    ).first()
    if rationale is not None and (rationale.rationale_text or "").strip():
        return str(rationale.rationale_text).strip()
    entry = session.exec(
        select(ErrorLogEntry)
        .where(ErrorLogEntry.attempt_id == attempt_id)
        .order_by(ErrorLogEntry.id.desc())
    ).first()
    if entry is None:
        return ""
    return (entry.user_note or entry.ai_diagnosis or "").strip()


def _short_note(text: str, *, limit: int = 180) -> str:
    compact = " ".join((text or "").split())
    if len(compact) <= limit:
        return compact
    return compact[: max(0, limit - 1)].rstrip() + "..."


def _cached_similarity_scores(
    session: Session,
    question_id: int,
    candidate_ids: set[int],
) -> dict[int, float]:
    """Similarity from already-stored vectors only; never embeds on this path."""
    if not candidate_ids:
        return {}
    try:
        vectors = _question_vectors(session)
        target = vectors.get(question_id)
        if not target:
            return {}
        out: dict[int, float] = {}
        for qid in candidate_ids:
            vec = vectors.get(qid)
            if vec and _comparable(target, vec):
                score = cosine(target, vec)
                if score > 0:
                    out[qid] = round(float(score), 4)
        return out
    except Exception:
        return {}


def trap_similar_misses_for_question(
    session: Session,
    question_id: int,
    *,
    chosen_answer: str | None = None,
    trap_type: str | None = None,
    limit: int = 3,
) -> list[dict]:
    """Recent misses that share the active trap pattern.

    This is the RAG-Socratic "you have fallen for this shape before" retrieval
    path. It intentionally uses existing attempts, trap labels, error notes, and
    cached vectors only; it never makes a realtime embedding/model call.
    """
    current = session.get(Question, question_id)
    if current is None:
        return []
    target_trap = (trap_type or "").strip() or _choice_trap_type(
        session,
        question_id,
        chosen_answer,
    )
    current_traps = _wrong_choice_trap_types(session, question_id)

    misses = session.exec(
        select(Attempt)
        .where(Attempt.is_correct == False)  # noqa: E712
        .where(Attempt.chosen_answer.is_not(None))
        .where(Attempt.question_id != question_id)
        .order_by(Attempt.id.desc())
        .limit(100)
    ).all()
    if not misses:
        return []

    qids = {int(a.question_id) for a in misses}
    qmap = {
        q.id: q
        for q in session.exec(select(Question).where(Question.id.in_(qids))).all()
    }
    choices = session.exec(
        select(AnswerChoice).where(AnswerChoice.question_id.in_(qids))
    ).all()
    choice_idx = {(c.question_id, c.label): c for c in choices}
    similarities = _cached_similarity_scores(session, question_id, qids)

    ranked: list[tuple[int, float, int, dict]] = []
    seen_questions: set[int] = set()
    for attempt in misses:
        if attempt.question_id in seen_questions:
            continue
        seen_questions.add(attempt.question_id)
        q = qmap.get(attempt.question_id)
        if q is None:
            continue
        choice = choice_idx.get((attempt.question_id, attempt.chosen_answer or ""))
        attempt_trap = (choice.trap_type or "").strip() if choice else ""
        if not attempt_trap or attempt_trap == "none":
            continue

        exact_trap = bool(target_trap and attempt_trap == target_trap)
        same_question_trap = not target_trap and attempt_trap in current_traps
        same_type_trap = not target_trap and not current_traps and q.q_type == current.q_type
        if not (exact_trap or same_question_trap or same_type_trap):
            continue

        similarity = similarities.get(attempt.question_id)
        match_rank = 3 if exact_trap else 2 if same_question_trap else 1
        note = _latest_attempt_note(session, int(attempt.id or 0))
        record = {
            "attempt_id": attempt.id,
            "question_id": attempt.question_id,
            "q_type": q.q_type,
            "trap_type": attempt_trap,
            "chosen_answer": attempt.chosen_answer,
            "matched_by": "trap_type" if exact_trap else (
                "question_trap" if same_question_trap else "q_type_trap"
            ),
            "similarity": similarity,
            "note_excerpt": _short_note(note),
            "created_at": attempt.created_at.isoformat(),
        }
        ranked.append((
            match_rank,
            float(similarity or 0.0),
            int(attempt.id or 0),
            record,
        ))

    ranked.sort(key=lambda row: (row[0], row[1], row[2]), reverse=True)
    return [record for *_rank, record in ranked[: max(1, limit)]]


def trap_miss_context_notes(misses: list[dict]) -> list[str]:
    """Human-readable prompt notes for trap-similar miss records."""
    notes: list[str] = []
    for miss in misses:
        note = miss.get("note_excerpt") or "no written note captured"
        sim = (
            f", semantic similarity {miss['similarity']}"
            if miss.get("similarity") is not None
            else ""
        )
        notes.append(
            "Past trap-similar miss: "
            f"Q{miss.get('question_id')} ({miss.get('q_type')}) "
            f"used trap {miss.get('trap_type')}; "
            f"student chose {miss.get('chosen_answer')}{sim}. "
            f"Prior note: {note}"
        )
    return notes


# Prefer real (official/sample) exemplars: their canonical explanations are the
# quality anchor whose style/structure we want the explainer to imitate.
_EXEMPLAR_SOURCES = (QuestionSource.official, QuestionSource.sample)


def exemplar_for_question(session: Session, question_id: int, *,
                          k: int = 5, min_score: float = 0.5,
                          embedder: Optional[Embedder] = None) -> Optional[dict]:
    """2.7 — a worked exemplar for the explainer: the most-similar REAL question
    that already has a canonical explanation, so its style/structure/rigor can
    transfer into a freshly-generated explanation.

    Returns ``{"question_id", "q_type", "score", "explanation"}`` for the nearest
    qualifying neighbour, or ``None`` when:
    - embeddings are absent / nothing is similar (``similar_questions`` is empty),
    - no similar question is an official/sample item with a stored explanation,
    - the best similarity is below ``min_score`` (too loose to be a useful model).

    Never returns the SAME question (``similar_questions`` already excludes it) and
    makes no model call beyond the similarity lookup, so the realtime path stays
    cheap. Never raises: a degraded embedder must no-op, not crash the explainer.
    """
    try:
        sims = similar_questions(session, question_id, k=max(1, k), embedder=embedder)
    except Exception:
        return None
    for s in sims:
        if s["question_id"] == question_id:
            continue  # defensive: never the same question
        if s.get("score", 0.0) < min_score:
            break  # sorted desc -> everything after is even less similar
        q = session.get(Question, s["question_id"])
        if q is None or q.source not in _EXEMPLAR_SOURCES:
            continue
        exp = session.exec(
            select(Explanation)
            .where(Explanation.question_id == s["question_id"])
            .order_by(Explanation.id.desc())
        ).first()
        if exp is None or not (exp.body or "").strip():
            continue
        return {
            "question_id": s["question_id"],
            "q_type": s.get("q_type"),
            "score": s.get("score"),
            "explanation": exp.body,
        }
    return None
