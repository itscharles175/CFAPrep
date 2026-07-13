# LSATLab — R8 Visual Transformation: Implementation Plan (for review)

This translates the **what/why** in [docs/17](17-ui-visual-roadmap.md) into the **how**: concrete,
sequenced, file-level work. **Nothing here is implemented yet — this is for your review.** It is a
pure *visual* plan (no new features/screens/data); existing behavior and tests are a regression
guard, not a target to change.

> **Re-verified 2026-05-21** against the post–"12k-quality bank expansion" tree (commit `379ab2f`).
> Five parallel deep-audit passes re-checked every file-level claim. Several were stale — the app
> moved under the plan. The corrections are logged below and folded into the waves. The locked
> **direction** (Quiet Observatory, dark-as-hero) is unchanged; only the *starting facts* and
> *sequencing* moved.

---

## What changed since this plan's first draft (re-verification log)

The bank-expansion round reshaped the frontend more than its commit message implies. What the plan
must now account for:

**Already partly done (so these become "refine," not "build"):**
- **The Dashboard is no longer a flat stack of ~10 equal cards.** It is now ~12 motion-staggered,
  deliberately-weighted sections led by a `ResumeHero` hero, a bare engraved predicted-score
  `StatNumber` (outside any card), a 2-col `TrendChart`+`Countdown` hero row (with a forecast cone),
  and a `lazy()`+`Suspense` below-fold split. (`Dashboard.tsx:31-33,128-380`) The "Console
  recomposition" is now mostly *editing an existing composition*.
- **`rounded-card` (10px) is in use** (22× / 13 files) — no longer a dormant token. But the shadcn
  `Card` primitive still uses `rounded-lg` (`card.tsx:11`), so the *inconsistency* remains.
- **Newsreader is imported** (`index.css:3`) and used as the serif. The `opsz` optical-size axis is
  therefore on disk **and loaded** — but `font-optical-sizing`/`opsz` is still never enabled
  anywhere (grep: 0 hits). The opportunity stands; the framing ("never imported") was stale.
- **Analytics charts already use rich visx portal tooltips** in `DifficultyCurve`, `HeatStrip`, and
  `ContributionHeatmap`. The "bare native `<title>` everywhere" premise is wrong; the real gap is a
  *shared* tooltip/crosshair/legend/reference-line kit (each chart hand-rolls its own).

**Newly relevant surfaces the old plan covered in one line:**
- **Bank is now a 3-tab page** (Browse / Quality / Operations, `Bank.tsx:218-223`): a virtualized
  question browser (`VirtualList`, client-paginated via `bankBrowse.ts` looping the new
  `GET /api/bank/questions`), search + type + difficulty + **training-corpus** filters, soft-delete
  with undo, a `Sheet` preview drawer, a `TagEditor`; a **BankAuditPanel** "quality cockpit" (embed
  coverage, near-dup clusters, generation pass-rate + fail-reason bars, AI-drift re-quarantine, a
  jobs queue); and a dense, utilitarian **Operations** admin console (dataset ingest with the ReClor
  NC gate, bootstrap, backup/restore).
- **New sibling pages:** `Quarantine.tsx` (virtualized triage cards, keyboard A/D) and
  `BankTagReview.tsx` (a real `Table` with `Checkbox`).
- **Import is now a 3-step wizard** (upload → verify → done, `Import.tsx`), with an
  `ImportIntegrityGate` answer-key reconcile flow (a mismatch `Table`) that is the *visual benchmark*
  the rest of Import should rise to. The verify view is `grid-cols-2` with **no `lg:` breakpoint** —
  cramped on narrow widths.

**Corrected claims (don't repeat the old wording):**
- "`shadow-md`/`shadow-lg` leak beside e1–e4" — now confined to vendored shadcn primitives
  (`tooltip`, `select`, `switch`); app cards use `shadow-e*` (38×). Minor.
- "The Reckoning is a 2×2 grid" — it's a **`grid-cols-3` truth table** (header row + header column;
  the 4 outcome cells live inside it). The per-cell `scale:[1,1.06,1]` pulse + `OUTCOME_META` tones
  already exist (`revealed-block.tsx:169`); the reveal is **single-shot**, with no hold/settle beat.
