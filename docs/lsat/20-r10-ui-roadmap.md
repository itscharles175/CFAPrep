# LSATLab — R10 UI Roadmap: Performance, Perceived Speed & Finishing Craft (research)

**Scope: pure frontend / UI.** No backend, data, or API changes. **Research, not implementation.**
Five parallel read-only audits (3 performance lenses + 2 craft lenses) fed this; every item carries
`file:line` evidence and an Impact/Effort tag.

Hard contracts (unchanged): WCAG-AA, reduced-motion, all 4 themes (light/dark/focus-paper/high-
contrast), Okabe–Ito data colors, Test-Mode integrity, local-first.

> **Direction (chosen):** prioritize **Performance & perceived speed** and **more visual/aesthetic
> craft**, plus genuinely high-impact "finishing" polish that surfaced.

---

## The thesis: the system is built — now make it fast and finish it

R8 built the Observatory; R9 propagated it everywhere. The audits confirm the *system* is mature and
high-quality (tokens, the three type voices, glass/aurora/glow, `card-interactive`, `SystemNotice`,
`ListRow`, the Ceremony frame, the SRS flip, route-shaped skeletons). So R10 is **optimization +
completion**, not new aesthetics:

- **Performance has real, measurable headroom** the visual rounds didn't touch: the timed-exam screen
  re-segments the entire RC passage **every second** (~2,000+ wasted full re-renders per section); the
  first-paint JS bundle eagerly pulls ~60–90 KB gzip it doesn't need (charts, markdown, confetti,
  html-to-image); the most frequent interaction (SRS grading) **waits for the server** before showing
  the next card; and R9's signature effects (infinite `aurora-drift`, `backdrop-filter` glass) now run
  unthrottled, even when the tab is hidden.
- **The craft has cohesion gaps** from rapid propagation: `CardTitle` is still sans while page headers
  are serif (74 sites compensate by hand), ~40 surfaces still hand-mix the deprecated `bg-*/10` tint
  idiom, there's **no motion-driven hover/press layer** (`whileHover`/`whileTap` = zero usage), and the
  state family, toasts, selection, and number/date formatting each speak in two-to-four dialects.

Two tracks below (Performance, Craft) + a short finishing-polish track. Most items are low-risk because
they optimize or complete what already exists.

---

# TRACK A — Performance & Perceived Speed

## A1 — Bundle & asset diet (cut ~60–90 KB gzip off first paint)
The eager `index` chunk (~140 KB gz) statically pulls things that are below-the-fold or event-only.
- **A1.1 Lazy-load the chart vendor off the Dashboard critical path** — `Dashboard.tsx:23,247` eagerly
  imports `TrendChart`, which statically pulls 8 `@visx/*` + d3 (the **~37 KB gz** `viz` chunk) before
  first paint, though the chart sits below the instrument cluster. `lazy()` it. (Import `StatNumber`/
  `TypeBadge` from direct paths so the barrel doesn't drag chart siblings.) **(H / S)**
- **A1.2 Dynamic-import `html-to-image`** — `lib/recapExport.ts:1` top-level imports it; it's inlined
  into the eager `index` chunk via the motivation barrel, but only fires on a "Share PNG" click. Move
  to `await import()` inside the (already-async) export fns. **~7–8 KB gz.** **(H / S)**
- **A1.3 Dynamic-import `canvas-confetti`** — `motivation/confetti.ts:3` eager; only fires on a personal
  best. `await import()` inside `celebratePersonalBest`. **~4 KB gz.** **(M / S)**
- **A1.4 `motion` → `LazyMotion` + `m` + `domAnimation`** — the eager `motion` chunk is **~32 KB gz**
  and ships the full `domMax` (layout/drag projection) feature set, but the app uses only fade/slide/
  scale. `<LazyMotion features={domAnimation} strict>` + codemod `motion.X`→`m.X` across ~30 files cuts
  ~15–18 KB gz. **(M / M — broad mechanical change; `strict` mode + tests de-risk it.)**
- **A1.5 Lazy the markdown renderer inside Explanation** — `react-markdown`+`remark-gfm` (**~47 KB gz**)
  is correctly route-lazy already, but `Explanation.tsx:14` imports it synchronously, blocking the
  explanation shell's first paint. `lazy()` the markdown subcomponent so header/choices paint first.
  **(M / S)**
- **A1.6 Flatten the brand-mark SVG for small uses** — `public/favicon.svg` is ~9.5 KB with **16
  `feGaussianBlur` layers**; it's rendered as `<img>` via `<Logo>` in always-mounted chrome (titlebar,
  sidebar), the boot splash, and the *pulsing* `LoadingState` (re-rasterized each frame). Ship a
  flattened `favicon-flat.svg` (no blur filters) for sizes < ~32px + the splash/loader; keep the full
  mark for hero uses. **(M / S–M)**
