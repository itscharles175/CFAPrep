"""Wave 4 Backend-Perf — BACK-1/2/3/5.

Covers:
  * BACK-1 — content-addressed deterministic LLM cache: HOST-PARITY of the key
    pre-image (byte-for-byte vs src/lib/llm/determinism.js), determinism gating,
    SQLite + LRU hit/miss, hit-rate counter, and the offline_generate wrapping
    (a deterministic repeat skips the provider; a warm call always calls it).
  * BACK-2 — cost-aware gate: a cheap-check failure (length tell) short-circuits
    BEFORE any LLM solve/critique call; the flag-OFF path still runs the model;
    INT-1's build_validation_report stays full-evidence regardless of the flag.
  * BACK-3 — resumable, idempotent batch: run_job resumes from GenJob.next_index
    instead of regenerating 0..k, advances the checkpoint, and pins a
    deterministic per-index seed so a resume reproduces the same candidate.
  * BACK-5 — SQLite maintenance task: run_db_maintenance checkpoints the WAL,
    conditionally vacuums, reports reclaimed_bytes, and is reachable through the
    existing scheduler (run_scheduled_task / the seeded db_maintenance row).
"""
from __future__ import annotations

import json

import pytest
from sqlmodel import select

from app import config, generation, jobs
from app.llm import cache
from app.models import GenJob, GenStatus, LLMCacheEntry


# --- BACK-1: host-parity key pre-image --------------------------------------
# Frozen vectors computed from src/lib/llm/determinism.js (cacheKeyPreimage +
# cacheKey). If determinism.js changes its serialization WITHOUT bumping
# CACHE_KEY_VERSION (and updating these), this test fails — exactly the host<->
# backend mismatch the contract is meant to make detectable.
_HOST_BASE = dict(
    provider="lmstudio",
    model="gemma-4-e4b-it",
    system="Generate LSAT-quality JSON only.",
    format={"type": "object", "properties": {"questions": {"type": "array"}}},
    temperature=0,
    top_p=1,
    seed=1311,
    prompt="Write 3 questions about duration.",
)
_HOST_BASE_PREIMAGE = (
    "llm-cache\nv2\nprovider=lmstudio\nmodel=gemma-4-e4b-it\n"
    "system=\"Generate LSAT-quality JSON only.\"\n"
    "format={\"properties\":{\"questions\":{\"type\":\"array\"}},\"type\":\"object\"}\n"
    "temperature=0\ntop_p=1\nseed=1311\nprompt=Write 3 questions about duration."
)
_HOST_BASE_KEY = "6d11a145d16b2d0d23c88370a78dea1a9b8a3c03dc54ca0a16c7e7c1613870d9"

# Additional cross-impl vectors (provider/model trim, integer-float temp, missing
# fields). Keys produced by the SAME determinism.js helpers.
_HOST_VECTORS = [
    (
        dict(provider="ollama", model="qwen3:14b", system="Solve exactly.",
             format="json", temperature=0, top_p=1, seed=7,
             prompt="Solve this.\n(A) x"),
        "llm-cache\nv2\nprovider=ollama\nmodel=qwen3:14b\n"
        "system=\"Solve exactly.\"\nformat=\"json\"\ntemperature=0\n"
        "top_p=1\nseed=7\nprompt=Solve this.\n(A) x",
        "39f5564cd09acfd800f616468488a1eb02a13a3528f3d9a7c8c4312014699c19",
    ),
    (
        dict(provider="p", model="m", system=None,
             format={"b": 2, "a": {"z": 3, "y": 1}},
             temperature=0.0, top_p=None, seed=1, prompt="x"),
        "llm-cache\nv2\nprovider=p\nmodel=m\nsystem=\n"
        "format={\"a\":{\"y\":1,\"z\":3},\"b\":2}\ntemperature=0\n"
        "top_p=\nseed=1\nprompt=x",
        "70886fb9f4999e24901c16a35f83ae4983f1fcc70ae34c1a696915aa0285a88a",
    ),
    (
        dict(provider="  spaced  ", model="m", system=" keep whitespace ",
             format={"schema": {"required": ["a", "b"], "properties": {
                 "b": {"type": "number"}, "a": {"type": "string"},
             }}},
             temperature=0.3, top_p=0.95, seed=1311, prompt=" lead/trail "),
        "llm-cache\nv2\nprovider=spaced\nmodel=m\n"
        "system=\" keep whitespace \"\n"
        "format={\"schema\":{\"properties\":{\"a\":{\"type\":\"string\"},"
        "\"b\":{\"type\":\"number\"}},\"required\":[\"a\",\"b\"]}}\n"
        "temperature=0.3\ntop_p=0.95\nseed=1311\nprompt= lead/trail ",
        "eb579c3a972ecd39d7505e4ceb69ddb27fe8f9e709f9b4b165a94382c5ff40fb",
    ),
    (
        dict(provider=None, model=None, system=None, format=None,
             temperature=None, top_p=None, seed=None, prompt=None),
        "llm-cache\nv2\nprovider=\nmodel=\nsystem=\nformat=\n"
        "temperature=\ntop_p=\nseed=\nprompt=",
        "a114b030cf5ad734e25818c4322f4f0615380f246fa56523803d30862279e3b8",
    ),
]