- "`resume-banner.tsx`" — now **dormant**, superseded by `practice/resume-hero.tsx`. Target the hero.

**Newly found defects (fold into the relevant phases):**
- **Real bug:** `Styleguide.tsx:33` hardcodes `graphite-300` as `223 15% 83%` vs `index.css:51`'s
  `223 16% 83%` — a token-drift bug in the visual contract page.
- **The coach renders twice on the Dashboard** (`NarrativeCards` at `:204` *and* a dedicated "AI
  Coach" card at `:351-379`) — visual redundancy.
- **Highlighter fills are fixed `rgba`** (`index.css:260-271`), not theme-aware — they don't adapt to
  dark / high-contrast / focus-paper. (Adds to the theme-aware-highlighter phase.)
- **A third, divergent reading path exists:** `PassagePopout.tsx` uses `whitespace-pre-line`, its own
  non-persisted A−/A+ stepper, and supports no highlights — out of sync with the in-app pane.
- **`.density-pad` has zero consumers**; density's real effect is even narrower than "3 rules."
- **Chart tooltips have a second identity:** the one violet `TooltipContent` vs visx
  `TooltipInPortal` styled with `--popover`. Two tooltip looks.

---

## Grounding: the real current state (token + theme layer)
- `frontend/src/index.css` — token source: `:root` (light), `.dark`, `[data-density="compact"]`,
  `.high-contrast` + `.dark.high-contrast`, `.theme-focus`, and a **6th override: `@media print`**
  (`:279-346`). HSL CSS vars; elevation `e0–e4` (light + dark, dark e1 carries the inset top-edge
  highlight); `--space-unit`, `--measure`. `.theme-focus` still has **no dark variant**
  (`:146-166`); high-contrast still overrides only ~6 tokens (`:130-144`); `.reading p + p` is still
  dead (`:192-194`); `.hl-*` highlight colors are still fixed `rgba` (`:260-271`).
- `frontend/tailwind.config.js` — colors→vars; `verdict`/`graphite`/`tcolor` ramps (tcolor mirrored
  from `lib/labels.ts` — a duplicated source of truth); `sans`/`mono`/`serif`; `fontSize` incl.
  `stat`/`stat-xl` (48/64px) **and** `micro`/`2xs` (9/10px — a legibility concern); `borderRadius`
  incl. `chip` (4px) + `card` (10px); `boxShadow e0–e4`; keyframes
  `shimmer`/`fade-up`/`pulse-soft`/accordion; `tailwindcss-animate`.
- **Theming is fragmented across 5 application channels** owned by 3 modules: `theme-provider.tsx`
  (light/dark/system class), `prefs.ts` (high-contrast class, density attribute, `--measure` inline
  style), and per-screen `.theme-focus` (`Explanation.tsx:211`, `BlindReview.tsx:208`,
  `section-runner.tsx:628`). **Unifying this is the first thing Wave 1 fixes.**
- **No `lib/chartTheme.ts` exists** (still to be created). **No `@media (prefers-reduced-motion)`
  net exists** — only per-element `motion-reduce:` utilities, present on some elements
  (`app-shell.tsx:150`, `states.tsx:35`) but **missing** on `navigator-strip.tsx:85` and the
  streaming caret `Explanation.tsx:550`.

## Guiding implementation principles
1. **Token-first.** Change tokens in `index.css`/`tailwind.config.js`; let components inherit. Most
   "looks" changes touch tokens, not 60 components.
2. **Additive & backward-compatible.** Keep the `hsl(var(--token))` contract so existing components
   re-theme for free. Pure visual → the backend pytest suite (expanded by the bank round) + the
   frontend vitest + Playwright e2e suites stay green and act as the regression guard.
3. **Theme engine before anything theme-dependent.** Unify theming (Wave 1) so every later flourish
   themes correctly in all four themes for free.
4. **Each wave is independently shippable and green.** One branch per wave; merge only on a clean
   gate + visual review.
5. **Acceptance = looks in all 4 themes + reduced-motion + AA, not just "compiles."** Every phase
   lists explicit visual/a11y acceptance, not only the build gate.
6. **Reduced-motion & Okabe–Ito colorblind-safety are hard gates** on every animated/colored change.
7. **Elevate, don't rebuild.** Where the app already moved toward the vision (the Dashboard hero, the
   visx tooltips), refine what exists rather than re-deriving it.

