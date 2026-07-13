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

- [x] Scaffold Tauri around the Vite app; dev + prod builds **(M)**
- [x] **Sidecar supervision + PyInstaller proven end-to-end** — `services_dir()` searches QV_SERVICES_DIR → spike → cwd-parent → exe/resources/services → macOS Resources/services. `scripts/onb-minimal-requirements.txt` pins the focused subset excluding heavy provider SDKs (saves ~100 MB). `scripts/onb-stub-main.py` exposes the real backend's `/health` route, smoke-built to a 37.4 MB `.exe` via PyInstaller 6.20.0 and verified booting + responding `{"status":"ok"}` on Python 3.12.10. `docs/PACKAGING-PYINSTALLER.md` documents the full flow. The full backend bundle just runs the same script against `spike/open-notebook/api/main.py`
- [x] Native folder ingestion — Tauri commands `cfa_pick_folder` / `cfa_list_pdfs` / `cfa_read_pdf_bytes`; browser-side pdfjs extraction + page-aware chunker → Dexie sourceDocuments/sourceChunks; SHA-256 dedupe; "Desktop Shell" card on System Health
- [x] OS drag-drop ingestion via `onDragDropEvent`; browser-native review reminders via Notification API. Native tray + global hotkey are Tauri-shell follow-ups
- [x] Packaging + code signing + GitHub release pipeline — `npm run tauri:build`, signed bundle scaffolding in `tauri.conf.json` (Windows thumbprint + macOS signing-identity + notarization env vars), `.github/workflows/release.yml` matrix-builds Windows/macOS/Linux on `v*` tags. Auto-updater is opt-in (see `docs/PACKAGING.md`)

## Pillar 1 — One local brain (SurrealDB)

- [x] **Unified schema defined** — `StorageDriver` ships five namespaces across both drivers: `settings`, `chunks` (vector+hybrid), `reviewItems` (FSRS queue), `questionResults` (attempt log), `masterySnapshots`. SurrealDB tables (`review_items`, `question_results`, `mastery_snapshots`) defined under the same lazy idempotent `_schemaReady` gate with composite domain+topic / dueAt indexes. Dexie path active today; SurrealDB wire-ready. Migrating the remaining callers off direct `db.*` access is the mechanical Phase 4
- [x] **Strangler-pattern abstraction + Phase 2 sweep shipped** — `src/lib/storage/{dexieDriver,surrealDriver,index}.ts` wraps `db.settings`; `switchToSurreal()` validates a live `:8000` sidecar before swapping. Phase 2 done: 39 callsites across 8 production files (bootstrap, localLlm, mockGenerator, openNotebook, PwaInstallPrompt, Dashboard, SystemHealth, Today) now route through `getStorage().settings.*`. Dexie remains the active driver — only the SurrealDB schema migration + Phase 3 (other tables) is left **(L)**
- [x] **Vector + hybrid search over curriculum chunks** — `StorageDriver.chunks` namespace ships in both drivers. Dexie path uses JS BM25 (k1=1.5, b=0.75) + cosine similarity + 60/40 hybrid blend, works today with no sidecar. SurrealDB path: lazy idempotent schema (DEFINE TABLE / FIELD / ANALYZER quantvault_bm25 BM25 / INDEX … MTREE DIMENSION 384 DIST COSINE), batched FOR \$c IN \$chunks UPSERT, single SurrealQL hybrid query using `search::score(0)`, `vector::similarity::cosine`, `<|12|>` KNN operator, `text @@ \$query`. System Health "Hybrid curriculum search" panel routes through `getStorage().chunks` — works on Dexie today, transparently switches when `switchToSurreal()` activates
- [x] **Backup/restore + encrypted export** — `src/lib/encryptedBackup.ts`: AES-GCM-256 over PBKDF2-SHA256 (200k iterations), random 16-byte salt + 12-byte IV per encryption, salt as GCM additionalData. System Health UI offers Encrypted Export + Import Encrypted Backup alongside the plaintext path

## Pillar 2 — Notebook workspace (forked open-notebook, embedded)

