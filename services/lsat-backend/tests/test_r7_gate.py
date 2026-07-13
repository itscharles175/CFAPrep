"""R7 Wave 3a — "make validation real": the generation gate (Flagship B).

Covers, with INJECTED FAKES only (never touches Ollama):
  2.1 deterministic + structured-output params actually sent to the provider,
  2.3 decorrelated deterministic-solve mismatch rejection + adversarial
      two-answer rejection,
  2.2 each type-aware structural validator (pass + fail via injected critic),
  2.9 embedding dedup rejection at generation time,
  2.8 empirical-difficulty calibration mapping.
"""
from __future__ import annotations

import json

import pytest
from sqlmodel import Session, select

import sys

from app import audit, config, gen_validators, generation
from app.db import engine
from app.llm import cloud
from app.llm.ollama import OllamaProvider

# app.llm.__init__ binds a function named `ollama`, which shadows the submodule
# on attribute access; grab the real provider module from sys.modules so we can
# patch its httpx.Client.
ollama_mod = sys.modules[OllamaProvider.__module__]
from app.models import (
    AnswerChoice, Attempt, AttemptMode, GenJob, GenStatus, Question,
    QuestionSource, StudySession, SessionType,
)


# A sound LR candidate with balanced choice lengths (so no length-tell) and a
# long-enough stimulus (so structural passes).
def _cand(correct="B"):
    return {
        "stem": ("Every accredited lab follows the protocol. The Lyon facility is "
                 "an accredited lab, so it follows the protocol as well."),
        "prompt": "Which one of the following must be true?",
        "difficulty": 3,
        "correct_answer": correct,
        "choices": [
            {"label": "A", "text": "The Lyon facility is not accredited at all here.", "trap_type": "opposite"},
            {"label": "B", "text": "The Lyon facility follows the protocol it seems.", "trap_type": "none"},
            {"label": "C", "text": "All facilities following protocol are accredited.", "trap_type": "reversal"},
            {"label": "D", "text": "Some accredited labs ignore the set protocol.", "trap_type": "degree"},
            {"label": "E", "text": "No unaccredited facility follows any protocol.", "trap_type": "out_of_scope"},
        ],
    }


def _solver_const(letter):
    return lambda _p: f"The answer is {letter}."


def _critic_single(letter):
    """A critic that solves -> letter and critiques -> single defensible letter."""
    def fn(prompt: str) -> str:
        if "strict LSAT item reviewer" in prompt:
            return json.dumps({"single_defensible": True, "defensible_letters": [letter]})
        if "Solve this LSAT" in prompt:
            return letter
        return letter
    return fn


# --- 2.1 deterministic + structured-output params ---------------------------
class _RecordingResp:
    def raise_for_status(self):  # noqa: D401
        return None

    def json(self):
        return {"response": "{}"}


def test_ollama_generate_sends_options_and_format(monkeypatch):
    captured = {}

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None):
            captured["payload"] = json
            return _RecordingResp()

    monkeypatch.setattr(ollama_mod.httpx, "Client", _FakeClient)
    prov = OllamaProvider()
    prov.generate("qwen3:14b", "solve it", temperature=0, top_p=0.9,
                  seed=7, format="json")

    payload = captured["payload"]
    assert payload["options"] == {"temperature": 0, "top_p": 0.9, "seed": 7}
    assert payload["format"] == "json"
    assert payload["stream"] is False


def test_ollama_generate_omits_options_when_not_requested(monkeypatch):
    captured = {}

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, json=None):
            captured["payload"] = json
            return _RecordingResp()

    monkeypatch.setattr(ollama_mod.httpx, "Client", _FakeClient)
    OllamaProvider().generate("qwen3:14b", "plain")
    assert "options" not in captured["payload"]
    assert "format" not in captured["payload"]


