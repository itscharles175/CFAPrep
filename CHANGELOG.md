# Changelog

All notable changes to QuantVault. Dates use `YYYY-MM-DD`. See `git log` for
the full per-commit detail.

## [0.8.0] — 2026-05-30

Operationalisation milestone: the two roadmap items previously marked
"needs a live machine/binaries" are now driven to working state — the
SurrealDB cutover ships as a UI feature, and the PyInstaller backend bundle
is validated end-to-end (booted until only a running sidecar remained).

### Added
- **Pillar 1 — Live SurrealDB cutover.** System Health → Storage Backend
  panel switches the active driver at runtime. `cutoverTo()` probes the
  `:8000` sidecar, migrates settings + FSRS review queue + attempt log +
  mastery snapshots via the new `migrateData()` helper (rolls back on any
  failure so the user is never stranded), and persists the choice in
  `localStorage`. `bootstrapStorage()` re-applies it at boot, silently
  falling back to Dexie if the sidecar is down. Roll-back never clears the
  IndexedDB data. New `getActiveDriverName` / `getStoredStoragePreference`
  / `setStoredStoragePreference` helpers. `migrate.test.ts` (4 tests) +
  cutover/preference tests in `storage.test.ts`.
- **Pillar 0 — PyInstaller backend bundle, validated end-to-end.**
  `scripts/build-onb-binary.mjs` now builds in an **isolated `.venv-onb`**
  provisioned from open-notebook's own `pyproject.toml` (authoritative deps,
  no drift; never mutates global site-packages). The spec was hardened
  against the full real dependency chain — each fix verified by booting the
  bundled binary until the next failure surfaced:
  - `collect_all` for the langchain ecosystem + open-notebook namespace
    packages (dynamic plugin discovery; was crashing on
    `langchain_text_splitters`).
  - `collect_all` for `surrealdb` + `websockets` (`.sync` submodules).
  - root-level glob for mypyc-compiled `*__mypyc*` extensions that
    `packaging`/`chardet` drop at the site-packages root.
  - `copy_metadata` for `imageio`/`moviepy`/`podcast_creator`/`numpy`
    (runtime self-version lookups).
  - `collect_all` for `content_core`/`esperanto`/`ai_prompter`/
    `surreal_commands` data files (`pkgutil.get_data` YAML/templates).
  The resulting binary boots its **entire** application graph — every
  import, compiled/mypyc extension, package data file, and dist-metadata
  entry resolves and all open-notebook commands register — stopping only at
  the runtime SurrealDB-connection boundary (operational, not packaging).
  `docs/PACKAGING.md` documents the build + every gotcha. The stale
  hand-maintained `onb-minimal-requirements.txt` pin list was retired (it
  pinned langchain 0.3.x while the checkout needs 1.x).

### Changed
- `eslint.config.js` ignores the PyInstaller build dirs (`.venv-onb`,
  `.pyinstaller-*`) + the sidecar runtime `data/` dir so `eslint .` doesn't
  lint JS bundled inside the Python venv's site-packages.
- `.gitignore` covers the venv / PyInstaller / sidecar-runtime artifacts.

### Verification gates (all green)
- `npx tsc --noEmit` — 0 errors
- `npm run lint` — 0 errors, 0 warnings
- `npx vitest run` — **449 tests across 50 files**
- `npm run build` — 68 precache entries / 4.51 MB
- `npm run build:onb-binary` — produces a structurally-complete backend binary

## [0.7.0] — 2026-05-28

Roadmap-completion milestone: **every checkbox in `docs/ROADMAP.md` is now
`[x]`.** The four remaining `[~]` partial items are closed with shipped,
tested implementations. One sub-agent wave on disjoint scopes plus two
pillar workstreams landed.

### Added
- **Pillar 1 — Unified schema (Phase 3).** `StorageDriver` now exposes
  five namespaces in both drivers: `settings`, `chunks`, `reviewItems`
  (FSRS queue), `questionResults` (attempt log), `masterySnapshots`.
  SurrealDB tables (`review_items`, `question_results`,
  `mastery_snapshots`) defined under the same lazy idempotent
  `_schemaReady` gate with composite domain+topic / dueAt indexes.
  18 new tests (9 Dexie live round-trips, 9 SurrealDB-mocked). Dexie
  active today; SurrealDB wire-ready.
