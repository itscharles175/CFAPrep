# UI Round 4+ Roadmap (expansive)

**Status:** Master backlog — see [11-ui-round-4-shipped.md](11-ui-round-4-shipped.md) for shipped items. Most R4-A–G/H items are implemented client-side; deferred items are noted at the bottom of the shipped doc.  
**Date:** 2026-05-20  
**Baseline:** Rounds 1–3 + deferred items shipped ([06](06-ui-upgrades.md), [08](08-ui-round-2.md), [09](09-ui-round-3.md)).

This document is the **next wave** after the original Waves 0–6. Items are grouped by theme, tagged for **impact** (H/M/L) and **effort** (S/M/L), and sequenced into implementable **rounds** (R4-A … R4-H). Prefer items that compound: exam fidelity + analytics truth + review loop closure.

---

## Principles (unchanged)

1. **Test Mode is sacred** — no scores, coach, or analytics chrome while the clock runs (`mode` provider).
2. **Data-forward identity** — stable type colors, tabular numerals, bespoke viz (visx), not generic dashboard templates.
3. **Blind review is the differentiator** — every upgrade should strengthen timed → BR → bucket → drill → SRS.
4. **Informative motivation** — streaks, milestones, and celebration stay restrained; no XP mascots.
5. **Backend-safe UI** — client fallbacks until APIs exist; optional query params; sample data in dev.

---

## Honest baseline — what’s already strong

| Area | Shipped highlights |
|------|-------------------|
| Design system | Verdict tokens, type palette, Geist/Newsreader, `/dev/styleguide`, density + high contrast |
| Exam | Timer, pace bar, focus mode, RC split, annotations, navigator + hover preview, keyboard map, pre-submit |
| Analytics | Tabs, filters, compare overlays, gap dumbbell, mastery matrix, traps, exports, session compare |
| Review | Multi-session bucket queue, error log workspace, BR polish, post-exam hub |
| Motivation | Calendar heatmap, countdown, milestones, session recap PNG/SVG, adaptive TodayPlan |
| Engineering | Command palette, toasts, mutations, Playwright smokes, quarantine page |

**Remaining gaps from the original spec:** onboarding depth, streak-freeze discoverability, timer defaults persistence, true server-side analytics ranges, explanation “similar questions,” Bank as a study browser, full LawHub parity checklist, bundle/code-split discipline, and **closing the loop** from insight → action in one gesture everywhere.

---

## Impact legend

| Tag | Meaning |
|-----|---------|
| **H** | Changes daily study behavior or exam fidelity |
| **M** | Strong polish or power-user value |
| **L** | Nice-to-have; do after H/M |

| Effort | Meaning |
|--------|---------|
| **S** | ≤1–2 days |
| **M** | ~3–5 days |
| **L** | Multi-week / needs API |

---

# Theme A — Intelligence layer (coach & diagnosis)

Make the app feel like it **knows your LSAT**, not just charts your attempts.

| # | Upgrade | Impact | Effort | Notes |
|---|---------|--------|--------|-------|
| A1 | **Coach insight cards v2** — metric + sparkline + single CTA on dashboard, analytics, post-exam | H | M | Extend `NarrativeCards`; wire `ai/diagnose` refresh |
| A2 | **“Why this type?” drill-down page** — one screen per weak `q_type`: gap, traps, timing, last 5 misses | H | M | Route `/analytics/type/:qType` |
| A3 | **Recommendation inbox** — queue of coach actions (drill, SRS, BR session) with snooze/done | H | M | Unify TodayPlan + coach recs |
| A4 | **Similar-question carousel** on Explanation | H | M | Needs `similar` API or embedding search |
| A5 | **Spaced “trap spirals”** — 5-question micro-drills from your top trap types | H | L | Gen + official mix |
| A6 | **Pre-exam readiness score** — composite: gap, volume, recency, SRS backlog | H | M | Dashboard hero KPI |
| A7 | **Study time budget** — “You have 45m; suggested order: SRS → 1 timed section → 3 BR Qs” | H | M | TodayPlan v2 |
| A8 | **Compare sessions narrative** — “vs last week: +4 pts, Parallel still bleeding time” | M | S | On SessionCompare + recap |
| A9 | **Error-log pattern detection** — “4 reversal traps this week” banner | H | M | Aggregate `error_log` |
| A10 | **Local LLM status surface** — queue depth, model, last explain latency in Settings | M | S | Builds trust for offline AI |

---

# Theme B — Practice journey (one continuous loop)

Reduce navigation friction from **intent → doing the work → review**.