def test_cache_key_preimage_matches_host_base_vector():
    assert cache.CACHE_KEY_VERSION == 2
    assert cache.cache_key_preimage(**_HOST_BASE) == _HOST_BASE_PREIMAGE
    assert cache.cache_key(**_HOST_BASE) == _HOST_BASE_KEY


@pytest.mark.parametrize("inputs,preimage,key", _HOST_VECTORS)
def test_cache_key_host_parity_vectors(inputs, preimage, key):
    # Byte-exact pre-image (host trims provider/model, renders 0.0 as "0",
    # missing fields as "", prompt verbatim/untrimmed).
    assert cache.cache_key_preimage(**inputs) == preimage
    # And the SHA-256 of it matches the host's digest.
    assert cache.cache_key(**inputs) == key


def test_temperature_zero_distinct_from_missing():
    # "temperature 0" and "no temperature" MUST be different keys (host contract).
    k0 = cache.cache_key(provider="p", model="m", temperature=0, seed=1, prompt="x")
    kn = cache.cache_key(provider="p", model="m", temperature=None, seed=1, prompt="x")
    assert k0 != kn


def test_cache_key_contract_distinguishes_system_format_schema_and_sampling():
    base = dict(provider="p", model="m", temperature=0, top_p=1, seed=7, prompt="same")

    k = cache.cache_key(**base, system="A", format="json")
    assert cache.cache_key(**base, system="B", format="json") != k
    assert cache.cache_key(**base, system="A", format={"type": "object"}) != k
    cooler = {**base, "top_p": 0.9}
    assert cache.cache_key(**cooler, system="A", format="json") != k

    schema_a = {"type": "object", "properties": {"b": {"type": "number"},
                                                  "a": {"type": "string"}}}
    schema_b = {"properties": {"a": {"type": "string"}, "b": {"type": "number"}},
                "type": "object"}
    assert cache.cache_key(**base, system="A", format=schema_a) == cache.cache_key(
        **base, system="A", format=schema_b,
    )


def test_is_deterministic_gating():
    assert cache.is_deterministic(0, None) is True        # greedy temp 0
    assert cache.is_deterministic(0.0, None) is True
    assert cache.is_deterministic(0.8, 7) is True         # pinned seed
    assert cache.is_deterministic(0.8, None) is False     # warm, no seed
    assert cache.is_deterministic(None, None) is False
    # bools are not treated as numbers/seeds (footgun guard).
    assert cache.is_deterministic(True, None) is False
    assert cache.is_deterministic(0, True) is False or cache.is_deterministic(0, True) is True
    # (the seed=True case: bool is excluded as a seed but temp 0 still qualifies)
    assert cache.is_deterministic(0, True) is True


