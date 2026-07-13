"""Wave-1 foundation tests (docs/22): H1 sqlite-vec, H2 FTS5, H8 OOM/keep-alive,
A9 per-task tag model. Faked HTTP throughout; no live model server needed."""
from __future__ import annotations

import sys
from datetime import datetime, timezone

import app.llm.ollama  # noqa: F401 — register the submodule (facade shadows it)
import httpx
import pytest

from app.models import Question, QuestionSource


# --- H8: OOM is non-retryable + surfaces as LLMOOMError ---------------------
def _http_error(status: int, text: str) -> httpx.HTTPStatusError:
    return httpx.HTTPStatusError(
        "err",
        request=httpx.Request("POST", "http://x"),
        response=httpx.Response(status, text=text),
    )


def test_is_transient_excludes_oom():
    from app.llm import base
    assert base.is_transient(_http_error(500, "ggml cudaMalloc: out of memory")) is False
    assert base.is_transient(_http_error(503, "service unavailable")) is True


def test_oom_not_retried_and_raises_llmoom(monkeypatch):
    from app import config
    from app.llm import base
    monkeypatch.setattr(config, "LLM_MAX_RETRIES", 5)  # would retry a lot if transient
    calls = {"n": 0}

    def fn():
        calls["n"] += 1
        raise _http_error(500, "CUDA error: out of memory")

    with pytest.raises(base.LLMOOMError):
        base.retry_sync(fn)
    assert calls["n"] == 1  # OOM stops immediately


def test_transient_5xx_still_retried(monkeypatch):
    from app import config
    from app.llm import base
    monkeypatch.setattr(config, "LLM_MAX_RETRIES", 2)
    monkeypatch.setattr(base.time, "sleep", lambda *_: None)
    calls = {"n": 0}

    def fn():
        calls["n"] += 1
        raise _http_error(500, "internal error")

    with pytest.raises(base.LLMError):
        base.retry_sync(fn)
    assert calls["n"] == 3  # 1 + 2 retries


def test_ollama_set_keep_alive_posts_field(monkeypatch):
    ol = sys.modules["app.llm.ollama"]  # the facade `ollama()` shadows the submodule
    captured: dict = {}

    class _Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {}

    class _Client:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None):
            captured["url"] = url
            captured["json"] = json
            return _Resp()

    monkeypatch.setattr(ol.httpx, "Client", _Client)
    prov = ol.OllamaProvider("http://localhost:11434")
    assert prov.set_keep_alive("phi4:14b", -1) is True
    assert captured["url"].endswith("/api/generate")
    assert captured["json"]["keep_alive"] == -1


def test_set_keep_alive_is_best_effort(monkeypatch):
    from app import config
    ol = sys.modules["app.llm.ollama"]
    monkeypatch.setattr(config, "LLM_MAX_RETRIES", 0)

    class _Client:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, *a, **k):
            raise ol.httpx.ConnectError("refused")

    monkeypatch.setattr(ol.httpx, "Client", _Client)
    assert ol.OllamaProvider().set_keep_alive("m", 0) is False  # never raises


# --- A9: tagging routes to TAG_MODEL when set, else EXPLAIN_MODEL ------------
def test_tagging_uses_tag_model_when_set(monkeypatch):
    from app import config, tagging

    captured: dict = {}

    class _Prov:
        name = "ollama"

        def generate(self, model, prompt, *, timeout=None):
            captured["model"] = model
            return "{}"

    monkeypatch.setattr(tagging.llm, "local_provider", lambda: _Prov())
    monkeypatch.setattr(config, "EXPLAIN_MODEL", "phi4:14b")

    monkeypatch.setattr(config, "TAG_MODEL", "qwen2.5:3b")
    tagging._model_call("p")
    assert captured["model"] == "qwen2.5:3b"

    monkeypatch.setattr(config, "TAG_MODEL", "")  # empty -> explain model
    tagging._model_call("p")
    assert captured["model"] == "phi4:14b"