## Verification model (applied to every phase)
- **Automated gate:** `npm run build` (tsc strict) · `npm run test` (vitest) · `npm run lint`
  (0 errors; jsx-a11y at error). Backend untouched, but run `uv run pytest -q
  --ignore=tests/test_live_ollama.py` once at the end since `openapi.json`/the contract is shared.
- **New unit tests** for any new *pure logic*: theme resolution, `chartTheme` scale mapping, and
  (critically) the paragraph-splitter offset preservation (Wave 4.1).
- **Visual review checklist** per touched surface: render in **light / dark / focus-paper /
  high-contrast**; toggle **reduced-motion** (static state exists); keyboard **focus ring** visible;
  **contrast** spot-check (AA) on new color/elevation.
- **The Styleguide is the visual contract:** extend `/dev/styleguide` (`pages/Styleguide.tsx`) to
  render new tokens/components **across all four themes side by side** as each lands — and **fix it
  to read live CSS vars** instead of re-hardcoding the ramps (it currently drifts; see 1.9).
- **e2e smoke** (`e2e/route-smoke.spec.ts`) stays green (routes render, no error boundary).
- **Optional:** Playwright screenshot snapshots per theme for the hero surfaces (visual regression).

---

## WAVE 1 — Foundation (theme engine + visual system + a11y + cleanups)
The structural base. After this, every surface themes/repaints correctly for free. *(Execution is
foundation-first per the locked decision — no separate Wave-0 spike/gate.)*