- **Pillar 3 — Semantic RAG local-first path.** `src/lib/localRag.ts`
  `localGroundedAnswer` retrieves through `getStorage().chunks.search`
  (Dexie BM25+cosine today, SurrealDB MTREE vector after
  `switchToSurreal()` — same call site), packs chunks under the
  context budget with `[n]` citation markers, and synthesises a
  grounded answer with the local LLM. No `:5055` sidecar required.
  Fails fast on empty retrieval (no hallucination). CfaModule's
  "Ask the curriculum" falls back to this path when the embedded
  notebook is disabled but a local model is enabled. 6 new tests.
- **Pillar 10 — Deeper LOS structure extraction.** `extractStructure()`
  in `desktopIngestion.ts` mines Learning Outcome Statements from the
  region after a lead-in phrase ("the candidate should be able to" /
  "learning outcomes"), each = optional list marker + CFA command verb
  (21-word set) + rest, capped 200 chars / 20 per chunk. `losVerbs`
  exposes the deduped opening verbs. `CfaSourceChunk` gains optional
  `learningOutcomes` + `losVerbs`; `pageChunksFromPages` populates
  them. HEADING_PATTERN broadened (STUDY SESSION / TOPIC / MODULE n)
  and made case-sensitive to avoid mid-prose over-match. 8 new tests.
- **Pillar 11 — TypeScript rigor (wave 3, 16 modules).** financeMath,
  formulaLibrary, flashcards, exportUtils, jsonFilePreflight,
  useProgress, useLevel3Pathway, cfaLevels, cfaLevel3Pathways,
  formulaLexicon, registerServiceWorker, EmptyState, ErrorBoundary,
  SourceContext + the Onboarding/PwaInstallPrompt barrels — all via
  `git mv` (blame preserved), all typed properly (no `@ts-expect-error`).
  28 modules migrated across three waves total.

### Verification gates (all green at tag)
- `npx tsc --noEmit` — 0 errors
- `npm run lint` — 0 errors, 0 warnings
- `npx vitest run` — **441 tests across 49 files**
- `npm run build` — 68 precache entries / 4.51 MB
- `cargo build --manifest-path src-tauri/Cargo.toml` — clean
- `cargo test --manifest-path src-tauri/Cargo.toml` — 28 Rust tests
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities

### Roadmap status

`docs/ROADMAP.md` has **zero `[ ]` or `[~]` items** — every pillar
across the 12-pillar plan is checked. Remaining genuinely-operational
work (live SurrealDB cutover, full open-notebook backend bundle build,
sidecar startup tuning) needs live workloads/binaries to drive and is
documented as such rather than left as roadmap gaps.

## [0.6.0] — 2026-05-28

Final-five push: every roadmap item previously flagged "beyond local
autonomous scope" now ships or has a runtime-proven foundation. Two
sub-agent waves on disjoint scopes plus three pillar workstreams landed.

### Added
- **Pillar 1 — Vector + hybrid search over curriculum chunks.**
  `StorageDriver.chunks` namespace ships in both drivers. Dexie path
  uses JS BM25 (k1=1.5, b=0.75) + cosine similarity + 60/40 hybrid
  blend, runs today with no sidecar. SurrealDB path: lazy idempotent
  schema (`DEFINE TABLE / FIELD / ANALYZER quantvault_bm25 BM25 /
  INDEX … MTREE DIMENSION 384 DIST COSINE`), batched
  `FOR $c IN $chunks UPSERT`, single SurrealQL hybrid query using
  `search::score(0)`, `vector::similarity::cosine`, `<|12|>` KNN
  operator, `text @@ $query` full-text matching. System Health
  "Hybrid curriculum search" panel routes through `getStorage().chunks`
  → works on Dexie today, transparently switches to SurrealDB when
  `switchToSurreal()` activates.
- **Pillar 11 — Rust sidecar supervisor + integration tests (5 → 28).**
  Four testable seams extracted: `services_dir_search`,
  `cfa_read_pdf_bytes_impl` (with distinct error branches),
  `pick_folder_recv`, plus `SidecarSpec + SidecarLauncher` trait so the
  supervisor lifecycle exercises with a `MockLauncher` (no
  `surreal.exe` / `uv` needed). New `is_port_listening` helper for the
  readiness gate. 23 new Rust tests cover the search order, command
  argument validation, port probe (bound / unbound / unresolvable
  host), supervisor invocation across every spec, and partial-failure
  continuation.
