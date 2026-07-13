# 07 — Design Tokens & Locked Decisions (Wave-1 spec)

**Status:** Spec, ready to implement in Wave 1. Concrete values for the
"distinctive, data-forward" direction from `06-ui-upgrades.md`. These are my
picks (you delegated the choice); all are tunable, but they're internally
coherent and chosen for reasons noted inline.

## Decisions locked
1. **Signature accent:** "Verdict" indigo-violet on a cool **graphite** neutral base.
   Distinct from the stock blue, authoritative/legal, and it lets the *type-color*
   palette (not the brand color) carry the data identity. (§1)
2. **Fonts (all self-hosted, open-license — Tauri is offline):** **Geist** (UI +
   display), **Geist Mono** (timer, scores, all tabular numbers), **Newsreader**
   (serif reading mode for RC passages/stimuli). (§2)
3. **Charting:** **visx** (+ `d3-scale`, `d3-scale-chromatic`, `d3-shape`). Drop
   recharts. visx gives control for heatmaps/dumbbells/matrices while staying React +
   tree-shakeable. (§5)
4. **Gamification intensity:** **informative-first, restrained celebration.** No
   XP/levels/mascots. Data-driven motivators (contribution heatmap, goal countdown,
   progress rings) + subtle confetti *only* on genuine personal bests. (§6 of doc 06)
5. **Default density:** **comfortable**, with a compact toggle in Settings. (§6 doc 06)

---

## 1. Color

### 1.1 Neutrals — Graphite ramp (HSL)
Cool, low-saturation gray-blue. More editorial than stock slate.
```
graphite-50   228 24% 98%
graphite-100  226 22% 96%
graphite-200  224 18% 91%
graphite-300  223 15% 83%
graphite-400  222 12% 64%
graphite-500  222 11% 49%
graphite-600  223 14% 38%
graphite-700  225 18% 27%
graphite-800  227 22% 17%
graphite-900  229 26% 11%
graphite-950  231 30% 7%
```

### 1.2 Signature accent — "Verdict" (indigo-violet, ~262°)
```
verdict-300  256 95% 78%
verdict-400  258 92% 70%
verdict-500  262 83% 60%   ← primary (light theme)
verdict-600  263 72% 50%
verdict-700  264 66% 42%
```

### 1.3 Semantic (tuned into one chroma family)
```
success  152 58% 42%   warning  38 92% 50%
danger   358 70% 54%   info     200 85% 46%
```

### 1.4 Token mapping (replaces `src/index.css`)
**Light**
```
--background  graphite-50      --foreground   graphite-900
--card        0 0% 100%        --card-foreground graphite-900
--muted       graphite-100     --muted-foreground graphite-500
--border      graphite-200     --input        graphite-200
--primary     verdict-500      --primary-foreground 0 0% 100%
--ring        verdict-500      --radius       0.375rem (6px)
```
**Dark**
```
--background  graphite-950     --foreground   graphite-100
--card        graphite-900     --card-foreground graphite-100
--muted       graphite-800     --muted-foreground graphite-400
--border      graphite-800     --input        graphite-800
--primary     verdict-400      --primary-foreground graphite-950
--ring        verdict-400
```
Plus a **"focus" reading theme** (warm-tinted paper) for the exam screen — same
tokens, `--background 40 30% 97%`, slightly larger reading defaults.

### 1.5 THE type-color palette (highest-impact artifact)
Use the **Okabe–Ito** color-blind-safe categorical set, assigned by *question-type
family* (grouping ~17 LR + 9 RC types into families is more legible than 26 random
hues). Within a family, vary lightness for sub-types. Define once in `lib/labels.ts`
next to `qTypeLabel`; consume everywhere (charts, `<TypeBadge>`, navigator strip,
drills, error log).

| Family | Types | Okabe–Ito hex |
|---|---|---|
| Assumption | NecessaryAssumption, SufficientAssumption | `#0072B2` blue |
| Strengthen/Weaken | Strengthen, Weaken, Evaluate | `#009E73` bluish-green |
| Flaw/Structure | Flaw, Method, Role, PointAtIssue | `#D55E00` vermillion |
| Inference | Inference, MostStronglySupported, MainPoint | `#56B4E9` sky-blue |
| Principle | PrincipleApply, PrincipleIdentify | `#E69F00` orange |
| Parallel | Parallel, ParallelFlaw | `#CC79A7` reddish-purple |
| Paradox | Paradox | `#F0E442` yellow (use w/ dark text) |
| RC | all RC types | `#000000`/graphite, shaded per sub-type |