- **A1.7 Lazy-mount the `cmdk` dialog** — the palette is in the eager `index` chunk via the app-wide
  provider, but the dialog only renders on ⌘K. Keep the key listener eager; `lazy()` the
  `<Command.Dialog>` body. **(M / S)**
- *Verified already-good (don't touch):* fonts (`font-display:swap`, `wght`-axis only, subset by
  unicode-range), `lucide-react` per-icon tree-shaking, routes comprehensively `lazy()`'d.

## A2 — Render cost (stop the wasted work)
**Zero components use `React.memo` today** (verified) — the biggest structural lever.
- **A2.1 [FLAGSHIP] Isolate the 1-second exam clock from the question tree** — `timeLeft` is `useState`
  inside `SectionRunner` (`section-runner.tsx:179,271`), so every tick re-renders the whole passage +
  choices + navigator. The real cost: `HighlightableText` re-runs `splitParagraphBlocks(text)` +
  per-paragraph boundary scans (`highlightable-text.tsx:207,239`) **every second** — ~2,100 full RC
  passage re-segmentations the user never sees, per 35-min section (measurable CPU + battery drain on
  the hottest, longest-lived screen). Extract a `<SectionClock>` that owns its own tick (or
  `useSyncExternalStore`), so only the numerals re-render. **(H / M)**
- **A2.2 `React.memo` the exam children** — `ChoiceList`, `AnnotatedText`, `HighlightableText`,
  `NavigatorStrip` are plain fns; their props are already mostly `useMemo`/`useCallback`-stable, so memo
  boundaries will hold. Pairs with A2.1 to also absorb focus-mode idle-wake re-renders. **(H / S)**
- **A2.3 Virtualize the Review bucket queue** — `bucket-queue.tsx:175` renders **every** non-`timed_ok`
  attempt across all recent sessions as a flat `ListRow` stream (easily 100–200+ rows), and it's the
  default Review landing surface. Reuse `VirtualList` (the SessionHistory divider pattern is the
  template). It's the only unbounded un-virtualized list left on a primary surface. **(H / M)**
- **A2.4 Memoize the `AnalyticsProvider` context value** — `Analytics.tsx:525` builds the value inline
  with a fresh `setTypeFocus` each render, re-rendering the active tab's charts on every filter/brush/
  cross-filter change. `useMemo` the value + `useCallback` the setters. (Radix unmounts inactive tabs,
  so blast radius is one tab — hence M, not H.) **(M / S)**
- **A2.5 Memoize the `CommandPalette` context value** — `command-palette.tsx:81` builds the value inline
  and wraps the **whole app**; `SectionRunner`'s register effect means **flagging a question or changing
  reading size re-registers actions → app-wide re-render mid-exam**. `useMemo` the value; split stable
  (register/toggle) from volatile (open) context; read `cur.flagged` via a ref so flagging doesn't
  re-register. **(M / S)**
