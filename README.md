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
> for how the LSAT domain is embedded.

## Stack

| Layer                                  | What                                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Desktop shell**                      | Electron 43 with a sandboxed renderer, typed preload bridge, secure custom protocol, and main-process sidecar supervisor                                |
| **Domains**                            | Host (CFA/Quant/Excel) at `/`, LSAT at `/lsat` — one Vite bundle, each with its own router; see [ARCHITECTURE.md](docs/ARCHITECTURE.md)                 |
| **One local brain** (current → target) | Dexie / IndexedDB → SurrealDB (Wave-1); LSAT uses a FastAPI + SQLite sidecar on :8100                                                                   |
| **Notebook + RAG**                     | Embedded open-notebook (FastAPI on :5055, worker, transformations)                                                                                      |
| **Local model**                        | LM Studio or Ollama, OpenAI-compatible chat + embeddings. Standardize on **Gemma 4 E4B** (multimodal, 128K context)                                     |
| **Frontend**                           | React 19 + Vite 8 + react-router-dom 7 + recharts/@visx + lucide-react + pdfjs-dist; Geist/Newsreader fonts; vite-plugin-pwa for offline service-worker |

## What works today

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
with AI" button calls the local model with the question + options + correct

- picked indices and renders a personalized 3-5 sentence explanation as a
  callout below the static explanation. Same CORS guidance in the error path.

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
npm run lint        # eslint . — must be clean
npx tsc --noEmit    # zero errors
npm test            # vitest run — 160+ tests
npm run build       # vite + tsc + PWA bundle

# Electron desktop:
npx vitest run --project host electron
npm run electron:build:dir    # unpacked app
npm run electron:build        # platform installers
```

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

- **LM Studio** (recommended): serve `gemma-4-e4b-it` on
  `http://localhost:1234/v1`. Load at `-c 32768` (the 4096 default truncates
  RAG context). Enable CORS in Developer/Server panel — required for
  browser fetches in web dev. Electron uses the explicit `app://studyvault`
  origin and the same backend CORS policy.
- **Ollama**: `ollama pull gemma4:e4b`; start with `OLLAMA_ORIGINS=*` for
  browser dev.

Configure both URLs in System Health → Local AI / Embedded Notebook.

## Docs

- [`docs/ROADMAP.md`](docs/ROADMAP.md) — full multi-wave roadmap.
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
