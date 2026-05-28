# QuantVault Upgrade Roadmap — Maximal Ambition

> **North star:** portfolio-quality showcase.
> **Platform:** **Tauri desktop app (desktop-only)** that supervises a local multi-process runtime.
> **Blend:** **full fork of open-notebook**, embedding its FastAPI backend + SurrealDB as Tauri sidecars; QuantVault's React UI becomes the single unified shell.
> **Data:** **one local brain on SurrealDB** — curriculum, notebooks, FSRS history, embeddings, and a knowledge graph in a single offline store (migrate off Dexie/IndexedDB).
> **Model:** standardize on **Gemma 4 E4B** via Ollama — multimodal (text + image + audio), 128K context, ~4.5B effective params. Tune the whole AI layer for it.
> **Hard invariant:** fully **offline / local** — no cloud, self-hosted fonts, no CDNs. Works on a plane.
> **Appetite:** maximal. Heavy bundle and multi-process complexity are accepted in exchange for capability.

## The pitch this makes true

Install one offline desktop app, point it at your CFA curriculum folder, and it becomes an
AI study OS: a multimodal local tutor (Gemma 4 E4B) that *knows your books*, an open-notebook
workspace with RAG chat / transformations / study podcasts, spaced repetition, generative mock
exams, voice interaction, and exam-readiness analytics — all on one local SurrealDB brain, fully
offline. Showcase proof: signed installer + demo video + GitHub release.

## Architecture at a glance

```
Tauri (Rust core, supervisor + native fs/notifications/updater)
 ├─ SurrealDB sidecar        ← the one local brain (graph + vector + documents)
 ├─ open-notebook FastAPI    ← notebooks, RAG, transformations, podcasts (embedded Python)
 ├─ Ollama (reused)          ← Gemma 4 E4B (gen, vision, audio) + embedding model
 └─ React webview (QuantVault unified UI)
```

## Model standard — Gemma 4 E4B

- **128K context** → RAG can include many curriculum chunks at once (drop the old 12k-char slice budget).
- **Multimodal**: feed PDF page images, figures, lecture audio, photos of handwritten notes directly. Put image/audio *before* text in prompts.
- **Visual token budget** tunable per task (fine-grained figures vs. fast skim).
- Default tag `gemma4:e4b`; quantized `gemma4:e4b-it-q4_K_M` for modest GPUs. Embeddings via a local Ollama embed model into SurrealDB vectors.

## OSS building blocks (all offline)

| Tool | Role | License |
|---|---|---|
| **Tauri** | Desktop shell + sidecar supervisor | MIT/Apache-2 |
| **open-notebook** (lfnovo) | Forked & embedded: notebooks, RAG, transformations, multi-speaker podcasts | MIT |
| **SurrealDB** | The unified local store (graph + vector + docs) | BSL→Apache |
| **Ollama + Gemma 4 E4B** | Local multimodal generation + embeddings | Gemma terms |
| **ts-fsrs** + binding optimizer | Replace hand-rolled FSRS; fit weights to the user's history | MIT |
| **kokoro-js** | Local TTS for study podcasts + voice-out | Apache-2 |
| **whisper** (whisper.cpp / transformers.js) | Local STT for voice-in + lecture transcription | MIT |

---

## Pillar 0 — Desktop platform & sidecar runtime (Tauri)

- [ ] Scaffold Tauri around the Vite app; dev + prod builds **(M)**
- [ ] Sidecar supervision: bundle & launch SurrealDB + embedded open-notebook (PyInstaller) + reuse Ollama; health checks, lifecycle, ports **(XL)**
- [ ] Native folder ingestion — read/watch the CFA folder via Tauri fs; pdf.js + page-image extraction in a worker **(L)**
- [ ] Native reminders, tray, global hotkey to "Today"; `.qvsource` file association; OS drag-drop **(M)**
- [ ] Packaging + code signing + auto-update; GitHub release pipeline **(L)**

## Pillar 1 — One local brain (SurrealDB)

- [ ] Define the unified schema: sources, chunks+embeddings, notebooks, notes, FSRS reviews, attempts, mastery, knowledge graph **(L)**
- [ ] Migrate QuantVault's Dexie stores (`progressStore`, source vault) → SurrealDB; data-portability/import path **(XL)**
- [ ] Vector + hybrid search in SurrealDB over curriculum chunks **(L)**
- [ ] Backup/restore + encrypted export against the new store **(M)**

## Pillar 2 — Notebook workspace (forked open-notebook, embedded)

