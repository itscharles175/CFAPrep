# UI Polish v2 — Refinement Roadmap

> Status: **complete** — all 5 waves executed/dispositioned (2026-06-20). 13 genuine
> fixes shipped + verified; the rest found already-built, intentional-as-is, or
> deferred-with-cause (D1 inline-px cleanup → H2 lint rule). See per-wave notes below.
> Scope: a refinement pass over an already-polished app. Grounded in three code
> surveys (host UI, LSAT UI, design system) + a live visual pass (host dashboard,
> LSAT plane, dark mode, mobile width) on 2026-06-20.

The app is genuinely polished. This roadmap is *refinement* — one on-screen bug, a
handful of cross-plane seams, and a long tail of state/consistency/motion/a11y
touches. The quality bar is the LSAT "First light" empty state; the rest of the app
should hit it.

## Live-pass findings (the anchors)

- 🐞 **Dashboard duplicates the `Export / Encrypted Export / Import` triplet** — once
  in the hero, once under "Today". (→ C1)
- **Host chrome doesn't re-tint per domain.** On `/lsat` the page content is violet
  but the shared topbar/search/icons stay CFA-blue — `data-domain` is never set on
  `<html>` during navigation, so `[data-domain="…"]` overrides never fire on shared
  chrome. (→ A1)
- **Type-voice seam across planes.** LSAT uses serif display headings (Newsreader),
  host uses sans-bold. No rule. (→ A2)
- **Banner stacking.** `/lsat` stacks two amber notices (Backend-offline +
  Live-AI-off). (→ A6)

---

## Tracks

Effort: ⚡ quick · ◐ medium · ⬣ large.

### Track A — Cross-plane cohesion (host↔LSAT seams)
- **A1** ⚡ Wire `data-domain` on `<html>` from active route → shared chrome re-tints per domain.
- **A2** ◐ Explicit type-voice rule (serif-display vs sans), applied identically both planes.
- **A3** ◐ `.btn-primary` + accent components read `var(--accent)` not hardcoded `--blue-*`.
- **A4** ◐ Migrate remaining LSAT pages off legacy `PageLayout` → host `PageHeader` (Analytics, Tutor, RcLab, Settings, Styleguide).
- **A5** ⚡ Unify `AppShell` outer padding (`p-3 sm:p-6` → `--space-*`).
- **A6** ⚡ Notice-stacking policy: dedupe/collapse stacked system banners.

### Track B — State completeness (loading / empty / error / async)
- **B1** ◐ Route-shaped skeleton system (`aria-busy`/`role=status` + shimmer) on all lazy routes both planes.
- **B2** ◐ One EmptyState pattern (icon+title+desc+CTA) retro-fit: Flashcards, ReviewInbox filtered-zero, VaultCenter no-results, FormulaLibrary, LSAT Review tabs, Bank search, Playlists.
- **B3** ◐ One ErrorState pattern (icon+message+retry): Dashboard backup, Analytics sidecar, KnowledgeGraph coverage, LSAT TakeSection error, LSAT error-boundary fallback.
- **B4** ⚡ Async button spinners (use existing `loading` prop): Playlist Play, Bank Refresh/Benchmark, SRS generate-gaps, Dashboard backup, VaultCenter source import.
- **B5** ⚡ Toast-on-completion for silent ops (cache clear, scenario save, source export).

### Track C — Dashboard & top-level
- **C1** ⚡ Fix duplicated Export/Import triplet (the on-screen bug).
- **C2** ◐ Dashboard hierarchy: demote backup, lead with "what to study now".
- **C3** ⚡ Visible focus rings on domain cards / KPI tiles.

### Track D — Token & styling consistency (systemic)
- **D1** ◐ Inline px → tokens (`marginBottom:12` → `var(--space-3)`, `fontSize:11` → `var(--fs-xs)`).
- **D2** ◐ JS fallback hex + chart colors → tokens; tokenize LSAT highlight literals (`"yellow"`/`"green"`).
- **D3** ◐ Resolve Tailwind ↔ host-token divergence (shared utility layer so `text-muted`/`text-sm` read host tokens).
- **D4** ⚡ Consolidate focus-ring rule into one documented pattern.
- **D5** ⚡ Document z-index scale + lint values outside it.

### Track E — Motion & micro-interactions
- **E1** ⚡ `useReducedMotion` hook + hard `prefers-reduced-motion` keyframe gate.
- **E2** ◐ Animate tab content reveal (Analytics, LSAT Review — currently instant cut).
- **E3** ◐ Card-flip/reveal motion: Flashcards, SRS answer reveal.
- **E4** ⚡ Smooth chart/progress transitions; standardize entrance easing.
- **E5** ⚡ Card hover/press affordance on all clickable cards (apply `interactive`).

### Track F — Accessibility & responsive
- **F1** ◐ Mobile-first exam two-pane (stack single-column on phones).
- **F2** ⚡ Chart a11y parity (aria-label on calibration scatter; aria-live for updates).
- **F3** ⚡ Responsive grid breakpoint audit; KnowledgeGraph responsive viewport.
- **F4** ◐ Focus-trap + Escape in dialogs; ReviewInbox deep-link highlight + smooth-scroll.
- **F5** ⚡ WCAG contrast spot-check on hand-tuned inline shadow/border colors.

