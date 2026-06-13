"""B3 — embed-model-switch must not silently corrupt dedup/RAG.

When the embed model (or local provider) changes at runtime, previously-stored
vectors have a different dimension/model than vectors freshly embedded for a
query. The similarity/dedup/RAG READ paths must EXCLUDE such stored vectors
(treat them as absent) rather than scoring them — and must never raise on a
dimension mismatch. These tests lock in that behaviour for the pure-Python
cosine store (forced via ``VECTOR_BACKEND="cosine"`` so the result is
deterministic regardless of whether sqlite-vec is installed).
"""
from __future__ import annotations

import pytest

from app import config, embeddings
from app.models import EmbeddingVector, Question, QuestionSource


# Deterministic embedders of a *fixed* dimension each (no network). The 3-dim one
# stands in for the "current" embed model; the 5-dim one for a vector left over
# from a different model after a runtime switch.
def _embed3(text: str) -> list[float]:
    t = (text or "").lower()
    return [float(t.count("cat")), float(t.count("dog")), float(t.count("math"))]


def _embed5(text: str) -> list[float]:
    t = (text or "").lower()
    return [float(t.count("cat")), 0.0, 0.0, 0.0, float(t.count("math"))]


@pytest.fixture(autouse=True)
def _force_pure_python_cosine(monkeypatch):
    # Pin the pure-Python store so the assertions don't depend on sqlite-vec
    # availability (the native path applies the same guard via SQL).
    monkeypatch.setattr(config, "VECTOR_BACKEND", "cosine")
    embeddings.reset_cache()
    yield
    embeddings.reset_cache()


def _mk_question(session, stem: str) -> Question:
    q = Question(stem=stem, prompt=stem, correct_answer="A", q_type="Inference",
                 source=QuestionSource.research)
    session.add(q)
    session.commit()
    session.refresh(q)
    return q


def _store_vector(session, q: Question, vector: list[float], model: str) -> None:
    """Insert a question vector directly with a chosen dim/model, mirroring the
    shape ``_upsert`` writes (model is the current ``EMBED_MODEL@VERSION`` tag)."""
    session.add(EmbeddingVector(
        kind=embeddings.QUESTION, ref_id=q.id, model=model,
        dim=len(vector), vector_json=list(vector),
    ))
    session.commit()
    embeddings.reset_cache()


def _current_tag() -> str:
    return f"{config.EMBED_MODEL}@{config.EMBED_MODEL_VERSION}"


# --- cosine_top_k: mismatched-dim stored vector is skipped, not scored --------
def test_cosine_top_k_skips_mismatched_dim_vector(db_session):
    same = _mk_question(db_session, "cat cat cat")     # 3-dim, current model
    other = _mk_question(db_session, "cat math")       # 5-dim, "stale" model
    _store_vector(db_session, same, _embed3(same.stem), _current_tag())
    _store_vector(db_session, other, _embed5(other.stem), _current_tag())

    store = embeddings.vector_store(db_session)
    query = _embed3("cat cat cat")  # 3-dim query (the new model)

    # Must not raise, and must not surface the 5-dim row at all.
    results = store.cosine_top_k(query, k=10)
    ref_ids = [rid for rid, _ in results]
    assert other.id not in ref_ids                       # mismatched dim excluded
    assert same.id in ref_ids                            # same-dim still compared
    assert dict(results)[same.id] == pytest.approx(1.0)  # identical vectors


# --- similar_questions: same skip on the cached read path ---------------------
def test_similar_questions_ignores_mismatched_dim(db_session):
    target = _mk_question(db_session, "cat cat cat")
    good = _mk_question(db_session, "cat cat")        # 3-dim neighbour
    stale = _mk_question(db_session, "cat math")      # 5-dim leftover

    _store_vector(db_session, target, _embed3(target.stem), _current_tag())
    _store_vector(db_session, good, _embed3(good.stem), _current_tag())
    _store_vector(db_session, stale, _embed5(stale.stem), _current_tag())

    sims = embeddings.similar_questions(db_session, target.id, k=50, embedder=_embed3)
    ids = [s["question_id"] for s in sims]
    assert good.id in ids
    assert stale.id not in ids        # 5-dim vector excluded, never a bogus match
    # The surviving same-dim neighbour scores normally (cat-vector cosine == 1.0).
    assert sims[0]["question_id"] == good.id
    assert sims[0]["score"] == pytest.approx(1.0, abs=1e-4)


# --- nearest_existing (dedup gate): mismatched dim never fires a duplicate ----
def test_nearest_existing_skips_mismatched_dim(db_session):
    only = _mk_question(db_session, "cat math")  # the sole bank item, 5-dim/stale
    _store_vector(db_session, only, _embed5(only.stem), _current_tag())

    # Query embedder is the NEW 3-dim model. The only stored vector is 5-dim and
    # therefore incomparable -> the gate must report "no duplicate" (None), not a
    # bogus 0.0-similarity hit, and must not raise.
    res = embeddings.nearest_existing(db_session, "cat math", embedder=_embed3)
    assert res is None


def test_nearest_existing_matches_same_dim(db_session):
    twin = _mk_question(db_session, "cat cat cat")
    _store_vector(db_session, twin, _embed3(twin.stem), _current_tag())

    res = embeddings.nearest_existing(db_session, "cat cat cat", embedder=_embed3)
    assert res is not None
    assert res["question_id"] == twin.id
    assert res["score"] == pytest.approx(1.0, abs=1e-4)


# --- dimension-only guard: a SAME-dim vector is kept regardless of model id ----
# The raw vector accessors stay model-agnostic (upsert-then-read must round-trip
# for any model name). A real embed-model switch almost always changes the
# dimension — which the length check catches — and the startup backfill purges
# stale-version rows, so dimension is the read-time guard, not the model tag.
def test_same_dim_vector_kept_regardless_of_model(db_session):
    current = _mk_question(db_session, "cat cat cat")
    other = _mk_question(db_session, "cat cat")  # same dim, different model id

    _store_vector(db_session, current, _embed3(current.stem), _current_tag())
    _store_vector(db_session, other, _embed3(other.stem), "some-other-model@1")

    vectors = embeddings._question_vectors(db_session)
    assert current.id in vectors
    assert other.id in vectors  # same dim => comparable => kept


def test_blank_model_vector_kept_when_dim_matches(db_session):
    # A legacy row with no recorded model is still usable: the dimension check is
    # the guard, so same-dim legacy vectors round-trip.
    target = _mk_question(db_session, "cat cat cat")
    legacy = _mk_question(db_session, "cat cat")
    _store_vector(db_session, target, _embed3(target.stem), _current_tag())
    _store_vector(db_session, legacy, _embed3(legacy.stem), "")  # blank model

    vectors = embeddings._question_vectors(db_session)
    assert legacy.id in vectors  # kept (dimension matches)
