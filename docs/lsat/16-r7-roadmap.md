# LSATLab — R7 Roadmap (shipped)

Status framing: after v1 + R5 (UI) + R6 (stack: shippable/scalable/trustworthy), the
codebase was *feature-complete and production-shaped* but the **pedagogy data was
captured-but-inert, the AI gate measured plausibility more than soundness, and the
desktop shell was thin**. R7 pushes the next level: it makes the signature pedagogy
*drive what you study*, hardens the generation gate into a real soundness check,
turns the coach into a grounded tutor, and makes the app a genuinely native,
contract-safe desktop tool — all inside the locked local-first vision (single-user,
offline, no accounts/sync/hosted-backend; cloud opt-in for offline Tier-B only; real
imported questions remain the quality anchor and the only thing that feeds scoring).

## P0 (shipped first)
**Provenance export firewall** — `bank_export` / `GET /api/bank/export` used to emit the
full text of copyrighted `official` PrepTest questions, violating "nothing copyrighted
leaves your machine." Now default-deny (`include_official=False`), filtered at both the
PrepTest (`is_official`) and per-question (`source==official`) level, with the HTTP
endpoint hardcoded so the boundary can't be crossed over the wire. Guarded by contract
tests (sentinel-string scan of the payload).

## Three flagships
- **A — The pedagogy comes alive.** The Blind-Review 2×2 now routes to action *at BR-commit
  time* (the moment the data exists): `concept_gap`→SRS card (teach), `lucky`→SRS card pulled
  due soon (fragile), `timing_problem`→pacing queue (not a concept card). Plus a choice-level
  interaction model (process-of-elimination capture + analytics), confidence-calibration
  analytics ("sure-but-wrong"), and error-reason trends — all from data that was previously
  written and never read.
- **B — Make validation real.** The generation gate went from "structural + length-tell +
  same-model self-consistency + a 30-char stimulus check" to an 8-step pipeline: structural →
  length-tell → **deterministic solve by a decorrelated critic model** → self-consistency →
  single-defensible → **adversarial second-answer attack** → **per-q_type structural
  validators** (assumption negation test, parallel form-match, paradox tension, …) →
  **embedding dedup**. Sampling is now deterministic with `format:json`. An offline
  LLM-as-judge eval harness + golden set make Tier-A explanation quality a tracked number.
- **C — A native, trustworthy desktop app.** Native single-instance, window-state (replacing
  the JS shim + launch flash), a global shortcut, a richer tray, `.pdf` "Open with" file
  association, crash-safe durable in-progress sessions, idempotent/batched/auto-flushing
  offline writes, a fully keyboard-driven Blind Review, and live-region accessibility for the
  timed loop (a11y lint ratcheted to **error**).

## What shipped, by track

### Backend (FastAPI/SQLite/Ollama)
- **Schema foundation:** new tables `AttemptChoiceEvent`, `SRSReviewLog`, `MetricSample`,
  `UsageLedger`, `Playlist`, `AuditLog`; additive columns (`PrepTest.scale_table_json`,
  `Question.updated_at`/`empirical_difficulty`, `Explanation.model_used`/`confidence`/
  `answer_checked`, `Attempt.client_attempt_id`, `SRSCard.origin`/`leech`/`last_reviewed`);
  migrations v7 (idempotency + observability indexes) and v8 (orphan-FK cleanup).
- **Pedagogy (A):** `pedagogy.route_one`/`route_outcomes`, `/analytics/calibration`,
  `/analytics/error-reasons`, `/analytics/elimination`, `/srs/concept-gap-queue`,
  `/drills/pacing-queue`, choice-event ingestion on attempt create/batch.
- **Learning science:** honest forecast (information-weighted LS, horizon-widening prediction
  interval folding in LSAT SEM≈2.5, low-confidence range below a data floor); uncertainty-aware
  Beta-Binomial mastery ranked by credible lower bound; `/analytics/pacing` (clock-bleeders,
  thirds decay, triage); `/analytics/fatigue`; FSRS review-logging + `desired_retention`
  setting + leech flagging + interleaved due ordering + `POST /srs/optimize` (optimizer wired
  behind a dep probe); recency-excluding/difficulty-matched drills; per-PrepTest raw→scaled
  tables (`PUT /preptests/{id}/scale-table`, `scale_source` label); adaptive minute-budgeted
  study plan that reads the forecast gap.
- **AI gate (B):** deterministic sampling + structured output in `llm/`, decorrelated critic
  model (`GEN_CRITIC_MODEL`), `gen_validators.py`, adversarial + dedup checks in
  `validate_candidate`/`run_job`, empirical difficulty calibration (`audit.calibrate_difficulty`).