| # | Upgrade | Impact | Effort | Notes |
|---|---------|--------|--------|-------|
| B1 | **Practice hub** — single `/practice` hub: recent PTs, resume, drills, SRS due | H | M | Replace scattered entry points |
| B2 | **Resume everywhere** — persist last route (exam Q index, BR index, drill) per device | H | M | `prefs` + Tauri window state |
| B3 | **Session timeline** — chronological list with score, BR%, duration; click → recap | H | M | `/review/history` |
| B4 | **Compare any two sessions** — pick A vs B on timing + accuracy + gap | H | M | Generalize `SessionCompare` |
| B5 | **Unified review inbox** — tabs: Buckets · Error log · SRS · Flagged only | H | L | `/review` shell upgrade |
| B6 | **One-tap “finish review loop”** — after section: BR → buckets → top miss explain | H | M | PostExamHub v2 wizard |
| B7 | **PrepTest progress rings** — per PT: sections done, BR%, best score | M | M | PrepTests page |
| B8 | **Section presets** — “Timed 35 · BR flagged only · Untimed review” | H | S | TakeSection start dialog |
| B9 | **Drill builder v2** — type + difficulty + count + time cap + source filter | H | M | Drills page |
| B10 | **Quick actions on dashboard cards** — hover → Start / Resume / View analytics | M | S | |

---

# Theme C — Exam fidelity (LawHub parity+)

The highest-trust surface; small deltas matter.

| # | Upgrade | Impact | Effort | Notes |
|---|---------|--------|--------|-------|
| C1 | **Accommodations panel** — extra time %, break length, hide timer default | H | M | Settings + exam shell |
| C2 | **Scratch pad** — freehand or typed scratch area (RC pane or overlay) | H | L | Canvas or sidebar |
| C3 | **Underline + margin notes** in exam (beyond highlight) | H | M | Extend annotation model |
| C4 | **Line ruler / pointer** for RC (drag horizontal guide) | M | M | Reading craft |
| C5 | **Choice letter size / spacing** — accessibility presets | M | S | ReadingControls extension |
| C6 | **Navigator v3** — time-per-Q dot size, type color mode, unanswered pulse | H | M | `navigator-strip` |
| C7 | **Pre-submit v2** — flagged only, unanswered list, “review flagged” jump | H | M | `pre-submit-review` |
| C8 | **Section interstitial v2** — score estimate, pacing postmortem, break CTA | H | M | Between sections |
| C9 | **Full-exam map** — visual PT progress (S1→S2→break→S3…) | H | M | Exam page |
| C10 | **Keyboard help reads live bindings** — reflect `keyboardMap` in `?` overlay | M | S | |
| C11 | **Exam sound/haptics toggles** — optional section end chime (off by default) | L | S | |
| C12 | **Anti-distraction lock** — optional OS-level fullscreen on exam start (Tauri) | M | M | |

---

# Theme D — Blind review & explanation (differentiator depth)

| # | Upgrade | Impact | Effort | Notes |
|---|---------|--------|--------|-------|
| D1 | **BR batch mode** — filter flagged / wrong / all; keyboard-through queue | H | M | BlindReview page |
| D2 | **Confidence capture UX** — larger controls, remember last confidence | H | S | |
| D3 | **2×2 outcome animation** — reveal transition + bucket preview | H | M | `revealed-block` |
| D4 | **Outcome funnel chart** — timed×BR counts for session | H | M | Analytics + post-exam |
| D5 | **Annotations follow-through** — exam highlights visible in BR + Explanation | H | L | Persist per attempt |
| D6 | **Explanation: timed vs BR side-by-side** — when attempt has both | H | M | |
| D7 | **Per-choice AI spotlight** — stream highlights active choice in list | H | M | Explanation streaming |
| D8 | **Collapsible choice breakdown** — accordion per A–E with trap badges | H | S | |
| D9 | **“Add similar to SRS” batch** from explanation | M | M | |
| D10 | **Video-less “type primer”** — static pattern cards per LR/RC family | M | L | Content + UI |
| D11 | **Printable BR worksheet** — questions without answers, space for BR | M | M | Export |

---

# Theme E — Analytics command center

From “tabs of charts” to **decision cockpit**.