- *Verified already-good:* `staleTime: 30s` global + `keepPreviousData` + `refetchOnWindowFocus:false`
  (no refetch storm); `aurora-drift` is pure CSS (no re-render); `StatNumber` count-up is local-only;
  Bank/SessionHistory/Quarantine/error-log already virtualized.

## A3 — Animation / GPU / paint cost (R9's effects, throttled)
`will-change`, `visibilitychange`, and `IntersectionObserver` usage across `src/` is currently **zero**.
- **A3.1 Pause `aurora-drift` when the tab is hidden** — it's an **infinite** transform+opacity loop on
  every `.aurora::before` (`index.css:463`) with nothing pausing it when backgrounded (a study app sits
  idle for long stretches). A tiny `visibilitychange` listener toggling `animation-play-state:paused`
  on `<html>` stops N loops cold. **(H / S)**
- **A3.2 Cap the breath to the hero; make non-hero aurora static** — a typical Dashboard mounts ~5+
  simultaneous infinite aurora loops (predicted-score + Countdown×2 + Readiness + TodayPlan); Analytics
  similar. Gate the animation behind an `.aurora-breathe` modifier applied only to the page hero; bare
  `.aurora` stays a static glow (visually near-identical at 6–10% strength). Includes A3.3: stop the
  per-cell infinite aurora on **every** ignited blind-review answer cell (`revealed-block.tsx:257`) —
  the drama is the one-shot scale pulse, not a 16s loop. **(H / M)**
- **A3.4 `will-change` hygiene + compositor-only props** — add `will-change:transform,opacity` to the
  *animated* aurora only (scoped, not all — overuse = layer/memory bloat); and `card-interactive:hover`
  animates `box-shadow` (a paint property, `index.css:504`) → switch to an opacity-faded pseudo-element
  shadow so the lift is compositor-only. **(M / S)**
- **A3.5 Cheaper `backdrop-filter` on large Mica chrome** — under `html.mica`, blur runs on the sidebar
  + header + titlebar simultaneously, re-filtering on **every scroll/resize**, and the sidebar's
  `transition-all` animates width *while* a backdrop-filter is live during collapse. For large chrome,
  prefer a higher-opacity tint with zero blur (tokens already make this trivial: bump `--glass-alpha`,
  zero `--glass-blur` on chrome); transition only non-layout props. **(M / M — Win11+Mica only.)**
- **A3.6 Un-stack the command-palette blur** — opening ⌘K renders **two** nested blur layers (overlay
  `backdrop-blur-[2px]` + content `.glass`), atop the 3 chrome blurs under Mica = up to 5 concurrent
  backdrop-filters. Drop the overlay blur (a `bg-background/60` scrim reads identically). **(M / S)**
- **A3.7 Keep Analytics tab content mounted** — Radix `TabsContent` unmounts on switch (no `forceMount`),
  replaying every chart's `draw-on` + visx layout each time, so tabs feel like page loads. `forceMount`
  (CSS-hide inactive) for instant switches; lazily after first visit to bound DOM weight. **(M / S–M)**
- *Verified already-good:* reduced-motion + high-contrast are **complete** for the new effects (the
  global CSS net neutralizes keyframes; aurora/glow → 0 strength + glass → solid in HC).

## A4 — Perceived speed (make it feel instant)
- **A4.1 [FLAGSHIP] Optimistic SRS grading** — `Srs.tsx:93` `await api.srsReview(...)` **before**
  advancing, so the single highest-frequency interaction waits a server round-trip per card. Advance
  immediately, fire in the background (Undo + offline-queue already exist → cheap rollback). **(H / S–M)**
- **A4.2 Optimistic delete / playlist / flag mutations** — `mutations.ts` (delete-question, playlist
  CRUD, add-to-SRS, flag) all `await` then `invalidateQueries` → a refetch-flash delay. Add `onMutate`
  optimistic cache edits + `onError` rollback (TanStack's standard pattern; `useDeleteQuestion`'s
  Undo/restore is the model). **(M / M)**