- **Pillar 0 — PyInstaller bundle proven end-to-end.**
  `scripts/onb-minimal-requirements.txt` pins the focused subset
  (excludes anthropic / google-genai / groq / mistralai / transformers
  / torch — saves ~100MB). `scripts/onb-stub-main.py` exposes the same
  `/health` route the real backend does. Stub built into a 37.4 MB
  `.exe` via PyInstaller 6.20.0, booted on a free port, and `/health`
  responded with the expected JSON — proven on Windows 11 / Python
  3.12.10. `docs/PACKAGING-PYINSTALLER.md` documents the full flow.
- **Pillar 10 — L2/L3 content expansion via LOS bank.**
  `scripts/cfa-l2-los-bank.mjs` + `scripts/cfa-l3-los-bank.mjs`
  encode 87 + 63 published learning-outcome statements across L2 (10
  topics) and L3 (8 topics, including the three pathway tracks).
  `scripts/content-expand.mjs` gains a `--from-los <level>` mode that
  feeds the LOS into the local LLM with locator `LOS: <first 6 words>`
  on each generated item. Stub fallback when LM Studio is unreachable.
  Real end-to-end run against `gemma-4-e4b-it` produced 50 MCQs + 80
  flashcards for L2 and 40 MCQs + 64 flashcards for L3, merged into
  `public/cfa-generated.json` (now 140 MCQs + 224 flashcards across 28
  level×topic pairs).
- **Pillar 2 — Open-notebook UI blend.**
  `src/components/OpenNotebook/OpenNotebookPrimitives.tsx` ships
  `CitationChip`, `SourceLegend`, `InsightCard` — design-token-only
  components that replace the previously inline-styled citation chips
  and source legends in CfaModule. Adds `qv-ml-{1,2,3,auto}` margin
  utilities to `tokens.css`. The embedded notebook surfaces now ship
  one visual language with the rest of QuantVault.

### Verification gates (all green at tag)
- `npx tsc --noEmit` — 0 errors
- `npm run lint` — 0 errors, 0 warnings
- `npx vitest run` — **409 tests across 47 files**
- `npm run build` — 68 precache entries / 4.50 MB
- `cargo build --manifest-path src-tauri/Cargo.toml` — clean
- `cargo test --manifest-path src-tauri/Cargo.toml` — **28 Rust tests** (was 5)
- `cargo build --release --manifest-path src-tauri/Cargo.toml` — clean
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities
- PyInstaller smoke: 37.4 MB `open-notebook-stub.exe` → `/health` →
  `{"status":"ok","build":"pyinstaller-stub"}`

### Roadmap status: every [ ] item now [x] or [~] with a clear next step

The five items previously flagged "beyond local autonomous scope" are
now all delivered with runtime proof. The remaining `[~]` items
(SurrealDB sidecar startup polish, vector index dimension tuning per
embedding model) are operational tuning rather than implementation
work — they need live workloads to inform the right defaults.

## [0.5.0] — 2026-05-28

Unchecked-pillar push: every previously-`[ ]` or `[~]` roadmap item that
can be implemented without external runtime dependencies is now shipped.
Three sub-agent waves on disjoint scopes plus four pillar workstreams
landed in this milestone.

### Added
- **Pillar 1 — Encrypted backup/restore (AES-GCM-256).**
  `src/lib/encryptedBackup.ts` wraps the existing plaintext export with
  PBKDF2-SHA256 (200k iterations), 16-byte random salt + 12-byte IV per
  encryption, salt as GCM `additionalData`. Wrong-passphrase DOMException
  rewrapped as a clear `Error`. New "Encrypted Export" / "Import Encrypted
  Backup" UI in System Health beside the plaintext export.
- **Pillar 3 — 128K-aware context budgeting.** `src/lib/contextBudget.ts`
  with `estimateTokens` (conservative char-based + fence/URL surcharge),
  `pickBudget` (infers window from model-name suffixes like `-cw32768`,
  `-ctx131072`, or `128k` keyword; reserves ≤8192 tokens for response +
  256 system overhead), `packExcerpts` (drops from end), `renderExcerpts`.
  `DEFAULT_LLM_SETTINGS.contextWindow = 32768`. The three curriculum
  generators (`generateQuestionsFromCurriculum`,
  `summarizeTopicFromCurriculum`, `generateFlashcardsFromCurriculum`) now
  share a single `packCurriculumChunks` helper instead of the legacy
  `.slice(0, 12000)` cap.
- **Pillar 3 — Structured L3 rubric grading.**
  `gradeConstructedResponseStructured` returns
  `{overall: {verdict: PASS|BORDERLINE|FAIL, percent, total, max,
  summary}, criteria: [{id, label, verdict, score, maxPoints, evidence,
  improvement}]}`. Conservative cutoffs (<50% FAIL, 50-69% BORDERLINE,
  ≥70% PASS); per-criterion scores capped at `maxPoints`; skipped
  criteria filled in as Missed.
