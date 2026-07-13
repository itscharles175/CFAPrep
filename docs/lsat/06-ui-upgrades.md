# 06 — UI Upgrades (research & spec)

**Status:** Research / design spec. NOT implementation. Decisions to lock before building.
**Direction (chosen 2026-05-20):** *Distinctive, data-forward* — bold type hierarchy +
a signature accent, with analytics/diagnostics as the visual hero.
**Focus areas (all four, weighted):** Identity & polish · Motivation & consistency ·
Analytics & diagnostics · Test-taking fidelity.

## 0. Honest baseline (updated 2026-05-20)

**Shipped (Waves 1–5 largely complete):** Verdict/graphite tokens, Okabe–Ito type
colors, Geist + Newsreader fonts, Motion + page transitions, command palette,
keyboard help, Tauri titlebar, visx signature charts, motivation widgets
(calendar, countdown, milestones, confetti), exam timer + pace bar, reading
controls, annotations (highlight/underline/notes), RC resizable split, focus
mode, navigator strip with type dots, streaming explanations, Analytics tabs +
export, Styleguide at `/dev/styleguide`.

**Still open (this roadmap):** illustrated empty states, density toggle wiring,
404 page, `PageLayout` adoption, async UX on Practice/Drills/Import/Analytics,
analytics compare/drill-down, exam line-jump + pre-submit review, onboarding
wizard, streak freeze, high-contrast theme, Tauri window persistence, page
splits + mutation hooks, Playwright smoke tests.

The upgrade is now **long-tail polish + flagship depth**, not a greenfield redesign.

---

## 1. The design language (data-forward identity)

This is the foundation everything else inherits. Lock this first.

### 1.1 Color
Move off the stock blue to a **signature accent** + a **purpose-built data palette**.

- **Neutrals:** swap stock slate for a slightly cooler **graphite** ramp (more
  editorial, less "bootstrap"). 12 steps, tuned for both themes.
- **Signature primary — "Verdict" (deep indigo-violet, ~262°).** Distinctive vs the
  default blue, still authoritative/legal. Used sparingly: primary actions, active
  nav, the "current" accents. (Tunable — alternatives: a confident teal, or a
  graphite+electric-lime "instrument panel" look. Pick at lock time.)
- **Semantic:** success / warning / danger / info, all tuned into the same chroma
  family so charts and badges feel cohesive (today's success-green is a bit raw).
- **THE high-impact idea — a stable categorical palette keyed to question type.**
  Every LR/RC type gets ONE fixed color used *everywhere* it appears: charts,
  badges, the navigator strip, drill cards, the error log. "Parallel Reasoning" is
  always the same hue across the whole app. This builds a visual language and makes
  the data-forward identity legible. Define it once in `lib/labels.ts` alongside
  `qTypeLabel`. Needs a 17-type LR + 9-type RC palette engineered for
  distinguishability AND color-blind safety (test with deuteranopia).
- **Sequential ramp** for heatmaps (timing, accuracy) and a **diverging ramp**
  (red↔neutral↔green) for the timed-vs-blind-review gap. These are part of the
  brand, not afterthoughts.

### 1.2 Typography (data-forward = hierarchy + great numerals)
- **UI / body:** Inter (or Geist) — already feels modern; keep but tune scale.
- **Display:** a characterful display face for big stat numbers and page titles
  (e.g. Inter Display, Hubot Sans, or a refined grotesk). Big confident numerals are
  central to "data-forward."
- **Mono / numeric:** a mono (Geist Mono / JetBrains Mono) with **tabular figures**
  for the timer, scaled score, accuracy %, and all table/chart numbers so digits
  don't jitter. (TakeSection already uses `tabular-nums` on the timer — extend this
  app-wide via a `.stat` utility.)
- **Reading face for passages:** an optional high-legibility **serif** (Source Serif
  / Newsreader / Lora) for RC passages and stimuli — serif at reading size measurably
  helps long-form reading and signals "premium prep." Toggle in exam settings. This
  is where identity meets test-taking fidelity.
- **Type scale:** define a real modular scale + line-heights; reading text gets a
  longer line-height (1.6–1.7) and a constrained measure (see 4.2).

### 1.3 Form & depth
- Tighten radius to a confident **6px** (`--radius`), with a smaller token for chips.
- A real **elevation system** (0–4) using layered shadows + subtle borders, tuned per
  theme (dark mode uses lighter surfaces, not just shadow).