| Phase | Work | Key files | Notes / risk |
|---|---|---|---|
| 1.1 | **Unified theme engine.** Refactor `theme-provider.tsx` into one provider that owns theme (`light`/`dark`/`focus`/`high-contrast`) **and** density, applying a single source of truth (recommend `data-theme` + `data-density` on `<html>`; keep `--measure` as the one inline-style exception). Promote focus-paper + high-contrast to first-class, selectable in Settings. Migrate the `prefs.ts` HC/density logic + the 3 per-screen `.theme-focus` usages into it. | `theme-provider.tsx`, `prefs.ts`, `pages/Settings.tsx`, `main.tsx` (bootstrap), `index.css` (selectors), `Explanation.tsx`/`BlindReview.tsx`/`section-runner.tsx` (drop per-screen `.theme-focus`) | **Highest structural risk.** Keep the `--token` contract identical; migrate selectors mechanically; verify all 4 themes on every page. Rollback = revert provider + selector commit. |
| 1.2 | **Focus-paper dark variant + deepen high-contrast.** Add the missing dark focus theme (warm sepia-charcoal); extend HC to cards/popovers/semantic colors/elevation (today only ~6 light / ~5 dark tokens). | `index.css` | Fixes the focus-paper white-flash a11y regression. |
| 1.3 | **Light & color system.** Depth-surface tints (`--surface-1/2/3`) wired to the elevation ladder; `--primary` in `oklch`/display-P3 with sRGB fallback (the favicon already ships P3 — pipeline proven); the aurora/glow tokens (`--aurora`, edge-glow); semantic ramps (`--success-subtle` etc.) via `color-mix()` to replace scattered `/15`,`/5`,`/30` opacity improvisations. | `index.css`, `tailwind.config.js` | P3 needs sRGB fallback + test on a non-P3 display. |
| 1.4 | **Materials & depth.** One hairline/radius/shadow language: switch the `Card` primitive to `rounded-card` (resolving the `rounded-lg` vs `rounded-card` split), retire stray `rounded-xl`; add a `--glass` (bg + blur) surface utility for the command palette / popovers / coach dock / sticky headers (`backdrop-blur` is used exactly once today, `PassagePopout.tsx:38`). | `components/ui/card.tsx`, `components/ui/*`, `index.css` | Cross-cutting; visual-only. |
| 1.5 | **Theme-aware chart scales.** New `lib/chartTheme.ts` + `useChartScales()` that remaps the d3 ramps per theme and exposes theme-tokened mark colors. Fix the 3 offenders: `HeatStrip` (`interpolateViridis/Inferno` + `#fff`/`#111` marks), `ContributionHeatmap` (`interpolateViridis`), `GapDumbbell` (`interpolatePuOr`). Leave the already-tokened charts (TrendChart, DifficultyCurve, GapSankey, TimeRidgeline) alone. | `lib/chartTheme.ts`, `components/viz/{HeatStrip,ContributionHeatmap,GapDumbbell}.tsx` | Fixes charts washing out on dark/HC. Add a unit test for the mapping. |
| 1.6 | **Theme-aware highlighter.** Move the fixed `.hl-yellow/green/pink` `rgba` fills (`index.css:260-271`) to per-theme CSS vars; reconcile the toolbar swatch colors (`highlighter-toolbar.tsx` hardcodes `bg-yellow-400` etc.) to the same source so swatch == applied color; keep WCAG contrast of highlighted text in every theme. | `index.css`, `components/question/highlighter-toolbar.tsx`, `highlightable-text.tsx` | The underline/note marker already use `--primary`; bring the highlights in line. |
| 1.7 | **Reduced-motion CSS net + motion-token single-source.** Add an `@media (prefers-reduced-motion: reduce)` block neutralizing `animate-pulse`/`shimmer`/`pulse-soft`/`fade-up`; fix the two ungated sites (`navigator-strip.tsx:85`, `Explanation.tsx:550`) with the in-repo `motion-reduce:animate-none` pattern; single-source the duplicated duration/easing between `lib/motion.ts` and `tailwind.config.js`; optionally adopt the dormant `spring.press`/`scaleIn`/`fadeIn` presets where Wave-2 tactility needs them. | `index.css`, `tailwind.config.js`, `lib/motion.ts` | a11y fix — CSS keyframes currently bypass `MotionConfig`. |
| 1.8 | **Make density real.** Derive card/table/row padding from `--space-unit` (add `--card-pad`/`--row-h`); wire `.density-pad` to actual consumers (it has none today). | `index.css`, `components/ui/card.tsx`, table/list components | Compact mode currently changes ~3 rules with one dead helper. |
| 1.9 | **Track-6 token cleanups + Styleguide truth-fix.** Tokenize the streak `text-orange-500`; add an `<Icon>` wrapper (one stroke + 2–3 sizes; ~292 ad-hoc `h-/w-` sizings today); a real styled thin `ScrollArea` (the primitive is a no-op `overflow-auto` div); single-source the `tcolor` palette to `lib/labels.ts`; bump the `micro`/`2xs` (9/10px) usages off sub-legible sizes where they carry meaning; **fix `Styleguide.tsx` to read live CSS vars** (kills the `graphite-300` 15%-vs-16% drift). | `app-shell.tsx`, new `components/ui/icon.tsx`, `components/ui/scroll-area.tsx`, `pages/Styleguide.tsx`, `tailwind.config.js` | Mechanical; high cohesion payoff. |

**Wave 1 acceptance:** every page renders correctly in all four themes (incl. the new focus-dark);
the 3 d3 charts re-theme; highlights legible per theme; reduced-motion honored end-to-end (incl. the
two formerly-ungated pulses); AA contrast spot-checks pass; the Styleguide shows live tokens with no
drift; full gate green.

---

## WAVE 2 — Brand, tactile components, overlays, command palette
The identity + the feel of touching the app. None of this is theme-dependent after Wave 1.