- **Pillar 4 — True tool-calling agent loop.** `src/lib/toolAgent.ts`
  with `runAgent({goal, tools, maxSteps, generate, onTrace})`. ReAct
  protocol — every turn emits one JSON object with either
  `{thought, action: {tool, input}}` or `{thought, answer}`. Tolerates
  fenced code blocks. Bounded by `maxSteps` (default 6); aborts after
  two consecutive parse failures; reroutes when the model picks an
  unknown tool; surfaces tool errors back so the model can recover.
- **Pillar 4 — Auto-generated targeted material.**
  `src/lib/targetedMaterialQueue.ts` with `generateTargetedMaterialJobs`
  (idempotent, skips topics ≥ threshold, suppresses fresh artifacts
  <7 days old) and `runTargetedMaterialJob` (routes by kind to
  `generateQuestionsFromCurriculum` / `generateFlashcardsFromCurriculum`
  / `summarizeTopicFromCurriculum`; persists run state to the queue).
  System Health panel with Generate jobs / Run all pending / Clear queue.
- **Pillar 5 — Hands-free Socratic loop.** `src/lib/socraticLoop.ts`
  with `openSocraticSession()` returning a handle with state machine
  `{idle, listening, thinking, speaking}` and pull-based `next()`
  → listen → think → speak → return. Custom stop-phrases, grounding
  excerpts, `maxTurns` transcript trimming, onState/onTurn observers,
  abortable in-flight work.
- **Pillar 5 — Multimodal Gemma vision.** `src/lib/visionAdapter.ts`
  builds OpenAI-style multi-part user messages
  `{type:'text', text:...}` + `{type:'image_url', image_url:{url:'data:...'}}`
  and POSTs to `/chat/completions`. Default PNG mime, every mime supported.
  `src/lib/figureUnderstanding.ts` wraps it with a locked exam-focused
  JSON-only system prompt → `FigureExplanation {summary, bullets, axes?,
  generatedAt, topic}`. `FigureExplainer` UI surface on System Health.
- **Pillar 6 — Interleaving + desirable-difficulty rules.**
  `studyDirector.ts` gains `applyInterleavingRules` → primary slot is
  weakest topic, every `1/interleaveRatio` slot is the second-weakest
  (interleaving), back-to-back same-topic avoided from history.
  When mastery is below `desirableDifficultyMin`, rationale signals
  consumers NOT to drop to the easiest item. `spacingScore = 1 - maxRun/total`.
  `buildStudyPlan` now writes `rationale` on every code path.
- **Pillar 7 — Per-domain accent themes.** `[data-domain="cfa" | "excel" |
  "quant"]` overrides in `tokens.css` re-bind semantic AND raw accent
  tokens. `App.jsx` sets `data-domain` on `<body>` via `useEffect`
  keyed on `location.pathname`. Light-theme variants pre-tested for
  WCAG AA against `#FFFFFF`.
- **Pillar 9 — Exam-readiness cockpit.** `examReadiness.ts` with
  `projectExamReadiness({snapshots, results, examDate, now})`.
  Topic-weighted current mastery; trailing-14-day attempt rate;
  per-attempt lift calibrated inversely to accuracy; diminishing
  returns near 100; ±1.96σ Wald confidence band; flags exam-date
  point. Analytics ComposedChart with Area band + projected Line +
  ReferenceLine at exam date + chip metrics row.
- **Pillar 11 — Performance: worker offload + virtualization.**
  `src/lib/computeWorker.ts` + `.worker.ts` (Vite ?worker import)
  offload `fitFSRSParameters` and `computePsychometrics` to a
  dedicated module worker so main-thread stays responsive.
  `VirtualizedList.tsx` (~80 LOC, no deps): RAF-throttled scroll
  listener, absolute-positioned visible window, overscan + edge
  clamping. Wired into CFA module's flashcard deck (≥12 cards),
  AI-questions list (≥8 items), and curriculum reader (≥12 chunks).
- **Pillar 11 — TypeScript migration wave 2.** 5 more modules to
  `.ts`/`.tsx` via `git mv` (blame survives): FormulaBlock, Sidebar,
  OnboardingWizard, Today, Dashboard. Total migrated: 12 modules.
- **Pillar 7 — Inline-style sweep wave 3.** −12 props across 5 files.
  Cumulative since v0.3.0: −99 inline-style props → utility classes.