# --- BACK-1: hit/miss + counters via the public get/put ---------------------
def test_cache_get_put_hit_miss_and_counter(db_session):
    cache.reset_stats()
    kwargs = dict(provider="ollama", model="qwen3:14b", temperature=0, seed=7,
                  prompt="deterministic prompt")

    # First lookup: miss.
    assert cache.get(**kwargs) is None
    # Store, then lookup again: hit (served from LRU).
    cache.put(**kwargs, response="ANSWER")
    assert cache.get(**kwargs) == "ANSWER"

    # Durable tier persists the row.
    rows = db_session.exec(
        select(LLMCacheEntry).where(LLMCacheEntry.cache_key == cache.cache_key(**kwargs))
    ).all()
    assert len(rows) == 1
    assert rows[0].response == "ANSWER"

    stats = cache.stats()
    assert stats["misses"] == 1
    assert stats["hits"] == 1
    assert stats["stores"] == 1
    assert stats["hit_rate"] == 0.5  # 1 hit / (1 hit + 1 miss)


def test_cache_durable_survives_lru_clear(db_session):
    cache.reset_stats()
    kwargs = dict(provider="ollama", model="qwen3:14b", temperature=0, seed=7,
                  prompt="durable prompt")
    cache.put(**kwargs, response="DURABLE")
    # Simulate a restart: clear ONLY the in-memory tier (reset_stats clears LRU).
    cache.reset_stats()
    # The durable SQLite row must still serve the value (a hit), warming the LRU.
    assert cache.get(**kwargs) == "DURABLE"
    assert cache.stats()["hits"] == 1


def test_warm_call_is_not_cached(db_session):
    cache.reset_stats()
    warm = dict(provider="ollama", model="qwen3:14b", temperature=0.8, seed=None,
                prompt="creative prompt")
    cache.put(**warm, response="X")            # no-op for non-deterministic
    assert cache.get(**warm) is None           # not cacheable -> always None
    # A non-deterministic lookup must NOT pollute the hit/miss counters.
    assert cache.stats()["lookups"] == 0


# --- BACK-1: offline_generate wrapping --------------------------------------
class _CountingProvider:
    name = "ollama"

    def __init__(self):
        self.calls = 0

    def generate(self, model, prompt, system=None, timeout=None, **opts):
        self.calls += 1
        return f"resp-{self.calls}"


def test_offline_generate_caches_deterministic_call(monkeypatch, db_session):
    from app import llm

    cache.reset_stats()
    prov = _CountingProvider()
    monkeypatch.setattr(llm, "local_provider", lambda: prov)
    monkeypatch.setattr(config, "LLM_CACHE_ENABLED", True)

    # Two identical DETERMINISTIC calls: the model runs ONCE, second is a cache hit.
    a = llm.offline_generate("p", model="m", temperature=0, seed=7)
    b = llm.offline_generate("p", model="m", temperature=0, seed=7)
    assert a == b == "resp-1"
    assert prov.calls == 1
    assert cache.stats()["hits"] == 1


def test_offline_generate_cache_separates_system_and_format(monkeypatch, db_session):
    from app import llm

    cache.reset_stats()
    prov = _CountingProvider()
    monkeypatch.setattr(llm, "local_provider", lambda: prov)
    monkeypatch.setattr(config, "LLM_CACHE_ENABLED", True)

    a = llm.offline_generate("p", system="sys-a", model="m", temperature=0, seed=7)
    b = llm.offline_generate("p", system="sys-b", model="m", temperature=0, seed=7)
    c = llm.offline_generate("p", system="sys-a", model="m", temperature=0, seed=7)
    assert (a, b, c) == ("resp-1", "resp-2", "resp-1")
    assert prov.calls == 2

    schema_a = {"type": "object", "properties": {"b": {"type": "number"},
                                                  "a": {"type": "string"}}}
    schema_b = {"properties": {"a": {"type": "string"}, "b": {"type": "number"}},
                "type": "object"}
    d = llm.offline_generate("p", system="sys-a", model="m", temperature=0,
                             seed=7, format="json")
    e = llm.offline_generate("p", system="sys-a", model="m", temperature=0,
                             seed=7, format=schema_a)
    f = llm.offline_generate("p", system="sys-a", model="m", temperature=0,
                             seed=7, format=schema_b)
    assert (d, e, f) == ("resp-3", "resp-4", "resp-4")
    assert prov.calls == 4