| Phase | Work | Key files |
|---|---|---|
| 2.1 | **Brand `<Logo>`** from the bespoke P3 violet `favicon.svg` (an aurora-glow flask glyph, currently 100% unused in-app); reconcile `--verdict-500` to the mark's violet; replace **all 7** `FlaskConical` render sites. | new `components/logo.tsx`, `app-shell.tsx:228`, `titlebar.tsx:118`, `BlindReview.tsx:211`, `Exam.tsx:216`, `post-exam-wizard.tsx:64`, `post-exam-hub.tsx:50`, `section-runner.tsx:641`, `index.css` |
| 2.2 | **Type-role layer + enable optical sizing.** Add weight/tracking tokens + roles (display/h1–3/body/caption/overline) so screens stop hand-rolling `font-semibold tracking-tight`; enable `font-optical-sizing: auto` + the Newsreader `opsz` axis so the serif gets true display glyphs at hero sizes; apply the giant-mono-number + serif-sentence pattern to hero spots. | `index.css`, `tailwind.config.js`, hero surfaces |
| 2.3 | **Tactile control system.** Bake `active:scale` press + hover-elevation + transform transitions + a visual `loading` prop into `Button` (none exist today); extend press/hover to `Toggle`/`Switch`/`Tabs`; add an opt-in `interactive` `Card` (hover-lift). Wire the now-single-sourced motion tokens. | `components/ui/{button,toggle,switch,tabs,card}.tsx` |
| 2.4 | **Overlay unification.** Add `zoom`/`slide` enter to `Dialog`/`Dropdown`/`Select` to match `Popover`/`Tooltip` (today they fade-only); give `Sheet` a real slide (it hard-cuts); one frosted scrim; **reconcile the two tooltip identities** (the violet `TooltipContent` vs the visx `--popover` chart tooltip) into one. | `components/ui/{dialog,dropdown-menu,select,sheet,popover,tooltip}.tsx`, the visx chart tooltips |
| 2.5 | **Command palette as a signature surface.** Glass/scale enter, per-row shortcut chips, selected accent bar, group counts, footer hint. | `components/command-palette.tsx`, `keyboard-help.tsx` (Kbd) |

**Acceptance:** brand mark present everywhere the flask was; controls feel tactile; overlays animate
consistently with one tooltip identity; all reduced-motion-gated; full gate green.

---

## WAVE 3 — The three hero surfaces (Console · Reckoning · Cockpit)
Now that tokens + brand + tactility exist, finish the signature surfaces.

| Phase | Work | Key files | Note |
|---|---|---|---|
| 3.1 | **The Console (refine, don't rebuild).** Elevate the *existing* Dashboard composition: promote the bare predicted-score `StatNumber` into the engraved `<Stat>` treatment (mono + aurora + a serif counsel line); give the trend hero row real elevation hierarchy; **dedupe the twice-rendered coach** (`NarrativeCards` vs the "AI Coach" card); replace the centered spinner with a layout-faithful skeleton; retire the dormant `resume-banner.tsx`. No data/logic change. | `pages/Dashboard.tsx`, `components/dashboard/*` (+ a new `focal-wall.tsx` if warranted), `viz/StatNumber.tsx`, `components/states.tsx` | Composition already exists; this is polish + dedupe. |
| 3.2 | **The Reckoning.** Restyle `revealed-block.tsx`: add the missing **hold→settle** beat (a brief darkened hold on the timed-vs-BR answers, then the correct answer settles and the active outcome cell ignites — the `scale:[1,1.06,1]` + `OUTCOME_META` already exist) + a serif verdict line. It's a **`grid-cols-3` truth table**, not a 2×2 — keep that structure; make it the screenshot moment. | `components/blind-review/revealed-block.tsx`, `pages/BlindReview.tsx` | reduced-motion → instant resolve; Test-Mode unaffected; outcome semantics unchanged. Give the page its `PageLayout` chrome (today it's a bare spinner). |
| 3.3 | **The Cockpit + shared chart kit.** Build the *shared* primitives the charts lack: `<ChartTooltip>`+crosshair (unify the per-chart visx tooltips + add a hover crosshair to `TrendChart`, which is brush-only today), `<ChartLegend>`/`<ColorScaleKey>` (HeatStrip + ContributionHeatmap have **no legend**), `<ReferenceLine>`; add `@visx/gradient`+`@visx/pattern` (gradient fills + colorblind-redundant patterns); SVG `pathLength` draw-on. Then restyle the `TrendChart` forecast (it already has projection + nested variance cones — make it the hero "glide path"); give Analytics tabs a hero card + demoted grid (today 5 equal-weight `shadow-e1` walls). | new `components/viz/{ChartTooltip,ChartLegend,ColorScaleKey,ReferenceLine}.tsx`, `components/viz/TrendChart.tsx`, `pages/Analytics.tsx`, `components/analytics/tabs.tsx`, `package.json` | Adds 2 small deps. The d3-ramp theme fix landed in 1.5. |

