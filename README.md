# StudyVault

A **local-first, fully offline** study OS - desktop (Electron) and PWA - bundling
two exam-prep domains in one window: **CFA / Quant / Excel** (the original
QuantVault host) and **LSAT** (vendored from LSAT Lab). It turns your own
curriculum PDFs into a multimodal study OS — spaced repetition, generative mock
exams, grounded-RAG answering with citations, an agentic Study Director, and
analytics — plus the LSAT domain's question bank, timed sections, blind review,
and adaptive drills. All on your machine, no cloud, no account, no API keys.

> New here? Read **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the
> two-apps-one-window design and **[docs/LSAT-INTEGRATION.md](docs/LSAT-INTEGRATION.md)**
> for how the LSAT domain is embedded. Current implementation and release
> evidence is tracked in
> **[docs/STUDYVAULT-1.0-IMPLEMENTATION-LEDGER.md](docs/STUDYVAULT-1.0-IMPLEMENTATION-LEDGER.md)**.

## Stack

| Layer              | What                                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Desktop shell**  | Electron 43 with a sandboxed renderer, typed preload bridge, secure custom protocol, and main-process sidecar supervisor                                              |
| **Domains**        | Host (CFA/Quant/Excel) at `/`, LSAT at `/lsat` — one Vite bundle and one top-level router; see [ARCHITECTURE.md](docs/ARCHITECTURE.md)                                |
| **Local storage**  | Dexie / IndexedDB for host study data, SQLite for LSAT, and an optional SurrealDB cutover path                                                                        |
| **Notebook + RAG** | Embedded open-notebook (FastAPI on :5055, worker, transformations)                                                                                                    |
| **Local model**    | LM Studio first, with Ollama compatibility; both use local OpenAI-compatible chat and embedding endpoints. No specific model is required or downloaded automatically. |
| **Frontend**       | React 19 + Vite 8 + react-router-dom 7 + recharts/@visx + lucide-react + pdfjs-dist; Geist/Newsreader fonts; vite-plugin-pwa for offline service-worker               |

## Implemented surfaces

The following surfaces are present in the source tree. This is an implementation
inventory, not a claim that the StudyVault 1.0 acceptance matrix is green; use
the [implementation ledger](docs/STUDYVAULT-1.0-IMPLEMENTATION-LEDGER.md) for
verified, current, pending, and blocked status.

**Source ingestion** — three paths into the same `db.sourceDocuments` /
`db.sourceChunks` Dexie tables, all dedupe by SHA-256:

- Bundled `.qvsource` import (`scripts/cfa-source-vault.mjs ingest`).
- **Electron-native folder picker** for PDF folders (capability-scoped preload
  bridge + browser-side
  pdfjs extraction + the proven page-aware chunker).
- **Free-text paste** (System Health → Paste a source).

**Grounded answers** (Pillar 2) — every CFA topic has an "Ask the curriculum"
panel that creates a per-topic notebook on the embedded backend (lazy,
idempotent), seeds it with the whole topic's curriculum chunks, runs
open-notebook's RAG synthesis, and renders the answer with **numbered
citation chips** (①, ②) plus a source-title legend. Answers cache per topic
so they survive navigation; the Q&A can be **saved to the lesson note** with
a click. Progressive enhancement: per-source chat (truly scoped) kicks in
once `ensureSourceInsights` runs the "Key Insights" transformation in the
background.

**Generative mock exams** (Pillar 6) — for any level, generates a full mock
from the user's own ingested curriculum via the local LLM, shapes the
result into the existing exam runner's content so scoring/timing/persistence
all work unchanged. Per-level blueprint (`MOCK_BLUEPRINTS`), per-topic mix
displayed before start, mock-attempt analytics recorded. CORS errors made
actionable in the UI.

**Study Director** (Pillar 3/4) — pure `rankStudyActions` + async
`buildStudyPlan` over the FSRS queue, weak-topic mastery, and the 14-day
forecast. Surfaced as a panel on the CFA dashboard _and_ as the dedicated
`/today` focus-mode landing (hero card for the top action + then-list).

**AI coaching** (Pillar 3) — on every missed quiz question, an "🤖 Explain
with AI" button calls the local model with the question, options, correct and
picked indices, then renders a personalized 3-5 sentence explanation below the
static explanation. The error path includes the same CORS guidance.

**Vault management** (Pillar 1/5) — System Health surfaces the embedded
backend's notebooks (list/delete) and the local source vault
(list/delete/export-as-.qvsource/import-from-.qvsource) so the full pipeline
is manageable from inside the app.

**Analytics** (Pillar 9) — 14-day review-load forecast bar chart and a
30-day Mastery-Over-Time line chart on `/analytics`, both recharts over the
existing progressStore data.

**Keyboard + a11y** (Pillar 8) — Ctrl+K command palette over every route,
tool, and command in `routeManifest.ts`; `?` opens a keyboard-shortcuts help
dialog showing global + current-route bindings; `/today` is pre-cached for
offline use; the empty-vault Dashboard banner links straight to ingestion.

## Verify everything

```bash
npm run verify              # host lint/tests + Electron tests + production build
npm run verify:all          # adds LSAT typecheck and frontend tests
npm run check:docs          # architecture/documentation drift
npm run electron:build:dir  # unpacked Electron app
npm run electron:build      # platform installers
```

The Electron tests use Node's test runner through `npm run test:electron`; they
are intentionally excluded from the host Vitest project. Backend, content,
contract, restore, accessibility, visual, packaging, and mutation acceptance
remain separate gates in the implementation ledger.

## Run dev

Web-only dev (no native folder picker or supervised sidecars):

```bash
npm run dev
# → http://localhost:5173
```

Desktop dev (Electron auto-supervises the sidecars):

```bash
npm run electron:dev
```

Note: stop any spike servers on `:8000`, `:5055`, and `:8100` first. Electron
never kills an unknown listener; it blocks the affected sidecar and reports the
conflict. See `docs/SPIKE-FINDINGS.md`.

## Local model setup

- **LM Studio** (recommended): serve a compatible local model on
  `http://localhost:1234/v1`. Choose a context window appropriate for the model
  and study task. Enable CORS in Developer/Server panel for browser-based
  development. Electron uses the explicit `app://studyvault` origin and the
  same backend CORS policy.
- **Ollama**: expose its OpenAI-compatible endpoint on
  `http://localhost:11434/v1`; for browser development, allow the local Vite
  origin in Ollama's origin configuration.

Configure both URLs in System Health → Local AI / Embedded Notebook.

## Docs

- [`docs/STUDYVAULT-1.0-IMPLEMENTATION-LEDGER.md`](docs/STUDYVAULT-1.0-IMPLEMENTATION-LEDGER.md) — current implementation and acceptance evidence.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — current finish-line sequence and release gates.
- [`docs/SPIKE-FINDINGS.md`](docs/SPIKE-FINDINGS.md) — sidecar repro + the
  known gotchas (SurrealDB v2 not v3; PYTHONUTF8=1; LM Studio context).

## Privacy / offline invariant

- No cloud, no telemetry, no CDNs.
- All sidecars run on `127.0.0.1`.
- The Electron shell denies unexpected navigation, window creation, and
  non-loopback runtime egress.
- Source documents are stored in IndexedDB / SurrealDB on disk and marked
  `privateUseOnly: true`. Standard vault exports omit source text;
  `.qvsource` bundles are the only path that includes it.

## License

UNLICENSED — personal local-only tool, not for redistribution. See
`docs/SPIKE-FINDINGS.md` for the curriculum-PDF terms (`For candidate use
only. Not for distribution.`).