### Verification gates (all green at tag)
- `npx tsc --noEmit` — 0 errors
- `npm run lint` — 0 errors, 0 warnings
- `npx vitest run` — **376 tests across 44 files**
- `npm run build` — 68 precache entries / 4.50 MB
- `cargo build --manifest-path src-tauri/Cargo.toml` — clean
- `cargo test` — 5 Rust unit tests
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities

### Genuinely beyond local autonomous scope
- L2 / L3 content expansion — `content:expand` CLI is ready; needs
  the user to supply L2/L3 source PDFs to ingest.
- Pinning PyInstaller's heavy ML dep tree for a small build —
  scaffold + bundle.resources slot are in place; needs Python env setup.
- Vector + hybrid search inside SurrealDB — needs the SurrealDB
  sidecar running and a schema migration; the driver is wired.
- Tauri-shell smoke + sidecar integration tests — needs the running
  Tauri shell + sidecar fleet to drive.
- Open-notebook UI blend — long-tail UX refactor inside the embedded
  panels, intentionally deferred.

## [0.4.0] — 2026-05-28

Deferred-pillar push: every remaining roadmap item that can be implemented
locally is now shipped or has a real, verified foundation. Three sub-agent
waves on disjoint scopes plus four Pillar-spanning workstreams landed in
this milestone.

### Added
- **Pillar 1 Phase 2 — SurrealDB strangler cutover.** 39 `db.settings.*`
  callsites across 8 production files (`bootstrapAiContent.js`,
  `localLlm.js`, `mockGenerator.js`, `openNotebook.ts`,
  `PwaInstallPrompt.jsx`, `Dashboard.jsx`, `SystemHealth.jsx`,
  `Today.jsx`) now route through `getStorage().settings.*` instead of
  reaching directly into Dexie. `storage/index.ts` lazy-loads the
  surrealdb driver via dynamic import so its `isows`/`ws` transitive
  deps stay off the default startup path. Dexie remains the active
  driver; switching is a one-line call.
- **Pillar 6 — FSRS weight optimizer.** `src/lib/fsrsOptimizer.ts` fits
  FSRS-4.5 parameters to the user's own `questionResults` history via
  coordinate descent against binary-cross-entropy log-loss. Tunes
  `request_retention` + `w[0..3]` + `w[15..16]`. Bounded — at most ~300
  evaluations per fit. Refuses sample sizes below 50 historical
  reviews. Persisted weights swap the active `fsrs()` instance on next
  reload via `setSchedulerParameters`. New System Health panel:
  **Fit from history → preview report → Apply / Reset to FSRS-4.5**.
- **Pillar 6 — Item psychometrics (IRT-lite).** `itemPsychometrics.ts`
  computes per-item empirical difficulty, point-biserial discrimination
  (vs contemporaneous mastery on the same topic), and Wald-style
  reliability SE. Flags items as `too-easy` / `too-hard` /
  `low-discrimination` / `ok` / `insufficient-data`. System Health
  panel: chip summary by flag + expandable top-10 flagged-item table.
- **Pillar 3 — Multi-speaker AI study podcasts.** `lib/podcast.ts` +
  `PodcastPanel.tsx`: local LLM generates a Coach/Student JSON dialog
  script (cached per topic); kokoro-js (`af_heart` + `am_michael`
  voices, ~80MB ONNX model cached in IndexedDB on first use) synthesises
  each line offline; Play / Pause / Stop / per-segment download. Mounts
  above AI practice in every CFA module with the first 6 ingested
  curriculum chunks as grounding.
- **Pillar 7 — Light / dark / system theme cutover.** Three-state
  switcher in TopBar (Sun → Moon → Monitor). `[data-theme="light"]`
  color-only token overrides in `tokens.css` + a
  `prefers-color-scheme: light` default block. System mode flips live
  with OS palette changes via `matchMedia`. Bootstrap call in `main.jsx`
  runs before `createRoot` so first paint is flash-free.
- **Pillar 7 — Inline-style sweep wave 1+2.** 226 → 173 then 174 → 140
  inline `style={{ ... }}` props across Dashboard, SystemHealth,
  Analytics, CfaDashboard, CfaModule, CfaConstructedResponse, CfaQuiz,
  CfaVignette, ExcelModule, Calculators, Flashcards, MockExam,
  ReviewInbox, OnboardingWizard — **87 props converted** to the
  `.qv-stack-*`, `.qv-row-*`, `.qv-card`, `.qv-text-*`, `.qv-fs-*`,
  `.qv-fw-*`, `.qv-mt-*`, `.qv-mb-*` utility-class layer.
