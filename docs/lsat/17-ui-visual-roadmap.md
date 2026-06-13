# LSATLab — R8 "Visual Transformation" Roadmap (research)

**Scope (refined): this is a pure visual/aesthetic transformation — how everything *looks and
feels*, not what it does.** No new features, no new screens, no new data, no new capabilities for
the user. Every *existing* surface gets a revolutionary visual treatment using components and data
that already exist. (Earlier feature-oriented ideas — a knowledge map, agentic AI, session replay,
multi-window workspace — are explicitly out of scope for this round; this is about look.)

The ambition is still maximal — but on the *visual* axis: a singular, unmistakable art direction;
wide-gamut color and light; editorial variable-font typography; native desktop materials; a
signature motion personality; and obsessive craft on every pixel of the surfaces we already have.
The goal is that a screenshot of any screen is instantly recognizable as LSATLab and reads as the
most beautiful, premium study instrument in the category.

Seven research passes fed this, **re-verified 2026-05-21** against the post–bank-expansion tree
(five visual audits + a capabilities inventory + an art-direction study). The recurring finding
holds: **the stack has a high visual ceiling (`motion` v12, visx+d3, Tauri-2 native materials,
variable fonts with optical-size axes, display-P3 color) that the app uses unevenly.** The premium
P3 violet brand mark (a bespoke aurora-glow flask glyph) still sits unused in `favicon.svg` while
the app wears a stock lucide flask in 7 places; `lib/motion.ts`'s `spring.press`/`scaleIn`/`fadeIn`
presets are never wired into the `Button`/`Card` primitives (so nothing presses, lifts, or shows a
loading state); `.reading p + p` paragraph spacing is still dead code (passages render as one flat
text node); the `.hl-*` highlights are fixed `rgba` (not theme-aware); `backdrop-blur` is used once
and live-UI gradients are effectively zero (the only gradient cards are rendered off-screen). **The
transformation is "deploy the latent visual power under one vision," not a rebuild.**

*What's already moved toward the vision (so parts of this are now refinement, not new build):* the
Dashboard is no longer a flat card stack — it has a `ResumeHero`, an engraved predicted-score, and a
trend hero row; Newsreader's `opsz` axis is now imported (though `font-optical-sizing` is still off);
`rounded-card` is in use; and several charts already carry rich visx tooltips. The gaps that remain
are *cohesion and depth*, not absence.

Hard contracts on every change: preserve **WCAG-AA** (contrast, focus rings, **reduced-motion**,
live regions); hold across all four themes (light / dark / focus-paper / high-contrast); preserve
**Test-Mode integrity** (no answer/correctness leakage while timed); **Okabe–Ito colorblind-safe
data colors stay sacrosanct** (the accent is never a data category); local-first desktop. Audience:
one serious daily self-studier — calm, premium, authoritative, focused; **motivating without ever
being gamified-garish.**

---

# PART I — The Design Language: "The Quiet Observatory"

> **Manifesto:** *A precision instrument for honest self-study — dark, still, and exact, where
> every number is engraved, every surface catches light, and the only drama is the truth about
> your own mind.*

The metaphor is an **observatory at night**: a darkened room where a serious practitioner reads by
a pool of warm light while instruments at the edges quietly report. The register is a Leica, a
Braun calculator, Linear, Things — **expensive restraint.** This *evolves* the current system
(graphite ramp, verdict-violet accent, Geist/Geist-Mono/Newsreader, the elevation scale, the four
themes); today those tokens are used too *evenly* and too *brightly-by-default*. The Observatory
gives them hierarchy, depth, light, and a hero.

- **Dark is the hero.** `.dark` exists but light is the current default; flip the *intent* so the
  signature state is the near-black blue-graphite (`graphite-950`) that makes verdict-violet glow
  and Geist Mono numerals read as engraved. The four themes become **four times of day**, not a
  settings toggle: Observatory night (dark), lamplit desk (focus-paper), daylight (light), and the
  accessible floor (high-contrast). **No new theme is added.**
- **Center & periphery.** Every screen has a lit center (what you read/act on) and a calm
  periphery (ambient instruments: timer, pace, readiness, countdown).
