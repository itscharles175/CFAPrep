# 01 — Architecture

## Stack overview
```
┌─────────────────────────────────────────────────────────┐
│  Desktop shell:  Tauri (Rust core; ~10 MB; reuses MSVC)   │
│  Frontend:       React + TypeScript + Tailwind + shadcn/ui│
├─────────────────────────────────────────────────────────┤
│  Backend engine: Python + FastAPI (uv/venv, like Jarvis)  │
│  Local DB:       SQLite (single-file)                     │
│  AI runtime:     Ollama (already installed, 0.18.3)       │
│                  - realtime explain/diagnose: qwen3:8b    │
│                  - offline drill generation:  qwen3:14b/32b│
│  Embeddings/RAG: nomic-embed-text (Ollama) → sqlite-vec   │
└─────────────────────────────────────────────────────────┘
```

### Why this shape
- **Python backend** reuses everything already learned driving Ollama in Jarvis;
  could later expose itself as an MCP tool so Jarvis can answer "how did I do on
  assumption questions this week?"
- **Web frontend** because a study/testing UI lives or dies on its interface, and
  React+Tailwind+shadcn builds a polished, keyboard-driven Digital-LSAT-like screen
  fast.
- **Tauri** glues them with a tiny footprint using the Rust toolchain already
  installed (rustup 1.29 + MSVC 14.44 from the Jarvis build).

### Process model
Tauri spawns the FastAPI backend as a sidecar on a localhost port; the React UI
talks to it over HTTP + SSE (server-sent events for streaming AI tokens). SQLite
file lives in the app data dir. Ollama runs as the existing local service.

## AI subsystem
- **Explainer (Tier A, realtime, streamed):** input = question + chosen answer +
  correct answer; output = per-choice breakdown with trap classification. RAG pulls
  the user's own past notes on similar questions (vector search over Explanation +
  ErrorLogEntry).
- **Diagnostician (Tier A, on-demand/nightly batch):** reads recent attempts, emits
  a plain-English diagnosis + recommended next action; feeds the Dashboard "AI
  Coach" card.
- **Drill Generator (Tier B, offline batch + validation gate):** generates
  variations on weak types. Every item must pass the gate before it is ever served:
  1. **Decorrelated solve (authoritative correctness signal):** a *separate* critic
     model solves the item deterministically (temp 0); its answer must equal the
     credited answer. A secondary **self-consistency** probe re-samples the solver
     a configurable N times (default 3, `LSATLAB_GEN_SC_RUNS`) and must be stable —
     a sampling-stability check, not the primary correctness gate. (The gate also
     layers permutation-invariance, text-informativity, lexical-leak, CoVe,
     multi-model agreement, RC-authenticity, and embedding-dedup checks.)
  2. **Single defensible answer:** an independent critique pass finds no second
     defensible choice.
  3. **No length tell:** correct answer is not systematically longest/shortest.
  4. **Structural check:** stimulus actually contains the logical structure the
     question type requires.
  5. Low-confidence items are **quarantined** for manual review, not auto-served.
- **Score predictor:** maps timed performance on *real* sections to a scaled
  120–180 estimate using published raw→scaled conversion tables for owned tests.
  AI-generated items never feed prediction.

### Model routing (Settings-configurable)
| Job | Default model | Latency tolerance |
|---|---|---|
| Explain a question | qwen3:8b | realtime (streamed) |
| Diagnose patterns | qwen3:8b | seconds, on-demand |
| Generate drills | qwen3:14b or 32b | minutes, offline batch |
| Embeddings | nomic-embed-text | batch |

## Content ingestion pipeline (you have PDFs)
1. **Import** PDF → text extraction (`pymupdf`).
2. **AI structuring pass** (offline, bigger model): parse raw text into
   section → passage → question → choices as structured JSON. LSAT layout is
   regular, so this works well.
3. **Human verify screen** (essential): split view — raw PDF left, parsed structure
   right — fix any mis-splits before commit. One-time per test.
4. **Auto-tagging pass:** assign q_type, difficulty estimate, per-choice trap type;
   user can override.
5. **Answer-key reconcile:** import keys (you have them) and validate against parsed
   correct answers; flag mismatches.

> Legal note: only PrepTests the user owns are imported, for personal study. No
> redistribution. Generated content is clearly tagged `ai_generated` and segregated
> from official content in storage and analytics.

## Backup / portability
SQLite file + a JSON export of the question bank and attempt history.
`GET /api/bank/export` produces a self-contained, schema-versioned JSON
snapshot of every PrepTest, question, choice, explanation, attempt, error log
entry, and SRS card. `POST /api/bank/import-backup` applies it back, deduping
on PrepTest name and on question `external_id` / `content_hash`. The Bank UI
exposes one-click Export/Restore buttons; reinstalls preserve the bank.

## Bank growth pipeline
Beyond the user's owned PDFs, the bank can be grown from free research
datasets (AGIEval LR/RC, tasksource RC) via a dedicated importer:

1. **Research import** (`POST /api/bank/import`, CLI
   `python -m app.import_dataset`) pulls rows from Hugging Face's
   datasets-server, normalizes per source, and writes them as
   `source=research` with stable `external_id` + `content_hash` so re-runs are
   idempotent and cross-dataset overlap dedups.
2. **Auto-tagging** (`POST /api/bank/tag`) assigns `q_type` / `difficulty`
   using a cheap prompt-keyword classifier first, then `qwen3:8b` for the
   prompts the heuristic misses.
3. **Bootstrap orchestration** (`POST /api/bank/bootstrap`,
   `python -m app.bank_bootstrap --target-total 5000`) computes the deficit
   to a target bank size and queues Tier-B generation jobs across q_types
   weighted by `sqrt(anchor_count)`, rotating parents so a single job draws
   from many real anchors. The existing validation gate (self-consistency,
   single-defensible, no length tell, structural) still applies, so growth is
   safe even at scale.