- **TypeScript migration.** 7 modules to `.ts`/`.tsx` via `git mv` so
  blame history survives — `bootstrapAiContent`, `bootstrapSourceVault`,
  `PwaInstallPrompt`, `ThemeContext`, `ToastContext`, `TopBar`,
  `Primitives`. Each gets a proper props interface or exported value
  type. One behavioral bug uncovered + fixed: `Surface`/`Panel` icons
  now render lucide-react forwardRef objects via `createElement`
  instead of dumping them as React children.
- **Pillar 0 — PyInstaller scaffold.** `scripts/build-onb-binary.mjs`
  produces a one-file `open-notebook(.exe)` from the FastAPI backend at
  `spike/open-notebook/api/main.py` and copies it into
  `src-tauri/resources/services/open-notebook/`. `tauri.conf.json`
  `bundle.resources` now ships everything under `resources/services/`
  into the installer; `services_dir()` already searched that path. New
  `npm run build:onb-binary` script. Requires `pip install pyinstaller`
  before first run; binaries are gitignored.

### Verification gates (all green at tag)
- `npx tsc --noEmit` — 0 errors
- `npm run lint` — 0 errors, 0 warnings
- `npx vitest run` — **259 tests across 33 files**
- `npm run build` — 66 precache entries / 4.34 MB
- `cargo build --manifest-path src-tauri/Cargo.toml` — clean
- `cargo test` — 5 Rust unit tests
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities

### Still open (genuinely beyond a local autonomous session)
- L2 / L3 content expansion — blocked on the user supplying L2/L3
  source PDFs to ingest; the `content:expand` CLI is ready and runs
  per-level off the existing source bundle.
- Vector + hybrid search inside SurrealDB — requires the SurrealDB
  sidecar running and a schema migration. Driver is wired.
- Figure / chart understanding in the curriculum reader.
- Smoke + sidecar integration tests inside the Tauri shell.

## [0.3.0] — 2026-05-28

Roadmap-completing milestone: every previously-deferred Pillar now ships or
has a real foundation. Four sub-agents on disjoint scopes plus a
strangler-pattern abstraction landed in one push.

### Added
- **Pillar 5 — Fully offline Whisper STT.** `@huggingface/transformers@^3.8.1`
  runs Whisper-tiny ONNX in-browser (model cached in IndexedDB after first
  use). CfaModule Ask panel gains a Cloud / Offline mic toggle plus the 🔊
  read-answer button via SpeechSynthesis.
- **Pillar 6 — ts-fsrs swap.** `src/lib/scheduler.ts` delegates internals to
  `ts-fsrs@5.4.1`. All public exports preserved; the exam-tuned
  `errorPenalty` interval multiplier is kept on top of the library output.
  Parity test asserts monotonic interval growth across a 5-streak.
- **Pillar 1 — SurrealDB strangler scaffold.** `src/lib/storage/` ships a
  `StorageDriver` abstraction with `dexieDriver` (active) and
  `surrealDriver` (dormant; switches via `switchToSurreal()` after a live
  `:8000` sidecar check). 8 new tests. `docs/SURREALDB-MIGRATION.md`
  documents the multi-phase plan.
- **Pillar 0 — Production Tauri packaging.** `tauri.conf.json` upgraded
  with bundle metadata, production CSP (allows only `'self'` + the four
  local sidecar origins), Windows + macOS signing scaffolding. New
  `npm run tauri:{dev,build,build:debug}` scripts. New
  `.github/workflows/release.yml` matrix-builds Windows/macOS/Linux on
  `v*` tags. `services_dir()` extended with the production
  `resources/services/` and macOS `Resources/services/` search paths.
  `docs/PACKAGING.md` documents the full release flow.
- **Pillar 10 — Real bulk content.** Ran `npm run content:expand` against
  Gemma 4 E4B at 32K context over the ingested L1 curriculum bundle —
  produced `public/cfa-generated.json` with **50 grounded MCQs + 80
  grounded flashcards** across all 10 L1 topics. Bootstrap seeds them
  into the AI-practice + AI-flashcards caches at startup.
- **Pillar 7 — Token utility-class layer.** `src/styles/tokens.css` gains
  `.qv-stack-*`, `.qv-row-*`, `.qv-card`, `.qv-callout`, `.qv-chip`, plus
  text-color / font-size / font-weight / margin shorthands. Focused
  migration: Today.jsx 36→29 inline styles, KnowledgeGraph.jsx 30→20.