- **Color story.** Surfaces step *up toward the light* (a depth ladder on the existing elevation
  scale + the `inset 0 1px 0 rgba(255,255,255,.04)` top-highlight already in `--elevation-1`
  dark). **Verdict-violet becomes a ceremony color** — the predicted score, the Reveal verdict, the
  on-track affirmation, the focus ring; when violet appears, something is *asserted*; everywhere
  else is graphite. Data keeps Okabe–Ito categories + the four semantic tones. One new atmospheric
  primitive: a **subtle aurora** (radial verdict-700→transparent at ~4–8%) behind hero numbers — the
  instrument's glow, off under reduced-motion/high-contrast.
- **Three type voices, finally cast.** **Geist Mono = engraved numbers** (anything describing
  *you*: score, days, pace, accuracy — tabular, often `stat`/`stat-xl`, count-up, aurora behind
  hero instances). **Newsreader serif = the app's voice** (the coach's counsel, the Reveal verdict
  sentence, hero titles, empty-state lines) + the reading surface. **Geist sans = the quiet
  operator** (labels, controls, chrome — it recedes). The signature pattern on every hero surface:
  **a giant mono number + a short serif sentence.** Repeated, that *is* the brand.
- **Motion personality — "weighted calm."** Things *settle* on the emphasized ease (the existing
  `fadeUp` y:8→0), they never bounce; numbers count up like a gauge spinning to rest; hover
  *brightens* (surface steps up + a faint verdict edge-glow) rather than jumps. **The Reveal is the
  one place motion is allowed to be theatrical** — everywhere else it's so calm you barely notice
  it. That contrast is the point.

### The six design principles (the operating manual for every screen)
1. **One truth per room.** Each screen has a single most-important number/judgment, rendered
   monumentally; everything else supports or recedes.
2. **Violet is a verdict, never a decoration.** Reserve the accent for judgment/affirmation;
   graphite carries structure, semantic tones carry status, Okabe–Ito carries categories.
3. **Numbers are engraved; prose is counsel; UI whispers.** Never mix the three type roles.
4. **Light models depth.** Hierarchy comes from surface elevation + the top-edge highlight, not
   heavy borders or color blocks.
5. **Calm by default, drama only when earned.** Motion settles; reduced-motion is a first-class
   theme.
6. **Honesty over flattery.** Never hide a bad number behind cheerful color — state it plainly and
   let clarity, not confetti, do the encouraging.