- [x] Wire QuantVault UI to the local open-notebook API; curriculum flows in as sources via `ensureTopicNotebook`
- [x] Notebooks: sources + notes + RAG chat with **citations** to chunks/page locators — parsed `[source:xxx]` markers render as numbered chips ① ② with source-title legend (`src/lib/citations.ts`)
- [x] **Transformations** — `summarizeTopicFromCurriculum`, `generateFlashcardsFromCurriculum`, `generateQuestionsFromCurriculum`, `narrateStudyPlan`, `critiqueConstructedResponse`, `ensureSourceInsights("Key Insights")`. Five surfaces in CfaModule, two on /today, plus the Mock-exam constructed grader
- [x] **AI study podcasts** — multi-speaker Coach/Student script (Gemma 4 E4B) → kokoro-js TTS (`af_heart` + `am_michael`, ~80MB ONNX model cached in IndexedDB on first use). `PodcastPanel` mounts above AI practice in every CFA module with grounded source excerpts. Play / Pause / Stop / per-segment download. Stitching segments into a single WAV stream is the open polish **(M)**
- [x] **Open-notebook UI blend** — `src/components/OpenNotebook/OpenNotebookPrimitives.tsx` ships `CitationChip`, `SourceLegend`, `InsightCard` — design-token-only components that replace the previously inline-styled citation chips and source legends. Adds `qv-ml-{1,2,3,auto}` margin utilities. The embedded notebook surfaces now ship one visual language with the rest of QuantVault

## Pillar 3 — AI core on Gemma 4 E4B

- [x] Standardize the model client on Gemma 4 E4B; per-source chat streams SSE-style today; askGrounded global path is JSON. **128K-aware context budgeting** ships — `src/lib/contextBudget.ts` exports `pickBudget` (infers window from model-name suffixes), `packExcerpts` (drops from end), `renderExcerpts`. All three curriculum generators (`generateQuestions/Flashcards/SummarizeTopic`) now share `packCurriculumChunks`. `DEFAULT_LLM_SETTINGS.contextWindow = 32768`
- [x] **Semantic RAG — local-first path ships.** `src/lib/localRag.ts` `localGroundedAnswer` retrieves through `getStorage().chunks.search` (Dexie BM25+cosine today, SurrealDB MTREE vector after `switchToSurreal()`), packs chunks under the context budget with `[n]` citation markers, and synthesises a grounded answer with the local LLM — no `:5055` sidecar required. CfaModule's "Ask the curriculum" falls back to this path when the embedded notebook is disabled. open-notebook embeddings remain the path when the sidecar is up
- [x] "Explain this" / "why was I wrong" coaching — "🤖 Explain with AI" on every missed quiz question, backed by `explainWrongAnswer` in `localLlm.js`
- [x] **Constructed-response (L3 essay) grading** — `gradeConstructedResponseStructured` returns `{overall: {verdict: PASS/BORDERLINE/FAIL, percent, summary}, criteria: [{verdict, score, maxPoints, evidence, improvement}]}`. Conservative cutoffs (<50% FAIL, 50-69% BORDERLINE, ≥70% PASS); per-criterion scores capped; skipped criteria filled as Missed

## Pillar 4 — Agentic study director

- [x] **Tool-calling agent** — `src/lib/toolAgent.ts` with `runAgent({goal, tools, maxSteps, generate, onTrace})`. ReAct-style JSON-line protocol; tolerates fenced blocks + prose; bounded by maxSteps (default 6); aborts after 2 parse failures; reroutes unknown-tool picks; surfaces tool errors back to the model. AgentTool + parseAgentTurn + AgentTrace stream
- [x] Plan generation — `buildStudyPlan` runs over FSRS queue + readiness + 14-day forecast and re-runs on pathway/progress change. Plus `applyInterleavingRules` for desirable-difficulty + interleaving
- [x] **Auto-generates targeted material into the queue** — `src/lib/targetedMaterialQueue.ts` with `generateTargetedMaterialJobs` (idempotent, skips topics ≥ threshold, suppresses fresh artifacts <7 days) and `runTargetedMaterialJob` routing to the three curriculum generators. System Health: Generate jobs / Run all pending / Clear queue

## Pillar 5 — Multimodal + voice

