# StudyVault — Seamlessness + Polish Plan

> Status: **PLAN ONLY — no implementation.** Authored 2026-06-13, after the
> LSAT→StudyVault merge (v0.9.0, all merge phases done; gates green).
> Method: an 8-dimension analysis swarm (read-only) over the merged tree →
> 66 findings → adversarial synthesis; grounded against a fresh GitNexus
> re-index of the merged repo (**20,724 nodes / 35,796 edges / 768 clusters**).
> Goal: (A) make the host↔LSAT integration feel like **one product**, and
> (B) **polish the whole codebase** (tests, types, perf, CI, docs, dead code).

---

## 0. TL;DR — the single highest-leverage move

**Phase 1 → S1: design-token unification (M effort).** It resolves the most
-cited issue (6 of 8 analysts flagged "two design systems"), needs no router or
shell refactor, is reversible, and delivers the "one product" feeling the whole
goal hinges on. Everything else sequences around it.

The plan is four phases: **Quick Wins (week 1)** → **Visual coherence + CI
safety net (wks 2–4)** → **Backend/release hardening (wks 3–5)** → **Unified
shell + palette (wks 5–9)**, with **type/quality cleanup** running continuously.

---

## 1. The current seams (why it still feels like two apps)

The merge mounted LSAT natively, but four structural splits remain visible:

1. **Two design systems.** Host = CSS `@layer tokens` + `.qv-*` utilities + raw
   hex palette (`src/index.css` ~2800 lines, `src/styles/tokens.css`); LSAT =
   Tailwind 3 + Radix + HSL CSS-var tokens (`src/domains/lsat/index.css`). The
   theme bridge syncs the *name* (light/dark/system) but not the *token
   vocabulary*, so fonts, accent colors, spacing, radius, shadows, and motion
   differ between `/cfa` and `/lsat`. Host even self-conflicts (radius defined
   differently in `index.css` vs `tokens.css`).
2. **Two shells + two command palettes.** LSAT owns a full AppShell + Titlebar +
   cmdk ⌘K (`src/domains/lsat/components/{app-shell,titlebar,command-palette}.tsx`);
   the host has its own Sidebar/TopBar + ⌘K (`src/components/Layout/TopBar.tsx`).
   No persistent 4-domain switcher inside LSAT; no "back to StudyVault" affordance.
3. **Hard navigation between domains.** `src/main.jsx` branches the router on the
   URL; the dashboard LSAT card is `external: true` → a full page reload on
   switch. Intentional for isolation, but a visible UX seam (reload latency, lost
   scroll/state, no transition).
4. **Coverage island.** The LSAT subtree is excluded from the host's vitest
   (`vite.config.js`), eslint (`eslint.config.js`), and strict tsc (`tsconfig.json`
   + the `@lsat/*` ambient shim) — its tests don't run in CI, it isn't linted or
   type-checked. The Python backend's tests don't run in CI either.

Plus whole-codebase polish debt: ~28 `.jsx` + ~20 `.js` untyped host files; PWA
precaches ~6.3MB (incl. LSAT + kokoro/transformers ML chunks host-only users
never load); duplicate capabilities (error boundary, charts, toast); docs/README
still QuantVault-centric.

---

## 2. Quick Wins — S effort, ship first (Phase 0, ~1 week)

Each is independently shippable, touches no shared rendering path, and several
attack high-impact seams directly. **Q3's timeout pattern (reused from the
proven `lsatReviewBridge.ts`) unblocks all later host↔backend health work.**

| # | Win | Kind | Impact | Where |
|---|-----|------|--------|-------|
| **Q1** | Delete orphaned `src/domains/lsat/main.tsx` (zero importers; `LsatRoot.tsx` is the live mount) | seamless | low | dead code |
| **Q2** | Rebrand the ~6 remaining user-facing "QuantVault" strings → "StudyVault" (OnboardingWizard, PwaInstallPrompt, Dashboard export copy, SystemHealth help text, Today notification). **Skip** CFA author/reviewer metadata + docs/changelog | polish | med | brand |
| **Q3** | LSAT sidecar **health card** on System Health (`:8100/ai/health`) via a new `src/lib/lsatBackend.ts` using the same 2.5s timeout/AbortController pattern as `lsatReviewBridge.ts`; independent `useEffect`, never blocks render | seamless | high | settings/health |
| **Q4** | Host "Test LLM" also probes the LSAT backend's AI health → surfaces silent provider mismatches | polish | med | settings/health |
| **Q5** | Unify `lucide-react` version (host `^1.14` vs LSAT `_meta ^0.518`) to drop a duplicate icon bundle | polish | low | build |
| **Q6** | README + ROADMAP + PACKAGING → StudyVault umbrella; add "Multi-Domain Sidecars" (open-notebook:5055, lsatlab:8100) | polish | high→low | docs |
| **Q7** | Mount `sonner` `<Toaster>` in the host shell (already a host dep, only LSAT uses it) → host gains toasts | polish | low | dupes |
| **Q8** | "StudyVault home" affordance in the LSAT titlebar (one button → `/`) — cheap insurance until the shared shell lands | seamless | low | shell |
| **P1** | Cross-platform sidecar binary paths in `src-tauri/src/lib.rs` (hardcoded `*.exe` breaks macOS/Linux) → `cfg!(windows)` suffix | polish | med | packaging |
| **P9** | Comment the supervisor's dev-vs-prod sidecar divergence (open-notebook `uv run` vs LSAT frozen binary) + startup log lines | polish | low | packaging |

