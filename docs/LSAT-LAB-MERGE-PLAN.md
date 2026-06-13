# Merging LSAT Lab into QuantVault — Master Plan

> **Execution status (2026-06-13):** Phases **0, 1, 2, 3, R** are DONE and
> committed on `codex/performance-level2-content-gate` (StudyVault v0.9.0).
> LSAT runs natively at `/lsat`; the backend sidecar builds + boots + serves on
> 8100; rebrand to StudyVault complete. Browser-verified. **Remaining:** Phase
> 4 (shared settings/theme bridge), Phase 4.1 (unified Review Inbox), Phase 5
> (surface the LSAT import UI in the host — the flows already exist in-app),
> Phase 6 CI (binaries built locally, documented in PACKAGING.md), Phase 7
> (final sweep). Gates green throughout: tsc 0 · lint 0 · vitest 451/50 ·
> build 190 entries · cargo 29 · build:lsat-binary boots.


> Status: **PLAN ONLY — no implementation.** Authored 2026-06-13; decisions resolved 2026-06-13 (see §8).
> Outcome shape: a **single monorepo**, rebranded to the umbrella product **StudyVault**, with LSAT as a ported `/lsat` domain backed by a vendored, bundled FastAPI sidecar, and a **unified cross-domain review queue**.
> Target (host): **QuantVault / CFAPrep** — `C:\Users\charl\.gemini\antigravity\scratch\quantvault` (branch `codex/performance-level2-content-gate`, v0.8.0+; GitNexus repo **CFAPrep**).
> Source (incoming): **LSAT Lab** — `C:\Users\charl\LSATLab` (GitNexus repo **LSATLab**, last commit `cd3f2e2`).
> Both repos are indexed in GitNexus and fresh — use them throughout (see §9).

---

## 0. TL;DR — the recommendation

Merge LSAT Lab into QuantVault as a **first-class domain (`/lsat`) whose data/logic live behind a bundled, supervised FastAPI sidecar** — reusing the *exact* PyInstaller-sidecar bundling + Tauri supervision QuantVault already built and validated for open-notebook. Do **not** rewrite LSAT Lab's Python backend into the browser, and do **not** force LSAT onto Dexie. Keep one Tauri shell, one React app, one design language; let the two persistence models coexist behind the domain boundary.

This is **Option A** below. It preserves ~27k lines of working Python (scheduler, analytics, content health, import pipeline, generation+critic) intact, leans on infrastructure QuantVault already owns, and uses QuantVault's declarative domain-plugin seams (`catalog.js`, `routeManifest.ts`, `src/domains/*`) as designed.

Headline effort: **~6–9 focused phases**; the genuinely hard work is **frontend toolchain reconciliation** (React 18→19 / Vite 5→8 / TS 5.6→6, Tailwind-alongside-tokens) and **packaging/port/CSP wiring**, *not* the backend (which slots into an existing pattern).

---

## 1. Why merge, and what "merge" means here

The user owns two local-first, Tauri-packaged, exam-prep desktop apps with overlapping ambitions (spaced repetition, AI explanations, generated content, analytics, mock exams) but disjoint subject matter (CFA finance vs. LSAT). The goal is **one program** the user opens to study either subject — shared shell, shared navigation, shared model/settings surface — without throwing away either codebase's substance.

"Merge into this Program" = QuantVault is the **host**. LSAT becomes a domain inside it, not a peer app launched separately.

---

## 2. Current state of the host (QuantVault / CFAPrep)

Established over v0.1.0 → v0.8.0 (+ the post-v0.8.0 hardening commit `3447024`):

