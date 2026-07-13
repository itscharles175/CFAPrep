# LSATLab — Stack Upgrade Roadmap (R6)

Status framing: after the backend roadmap (158 tests) and the full R4+R5 UI, LSATLab is
**feature-complete but not yet a product you could hand to a stranger.** This wave moves it
from "feature-rich dev tool" to **shippable, trustworthy, and scalable**, without breaking the
locked local-first vision (no accounts/sync/hosted backend/cloud-realtime; cloud stays opt-in
for offline Tier-B only).

## The four truths the audit surfaced
1. **Can't be installed by a non-developer** — Tauri best-effort-spawns the backend by hunting a
   `.venv` (`src-tauri/src/lib.rs`); no bundled Python, no app-data dir, no signing, no auto-update,
   CI never runs `tauri build`.
2. **Will slow as the bank grows** — analytics reloads whole tables into Python and filters in-memory
   (`analytics.py` `_question_map`/`_all_attempts`); embeddings re-scan every call.
3. **Correctness soft spots** — official-only scoring + provenance are Python conventions, not DB-enforced;
   PDF answer-key reconcile silently falls back to "first choice"; dedup isn't atomic.
4. **AI has no feedback loop** — strong generation gate, but nothing rates explanations, analyzes *why*
   candidates fail, scores RC authenticity, or detects drift; RAG feeds only the explainer, not drills.

## Tracks
- **S — Shippability:** S1 backend sidecar (PyInstaller `externalBin`), S2 app-data relocation + first-run,
  S3 Ollama detect/guided-setup, S4 code signing/notarization, S5 auto-updater + release CI, S6 crash-safety.
- **P — Scale/Perf:** P1 SQL-pushdown analytics, P2 hot-path indexes, P3 incremental embeddings + warm cache,
  P4 query-budget regression tests, P5 frontend bundle split.
- **D — Data Integrity:** D1 answer-key reconcile workflow, D2 DB-level provenance/scoring guards,
  D3 atomic dedup, D4 integrity check + scheduled local backup, D5 soft-delete + audit trail.
- **Q — AI Quality:** Q1 explanation feedback loop, Q2 generation-failure analytics + refinement retry,
  Q3 RAG-driven drill/SRS selection, Q4 RC authenticity scoring, Q5 approved-AI drift watch,
  Q6 cloud Tier-B for hard generations (opt-in).
- **T — Testing/CI:** T1 e2e in CI + functional flows, T2 golden-set regression (scoring + gate),
  T3 coverage gates + stress/concurrency tests, T4 accessibility ratchet to AA.
- **X — Experience:** X1 first-run onboarding, X2 local ops/Diagnostics panel, X3 coach→tutor chat, X4 print/report.

## Waves
- **Wave 1 — shippable & correct:** S1–S3, D1+D2+D4, P1+P2.
- **Wave 2 — trustworthy to ship repeatedly:** S4+S5, T1+T2, X1.
- **Wave 3 — raise the intelligence ceiling:** Q1+Q2+Q3, P3, T3.
- **Wave 4 — depth & polish:** Q4–Q6, D3+D5, X2–X4, T4, P5.

Highest-leverage bets: **S1** (unlocks every improvement reaching a real user) and **P1** (removes the
one pattern that caps bank size).

## Non-goals (reaffirmed)
No accounts/auth, cloud sync, hosted/Postgres backend, multi-tenancy, mobile, cloud-realtime LLM.
Shippability = a self-contained local install, not a service.