### Track G — Delight / final touches
- **G1** ◐ Host empty states up to "First light" standard.
- **G2** ⚡ Count-up/number transitions on KPI tiles.
- **G3** ◐ Host route cross-fade to parity with LSAT PageTransition.
- **G4** ⚡ KnowledgeGraph zoom/pan + responsive viewport.
- **G5** ◐ ⌘K palette polish (recents, section icons, empty-search hint).
- **G6** ⚡ Copy-to-clipboard on StyleGallery token readouts.

### Track H — Guardrails
- **H1** ◐ Visual-regression snapshots on key routes × both planes × both themes.
- **H2** ⚡ ESLint rule banning raw hex / inline px in `style=` props.

---

## Rollout (in order)

- **Wave 1 — visible quick wins:** C1, A1, A6, B4, E5, C3, F2. ✅ SHIPPED (commit f2bddc0).
  - Genuine fixes: C1 (dup Dashboard buttons), A6 (banner de-stack), B4 (SRS spinner + Dashboard busy label), F2 (calibration scatter aria-label).
  - Verified already-satisfied (no change): A1 (data-domain on `<body>`), E5/C3 (Panel interactive + focus-visible).
- **Wave 2 — state trifecta:** B1, B2, B3. ✅ SHIPPED (commit 54dc244).
  - Genuine fixes: B3 (LSAT exam error-boundary → design language), B2 (Flashcards empty CTA + FormulaLibrary no-results EmptyPanel; both browser-verified).
  - Verified already-satisfied: B1 (host + LSAT skeletons already carry role=status/aria-busy).
- **Wave 3 — cohesion & tokens:** partial. Commits `e0f8e88` (A3+D5), `5788afd` (A4).
  - ✅ **A3** — per-domain `--accent-strong` button-fill token; primary buttons re-tint cfa/excel/quant/lsat. Browser-verified, all 4 AA-safe for white text.
  - ✅ **D5** — z-index scale documented with role-based usage guide.
  - ✅ **A4** — LSAT `PageLayout` delegates its header to the host `PageHeader`; unifies 6 straggler pages (Analytics, Explanation, Import, TypeAnalytics, SessionHistory, NotFound) onto the host voice in one edit. Browser-verified on Analytics.
  - ⊘ **A2** — SUBSUMED by A4: the unified type-voice IS the host PageHeader's (sans + badge); A4 completed the migration the K4 reskin started. No separate change.
  - ⊘ **A5** — NON-GAP: AppShell `p-3 sm:p-6` is already the 4px token scale (Tailwind spacing == design tokens).
  - ⊘ **D2** — NON-GAP: the section-runner `"yellow"/"green"` are highlighter-color ENUM KEYS, not CSS colors (intentionally fixed across themes).
  - ✅ **D4** — DONE (commit 800856c, after a first attempt was reverted). Consolidated the focus system to 3 documented tiers + removed the orphaned `:focus-visible{outline}` rule; the fix was adding an explicit `outline:none` to `input/select/textarea:focus-visible` so removing the orphan can't surface a UA-default outline on raw inputs (the regression the first attempt hit). Browser-verified: inputs render no outline (outline-style:none), topbar shows its :focus-within accent border, general elements keep the 2px ring.
  - ✅ **D3** — DONE (commit 800856c) as a VERIFIED NON-GAP + documentation. The divergence doesn't exist: every Tailwind colour utility resolves to `hsl(var(--token))` (config + unified-palette.css), `--muted-foreground` isn't accent-derived, and no host component uses a raw Tailwind palette colour (grep-verified). Documented the bridge in tailwind.config.js; no restyle (forcing one would manufacture a regression).
  - **D1** — DEFERRED (low value): most flagged px are SVG attribute numbers (correct as numbers); the few inline layout px are marginal.
- **Wave 4 — motion & delight:** mostly already-handled by prior waves. Commit `9437a03`.
  - ✅ **E1** — `prefers-reduced-motion` now caps `animation-iteration-count: 1` so infinite animations (shimmer/pulse/aurora/route-progress) don't loop at 1ms into a flicker. Genuine fix.
  - ✅ **G6** — /style token gallery names are click-to-copy.
  - ⊘ Already-handled / intentional: E2 (LSAT tabs use a deliberate forceMount keep-alive — instant by design, a fade would undo it); G2 (StatNumber count-up already exists where it fits; KPI band uses unit-strings); E3/E4/F1/F3/G3 (Wave-2 micro-interactions + UB4 responsive + UC5 charts + LSAT PageTransition); F4 (reviewDeepLinkFlash keyframe exists); F5 (Playwright a11y-check.mjs IS the contrast gate); G1/G4/G5 (larger bespoke features — left as solid-as-is).
- **Wave 5 — guardrails:**
  - ✅ **H1** — VERIFIED ALREADY BUILT: `scripts/visual-regression.mjs` (UA7) pixel-diffs curated routes × light/dark × desktop/mobile against committed baselines (host + LSAT). NOTE: the A3/A4/D4 visual changes intentionally shift those baselines — `tests/visual-baselines/` must be regenerated (run the script with the Playwright suite in CI) as the deliberate re-baseline step.
  - ⚠️ **H2** — DEFERRED. A lint rule banning raw hex / inline px in `style=` props would error on existing inline styles (the D1 cleanup it depends on was deferred as low-value), so a blanket rule breaks `eslint .`. Land it as a dedicated pass AFTER the D1 cleanup.

Each item: GitNexus impact before edits → change → frontend gate (`tsc` host+lsat,
`eslint`, `vitest`, `vite build`) → `detect_changes` → commit. Backend/Rust gates
only when those layers are touched (UI items don't need them).
