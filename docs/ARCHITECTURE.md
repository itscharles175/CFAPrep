# StudyVault — Architecture

StudyVault is a **local-first, fully offline** study OS that bundles two large
apps into one desktop window (Electron) and one web bundle (Vite):

- the **host** — CFA / Quant / Excel prep (the original QuantVault), and
- the **LSAT domain** — Law School Admission Test prep (vendored from LSAT Lab).

They share one window, one bundle, one top-level router, and one theme. Each
domain retains its own feature modules and data layer. Everything runs on the
user's machine — no cloud, no account, no API keys.

> This is the umbrella overview. For how the LSAT app is embedded, see
> [LSAT-INTEGRATION.md](LSAT-INTEGRATION.md). For packaging the desktop app and
> its Python sidecars, see [PACKAGING.md](PACKAGING.md) and
> [PACKAGING-PYINSTALLER.md](PACKAGING-PYINSTALLER.md). The merge history is in
> [LSAT-LAB-MERGE-PLAN.md](LSAT-LAB-MERGE-PLAN.md); the polish roadmap in
> [STUDYVAULT-POLISH-PLAN.md](STUDYVAULT-POLISH-PLAN.md). The desktop shell was
> Tauri 2 until 2026-07-16 — see
> [decisions/2026-07-23-electron-desktop-runtime.md](decisions/2026-07-23-electron-desktop-runtime.md)
> for what that migration gained and lost. Its verification-debt section is a
> historical snapshot; current evidence lives in
> [STUDYVAULT-1.0-IMPLEMENTATION-LEDGER.md](STUDYVAULT-1.0-IMPLEMENTATION-LEDGER.md).

---

## 1. The two apps in one window

|           | Host (CFA/Quant/Excel)                                                                              | LSAT domain                                                            |
| --------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Source    | `src/` (top level)                                                                                  | `src/domains/lsat/` (vendored)                                         |
| Framework | React 19 · Vite 8 (rolldown) · TS 6 (strict)                                                        | React-18-era code, runs on the host's hoisted React 19                 |
| Styling   | CSS `@layer tokens` + `.qv-*` utilities, raw hex palette (`src/index.css`, `src/styles/tokens.css`) | Tailwind 3 + Radix + HSL CSS-var tokens (`src/domains/lsat/index.css`) |
| Data      | Dexie / IndexedDB (SurrealDB cutover available)                                                     | FastAPI + SQLite backend **sidecar** on `127.0.0.1:8100`               |
| Charts    | recharts                                                                                            | @visx                                                                  |
| Router    | Owns the single top-level `BrowserRouter`                                                           | routes are re-based beneath `/lsat` inside the host router             |

There is **one Vite build**. The LSAT subtree is aliased (`@lsat/*` →
`/src/domains/lsat`) and bundled into its own lazy chunks, so a host-only user
never downloads the LSAT code (and vice-versa).

## 2. Top-level routing (one unified root, soft cross-domain nav)

`src/main.jsx` renders a single application root — `src/components/UnifiedRoot.tsx`
— directly. There is **one** host `<BrowserRouter>` that routes _both_ planes; a
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
> domains booted as a _split shell_ — the entry swapped the host sub-app against a
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

`electron/main.js` creates the hardened desktop process boundary. Renderers run
with `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`.
`electron/preload.cjs` exposes the fixed `window.studyvault` contract; renderer
code never receives raw Node, filesystem, shell, or `ipcRenderer` access.

Production pages are served from the secure, standard `app://studyvault`
protocol. Navigation, new windows, permissions, external URLs, file paths, and
every IPC payload are validated in the main process.

The main-process sidecar supervisor launches and health-checks:

| Sidecar                    | Port | Purpose                                  |
| -------------------------- | ---- | ---------------------------------------- |
| SurrealDB                  | 8000 | the unified local store (cutover target) |
| open-notebook API + worker | 5055 | notebook + RAG (langchain/langgraph)     |
| LSAT backend               | 8100 | LSAT question bank, SRS, AI explanations |

Sidecars ship as **PyInstaller** binaries staged under
`electron/resources/services/` and copied to `process.resourcesPath/services`
by electron-builder. The supervisor verifies provenance, retries an occupied
expected port on a bounded budget and then blocks — never terminating an
occupant it does not own — injects LSAT authentication in the Electron session,
captures redacted logs, restarts owned children with bounded backoff, and
terminates only process trees it launched.