def test_offline_generate_does_not_cache_warm_call(monkeypatch, db_session):
    from app import llm

    cache.reset_stats()
    prov = _CountingProvider()
    monkeypatch.setattr(llm, "local_provider", lambda: prov)
    monkeypatch.setattr(config, "LLM_CACHE_ENABLED", True)

    # Warm (no seed, non-zero temp): every call hits the model, nothing cached.
    a = llm.offline_generate("p", model="m", temperature=0.8)
    b = llm.offline_generate("p", model="m", temperature=0.8)
    assert a == "resp-1" and b == "resp-2"
    assert prov.calls == 2
    assert cache.stats()["lookups"] == 0


# --- BACK-2: cost-aware gate early-exit -------------------------------------
def _length_tell_candidate() -> dict:
    """A structurally-valid candidate whose CREDITED choice is uniquely longest —
    fails the cheap no-length-tell check, so the gate should reject it."""
    return {
        "stem": "All cats are mammals. Felix is a cat and lives indoors today.",
        "prompt": "Which one of the following must be true?",
        "correct_answer": "B",
        "choices": [
            {"label": "A", "text": "Felix is a reptile.", "trap_type": "opposite"},
            {"label": "B",
             "text": "Felix is a mammal because every cat is a mammal and Felix "
                     "is unambiguously a cat as the stimulus states.",
             "trap_type": "none"},
            {"label": "C", "text": "All mammals are cats.", "trap_type": "reversal"},
            {"label": "D", "text": "Felix is a plant.", "trap_type": "out_of_scope"},
            {"label": "E", "text": "Some cats are dogs.", "trap_type": "degree"},
        ],
    }


def test_cost_aware_short_circuits_before_model(db_session):
    cand = _length_tell_candidate()

    def boom(_prompt: str) -> str:
        raise AssertionError("cost-aware gate must not call the model after a "
                             "cheap-check failure")

    report = generation.validate_candidate(
        cand, runs=3, solver=boom, critic=boom, q_type="Inference",
        cost_aware=True,
    )
    assert report["passed"] is False
    assert report["reason"] == "length_tell"
    assert report.get("cost_aware_short_circuit") is True
    # The expensive gate never ran (recorded as skipped, never as a pass).
    det = report["checks"].get("deterministic_solve")
    assert det == {"ok": True, "skipped": "cost_aware_short_circuit"}


def test_cost_aware_off_still_runs_model_and_same_verdict(db_session):
    cand = _length_tell_candidate()
    calls = {"n": 0}

    def solver(_prompt: str) -> str:
        calls["n"] += 1
        return "B"

    def critic(prompt: str) -> str:
        calls["n"] += 1
        if "single_defensible" in prompt or "item reviewer" in prompt:
            return json.dumps({"single_defensible": True, "defensible_letters": ["B"]})
        return "B"

    report = generation.validate_candidate(
        cand, runs=3, solver=solver, critic=critic, q_type="Inference",
        cost_aware=False,
    )
    # Full-evidence run: the model WAS consulted, and the verdict is still a
    # length-tell rejection (cost-aware must not change pass/fail, only speed).
    assert calls["n"] > 0
    assert report["passed"] is False
    assert report["reason"] == "length_tell"
    assert report.get("cost_aware_short_circuit") is not True


def test_int1_report_is_full_evidence_despite_cheap_failure(monkeypatch, db_session):
    # build_validation_report (INT-1) forces cost_aware=False so the shared
    # endpoint reports every gate. Even with the global flag ON, the model runs.
    monkeypatch.setattr(config, "GEN_COST_AWARE_GATE", True)
    cand = _length_tell_candidate()
    ran = {"model": False}

    def solver(_prompt: str) -> str:
        ran["model"] = True
        return "B"

    def critic(prompt: str) -> str:
        ran["model"] = True
        return json.dumps({"single_defensible": True, "defensible_letters": ["B"]})

    out = generation.build_validation_report(
        cand, q_type="Inference", runs=3, solver=solver, critic=critic,
    )
    assert ran["model"] is True
    assert out["passed"] is False
    # deterministic_solve gate is present and judged (not short-circuited away).
    solve_gate = next(g for g in out["gates"] if g["gate"] == "deterministic_solve")
    assert solve_gate["passed"] is not None