def test_cloud_generate_forces_json_tool_use(monkeypatch):
    # AI-10: opt out of the strict-offline fence so the provider can construct.
    monkeypatch.setattr(config, "ENFORCE_OFFLINE", False)
    monkeypatch.setattr(config, "CLOUD_EGRESS_ALLOWED", True)
    captured = {}

    class _Resp:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "content": [{"type": "tool_use", "name": "respond_json",
                             "input": {"json": "{\"correct_answer\": \"B\"}"}}],
                "usage": {"input_tokens": 5, "output_tokens": 9},
            }

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, headers=None, json=None):
            captured["json"] = json
            return _Resp()

    monkeypatch.setattr(cloud.httpx, "Client", _FakeClient)
    prov = cloud.AnthropicProvider("sk-test", model="claude-opus-4-7")
    out = prov.generate(None, "make a question", temperature=0, top_p=0.9,
                        seed=7, format="json")

    body = captured["json"]
    assert body["temperature"] == 0  # deterministic forwarded
    assert body["top_p"] == 0.9
    assert "seed" not in body  # Anthropic has no seed knob.
    assert body["tool_choice"] == {"type": "tool", "name": "respond_json"}
    assert body["tools"][0]["name"] == "respond_json"
    # output extracted from the forced tool_use block
    assert out == "{\"correct_answer\": \"B\"}"


def test_offline_generate_threads_params_to_ollama(monkeypatch):
    import app.llm as llm

    captured = {}

    def fake_generate(model, prompt, system, timeout, *, temperature=None,
                      top_p=None, seed=None, format=None):
        captured.update(temperature=temperature, top_p=top_p, seed=seed,
                        format=format, model=model)
        return "ok"

    monkeypatch.setattr(config, "GEN_PROVIDER", "ollama")
    monkeypatch.setattr(llm.ollama(), "generate", fake_generate)
    out = llm.offline_generate("p", temperature=0, top_p=0.9, seed=7,
                               format="json")
    assert out == "ok"
    assert captured == {"temperature": 0, "top_p": 0.9, "seed": 7,
                        "format": "json", "model": config.GEN_MODEL}


def test_critic_generate_routes_to_critic_model(monkeypatch):
    import app.llm as llm

    captured = {}

    def fake_generate(model, prompt, system, timeout, *, temperature=None,
                      top_p=None, seed=None, format=None):
        captured["model"] = model
        captured["temperature"] = temperature
        captured["top_p"] = top_p
        captured["seed"] = seed
        return "B"

    monkeypatch.setattr(config, "GEN_PROVIDER", "ollama")
    monkeypatch.setattr(config, "GEN_CRITIC_MODEL", "qwen3:critic")
    monkeypatch.setattr(llm.ollama(), "generate", fake_generate)
    llm.critic_generate("solve", temperature=0, seed=7)
    # routed to the distinct critic model, deterministic params forwarded
    assert captured["model"] == "qwen3:critic"
    assert captured["temperature"] == 0 and captured["seed"] == 7


def test_critic_model_is_decorrelated_from_generator(monkeypatch):
    import app.llm as llm

    monkeypatch.setattr(config, "GEN_PROVIDER", "ollama")
    monkeypatch.setattr(config, "GEN_MODEL", "qwen3:14b")
    monkeypatch.setattr(config, "GEN_CRITIC_MODEL", "qwen3:critic")
    assert llm.critic_model_name() != config.GEN_MODEL


# --- 2.3 decorrelated deterministic solve + adversarial attack --------------
def test_gate_accepts_with_decorrelated_critic():
    report = generation.validate_candidate(
        _cand("B"), runs=3, solver=_solver_const("B"), critic=_critic_single("B"),
    )
    assert report["passed"] is True
    assert report["checks"]["deterministic_solve"]["ok"] is True
    assert report["checks"]["cove_verify"]["ok"] is True


def test_gate_rejects_solve_mismatch():
    # Critic (the authoritative deterministic solver) disagrees with credited B.
    def critic(prompt):
        if "strict LSAT item reviewer" in prompt:
            return json.dumps({"single_defensible": True, "defensible_letters": ["B"]})
        if "Solve this LSAT" in prompt:
            return "D"  # solved a DIFFERENT letter than credited
        return "D"

    report = generation.validate_candidate(
        _cand("B"), runs=3, solver=_solver_const("B"), critic=critic,
    )
    assert report["passed"] is False
    assert report["reason"] == "solve_mismatch"
    assert report["checks"]["deterministic_solve"]["solved"] == "D"


def test_gate_rejects_cove_disagreement():
    # Critic agrees with credited B, but the decorrelated solver's blind CoVe
    # verification picks C -> reject.
    def critic(prompt):
        if "strict LSAT item reviewer" in prompt:
            return json.dumps({"single_defensible": True, "defensible_letters": ["B"]})
        if "Solve this LSAT" in prompt:
            return "B"
        return "B"

    solve_n = 0

    def solver(prompt: str) -> str:
        nonlocal solve_n
        if "Solve this LSAT" in prompt and "[removed]" not in prompt:
            solve_n += 1
            # Self-consistency runs (3) return B; the final CoVe solve returns C.
            return "C" if solve_n > 3 else "B"
        return "B"

    report = generation.validate_candidate(
        _cand("B"), runs=3, solver=solver, critic=critic,
    )
    assert report["passed"] is False
    assert report["reason"] == "cove_disagreement"
    assert report["checks"]["cove_verify"]["solver_pick"] == "C"