| # | Upgrade | Impact | Effort | Notes |
|---|---------|--------|--------|-------|
| E1 | **Saved analytics views** — name + filter preset (range, source, tab) | H | M | localStorage → API later |
| E2 | **Score projection cone** — band + exam date marker on trend | H | M | TrendChart v2 |
| E3 | **Per-PrepTest analytics** — select PT, see section breakdowns | H | L | Needs session/PT linkage |
| E4 | **Timing budget table** — target sec/Q vs actual per type | H | M | Timing tab |
| E5 | **Heatmap compare** — two sessions side-by-side strips | H | M | `HeatStrip` |
| E6 | **Mastery matrix drill-through** — click cell → filtered error log | H | S | |
| E7 | **Trap trends over time** — small multiples by week | M | M | TrapBars v2 |
| E8 | **Difficulty × type grid** — where ceiling is by family | M | M | |
| E9 | **Analytics alerts** — “Parallel gap widened >8pts” toast on login | H | M | prefs thresholds |
| E10 | **Print/PDF analytics report** — multi-tab snapshot for coach/tutor | M | L | html-to-image bundle |
| E11 | **Brush → filter everywhere** — brush on trend filters all tabs | H | M | AnalyticsProvider |
| E12 | **Official vs AI drill split** — clearer visual language | M | S | Already have source filter |

---

# Theme F — Content, import & bank (library UX)

| # | Upgrade | Impact | Effort | Notes |
|---|---------|--------|--------|-------|
| F1 | **Bank browser v2** — filter PT, section, type, difficulty; preview pane | H | L | Bank page redesign |
| F2 | **Question preview drawer** — stem + choices without leaving bank | H | M | |
| F3 | **Import diff view** — parse warnings inline on structure tree | H | M | Import verify |
| F4 | **Import job history** — list past imports, re-open verify | M | L | API |
| F5 | **Merge/replace rules** on re-import same PT | H | L | |
| F6 | **Quarantine v2** — batch approve/reject, keyboard shortcuts | H | M | Quarantine page |
| F7 | **Side-by-side model output** — prompt, raw, parsed card | M | M | Gen review |
| F8 | **Tag editor** — bulk q_type / difficulty fix in bank | M | L | |
| F9 | **“Study this PT” wizard** — pick sections → timed plan | H | M | Practice hub tie-in |

---

# Theme G — Motivation & habit (months-long grind)

| # | Upgrade | Impact | Effort | Notes |
|---|---------|--------|--------|-------|
| G1 | **Onboarding v2** — goal, import PT, baseline 5Q drill, keyboard tour | H | M | Extend wizard + react-hook-form |
| G2 | **Streak freeze UX** — visible in calendar, confirm dialog, weekly limit copy | M | S | prefs exist |
| G3 | **Weekly goal rings** — questions / minutes target vs actual | H | M | StudyCalendar |
| G4 | **Reflection prompt** — end-of-session: “what felt slow?” (optional note) | M | S | PostExamHub |
| G5 | **Milestone share cards** — PNG like session recap | M | S | Reuse recap export |
| G6 | **Study streak insights** — best day-of-week, avg minutes | M | S | Dashboard |
| G7 | **Exam countdown modes** — compact header vs dashboard card | M | S | |
| G8 | **Personal best history** — sparkline of PB sections | M | M | `recordScore` data |
| G9 | **Gentle nudges** — “3 days since timed section” (dismissible) | M | S | Not push notification yet |
| G10 | **Weekly report v2** — charts embedded, email-ready HTML | M | M | `weeklyReport.ts` |

---

# Theme H — Platform, a11y & engineering UX

| # | Upgrade | Impact | Effort | Notes |
|---|---------|--------|--------|-------|
| H1 | **Route-level code splitting** — lazy analytics, styleguide, bank | H | M | Bundle already >500kb |
| H2 | **Virtualized tables** — error log, bank, session list | H | M | `@tanstack/react-virtual` |
| H3 | **Optimistic attempt save** — exam never feels laggy | H | M | mutations |
| H4 | **Offline attempt queue** — sync when backend returns | H | L | Tauri + IndexedDB |
| H5 | **Undo toasts** — SRS add, error log, import commit | M | M | |
| H6 | **Global loading bar** — top progress for route transitions | M | S | |
| H7 | **404 illustration** — branded spot art + search palette | L | S | NotFound |
| H8 | **Focus-visible audit** — keyboard path on every interactive | H | M | a11y |
| H9 | **Chart accessibility** — data tables always paired (extend `chart-data-table`) | H | S | |
| H10 | **Timer defaults persistence** — LR/RC minutes in Settings | M | S | Settings stub today |
| H11 | **Form coverage** — timer settings, theme import/export | M | S | react-hook-form |
| H12 | **Command palette v2** — recent items, exam actions, analytics jumps | H | M | cmdk |
| H13 | **DataTable primitive** — sort, filter, column resize for bank/error log | H | M | shadcn pattern |
| H14 | **E2E expansion** — exam flow, BR, analytics compare, import verify | H | M | Playwright |
| H15 | **Storybook or styleguide sections** — per-component motion states | M | L | |

---