- **Stack:** React 19.2 / Vite 8 / TypeScript 6 / react-router-dom 7.15. Frontend-only by default.
- **Desktop:** Tauri 2.11 shell in `src-tauri/`. The Rust supervisor (`src-tauri/src/lib.rs`) discovers a services dir (`services_dir_search`: env override → `spike/` → cwd parents → `resources/services/` → macOS `../Resources/services/`) and launches a **declarative `Vec<SidecarSpec>`** via `build_sidecar_specs(dir)` — currently SurrealDB + open-notebook API + open-notebook worker. `is_port_listening` gives readiness probes; `SidecarLauncher` is a trait (mockable, unit-tested).
- **Storage:** Dexie/IndexedDB via `src/lib/progressStore.ts`, behind a `StorageDriver` abstraction (`src/lib/storage/`) with `dexieDriver` (active) + dormant `surrealDriver`. Five namespaces, all now at **SurrealDB parity** after `3447024` (settings — with hex-encoded record ids — / chunks / reviewItems / questionResults / masterySnapshots). Live cutover UI exists (System Health → Storage Backend; `cutoverTo()` + `migrateData()`).
- **Spaced repetition:** client-side `ts-fsrs@5.4.1` in `src/lib/scheduler.ts` + `fsrsOptimizer.ts` (FSRS-4.5 weight fitting) + IRT-lite `itemPsychometrics.ts`.
- **AI:** `src/lib/localLlm.js` → LM Studio (`:1234`) / Ollama (`:11434`), OpenAI-style `/chat/completions`, `generateText()` helper. RAG via open-notebook sidecar (`src/lib/openNotebook.ts`) + local-first `src/lib/localRag.ts` (retrieval through the storage abstraction). Voice (Whisper) + kokoro podcasts.
- **Domain plug-in pattern (the key seam):**
  - `src/data/catalog.js` — `domains[]` array (`{id,title,subtitle,path,color,gradient,badge,stats}`) + per-domain topic arrays.
  - `src/routes/routeManifest.ts` — typed central manifest: `RouteDomain` union, `AppRouteId` union, `AppRoute` interface (path, nav group/label/order, accent role, preferred layout, search group, offlineCritical, keyboard scopes, breadcrumbs). Smoke/regression/a11y harnesses iterate this manifest.
  - `src/domains/{cfa,excel,quant}/` — per-domain pages/loaders/runtime.
- **Packaging:** `scripts/build-onb-binary.mjs` builds the open-notebook FastAPI backend into a one-file PyInstaller binary inside an isolated `.venv-onb`, drops it in `src-tauri/resources/services/`, shipped via `tauri.conf.json` → `bundle.resources`. **Validated end-to-end last session** (binary boots its whole import graph; only the runtime DB connection remains). CSP `connect-src` already allows `localhost:1234/5055/8000/11434`. `.github/workflows/release.yml` matrix-builds signed bundles on `v*` tags.
- **Quality gates:** `npm run verify` (lint + vitest + build), `smoke` / `browser:regression` / `visual:regression` / `a11y:check` (Playwright over `routeManifest`), `cargo test` (28 Rust tests). 449 vitest tests / 50 files at v0.8.0.

### What changed since our last session (the only post-v0.8.0 commit, `3447024` "Fix regression gates and storage parity", by Codex)
- **Storage parity:** `surrealDriver.settings` now hex-encodes arbitrary key strings into safe SurrealDB record ids (`setting:k_<hex>`), added a `setting` SCHEMALESS table + key index, and round-trips the original payload. So all five namespaces have real SurrealDB parity, not just the keyed three. New schema.test cases lock this in (record-id encoding, `bulkDelete` encoding, schema-once).
- **Regression gates:** `scripts/browser-regression.mjs` gained a richer `assertNoRuntimeErrors` pass; `scripts/smoke.mjs` tweaks; both still drive `src/routes/routeManifest.ts`.
- **UI fixes:** `CfaConstructedResponse.jsx`, `KnowledgeGraph.jsx`, `MockExam.jsx`, `StyleGallery.jsx`, `index.css`, `tokens.css` — token/contrast/layout polish.
- Net: +286/−74 across 10 files. No new dependencies, no architectural change. **Implication for the merge:** the storage abstraction is now a trustworthy seam, and the regression harness is manifest-driven — both help us add a domain safely.

---

## 3. Current state of the source (LSAT Lab)

Architecturally a **different animal** — a client/server monorepo:

- **Frontend:** React **18.3** / Vite **5.4** / TS **5.6** / react-router-dom **7.15** (same router). Tailwind + Radix UI primitives + `visx` charts + `motion/react` + `sonner`. Data fetching via **React Query** over a **generated OpenAPI client** (`frontend/src/lib/api.gen.ts`, `api.ts`, `hooks.ts`, `types.ts` ~55KB). `localStorage` (not IndexedDB) for UI prefs (`frontend/src/lib/storage.ts`). 32 pages, 90+ components in 18 subdirs. Tauri 2.11 shell with its own `src-tauri/`.
- **Backend (the substance):** **FastAPI + Python 3.12 + SQLite (WAL) + SQLModel ORM**, 73 files / ~27k lines. ~24 routers / 100+ endpoints (`/api/ai`, `/api/srs`, `/api/sessions`, `/api/analytics`, `/api/drills`, `/api/content`, `/api/import`, `/api/generation`, `/api/content-health`, `/api/notebook-os`, …). Server-side spaced repetition via the Python **`fsrs>=6.3.1`** library (`adaptivity.py`, 63KB; state stored in `SRSCard.state`). `analytics.py` (74KB). `app/llm/` provider abstraction (Ollama default / LM Studio / opt-in Anthropic cloud, budget-gated, "cloud never score-affecting"). `sqlite-vec` embeddings for RAG. PDF import (`pymupdf`) + research-dataset import (AGIEval/ReClor/tasksource) with a **quarantine/approval gate**. AI **generation + adversarial critic** pipeline (`GenJob` queue). Already ships a **PyInstaller sidecar** (`backend/sidecar_main.py`, `backend/lsatlab.spec`) — i.e. *the same packaging shape QuantVault uses*.
- **LSAT domain model (the payload worth merging):** `PrepTest / Section (LR|RC) / Question / AnswerChoice / Attempt / StudySession / SRSCard / GenJob`. Rich enums: 17 `LrType`s, 9 `RcType`s, 10 `TrapType`s; `confidence` (sure/likely/guess); blind-review (`br_answer`/`br_correct`); empirical difficulty re-estimation; scaled-score tables. Study modes: timed sections, full 3h25m exams, drills, blind review, RC lab, tutor, notebook.
- **Docs:** 16 architecture markdown files under `docs/` (00-vision, 01-architecture, 03-data-model, 05-api-contract, 07-design-tokens, 14-packaging, …) — read these before executing each phase.
- **Landmines:** repo is **~11GB** including a **2.4GB `backend/lsatlab.db`** (must never enter QuantVault git history); **PrepTest content is LSAC-copyrighted** (user-owned imports only, never bundled); **ReClor is non-commercial/research-only**; license is "All Rights Reserved."

### Compatibility matrix (host ⟵ source)

| Concern | QuantVault (host) | LSAT Lab (source) | Verdict |
|---|---|---|---|
| Router | react-router-dom 7.15 | react-router-dom 7.15 | ✅ SAME |
| Desktop shell | Tauri 2.11 | Tauri 2.11 | ✅ SAME (one shell) |
| Python sidecar packaging | PyInstaller via `build-onb-binary.mjs` (validated) | PyInstaller via `lsatlab.spec`/`sidecar_main.py` | ✅ SAME PATTERN — biggest reuse win |
| React | 19.2 | 18.3 | ⚠ minor — port up |
| Vite | 8 | 5.4 | ⚠ port up (config + plugin API) |
| TypeScript | 6 | 5.6 | ⚠ port up (stricter) |
| UI system | design tokens + `.qv-*` + custom primitives | Tailwind + Radix + HSL token vars | ⚠ two conventions — bridge or scope |
| Data fetching | direct Dexie calls | React Query + OpenAPI client | ⚠ add React Query to host, scope to `/lsat` |
| User-data store | Dexie/IndexedDB | SQLite behind FastAPI | ⚠ coexist (do NOT unify) |
| Spaced repetition | client `ts-fsrs` 5.4 | server `fsrs` 6.3 | ⚠ coexist (both FSRS family) |
| Local LLM target | LM Studio / Ollama | Ollama / LM Studio / cloud | ✅ same servers; keep separate clients |

---

## 4. Architectural decision — recommended strategy

### Option A — **Sidecar-backed domain inside the host** ✅ RECOMMENDED
One Tauri shell, one React app. LSAT mounts at `/lsat` as a registered QuantVault domain. LSAT's FastAPI+SQLite backend ships as a **bundled, supervised PyInstaller sidecar** (4th `SidecarSpec`), bundled by a generalized version of `build-onb-binary.mjs`. LSAT React pages (ported to the host toolchain) talk to `http://localhost:<lsat-port>` via their existing api/React-Query layer. CFA/Quant/Excel keep Dexie; LSAT keeps SQLite-behind-FastAPI. Shared: shell, top-level nav/dashboard, theme, model settings.

- **Pros:** preserves the entire Python investment; reuses proven QuantVault packaging/supervision; honours the domain-plugin pattern; clean blast radius (LSAT failures are contained behind a sidecar boundary the UI already knows how to degrade around).
- **Cons:** two persistence models in one app; toolchain reconciliation for the LSAT frontend; larger installer (Python backend ~120MB like open-notebook's).
- **Risk:** MEDIUM, front-loaded into Phase 1–3, then linear.

### Option B — Full port to host's frontend-only model ❌
Reimplement scheduler/analytics/content/import/generation in TS over Dexie; drop Python. ~27k lines rewritten; loses `sqlite-vec` RAG, the import + quarantine pipeline, generation+critic. **Rejected** — enormous, lossy, re-validates everything.

### Option C — Two apps sharing only tokens + a launcher ❌
Doesn't satisfy "merge into this Program"; leaves two builds, two shells. **Rejected** as the end state (though it's effectively the *starting* point we migrate away from).