def test_cove_verify_passes_when_solver_agrees():
    report = generation.validate_candidate(
        _cand("B"), runs=3,
        solver=_solver_const("B"), critic=_critic_single("B"),
    )
    assert report["checks"]["cove_verify"]["ok"] is True
    assert report["passed"] is True


# --- 2.2 type-aware structural validators -----------------------------------
def _na_cand():
    c = _cand("B")
    c["prompt"] = "The argument depends on which one of the following assumptions?"
    return c


def test_necessary_assumption_validator_pass():
    critic = lambda _p: json.dumps({"negation_breaks_argument": True,
                                    "argument_depends_on_it": True})
    v = gen_validators.validate_structure("NecessaryAssumption", _na_cand(), critic)
    assert v["ok"] is True


def test_necessary_assumption_validator_fail():
    # Negating the credited choice does NOT break the argument -> not necessary.
    critic = lambda _p: json.dumps({"negation_breaks_argument": False,
                                    "argument_depends_on_it": False})
    v = gen_validators.validate_structure("NecessaryAssumption", _na_cand(), critic)
    assert v["ok"] is False
    assert v["reason"] == "assumption_not_required"


def test_sufficient_assumption_validator_pass_and_fail():
    ok = gen_validators.validate_structure(
        "SufficientAssumption", _cand("B"),
        lambda _p: json.dumps({"conclusion_follows_when_added": True}))
    assert ok["ok"] is True
    bad = gen_validators.validate_structure(
        "SufficientAssumption", _cand("B"),
        lambda _p: json.dumps({"conclusion_follows_when_added": False}))
    assert bad["ok"] is False and bad["reason"] == "conclusion_does_not_follow"


def test_parallel_validator_pass_and_fail():
    ok = gen_validators.validate_structure(
        "Parallel", _cand("B"), lambda _p: json.dumps({"same_argument_form": True}))
    assert ok["ok"] is True
    bad = gen_validators.validate_structure(
        "Parallel", _cand("B"), lambda _p: json.dumps({"same_argument_form": False}))
    assert bad["ok"] is False and bad["reason"] == "form_mismatch"


def test_parallel_flaw_validator_pass_and_fail():
    ok = gen_validators.validate_structure(
        "ParallelFlaw", _cand("B"),
        lambda _p: json.dumps({"stimulus_is_flawed": True, "same_flaw": True}))
    assert ok["ok"] is True
    bad = gen_validators.validate_structure(
        "ParallelFlaw", _cand("B"),
        lambda _p: json.dumps({"stimulus_is_flawed": True, "same_flaw": False}))
    assert bad["ok"] is False and bad["reason"] == "flaw_mismatch"


def test_paradox_validator_pass_and_fail():
    ok = gen_validators.validate_structure(
        "Paradox", _cand("B"),
        lambda _p: json.dumps({"has_tension": True, "choice_resolves_tension": True}))
    assert ok["ok"] is True
    bad = gen_validators.validate_structure(
        "Paradox", _cand("B"),
        lambda _p: json.dumps({"has_tension": False, "choice_resolves_tension": False}))
    assert bad["ok"] is False and bad["reason"] == "no_paradox_resolved"


def test_strengthen_weaken_validators():
    s_ok = gen_validators.validate_structure(
        "Strengthen", _cand("B"), lambda _p: json.dumps({"strengthens": True}))
    assert s_ok["ok"] is True
    w_bad = gen_validators.validate_structure(
        "Weaken", _cand("B"), lambda _p: json.dumps({"weakens": False}))
    assert w_bad["ok"] is False and w_bad["reason"] == "does_not_weaken"


def test_type_complete_prompt_validator_for_method():
    c = _cand("B")
    c["prompt"] = "The argument proceeds by which one of the following methods?"
    v = gen_validators.validate_structure("Method", c, lambda _p: "{}")
    assert v["ok"] is True and v["check"] == "method"