- A **density** setting (comfortable / compact) for data-dense screens — power users
  studying for months will want compact tables.

### 1.4 Motion system
Adopt **Motion** (the library formerly framer-motion) with motion *tokens*:
- Durations: 120 / 200 / 320 ms. Easings: standard + emphasized (custom cubic-bezier).
- **Respect `prefers-reduced-motion`** globally (a `useReducedMotion` gate) — non-negotiable.
- Applications: page/route transitions (replace the hard remount), list stagger,
  **number count-ups** for scores/stats, chart enter animations, the
  **eliminate-strike** animation on answer choices, streak-flame pulse, tasteful
  confetti on milestones.

### 1.5 Iconography & illustration
- Keep lucide for UI, but add a small set of **bespoke spot illustrations** for empty
  states (no data yet, all-caught-up on SRS, import-your-first-PrepTest) so the app
  has warmth instead of blank panels.

**Deliverable for this section:** a token file + a one-screen "design system"
storybook page (`/dev/styleguide`) showing colors, type, the type-color map,
elevation, and motion — the reference for all other work.

---

## 2. Identity & polish

| # | Upgrade | Why it's high-impact | Touches |
|---|---|---|---|
| 2.1 | **Token + theme overhaul** (§1.1–1.3) | Removes the "default template" feel instantly | index.css, tailwind.config |
| 2.2 | **Command palette (⌘/Ctrl-K)** | Keyboard-first nav: jump to any screen, start a drill, open a PrepTest, toggle theme, "explain this question" | new component, app-shell |
| 2.3 | **Route transitions + layout animation** | Replaces jarring remount; makes the app feel alive and intentional | app-shell, Motion |
| 2.4 | **Skeleton loaders** per screen | Perceived performance; no more generic spinner | states.tsx + per page |
| 2.5 | **Empty states with illustration + a clear next action** | First-run and "all done" moments feel designed, not broken | states.tsx, all pages |
| 2.6 | **Toast/feedback system** | Confirm attempts saved, SRS scheduled, import committed; undo affordances | new (shadcn sonner) |
| 2.7 | **Micro-interactions** | Choice select/eliminate, flag toggle, nav hover, button press — small spring/scale feedback | question components |
| 2.8 | **Accessibility pass** | Visible focus rings, AA+ contrast, full keyboard reachability, ARIA on charts, reduced-motion | global |
| 2.9 | **Refined nav rail** | Section grouping (Practice / Insight / Setup), active indicator bar, tooltips when collapsed, SRS-due pulse | app-shell |
| 2.10 | **Keyboard-shortcut help overlay (`?`)** | Teaches the (already rich) shortcuts; signals craft | new component |
| 2.11 | **App chrome for Tauri** | Custom titlebar/traffic-lights, drag region, window-state memory — makes it feel native, not a webpage | src-tauri + frontend |

---

## 3. Analytics & diagnostics — the visual hero

This is where "data-forward" earns its name. Recharts defaults can't carry it;
plan **visx (d3 + React)** or hand-rolled d3 for the signature charts, keeping
recharts only for trivial cases (or dropping it). Every chart uses the §1.1 palettes.

| # | Upgrade | Why |
|---|---|---|
| 3.1 | **Score-trend with goal band + projection** | Line chart that shows your target-score band, a trend/projection cone, and exam-date marker — turns a number into a story | 
| 3.2 | **Per-section timing heatmap** | A row of cells (one per question) colored by time spent, marked correct/incorrect — instantly shows where the clock dies. This is the upgrade to `analytics/timing/{session_id}`. Bespoke; recharts can't do it well. |
| 3.3 | **Timed-vs-Blind-Review gap, visualized** | The single most diagnostic metric. A diverging dumbbell/slope chart per type showing the gap, color-coded to the §1.1 diverging ramp, with the "timing vs understanding" interpretation inline |
| 3.4 | **Question-type mastery matrix/radial** | All 17 LR + 9 RC types as a sortable matrix (accuracy × avg-time × volume) or radial; each cell uses its stable type color. Click → drill that type |
| 3.5 | **Trap-analysis view** | Which trap types fool you (reversal, out-of-scope, degree…), as a ranked bar + examples. Ties to `AnswerChoice.trap_type` |
| 3.6 | **Difficulty curve** | Accuracy vs item difficulty (1–5) with a fitted curve — shows your "ceiling" |
| 3.7 | **Diagnostic narrative cards** | The AI Coach output rendered as scannable insight cards with a metric, a sparkline, and a one-tap action ("Drill this") — pairs `ai/diagnose` with viz |
| 3.8 | **Drill-down + time-range + compare** | Every chart filterable (real-only vs +AI, last 7/30/all), and a "compare to 30 days ago" overlay |
| 3.9 | **Stat treatment** | Big tabular-figure numbers, count-up on mount, delta chips (▲3) with semantic color, sparklines beside KPIs |
| 3.10 | **Shareable/export session report** | A clean printable/PNG "session recap" — also feeds Motivation (§4.5) |