> **Decision:** proceed with **Option A**. Everything below details it.

---

## 5. Target architecture (post-merge)

```
QuantVault (single Tauri 2 shell)
├─ React 19 / Vite 8 / TS 6 app
│   ├─ Home dashboard → domain cards: CFA · Quant · Excel · LSAT   ← catalog.js
│   ├─ /cfa /quant /excel        → Dexie/IndexedDB (unchanged)
│   └─ /lsat                      → React Query → http://localhost:8100  (LSAT FastAPI)
│        └─ ported LSAT pages/components (Tailwind scoped under a .lsat-root layer)
├─ Tauri Rust supervisor (build_sidecar_specs → Vec<SidecarSpec>)
│   ├─ surreal (8000)            [existing]
│   ├─ open-notebook API (5055)  [existing]
│   ├─ open-notebook worker      [existing]
│   └─ lsatlab API (8100)        ← NEW 4th spec, port-gated by is_port_listening
└─ resources/services/
    ├─ open-notebook/…           [existing PyInstaller bundle]
    └─ lsatlab/lsatlab(.exe)     ← NEW PyInstaller bundle (built like open-notebook)

User data:
  CFA/Quant/Excel  →  IndexedDB (Dexie)            [unchanged]
  LSAT             →  %APPDATA%/QuantVault/lsatlab.db (SQLite, created on first run, seeded)
```

Port map (CSP `connect-src` must list all): LM Studio `1234`, open-notebook `5055`, SurrealDB `8000`, **LSAT `8100` (new)**, Ollama `11434`.

---

## 6. Phased execution plan

Each phase ends green on the host's gates (`npm run verify` + `cargo test` + relevant Playwright harness) and is its own commit. Use the GitNexus calls noted per phase (see §9 for the standing workflow).

### Phase 0 — Pre-flight, decisions, and safety nets
- **Read** LSAT Lab's `docs/01-architecture.md`, `03-data-model.md`, `05-api-contract.md`, `14-packaging.md`, `07-design-tokens.md` end to end. Capture the API contract (it has `openapi.json` — the source of truth for the frontend client).
- **Create a GitNexus group** spanning both repos (`group.yaml` with `CFAPrep` + `LSATLab`) so we can `query`/`context` across both and track the OpenAPI **contract** during the merge. (See §9.)
- **Decide the open questions in §8** with the user before writing code.
- **Set up the repo hygiene** that must exist *before* any LSAT files land: `.gitignore` entries for `**/lsatlab.db`, `**/*.db`, `backend/.venv*`, `.venv-lsat/`, research datasets; confirm the 2.4GB DB and 11GB working tree never enter history (the bundled sidecar ships a *seed* DB; user data lives in app-data).
- **Licensing triage doc** (`docs/CONTENT-LICENSING.md`): codify "official PrepTests = user-owned imports only, never bundled"; gate ReClor/AGIEval behind a non-commercial build flag; carry LSAT Lab's content-source provenance (`PrepTest.source`) into any UI that exposes content.
- Gate: decisions recorded; nothing merged yet.