**Alternate direction considered — "The Study Journal":** a warm editorial logbook making
focus-paper the hero (Newsreader-forward, old-style figures, verdict as an ink stamp, the Reveal as
"turning the page"). Buildable on the same tokens; the counter-option if the product ever wants
warmth over exactitude. **Recommendation: the Observatory is primary** (it best fits "precision
instrument you live in daily" and makes the data sing).

---

# PART II — The Visual System (where the *revolutionary look* lives)

This is the heart of the round: a deep, cohesive visual system. Making *this* extraordinary is what
transforms the app's looks — every surface inherits it.

### 1. Light & color
- **Graphite depth ladder, not flat cards.** Define 2–3 elevation steps as actual surface tints
  (background → recessed well → resting card → raised/active), each catching a hair more light;
  hierarchy reads from luminance, not borders. **(H/M)**
- **Verdict ramp → wide-gamut P3 / `oklch`.** The favicon already ships display-P3, so the pipeline
  is proven; render the accent in `oklch`/P3 with an sRGB fallback for a vivid, alive violet on
  laptop displays — used only for verdict moments. **(M/S)**
- **The aurora & glow system.** A reusable radial-gradient "instrument glow" token behind hero
  numerals and the Reveal; a faint verdict edge-glow on hover/active surfaces. Gradients today live
  in 3 places — make a *system* of them, tasteful and sparse. **(M/M)**
- **Semantic + tinted-surface ramps.** Give success/warning/info/danger 3–4 steps + `color-mix()`
  tints, replacing scattered `/15`,`/5`,`/30` opacity improvisations so status UI is consistent in
  all four themes. **(M/M)**

### 2. Materials & depth
- **Native OS translucency (vibrancy / Windows Mica / acrylic).** The single biggest "this is a
  real desktop app, not a web page" visual jump — a frosted, light-bending sidebar/titlebar.
  Requires the `window-vibrancy` Rust crate + capability grants; degrade gracefully where
  unsupported. **(H/M, native)**
- **Frosted-glass surfaces** (`backdrop-blur` + gradient + `color-mix`) for the command palette,
  popovers, the coach dock, sticky headers — currently `backdrop-blur` is used once. **(M/S)**
- **A single hairline + radius + shadow language.** Resolve the fragmentation (cards use
  `rounded-lg` while the dedicated `rounded-card` 10px token goes unused; `shadow-md`/`shadow-lg`
  leak beside the `e1–e4` scale): controls = one radius, surfaces = `rounded-card`, elevation only
  via the token scale. Makes the whole app feel authored by one hand. **(M/M)**

### 3. Typography (the editorial signature)
- **The Engraved-Number system.** A `<Stat>` treatment: oversized tabular Geist Mono (`stat`/
  `stat-xl` already exist), count-up on first paint (reduced-motion → instant), optional aurora
  behind hero instances. The most-repeated brand element. **(H/S)**
- **Newsreader optical-size display serif.** Import the on-disk-but-unused `opsz` axis + enable
  `font-optical-sizing`, so the serif at large sizes gets true display glyphs — page/hero titles
  and the coach voice become editorial. Essentially free. **(H/S)**
- **A type-role layer.** Add weight + tracking tokens and roles (display / h1–3 / body / caption /
  overline) so screens stop hand-rolling `font-semibold tracking-tight`; cast the three voices
  consistently. **(H/M)**
- **Editorial figure detailing.** Tabular figures everywhere numbers align (already disciplined),
  plus small-caps for labels/legends and slashed-zero where it reads as instrumentation. **(M/S)**

### 4. Motion (the "weighted calm" personality)
- **Settle, don't bounce.** Standardize on the emphasized ease + the `fadeUp`/`scaleIn` vocabulary;
  single-source the duplicated motion tokens (`motion.ts` vs `tailwind.config.js`). **(M/S)**
- **Shared-element transitions (`layoutId`)** for *visual continuity* — a card morphs into its
  detail view instead of a hard cut (used in exactly one place today). **(M/M, reduced-motion gated)**
- **Scroll-linked reveals** (`useScroll`/`useTransform`) — calm parallax on the dashboard hero,
  section headers that settle as you scroll. **(M/M, gated)**
- **Draw-on for charts & rings** (SVG `pathLength`) — the trend line *traces* in, rings sweep, on
  mount. **(M/S, gated)**
- **App-wide enter motion** — Bank/Settings/PrepTests/Playlists/Review hard-cut in today; wrap page
  bodies in stagger/`fadeUp` (Dashboard already shows the pattern). **(M/M)**
- **The reduced-motion safety net** — an `@media (prefers-reduced-motion)` CSS block so CSS
  keyframes (`animate-pulse`, `shimmer`) honor the preference, not just `motion/react`. **(M/S, a11y)**

### 5. Iconography & micro-detail
- One icon stroke weight + 2–3 sizes via an `<Icon>` wrapper (~224 ad-hoc sizes today); tactile
  micro-interactions baked into primitives (press-scale, hover-brighten); optical alignment and a
  real styled thin `ScrollArea` (the primitive is currently a no-op div with native scrollbars).
  **(M/M)**

### 6. Themes as four environments
Art-direct each theme as a distinct *mood* (not a color swap), with a tasteful cross-fade on
switch, and ensure the depth/light/material language reads correctly in all four (the dark hero's
top-edge highlight vs light's softer shadows; high-contrast flattens aurora/glow to pure borders).
**(H/M, a11y)**

---

# PART III — Every Surface, Re-skinned (visual reimagining of *existing* screens — no new features)

Each is a **visual recomposition of components and data that already exist** — the look changes,
the functionality does not.

- **The Dashboard → "The Console" · (H/M) — refine, don't rebuild.** It is *already* a weighted,
  motion-staggered composition (a `ResumeHero`, a bare predicted-score `StatNumber`, a
  `TrendChart`+`Countdown` hero row, a `lazy` below-fold split) — not the flat stack the first draft
  assumed. The visual work is to *elevate* it: promote the predicted score into the engraved `<Stat>`
  treatment (`stat-xl` + count-up + aurora + one serif counsel sentence), give the trend row real
  elevation hierarchy, **dedupe the coach** (it renders twice today — `NarrativeCards` and a separate
  "AI Coach" card), retire the now-dormant `resume-banner.tsx`, and replace the centered spinner with
  a layout-faithful skeleton. Same components, sharper composition.
- **The Reveal (Blind Review) → "The Reckoning" · (H/M).** A visual/motion treatment of the
  *existing* outcome **truth table** (a `grid-cols-3` matrix — header row + header column + the four
  outcome cells — not a literal 2×2). Today the reveal is single-shot; add the **hold→settle** beat:
  a brief darkened "hold" on your timed vs BR answers, then the correct answer settles in and your
  outcome cell *ignites* (the per-cell `scale:[1,1.06,1]` + `OUTCOME_META` tones already exist) while
  the others recede, with a serif verdict line. The signature, screenshot-worthy moment — pure
  presentation of data already shown today.
- **Analytics → "The Cockpit" · (H/M).** No new charts — make the *existing* visx pieces cohere and
  shine. Several charts already carry rich portal tooltips (`DifficultyCurve`, `HeatStrip`,
  `ContributionHeatmap`); the gap is *shared* primitives: one `<ChartTooltip>`+crosshair (unify them
  + add a hover crosshair to the brush-only `TrendChart`), shared legends/scale keys (the d3
  heatmaps have none), a `<ReferenceLine>`, gradient/pattern fills, and draw-on animation. The
  forecast already renders a projection line + nested variance cones inside `TrendChart` — restyle it
  as the hero "glide path" (goal-band runway + forecast cone to exam day). Tabs gain a hero card +
  demoted grid instead of the 5 equal-weight `shadow-e1` walls.
- **The timed loop → "The Reading Room" · (H/M).** Visual immersion of the existing runner: real
  paragraph typography (render passages as `<p>` so dead `.reading p + p` engages; one authoritative
  line-height — **done carefully**, since highlight/note anchors are absolute char-offsets over a
  flat text node and a naive split would corrupt saved annotations), theme-aware crafted highlights
  (today fixed `rgba`), the timer/pace restyled as **ambient edge instruments** (a thin depleting
  hairline that warms under 2:00, not a red badge), and the divergent `PassagePopout` reading path
  brought in line. Test-Mode integrity *deepens* (less visual noise, never more signal).
- **Onboarding → "First Light" · (H/S).** A visual welcome over the *existing* goal form: a dark
  stage, breathing aurora, the wordmark engraved in mono, a monumental score control with a live
  mini-trend, days-to-exam engraving themselves. Same `goal`/`saveStudyPlan` wiring — staged as a
  premium first impression.
- **The data surfaces → "The Archive" · (H/M) — new scope.** Bank is now a substantial 3-tab screen
  (Browse / Quality / Operations) plus sibling Quarantine + Tag-review pages and a 3-step Import
  wizard. Make them as premium as the hero pages, purely visually: a single **provenance badge
  system** (official / research / ReClor-NC / AI-generated / sample / training-corpus, colorblind-safe)
  replacing the duplicate label maps and raw `src.key` text; the virtualized browser as a calm dense
  data surface with real empty/error/skeleton states; the audit panel as a designed quality dashboard
  (shared meters, not hand-rolled bars; warn-states as badges, not color-only); Quarantine/Tag-review
  as a reviewable queue with verdict chips; Operations + Import re-housed on the shared primitives
  (every raw `<input type="checkbox">` → the `Checkbox` primitive; faux-`rounded-md` cards → `Card`;
  the cramped `grid-cols-2` verify view → responsive at `lg:`) — rising to the `ImportIntegrityGate`'s
  existing polish bar.
- **The rest — a consistent polish pass · (M/M).** PrepTests, Settings, SRS, Review, Playlists,
  SessionHistory: a `PageLayout` header system (eyebrow/icon/section headers), framed hero numbers,
  crafted interactive cards, distinctive illustrated empty/loading states — so utility pages feel as
  premium as hero pages.

---

# PART IV — Signature Visual Details (the screenshot-worthy touches — all look, no feature)
1. **The Engraved Number** — the brand's most-repeated element (oversized tabular mono + count-up +
   aurora).
2. **The Verdict matrix** — the Reckoning's four-outcome truth table (timed × blind-review) as the
   app's signature diagram and marketing image.
3. **Themes-as-Environments** — four times of day with a cross-fade on switch.
4. **The "First Light" loading identity** — replace generic spinners with one calm motif (an aurora
   bloom / a gauge-arc filling) at boot, on the global loading bar, and as the LLM "thinking" state.
5. **The Glide-Path trend** — the score-trend-toward-exam styled as the brand-hero visualization
   (restyle of the existing forecast chart).
6. **The Quiet Affirmation (anti-confetti)** — genuine wins marked by a single verdict pulse + one
   serif line that settles and fades; confetti becomes the rare opt-in exception.
7. **Ambient sound-free pace feedback** — time felt through the periphery (a warming hairline),
   never a beep/box; respects anxious test-takers + reduced-motion.
8. **Beautiful empty states** — a calm dark observatory still-life + one engraved invitation,
   instead of a generic gray icon.
9. **The Coach as Counsel** — the AI diagnosis set in Newsreader serif, like a note from a tutor,
   distinct from all chrome (typographic treatment of existing output).
10. **The Engraved Recap "Receipt"** — the post-section recap styled as a clean printable instrument
    readout; surface the premium `RecapShareCard` (today rendered off-screen) as a *viewable* moment.

---

# PART V — Foundation Flagships (the visual-system work that makes it executable)
The *how* beneath Parts I–IV. (Condensed; impact/effort retained.)

- **F1 — One theme engine, themed everything.** Unify the four fragmented theme mechanisms into one
  `data-theme` + `data-density` engine, all four selectable **(H/M)**; add the missing focus-paper
  **dark variant** + deepen high-contrast **(H/S, a11y)**; **theme-aware chart scales** (`chartTheme.ts`,
  remap d3 ramps per theme, kill hardcoded `#fff`/`#111`) **(H/M, a11y)**; theme-aware highlighter
  **(H/M)**; semantic ramps + tinted-surface tokens **(M/M)**; make density real (padding from
  `--space-unit`) **(M/M)**.
- **F2 — Brand identity & materials.** Promote the dormant `favicon.svg` into a `<Logo>` + reconcile
  `verdict-500` to the mark **(H/S)**; the type-role layer + Newsreader `opsz` **(H/M)**; the
  signature gradient/aurora + glass-surface + P3 accent tokens **(M/M)**; cohesive illustration
  language **(M/M)**.
- **F3 — Tactile components + motion.** Bake press/hover-elevation/transform transitions into Button
  (+Toggle/Switch/Tabs) **(H/S)**; hero primary CTA + a visual `loading` state **(H/S)**; interactive
  cards (`rounded-card`, density padding, hover-lift) **(H/M)**; unify+animate overlays
  (zoom/slide enter; one tooltip identity; frosted scrim) **(H/M)**; the command palette as the
  signature surface **(H/M)**; app-wide stagger/enter + chart draw-on **(H/M)**; the reduced-motion
  CSS net **(M/S, a11y)**.
- **F4 — Reading & the Reckoning.** Real paragraph typography + one line-height **(H/M)**; theme-aware
  crafted highlights **(H/M)**; the supportive graduated/ambient timer **(H/S)**; calm the navigator
  (drop the perpetual pulse) **(H/S, a11y)**; the sequenced Reckoning **(H/M)**; promote the AI
  explanation to a first-class reading surface (tuned `.reading` type, not `prose-sm`) **(H/M)**;
  question/section transitions + true zen mode **(M/M)**.
- **F5 — Composed dashboard + dashboard-grade charts.** The Console recomposition **(H/M)**;
  layout-faithful skeletons **(H/M)**; the chart cohesion kit (shared tooltip/crosshair, legends,
  reference-line, gradient/pattern fills) **(H/M)**; the hero Glide-Path styling **(H/M)**; tab →
  cockpit hierarchy **(M/M)**; surface the share card + quiet affirmation **(M/M)**.
- **Track 6 — Cleanups.** Card-radius contradiction; radius/shadow token standardization;
  single-source motion tokens; tokenize the off-palette streak orange; `<Icon>` wrapper; styled
  `ScrollArea`; unify error/offline/AI into one calm "system status" look; KPI count-up from
  previous value; enrich `Sparkline`; responsive Import split.

---

# PART VI — Accessibility-critical (visual regressions to fix within the round)
- **CSS animations bypass reduced-motion** — there's no `@media (prefers-reduced-motion)` net, only
  per-element `motion-reduce:` utilities, present on some elements but **missing on exactly two**:
  the navigator `animate-pulse` (`navigator-strip.tsx:85`) and the streaming `▋` cursor
  (`Explanation.tsx:550`). The correct pattern already exists in-repo (`app-shell.tsx:150`) — apply
  it + add the global net.
- **Focus-paper has no dark variant** → white flash for dark users entering reading mode.
- **The three d3-ramp charts + hardcoded `#fff`/`#111` marks aren't theme-aware** (`HeatStrip`,
  `ContributionHeatmap`, `GapDumbbell`) → wash out on dark/high-contrast. (The other visx charts are
  already token-clean.)
