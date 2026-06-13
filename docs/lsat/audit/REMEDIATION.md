# LSATLab Deployment-Readiness Audit & Remediation (2026-06-02)

Three independent audits were run on the current branch
(`codex/vnext-roadmap-foundation`):

1. **Visual audit** — the app was launched (backend + Vite + browser) and driven
   through onboarding, dashboard, practice, bank, settings, analytics, review,
   drills, import, tutor, playlists, plus light/dark and mobile. Live runtime
   bugs were reproduced and root-caused.
2. **Codex backend audit** — full FastAPI backend pass → [`backend-codex.md`](backend-codex.md)
   (0 P0, 6 P1, 5 P2). Confirmed the `/api/bank/export` official-content firewall
   is intact.
3. **Swarm audit** — 6-dimension, adversarially-verified multi-agent sweep
   (frontend correctness, a11y/UX, deployment, LM Studio, cross-stack, backend
   integrity) → [`frontend-swarm.md`](frontend-swarm.md) (3 P0, 15 P1, 31 P2).

All three P0s were the **LM Studio gap**, which is now fully built and verified.

---

## Fixed & verified this session

Verification: backend **551 tests pass** (`pytest`, excl. live-Ollama), frontend
**198 tests pass** + clean `tsc -b && vite build`, plus live runtime checks.

### LM Studio: now a first-class local provider (all 3 P0s)
Verified end-to-end against the real LM Studio server (gemma-4-e4b-it loaded),
including a live streamed explanation.

- **Editable model-role pickers** for Explain / Generate / Diagnose / Embed /
  Critic — a dropdown of loaded models when the provider is reachable, a
  free-text id input when it isn't. `frontend/src/components/settings/model-routing-card.tsx`