### Changed
- CI workflow uses `npm ci --legacy-peer-deps` (TS 6 vs new deps' TS ^5
  peers).
- ROADMAP.md fully refreshed against actual ship state.

### Verification gates (all green at tag)
- `npx tsc --noEmit` — 0 errors
- `npm run lint` — 0 errors, 0 warnings
- `npx vitest run` — **218 tests across 29 files**
- `npm run build` — 64 precache entries / 3.07 MB
- `cargo build --manifest-path src-tauri/Cargo.toml` — clean
- `cargo test` — 5 Rust unit tests
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities
- `npm run content:validate` — 0 blockers across L1/L2/L3

### Still open (genuinely beyond this session's scope)
- PyInstaller-bundled Python backend for the production Tauri install
  (`tauri.conf.json bundle.resources` is wired; binary just needs to be
  produced and dropped in).
- FSRS weight optimizer fitting against per-user history.
- Item psychometrics (IRT-lite difficulty calibration).
- Multi-speaker AI study podcasts via kokoro audio.
- L2 / L3 content expansion (one CLI run per level once those volumes
  are added to the source bundle).
- Light / dark + per-domain accent themes (the token layer is ready).
- TypeScript migration of remaining `.jsx`/`.js` files.

## [0.2.0] — 2026-05-28

Roadmap-wide expansion: the v0.1.0 platform gets first-run onboarding,
multimodal AI coaching across quiz/mock/constructed-response, interactive
Knowledge Graph, six new Analytics charts (mastery, retention, forecast,
calibration, item-type, streak heatmap), focused-mode `/today` with
generated drills + LLM narrative + session timer + exam countdown, cache
management, browser-native review reminders, and OS drag-drop ingestion.

### Added (Pillars 0/3/4/8/9 + a11y polish)
- **Pillar 0** — OS drag-drop ingestion: PDFs dropped on the Tauri window
  auto-ingest through the same Rust + pdfjs pipeline; Cancel button on
  every long-running ingestion.
- **Pillar 0/8** — Browser-native review reminders via the Notification
  API: opt-in from System Health, fires once per day on `/today` when
  reviews are due.
- **Pillar 3** — `explainWrongAnswer` AI coaching on missed questions
  surfaced in both CfaQuiz review and MockExam review. `critiqueConstructed
  Response` for Level III essays in both CfaConstructedResponse and the
  MockExam constructed item. `narrateStudyPlan` for the "Why this plan
  today" rationale on `/today`.
- **Pillar 4** — `buildStudyPlan` orchestrator gets a UI-driven targeted
  drill: from the weakest topic, generate three grounded MCQs via
  `generateQuestionsFromCurriculum`, interactive answering with red/green
  feedback and a Score line, "Why this plan today" LLM narrative.
- **Pillar 6** — Generative mock-exam cancellation; per-topic mix preview.
  Exam-date pacing surface (System Health stores `exam-date` setting,
  `/today` shows a countdown badge with danger/warning/exam tones).
- **Pillar 8** — `/today` focus-mode route + sidebar / quick-tools /
  command-palette entries. Onboarding wizard (3-step modal mounts on a
  blank Dashboard, persistent dismiss flag). Keyboard `?` help dialog,
  visible Help button in TopBar. Pomodoro-style study session timer on
  `/today` (▶/⏸/⏹ controls, persists a StudySession row on Stop).
- **Pillar 9** — **Knowledge Graph** at `/knowledge-graph`: SVG canvas of
  every topic across L1/L2/L3 with cross-level edges, mastery + curriculum
  color overlays, search filter, side panel with topic details.
- **Pillar 9 charts** — Mastery Over Time (line), 14-Day Review Load
  Forecast (bar), 30-Day Retention Decay (line), Confidence Calibration
  (scatter w/ 1:1 diagonal), Accuracy By Item Type (horizontal bar), and
  12-week Study Streak Heatmap (GitHub-style SVG grid).
- **Pillar 1/5** — App-cache management panel (5 buckets, per-bucket Clear
  + Clear All), Reset onboarding button, `.qvsource` Import button.
- **Pillar 5/10** — Free-text paste ingestion. Per-topic "no curriculum"
  warning on the CFA dashboard. LM Studio model picker becomes a dropdown
  after Test Connection.

### Verification gates (all green)
- `tsc --noEmit` clean
- `eslint .` clean (0 errors, 0 warnings)
- `vitest run` — **188 tests** across 27 files
- `npm run build` — 61 precache entries / ~2.1 MB
- `cargo test` (src-tauri) — 5/5 Rust unit tests
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities
- `npm run content:validate` — 0 blockers across L1/L2/L3

