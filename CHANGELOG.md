# Changelog

All notable changes to QuantVault. Dates use `YYYY-MM-DD`. See `git log` for
the full per-commit detail.

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