- **Highlighter fills are fixed `rgba`** (not theme-aware) → poor contrast in dark/high-contrast/focus.
- **High-contrast is shallow** (~6 tokens; cards/popovers/semantic colors/elevation untouched).
- **The d3 heatmaps have no visible legend** — color is the sole channel.
*(All folded into F1 + F3 + the chart cohesion kit.)*

---

# PART VII — The visual superpowers we already have (feasibility)
Every Part II/III idea maps to capability already on the stack:
- **Optical-size serif (`opsz`)** — Newsreader is now imported, so the axis is loaded; but
  `font-optical-sizing` is still never enabled, so large serif gets no display glyphs yet. *Trivial.*
- **Display-P3 / `oklch` accent** — favicon proves the pipeline; sRGB fallback. *Low.*
- **Native vibrancy / Mica translucency** — needs the `window-vibrancy` crate + capability grants.
  *Medium, native.*
- **Frosted glass / gradients / `color-mix`** — gradients used in 3 spots, blur in 1. *Low.*
- **Shared-element `layoutId` morphs** — used once (the nav bar). *Medium, gated.*
- **Scroll-linked motion** (`useScroll`/`useTransform`) — unused. *Medium, gated.*
- **SVG `pathLength` draw-on** — unused; replaces the hand-rolled ring transition. *Low, gated.*
- **Gradient/pattern chart fills** (`@visx/gradient`+`@visx/pattern`) — small deps; patterns also
  add colorblind-safe redundancy. *Low.*
