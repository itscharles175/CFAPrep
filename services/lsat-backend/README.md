# LSAT Lab — Backend

Local FastAPI study engine for LSAT Lab. Runs entirely offline against a local
SQLite file and a local Ollama instance. All HTTP routes are under `/api`; the
contract lives in `../docs/05-api-contract.md` (source of truth).

## Stack
- **FastAPI + uvicorn** (HTTP + SSE streaming)
- **SQLModel** (SQLAlchemy 2 + Pydantic) over **SQLite** (`lsatlab.db`)
- **httpx** (async streaming to Ollama)
- **PyMuPDF** (PDF import)
- **fsrs** (`py-fsrs`) for spaced repetition
- **pytest** for tests

## Requirements
- Python 3.12, `uv`
- Ollama at `http://localhost:11434` with:
  - `phi4:14b` for preferred Tier-A explanations
  - `qwen3:8b` as the explanation fallback and coach diagnosis model
  - `qwen3:14b` for local Tier-B generation
  - `nomic-embed-text` for local retrieval and semantic deduplication

## Install
```powershell
uv sync          # creates .venv and installs deps from pyproject.toml/uv.lock
```

## Seed sample content (offline, no Ollama needed)
```powershell
uv run python -m app.seed
```
Creates one PrepTest "Sample Diagnostic (original practice content)" — an 8-question
LR section and a 5-question RC section (all original, `source="sample"`), with answer
keys, per-choice trap tags, and pre-written explanations — plus one completed prior
study session with realistic attempts and a few SRS cards so the dashboard/analytics
render against real data. Re-running re-seeds idempotently.

## Run
```powershell
.\run.ps1
# or:
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```
Then visit `http://127.0.0.1:8000/docs` for interactive OpenAPI.

## Test
```powershell
uv run pytest -q
```
Unit tests mock Ollama (fast, deterministic). One integration test
(`tests/test_live_ollama.py`) hits real Ollama and is auto-skipped when it is
unreachable.

## Configuration (env vars, all optional — see `backend/.env.example` for the full list)
| Var | Default | Meaning |
|---|---|---|
| `LSATLAB_DB` | `backend/lsatlab.db` | SQLite file path |
| `LSATLAB_LOCAL_PROVIDER` | `ollama` | Local inference provider: `ollama` or `lmstudio` (also switchable in Settings → AI & system) |
| `LSATLAB_OLLAMA_URL` | `http://localhost:11434` | Ollama base URL |
| `LSATLAB_LMSTUDIO_URL` | `http://localhost:1234/v1` | LM Studio OpenAI-compatible base URL (include the `/v1` suffix); loopback only unless `LSATLAB_ALLOW_REMOTE_LLM=1` |
| `LSATLAB_EXPLAIN_MODEL` | `phi4:14b` | Preferred Tier-A explanation model |
| `LSATLAB_EXPLAIN_FALLBACK_MODEL` | `qwen3:8b` | Local fallback when the preferred explain model is not pulled |
| `LSATLAB_GEN_MODEL` | `qwen3:14b` | Tier-B generation/structuring model |
| `LSATLAB_GEN_CRITIC_MODEL` | `llama3.1:8b` | Decorrelated critic for Tier-B gate |
| `LSATLAB_DIAGNOSE_MODEL` | `qwen3:8b` | coach diagnosis model |
| `LSATLAB_TAG_MODEL` | `qwen3:8b` | tagging model (A9: small fast model) |
| `LSATLAB_EMBED_MODEL` | `nomic-embed-text` | embeddings model (RAG / similarity) |
| `LSATLAB_EMBED_REQUEST_TIMEOUT_S` | `30` | per-request timeout for embed calls |
| `LSATLAB_VECTOR_BACKEND` | `auto` | H1: `auto`, `sqlite_vec`, or `python` |
| `LSATLAB_GEN_SC_RUNS` | `3` | self-consistency runs in the validation gate |
| `LSATLAB_GEN_PROVIDER` | `ollama` | offline generation provider: `ollama` or `cloud` |
| `ANTHROPIC_API_KEY` / `LSATLAB_CLOUD_API_KEY` | — | cloud key; enables the `cloud` provider (offline tiers only) |
| `LSATLAB_CLOUD_GEN_MODEL` | `claude-3-5-sonnet-20241022` | cloud model for offline Tier-B generation |
| `LSATLAB_CLOUD_BUDGET_USD_MONTHLY` | `50` | R7 hard monthly budget for the cloud path |
| `LSATLAB_LLM_RETRIES` | `2` | transient-error retries for model calls |
| `LSATLAB_LLM_CONCURRENCY` | `2` | cap on concurrent local GPU calls |
| `LSATLAB_JOBS_WORKER` | `1` | run the durable generation worker (`0` in tests) |
| `LSATLAB_CALIBRATION_INTERVAL_S` | `86400` | empirical-difficulty recalibration period |
| `LSATLAB_LOG_DIR` / `LSATLAB_LOG_LEVEL` | `<db dir>/logs`, `INFO` | local rotating log file |
| `LSATLAB_CORS_ORIGINS` | `http://localhost:5173,tauri://localhost` | allowed CORS origins (validated at startup; `*` is rejected) |
| `LSATLAB_SQLITE_FK_ENFORCE` | `1` | toggles `PRAGMA foreign_keys=ON` (default on for app integrity) |