- **Explanation/coach:** self-checked explanations (verify asserted letter == correct answer,
  regenerate-once, populate model/confidence/answer_checked; dropped "do not hedge"); worked-
  exemplar RAG; grounded coach (`coach.build_coach_context`) that cites specific missed
  question ids and varies its recommendation; offline `eval.py` LLM-as-judge + golden set.
- **Platform/correctness:** complete delete cascade + integrity orphan sweep + opt-in
  `PRAGMA foreign_keys` (`LSATLAB_SQLITE_FK`); consistent soft-delete filter + `AuditLog`
  edit trail; full-fidelity portable backup (adds StudyPlan/Setting/Reflection/feedback/
  Annotation/EmbeddingVector/Playlist, firewall kept airtight incl. official embeddings);
  OCR fallback + chunked (no 8k truncation) import; batch idempotent attempts
  (`POST /sessions/{id}/attempts/batch` + `client_attempt_id`); persisted metrics + **enforced**
  cloud monthly budget (falls back to local); read-write provenance-safe MCP tools; worker
  calibration hook; **playlists / "Smart sets"** (CRUD + criteria resolution + play-into-session).

### Frontend (React/Vite/TS/Tauri)
- **Core loop:** durable crash-safe session draft; Blind Review fully keyboard-driven
  (A–E commit, confidence, R/Enter reveal); live-region a11y (timer thresholds, question
  changes, reveal outcome + focus move); granular widget error boundaries; SSE explanation
  auto-reconnect; touch/pen highlighting.
- **Contracts/plumbing:** OpenAPI→TS codegen (`npm run gen:api` → `api.gen.ts` from a committed
  `openapi.json` snapshot) + zod runtime validation on the take→BR→explain hot paths;
  batched/idempotent/auto-flushing offline writes; choice-event capture UI; coach route fixes.
- **Features:** Smart-sets (playlists) page + criteria builder + "Save as Smart set" from Review
  buckets; annotations/notes review hub; SRS card depth (origin, interval preview, explanation
  link); resume-first dashboard + onboarding "try a sample section".
- **Ergonomics/perf:** `placeholderData: keepPreviousData` on analytics hooks; prefetch-on-intent;
  virtualized SessionHistory/Quarantine; centralized versioned localStorage store (key strings
  preserved); `unwrap` accessor (subset migrated, pattern documented).
- **Quality:** behavioral Playwright e2e (real take→BR→reveal→explanation loop + full-route
  smoke, **33 passing** against sample-data with no backend); unit tests for the offline/api/
  mutations spine; jsx-a11y ratcheted **warn→error** (test files now linted too).

### Desktop (Tauri 2)
- `tauri-plugin-single-instance` (focus + forward file args), `tauri-plugin-window-state`
  (native geometry, replaced the JS shim), `tauri-plugin-global-shortcut` (Ctrl+Shift+L →
  focus/resume), richer tray (Resume / Today's SRS / Quick drill), `.pdf` `fileAssociations` +
  open-with → `/import`, updater pubkey sourcing + a CI guard that fails a tag release on the
  placeholder, and documented `tauri signer generate` / secret steps.

## Verification
- **Backend:** 367 pytest tests across 47 files, green **including the live-`qwen3` suite**
  (real explain/generate-`format:json`/tag/eval paths).
- **Frontend:** `npm run build` (tsc strict) + 123 vitest + `npm run lint` (0 errors, jsx-a11y at
  error) + 33 Playwright e2e all green.
- **Desktop:** `cargo check` + `cargo clippy` clean (all three plugins compile); JS bundle
  confirmed unaffected (plugins dynamically imported / `isTauri()`-guarded).

## Honestly deferred / needs a build-or-signing machine
- `tauri build` / installer production, code signing (Authenticode / Apple notarization),
  auto-update end-to-end (real keypair + published `latest.json`), and the OS-level desktop
  behaviors (second-instance focus, `.pdf` association registration, the global shortcut binding,
  window-geometry persistence) — config + Rust are written and compile, but require a real bundle.
- FK enforcement left **opt-in** (`LSATLAB_SQLITE_FK=1`): enabling it globally tripped one test on
  SQLAlchemy flush-ordering (not real corruption), so integrity is guaranteed by the complete
  cascade + orphan sweep instead.
- The `.data.data` envelope collapse is partial (a coherent subset migrated; `unwrap` accessor +
  pattern documented for the remaining ~35 files) — deliberately not a risky one-pass sweep.
- Live spot-checks worth doing on a real machine: OCR against an actual scanned/multi-column
  PrepTest, and exemplar-RAG latency/quality with real embeddings.

## Non-goals (reaffirmed, unchanged)
No accounts/auth, cloud sync, hosted/Postgres backend, multi-tenancy, mobile, cloud-realtime LLM,
Logic Games, or writing sample. Cloud (Claude) stays opt-in for **offline Tier-B only** and never
feeds score prediction.