# Theme I — Native desktop (Tauri)

| # | Upgrade | Impact | Effort | Notes |
|---|---------|--------|--------|-------|
| I1 | **Window layout restore** — size, position, maximized | M | M | |
| I2 | **Global hotkeys** — palette, pause timer (careful in Test Mode) | M | M | |
| I3 | **Tray menu** — streak, resume session, quit | M | M | |
| I4 | **Passage pop-out window** — RC second monitor | H | L | |
| I5 | **Native file pickers** — import PDF, backup restore | M | S | |
| I6 | **Auto-update channel** — stable/beta badge in Settings | L | L | |

---

## Suggested implementation rounds

### R4-A — Close the loop (highest ROI, ~2 weeks)

B1, B6, A1, A3, E6, D8, C10, G1 (partial), H10  
*Outcome:* User lands → sees what to do → finishes section → BR → explain without hunting.*

### R4-B — Exam fidelity pack (~2 weeks)

C7, C8, C6, C1, C3, C5, B8, D2, D3  
*Outcome:* Timed experience matches real test expectations.*

### R4-C — Analytics cockpit (~2 weeks)

E2, E4, E5, E11, A2, B4, D4, E9  
*Outcome:* Analytics drives specific next actions.*

### R4-D — Review & explanation depth (~2 weeks)

D1, D5 (phase 1), D6, D7, B5 (shell), A4, A9  
*Outcome:* Review surfaces feel as premium as exam.*

### R4-E — Library & content ops (~2–3 weeks)

F1, F2, F3, F6, B7, F9  
*Outcome:* Content scale without fear.*

### R4-F — Motivation & habit (~1 week)

G2, G3, G4, G10, G5, A7  
*Outcome:* Retention for 90-day study arcs.*

### R4-G — Platform hardening (~2 weeks)

H1, H2, H3, H8, H9, H12, H14  
*Outcome:* Fast, accessible, testable at scale.*

### R4-H — Native & stretch (~ongoing)

I1–I5, C2, C12, F4, H4, E3  
*Outcome:* Desktop-class power user features.*

---

## Backend coordination (avoid UI/backend collision)

| UI item | Likely API need |
|---------|-----------------|
| A4 similar questions | `GET /questions/:id/similar` |
| E3 per-PT analytics | PT-scoped aggregates |
| D5 annotation sync | attempt-scoped annotation CRUD |
| F4 import history | jobs list |
| H4 offline queue | batch attempt sync |
| E1 saved views | user prefs endpoint (optional) |
| B4 session compare | optional combined results endpoint |

Until APIs exist: **client aggregation** from `sessionResults` (pattern established in R3 gap + bucket queue).

---

## Explicitly deprioritize (low impact / scope trap)

- Social feeds, leaderboards, multiplayer
- Heavy gamification (XP, avatars, loot boxes)
- Rebuilding charts in a third library
- Custom themes beyond light/dark/high-contrast
- Mobile-first layout (desktop study tool first)
- In-app billing / subscription UI (not product core)

---

## Success metrics (how to know R4 worked)

1. **Time-to-next-action** — dashboard → started drill/section in &lt;2 clicks median.
2. **BR completion rate** — % of finished timed sections with BR started within 24h.
3. **Error-log resolution** — items marked reviewed or drilled within 7d.
4. **Exam abandonment** — drop-off mid-section decreases.
5. **Analytics engagement** — compare mode + drill-through CTR from charts.
6. **Performance** — LCP &lt;2.5s on dashboard; analytics route &lt;500kb initial JS.

---

## Quick reference — top 20 “do these first”

1. Practice hub + resume (B1, B2)  
2. Post-exam review wizard (B6)  
3. Coach cards + recommendation inbox (A1, A3)  
4. Per-type drill-down page (A2)  
5. Pre-submit + navigator v3 (C7, C6)  
6. Score projection + timing budget (E2, E4)  
7. BR batch mode (D1)  
8. Explanation side-by-side + choice spotlight (D6, D7)  
9. Mastery → error log drill (E6)  
10. Session timeline + compare any two (B3, B4)  
11. Onboarding v2 (G1)  
12. Bank browser v2 (F1)  
13. Quarantine batch (F6)  
14. Analytics brush → global filter (E11)  
15. Similar questions on Explanation (A4)  
16. Accommodations (C1)  
17. Code splitting + virtualized lists (H1, H2)  
18. Command palette v2 (H12)  
19. Readiness score KPI (A6)  
20. Annotation follow-through (D5)  

---

*When locking a round for implementation, copy the relevant section into a new `docs/11-ui-round-4a.md` (shipped) doc and keep this file as the master backlog.*
