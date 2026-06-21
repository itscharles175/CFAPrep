# StudyVault — Architecture

StudyVault is a **local-first, fully offline** study OS that bundles two large
apps into one desktop window (Tauri 2) and one web bundle (Vite):

- the **host** — CFA / Quant / Excel prep (the original QuantVault), and
- the **LSAT domain** — Law School Admission Test prep (vendored from LSAT Lab).

They share one window, one bundle, and one theme, but each keeps its own router,
design system, and data layer. Everything runs on the user's machine — no cloud,
no account, no API keys.

> This is the umbrella overview. For how the LSAT app is embedded, see
> [LSAT-INTEGRATION.md](LSAT-INTEGRATION.md). For packaging the desktop app and
> its Python sidecars, see [PACKAGING.md](PACKAGING.md) and
> [PACKAGING-PYINSTALLER.md](PACKAGING-PYINSTALLER.md). The merge history is in
> [LSAT-LAB-MERGE-PLAN.md](LSAT-LAB-MERGE-PLAN.md); the polish roadmap in
> [STUDYVAULT-POLISH-PLAN.md](STUDYVAULT-POLISH-PLAN.md).

---

## 1. The two apps in one window

| | Host (CFA/Quant/Excel) | LSAT domain |
|---|---|---|
| Source | `src/` (top level) | `src/domains/lsat/` (vendored) |
| Framework | React 19 · Vite 8 (rolldown) · TS 6 (strict) | React-18-era code, runs on the host's hoisted React 19 |
| Styling | CSS `@layer tokens` + `.qv-*` utilities, raw hex palette (`src/index.css`, `src/styles/tokens.css`) | Tailwind 3 + Radix + HSL CSS-var tokens (`src/domains/lsat/index.css`) |
| Data | Dexie / IndexedDB (SurrealDB cutover available) | FastAPI + SQLite backend **sidecar** on `127.0.0.1:8100` |
| Charts | recharts | @visx |
| Router | `react-router` (`BrowserRouter`) | own `BrowserRouter basename="/lsat"` |

There is **one Vite build**. The LSAT subtree is aliased (`@lsat/*` →
`/src/domains/lsat`) and bundled into its own lazy chunks, so a host-only user
never downloads the LSAT code (and vice-versa).

## 2. Top-level routing (one unified root, soft cross-domain nav)

`src/main.jsx` renders a single application root — `src/components/UnifiedRoot.tsx`
— directly. There is **one** host `<BrowserRouter>` that routes *both* planes; a
top-level `<Routes>` selects:

- `/lsat` + `/lsat/*` → `<LsatUnifiedMount>` — the LSAT providers + startup, with the
  vendored LSAT `App` re-based onto the `/lsat` prefix via
  `src/components/RebasedLsatRouter.tsx`, all inside the shared host shell.
- everything else → the host `<App/>` (the host shell + routes).

Both planes share the one history, so crossing `/cfa ↔ /lsat` is a **soft
navigation** — no page reload, no router swap — routed through
`src/lib/domainNav.ts`. The LSAT mount is therefore **persistent**, and its
provider/effect teardown lives in `<LsatUnifiedMount>` for that reason. One-time
host startup (the host CSS world + host bootstrap) is reproduced in `UnifiedRoot`
via the shared `runHostStartupOnce`.

> History: until the **Keystone K4** UI-unification cutover (K4-12/K4-13) the two
> domains booted as a *split shell* — the entry swapped the host sub-app against a
> separate LSAT root, each owning its own `<BrowserRouter>`, with a
> `MutationObserver` keeping only the active domain's stylesheets live so the two
> design systems' global CSS could not conflict. That split shell, its
> CSS-isolation observer, and the per-domain hard reload were all retired; both
> design systems now coexist in one document (reconciled by the K4 reskin). See
> [LSAT-INTEGRATION-UPGRADE-ROADMAP.md](LSAT-INTEGRATION-UPGRADE-ROADMAP.md) §7.

## 3. Shared surfaces (what makes it feel like one product)

- **Typography** — both domains render in **Geist** (sans/mono) + Newsreader
  (serif). `src/styles/unified-palette.css` (`@fontsource-variable/geist*`,
  imported last + unlayered) is the single source for the shared font vocabulary.
- **Theme** — the host (`qv-theme` → `data-theme` attr) is the primary theme
  surface; `main.jsx` bridges its light/dark/system choice into the LSAT key
  (`lsatlab-theme` → `.dark` class) before the LSAT provider reads it.
- **Cross-domain links** — the host dashboard links into `/lsat`; the host
  System Health page surfaces the LSAT backend's liveness + model routing
  (`src/lib/lsatBackend.ts`); the Review Inbox aggregates LSAT due cards
  (`src/lib/lsatReviewBridge.ts`, degrades on timeout).

## 4. Desktop shell + sidecars

The Tauri 2 Rust core (`src-tauri/src/lib.rs`) is a **supervisor**:
`build_sidecar_specs()` returns the local services it launches and health-checks:

| Sidecar | Port | Purpose |
|---|---|---|
| SurrealDB | 8000 | the unified local store (cutover target) |
| open-notebook API + worker | 5055 | notebook + RAG (langchain/langgraph) |
| LSAT backend | 8100 | LSAT question bank, SRS, AI explanations |

Sidecars ship as **PyInstaller** binaries staged under
`src-tauri/resources/services/` (gitignored — built at release time). Paths are
cross-platform (`cfg!(windows)` exe suffix). In dev, open-notebook runs via
`uv run` and the LSAT backend from source; in a packaged build they're the
frozen binaries.

## 5. Quality gates (CI)

- **`.github/workflows/ci.yml`** — two parallel jobs:
  - `quality` — host `lint` + `tsc --noEmit` + `test` (vitest `host` project) +
    `build` + bundle/content checks.
  - `lsat-quality` — `tsc -p tsconfig.lsat.json` (strict typecheck of the
    vendored subtree) + the LSAT vitest project (`test:lsat:ci`).
- **`.github/workflows/release.yml`** (on `v*` tags) — `verify` → per-OS Tauri
  bundle, which first **builds + smoke-tests** the LSAT backend sidecar
  (`scripts/smoke-sidecar.mjs`, `/api/health → {ok:true}`) and fails if a
  required sidecar is missing. open-notebook is built only when the `ONB_GIT_URL`
  repo variable points at its source (it lives in gitignored `spike/`).

Local: `npm run verify` (host lint+test+build) · `npm run test:all` (both vitest
projects) · `npm run typecheck:lsat` · `cargo test` (in `src-tauri/`).

## 6. Source map

```
src/
  main.jsx                  boots the single unified root
  components/UnifiedRoot.tsx one BrowserRouter routing host + /lsat (soft nav)
  App.jsx                   host shell + routes (LSAT mounts at /lsat/* via LsatUnifiedMount)
  index.css, styles/        host design tokens (+ unified-palette.css)
  components/, pages/, lib/  host UI, routes, logic
  domains/lsat/             vendored LSAT app (@lsat/*), re-based under /lsat + Tailwind
  lib/lsatBackend.ts        host → LSAT sidecar health/model client
  lib/lsatReviewBridge.ts   host Review Inbox ← LSAT due cards
src-tauri/                  Tauri Rust core + sidecar supervisor
services/lsat-backend/      LSAT FastAPI + SQLite backend (committed source)
scripts/                    build-*-binary.mjs, smoke-sidecar.mjs, …
docs/                       this doc + integration/packaging/roadmap
```