Crash safety is layered. `electron/watchdog.js` starts a detached owned-child
watchdog (`electron/child-watchdog.cjs`) that tracks each launched PID and reaps
it if the main process disappears. On Windows children are spawned
**non-detached**, so libuv's own job object also tears them down with the main
process — which is why an unhealthy watchdog degrades the boot (banner +
`crash_guard_unavailable`) instead of blocking it. `electron/port-sweep.js`
clears owned ports before the first launch and `electron/relocation.js` guards
app-data relocation, both ported from the retired Rust supervisor.

The retired Tauri shell used an explicit Windows Job Object plus
`PR_SET_PDEATHSIG` on Linux. Electron now combines its detached watchdog with
the non-detached Windows spawn policy. `electron/tests/crash-recovery.test.mjs`
covers abrupt parent death, watchdog liveness-poll reaping, ownership rejection,
and the end-to-end orphan guard; the runtime suite also pins relocation behavior
across Windows, macOS, and Linux. These tests restore coverage of the migration
gaps, but code and test presence alone do not establish packaged release
acceptance. See the [implementation ledger](STUDYVAULT-1.0-IMPLEMENTATION-LEDGER.md)
for the current evidence boundary.

## 5. Quality gates (CI)

- **`.github/workflows/ci.yml`** — parallel jobs; the load-bearing ones:
  - `quality` — host `lint` + `tsc --noEmit` + `test` (vitest `host` project) +
    `build` + bundle/content/no-egress/docs-drift/baseline checks.
  - `lsat-quality` — `tsc -p tsconfig.lsat.json` (strict typecheck of the
    vendored subtree) + the LSAT vitest project (`test:lsat:ci`).
  - `lsat-backend-tests` — the full backend pytest suite behind an 85% floor.
  - `electron-runtime` (**`windows-latest`**) — the only gate over the desktop
    shell. It runs `npm run test:electron`, builds the LSAT sidecar, verifies
    its provenance, smoke-tests it, then packages an unpacked app with
    `electron-builder --dir` and asserts the executable and staged sidecar
    exist. This job replaced the deleted `tauri-rust` Rust gate. The Electron
    suite covers the relocation guard, port sweep, watchdog degradation, abrupt
    crash-path reaping, and the Windows non-detached spawn guarantee.
  - `a11y`, `visual`, `perf`, `lsat-qa-gates`, `lsat-sidecar-smoke` — the
    Playwright/contract lanes.
- **`.github/workflows/release.yml`** (on `v*` tags) — `verify` runs host and
  LSAT typecheck/tests/build plus content, no-egress, sidecar-fetch inventory,
  docs drift, RAG retrieval-eval, citation-faithfulness, generated-content gate,
  source-grounded answer benchmark, explanation-golden, prompt-regression
  fixture, dependency-audit, and deterministic generation-quality regression floors before
  per-OS Electron bundling, which first
  **builds + smoke-tests** the LSAT backend sidecar (`scripts/smoke-sidecar.mjs`,
  `/api/health → {ok:true}`) and fails if a required sidecar is missing.
  open-notebook is built only when the
  `ONB_GIT_URL` repo variable and full-SHA `ONB_GIT_REF` point at pinned source
  (it lives in gitignored `spike/`).

Local: `npm run verify` (host lint + test + **Electron runtime tests** + build) ·
`npm run verify:all` (adds the LSAT typecheck/tests and JUnit reporters) ·
`npm run test:all` (both vitest projects) · `npm run typecheck:lsat` ·
`npm run test:electron`.

> The Electron tests are **not** Vitest. `vite.config.js` excludes `electron/**`
> from the `host` project, so `npm run test:electron` runs every
> `electron/tests/**/*.test.mjs` file under `node --test`.

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
electron/                   Electron main/preload, IPC policy, supervisor, assets
  main.js, preload.cjs      process boundary + the fixed window.studyvault contract
  sidecar-manager.js        sidecar launch/health/provenance/backoff supervisor
  watchdog.js, child-watchdog.cjs  owned-child crash reaping
  port-sweep.js, relocation.js     owned-port sweep, app-data relocation guard
  tests/*.test.mjs          desktop runtime, security, and crash-recovery gates (node --test)
electron-builder.yml        installers, resources, signing/notarization config
services/lsat-backend/      LSAT FastAPI + SQLite backend (committed source)
scripts/                    build-*-binary.mjs, smoke-sidecar.mjs, …
docs/                       this doc + integration/packaging/roadmap
```