- [x] **Multimodal ingestion** — Whisper-tiny ONNX runs entirely in-browser via `@huggingface/transformers`; **Gemma vision** wired via `src/lib/visionAdapter.ts` (multi-part `text` + `image_url` messages to LM Studio / Ollama). PDF page images / photos of notes can be passed to a vision-capable Gemma model
- [x] **Voice tutor** — `recognizeOnceOffline` (Whisper-tiny) + `recordAudioForOfflineStt` + `speak()` over SpeechSynthesis + **hands-free Socratic loop** (`src/lib/socraticLoop.ts`: state machine listen → think → speak with custom stop-phrases, grounding excerpts, maxTurns trimming, abortable)
- [x] **Figure/chart understanding** — `src/lib/figureUnderstanding.ts` with `explainCurriculumFigure` → FigureExplanation {summary, bullets, axes?}. `FigureExplainer` UI accepts PNG/JPEG/WebP uploads and renders the structured explanation

## Pillar 6 — Learning science & generative exams

- [x] Adopt **ts-fsrs** — `src/lib/scheduler.ts` now delegates internals to `ts-fsrs@5.4.1`; all public exports preserved; exam-tuned errorCategory penalty multiplier kept on top of the library output; parity test asserts monotonic interval growth across a 5-streak
- [x] **FSRS optimizer** — `src/lib/fsrsOptimizer.ts` fits FSRS-4.5 parameters to the user's `questionResults` history via coordinate descent against binary-cross-entropy log-loss. Tunes `request_retention` + `w[0..3]` + `w[15..16]`. Bounded ~300 evals; refuses sample sizes below 50 reviews. Persisted params swap the active `fsrs()` instance on next reload. System Health: **Fit from history → preview report → Apply / Reset**
- [x] **Item psychometrics — IRT-lite** — `src/lib/itemPsychometrics.ts` computes per-item empirical difficulty + point-biserial discrimination + Wald reliability SE. Flags `too-easy` / `too-hard` / `low-discrimination` / `ok` / `insufficient-data`. System Health: chip summary by flag + expandable top-10 flagged-item table
- [x] **Generative mock exams** — `src/lib/mockGenerator.js` builds per-level mocks from ingested curriculum via the local LLM; topic mix preview; integrated into the existing MockExam runner so scoring/timing/persistence work unchanged
- [x] **Smarter planning** — exam-date countdown badge on `/today`; LLM "Why this plan today" narrative; **interleaving + desirable-difficulty** rules in `applyInterleavingRules`: weakest topic primary, every 1/interleaveRatio slot is second-weakest, back-to-back same-topic avoided from history, rationale signals consumers NOT to drop to the easiest item when mastery is below desirableDifficultyMin. spacingScore = 1 - maxRun/total

## Pillar 7 — Design system & visual craft *(bedrock)*

- [x] Design tokens in CSS layers — `src/styles/tokens.css` ships eight token families (color/type/space/radius/elevation/motion/z-index/layout) under `@layer tokens`, plus a utility-class layer (`.qv-stack-*`, `.qv-row-*`, `.qv-card`, `.qv-callout`, `.qv-chip`, color/font/margin shorthands). Mechanical inline-style → utility-class sweep across remaining components is the steady-state follow-up
- [x] Component library + in-app gallery — every Primitive (Surface, StatusBadge, PageHeader, MetricTile, Panel, Dialog, SegmentedControl, InlineCluster, ProgressRail, EmptyPanel, QuestionStage, RubricPanel) rendered at `/style` with all token families
- [x] Theming — `prefers-reduced-motion` honoured at the token layer; **light/dark/system** three-state switcher in TopBar with `[data-theme="light"]` token overrides + `prefers-color-scheme` default block; bootstrap runs before `createRoot` to avoid first-paint flash. **Per-domain accent themes** ship: `[data-domain="cfa" | "excel" | "quant"]` overrides re-bind semantic + raw accent tokens; `App.jsx` sets the attribute on body via useEffect keyed on `location.pathname`. Light-theme variants tested for WCAG AA against #FFFFFF

## Pillar 8 — UX flows & navigation

- [x] Command palette (⌘K) — TopBar input filters routes/tools/commands from the manifest with combobox+listbox ARIA
- [x] "Today" focus mode — new `/today` route with hero top-action card + then-list, surfaced in sidebar Tools + Dashboard quick-tools + ⌘K
- [x] First-run onboarding — `src/components/Onboarding/OnboardingWizard.jsx` ships a 3-step modal (welcome / model picker with LM Studio + Ollama presets / ingestion paths) gated on an empty vault + disabled LLM + no dismiss flag. Resettable from System Health
- [x] Keyboard help dialog — `?` opens a Dialog listing global + route-scoped shortcuts from `keyboardHelp` metadata