- **A4.3 Route-chunk prefetch on nav intent** — all 22 routes are `lazy()` with no prefetch, so the
  first visit to Analytics/Bank/Settings shows the skeleton while the JS downloads. Warm the chunk via
  the route's `import()` on sidebar `NavLink` `onPointerEnter`/focus (and the ⌘K list). Data-prefetch
  already exists for sections/preptests — extend the pattern to route chunks. **(M / S)**

---

# TRACK B — Visual / Aesthetic Craft

## B1 — Adoption completeness (the system is built; surfaces lag)
- **B1.1 Cast hero/instrument `CardTitle`s in the serif display voice** — the biggest cohesion gap:
  PageLayout/PageSection/Ceremony titles are serif `.type-display`, but **every `CardTitle` is sans**
  (`card.tsx:41`) and **74 sites** shrink it to `text-base` to compensate. Add an opt-in `voice?:
  "sans"|"display"` prop (default sans) and opt the hero/instrument cards in (leave dense table/settings
  cards sans). **(H / M)**
- **B1.2 Retire the deprecated `bg-*/5·/10·/15` tint idiom for `bg-*-subtle`** — ~40 surfaces still
  hand-mix raw opacity (`NarrativeCards.tsx:58`, `trap-spiral-card.tsx:50`, `Milestones.tsx:137`, …),
  so status tints read inconsistently across themes (raw `/5` ignores the per-theme `--subtle-alpha`).
  Mechanical swap on decorative containers (leave intentional choice-state fills). **(M / S)**
- **B1.3 Route stat figures through `StatNumber`** (count-up + numeric voice) — the recap grid
  (`SessionRecap.tsx:260`), streak figures (`streak-insights.tsx:63`), and the timeline score
  (`SessionHistory.tsx:238`) hand-roll static `stat font-semibold` with no count-up/`.type-numeric`.
  The recap & post-exam scores are emotional peaks — count-up pays off most. **(M / S)**
- **B1.4 Modernize the two laggard motivation cards** — `streak-insights.tsx` + `Milestones.tsx`/
  `MilestoneGallery.tsx` are the most visibly pre-R8 surfaces (ad-hoc lucide sizes, `bg-muted/30`, sans
  numerals, `text-xs uppercase` instead of `.type-overline`), sitting beside polished R9 cards. **Also a
  cohesion decision:** two components solve "milestones" differently — pick one language. **(M / M)**
- **B1.5 `interactive` affordance on genuinely-clickable cards** — `card-interactive` is used in 3 spots;
  PlaylistCard, Drills items, and PrepTests/Bank cards navigate on click but present no hover lift. Add
  `interactive` only where a real click target exists (no false affordance). **(M / S)**

## B2 — A micro-interaction layer that doesn't exist yet
- **B2.1 Motion-driven hover/press for cards & CTAs** — `whileHover`/`whileTap`/`whileFocus` appear in
  **zero** files; all press is CSS `active:scale` and hover is color-only. The `spring.press` token
  already exists unused (`lib/motion.ts:19`). A spring lift on hover + press-down on tap is the
  "web app → native app" difference. **Must use `useReducedMotion` guards** — the global CSS net does
  NOT cover motion/react springs. Highest value on ResumeHero, PlaylistCard, milestone tiles. **(H / M)**
- **B2.2 Sliding `layoutId` active indicator for Tabs** — the nav rail's sliding `layoutId` is lovely,
  but Tabs (`tabs.tsx:29`) hard-cut the active pill via CSS. Analytics (the most tab-heavy flagship)
  would feel markedly more premium with the proven nav-rail pattern (scoped per `TabsList`, reduced-
  motion → static). Same idiom, currently two solutions. **(M / M)**