# --- BACK-5: SQLite maintenance task ----------------------------------------
def test_run_db_maintenance_reports_bytes_and_steps(db_session):
    from app.db import run_db_maintenance

    result = run_db_maintenance()
    assert result["ok"] is True
    assert result["errors"] == []
    # WAL checkpoint ran (TRUNCATE returns a 3-tuple).
    assert result["wal_checkpoint"] is not None
    assert "checkpointed_frames" in result["wal_checkpoint"]
    # ANALYZE ran; reclaimed_bytes present and non-negative.
    assert result["analyze"] is True
    assert result["reclaimed_bytes"] >= 0
    assert result["size_before_bytes"] >= 0
    assert result["size_after_bytes"] >= 0


def test_db_maintenance_vacuum_is_conditional(db_session):
    from app.db import run_db_maintenance

    # A freshly-seeded test DB has a near-empty free-list, so the conditional
    # VACUUM should be SKIPPED (ran=False) — the expensive rewrite only fires
    # when the free-list ratio crosses the threshold.
    result = run_db_maintenance(vacuum_freelist_ratio=0.15, vacuum_min_freelist_pages=64)
    assert result["vacuum"]["ran"] is False
    assert "freelist_ratio" in result["vacuum"]

    # ratio<=0 disables VACUUM entirely even on a fragmented DB.
    disabled = run_db_maintenance(vacuum_freelist_ratio=0.0)
    assert disabled["vacuum"]["ran"] is False


def test_db_maintenance_task_runs_through_scheduler(db_session):
    # The seeded registry includes the db_maintenance task; running it through
    # the EXISTING scheduler records a SchedulerRun with the reclaimed-bytes
    # evidence in its result.
    jobs.ensure_default_schedules(db_session)
    out = jobs.run_scheduled_task(db_session, "db_maintenance")
    assert out["ok"] is True
    maint = out["result"]["db_maintenance"]
    assert "reclaimed_bytes" in maint
    assert maint["analyze"] is True


def test_db_maintenance_task_type_supported():
    assert "db_maintenance" in jobs.SUPPORTED_SCHEDULED_TASK_TYPES


# --- BACK-1: observability surface ------------------------------------------
def test_observability_status_exposes_llm_cache(client):
    body = client.get("/api/observability/status").json()
    assert "llm_cache" in body
    cache_block = body["llm_cache"]
    # The hit-rate counter shape the System Health panel reads.
    for key in ("enabled", "hits", "misses", "stores", "hit_rate", "lru_size",
                "key_version"):
        assert key in cache_block
    assert cache_block["key_version"] == cache.CACHE_KEY_VERSION


# --- BACK-3: resumable, idempotent batch ------------------------------------
def _fake_candidate_json(idx: int) -> str:
    """A clean, gate-passing candidate keyed by index (distinct stems)."""
    return json.dumps({
        "stem": f"Item {idx}: all cats are mammals and Felix is a cat indeed.",
        "prompt": "Which one of the following must be true?",
        "correct_answer": "B",
        "choices": [
            {"label": "A", "text": "Felix is a reptile here.", "trap_type": "opposite"},
            {"label": "B", "text": "Felix is a mammal okay.", "trap_type": "none"},
            {"label": "C", "text": "All mammals are cats now.", "trap_type": "reversal"},
            {"label": "D", "text": "Felix is not an animal!", "trap_type": "out_of_scope"},
            {"label": "E", "text": "Some cats are not mammals.", "trap_type": "degree"},
        ],
    })