---

## 3. Seamlessness workstreams — ordered by value/effort

### S1 — Design-token unification (single source of truth) — **M · HIGH ⭐**
Create `src/styles/unified-palette.css`: one HSL palette + semantic aliases.
Convert host hex→HSL **preserving current appearance**, then make LSAT's Tailwind
config ingest those vars. Fold in the cheap sub-wins: one derived `--radius`
scale (kill the host's radius self-conflict), standardize fonts on Geist/Newsreader
(add `@fontsource` to host — ~15KB already paid by LSAT), copy LSAT's keyframe
library + `prefers-reduced-motion`, migrate host `--shadow-*` → LSAT's per-theme
`--elevation-*`. **Do NOT build a density-toggle UI** (gold-plating for a personal
app). Kills 6 findings, no router/shell refactor, reversible.

### S2 — Bring LSAT into CI: tests + lint + types — **M→L · HIGH ⭐**
Add a **separate** `lsat-quality` CI job (`cd src/domains/lsat && npm ci && lint
&& test`) + a `lsat-backend-quality` job (`pytest`). Use a vitest **workspace**
with per-project configs/setupFiles (don't force one vitest version — host is v4,
LSAT v2). Keep LSAT's looser TS via project references (`tsc -b`). ~400 LSAT +
~70 backend tests currently never run → silent-regression risk on a just-merged
subtree. Parallel jobs = no host slowdown.

### S3 — PWA precache: stop shipping LSAT/ML chunks to host-only users — **M · HIGH**
`vite.config.js` blanket-precaches ~183 entries/~6.3MB incl. `LsatRoot-*`
(140KB+76KB) and `kokoro` (1.3MB) + `transformers.web` (856KB). Exclude
LSAT/ML chunks from `globPatterns` and serve them `staleWhileRevalidate` on first
`/lsat`/voice use; add LSAT-aware `manualChunks` (none today). Saves ~2.3MB on
cold install. **Risk-guard:** use `staleWhileRevalidate` (not `NetworkOnly`) so
offline still works after the first online visit.

### S4 — Unified command palette (one ⌘K) — **M · HIGH**
Host has a basic TopBar search/palette; LSAT has the richer cmdk modal. Hoist
LSAT's cmdk to the top level, expose `useLsatCommandActions()`, merge both route
sets. Cleanest after S6; partially doable before.

### S5 — Unified model/provider settings — **L · HIGH**
Host stores `local-llm` in Dexie; LSAT stores model routing in its backend SQLite
(`/settings`). Switching LSAT to LM Studio leaves the host on Ollama → silent
mismatch. **Phase A** (after Q3): surface LSAT `/settings` read-only on System
Health + a "Configure LSAT Models" deep-link. **Phase B** (after S1/S6):
bidirectional sync + a host provider toggle.

### S6 — Shared AppShell + unified router (soft navigation) — **L→XL · HIGH · keystone, do later**
Single top-level router; `/lsat/*` lazy under `<Suspense>` (keeps the bundle
split); hoist a `<DomainRail>` (4 domains) + Titlebar/TopBar to a shared layout;
LSAT pages render via `<Outlet/>` instead of owning their shell. Subsumes
"back-to-host affordance," "Review Inbox soft-link" (the bridge already returns
`deepLinkPath` + degrades — soft nav is a **free win** the moment routing
unifies), and "second shell." Highest blast radius → depends on S1 (tokens) + S4
(palette). **Sequence the minimal path first** (visual unification, keep separate
routers); treat the full router merge as an optional Phase 3b.

---

## 4. Polish workstreams — ordered by value/effort

| # | Work | Impact | Effort | Note |
|---|------|--------|--------|------|
| **P3** | Build the Python backends in CI/release (`build:onb-binary` + `build:lsat-binary` job; tauri matrix depends on it) | high | L | **Biggest correctness risk** — a tag can currently ship missing a freshly built sidecar |
| **P4** | CI smoke test: boot each binary on an alt port, poll `/health`→`{ok:true}`, kill | med | M | catches PyInstaller/mypyc runtime failures |
| **P2** | Decide LSAT data dir: keep `%APPDATA%/LSATLab` (reuses existing LSAT data) **vs** scope to StudyVault (unified backup) — see §6 decision | med | S | currently reuses; trade-off below |
| **P5** | Merge the two ErrorBoundary impls (adopt LSAT's richer page/widget + `resetKey` API as shared) | med | M | dupes |
| **P6** | Dedupe D3 / align chart-lib versions (host recharts + @visx@4 vs LSAT @visx@3) via a shared `d3-core-vendor` chunk — **keep both libs** | med | L | build |
| **P7** | Incremental host `.jsx/.js` → TS (`checkJs:false` masks this). Priority: `lib/{localLlm,voice,mockGenerator}.js` → entries → pages → CFA domains; add a pre-commit gate against new untyped files | med | L | continuous |
| **P8** | Docs restructure: `docs/ARCHITECTURE.md` (umbrella) + `docs/LSAT-INTEGRATION.md`; prune the 31 vendored `docs/lsat/*` to references | med | L | builds on Q6 |

---

## 5. Phase sequencing

- **Phase 0 — Quick Wins (week 1):** Q1–Q8 + P1, P9. Independent, low-risk,
  immediate "one product" signal; establishes correct binary paths before any
  release work; Q3 unblocks all health work.
- **Phase 1 — Visual coherence + safety net (wks 2–4):** **S1 ∥ S2 ∥ S3** — no
  interdependencies, fully parallelizable. After this, `/cfa` and `/lsat` look
  identical, every test runs in CI, and host-only users stop downloading 2.3MB of
  LSAT/ML. **Best value/effort ratio in the plan.**
- **Phase 2 — Backend integration + release hardening (wks 3–5, overlaps P1):**
  **P3 → P4 → S5-Phase-A.** P3 first — it's the single biggest correctness risk.
- **Phase 3 — Unified shell + palette (wks 5–9):** **S6 (minimal path) → S4 →
  S5-Phase-B.** The keystone seamlessness work; depends on Phase 1 tokens. Defer
  the full router merge to a Phase 3b if the minimal path proves stable.
- **Phase 4 — Type & quality cleanup (continuous, from wk 2):** P5–P8 as
  background workstreams; P7 incremental, never blocks a phase; P8 docs trail
  Phase 3 decisions.

**Deferred / dropped:** density-toggle UI; full recharts→visx migration; a fully
unified onboarding wizard (use a shared first-run flag + one LSAT mention in the
host wizard instead); Tailwind v4 / full design-system rewrite.

---

## 6. Decisions for the user

1. **LSAT data directory (P2).** Keep the current `%APPDATA%/LSATLab` default
   (StudyVault **reuses** any data from a prior standalone LSAT Lab install) **or**
   scope it to a StudyVault app-data dir (cleaner unified backup/export, but a
   fresh start that won't see existing LSAT progress)? *Recommendation: keep reuse
   for now (preserves your data); revisit when unified backup/export is built.*
2. **Router unification depth (S6).** Ship only the **minimal path** (shared
   shell + visual unity, keep the two routers) — or also pursue the **full router
   merge** (LSAT out of its own `BrowserRouter`)? *Recommendation: minimal path
   first; full merge optional later.*
3. **Scope of this effort.** Approve the full 4-phase plan, or start with just
   **Phase 0 + Phase 1** (the highest-ROI slice) and reassess?

---

## 7. Top risks

1. **Token unification (S1) regresses one theme** — host hex→HSL + re-theming
   shadows for light mode (host shadows are dark-only today) is where appearance
   can drift. *Mitigate:* convert to visually identical HSL first (no value
   changes), snapshot both themes in both domains before/after, land light-mode
   shadow re-theming as a separate reviewable diff.
2. **Vitest version coordination (S2)** — a naive single-runner workspace breaks
   LSAT's v2-era tests. *Mitigate:* separate jobs + per-project configs, not one
   forced version.
3. **Router unification (S6) has the highest blast radius** (providers, basename,
   theme, palette at once). *Mitigate:* minimal path first; full merge only after
   Phase 1 + shared shell are stable.
4. **PWA precache change (S3) could break offline** for an offline-first app.
   *Mitigate:* `staleWhileRevalidate`, verify offline `/lsat` after first online
   visit.
5. **Release backend build (P3)** lengthens CI and can fail on PyInstaller quirks.
   *Mitigate:* P4 smoke test + gate the tauri matrix on `build-backends`.
6. **Two `@/` aliases** — any CI/tsc/workspace unification (S2) must preserve the
   most-specific-first ordering (`@lsat` before `@` in `vite.config.js`) or LSAT
   imports silently resolve to host files.

---

## 8. Execution discipline — GitNexus + memory

- The merged repo is freshly indexed in GitNexus (**CFAPrep** = 20,724 nodes).
  Per CLAUDE.md, before editing any shared symbol touched by these workstreams
  (`build_sidecar_specs`, `services_dir_search`, `routeManifest`, the theme
  module, `SystemHealth`, `main.jsx`), run `gitnexus_impact` first and
  `gitnexus_detect_changes` before each commit. Use `gitnexus_query` to locate
  seams; the **LSATLab** index covers the vendored subtree.
- Each phase ends green on `npm run verify` + `cargo test` + (post-S2) the LSAT
  test/lint jobs, and is its own commit — same cadence as the merge phases.
- Persist decisions + status to agent memory ([[lsatlab-merge]],
  [[merge-workflow-gitnexus-memory]]) as workstreams land.

> Nothing here is implemented. Resolve §6 with the user, then execute
> phase-by-phase, starting with the Phase 0 Quick Wins + Phase 1 S1 (the single
> highest-leverage move).