- **B2.3 The deferred F2.3 morph — a scoped, SAFE slice** — the cross-route card→detail morph stays
  blocked by the global `<AnimatePresence mode="wait">` (`App.tsx:145,498`). But a **within-page expand**
  morph avoids the router entirely and is fully safe: e.g. a SessionHistory timeline row → in-place
  expanded recap, or a PlaylistCard → expanded criteria, with a shared `layoutId` and a reduced-motion
  instant fallback. Ship one in-page expand as the flagship; keep the cross-route version deferred. **(H / M)**

## B3 — Signature moments still missing
- **B3.1 A calm Personal-Best / streak "verdict" moment** — today a PB is just confetti + a static
  `<Badge>` (`SessionRecap.tsx:172`), tonally off-brand for an observatory. The Reckoning proves the
  team can do a restrained ceremonial beat — give a PB/streak-milestone the same calibre (aurora bloom +
  engraved figure + a serif counsel line; soften/retire the confetti). Tie 7/30/100-day streaks in via
  the existing `computeStreak`. **(H / M)**
- **B3.2 Unify the accent-hero panel into one primitive** — the "primary verdict-accented panel" is
  hand-rolled ≥4 ways with **different radii** (ResumeHero `rounded-xl` vs the system `rounded-card`
  10px — a literal corner seam between the hero and everything below) and tints. A `FeatureCard`/
  `AccentPanel` (aurora + `glow-verdict` + `bg-primary-subtle` + `rounded-card`) consumed by ResumeHero,
  NarrativeCards, post-exam score, resume-banner. **(M / M)**
- **B3.3 Hover-preview cards for dense rows** — a genuinely-absent capability: SessionHistory/Bank/
  weakest-type rows navigate on click with no peek. A `HoverPreview` on the existing Popover (hover-
  intent delay, focus-accessible, no-fire-on-touch) adds depth without new screens; start with the
  session timeline. **(M / M)**

---

# TRACK C — Finishing polish (consistency & the "last 10%")

- **C1 The state family** — `ErrorState` is the one system surface with no bespoke art: **17 call sites**
  share a bare lucide `AlertTriangle` (`states.tsx:334`). Add an `illustration` slot + an "observatory
  offline" spot — and **wire the already-built-but-unused `IllustrationOffline`** (`illustrations.tsx:52`,
  zero importers). Fill the ~15 `EmptyState`s still on the generic Inbox fallback (analytics sub-tabs,
  the celebratory "Reviewed N cards" → reuse `IllustrationSrsCaughtUp`). **(H / S–M)**
- **C2 Toasts → the design system + the high-contrast hole** — 112 `toast.*` calls render in sonner's
  stock `richColors` (default font/radius/border), bypassing the token language entirely; and
  `<Toaster theme={resolved}>` (`App.tsx:475`) ignores high-contrast (`resolved` is only light/dark), so
  HC users get low-contrast toasts — a real WCAG hole on a critical surface. One `toastOptions` block
  mapping to `--popover`/`--border`/`radius`/`*-subtle` fixes both (tokens already re-theme under
  `.high-contrast`). **(H / S)**
- **C3 Selection + scrollbar theming** — no `::selection`/`caret-color` anywhere, so selecting passage/
  explanation text shows the OS default blue (jarring in dark/HC/focus-paper); and the **main** `<main>`
  scroll region (`app-shell.tsx:501`) uses the unstyled native scrollbar while `.scroll-thin` is opt-in
  elsewhere. Add a verdict-tinted `::selection` (AA in all 4 themes) + `scroll-thin` on `<main>`. **(M / S)**
- **C4 Unify number/date formatting** — duration has ≥4 idioms (`2:14`, `12m`/`1h 5m`, `134s`, `1.2s`)
  so the same metric reads differently across tables; dates mix bare ISO slices (`SessionHistory.tsx:232`
  `started.slice(0,10)`), `timeAgo`, and `toLocaleDateString`. A shared `formatDuration` (clock=`m:ss`,
  prose=`2m 14s`) + `formatDate` (relative on the timeline). **(M / M)**