> **Realtime stays local.** Explain/diagnose/tag always use Ollama. The optional
> `cloud` provider serves **only** offline Tier-B generation + its validation
> passes, never realtime and never score prediction. The cloud key lives in the
> environment only — it is never persisted or returned by the settings API.

## Local release trust
Run the local release gate before packaging or publishing:

```powershell
uv run python scripts\release_local.py --timeout 1200
```

The gate writes `dist/release_local_report.json` and `dist/release_trust.json`.
Production-ready local AI requires the configured explain, fallback, diagnose,
generation, and embedding models to be visible to Ollama; missing preferred
models are surfaced in the trust manifest instead of being hidden by fallbacks.

## Backend capabilities added on top of v1
- **Resilient LLM layer** (`app/llm/`): retries/backoff, a GPU concurrency cap, and
  a pluggable provider (Ollama default; optional cloud for offline generation).
- **Durable job queue** (`app/jobs.py`): generation jobs survive restarts; a worker
  drains `queued` jobs and a startup reconciler fails interrupted ones
  (`planned → queued → running → done/failed`).
- **Recorded migrations** (`app/migrations.py`) beside additive columns in `db.py`.
- **Embeddings + RAG** (`app/embeddings.py`): vectors for "similar misses",
  semantic dedup, and past notes the explainer weaves in.
- **Full exam mode** (`app/exams.py`), **study plans** (`app/study_plan.py`),
  **forecasting + mastery** (`app/analytics.py`), **settings/model routing**
  (`app/settings_store.py`), **scheduled coach** (`app/coach.py`), **explanation
  pre-generation** (`app/pregenerate.py`), **bank audit** (`app/audit.py`), and a
  **read-only MCP server** (`uv run python -m app.mcp_server`).
- **Observability** (`app/observability.py`): local rotating log + per-request id +
  uniform LLM-call telemetry. CI in `.github/workflows/ci.yml`.

> **Testing note:** Ollama may be running locally, so unit tests inject fake model
> callables (`solver`/`critic`/`generator`/`model_call`/`embedder`) and set
> `LSATLAB_JOBS_WORKER=0` — they never call a real model. Coverage:
> `uv run pytest --cov=app`.

## Project layout
```
backend/
  app/
    config.py        env-overridable settings
    db.py            engine + session
    models.py        SQLModel schema + enums
    serializers.py   test-mode vs review-mode question shapes (answer hiding)
    ai.py            Ollama streaming, <think> stripping, explain/diagnose/health
    analytics.py     dashboard, by-type, timing, BR-gap, traps, 2x2 outcome
    scoring.py       raw -> 120-180 scaled conversion curve (documented)
    srs.py           FSRS scheduling (py-fsrs)
    generation.py    Tier-B drill generation + 4-part validation gate
    import_pdf.py    PDF text extraction + AI structuring + commit + fixture
    seed.py          sample content + prior session seeder
    routers/         FastAPI routers (content, sessions, ai, analytics, srs,
                     drills, generation, import, error_log)
    main.py          app assembly + CORS
  tests/             pytest suite (Ollama mocked + 1 skipif live test)
  run.ps1            uvicorn launcher
```

## Key behaviors
- **Answer hiding:** test-mode question responses never include
  `correct_answer`/`is_correct`/`trap_type`/`explanation`. Only `?reveal=true`,
  `/sessions/{id}/results`, quarantine review, and error-log expose the key.
- **Official-only stats:** score prediction and "official accuracy" use
  `source == "official"` only. Seeded sample content is `source="sample"`, so
  `by-type?source=official` is empty until you import a real owned PrepTest.
- **Blind-review 2×2:** `results` returns `outcome` =
  `timed_ok | timing_problem | concept_gap | lucky`.
- **Tier-B gate:** generated items must pass self-consistency, single-defensible
  critique, no answer-length tell, and structural sanity; failures are quarantined
  and never served until manually approved.

## Score conversion curve
`scoring.py` maps percent-correct on official questions to a 120–180 scaled estimate
via a representative published-style piecewise-linear curve (100%→180, 90%→170,
80%→164, 70%→158, 60%→152, 50%→145, 40%→138, 30%→131, 20%→125, ≤10%→120). It is an
estimate; only `source=="official"` attempts feed it. See the docstring in
`app/scoring.py` for the full anchor table and rationale.