def test_unknown_type_fails_closed():
    v = gen_validators.validate_structure("NotAType", _cand("B"), lambda _p: "{}")
    assert v["ok"] is False
    assert v["check"] == "unknown_q_type"
    assert v["reason"] == "unsupported_q_type"


def test_unknown_type_is_rejected_by_generation_gate():
    report = generation.validate_candidate(
        _cand("B"),
        3,
        solver=_solver_const("B"),
        critic=_critic_single("B"),
        q_type="NotAType",
    )
    assert report["passed"] is False
    assert report["reason"] == "unsupported_q_type"
    assert report["checks"]["structural_type"]["check"] == "unknown_q_type"


def test_validator_fails_closed_on_unparseable_critic():
    # A validator that can't confirm the required structure must NOT approve.
    v = gen_validators.validate_structure(
        "NecessaryAssumption", _na_cand(), lambda _p: "this is not json")
    assert v["ok"] is False


def test_type_validator_wired_into_gate():
    # End-to-end through validate_candidate: a NecessaryAssumption whose negation
    # doesn't break the argument is rejected with the validator's reason.
    def critic(prompt):
        if "negation test" in prompt:
            return json.dumps({"negation_breaks_argument": False,
                               "argument_depends_on_it": False})
        if "strict LSAT item reviewer" in prompt:
            return json.dumps({"single_defensible": True, "defensible_letters": ["B"]})
        return "B"

    report = generation.validate_candidate(
        _na_cand(), runs=3, solver=_solver_const("B"), critic=critic,
        q_type="NecessaryAssumption",
    )
    assert report["passed"] is False
    assert report["reason"] == "assumption_not_required"
    assert report["checks"]["structural_type"]["ok"] is False


# --- 2.9 embedding dedup gate -----------------------------------------------
def _bow_embedder(text, model=None):
    # Trivial bag-of-words vector: identical text -> identical vector -> cosine 1.
    vocab = ["accredited", "lab", "protocol", "lyon", "facility", "follows",
             "vegetation", "heat", "island", "city"]
    t = (text or "").lower()
    return [float(t.count(w)) for w in vocab]


def test_dedup_rejects_near_duplicate(db_session):
    from app import embeddings

    parent = _seed_lr_parent(db_session, "Inference")

    # Pre-embed an existing question whose text matches the candidate exactly.
    existing = Question(stem=_cand()["stem"], prompt=_cand()["prompt"],
                        correct_answer="B", q_type="Inference",
                        source=QuestionSource.research)
    db_session.add(existing)
    db_session.commit()
    db_session.refresh(existing)
    for c in _cand()["choices"]:
        db_session.add(AnswerChoice(question_id=existing.id, label=c["label"],
                                    text=c["text"], is_correct=(c["label"] == "B")))
    db_session.commit()
    embeddings.embed_question(db_session, existing, embedder=_bow_embedder)

    job = GenJob(q_type="Inference", count=1, status=GenStatus.queued)
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    job_id = job.id

    # The generator emits a candidate identical to the existing question. It is
    # also the solver (run_job uses generate= for the self-consistency solver),
    # so it must answer the solve prompt with the credited letter.
    def gen_fake(prompt):
        if "Write ONE original" in prompt:
            return json.dumps(_cand("B"))
        return "B"

    generation.run_job(job_id, generate=gen_fake, critic=_critic_single("B"),
                       embedder=_bow_embedder)

    with Session(engine) as s:
        finished = s.get(GenJob, job_id)
        assert finished.accepted == 0
        assert finished.quarantined == 1
        cand_report = finished.validation_report["candidates"][0]
        assert cand_report["reason"] == "near_duplicate"
        assert cand_report["checks"]["novelty"]["ok"] is False


def test_dedup_passes_when_no_existing_embeddings(db_session):
    # With an empty vector store the dedup gate no-ops (and never calls embed).
    _seed_lr_parent(db_session, "Inference")
    job = GenJob(q_type="Inference", count=1, status=GenStatus.queued)
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    job_id = job.id

    calls = {"n": 0}

    def counting_embedder(text, model=None):
        calls["n"] += 1
        return _bow_embedder(text)

    def gen_fake(prompt):
        if "Write ONE original" in prompt:
            return json.dumps(_cand("B"))
        return "B"

    generation.run_job(job_id, generate=gen_fake, critic=_critic_single("B"),
                       embedder=counting_embedder)

    with Session(engine) as s:
        finished = s.get(GenJob, job_id)
        assert finished.accepted == 1
        novelty = finished.validation_report["candidates"][0]["checks"]["novelty"]
        assert novelty["checked"] is False
    # No bank vectors to compare against -> embedder never invoked.
    assert calls["n"] == 0