def test_provider_info_reports_tag_model(monkeypatch):
    import app.llm as llm
    from app import ai, config
    monkeypatch.setattr(config, "LOCAL_PROVIDER", "lmstudio")  # skip the Ollama probe
    monkeypatch.setattr(config, "EXPLAIN_MODEL", "phi4:14b")
    monkeypatch.setattr(config, "TAG_MODEL", "")
    ai.reset_resolved_models()
    assert llm.provider_info()["tag_model"] == "phi4:14b"
    ai.reset_resolved_models()


# --- H2: FTS5 keyword search -------------------------------------------------
def _add_q(session, stem: str, *, source=QuestionSource.sample) -> Question:
    q = Question(stem=stem, prompt="Which one most weakens?", correct_answer="A",
                 q_type="Weaken", source=source)
    session.add(q)
    session.commit()
    session.refresh(q)
    return q


def test_fts_search_matches_keyword_and_phrase(db_session):
    from app import search
    q = _add_q(db_session, "The zorbloxian hypothesis entails a necessary condition")
    assert any(r["question_id"] == q.id
               for r in search.search_questions(db_session, "zorbloxian"))
    # multi-token => implicit AND
    assert any(r["question_id"] == q.id
               for r in search.search_questions(db_session, "necessary condition"))
    # no match + blank => []
    assert search.search_questions(db_session, "qwzxnomatchword") == []
    assert search.search_questions(db_session, "   ") == []
    # results never carry the correct answer
    for r in search.search_questions(db_session, "zorbloxian"):
        assert "correct_answer" not in r and "is_correct" not in r


def test_fts_search_excludes_soft_deleted(db_session):
    from app import search
    q = _add_q(db_session, "uniquetokenalpha bravo charlie")
    assert any(r["question_id"] == q.id
               for r in search.search_questions(db_session, "uniquetokenalpha"))
    q.deleted_at = datetime.now(timezone.utc)
    db_session.add(q)
    db_session.commit()
    assert search.search_questions(db_session, "uniquetokenalpha") == []


def test_fts_search_filters_by_source(db_session):
    from app import search
    qs = _add_q(db_session, "deltaecho foxtrot sample item", source=QuestionSource.sample)
    _add_q(db_session, "deltaecho foxtrot research item", source=QuestionSource.research)
    res = search.search_questions(db_session, "deltaecho", source="sample")
    assert [r["question_id"] for r in res] == [qs.id]


# --- H1: sqlite-vec backend matches cosine ranking, with fallback -----------
def test_sqlite_vec_ranking_matches_cosine(db_session, monkeypatch):
    from app import config, embeddings
    if not embeddings._sqlite_vec_available():
        pytest.skip("sqlite-vec not available in this build")

    vecs = {"a": [1.0, 0.0, 0.0], "b": [0.9, 0.1, 0.0],
            "c": [0.0, 1.0, 0.0], "d": [0.0, 0.0, 1.0]}
    ids: dict[str, int] = {}
    for key, v in vecs.items():
        q = _add_q(db_session, f"vec-{key}")
        ids[key] = q.id
        embeddings._upsert(db_session, embeddings.QUESTION, q.id, v, "test-model")
    db_session.commit()

    query = [1.0, 0.05, 0.0]  # nearest: a, then b, then c, then d

    monkeypatch.setattr(config, "VECTOR_BACKEND", "sqlite-vec")
    vec_store = embeddings.vector_store(db_session)
    assert isinstance(vec_store, embeddings.SqliteVecStore)
    vec_rank = [rid for rid, _ in vec_store.cosine_top_k(query, k=4)]

    monkeypatch.setattr(config, "VECTOR_BACKEND", "cosine")
    cos_store = embeddings.vector_store(db_session)
    assert not isinstance(cos_store, embeddings.SqliteVecStore)
    cos_rank = [rid for rid, _ in cos_store.cosine_top_k(query, k=4)]

    assert vec_rank == cos_rank          # identical top-k ranking
    assert vec_rank[0] == ids["a"]       # closest is 'a'
    # exclude_id is honored
    assert ids["a"] not in [
        rid for rid, _ in vec_store.cosine_top_k(query, k=4, exclude_id=ids["a"])
    ]


def test_vector_store_backend_selection(monkeypatch, db_session):
    from app import config, embeddings
    monkeypatch.setattr(config, "VECTOR_BACKEND", "cosine")
    assert type(embeddings.vector_store(db_session)) is embeddings.SQLiteVectorStore