**Acceptance:** the Console reads as "one truth per room"; the Reckoning feels like a moment; charts
share one tooltip/legend/reference-line identity and read in all 4 themes; full gate green.

---

## WAVE 4 — The surfaces users live & work in (Reading Room + the data surfaces)
Two big surface families. Both are "elevate the existing screens"; the data surfaces are new scope
the old plan barely touched.

### 4A — The Reading Room (timed loop + explanation)
| Phase | Work | Key files | Risk |
|---|---|---|---|
| 4.1 | **Reading substrate** — render passages/stimuli as real `<p>` (engage the dead `.reading p + p`); one authoritative line-height (drop the competing `leading-relaxed`). | `components/question/highlightable-text.tsx`, `annotated-text.tsx`, `index.css` | **Logic risk (real):** highlight/note offsets are absolute char indices over a flat text node; `LineReferenceChips` + `scrollToRange` also assume `\n` lives in the offset space. A naive split that drops `\n` corrupts every saved highlight/note. **Mitigation:** preserve every original character; add offset-preservation unit tests; migrate `highlightable-text` + `line-reference` together; feature-flag the `<p>` renderer. |
| 4.2 | **Ambient timer/pace + calm navigator.** Restyle `ExamTimer` from a badge-that-turns-red-under-2:00 into a graduated/ambient edge instrument (warming hairline); drop the perpetual navigator pulse. | `components/question/exam-chrome.tsx`, `navigator-strip.tsx`, `section-runner.tsx` | Preserve `role="timer"` + the 5:00/2:00/1:00 `aria-live` announcements + Test-Mode integrity. |
| 4.3 | **AI explanation as a first-class reading surface** — move the streamed body off `prose-sm` onto the tuned `.reading` type (it ignores the user's reading-size/serif/measure prefs today); citation↔choice shared accent; keep `aria-live` on the stream and the now-gated caret. | `pages/Explanation.tsx`, `components/explanation/*` | |
| 4.4 | **Reconcile the popout reading path.** `PassagePopout.tsx` uses `whitespace-pre-line` + its own non-persisted A−/A+ stepper + no highlights — bring its typography/measure in line with the main pane so the same passage reads identically. | `components/question/PassagePopout.tsx`, `lib/prefs.ts` | visual consistency only |

### 4B — The data surfaces (Bank · Quarantine · Tag-review · Import) — *purely visual*
These are now substantial screens with real design-system violations. Make them as premium as the
hero pages without changing a single behavior.
| Phase | Work | Key files |
|---|---|---|
| 4.5 | **A provenance badge system.** Map each `QuestionSource` (`official`/`ai_generated`/`sample`/`research`/`reclor`) **plus** the training-corpus flag to one calm, colorblind-safe badge token set; use it everywhere (Browse rows, preview drawer, by-source breakdown, dataset rows) — replacing the two divergent `SOURCE_LABEL` maps and the raw `src.key` text; add a small legend. | new badge tokens in `index.css`/`tailwind.config.js`, `components/ui/badge.tsx`, `Bank.tsx`, `components/bank/question-browser.tsx` |
| 4.6 | **Bank Browse + Quality as designed data surfaces.** Consistent row rhythm in the virtualized list; **add the missing empty + error states** (today just "0 questions shown"); skeleton the stat tiles; unify the 6 audit cards onto `Card`+`shadow-e1`; replace the hand-rolled fail-reason/coverage bars with a shared meter; give warn-states a badge/icon (not color-only); present embed coverage as a designed gauge. | `pages/Bank.tsx`, `components/bank/{question-browser,audit-panel,tag-editor}.tsx`, `components/states.tsx` |
| 4.7 | **Quarantine + Tag-review as a reviewable queue.** Consistent card chrome; an "N remaining" progress header; designed approve/reject verdict chips (instead of `key: value` text and `✓·⚠` glyphs); a visible keyboard-shortcut affordance bar. | `pages/Quarantine.tsx`, `pages/BankTagReview.tsx` |
| 4.8 | **Operations as a sectioned panel + Import as a staged flow.** Convert the faux-card `rounded-md` boxes to nested cards; **swap every raw `<input type="checkbox">` for the `Checkbox` primitive** (`Bank.tsx:285,339,355`, `question-browser.tsx:144`, `Import.tsx:337`) and the raw text input for `Input`; replace the hand-rolled progress bar with the shared meter; add a 3-step stepper header to Import; **make the verify grid stack at `lg:`** (it's `grid-cols-2` with no breakpoint); give the raw-`<pre>` PDF text a designed mono surface; raise the training-corpus opt-in to the `ImportIntegrityGate`'s polish bar (the in-file benchmark). | `pages/Bank.tsx`, `pages/Import.tsx`, `components/import/{import-structure-tree,import-name-field,import-job-history}.tsx`, `components/ui/checkbox.tsx` |

**Acceptance:** the timed loop reads as a calm reading room (real paragraphs, ambient time, no
ungated pulse) with highlights/notes intact (offset tests pass); the data surfaces use only shared
primitives (no raw checkboxes / faux-cards / hand-rolled bars), have empty/error/loading states, one
provenance badge system, and stack responsively; full gate green.

---

## WAVE 5 — Environments, signature details, native depth, app-wide polish

| Phase | Work | Key files | Note |
|---|---|---|---|
| 5.1 | **Themes-as-environments** cross-fade on switch + per-theme atmosphere polish (incl. the new focus-dark). | `theme-provider.tsx`, `index.css` | reduced-motion safe |
| 5.2 | **Signature details** — "First Light" loading identity (boot + the existing `global-loading-bar.tsx` + the LLM "thinking" state) using the brand glyph; the quiet anti-confetti affirmation; **surface the off-screen `RecapShareCard`** (today `fixed -left-[9999px]`, export-only) as a *viewable* engraved "receipt"; the coach-as-counsel serif. Confetti already double-gates reduced-motion — keep it. | `global-loading-bar.tsx`, `motivation/confetti.ts`, `SessionRecap.tsx`/`recap-share-card.tsx`, coach surfaces | |
| 5.3 | **First Light onboarding** — visual welcome staged over the existing goal form (no new data); add the brand glyph (onboarding has no logo today). | `onboarding-wizard.tsx`, reuse `goal-settings-form` logic | |
| 5.4 | **Native vibrancy / Windows Mica translucency.** Add `window-vibrancy` Rust crate + capability grants + `setEffects`; JS/`--glass` fallback when unsupported. | `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `capabilities/default.json`, `tauri.conf.json` | **⚠ Rust — cannot fully verify in this env;** verify with `cargo check`/`cargo clippy` + flag for a build machine. |
| 5.5 | **App-wide motion** — stagger/enter on remaining hard-cut pages; shared-element (`layoutId`) card→detail morphs; calm scroll-linked hero reveal. | page bodies, `lib/motion.ts` | all reduced-motion gated |
| 5.6 | **`PageLayout` header system** (eyebrow/icon/section headers) + remaining utility-page polish + the consistent loading treatment (Dashboard/BlindReview still use bare spinners vs Analytics' gold-standard skeletons). | `page-layout.tsx`, those pages | |
| 5.7 | **Remaining Track-6** — unify error/offline/AI into one "system status" look; KPI count-up from previous value; enrich `Sparkline`. | `states.tsx`, `offline-banner.tsx`, `ai-prereq-banner.tsx`, `viz/StatNumber.tsx`, `viz/Sparkline.tsx` | |

---

## New artifacts this plan creates
- **Components:** `components/logo.tsx`, `components/ui/icon.tsx`, `components/ui/checkbox.tsx` (if
  not already present), `components/dashboard/focal-wall.tsx` (optional), `components/viz/{ChartTooltip,ChartLegend,ColorScaleKey,ReferenceLine}.tsx`, an aurora primitive, skeleton + meter variants. (Plus extending `StatNumber.tsx`.)
- **Lib:** `lib/chartTheme.ts` (+ `useChartScales`).
- **Tokens (index.css):** depth surfaces, aurora/glow, glass, semantic-subtle ramps, P3/oklch
  primary, focus-**dark** theme, deepened high-contrast, the reduced-motion `@media` net, theme-aware
  highlight vars, the provenance badge token set, `font-optical-sizing`.
- **Tailwind:** type-role/weight/tracking, new keyframes (aurora drift, draw-on), single-sourced
  motion values, `tcolor` single-sourced from `lib/labels.ts`.
- **Deps:** `@visx/gradient`, `@visx/pattern` (small, Wave 3); `window-vibrancy` (Rust, Wave 5).

## Risk register
| Risk | Wave | Mitigation |
|---|---|---|
| **Theme-engine refactor** breaks a theme on some page | 1.1 | Keep the `--token` contract identical; migrate the 5 channels mechanically; full 4-theme sweep per page; isolated revertable commit. |
| **Reading paragraph offsets** corrupt saved highlights/notes | 4.1 | Preserve every original character (incl. `\n`); migrate `highlightable-text` + `line-reference` + `scrollToRange` together; offset-preservation unit tests; feature-flag the `<p>` renderer. |
| **Raw-checkbox → `Checkbox` swap** is cross-cutting (5 sites) | 4.8 | Mechanical; verify each form still submits the same value; visual + a11y check. |
| **Native vibrancy** unverifiable here | 5.4 | Isolate to a guarded Rust change + JS/`--glass` fallback; `cargo check`/`clippy` only; flag "needs build machine." |
| **P3/oklch** on non-wide-gamut displays | 1.3 | Always provide sRGB fallback; verify on a standard display. |
| **Styleguide drift** masks real token regressions | 1.9 | Make it read live CSS vars; it then becomes a true regression mirror. |
| **Visual regression** on untouched screens | all | The Styleguide cross-theme gallery + e2e route smoke + optional screenshot snapshots. |
| **Scope creep into features** | all | Hard rule: pure visual; if a change alters behavior/data, it's out of scope. The existing test suites are the guard. |

## Effort & verifiability summary
| Wave | Rough effort | Fully verifiable here? |
|---|---|---|
| 1 — Foundation (theme engine, color/material/motion, a11y, cleanups) | L | ✅ build/test/lint + visual |
| 2 — Brand + tactile components + overlays + palette | M–L | ✅ |
| 3 — Hero surfaces (Console + Reckoning + Cockpit + chart kit) | L | ✅ |
| 4 — Reading Room + the data surfaces (Bank/Quarantine/Import) | L–XL | ✅ (4.1 needs offset tests) |
| 5 — Environments, details, native, app-wide polish | M–L | ⚠ mostly ✅; **5.4 native vibrancy needs a build machine** |

## Decisions (LOCKED 2026-05-21)
1. **Direction: "The Quiet Observatory."** (The Study Journal alternate is shelved.)
2. **Dark is the hero** — dark is the default theme for new installs (light/focus/high-contrast/system stay selectable; saved prefs honored).
3. **Dependencies approved** — `@visx/gradient` + `@visx/pattern` and the `window-vibrancy` Rust crate.
4. **Attempt native vibrancy/Mica (Wave 5.4)** here, verified by `cargo check`; flagged for a build machine for the final visual confirmation.
5. **No Wave-0 pause — implement the entire roadmap, review at the end.** Execution is foundation-first (theme engine + token system land before the hero surfaces, so nothing is built twice).

## Non-goals (reaffirmed)
No new features/screens/data/capabilities; no new themes beyond the four; no 3D/Lottie/heavyweight
deps; no gamified motion. Local-first + the R7 AA bar preserved; reduced-motion + Okabe–Ito
colorblind-safety are hard gates on every change.
