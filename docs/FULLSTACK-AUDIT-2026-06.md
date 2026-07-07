# Full-Stack Audit — 2026-06-20

**Method.** Two independent agent swarms + an adversarial cross-check, GitNexus-guided.
- **Codex swarm** (5 read-only deep auditors): data/persistence, FastAPI backend, Rust/Tauri sidecars, security/offline, build/CI.
- **Claude swarm** (9 GitNexus-aware auditors): learning/FSRS engine, analytics/viz, cross-domain identity, unified-shell runtime, LSAT client contract, UI/a11y, host-data impact, performance, test-coverage.
- **Cross-check** (6 adversarial verifiers): re-read every cited `file:line` at HEAD `d73e959`, tried to *refute* each claim, and re-calibrated severity to the real threat model.

**Threat model.** Local-first, offline, single trusted user; no remote server; no multi-tenant; no untrusted network. Calibration: data loss/corruption/silent-wrong-scoring = top; silent/default non-localhost egress = high; opt-in features the user must enable ≠ violations; classic web auth/CSRF = N/A.

**Headline.** Under the real threat model there are **no confirmed CRITICALs** — every "CRITICAL" the Codex swarm raised was either refuted or downgraded once calibrated (notably the Anthropic cloud egress, which is strictly opt-in). The substance is a tight set of **HIGH**s (one real scoring-corruption gate gap, broken cross-domain navigation, a whole-app crash-isolation gap, and an untested offline invariant) plus a cluster of **safety nets that silently don't work**.

Legend: 🔁 found by both swarms · 🟣 Codex · 🔵 Claude · ✓ cross-check CONFIRMED · ◐ PARTIAL · ✗ REFUTED.

---

## HIGH

### H1 — Derived learning data can be silently lost on every Import/Repair/Restore 🔵
`src/lib/progressStore.ts:2282` (rebuild) + `:3936-3942` (clears) + `:4114` (repair). `importVaultData` commits its atomic transaction, **then** calls `rebuildLearningIndexes()` in a *separate* transaction whose first act is `clear()` of `reviewItems`, `masterySnapshots`, `reviewEvents`, `confidenceCalibration` before rebuilding row-by-row. If that rebuild throws/aborts (quota, a throw in `buildReviewItem`/`scheduleReview`, blocked tab), those four derived stores are left **cleared** while `questionResults` survives — the user's SRS schedule, mastery, and calibration vanish though the import "succeeded". Blast radius (GitNexus impact): every Import, Repair, and Unified Restore. *Not adversarially cross-checked; strong evidence, conf 0.82.*
**Fix:** build rebuilt rows in memory first, then `clear()+bulkPut()` inside one tx (abort rolls back to the imported-consistent state); or fold the rebuild into the import transaction; or restore the rollback snapshot on rebuild failure.

### H2 — Malformed "official" questions can enter the scored bank 🟣 ✓
`services/lsat-backend/app/import_pdf.py:481`. `commit_issues` builds labels as a **set**, so five duplicate `"A"` choices collapse and pass (`len==5` still true); `commit_structure` then persists `source=official, approved=True` and marks **every** label-matching choice `is_correct=True`. `finish_session` scores on official `is_correct` → silently corrupted score prediction. Gated only by user OCR review + explicit force, not by code.
**Fix:** strict commit schema — labels exactly A–E once, exactly one credited choice, difficulty 1–5, non-empty text, known section/q_type.

### H3 — Cross-domain navigation changes the URL but not the view 🔵 ✓
`src/lib/domainNav.ts:90`. `navigateDomain()` does `history.pushState` + dispatches `studyvault:navigate`, but **nothing** under the single `<BrowserRouter>` (UnifiedRoot) listens for that event or fires `popstate`, and React-Router 7 only observes native `popstate`. So the Dashboard "LSAT" card, the ⌘K cross-domain jump, NotificationCenter rows, and cross-domain Back (`history-aware-back.ts:87`) flip the URL while the mounted plane stays put until a reload. The deleted legacy `StudyVaultRoot` had the listener; the unified cutover never reintroduced it.
**Fix:** mount a small component under the router that listens for `studyvault:navigate` and calls `useNavigate()`; or have `navigateDomain` dispatch a synthetic `popstate` after `pushState`. Add a runtime test.