### Phase 1 — Land the LSAT backend as a buildable, bundled sidecar (no UI yet)
- Vendor `LSATLab/backend/` into the host repo as `services/lsatlab-backend/` (source only — **exclude** `lsatlab.db`, `.venv`, datasets, tests' fixtures > a size cap).
- **Generalize `scripts/build-onb-binary.mjs`** (or add `scripts/build-lsat-binary.mjs` modeled on it) to build LSAT Lab's `sidecar_main.py` via its existing `lsatlab.spec` into an isolated `.venv-lsat`, output to `src-tauri/resources/services/lsatlab/`. Reuse every hard-won fix from last session (collect_all for dynamic imports, mypyc root-glob, copy_metadata, isolated venv). Add `npm run build:lsat-binary`.
- **Add the 4th `SidecarSpec`** in `src-tauri/src/lib.rs` `build_sidecar_specs()` (program = `dir.join("lsatlab").join("lsatlab.exe")`, args to bind `127.0.0.1:8100`, env for DB path → app-data). Teach `services_dir_search` to also recognize an `lsatlab/` subdir. Add a readiness probe on `8100`. Extend the supervisor unit tests (mock launcher) to assert the 4th spec is built.
- **Seed-DB bootstrap:** ship LSAT Lab's `bank_bootstrap.py` sample content; on first run the sidecar creates `%APPDATA%/QuantVault/lsatlab.db` and seeds it. Never ship official content.
- **CSP:** add `http://localhost:8100` to `connect-src` in `src-tauri/tauri.conf.json`.
- GitNexus: before editing `lib.rs`, run `impact` on `build_sidecar_specs` / `services_dir_search` / `spawn_sidecars` (host repo) to confirm blast radius; `detect_changes` before commit.
- Gate: `npm run build:lsat-binary` produces a binary that boots its import graph (same bar we held open-notebook to); `cargo test` green; binary launches under the supervisor and answers `GET /api/health` on 8100 in a manual smoke.

### Phase 2 — Host toolchain reconciliation for LSAT frontend code
- Port LSAT frontend deps into the host `package.json`: add `@tanstack/react-query`, the Radix primitives actually used, `visx` packages, `motion`, `sonner`, `tailwindcss` + `postcss` + `autoprefixer` (+ codegen tooling for `api.gen.ts` if regenerating from `openapi.json`).
- **React 18→19:** mostly source-compatible; audit for `ReactDOM.render` legacy, `defaultProps` on function components, string refs, and `useRef` initial-arg changes. **Vite 5→8 / TS 5.6→6:** update config to the host's conventions; expect stricter TS (the host is TS 6 strict). This is the **largest discrete effort** — budget for a real compatibility pass.
- **Tailwind alongside the token system:** scope Tailwind to LSAT pages (e.g. a `.lsat-root` wrapper + a Tailwind `important`/prefix or a CSS cascade layer) so it never fights the host's `@layer tokens` / `.qv-*` utilities. Map LSAT's HSL token vars → the host's token vars where they mean the same thing (theme bridge) so light/dark/system from `src/lib/theme.ts` drives LSAT pages too.
- Gate: the LSAT component library compiles under the host toolchain in isolation (a Storybook-less type+build check); host `npm run build` still green with the new deps present but unused.

### Phase 3 — Register LSAT as a domain + mount its pages
- `src/data/catalog.js`: add the `lsat` domain card (`{id:'lsat', title:'LSAT', path:'/lsat', color, gradient, badge, stats}`) + topic arrays (LR/RC types).
- `src/routes/routeManifest.ts`: extend `RouteDomain` with `'lsat'`, add `AppRouteId`s (`lsat-dashboard`, `lsat-practice`, `lsat-exam`, `lsat-blind-review`, `lsat-drills`, `lsat-srs`, `lsat-analytics`, `lsat-tutor`, `lsat-bank`, …), and `AppRoute` entries (nav group/label/order, accent role — add an `'lsat'` accent, preferred layout, search group, `offlineCritical:false`, keyboard scopes, breadcrumbs). The smoke/regression/a11y harnesses pick these up automatically — so each route must render an `expectedText`.
- `src/domains/lsat/`: bring the ported LSAT pages/components here. Wire them under the host's router with their React Query provider scoped to the subtree (one `QueryClientProvider` mounted at the `/lsat` boundary, not app-global, to avoid touching CFA pages).
- Point the LSAT api client's base URL at `http://localhost:8100` (via the host's settings, defaulting to that port). Reuse LSAT Lab's existing graceful "backend unavailable" states; mirror QuantVault's actionable sidecar-down messaging.
- GitNexus: `impact` on `routeManifest` exports + `domains`/`catalog` consumers before editing (these are high-fan-in); `route_map` on the host to confirm no route collisions; `detect_changes` pre-commit. Cross-check with the LSATLab graph via `query` (group mode) to ensure no page depends on a backend route we haven't bundled.
- Gate: `/lsat` dashboard renders; nav shows four domains; `smoke` + `browser:regression` pass over the expanded manifest; CFA/Quant/Excel untouched (Dexie tests still green).

### Phase 4 — Shared surfaces (settings, model config, theme, nav)
- **Model/LLM settings:** unify the "where is my local model" surface. LSAT's backend reads its own provider config; expose it in the host's System Health → Local AI panel (LM Studio/Ollama URLs) and pass through to the LSAT sidecar via env/IPC so the user configures models once.
- **Theme:** confirm `data-theme` light/dark/system drives LSAT pages through the token bridge from Phase 2.
- **Storage Backend panel:** document that the cutover toggle governs *Dexie↔SurrealDB for CFA-family data only*; LSAT's SQLite is independent. Avoid implying it migrates LSAT data.
- **Top nav / command palette / keyboard help:** ensure LSAT routes appear in ⌘K search and the `?` help dialog (they will, via `routeManifest`, if `searchGroup`/`keyboardScopes` are set).
- Gate: one settings pass configures models for both worlds; theme consistent; a11y check green.

