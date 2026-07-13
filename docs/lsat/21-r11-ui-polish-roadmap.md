# LSATLab — R11 UI Roadmap: Small Details & Polish (research)

**Scope: pure frontend / UI. The last 2%.** No backend (Codex owns it), no new features, no
redesigns — micro-interactions, spacing/alignment, typography micro-details, theme edge cases, motion
timing, and edge-state nits. **Research, not implementation.** Six parallel read-only "visual" audits
(one per detail category) fed this; every item carries `file:line` evidence + Impact/Effort.

Hard contracts unchanged: WCAG-AA, reduced-motion, all 4 themes, Okabe–Ito data colors, Test-Mode,
local-first.

## Thesis
After R8/R9/R10 the system is genuinely mature, and the scouts confirmed the baseline is strong
(reduced-motion is **comprehensively** gated — no a11y gaps found there; the focus safety-net, Button
tactility, the nav rail, ListRow, charts, `::selection`/scrollbar are exemplary). What remains is a
**tight, high-confidence set of small things**: a handful of genuine *defects* hiding as "polish," plus
a lot of *consistency convergence* — one role implemented several slightly-different ways because three
big rounds propagated fast. Most fixes are **S effort**. Two tiny shared helpers (a `pluralize()` and
importing the existing motion tokens) collapse a large fraction of the list.

---

## Track 1 — Genuine defects (these are bugs, not taste; fix first)

- **1.1 Export share-cards are unreadable PNGs in light / focus-paper / high-contrast.** `recap-share-card.tsx:25` and `milestone-share-card.tsx:16` hardcode a dark-violet gradient background but pull ink from the *active theme's* tokens (`text-foreground`/`text-muted-foreground`). In any light theme the exported PNG is dark-on-dark (effectively blank). The deprecated `downloadRecapPng` did it right (fixed light ink). **Fix:** give the cards fixed light ink (the bg is always dark); also align the capture bg `#0f172a` (`recapExport.ts:11`) to the card's graphite base. **(M / S)**
- **1.2 focus-paper silently strips high-contrast inside reading mode.** `.theme-focus` is a per-container class on the reading surfaces (`Explanation.tsx:230`, `BlindReview.tsx:222`, `section-runner.tsx:719`); it locally redefines `--border`/`--input`/`--muted-foreground` to warm-paper values, overriding the `.high-contrast` hardening on `<html>` — so an HC user loses hardened contrast exactly in the densest reading view. No `.high-contrast .theme-focus` guard exists (`index.css`). **Fix:** add an HC-focus reconciliation block. **(M / M, a11y)**
- **1.3 Pluralization: "1 questions" / "1 cards due".** The codebase pluralizes correctly in ~25 places via `${n===1?"":"s"}`, but ~6 sites were missed — incl. two **aria-labels** (SR announces "1 questions"): `playlist-card.tsx:109`, `app-shell.tsx:224` (SRS badge "1 cards due"), `Quarantine.tsx:84` toast, `Bank.tsx:196` restore toast, `bucket-queue.tsx:159`. **Fix:** a `pluralize(n, noun)` helper in `lib/utils.ts` + adopt at these sites (and going forward). **(M / S)**
- **1.4 Loading→loaded layout shift on Practice + Quarantine.** Both render `<SkeletonList rows>` while the loaded page is a card grid/stats layout — a hard jump (the R9 route-shaped-skeleton migration missed them), and Quarantine also flips its title ("Quarantine" → "Generation quarantine") on load. `Practice.tsx:38`, `Quarantine.tsx:113,130`. **Fix:** `SkeletonListPage` + matching title. **(M / S)**
- **1.5 `ContributionHeatmap` busy-tier hatch is invisible on light themes.** `ContributionHeatmap.tsx:93` hardcodes a `rgba(255,255,255,0.55)` hatch (its sibling `HeatStrip` was modernized to luminance-based ink) — so the colorblind-redundant cue vanishes on light/focus-paper cells. **Fix:** derive the hatch ink from cell luminance like HeatStrip. **(S / S, a11y-redundancy)**
- **1.6 Playlist name can overflow its card.** `playlist-card.tsx:104` uses `truncate` on a flex child with no `min-w-0`, so a long (user-supplied) playlist name pushes the badges out / wraps instead of ellipsizing (PrepTests/recommendation-inbox already do the `min-w-0` pattern). **Fix:** wrap in `min-w-0`. **(S / S)**

---

## Track 2 — Systemic consistency convergence (the bulk of "small details")
*One role, several near-duplicate idioms — flagged independently by multiple scouts.*