Signature reusable components to build: `<Sparkline>`, `<HeatStrip>`,
`<GapDumbbell>`, `<StatNumber>` (count-up + tabular), `<TypeBadge>` (stable color),
`<TrendChart>` (goal band), `<MasteryMatrix>`.

---

## 4. Test-taking fidelity & reading craft

The exam screen is used more than any other; reading is the core activity. High ROI.

| # | Upgrade | Why |
|---|---|---|
| 4.1 | **Real timer + pacing indicator** | Replace emoji `⏱` with a proper monospaced timer; add an optional thin **pace bar** ("you're 2 questions behind pace") and an end-of-section warning state | 
| 4.2 | **Reading typography controls** | Adjustable text size, line-height, and **measure (line length ~60–70ch)** for passages/stimuli; optional serif reading mode (§1.2). Persisted. Biggest comfort win |
| 4.3 | **Annotation upgrade** | Today's 3-color highlighter → also underline, a margin **note** anchored to a selection, and quick "eliminate-as-you-read." Notes resurface in review |
| 4.4 | **Eliminate-strike animation + clearer states** | Animate the strike-through; make selected/eliminated/flagged visually unmistakable and keyboard-mirrored |
| 4.5 | **Calm exam chrome** | Edge-to-edge focus layout, dimmed app shell, a subtle "focus mode" that hides everything but text + choices; honors the "no analytics during the clock" rule with real polish |
| 4.6 | **Two-pane RC ergonomics** | Resizable split, synchronized-feel scrolling, "jump to referenced line," sticky question while scrolling the passage |
| 4.7 | **Question navigator upgrade** | The footer strip → richer: answered/flagged/eliminated-progress per item, time-per-question dots, hover preview, color by type (optional) |
| 4.8 | **Blind Review screen polish** | The 2×2 outcome grid (already a differentiator) gets real visual weight: animated reveal, color-coded routing, "add to SRS / drill this type" actions inline |
| 4.9 | **Streaming AI explanation craft** | Render markdown, a typing cursor, per-choice citations that highlight the choice being discussed, collapsible per-choice breakdown — elevate `ai/explain` consumption |
| 4.10 | **Section break / full-exam flow** | A proper timed full-exam shell with section transitions, a break timer, and a calm "section complete" interstitial |

---

## 5. Motivation & consistency (the months-long grind)

Tasteful, data-forward motivation — informative, not childish.

| # | Upgrade | Why |
|---|---|---|
| 5.1 | **Study calendar / contribution heatmap** | GitHub-style consistency grid (questions or minutes/day). The single best consistency motivator; also very on-brand for data-forward |
| 5.2 | **Goal + exam-date countdown** | Set a target score and test date; dashboard shows "X days to test, on track / behind" tied to the projection (§3.1) |
| 5.3 | **Session recap / celebration** | After a section: an animated recap (score, time, best type, BR gap) with tasteful confetti on personal bests. Closes the loop emotionally |
| 5.4 | **Streak system, done right** | Keep the flame, but make it meaningful (streak freeze, weekly goal rings) and quiet in Test Mode |
| 5.5 | **Milestones & progress rings** | "100 LR questions," "first 170 section," type-mastery badges — progress rings on the dashboard |
| 5.6 | **"Today's plan" upgrade** | The dashboard checklist becomes adaptive (driven by `ai/diagnose` + SRS due + weak types), with estimated time and one-tap start |
| 5.7 | **Weekly review email/report (local)** | An optional generated weekly summary (could route through the Jarvis MCP hook noted in the roadmap) |

---

## 6. Prioritization