### Phase 4.1 — Unified cross-domain review queue (decision §8.6)
The host has client-side `ts-fsrs` review items (CFA/Quant/Excel, in Dexie via `reviewItems`); LSAT has server-side Python `fsrs` `SRSCard`s behind `/api/srs`. Unify the *surface*, not the engines:
- Define a domain-agnostic **`UnifiedReviewItem`** view-model: `{ domain, sourceId, title, dueAt, retrievability?, lastReviewedAt, deepLinkPath }`.
- Add a **review-source provider interface** with two adapters: (a) a Dexie adapter that maps the host's `reviewItems` (already exposed via the `StorageDriver`); (b) an HTTP adapter that calls the LSAT sidecar's `/api/srs/queue` (or equivalent) and maps `SRSCard` → `UnifiedReviewItem`.
- Build a **Today / Review Inbox** that merges both providers, sorts by `dueAt`, and deep-links each item back into its domain's review flow (CFA quiz review vs. LSAT blind-review/drill). Grading stays in each domain's native engine — the inbox only aggregates "what's due" and routes the user there.
- Degrade gracefully: if the LSAT sidecar is down, the inbox shows CFA-family items only with a "LSAT reviews unavailable (backend offline)" note.
- GitNexus: `query` both repos (group mode) for the existing "due review" flows (`rankReviewItems`/`isDue` in host; `/api/srs/next` in LSAT) so the adapters reuse, not duplicate, due-logic. `impact` on host `reviewItems`/scheduler consumers before adding the provider layer.
- Gate: the inbox shows due items from both worlds, routes correctly, and the host's existing FSRS tests still pass.

### Phase 5 — Content & import wiring (licensing simplified — personal use only, §8.3)
- Wire LSAT Lab's PDF/dataset **import** flows (`import_pdf.py`, `import_dataset.py`, quarantine/approval gate) into the host UI under `/lsat` (or System Health).
- Since the product is **personal-use-only and never distributed**, there is **no commercial licensing gate**: user-owned PrepTest imports + research datasets (ReClor/AGIEval) are fine for personal study. Keep it light: (a) content provenance (`PrepTest.source`) visible in the bank UI, (b) a short `docs/CONTENT-LICENSING.md` ("personal use only; do not redistribute; copyrighted content stays out of the repo"), (c) never commit official/copyrighted content to git.
- Future work (NOT this merge): converging QuantVault's `desktopIngestion.ts`/pdfjs with LSAT's `pymupdf` import (different schemas); converging LSAT's `sqlite-vec` RAG with the host's `localRag.ts` (keep separate for now — both already local).
- Gate: a user can import an owned PrepTest PDF into `/lsat`, it lands quarantined, gets approved, and appears in the bank — all offline.

### Phase R — Umbrella rebrand to "StudyVault" (decision §8.5, FINAL)
- Rebrand outward-facing identity: `productName` "StudyVault" + window titles in `tauri.conf.json`; **bundle identifier** `com.quantvault.app → com.studyvault.app` (note: changing the identifier changes the app-data dir, so do this *before* users have real LSAT data, or ship a one-time data-dir migration); `package.json` `"name"`; README; app icon/wordmark; home dashboard title.
- **Do NOT** rename the internal `.qv-*` CSS utility prefix / `qv-*` token names — pure churn, no user value; they stay as an internal code prefix.
- Gate: app launches as StudyVault under the new identifier; data-dir migration (if any) verified.

### Phase 6 — Packaging, release, and CI
- `tauri.conf.json` `bundle.resources`: include `resources/services/lsat-backend/` (built binary). Add `build:lsat-binary` to the release flow (`.github/workflows/release.yml`) so the matrix builds the LSAT sidecar per-OS alongside open-notebook. Installer size ~240MB+ is **accepted** (§8.2) — no on-demand-download mechanism.
- Update `docs/PACKAGING.md` with the LSAT sidecar (build, port 8100, env, app-data DB path, seed bootstrap).
- Bump versions (`package.json` / `tauri.conf.json` / `Cargo.toml`) to a minor signalling the umbrella + LSAT domain (e.g. v0.9.0). Update `CHANGELOG.md` + `docs/ROADMAP.md` (add "LSAT domain" + "umbrella rebrand" + "unified review queue" pillars).
- Gate: `npm run tauri:build:debug` produces an installer that launches under the new brand, supervises 4 sidecars, and serves `/lsat`.