- **2.1 The `.type-overline` voice: one role, 5+ hand-rolled recipes.** The same small-caps section label renders at 10/11/12px, 400/500/600 weight, and 0.025/0.09em tracking across ~13 files (`NarrativeCards.tsx:92`, `audit-panel.tsx:250`, `TypeAnalytics.tsx:180`, `section-runner.tsx:626`, `docked-coach.tsx:202`, `focus-quality-card.tsx:92`, …) instead of the `.type-overline` class. They sit side-by-side in analytics. **Fix:** mechanical swap to `type-overline`. (Exclude the export share-cards — deliberate inline styles for html-to-image.) **(M / M)**
- **2.2 Raw shadows leak beside the `e1–e4` scale + two tooltip identities.** `ui/tooltip.tsx:18` is inverted `bg-primary` + `shadow-md` + `rounded-md` + no border, while `chart-kit.tsx` documents "ONE popover identity" (`bg-popover` + `shadow-e2` + `rounded-card`) — two tooltips. Plus `shadow-lg` (switch thumb), `shadow-sm` (tabs + app-shell active pill, rc-line-ruler). **Fix:** reconcile the base Tooltip to the popover identity; map stray `shadow-md/lg/sm` → `e1`. **(M / S)**
- **2.3 Finish the `*-subtle` migration.** Holdouts still hand-mix raw opacity (and `/10`·`/15` ≠ the `--subtle-alpha: 0.12`, so they don't even match the same tone, and skip HC hardening): `ui/alert.tsx:11-17` (`bg-*/10`), `StatNumber.tsx:108` delta chips (`bg-*/15`), plus a tail (`Srs.tsx:327`, `choice-breakdown.tsx:70`, `pre-submit-review.tsx:52`). **Fix:** swap decorative tints to `bg-*-subtle`. **(S / S)**
- **2.4 Motion-token drift: ~14 inline-literal call sites bypass `lib/motion.ts`.** Components hardcode `ease:[0.3,0,0,1]` + off-scale durations (`0.22/0.24/0.28/0.4/0.45`) instead of importing `easing`/`duration` (`revealed-block.tsx:106,153,254`, `ceremony.tsx:63`, `sealed-beat.tsx`, `choice-list.tsx:108`, `question-overview.tsx`, `docked-coach.tsx:123`, `Srs.tsx`). `ReadinessGauge.tsx:84` is the one that does it right. **Fix:** import the tokens; snap stray durations to the scale (or add a token). **(M / M)**
- **2.5 Standardize hover-tint.** Interactive rows use four tints with no rule: `hover:bg-accent/50` (plurality + the `ListRow` primitive), `/60`, `/80`, `hover:bg-muted/50` (table). **Fix:** converge on `hover:bg-accent/50` for rows. **(S / S)**

---

## Track 3 — Density activation (the tokens exist but aren't wired)

- **3.1 `density-gap` is a dead no-op.** It sets `gap` but is only applied to non-flex/grid block containers (`page-layout.tsx:45`, `states.tsx`), so it does nothing — and the page header→content rhythm is locked at a fixed `space-y-4`, **not** density-responsive (defeats the R8 density goal; systemic since every page routes through PageLayout). **Fix:** drive PageLayout's vertical rhythm from `--space-unit`. **(M / S)**
- **3.2 Card/dialog padding free-for-all.** Same "resting card" role pads at `p-4`/`p-5`/`p-6`/`--card-pad` (`KpiRow.tsx:79,101`, `resume-hero.tsx:54`, `first-light-console.tsx:61`, …) — so the Dashboard hero (24px) and Analytics KPI cluster (20/16px) disagree, and the literals ignore compact density. `DialogContent` hardcodes `p-6` (not `--card-pad`). **Fix:** standardize resting cards on `--card-pad`; tokenize dialog padding. **(M / M)**
- **3.3 Add a shared `DialogFooter` + route hand-rolled tables through `Table` with right-aligned numerics + `--row-h`.** ~6 dialogs hand-roll `flex justify-end gap-2` action rows (one defines a private `DialogFooterRow`); hand-rolled tables left-align numeric columns (`timing-budget-table.tsx`) and ignore `--row-h`. **Fix:** export `DialogFooter`; right-align numeric `<td>`; wire table row height to `--row-h`. **(M / M)**
- **3.4 Two small radius/padding seams:** the dashboard skeleton resume-band is `rounded-xl` while the loaded `ResumeHero` is `rounded-card` (corner pops on load, `dashboard-skeleton.tsx:17`); headerless `CardContent` uses `pt-6` vs `pt-[var(--card-pad)]` in two files; page card-grid gutters split `gap-6` vs `gap-4`. **(S / S)**

---

## Track 4 — Micro-interaction & a11y finish

- **4.1 Segmented controls handle hover three ways — and the global header `ModeToggle` has *no* hover affordance** (`app-shell.tsx:522` declares `transition-colors` with nothing to transition). Converge on one (`hover:bg-accent`/`text-foreground`); fix the ModeToggle first. **(M / S)**
- **4.2 `<Button loading>` is used nowhere real.** Five async submit buttons hand-roll a text-swap with no spinner (`Bank.tsx:418`, `Explanation.tsx:488`, `tag-editor.tsx:143`, `smart-set-builder.tsx:234`, `playlist-card.tsx:137`) though the Button ships a polished `loading` prop. **Fix:** adopt `loading={busy}`. **(M / S)**
- **4.3 Highlighter toolbar has no `aria-pressed`/`aria-label` and no focus ring on swatches** (`highlighter-toolbar.tsx:34-79`) — a keyboard/AT user can't tell which pen is active (the eliminate button in `choice-list.tsx:172` does it right). **(M / S, a11y)**
- **4.4 Focus-ring inconsistency.** Some controls show hover-ring but define no `focus-visible` (rely on the global net), so hover and keyboard focus look unrelated (`pre-submit-review.tsx:49`, reading-controls segmented buttons); a third hand-rolled Switch + a raw range input diverge from the `Switch`/`Slider` primitives. **Fix:** add the token `focus-visible:ring` + use the primitives. **(S / S)**
- **4.5 Keyboard + grow-vs-lift nits:** the navigator hover-preview is mouse-only (no `onFocus`, `navigator-strip.tsx:130`); the coach FAB is the only `hover:scale-105` "grow" in an app whose language is lift/press (`docked-coach.tsx:106`). **(S / S)**

---

## Track 5 — Motion timing & typographic finish

- **5.1 Unify the three modal-enter signatures** (Radix `zoom-in-95`/200ms vs motion `scale .97`/.22s vs .32s) by reusing the existing `scaleIn` variant; and **the four progress-fill tempos** (`Progress` default 150ms / meter 500ms / loading-bar 200ms / navigator 300ms) onto one. **(M / S–M)**
- **5.2 Tabs hard-cut the active pill** (`ui/tabs.tsx:29`) while the nav rail slides via `layoutId` — add a `layoutId` underline/pill per `TabsList` (reduced-motion static fallback). *(This is the recurring R10-deferred B2.2; the most-felt motion win on Analytics/Review/Bank.)* **(M / M)**
- **5.3 `transition-all` → specific properties** on the hot surfaces that only change a few (`choice-list.tsx:69` — the most-rendered exam surface; `app-shell.tsx:358` sidebar; others) — jank/perf + matches the explicit-property idiom Button already uses. **(S / S)**
- **5.4 Typographic finish:** add `text-wrap: balance` to the serif `.type-display` h1/h2 (PageLayout + CardTitle display branch) to kill title orphans; switch the **exam timer** digits from `font-mono` to `.type-numeric` (slashed-zero — `exam-chrome.tsx:79`); drop `uppercase` on Title-Case **trap chips** (`choice-list.tsx:151`) to match the analytics casing. **(S / S)**
- **5.5 Microcopy + formatting tail:** raw ISO dates in 6 session-picker labels → `formatDate` (`analytics/tabs.tsx:316`, `SessionCompare.tsx:166`, `heatmap-compare.tsx:157`, `bucket-queue.tsx:145`, `error-log-workspace.tsx:117`); "FSRS schedule" → "spaced-repetition schedule" (`Srs.tsx:60`); a small label map for the raw lowercase session-`type` badges; a one-line comment on the deliberately-static `Sparkline` so nobody "fixes" it into N animations. **(S / S)**

---

## Quick-win cluster (one fast PR, near-zero risk)
Two tiny shared helpers + their adoption knock out a big slice: a **`pluralize(n, noun)`** in `lib/utils.ts` (Track 1.3), and **importing the `easing`/`duration` motion tokens** (Track 2.4). Bundle with: the `*-subtle` swaps (2.3), `text-wrap: balance` headings (5.4), `formatDate` on the ISO sites (5.5), the playlist `min-w-0` (1.6), the dashboard `rounded-card` seam (3.4), and the ModeToggle hover (4.1). All S-effort, all token-driven.

## Already solid — do NOT re-propose
Reduced-motion (every JS spring + the CSS net — **no gaps**), the `:focus-visible` safety net, themed `::selection`/caret, Button tactility + `loading`/`aria-busy`, the nav rail (hover/active/focus/press/collapsed-tooltips/`layoutId`), `ResizableSplit` (full ARIA splitter), `choice-list` (radio semantics + correctness-neutral commit), `ListRow`/`Icon`/`Card` token discipline, `disabled:opacity-50` consistency, en-dash range discipline, and broad `tabular-nums`/`aria-label` coverage.

## Sequencing
1. **Quick-win cluster** (above) — fast, safe, broad.
2. **Track 1 defects** (export PNGs, focus×HC, layout-shift, heatmap hatch) — they're real bugs.
3. **Track 2 convergence** (type-overline sweep, tooltip/shadow identity, motion-token drift) — the bulk of the felt polish.
4. **Track 3 density** (wake `density-gap`, card/dialog padding, DialogFooter/table).
5. **Tracks 4–5** (micro-interaction + motion-timing + typographic finish, incl. the tabs `layoutId`).

## Non-goals
No backend/data/feature work; no new themes; no heavyweight deps; no gamified motion. The four hard
contracts hold on every change.
