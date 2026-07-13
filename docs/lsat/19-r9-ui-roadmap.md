# LSATLab — R9 UI/Visual Roadmap: "The Living Observatory" (research)

**Scope: a pure frontend / UI / visual round.** No backend, no new data, no new features — a separate
agent owns the backend; everything here uses data and endpoints that already exist. **Research, not
implementation.** Six parallel read-only audits of the post-R8 frontend fed this.

Hard contracts (unchanged, enforced on every item): **WCAG-AA** (contrast, focus rings, live
regions), **reduced-motion** (the global `@media` net + `MotionConfig` already gate this), **all four
themes** (light / dark / focus-paper / high-contrast), **Test-Mode integrity** (never reveal
correctness while timed), **Okabe–Ito data colors** (the verdict-violet accent is never a data
category), and **local-first** (no heavyweight deps — no three.js/Lottie; we already have `motion`
v12, visx, the `window-vibrancy` Rust crate, and our own token system).

---

## The thesis: R8 wired the instrument; R9 turns it on

R8 ("The Quiet Observatory") built an excellent **foundation** — a unified dark-default theme engine,
a depth/aurora/glass/semantic-subtle token system, the three type voices, a brand `<Logo>`, a tactile
`<Button>`, an `<Icon>` wrapper, theme-aware charts + a chart kit, the offset-safe reading substrate,
and native Mica scaffolding. But the audits found the same pattern in every domain: **the premium
assets were authored and then deployed in a razor-thin slice (the hero surfaces), or not switched on
at all.** The recurring evidence:

| Dormant / barely-used asset | Reality today |
|---|---|
| **Native Mica / vibrancy** | `apply_mica` runs + window is `transparent:true`, but every chrome layer is opaque (`body`, app root, sidebar, titlebar all paint over it) → **Mica is 100% invisible.** |
| **`.glass` material** | The marquee R8 material is used on **exactly one** surface (the command palette). Every other overlay is flat `bg-popover`. |
| **`aurora-drift` keyframe** | Defined in tailwind; referenced **nowhere** — the hero aurora never breathes. |
| **`draw-on` keyframe** | Defined; referenced **nowhere** — a fleet of visx charts render statically. |
| **`card-interactive`** | The calm hover-lift is on **one** card (Dashboard); every other clickable card grid is inert. |
| **`layoutId` shared-element** | Used **once** (the nav active-bar); no card→detail morphs anywhere. |
| **The three type voices** | `.type-display/.type-counsel/.type-numeric/.type-overline` exist; `font-semibold tracking-tight` is still hand-rolled **80×/51 files** (even `CardTitle` and `<Logo>`). |
| **`<Icon>` wrapper** | Used ~30×; **277 ad-hoc `h-N w-N` icon sizings** remain across 80 files. |
| **`--row-h` density token / real density** | Defined; consumed **nowhere** — "compact" only changes `main` padding. |
| **`data-theme` attribute** | Stamped on `<html>` (`dark`, `light-hc`…); **no CSS selector reads it.** |
| **`PageLayout` header system** | A 44-line stub (`title`+`description`); no eyebrow/icon/section system; **no utility page** uses the type voices. |
| **`breadcrumb.tsx`** | Built; imported nowhere. |
| **`ContributionHeatmap` / `ReadinessGauge` / `StatNumber` aurora+subline** | Built; **unused in Analytics** (the KPI row never passes the hero props). |
| **"First Light" onboarding** | Does not exist — onboarding is a plain shadcn `Dialog` wizard. |
| **Empty / first-run states** | A brand-new user is shown **fabricated sample data** (predicted 164, a 12-day streak) as if it were theirs. |

So R9's spine is **activation + propagation + the higher-craft layer**: light every room of the
observatory, make it breathe and respond, give it native materials and ceremony, and bring the
secondary surfaces up to the hero bar. Most of it is low-risk because the primitives already exist and
already honor the contracts.

---

# PART I — Flagships (the high-impact arcs)

## F1 — Native materials, for real (the "this was built for my desktop" jump)
Today Mica is painted and then occluded by an opaque wall. **Make the desktop frame translucent,
Tauri-gated**, so the carefully-built Mica/vibrancy actually shows — the single biggest perceived
upgrade available.
- **F1.1** Introduce a Mica-aware surface tier: under Tauri (`isTauri()` already exists in
  `titlebar.tsx`), let the **window root + sidebar + titlebar + top header** use `.glass`/translucent
  tokens while the content column stays opaque for readability. The web build keeps solid surfaces. **(H / M)**