### Phase 7 — Verification, docs, memory
- Full gate sweep: `npm run verify`, `cargo test`, `smoke`, `browser:regression`, `visual:regression`, `a11y:check`, `npm audit`. Add LSAT-specific vitest coverage for the domain registration + api-base wiring; keep the Python backend's pytest suite runnable from `services/lsatlab-backend/`.
- GitNexus: re-`analyze` the host repo so CFAPrep's index reflects the new domain; run `detect_changes` on the final diff; spot-check `impact` on the touched shared symbols one last time.
- Update agent memory (see §10) and `docs/ROADMAP.md`.

### (Deferred / explicitly out of scope for the merge)
- Unifying spaced repetition across domains (one review inbox over both `ts-fsrs` and Python `fsrs`).
- Unifying the two PDF pipelines / the two RAG paths.
- Migrating LSAT off SQLite onto the StorageDriver abstraction.
- Single-binary backend consolidation (open-notebook + LSAT in one Python process).

---

## 7. Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | 2.4GB DB / 11GB tree pollutes host git history (esp. now we VENDOR into one monorepo, §8.1) | HIGH | Phase-0 `.gitignore` (`*.db`, datasets, `.venv*`) *before* vendoring; copy **tracked source only** (not the working tree); seed-DB bootstrap; `git status` + repo-size check pre-commit; confirm LSAT Lab isn't committing its own `lsatlab.db` |
| R2 | Frontend toolchain skew (React 18→19, Vite 5→8, TS 6) breaks LSAT pages | HIGH | Phase 2 is a dedicated compatibility pass with its own gate before any mounting |
| R3 | Tailwind fights the host's token/`.qv-*` system | MED | Scope Tailwind under `.lsat-root` + cascade layer; theme-bridge tokens |
| R4 | Two Python sidecars bloat the installer (~240MB+) | MED | Accept for v1; follow-up: shared Python runtime or on-demand backend download |
| R5 | Port/CSP/firewall conflicts (8100) | MED | Centralize ports; add to CSP `connect-src`; readiness probe; configurable port |
| R6 | LSAT content licensing (LSAC PrepTests, ReClor) | LOW (downgraded — personal use only, §8.3) | No commercial gate needed; keep content out of the repo + provenance in UI + a short personal-use `docs/CONTENT-LICENSING.md`. Risk is only "don't accidentally commit copyrighted content or ever redistribute." |
| R7 | React Query provider leaks into CFA pages / global state collisions | MED | Mount `QueryClientProvider` only at the `/lsat` boundary |
| R8 | Regression harness (`routeManifest`-driven) fails on new routes missing `expectedText` | LOW | Every new `AppRoute` ships with rendered expected text; run `smoke` per phase |
| R9 | Supervisor change destabilizes existing sidecars | MED | GitNexus `impact` on `build_sidecar_specs`/`spawn_sidecars` before edit; the spec list is additive + unit-tested |
| R10 | Backend port assumptions hardcoded in LSAT frontend | MED | Route base-URL through host settings; grep the OpenAPI client for absolute URLs in Phase 3 |

---

## 8. Decisions — RESOLVED (2026-06-13)

All six locked by the user; the plan above/below is updated to match.

1. **Repo layout → VENDOR into a single monorepo.** (User: "you pick what's best.") Decision: vendor LSAT Lab's backend **source-only** into the umbrella repo at `services/lsat-backend/` (and the LSAT frontend into `src/domains/lsat/`), making one repo / one CI / one release that matches the umbrella-rebrand intent. The standalone `LSATLab` repo becomes the archived pre-merge source of truth. **Mandatory** `.gitignore` discipline (R1) keeps `*.db`, datasets, and `.venv*` out of history — confirm before the first vendoring commit that LSAT Lab isn't *committing* its 2.4GB `lsatlab.db` (if it is, vendor via `git rm --cached` semantics, copying only tracked source). Submodule was the alternative; rejected because the product is consolidating under one brand and the user develops solo (submodule checkout/CI overhead buys nothing here).
2. **Installer size → ACCEPTED.** ~240MB+ (two bundled Python backends) is fine. No on-demand-download mechanism needed; drop that alternative from Phase 6.
3. **Commercial intent → NEVER (personal use only).** Simplifies Phase 5 + R6 dramatically: no commercial licensing gates, no ReClor/AGIEval build-flag exclusion machinery. Personal-use of user-owned PrepTest imports + research datasets is fine. Keep only: (a) content provenance carried through the UI, (b) a short `docs/CONTENT-LICENSING.md` stating personal-use-only / do-not-redistribute, (c) never commit copyrighted content to the repo.
4. **Frontend → PORT into the host React app.** Native pages under `/lsat` (no iframe). Phases 2–3 as written.
5. **Branding → REBRAND to "StudyVault"** (FINAL — user's pick 2026-06-13). Keeps the established *-Vault* lineage (host is QuantVault; there's already a `vault` route domain + StorageDriver "vault" naming) while signalling multi-subject study/prep. Adds a rebrand workstream (new §6 Phase R, folded near packaging). Scope: product name + window titles + bundle identifier (`com.quantvault.app` → `com.studyvault.app`) + `package.json` name + docs + README + app icon/wordmark. **Defer** renaming the internal `.qv-*` CSS utility prefix and `qv-*` token names (huge mechanical churn, zero user-facing value) — keep them as an internal code prefix.
6. **Scheduling → UNIFY (near-term).** Build a single cross-domain review queue. Expands Phase 4 with a "unified review inbox" workstream — see new §5.1.