- **Richer celebration** (`canvas-confetti` shapes / scoped bursts) — *Trivial; keep the
  reduced-motion skip.*

**Honest limits:** no 3D/WebGL or vector-animation files (no three.js/Lottie/Rive) without
heavyweight deps — out of scope for the local-first ethos. The whole ambition is **editorial +
native-desktop polish**, executed with restraint. **Reduced-motion gating and Okabe–Ito
colorblind-safe data colors are non-negotiable on every flourish.**

---

# PART VIII — Sequencing (foundation-first, locked)
The direction is confirmed, so there is **no Wave-0 spike/gate** — execution is foundation-first so
nothing is built twice. (The file-level plan lives in [docs/18](18-r8-implementation-plan.md).)
- **Wave 1 — Foundation.** F1 (theme engine + theme-aware charts/highlights) + the a11y-critical
  fixes + Track 6 token cleanups + the material/color/type system (Part II). *Everything downstream
  then themes for free.*
- **Wave 2 — Brand + the tactile layer.** F2 (logo/type-role/`opsz`) + F3.1–3.5 (tactile controls,
  overlay unification, the command palette).
- **Wave 3 — The three hero surfaces.** The Console (refine) + The Reckoning (the hold→settle beat) +
  the Analytics Cockpit (the shared chart kit + Glide-Path + tab hierarchy).