### H4 — A crash in shared chrome/providers white-screens the whole app 🔵 ✓
`src/components/UnifiedRoot.tsx:103`. The `/lsat/*` and `/*` route elements have **no per-plane ErrorBoundary**; `SharedLayout` (Sidebar/TopBar) and the `LsatUnifiedMount` provider stack sit *above* the in-`App` boundaries. A render throw there escapes every in-app boundary to the root `main.jsx` crash screen (hard-reload only) — defeating the stated crash-isolation goal.
**Fix:** wrap each plane in `UnifiedRoot` with a route-reset `DomainErrorBoundary` (the `resetKey` API already exists).

### H5 — The offline/PWA invariant is never exercised in CI 🟣 ✓
`package.json:40` defines `browser:regression` (SW readiness, offline reload, offline deep-routes, PWA update prompt) — the gate for this app's central promise — but **no workflow invokes it** (grep across `.github/` = 0). A broken service worker or update path ships green.
**Fix:** add a CI job after `npm run build` that installs Chromium and runs `npm run browser:regression`.

---

## MEDIUM

### Safety nets that silently don't work
- **M1 — Rollback snapshots are write-only.** 🔵 ✓ `progressStore.ts:2101`. A full `VaultExport` is snapshotted before every reset/import/repair, but **no code restores `snapshot.payload`** — no `restoreRollback`, no UI. The advertised one-click safety net is unusable, and each snapshot embeds a full vault copy → export bloat. **Fix:** add `restoreRollbackSnapshot(id)` + a Restore button in SystemHealth; exclude snapshot payloads from `exportVaultData`.
- **M2 — `repairVaultData` is dead for real corruption.** 🟣 ✓ `progressStore.ts:4088`. It filters bad rows then `importVaultData(repaired,'replace')` **without recomputing the checksum**, so validation rejects it *exactly when it removed rows*. Repair succeeds only when it changes nothing. **Fix:** recompute the checksum (`withChecksum`) after filtering.
- **M3 — DATA-3 schema-version handshake gate is decorative.** 🔵 ✓ `useSyncProgress.ts`/`useSyncFsrsWriteBack.ts` mounted unconditionally in `UnifiedRoot.tsx:89`, POST to `:8100` every 5 min with **no** `crossDomainWritesEnabled` check (only SystemHealth reads it, for display). A version-mismatched host keeps pushing → backend-mirror drift (not host corruption). **Fix:** gate both hooks on `fetchDataSchemaAlignment()`.

### Data integrity (host)
- **M4 — Single-question save is non-transactional.** 🔁 ✓ `progressStore.ts:792` — `recordQuestionResult → persistQuestionResult` writes 5 stores sequentially with no `db.transaction` (the bulk path *does*). Currently latent (GitNexus impact: 0 live callers; exported only) but trivially reachable. **Fix:** wrap in the same tx the sibling recorders use.
- **M5 — Future-schema import silently drops unknown stores.** 🔁 ✓ `progressStore.ts:1748` — `migrateVaultData` copies only known `STORE_NAMES`, forces `schemaVersion`, and re-synthesizes the checksum so nothing flags the drop. Only bites a newer-build backup restored into an older build. **Fix:** reject `schemaVersion > VAULT_SCHEMA_VERSION` (or warn + list dropped stores).
- **M6 — Attempt `crossId` derived from the Dexie auto-id → backend double-counts after a merge-import.** 🔵 `dataDictionary.ts:408`. Merge-import re-keys `questionResults`, so each historical attempt gets a *new* `cfa:attempt:<n>`; the idempotent backend UPSERT then stores both copies → double-counted attempts/accuracy in cross-domain analytics & ability. **Fix:** derive `nativeId` from content (`hash(questionId+createdAt)`), not the row id.