def _seed_lr_parent(session: Session, q_type: str) -> Question:
    parent = Question(stem="x" * 60, prompt="p?", correct_answer="A",
                      q_type=q_type, source=QuestionSource.research)
    session.add(parent)
    session.commit()
    session.refresh(parent)
    for lbl in "ABCDE":
        session.add(AnswerChoice(question_id=parent.id, label=lbl,
                                 text=f"opt {lbl}", is_correct=(lbl == "A")))
    session.commit()
    return parent


# --- 2.8 empirical difficulty calibration -----------------------------------
def test_accuracy_to_difficulty_mapping():
    assert audit.accuracy_to_difficulty(1.0) == 1.0   # easiest
    assert audit.accuracy_to_difficulty(0.5) == 3.0
    assert audit.accuracy_to_difficulty(0.0) == 5.0   # hardest
    assert audit.accuracy_to_difficulty(0.75) == 2.0
    # clamps
    assert audit.accuracy_to_difficulty(1.5) == 1.0
    assert audit.accuracy_to_difficulty(-0.5) == 5.0


def _attempts_for(session: Session, q: Question, correct_n: int, total_n: int,
                  mode: AttemptMode = AttemptMode.drill) -> None:
    sess = StudySession(type=SessionType.drill)
    session.add(sess)
    session.commit()
    session.refresh(sess)
    for i in range(total_n):
        session.add(Attempt(question_id=q.id, session_id=sess.id, mode=mode,
                            is_correct=(i < correct_n)))
    session.commit()


def test_calibrate_difficulty_recomputes_from_accuracy(db_session):
    q = _seed_lr_parent(db_session, "Weaken")
    q.difficulty = 2  # model-asserted; must remain intact
    db_session.add(q)
    db_session.commit()
    # 2 of 8 correct -> accuracy 0.25 -> difficulty 4.0
    _attempts_for(db_session, q, correct_n=2, total_n=8)

    out = audit.calibrate_difficulty(db_session, min_attempts=5)
    assert out["calibrated"] >= 1

    db_session.refresh(q)
    assert q.empirical_difficulty == 4.0
    assert q.difficulty == 2  # model-asserted untouched


def test_calibrate_skips_insufficient_attempts(db_session):
    q = _seed_lr_parent(db_session, "Weaken")
    _attempts_for(db_session, q, correct_n=1, total_n=3)  # below min
    audit.calibrate_difficulty(db_session, min_attempts=5)
    # My fresh question has only 3 (< 5) live attempts -> not calibrated.
    db_session.refresh(q)
    assert q.empirical_difficulty is None


def test_calibrate_excludes_blind_review(db_session):
    q = _seed_lr_parent(db_session, "Weaken")
    # All attempts are blind-review -> excluded -> not enough live attempts.
    _attempts_for(db_session, q, correct_n=5, total_n=8,
                  mode=AttemptMode.blind_review)
    out = audit.calibrate_difficulty(db_session, min_attempts=5)
    assert out["calibrated"] == 0
    db_session.refresh(q)
    assert q.empirical_difficulty is None


def test_calibrate_difficulty_endpoint(client):
    # A fresh question with a known attempt history (so seed attempts don't
    # blend in), then hit the endpoint.
    from app.db import engine as eng
    with Session(eng) as s:
        q = Question(stem="z" * 60, prompt="p?", correct_answer="A",
                     q_type="Weaken", source=QuestionSource.research)
        s.add(q)
        s.commit()
        s.refresh(q)
        sess = StudySession(type=SessionType.drill)
        s.add(sess)
        s.commit()
        s.refresh(sess)
        for i in range(6):
            s.add(Attempt(question_id=q.id, session_id=sess.id,
                          mode=AttemptMode.drill, is_correct=(i < 3)))
        s.commit()
        qid = q.id

    r = client.post("/api/gen/calibrate-difficulty", json={"min_attempts": 5})
    assert r.status_code == 200
    body = r.json()
    assert body["calibrated"] >= 1

    with Session(eng) as s:
        q = s.get(Question, qid)
        assert q.empirical_difficulty == 3.0  # 3/6 correct -> accuracy 0.5 -> 3.0