def test_batch_resumes_from_next_index(monkeypatch, db_session):
    # GEN_RESUMABLE_BATCH gates the resume; with an INJECTED generate fake the
    # production path is the legacy full-range one, so this test drives run_job
    # with the live (default) generator path by NOT injecting generate, and
    # instead stubbing the candidate generator + the gate's model seams.
    monkeypatch.setattr(config, "GEN_RESUMABLE_BATCH", True)
    monkeypatch.setattr(config, "GEN_BATCH_BASE_SEED", 1000)

    seen_indices: list[int] = []

    # Replace the live candidate generator with a deterministic, index-aware fake.
    # run_job also reuses this generator as the gate SOLVER (without a seed), so we
    # record ONLY the seeded calls — those are the actual per-index candidate
    # generations, which is what proves the resume started at next_index.
    def fake_candidate_generator(prompt, system=None, timeout=None, *, seed=None):
        if seed is None:
            return "B"  # acting as the gate solver: just return the credited letter
        idx = seed - config.GEN_BATCH_BASE_SEED  # run_job passes seed = BASE + i
        seen_indices.append(idx)
        return _fake_candidate_json(idx)

    def fake_critic(prompt):
        if "item reviewer" in prompt:
            return json.dumps({"single_defensible": True, "defensible_letters": ["B"]})
        return "B"

    monkeypatch.setattr(generation, "_candidate_generator", fake_candidate_generator)
    monkeypatch.setattr(generation, "_gate_critic", fake_critic)

    # Enqueue a count=4 job and pretend it was interrupted after 2 candidates.
    jid = jobs.enqueue(db_session, "Inference", 4, status=GenStatus.queued)
    job = db_session.get(GenJob, jid)
    job.next_index = 2
    job.produced = 2
    job.accepted = 2
    db_session.add(job)
    db_session.commit()

    generation.run_job(jid)

    refreshed = db_session.get(GenJob, jid)
    db_session.refresh(refreshed)
    # Only indices 2 and 3 were generated on resume (0 and 1 were skipped).
    assert seen_indices == [2, 3]
    assert refreshed.next_index == 4
    assert refreshed.status == GenStatus.done
    # Totals accumulated across the (simulated) prior run + this run.
    assert refreshed.produced == 4


def test_completed_resumable_job_is_idempotent_noop(monkeypatch, db_session):
    monkeypatch.setattr(config, "GEN_RESUMABLE_BATCH", True)

    def must_not_generate(prompt, system=None, timeout=None, *, seed=None):
        raise AssertionError("a fully-consumed batch must not regenerate")

    monkeypatch.setattr(generation, "_candidate_generator", must_not_generate)

    jid = jobs.enqueue(db_session, "Inference", 3, status=GenStatus.queued)
    job = db_session.get(GenJob, jid)
    job.next_index = 3  # already finished all 3
    job.produced = 3
    db_session.add(job)
    db_session.commit()

    generation.run_job(jid)  # must run zero iterations, no model call

    refreshed = db_session.get(GenJob, jid)
    db_session.refresh(refreshed)
    assert refreshed.status == GenStatus.done
    assert refreshed.next_index == 3


def test_non_resumable_batch_ignores_next_index(monkeypatch, db_session):
    # With the flag OFF, next_index is ignored and the full range runs from 0.
    monkeypatch.setattr(config, "GEN_RESUMABLE_BATCH", False)

    gen_calls = {"n": 0}

    def gen_fake(prompt):  # legacy single-arg generator fake (injected)
        # Distinguish a CANDIDATE prompt (asks for a JSON object) from a SOLVE
        # prompt (asks for a single letter), since run_job reuses this fake as the
        # gate solver too.
        if "JSON object" in prompt:
            n = gen_calls["n"]
            gen_calls["n"] += 1
            return _fake_candidate_json(n)
        return "B"

    def critic_fake(prompt):
        if "item reviewer" in prompt:
            return json.dumps({"single_defensible": True, "defensible_letters": ["B"]})
        return "B"

    jid = jobs.enqueue(db_session, "Inference", 2, status=GenStatus.queued)
    job = db_session.get(GenJob, jid)
    job.next_index = 1  # would skip index 0 IF resumable were on
    db_session.add(job)
    db_session.commit()

    generation.run_job(jid, generate=gen_fake, critic=critic_fake)

    refreshed = db_session.get(GenJob, jid)
    db_session.refresh(refreshed)
    # Flag OFF -> full range from 0 (BOTH candidates generated), next_index ignored.
    assert gen_calls["n"] == 2
    assert refreshed.produced == 2