Impact × effort. Do the **Foundation** first (everything inherits it), then high-ROI
quick wins, then the flagship efforts.

### Wave 1 — Foundation (unblocks all else)
- §1 design tokens (color incl. the type-color map, type, radius, elevation) — 2.1
- Motion system + reduced-motion gate — 1.4
- `<StatNumber>`, `<TypeBadge>`, `<Sparkline>` primitives
- Skeletons + empty-state system — 2.4, 2.5

### Wave 2 — Quick wins (high impact, low effort)
- Real timer + pacing bar — 4.1
- Reading typography controls + serif mode — 4.2
- Route transitions — 2.3
- Toasts + micro-interactions — 2.6, 2.7
- Command palette — 2.2
- Refined nav rail + shortcut help — 2.9, 2.10

### Wave 3 — Flagship: the data-forward analytics
- Timing heatmap — 3.2
- Timed-vs-BR gap viz — 3.3
- Type-mastery matrix — 3.4
- Score-trend w/ goal band + projection — 3.1
- Diagnostic narrative cards — 3.7
- Trap analysis + difficulty curve — 3.5, 3.6

### Wave 4 — Test-taking depth
- Annotation upgrade (notes/underline) — 4.3
- Calm focus mode + RC ergonomics — 4.5, 4.6
- Streaming explanation craft — 4.9
- Blind-review reveal polish — 4.8
- Full-exam/section-break flow — 4.10

### Wave 5 — Motivation & consistency
- Study calendar heatmap — 5.1
- Goal + exam countdown + projection tie-in — 5.2
- Session recap/celebration — 5.3
- Milestones/progress rings, adaptive plan — 5.5, 5.6

### Wave 6 — Native feel & a11y finish
- Tauri custom chrome + window-state — 2.11
- Full accessibility audit — 2.8
- Density setting, export/print reports — 1.3, 3.10

---

## 7. Tech, dependencies, risks

- **Charting:** add **visx** (or d3-shape/scale + React) for bespoke viz; keep
  recharts only for trivial charts or remove it. Decide at Wave 3.
- **Motion:** add **motion** (framer-motion). Gate on reduced-motion.
- **Toasts:** shadcn **sonner**.
- **Fonts:** self-host (Tauri is offline-first — do NOT depend on Google Fonts CDN);
  subset and ship in `public/fonts`.
- **Command palette:** **cmdk** (pairs with shadcn).
- **Bundle size:** v1 build is already ~826 kB JS. Adding viz + motion + fonts makes
  **code-splitting non-optional** — lazy-load analytics and the styleguide, split
  vendor chunks (the build already warns about this).
- **Perf in WebView2:** heatmaps/large SVGs must be virtualized or canvas-rendered if
  question counts grow; test on the 12 GB laptop, not just dev.
- **Color-blind safety:** the type-color palette is the riskiest design artifact —
  validate with simulators before locking.
- **Don't break Test-Mode discipline:** all motivation/analytics chrome stays hidden
  while the clock runs (the existing `mode` provider already enforces this — extend it).
- **Theming scope:** ship light + dark + an optional "focus" reading theme; ensure the
  data palettes have both-theme variants.

## 8. Inspiration / references (feel, not copy)
- **Linear / Things** — calm precision, keyboard-first, motion restraint.
- **Vercel / Geist** — data-forward type + numerals, elevation.
- **GitHub contribution graph** — the consistency heatmap pattern (§5.1).
- **Observable / visx galleries** — bespoke diagnostic viz (§3).
- **7Sage / LawHub** — domain expectations for the exam interface (calm, minimal).
- **Duolingo** — *restrained* borrowing of streak/celebration loops for §5.

## 9. Decisions — LOCKED (see docs/07-design-tokens.md for concrete values)
1. **Signature accent** — ✅ "Verdict" indigo-violet (~262°) on a cool graphite base.
2. **Fonts** — ✅ Geist (UI/display) + Geist Mono (numerals/timer) + Newsreader
   (serif reading mode), all self-hosted.
3. **Charting library** — ✅ visx + d3-scale/-chromatic; drop recharts.
4. **Gamification intensity** — ✅ informative-first, restrained celebration (no
   XP/levels/mascots; subtle confetti only on personal bests).
5. **Density default** — ✅ comfortable, with a compact toggle in Settings.

All five are documented with rationale and exact tokens in **docs/07-design-tokens.md**.