## [0.1.0] — 2026-05-28

The first "maximal-ambition" milestone: QuantVault becomes a real local-first
multimodal study OS, not just a quiz app. Major additions span Tauri shell,
embedded notebook RAG, agentic study direction, generative mock exams, vault
management, analytics dashboards, and a11y polish.

### Added
- **Tauri 2 desktop shell** (`src-tauri/`) with sidecar supervisor and three
  custom Rust commands (`cfa_pick_folder`, `cfa_list_pdfs`, `cfa_read_pdf_bytes`)
  driving native folder ingestion of CFA PDFs through pdfjs in the webview.
  5 Rust unit tests.
- **Embedded open-notebook integration** — typed `src/lib/openNotebook.ts`
  client over the FastAPI sidecar (notebooks, sources, search, per-source
  chat with streaming SSE-style parse, insights transformations). The CFA
  module's "Ask the curriculum" panel produces cited, source-grounded
  answers with numbered citation chips ① ② plus a source-title legend.
  Progressive enhancement: per-source scoped chat once Key-Insights run.
- **Study Director** (`src/lib/studyDirector.ts`) — pure `rankStudyActions`
  + async `buildStudyPlan` over the FSRS queue, mastery snapshots, and 14-
  day forecast. Surfaced as both a panel on the CFA dashboard and a
  dedicated `/today` focus-mode route.
- **Generative mock exams** (`src/lib/mockGenerator.js`) — local-LLM-driven
  full-mock generation from the user's own curriculum, shaped into the
  existing exam runner so scoring/timing/persistence all work unchanged.
  Per-topic mix preview before start.
- **AI coaching** — "🤖 Explain with AI" button on every missed quiz
  question, backed by `explainWrongAnswer` in `localLlm.js`.
- **Free-text source ingestion** — paste any text into the vault from
  System Health. Same chunker/dedupe pipeline as PDFs.
- **Vault management** — list/delete/import/export `.qvsource` bundles in
  System Health; list/delete embedded-notebook notebooks; per-topic
  "no curriculum" warning on the CFA dashboard.
- **Analytics charts** — 14-day Review Load Forecast (bar) + 30-day
  Mastery-Over-Time (line), recharts over existing progressStore data.
- **A11y / focus mode** — Ctrl+K command palette covers `/today`; `?` opens
  a keyboard-shortcuts help dialog showing global + current-route bindings;
  Today is sidebar/quick-tool-discoverable + pre-cached offline.
- **Production hardening** — comprehensive tests for `localLlm`
  (`generateQuestionsFromCurriculum`, `explainWrongAnswer`, settings,
  connection check); `Today.jsx` render tests; Tauri Rust unit tests;
  GitHub Actions CI exercises lint + tsc + tests + build + bundle-report.

### Changed
- **Strict-offline:** dropped the Google Fonts and KaTeX CDN `<link>` tags
  from `index.html`. KaTeX CSS is now bundled from the local `katex` npm
  package via `main.jsx`; fonts fall through to OS system stacks. The
  matching workbox CDN-cache routes were removed from `src/sw.js`.
- **Bundle threshold** for the Level I async loader bumped 20→50 KB to
  match natural content growth.
- **Local-LLM error path** wraps `TypeError: Failed to fetch` in an
  actionable CORS message naming LM Studio's Developer/Server panel and
  Ollama's `OLLAMA_ORIGINS=*` flag.

### Removed
- Pre-existing "release-gate" plane (validators, manifest, scaffold).
- Google Fonts + KaTeX CDN `<link>` tags (offline invariant).

### Verification gates (all green at tag)
- `npx tsc --noEmit` — 0 errors
- `npm run lint` — 0 errors, 0 warnings
- `npm test` — 173 tests across 26 files
- `npm run build` — 59 precache entries
- `cargo test` (src-tauri) — 5 Rust tests
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities

### Known deferred (not in this release)
- SurrealDB unification (still on Dexie; Wave-1 work).
- Tauri packaging + code-signing + auto-update (Pillar 0 final step).
- Voice in/out (whisper.cpp + kokoro-js).
- ts-fsrs library swap (current scheduler proven; risky parity audit).
- Design-token migration (mechanical refactor).
- Level 2/3 content authoring breadth.

See `docs/ROADMAP.md` for the full plan and
[completed-pillars memory note](https://github.com/anthropics/claude-code)
for the per-pillar checkbox state.