- **C5 Overflow / truncation hardening** — long PrepTest names break the card header (`PrepTests.tsx:97`,
  no `truncate`/`min-w-0`, while PlaylistCard already solves it); long reading text lacks `overflow-wrap`
  (`highlightable-text.tsx:233`) so a pasted URL/long token can force horizontal scroll in the RC pane.
  A quick `min-w-0`+`truncate` sweep on user-named entities + `[overflow-wrap:anywhere]` on reading. **(M / S)**
- **C6 Decide focus-paper's status** — it's a per-reading toggle (3 containers), not a peer theme: it's
  absent from the appearance gallery and the themes-as-environments cross-fade never fires for it.
  Either promote it to a 4th gallery swatch with a live preview, or document it as reading-only with a
  one-line pointer in the gallery. (Prefer the preview-swatch over globalizing warm-paper — that'd mean
  re-auditing every surface.) **(M / M or S)**

---

## Cross-cutting guardrails (apply to every item)
- **Reduced-motion:** the global CSS net covers CSS keyframes/transitions but **NOT motion/react
  springs** — every new `whileHover`/`whileTap`/spring (B2.1) needs an explicit `useReducedMotion` guard
  (the codebase's existing pattern).
- **No false affordance:** add hover-lift/`interactive` only to genuinely clickable cards.
- **High-contrast & 4 themes:** verify each new surface (toasts, selection, glass tuning) in all four;
  HC already forces aurora/glow → 0 and glass → solid.
- **Test-Mode:** the exam-clock isolation (A2.1) and any timed-surface change stay correctness-neutral.

## Sequencing (suggested)
- **Wave 1 — Quick wins (S, low-risk, broad payoff):** A1.1–A1.3 + A1.7 (bundle lazy-loads), A4.1 (SRS
  optimism), A3.1 (pause aurora offscreen), C1+C2 (states & toasts speak the system), B1.2+B1.3+B1.5
  (tint/StatNumber/interactive sweeps), C3 (selection + main scrollbar). *A fast first PR that makes the
  app measurably lighter, faster-feeling, and more cohesive.*
- **Wave 2 — The render flagship:** A2.1 + A2.2 (isolate the exam clock + memo the tree) — the single
  biggest CPU/battery win; plus A2.3–A2.5 + A3.7 (virtualize bucket queue, memoize contexts, mount tabs).
- **Wave 3 — Bundle depth + perceived speed:** A1.4 (LazyMotion), A1.5/A1.6 (markdown/favicon), A4.2/A4.3
  (optimistic mutations + route prefetch), A3.4–A3.6 (will-change/Mica/palette blur).
- **Wave 4 — Craft completion:** B1.1 + B1.4 (CardTitle voice, motivation cards), B3.2 (accent panel),
  C4/C5/C6 (formatting, overflow, focus-paper).
- **Wave 5 — The micro-interaction + signature layer:** B2.1 (motion hover/press), B2.2 (Tabs slide),
  B2.3 (scoped morph), B3.1 (PB beat), B3.3 (hover-preview).

## The bets
- **Biggest perf win:** A2.1 (the exam clock) — kills ~2,000+ needless full-passage re-segmentations per
  section on the hottest screen.
- **Biggest perceived-speed win:** A4.1 (optimistic SRS grading) — the most frequent interaction stops
  waiting on the network.
- **Biggest bundle win:** A1.1–A1.4 together — ~60–90 KB gzip off first paint.
- **Biggest craft win:** B1.1 (serif `CardTitle` voice) + B2.1 (the missing motion hover/press layer) —
  the two things that most separate the app from a 10/10 native-feeling product.

## Non-goals
No backend / data / API / feature work; no new themes beyond the four; no heavyweight deps; no gamified
motion. Reduced-motion + Okabe–Ito + Test-Mode + WCAG-AA remain hard contracts.