- **Wave 4 — The surfaces users live & work in.** The Reading Room (reading substrate, ambient timer,
  explanation-as-reading) + **The Archive** (the Bank/Quarantine/Tag-review/Import data surfaces).
- **Wave 5 — Environments, details & native depth.** Themes-as-environments cross-fade + signature
  details (loading identity, quiet affirmation, surfaced recap card, empty states) + native
  vibrancy/Mica + app-wide enter motion + remaining Track 6 polish.

## The bet
**The foundation carries the brand.** With direction locked, the leverage is in Wave 1 (one theme
engine + the depth/light/type system) — once that lands, every surface inherits the Observatory for
free, and the hero surfaces become *refinement* rather than rescue. The two that carry the identity
are still the Console (the daily home) and the Reckoning (the emotional climax) — a giant engraved
score under a serif sentence, and an outcome truth-table that turns the core diagnostic into a moment
you'd screenshot. The revolution here is *visual*: one art direction, wide-gamut light, editorial
type, native materials, and weighted-calm motion, applied with obsessive consistency to the app we
already have.

## Non-goals (this round)
**No new features, screens, data, or user-facing capabilities** (the feature ideas — knowledge map,
agentic AI, replay, multi-window — are explicitly deferred); no new themes beyond the four; no
3D/Lottie/heavyweight deps; no gamified/garish motion. Local-first and the R7 AA bar are preserved;
**reduced-motion and Okabe–Ito colorblind-safety are hard contracts** on every change.