> The brand **Verdict violet is reserved for UI** (primary actions, active state) so
> it never collides with a data category.

### 1.6 Continuous ramps (via d3-scale-chromatic — proven, CB-aware)
- **Heatmaps** (timing, accuracy): `interpolateViridis` (or `Inferno` for the timing
  "pressure" heat). CB-safe, perceptually uniform.
- **Diverging** (timed-vs-blind-review gap): `interpolatePuOr` (purple↔orange) —
  CB-safe and ties to the brand violet. Avoid RdYlGn (not CB-safe).

---

## 2. Typography

### 2.1 Faces (self-host in `public/fonts`, subset)
- **Geist** (variable) — UI text + display/headings + big stat numerals.
- **Geist Mono** — timer, scaled score, accuracy %, tables, anywhere digits align.
  Always with `font-feature-settings: "tnum" 1` (tabular figures).
- **Newsreader** (variable, optical sizes) — opt-in serif for RC passages & stimuli;
  designed for on-screen long-form reading.

### 2.2 Scale (px / line-height)
```
xs    12/16     sm   14/20     base 15/24     lg   17/26
xl    20/28     2xl  24/32     3xl  30/38     4xl  38/44
stat  48/52     stat-xl 64/64   (Geist, tight, tabular)
```
**Reading (passages/stimuli):** size adjustable 16/19/22px (3 steps), line-height
**1.65**, measure capped at **66ch**, paragraph spacing. These are user controls
(§4.2 of doc 06), persisted.

### 2.3 Usage
- Page titles: Geist 2xl–3xl, tight tracking.
- KPI numbers: `<StatNumber>` = Geist/Geist-Mono stat size, tabular, count-up on mount.
- Timer: Geist Mono, tabular, color-shifts under 2:00 (already partially done in
  `TakeSection.tsx` — replace the emoji, keep the threshold logic).

---

## 3. Form & depth

### 3.1 Radius
```
--radius 6px   (base)   chip 4px   card 10px   pill 9999px
```

### 3.2 Elevation (light / dark)
```
e0  none (flat)
e1  border + 0 1px 2px rgba(0,0,0,.06)        / dark: border + inset highlight
e2  card:    0 2px 6px rgba(16,18,27,.08)      / dark: 0 2px 6px rgba(0,0,0,.4)
e3  popover: 0 8px 24px rgba(16,18,27,.12)     / dark: 0 8px 24px rgba(0,0,0,.5)
e4  modal:   0 16px 48px rgba(16,18,27,.18)    / dark: + scrim
```
Dark mode uses **lighter surfaces** (graphite-900 cards on graphite-950 bg), not just
shadow, since shadows read weakly on dark.

### 3.3 Density
`--space-unit` 4px comfortable / 3px compact; row heights and paddings derive from it.

---

## 4. Motion tokens
Library: **motion** (framer-motion). Gate everything on `prefers-reduced-motion`.
```
duration:  fast 120ms · base 200ms · slow 320ms · celebrate 500ms
easing:    standard   cubic-bezier(0.2, 0, 0, 1)
           emphasized cubic-bezier(0.3, 0, 0, 1)   (enter/important)
           exit       cubic-bezier(0.4, 0, 1, 1)
spring:    UI press   { stiffness: 400, damping: 30 }
```
Applications: route transitions, list stagger (40ms), `<StatNumber>` count-up, chart
enter, choice eliminate-strike, streak pulse, milestone confetti (celebrate duration).

---

## 5. New dependencies (Wave 1)
```
motion                         # animation
@visx/* (scale, shape, group,  # bespoke charts
  heatmap, axis, tooltip)
d3-scale d3-scale-chromatic    # ramps (viridis, PuOr)
cmdk                           # command palette (⌘K)
sonner                         # toasts
```
Drop `recharts`. Self-host fonts (no Google CDN). **Code-split**: lazy-load Analytics
+ styleguide; manual vendor chunks (build already warns at ~826 kB).

## 6. First implementation step (when greenlit)
A `/dev/styleguide` route rendering: the graphite ramp, Verdict accent, the
type-color family table, semantic colors, the type scale, elevation samples, and a
motion demo. This is the visual contract every later wave is checked against — build
it before touching real screens.