- **`missing_models` surfaced** as a warning ("N configured models not loaded in
  LMStudio …") so AI no longer fails silently after a provider switch.
  `frontend/src/lib/types.ts` (AiHealth), backend `app/ai.py` health scan now
  also covers the critic role.
- **`gen_critic_model` is now runtime-overridable** so generation can be made
  LM-Studio-valid. `app/settings_store.py`, `app/routers/settings_routes.py`.
- **Security (Codex P1 #1): `lmstudio_url` is loopback-validated.** Realtime
  explanations send official content to this URL, so non-loopback hosts are
  rejected with a 422 unless `LSATLAB_ALLOW_REMOTE_LLM=1`. `app/settings_store.py`
  (`is_allowed_lmstudio_url`), `app/routers/settings_routes.py`.
- **Provider parity (Codex P2 #9):** `LMStudioProvider.set_keep_alive` (no-op)
  and the embed call now uses `EMBED_REQUEST_TIMEOUT_S`. `app/llm/lmstudio.py`.

### Core-flow correctness bugs (swarm P1s)
- **Playlists page crash fixed** — `GET /api/playlists` returns a
  `{playlists, criteria_keys}` envelope; the client treated it as an array and
  crashed on `.map`. `api.playlists` now unwraps it. `frontend/src/lib/api.ts`.
  (Verified: page renders its empty state.)
- **PrepTests "Start full timed exam" route fixed** — was routing to
  `/take/${section1}` (single section); now `/exam/${preptestId}` (the real
  multi-section timed exam). `frontend/src/pages/PrepTests.tsx`.
- **Three dead "Add to SRS" affordances now create real cards** — Similar
  Questions, the Explanation error-log checkbox, and Blind-Review reveal all
  wrote to a write-only localStorage list (or only an error-log row) yet toasted
  success, so missed questions never resurfaced. All three now call the real
  `useBulkSrsCards` / `POST /api/srs/cards` mutation; the dead `lib/srsQueue.ts`
  module was removed. `components/explanation/similar-questions.tsx`,
  `pages/Explanation.tsx`, `pages/BlindReview.tsx`.

### Backend hardening
- **API hardening (latent bug):** the `RequestValidationError` handler passed raw
  `exc.errors()` to `JSONResponse`; a validator-raised `ValueError` carries the
  exception in `ctx`, which is not JSON-serializable → **422s turned into 500s**.
  Now wrapped in `jsonable_encoder`. `app/main.py`. (Surfaced by the new
  `lmstudio_url` validator; affects all validator errors.)
- **PDF upload memory cap (Codex P1 #5):** `/import/parse` did `await file.read()`
  unbounded; now a bounded read with a configurable cap
  (`MAX_PDF_UPLOAD_BYTES`, 50 MB) → HTTP 413 on oversize. `app/routers/import_routes.py`,
  `app/config.py`.
- **Non-loopback bind guard (Codex P1 #6):** the packaged sidecar refuses to bind
  a non-loopback host (the local API is unauthenticated and serves official-content
  previews) unless `LSATLAB_ALLOW_REMOTE_API=1`. `backend/sidecar_main.py`.

---

## Round 2 — full remediation pass (implemented & verified)

A second pass implemented essentially the entire backlog. **Verification: backend
579 tests pass, frontend 206 tests pass + clean `tsc -b && vite build`, `cargo
check` clean, and a runtime smoke (every major page, 0 console errors).** A
7-agent implementation swarm handled disjoint backend + a11y file-groups in
parallel; I handled the shared-file / cross-stack / Rust / config fixes and
verified centrally.

Backend (Codex + swarm):
- **Notebook URL-import SSRF** (Codex #2): redirects are now followed manually,
  validating every hop before fetch (cap 5). `notebook_os.py`.
- **Cloud budget overshoot** (Codex #4 / swarm #44): a worst-case pre-charge
  estimate now gates each cloud call. `llm/__init__.py`, `observability.py`.
- **Embed-model-switch corruption** (swarm P0 #31): similarity/dedup/RAG now skip
  dimension-incomparable stored vectors. `embeddings.py`.
- **Portable bank import** (Codex #3 / swarm #46, #47, #49): single-transaction
  rollback, broad-exception handling, `official`→non-official clamp on the
  over-the-wire path, orphan-aware `verify_restore`, bank-list count cleanup.
  `bank_export.py`, `dataset_routes.py`.
- **Restore safety** (Codex #7, #11 / swarm #43, #45): in-process schema heal
  (`init_db`) after restore, worker paused during overwrite, differentiated HTTP
  codes (400/404/409), dedup-index readiness warning. `backup.py`,
  `backup_routes.py`, `migrations.py`.
- **Validation handler 500→422** (latent): `jsonable_encoder` in `main.py`.
- **coachRefresh parity** (#42): `available` field added. `ai_routes.py`.

Frontend correctness / cross-stack:
- **Explanation/review 403** (#37): reveal context (`attempt_id`/`session_id`) is
  now threaded through `api.question`/`useQuestion`. `api.ts`, `hooks.ts`,
  `Explanation.tsx`.
- Command-palette staleness (#4), review-bucket session link (#7), spurious
  `/sessions/0/results` (#8), NotFound→/dashboard (#9), bank-browse reveal 403
  graceful catch (#39).

Accessibility (swarm):
- Sheet titles (#12), answer-choice radio names include the text (#13),
  navigator flagged-cell contrast (#14), eliminate-button label (#15), saved-view
  button labels (#17), scratch-pad ARIA (#18), Progress value text (#19), Dialog
  `aria-describedby` default (#20), form-label associations (#16), and an
  AA-contrast `--warning` text token (#11).

Deployment / packaging:
- **Data-dir unification** (#22): the Tauri shell now passes `LSATLAB_DATA_DIR`
  to the sidecar (`cargo check` verified). `src-tauri/src/lib.rs`.
- Updater-pubkey sentinel (#23), NSIS `currentUser` install (#27), corrected
  `.env.example` host/port vars (#25). LM Studio onboarding now points to the
  role pickers when models are missing (#35).

## Round 3 — the deferred items, now implemented & verified

Verification: backend **589 tests** pass, frontend **206 tests** + clean
`tsc -b && vite build`, `cargo check` clean, OpenAPI snapshot regenerated, and a
live end-to-end check of the drill runner.

- **Drills & Smart-sets now run their curated set (P1 — the big one).** Backend
  persists the selected `question_ids` on the drill/playlist `StudySession`
  (`drills.py`, `playlist_routes.py`) and serves them section-shaped via a new
  `GET /api/sessions/{id}/questions` (`sessions.py`). The frontend adds a
  `/take/session/:id` route + a `sessionMode` in `TakeSection` (loads via
  `useDrillSession`, attaches to the existing session for attempts), and
  `Drills.tsx`/`Playlists.tsx` navigate there. **Verified live:** starting a drill
  now opens the timed runner with the curated questions (was a `/take/null` 422).
- **Final-question timing undercount (P2)** — `section-runner.tsx` now flushes the
  current question's elapsed time before finish/auto-submit (`flushCurrentTime`),
  with the accumulator reworked so an explicit flush + the unmount cleanup never
  double-count.
- **DB-integrity degraded mode (P2)** — on a failed startup integrity check,
  `main.py` now disables the background job worker (so generation can't write to a
  possibly-corrupt DB) and logs DEGRADED, in addition to the existing restore hint.
- **Seed-on-empty (P1)** — added an opt-in `LSATLAB_SEED_ON_EMPTY` flag (off by
  default; skipped on a degraded DB) that seeds sample content into an empty DB.
- **API-client cleanup (P2)** — removed 18 confirmed-zero-reference `api.*`
  methods (incl. the dead `genCreateJob`/`genJob`) + the orphaned `GenJob` import.
- **`/api/ai/models` / refresh (P2)** — added a "Refresh" control on the model
  routing card that re-fetches the provider's loaded models (the simpler of the
  finding's two options).
- **OpenAPI snapshot (P2)** — regenerated the committed `frontend/openapi.json`
  (+`api.gen.ts`) for the new route; the release gate's drift check enforces it.
- **Version consistency** — backend now reads `config.APP_VERSION` (0.1.0),
  matching `tauri.conf.json` / `package.json` / `Cargo.toml`.
- **Sidecar build guard (P2)** — `npm run tauri:build` now runs
  `scripts/check-sidecar.mjs` first and fails clearly if the backend sidecar
  binary isn't staged (prevents a broken installer).
- **Notebook free-text firewall heuristic (P2)** + **FK-on integration test (P2)**
  — implemented by the swarm (`notebook_os.py` similarity guard;
  `test_fk_integration.py`).
- **BlindReview `correct_answer` (P2)** — verified a non-issue: session results use
  `question_review_mode`, which always includes `correct_answer`.
- **resolve_explain_model defense-in-depth (P1)** — left as-is: fully mitigated by
  the model-role pickers + `missing_models` surfacing (adding a sync model probe in
  the cached resolver would add startup latency for no behavioural gain).

---

## Notes for packaging
- `release-local.ps1` / full `tauri build` were **not** run this session; the
  frontend production build (`tsc -b && vite build`), `cargo check`, and the
  backend suite are green, and the committed OpenAPI snapshot is current. Build the
  sidecar + Tauri bundle (now guarded by `check-sidecar.mjs`) to validate the full
  packaged path before distribution.