- **F1.2** Promote **`.glass` to a real material tier** on all floating chrome — dropdown, select,
  popover, sheet, the coach dock — behind the existing solid fallback (pays off on web too, independent
  of Mica). **(H / S–M)**
- **Risk:** WCAG-AA over blurred backdrops (re-verify all 4 themes); high-contrast must force solid
  (`--glass` already flattens intent); **needs a real Win11 build to confirm visually** (can't be seen
  headless). `backdrop-filter` already degrades to a tint.

## F2 — A living motion personality (settle, breathe, morph)
R8's motion is a single 6px page fade. Give the app a **differentiated, alive** motion language using
only `motion` v12 + the dormant CSS keyframes.
- **F2.1 Activate the breath:** wire `aurora-drift` into `.aurora::before` so hero numerals (predicted
  score, countdown) glow with a slow living pulse; reduced-motion already neutralizes it. **(M / S)**
- **F2.2 Charts that trace in:** wire `draw-on` + SVG `pathLength` into TrendChart line/area,
  DifficultyCurve, ridgeline paths, and gauge arcs — charts *arrive* instead of *appearing*. **(M / M)**
- **F2.3 Shared-element `layoutId` morphs:** a card expands into its detail/hero (PrepTest card →
  PrepTestAnalytics, Playlist card → detail, drill card → runner). The highest-craft motion upgrade;
  start with one flagship pair to prove the pattern. **(H / M–L)**
- **F2.4 List choreography:** an `<AnimatedList>` (fadeUp + `layout`) for add/remove/reorder on the
  high-traffic queues (SRS due, flagged, playlists, recommendation inbox) — today every list mutation
  is a hard cut. **(H / M)**
- **F2.5 Overlay enter-anim unification:** give dropdown/select/tabs/toggle/switch the zoom+slide
  tactility R8 gave dialog/popover; a `layoutId` sliding tab indicator. **(M / S)**
- **Risk:** all gated by the existing reduced-motion net; cap list animation on long/virtualized lists.

## F3 — "First Light": onboarding, the honest empty Console, and the branded first frame
The app's first impressions are its weakest surfaces.
- **F3.1 The First Light onboarding (deferred R8 flagship):** replace the boxy modal wizard with a
  full-bleed dark stage — breathing aurora behind the `Logo`, the goal/score/exam-date captured as
  **engraved numerals** that animate as the user drags the slider, staged as calm cross-fades on one
  canvas. The reusable engine already exists (`StatNumber voice="numeric" aurora`, the First Light
  loader). **(H / L)**
- **F3.2 An honest empty / first-run Console:** a brand-new user currently sees fabricated sample data
  (predicted 164, 12-day streak) as if it were real — the biggest *trust* gap on the surface, and
  off-key for an app whose R8 principle is "honesty over flattery." Render an "observatory before first
  light" state instead: an engraved `— / 180`, a calm aurora, and a guided first-section path, gated on
  a true "new user" predicate (no goal + zero sessions). **(H / M)**
- **F3.3 A branded cold-boot first frame:** the first ~400ms is an empty rectangle until the JS mounts.
  Inline a minimal static "First Light" mark (favicon glyph + calm pulse) in `index.html` body, themed
  by the existing pre-paint script, removed on React mount. **(M / S)**

## F4 — Propagate the system: the page-header spine + the "activation sweep"
Make every secondary surface as premium as the hero pages by **deploying what already exists.**
- **F4.1 Build the deferred `PageLayout` eyebrow/icon/section-header system** — `eyebrow` (overline) +
  `icon` (tinted token chip) + a `<PageSection>` primitive, with the title routed through `.type-display`
  (Newsreader optical-sizing) instead of raw `text-2xl font-bold`. The keystone everything else rides on. **(H / M)**
- **F4.2 Adopt it on every utility page** with a consistent identity (PrepTests "LIBRARY", Settings
  "PREFERENCES", Playlists "COLLECTIONS", SessionHistory "ACTIVITY", …). **(H / M, config once F4.1 lands)**
- **F4.3 Type-voice + density propagation:** route `CardTitle`, dialog/sheet titles, and headings
  through the type voices; retire the 80× hand-rolled `font-semibold tracking-tight`; drive list/table/
  nav row heights from `--row-h`/`--space-unit` so "compact" is real. **(M / M)**