- [ ] Wire QuantVault UI to the local open-notebook API; curriculum flows in as sources **(L)**
- [ ] Notebooks: sources + notes + RAG chat with **citations** to chunks/page locators **(M)**
- [ ] **Transformations** — summarize / extract flashcards / key-points / generate questions from any source **(M)**
- [ ] **AI study podcasts** — multi-speaker script (Gemma) → kokoro audio, fully local **(L)**
- [ ] Blend open-notebook's UI into QuantVault's design system (don't ship two visual languages) **(L)**

## Pillar 3 — AI core on Gemma 4 E4B

- [ ] Standardize the model client on Gemma 4 E4B; streaming (SSE); 128K-aware context budgeting **(M)**
- [ ] Semantic RAG over SurrealDB vectors; tutor grounded in real books **(L)**
- [ ] "Explain this" / "why was I wrong" coaching anywhere **(M)**
- [ ] Constructed-response (L3 essay) grading against rubrics **(L)**

## Pillar 4 — Agentic study director

- [ ] Tool-calling agent over the local data (reviews due, weak objectives, readiness, calendar) **(XL)**
- [ ] Weekly plan generation + daily adaptation from performance **(L)**
- [ ] Auto-generates targeted material (questions, drills, notebook summaries) into the queue **(L)**

## Pillar 5 — Multimodal + voice

- [ ] Multimodal ingestion — PDF page images/figures, lecture audio/video (Whisper transcribe), photos of notes → Gemma vision/audio **(XL)**
- [ ] Voice tutor — hands-free Socratic mode (Whisper in + kokoro out) **(L)**
- [ ] Figure/chart understanding in the curriculum reader **(M)**

## Pillar 6 — Learning science & generative exams

- [ ] Adopt **ts-fsrs** + migrate the hand-rolled scheduler **(L)**
- [ ] **FSRS optimizer** — fit weights to the user's review history **(L)**
- [ ] Item psychometrics — IRT-lite difficulty calibration (`psychometricStats`) **(L)**
- [ ] **Generative mock exams** — AI assembles full timed exams calibrated to weak areas + difficulty **(L)**
- [ ] Smarter planning — exam-date pacing, interleaving, desirable difficulty **(M)**

## Pillar 7 — Design system & visual craft *(bedrock)*

- [ ] Design tokens (color, type, space, radius, elevation, motion) in CSS layers; remove inline styles **(L)**
- [ ] Component library: formalize/extend `Primitives`; in-app `/style` gallery **(L)**
- [ ] Theming (light/dark, per-domain accents, contrast/reduced-motion); motion language (View Transitions); self-hosted premium type **(M)**

## Pillar 8 — UX flows & navigation

- [ ] Command palette (⌘K) on existing route/command data **(M)**
- [ ] "Today" focus mode (Review → due → weak → mock) via `nextRecommendation` **(M)**
- [ ] First-run onboarding (folder, model, exam date, pathway); native window UX, breadcrumbs, keyboard scopes **(M)**

## Pillar 9 — Data viz & dashboards

- [ ] Exam-readiness cockpit + retention-forecast curves **(L)**
- [ ] Mastery-over-time, FSRS decay, calibration plot, error breakdown, streak heatmap **(M)**
- [ ] Interactive curriculum knowledge-graph canvas (over the SurrealDB graph) **(L)**

## Pillar 10 — Content coverage

- [ ] Better structure extraction (Learning Modules / LOS, headings, figures/tables) **(L)**
- [ ] Breadth — L2/L3 PDFs, deepen Quant/Excel **(L)**

## Pillar 11 — Infra & quality

- [ ] Performance — virtualization, worker offload, sidecar startup time **(M)**
- [ ] TypeScript rigor — migrate remaining `.jsx`/`.js` → `.tsx` **(L)**
- [ ] Testing — Playwright e2e + Tauri smoke + sidecar integration tests **(M)**

---

## Waves

| Wave | Theme | Headline |
|---|---|---|
| **0** | Platform spine | Tauri shell + sidecar runtime (SurrealDB + open-notebook + Ollama/Gemma 4 E4B) + native ingestion |
| **1** | One brain + design | SurrealDB unification (migrate off Dexie) + design tokens/component library |
| **2** | Notebook + AI core | Embedded notebook workspace, RAG, citations, transformations; Gemma 4 E4B streaming |
| **3** | Intelligence | Agentic study director, generative mock exams, ts-fsrs + optimizer |
| **4** | Multimodal + voice | Image/audio ingestion, voice tutor, podcasts |
| **5** | Insight + polish | Dashboards, knowledge-graph canvas, breadth, a11y, packaging/signing |

## Signature centerpieces (demo path)

1. Point at a folder → multimodal local tutor that knows your books
2. Notebook workspace: RAG chat with citations + one-click study podcast
3. Agentic study director planning your week
4. Voice tutor — talk to your curriculum, hands-free
5. Exam-readiness cockpit + knowledge-graph canvas

## Risks / honest notes

- **Bundle weight & complexity:** embedding Python + SurrealDB + supervising Ollama is a heavy, multi-process desktop app (likely hundreds of MB–GB). Accepted for capability; mitigate with lazy sidecar start and a clean supervisor.
- **Two datastores during migration:** Dexie → SurrealDB is a large migration; run dual-write/strangler so the app stays usable.
- **Offline invariant holds throughout:** every sidecar runs locally; no feature may reach the network.

## Tracking

Check items off as they land. Each wave ends with the app runnable, sidecars healthy, and `lint`/`tsc`/tests/build green.