## Pillar 9 — Data viz & dashboards

- [x] **Exam-readiness cockpit** — `projectExamReadiness({snapshots, results, examDate})` projects topic-weighted mastery over trailing-14-day attempt rate with per-attempt lift calibrated inversely to accuracy and ±1.96σ Wald confidence band. Analytics ComposedChart shows the projected line + band + ReferenceLine at exam date + chip metrics row
- [x] Mastery-over-time + 30-day Retention Decay + Confidence Calibration scatter + Accuracy By Item Type + 12-week Streak Heatmap all ship on Analytics
- [x] Interactive curriculum knowledge-graph canvas at `/knowledge-graph` — SVG canvas with cross-level edges, mastery + curriculum color overlays, search filter, side panel. Surrealdb-graph backing follows once Pillar 1 callers are migrated

## Pillar 10 — Content coverage

- [x] **Better structure extraction** — page-aware chunking with locators + `extractStructure()` in `desktopIngestion.ts`: LOS mined from the region after a lead-in phrase ('the candidate should be able to' / 'learning outcomes'), each = optional list marker + CFA command verb (21-word set) + rest, capped 200 chars / 20 per chunk. `CfaSourceChunk` gains optional `learningOutcomes` + `losVerbs`; `pageChunksFromPages` populates them. HEADING_PATTERN broadened (STUDY SESSION / TOPIC / MODULE n) and made case-sensitive to avoid mid-prose over-match. "no curriculum" warning still surfaces uncovered topics
- [x] **Bulk AI content expansion — L1 + L2 + L3 all shipped.** `npm run content:expand` reads ingested curriculum chunks; `npm run content:expand --from-los <level>` reads `scripts/cfa-l{2,3}-los-bank.mjs` (87 + 63 LOS across 18 topics) when the source PDFs aren't available. Total in `public/cfa-generated.json`: **140 MCQs + 224 flashcards across 28 level×topic pairs** (L1 chunk-grounded, L2 + L3 LOS-grounded against gemma-4-e4b-it). `bootstrapAiContent` seeds them all into the in-app caches at startup
- [x] Bring-your-own content — paste-text source ingestion lands in the same vault (`ingestTextSource`)

## Pillar 11 — Infra & quality

- [x] **Performance** — `src/lib/computeWorker.ts` + `.worker.ts` offload `fitFSRSParameters` + `computePsychometrics` to a dedicated module worker (Vite ?worker import). `src/components/VirtualizedList/` ~80 LOC fixed-height virtualizer (RAF-throttled scroll, absolute positioning, overscan + edge clamping, no external deps) wired into CFA module's flashcards (≥12), AI questions (≥8), curriculum chunks (≥12). Sidecar startup time remains an open Tauri-shell **(M)** item
- [x] **TypeScript rigor** — three waves done (28 modules total). Wave 3 added financeMath, formulaLibrary, flashcards, exportUtils, jsonFilePreflight, useProgress, useLevel3Pathway, cfaLevels, cfaLevel3Pathways, formulaLexicon, registerServiceWorker, EmptyState, ErrorBoundary, SourceContext + the Onboarding/PwaInstallPrompt barrels — each typed properly (no @ts-expect-error). The few remaining `.js`/`.jsx` files are large data literals (`src/data/*`, `cfaLevel*Runtime`) and top-level page shells whose conversion is low-value churn
- [x] **Testing** — vitest **409 unit/integration tests across 47 files** + **28 Rust cargo tests** (was 5). Pillar 11 Rust suite extracts 4 testable seams (services_dir_search, cfa_read_pdf_bytes_impl, pick_folder_recv, SidecarSpec + SidecarLauncher trait) so the supervisor lifecycle exercises with a MockLauncher — no surreal.exe / uv needed. Playwright e2e (`scripts/smoke.mjs`) still ships. The remaining UI smoke pass against a running Tauri shell is operational coverage
- [x] **Strict-offline invariant enforced** — Google Fonts / KaTeX CDN `<link>` tags removed; KaTeX CSS bundled from npm; SW runtime-cache routes for those CDNs deleted

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