- **F4.4 The `<Icon>` adoption sweep:** collapse the 277 ad-hoc icon sizings to `<Icon as=… size=…>`
  (one stroke weight, one scale) — mechanical, broad consistency lift. **(M / M)**
- **F4.5 `card-interactive` as the default for clickable cards** (or an `interactive` prop on `<Card>`):
  app-wide hover-lift affordance, currently on one card. **(M / S)**
- **F4.6 App-wide page enter motion** via the `PageLayout` root so every utility page inherits a calm
  reveal (hero pages stagger; utility pages hard-cut today). **(M / S)**

---

# PART II — Surface elevations (the per-room work)

## The Console (Dashboard) · onboarding · palette
- **Recompose into a focal wall + calm periphery** — promote predicted-score + countdown + readiness
  into one above-the-fold instrument cluster; demote streak/milestones/calendar to the lazy periphery
  (it's still a ~11-block long scroll). **(H / M)**
- **Countdown-to-exam as the emotional focal instrument** — engraved `type-numeric` day count + a serif
  counsel line ("18 mornings left — protect the routine") + an arc of prep-window elapsed; it's the most
  charged number in LSAT prep and is currently a small side card. **(H / S)**
- **Readiness as a true instrument** — engraved center score + metered factor bars + a one-line serif
  verdict (today: a gauge beside a dot-legend and `✓/○` plaintext). **(M / M)**
- **TodayPlan as a designed ritual** — a budget gauge/arc instead of a raw number field, satisfying
  check affordances, a "done for today" terminal state (today it reads as a settings form with raw
  checkboxes). **(M / M)**
- **Command palette as a power surface** — scoped/contextual commands via the existing unused
  `register()` API (on a type page: "Drill this type"; on Review: bucket actions), glance data on rows,
  a "spotlight" identity (brand glyph, recents metadata). **(H / M)**
- **One voice + de-gamify** — reconcile the three coach voices (hero counsel vs. `Sparkles` insight vs.
  robot chatbot) into one counsel tone; fold the two stacked milestone cards (trophies, Unlocked/Locked
  badges) into one quiet "Progress" ledger. **(M / S)**

## The Cockpit (Analytics) · data-viz
- **Annotation layer on the TrendChart** — labeled pins for personal-best, the start of an improving
  run, the biggest jump ("you improved here"), all client-derivable from the series it already has;
  a reusable `<ChartAnnotation>` in the chart kit. **(H / M)**
- **KPI row as an instrument cluster** — adopt the Dashboard's `voice="numeric"`/`aurora`/`subline` hero
  treatment (props exist, never passed) + a sparkline per KPI; weight predicted-score as primary
  (today: four identical flat cards). **(H / S)**
- **Cross-filter the page** — extend the proven brush→context→URL model so selecting a KPI or a
  MasteryMatrix type focuses every chart on that lens (today MasteryMatrix navigates away instead). **(H / M)**
- **Forecast as a signature hero** — lift the glide-path/cones out of the trend card's right edge into an
  "Are you on track?" panel (reuse `ReadinessGauge`, unused in Analytics). **(H / M)**
- **Chart empty/low-data states** — a shared `<ChartEmpty>` (ghost-grid + CTA) for the many charts that
  silently `return null` on thin data, so a new user's Timing/Traps tabs don't collapse to nothing. **(H / M)**
- **The printable/share report, composed** — today Print just `window.print()`s the live page; build a
  `print:`-only report composition (title block, KPIs, trend, gap, difficulty in a fixed grid). **(M / M)**
- **Richer tooltip storytelling + axis/data-ink polish** — migrate the `<title>`-only charts to the kit's
  `ChartTooltip` with micro-narrative; consistent units, `tabular-nums`, axis titles, smarter ticks. **(M / S–M)**
- **A study-consistency heatmap** — reuse the unused `ContributionHeatmap` as a diagnostic ("consistency
  vs. score"). **(M / S)**

## The Study Loop (reading · exam · blind review · SRS · drills · explanation)
- **A true zen / distraction-free focus mode** — the most-promised, least-delivered feature: today it's
  just `opacity-30` on the header/footer. Build real immersion (chrome that fades on idle, generous
  centering, the navigator collapsed to a progress dot-row, the depleting hairline as the only persistent
  ambient element). Test-Mode-safe; keep the timer AA-reachable. **(H / M)**
- **The exam as a ceremony** — a shared `<Ceremony>` frame for intro → break → section-sealed → done
  (today each re-implements `Logo + h1 + Card`); the section lineup as a designed itinerary, not list
  rows. **(H / M)**
- **The break timer as a designed rest moment** — a *filling* restful ring (not the urgency hairline),
  breathing pacing, the interstitial pacing recap elevated. **(M / S)**
- **SRS card as a premium flip/grade surface** — front (recall) → settle → back (verdict + interval),
  grade buttons that map Again→Easy to a growing interval arc (today: a plain card + a flat 4-button grid
  with 10px gray interval text). Borrow the Reckoning's settle/`glow-verdict`. **(H / M)**
- **A designed margin-annotation layer** — notes that live in a gutter rail aligned to their anchor with
  hover-to-peek (today "margin notes" render as a list *below* the passage); scope to review/explanation
  first. **(M / L)**
- **Timed confidence + commit micro-moment** — an optional inline "sure/unsure" gut-read at answer time
  (the BR confidence vocabulary already exists) and a *neutral* commit acknowledgment (ink-set on the
  letter chip). **Strictly correctness-neutral while timed.** **(M / S–M)**
- **Reading controls as a premium reader panel** — a wider sectioned panel with a live type specimen that
  re-renders as you tune size/serif/measure (today: a cramped `w-56` popover of stacked controls). **(M / S)**
- **A summonable question overview map** — a ⌘K-style panorama of all questions (answered/flagged/
  eliminated/time), distinct from the cramped footer strip. Progress-only, never correctness. **(M / M)**
- **Explanation as a reading-first layout** — the explanation as the primary column with real hierarchy,
  secondary actions (log error, drill, similar) demoted to a rail (today: five co-equal cards). **(M / M)**

## Secondary surfaces
- **Settings as a designed preferences surface** — grouped sections (Study / Appearance / AI & system /
  Data) via the F4.1 headers + an in-page anchor rail (today: 8 bare stacked cards). **(H / M)**
- **Appearance picker → a visual theme gallery** — clickable swatch cards with live mini-previews
  rendered in each environment's tokens, unifying theme + contrast + density (today: a text dropdown). **(H / M)**
- **A unified `SystemNotice` language** — one primitive (icon chip + title + body + action + dismiss) for
  offline / AI-prereq / error-pattern / recommendation banners (4 divergent idioms today; 18 files still
  mix `bg-warning/10` with the R8 `bg-warning-subtle`). **(H / M)**
- **A shared `ListRow`/`DataList`** wired to the density tokens for the four near-identical-but-divergent
  queues (SessionHistory, Playlists, BucketQueue, SRS inline). **(H / M)**
- **SessionHistory as a timeline** — month/week dividers, a connecting rail, score deltas vs. previous
  (today: a flat list of identical cards). **(M / M)**
- **Playlists as designed collections** — criteria chips, a small type/difficulty distribution,
  smart-vs-manual cover treatment. **(M / M)**
- **The coach dock as a glass counsel panel** — cast diagnosis/replies in the `.type-counsel` serif voice,
  a `--glass` surface (the token was created "for the coach dock"), drop the robot/AI signifiers. **(M / S)**
- **Empty/loading illustration consistency** — apply the 6 bespoke `illustrations.tsx` SVGs uniformly
  (Playlists/SessionHistory/SRS-inline lack them) and standardize the `LoadingState`-vs-bare-`SkeletonList`
  split. **(M / S)**

## The Shell (navigation · window chrome · perceived performance)
- **A premium navigation rail** — `--surface-*` luminance active/hover states, group dividers in collapsed
  mode, a brand/version lockup, and **persist the collapse state** (today it resets every launch while the
  window geometry persists natively — an inconsistency). **(H / M)**
- **A discoverable command-palette affordance** — a faux "Search or jump to… ⌘K" field in the rail/top bar
  (⌘K is fully built but invisible; the empty top header gets a purpose). **(H / S)**
- **Layout-faithful skeletons everywhere** — many routes + every lazy `Suspense` fallback still flash the
  centered spinner; author route-shaped skeletons (list/detail/exam) and wire them into `LazyPage` (the
  biggest perceived-perf win; Dashboard already proves the pattern). **(H / M)**
- **Unify the titlebar + top header into one desktop frame** — a centered title or wire the dormant
  `breadcrumb.tsx` to the router (two stacked mostly-empty bars today). **(M / M)**
- **A real navigation-driven loading bar** — drive `GlobalLoadingBar` from actual Suspense/navigation state
  instead of a fixed 480ms fake timeline. **(M / M)**
- **Responsive shell** — `matchMedia`/ResizeObserver auto-collapse of the rail below a width threshold
  (the shell has zero breakpoints today; only the 1024px minWidth saves it). **(M / M)**
- **A branded multi-window popout** — give `PassagePopout` the shared Titlebar + brand + reading-controls
  (it currently escapes the desktop frame entirely). **(M / S)**

---

# PART III — Signature details (the screenshot-worthy touches)
1. **The breathing aurora** behind the engraved hero numerals (F2.1).
2. **Charts that trace themselves in** on mount (F2.2).
3. **The Mica frame** — translucent chrome over the desktop (F1).
4. **Card→detail shared-element morphs** (F2.3).
5. **First Light** — the dark-stage onboarding with engraved, animating goal numbers (F3.1).
6. **The SRS interval arc** — the spaced-repetition interval visibly growing as you grade (Study Loop).
7. **The exam ceremony** — the itinerary, the restful break ring, the "section sealed" beat.
8. **The question overview panorama** — a calm ⌘K map of the whole section.
9. **The annotation gutter** — marginalia that live beside the text they mark.

---

# PART IV — Cross-cutting & hard contracts
- **Accessibility depth:** re-verify WCAG-AA on every glass/P3/brighter-accent surface; add explicit
  `motion-reduce:` transform guards on the few transform-based shell affordances; deepen high-contrast for
  the new translucent chrome (force solid); a contract test that `.high-contrast` keeps shell surfaces
  opaque.
- **A latent print bug to fix in passing:** the print stylesheet hides the bare `header` element globally,
  which also suppresses `PageLayout`'s page-title header — scope the print-hide to the app chrome
  specifically so the Analytics print keeps its title.
- **Color/light (optional new direction):** a display-P3-progressive-enhanced verdict accent via
  `@supports` (the whole system is sRGB today), used for the UI accent only — Okabe–Ito data colors stay
  untouched.
- **Wake the `data-theme` hook** for per-environment finishing (stronger glass in dark, warmer shadows in
  focus-paper, flatter materials in `-hc`) — turning "4 themes" into "4 designed environments."

---

# PART V — Sequencing (suggested)

**Wave A — The activation quick-wins (low effort, assets already exist, near-zero risk).**
F1.2 (glass on overlays) · F2.1 (aurora breath) · F2.5 (overlay anims) · F4.4 (Icon sweep) · F4.5
(card-interactive default) · the `data-theme` polish · the Analytics KPI hero treatment · the
command-palette affordance + the dormant `draw-on`/`ContributionHeatmap`/`ReadinessGauge` reuses. *A fast
first PR that makes the whole app feel markedly more finished.*

**Wave B — The page-header spine + propagation.** F4.1 → F4.2 → F4.3 + F4.6 (the keystone; everything
secondary rides on it), plus the `SystemNotice` + `ListRow` shared primitives.

**Wave C — The flagships.** F1.1 (Mica chrome) · F2.3 (shared-element morphs) · F2.4 (list choreography) ·
F3 (First Light + honest empty Console + boot frame). *The trio that vaults from "polished web app in a
window" to "built for my desktop."*

**Wave D — Surface elevations.** The Console focal-wall + instruments, the Cockpit (annotations,
cross-filter, forecast hero, chart empties, composed report), and the Shell (skeletons everywhere,
premium rail, unified frame).

**Wave E — The study loop's craft moments.** Zen focus mode, the exam ceremony, the SRS flip/grade
surface, the annotation gutter, the question overview map.

## The bets
- **Highest ROI / lowest risk:** Wave A — it's pure activation of authored-but-unused assets.
- **The flagship:** F1 (visible Mica) + F2.3 (shared-element morphs) + F3.1 (First Light) — the irreversible
  first-impression upgrades.
- **The honesty fix:** F3.2 (stop showing new users fake data) is the one item that's as much about trust
  as polish, and it's squarely on the R8 "honesty over flattery" principle.

## Non-goals (this round)
No backend / data / feature work (a separate agent owns the backend); no new themes beyond the four; no
3D/Lottie/heavyweight deps; no gamified motion. Reduced-motion + Okabe–Ito + Test-Mode integrity + WCAG-AA
remain hard contracts on every change.
