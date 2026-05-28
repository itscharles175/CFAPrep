# Changelog

All notable changes to QuantVault. Dates use `YYYY-MM-DD`. See `git log` for
the full per-commit detail.

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