### Backend correctness
- **M7 — Generated `difficulty` is unbounded.** 🟣 ✓ `generation.py:1001/2349` — `validate_candidate` doesn't bound difficulty; `difficulty=999` survives and skews `adaptivity._attempt_signal` ability math. Originates from the user's own local model (decoder-bounded), not an attacker. **Fix:** require/clamp difficulty 1–5 before persist.
- **M8 — Passage-first enqueue race.** 🟣 ✓ `passage_routes.py:60` — the job is committed `queued` *then* `passage_first=True` in a second commit; a worker poll in between runs the per-question pipeline instead of the shared RC passage. (This is the L5 feature shipped this session.) **Fix:** pass `passage_first` into `enqueue` before the first commit.
- **M9 — Attempt batch is unbounded and per-attempt-committed.** 🟣 ✓ `sessions.py:47` — no `max_items`, each attempt commits separately, no outer transaction → a mid-batch failure leaves partial scoring history (idempotency keys make retry safe). **Fix:** bound the list + one transaction.
- **M10 — Portable bank import writes unbounded difficulty / arbitrary `correct_answer` / verbatim `is_correct`.** 🟣 ◐ `bank_export.py:577`. The "mints `official`" premise was **refuted** (incoming `official` is clamped to `sample`), but the unvalidated fields are real (self-inflicted by the user's own backup). **Fix:** validate imported questions through the same strict schema.

### Offline-invariant hardening (bounded, but real)
- **M11 — `localLlm` base URL has no loopback validation; a backup import can redirect prompts off-device.** 🟣 ✓ `localLlm.js:206` + `progressStore.ts:2245`. Gated on importing an untrusted backup **and** enabling the LLM, but there's no host allow-list. **Fix:** restrict `baseUrl` to loopback/private hosts in `saveLlmSettings`.
- **M12 — Model-markdown `<img>` + service-worker image cache → remote tracker egress.** 🟣 ✓ `ai-markdown.tsx:49` renders model markdown with no `img` override; `sw.js:28` caches every image with no same-origin check. Bounded (explanations come from the local model; needs poisoned RAG/imported content). **Fix:** override the `img` renderer to drop/relativize remote `src`; same-origin-guard the SW image route.
- **M13 — Weekly-report export interpolates unescaped `q_type` into downloaded `text/html`.** 🟣 ✓ `weeklyReport.ts:42`. The codebase already has `escapeHtml()` (used in `br-worksheet-export.ts`) but this builder skips it. **Fix:** escape all interpolated fields.

### Rust / Tauri (resource leaks; no data loss)
- **M14 — Sidecars survive an app crash/kill.** 🟣 ✓ `lib.rs:2237` — cleanup only on clean `RunEvent::Exit`; plain `Command::spawn` with no Job Object / process group / parent-death. On SIGKILL/panic, sidecars keep ports + the RocksDB lock. **Fix:** launch in a Windows Job Object (kill-on-close) / Unix process group + PDEATHSIG.
- **M15 — `uv`-spawned grandchildren orphaned** 🟣 ✓ `lib.rs:584` (kill hits only the direct `uv` child); **M16 — DATA-7 relocation guard is inert** 🟣 ✓ `lib.rs:879` (only fires if `LSATLAB_DATA_DIR` is preset, which packaged startup never sets → orphaned legacy bank never recovered; detect-only, so no destruction).

### Client contract & runtime
- **M17 — `request()` has no abort/timeout.** 🔵 ✓ `api.ts:219` — every JSON endpoint can hang forever against a wedged-but-connected sidecar; only SSE paths thread `AbortSignal`. **Fix:** add `signal` + `AbortSignal.timeout()` and thread React Query's signal on hot paths.
- **M18 — `api.gen.ts` is 41 routes behind and the drift gate can't see it.** 🔵 `api.gen.ts`/`_meta/openapi.json` (185 paths) vs backend baseline (226). The drift gate only diffs live-backend-vs-backend-baseline and only fails on *removals*, so client-side drift (a renamed field on any of 41 unseen routes) ships green and only fails at runtime. ~15 files carry `// read defensively / bare cast` against a contract no tool verifies. **Fix:** add a root `gen:api` script + a CI step diffing the committed client spec against the live backend.

### CI / build
- **M19 — Visual-regression gate is a false-green.** 🟣 ✓ Fixed: `visual-regression.mjs` now preflights the required route/theme/viewport baseline matrix and fails closed when any baseline is missing unless `UPDATE_VISUAL_BASELINES=1` is set for a deliberate rebaseline. Host and LSAT visual jobs restore separate approved baseline caches. *(Cosmetic gate → MEDIUM.)*
- **M20 — Release can publish with missing installers.** 🟣 ✓ `release.yml:270` `if-no-files-found: warn` + `:293` `fail_on_unmatched_files: false`. The total-empty case is caught by the sidecar/tauri-build steps; a *partial* installer set slips through. **Fix:** `error` + `fail_on_unmatched_files: true` + a bundle-count assertion.
- **M21 — Bundle gate ignores the 21.6 MB `ort-wasm` asset.** 🟣 ✓ `bundle-report.mjs:25` scans only `.js`/`.css`. **Fix:** add `.wasm`/worker/font budgets.

---

## LOW (selected)
- **Analytics phantom points** 🔵 `Analytics.jsx:726` — CFA calibration scatter & tables plot zero-attempt buckets as `(conf%, 0%)` / "+100 gap" (the LSAT series correctly filters `attempts>0`). Fix: filter `attempts>0`.
- **FSRS `cardFromReviewItem` can throw `Invalid delta_t`** 🔵 `scheduler.ts:201` — reconstructs `last_review` from `dueAt−interval` instead of the persisted `lastResultAt`; a dueAt edit (write-back/restore) makes `ts-fsrs` throw on the answer hot-path. Fix: anchor to `lastResultAt`, clamp `≤ now`.
- **Timezone off-by-one** 🔵 `forecastReviewLoad`/heatmap/streak key by UTC date but compute "today" from local midnight → wrong day bucket east/west of UTC.
- **Accent-as-text contrast** 🔵 ◐ `tokens.css:391` — `--accent #8B5CF6` as *small text* on dark cards ≈ 4.0:1 (sub-AA); button fill `#6D28D9` and light theme pass. A11y polish only. (My earlier live check measured the button-fill `--accent-strong #6D28D9`, which passes — the text token is the lower-contrast one.)
- **Arbitrary local PDF/file read** 🟣 ✓→LOW `lib.rs:202`, `dataset_routes.py:179` — mechanically real but crosses no privilege boundary (CSP-locked webview; the "attacker" is the single user who owns the disk). Defense-in-depth only.
- **Light theme `--text-muted` == `--text-secondary`**; **`status-badge-danger` 4.03:1**; **`StudySessionCard` missing `-webkit-backdrop-filter`**; **`playlists()` swallows shape mismatch as `[]`**; **sidecar restart-loop has no backoff** (self-limited to 1/7s); **webview opens before sidecar readiness** (degrades gracefully); **`cfa_pick_folder` blocks an async worker**; **`fsrsOptimizer` comments say FSRS-4.5 but lib is FSRS-6** (indices still valid).

---

## Notable REFUTALS / downgrades (trust calibration)
- ✗ **Cloud egress to `api.anthropic.com` is NOT a default leak.** `GEN_PROVIDER` defaults to `ollama`; cloud requires `GEN_PROVIDER=cloud` **and** an API key. The default build is fully local/offline. (Documented opt-in offline-tier.)
- ◐→LOW **HF dataset import & notebook URL import** are opt-in, user-triggered, loopback-only routes to fixed hosts; the notebook URL fetch has sound per-hop SSRF/private-IP guards.
- ◐→LOW **SRS bulk `question_ids`** — the "N+1 that locks the DB" is overstated (one pre-load query; cap is cheap hardening, not a vuln).
- ◐→LOW **CI headless backdrop-filter screenshot hang** — the *CI* Playwright job uses **new-headless Chromium (SwiftShader)**, which renders `backdrop-filter` and fails *loudly* via timeouts rather than hanging; the diff path is unreachable on fresh CI anyway. The hang I hit live was the GPU-less **CDP `Page.captureScreenshot`** path in the preview/automation Chrome — real for that tooling, not for CI. (Still worth gating blur behind `prefers-reduced-transparency` for perf + capture friendliness.)

---

## Recommended fix order
1. **H1** (derived-data loss on restore) — highest data-integrity value; touches the path worked on this session.
2. **H3 + H4** (broken cross-domain nav + crash-isolation gap) — small, high-impact runtime fixes.
3. **H2 + M7/M8** (question-validity gates: dup-label, difficulty bound, passage-first race).
4. **M1/M2/M3** (make the rollback/repair/handshake safety nets actually work).
5. **H5 + M18/M19/M20** (wire offline regression into CI; close the client drift + release gates).
6. Egress hardening **M11/M12/M13**, Rust lifecycle **M14–M16**, then LOWs.

---

## Remediation status (2026-06-20, branch `codex/performance-level2-content-gate`)

Implemented in waves, each independently gated (tsc host+lsat / eslint / vitest /
vite build for host+LSAT; pytest for backend; cargo test for Rust) + `detect_changes`
before each commit:

- **Wave A** `0892165` — M1 rollback **restore** (+ SystemHealth button), M2 repair
  re-checksum, M4 `recordQuestionResult` transaction, M5 future-schema/unknown-store
  reject. (+4 tests)
- **Wave B** `ba2a6d5` + `4948045` — H3 cross-domain nav reaches the router, H4
  per-plane ErrorBoundary, M17 `request()` abort/timeout, M3 sync handshake gate,
  M6 content-stable attempt crossId, stale-comment cleanup. (+2 tests)
- **Wave C** `7ef2e19` — H2 duplicate-label gate, M7/M10 `clamp_difficulty` at all 6
  ingestion sites, M8 passage-first enqueue race, M9 + SRS payload bounds. (+1 test)
- **Wave D** `595060a` — M11 localLlm loopback allow-list, M12 markdown remote-img
  block + SW same-origin image cache, M13 weekly-report HTML escaping.
- **Wave F** `f2f44fa` — H5 offline/PWA suite wired into CI, M19 visual gate
  fail-closed-when-baselines-exist, M20 release fail-on-missing-installers, M21
  bundle gate scans/budgets `.wasm`.
- **Wave G** `a26ff01` — FSRS `cardFromReviewItem` delta-guard, analytics
  phantom-point filter, dark-theme LSAT accent contrast, StudySessionCard webkit prefix.
- **Wave E** (this) — M15 process-tree kill (Windows `taskkill /T` for uv
  grandchildren) at the respawn + exit paths, `cfa_pick_folder` `spawn_blocking`.

### Documented residuals (deliberately deferred, with rationale)
- **H1** — REFUTED on inspection: `rebuildLearningIndexes` already wraps
  clear()+rebuild in one Dexie transaction (the clear rolls back on abort), so the
  "leaves stores cleared" data-loss premise is false. No change.
- **M14** (sidecars survive an app *crash*) — needs an OS Job Object
  (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) assigned at spawn + a Unix PDEATHSIG path.
  This is process-lifecycle code whose kill-on-crash behaviour can only be verified
  by running the Tauri shell on Windows; shipping it unverified risks breaking
  sidecar launch (worse than the recoverable port leak). M15 (tree-kill on the
  clean exit/restart paths) is done; M14 (the crash path) awaits on-target verification.
- **M16** (DATA-7 relocation guard inert without `LSATLAB_DATA_DIR`) — activating it
  means passing the Tauri app-data dir as the resolve base, but if that differs from
  the backend's own path resolution it would redirect the sidecar to an empty store
  (a regression). Needs host↔backend path-resolution coordination + on-target test.
  It's a *missed-recovery*, not data loss.
- **M18** (`api.gen.ts` 41 paths behind + client-drift gate) — regenerating the typed
  client requires dumping the live FastAPI spec (backend running) via
  `openapi-typescript`; an operational step, plus a CI gate diffing the committed
  client snapshot vs the backend. Deferred (needs the live backend + a codegen run).
- **M19 baseline seeding** — the gate is now fail-closed *once baselines exist*, but
  the baselines themselves must be generated on Linux CI and restored via
  `actions/cache` (committing Windows PNGs would fail on AA differences). Operational.
- **Restart backoff** (LOW) — already self-limited to one respawn / 7s; an
  exponential backoff would add struct churn across 3 construction sites for marginal
  value. Deferred.
- **Remaining LOW cosmetics** — light `--text-muted`==`--text-secondary` parity,
  `status-badge-danger` 4.03:1, analytics UTC/local day-keying off-by-one,
  `fsrsOptimizer` FSRS-4.5→6 comment drift, `playlists()` empty-shape swallow, the
  calibration/difficulty TABLE zero-attempt rows. All cosmetic/correctness-polish.

### Residual closure (R1–R4, 2026-06-20)
The residuals above were then worked down — only M14 + M16 remain (both need an
on-Windows runtime to verify; see rationale above):
- **R1** `55c944a` — LOW cosmetics: light `--text-muted` tier, `status-badge-danger`
  → `--danger` token, `fsrsOptimizer` FSRS-6 comments, calibration/difficulty TABLE
  zero-attempt rows dashed. (`playlists()` swallow + the timezone day-keying were
  judged genuinely-not-worth-it and left as-is, with rationale in the commit.)
- **R2** `291a7a6` — sidecar crash-loop **backoff** (exponential, 14s→5min; resets on
  recovery). cargo test 61 ✓.
- **R3** `a292839` — **M19** completed: `actions/cache` seeds/restores Linux visual
  baselines so the (already fail-closed) gate actually enforces.
- **R4** `d626fff` — **M18** completed: regenerated the typed client to the live
  226-path spec (was 185) + added the `--client` drift gate wired into CI + `gen:api`
  / `contract:check:client` scripts. tsc lsat 0; gate reports 226 covers 226.

**Open (verification-gated):** M14 (Windows Job Object kill-on-CRASH) and M16
(DATA-7 backend-path-matched relocation). Both compile-safe to add but their runtime
behaviour (kill-on-crash; not redirecting the data dir to an empty store) can only be
confirmed by running the packaged Tauri shell on Windows — out of scope for this
headless environment.