---

## 9. GitNexus workflow for executing this merge (efficiency mandate)

Both repos are indexed (`CFAPrep`, `LSATLab`). Use GitNexus instead of grep/manual tracing throughout — and **keep this practice in project memory** (done; see §10):

- **Before editing any shared host symbol** (`build_sidecar_specs`, `services_dir_search`, `spawn_sidecars`, `routeManifest` exports, `domains`/catalog consumers, `App` router): `mcp__gitnexus__impact({repo:'CFAPrep', target:'<symbol>', direction:'upstream'})` → report blast radius/risk before touching it.
- **To find seams** (where to mount, what consumes what): `mcp__gitnexus__query({repo:'CFAPrep', query:'…'})` and on the source `query({repo:'LSATLab', …})`.
- **For 360° on a symbol:** `mcp__gitnexus__context({name})`. **For API surface:** `route_map`/`api_impact` on LSATLab to enumerate the endpoints the frontend depends on (so Phase 1 bundles a backend that actually satisfies the client).
- **Cross-repo contract tracking:** create a **GitNexus group** (`group_list`/`group_sync`) containing both repos so the OpenAPI/api.gen.ts contract between LSAT frontend and backend is tracked as we move files — `query`/`context` accept `@<group>` mode.
- **Before every commit:** `mcp__gitnexus__detect_changes({repo:'CFAPrep'})` to confirm the diff only touches expected symbols/flows; re-`analyze` after large moves so the index stays fresh.
- **Renames/moves** (e.g. vendoring backend, renaming a domain id): use `mcp__gitnexus__rename` rather than find-and-replace.

CLAUDE.md in the host repo already mandates `gitnexus_impact` before edits and `gitnexus_detect_changes` before commits — this merge must honour that.

---

## 10. Agent-memory plan (persisted this session)

Written to `…/memory/`:
- **feedback / `merge-workflow-gitnexus-memory.md`** — use GitNexus (both repos indexed) + agent memory for efficiency on this merge; the why + how-to-apply.
- **project / `lsatlab-merge.md`** — the merge project: source/host locations, Option A decision, this plan's path, open decisions, phase status.
- **reference / `indexed-repos-gitnexus.md`** — both repos' GitNexus names/paths/last-commit so future sessions skip rediscovery.

(MEMORY.md index updated with one-line pointers.)

---

## 11. Effort & sequencing summary

| Phase | Theme | Relative effort | Risk |
|---|---|---|---|
| 0 | Hygiene + monorepo vendoring prep | S | — |
| 1 | LSAT backend → vendored, bundled, supervised sidecar | M (reuses proven pattern) | MED (R1,R9) |
| 2 | Frontend toolchain reconciliation | **L (the real work)** | HIGH (R2,R3) |
| 3 | Domain registration + page mount | M | MED (R7,R8) |
| 4 | Shared settings / theme / nav | S–M | LOW |
| 4.1 | Unified cross-domain review queue (§8.6) | M | MED |
| 5 | Content / import (licensing light, §8.3) | M | LOW (R6 downgraded) |
| R | Umbrella rebrand → "StudyVault" (§8.5) | S | LOW |
| 6 | Packaging / release / CI | M | MED (R4,R5) |
| 7 | Verification / docs / memory | S | LOW |

**Critical path:** Phase 1 (backend bundling — cheap thanks to the open-notebook precedent) and Phase 2 (frontend port — the genuine cost) run in parallel; Phase 3 depends on both. Phase 4.1 depends on 3 + the live LSAT sidecar. Phase R (rebrand) is independent and can land any time before 6. Everything else is linear.

> Nothing in this document has been implemented. Resolve §8 with the user, then execute phase-by-phase with the §9 GitNexus discipline, committing at each green gate.
