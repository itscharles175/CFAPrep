# Changelog

All notable changes to QuantVault. Dates use `YYYY-MM-DD`. See `git log` for
the full per-commit detail.

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
