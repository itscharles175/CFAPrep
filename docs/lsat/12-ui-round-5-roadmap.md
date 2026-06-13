# UI Round 5+ Roadmap — "Continuous tutor" wave

**Status:** Master backlog for the next push beyond Round 4.
**Baseline:** Rounds 1–4 shipped ([06](06-ui-upgrades.md) · [08](08-ui-round-2.md) · [09](09-ui-round-3.md) · [10](10-ui-round-4-roadmap.md) · [11](11-ui-round-4-shipped.md)).
**Date:** 2026-05-20

After Round 4 the app is **structurally complete** — every page exists, every major flow works, sample data + offline queue prevent dead-ends. What it isn't yet: a **continuous tutor that feels native, fast, and personal across months of study**. Round 5 is about closing that gap on six axes at once: intelligence depth, design-system enforcement, API/backend coordination, exam fidelity v2, native desktop class, and performance/a11y.

This document is **the audit-grounded backlog** for that wave. Every item is anchored in a specific file/route/endpoint to remove guesswork during implementation.

---

## Principles (extension of R4)

1. **Test Mode is sacred** — preserved without modification.
2. **AI is continuous, not modal** — the tutor surfaces alongside study, not just on demand.
3. **Backend is now mature enough to drive UI** — replace localStorage proxies with real `/study`, `/coach`, `/forecast`, `/mastery` endpoints.
4. **Native > web wrapper** — Tauri features ship instead of being stubbed.
5. **Design-system tokens are enforced**, not aspirational.
6. **A11y + perf are budgets, not afterthoughts** — every wave has measurable targets.

---

## What we found in the granular audit (one-paragraph summaries)

- **UX polish.** Strongest pages: Analytics, Import, Exam. Weakest: **Bank** (copy bug + admin-first IA), **TypeAnalytics** (fake `accuracy + 0.05` stub, no gap/traps), **SessionHistory** (no empty/error states). Cross-cutting issues: hover-only actions on Dashboard, SRS tab in Review is a redirect stub, ad-hoc `return null` loaders in 5+ components, inconsistent "Sample data" copy.
- **Design system.** Tokens in `docs/07-design-tokens.md` are well-implemented at the foundation; **density is wired but unused** (only `.density-gap` on `PageLayout`); **17 ad-hoc `text-[9–11px]` sizes** bypass the type scale; **shadcn primitives missing**: Accordion, Checkbox, RadioGroup, Popover, Slider, Pagination, Table, Alert, Toggle, Stepper, Combobox, Breadcrumb. Default `shadow-sm/md/lg` on `Card/Dialog/Dropdown` bypass `--elevation-*` tokens. Exam routes skip `PageTransition`.
- **API coverage.** Backend exposes **52 routes**; ~24 are **unwired or partially wired**. Notable gaps: `GET /api/ai/coach` (snapshot exists, dashboard ignores it), `/api/analytics/{mastery,forecast,report}`, `/api/study/*`, `/api/settings`, `/api/gen/jobs` list, `/api/bank/{audit,duplicates,embed,tag-review}`, `POST /api/exams`. Three **phantom** endpoints in `api.ts` (annotations, bulk-tag, `questions/{id}/similar`). `?days=` query parameters are ignored by most analytics endpoints — date filtering is client-side only.
- **AI layer.** Tier A explain stream works on Explanation; **follow-up chips don't send their text** (`Explanation.tsx` ~112–119 toggles `chosen_answer` only). **No cached/live badge**; cached `explanation.body` never auto-rendered. `error_log.ai_diagnosis` field exists but is **never populated** on create. Coach snapshot worker runs every ~6h but UI never reads it. Validation reports on generated questions are not shown in Quarantine.
- **Tauri.** Frameless window + tray + dev backend spawn work. **PDF picker is stubbed** — `plugin-dialog/plugin-fs` aren't in `Cargo.toml` or capabilities. No second window, no global hotkeys, no OS notifications, no auto-update, no code signing. Backend spawn is Windows-only path.
- **Performance.** ~617 kB main chunk because **Dashboard eagerly pulls `viz` + `motion` + `html-to-image` + `confetti`**. Six shelled routes (`Settings`, `Review`, `Practice`, `PrepTests`, `Drills`, `Srs`) are static imports. Analytics tab panels all ship in one chunk. Three variable fonts load upfront. Zero unit tests; 12 Playwright smokes don't cover exam, BR, explanation, or settings.
- **A11y.** Skip link + Radix + `useReducedMotion` are good; gaps: icon-only buttons missing `aria-label` (navigator, similar-questions, saved-views), no `aria-live` on AI streaming, `navigator-strip` pulse without `motion-reduce`, light `--muted-foreground` borderline AA for small text.

---

## Impact / effort legend (same as R4)

| Tag | Meaning |
|-----|---------|
| **H** | Changes daily study behavior, exam fidelity, or perceived intelligence |
| **M** | Strong polish or power-user value |
| **L** | Nice-to-have once H/M land |

| Effort | Meaning |
|--------|---------|
| **S** | ≤1–2 days |
| **M** | ~3–5 days |
| **L** | Multi-week / needs backend change |

---

# Theme A — Continuous tutor (AI depth)

Make the app **feel like the LLM is studying with you** rather than answering on click.

| # | Upgrade | Impact | Effort | Anchor |
|---|---------|--------|--------|--------|
| A1 | **Real follow-up explain** — accept `user_message` + `focus_choice` on `POST /ai/explain`; wire Explanation chips so "Why is C wrong?" actually sends choice context | H | M | Backend `ai_routes.py`; `Explanation.tsx` ~112–119 |
| A2 | **Cached-vs-live badge + auto-load cached body** — render `explanation.body` immediately if present; show "Cached" pill from SSE `done.cached` event | H | S | `streamExplain` in `api.ts`; `Explanation.tsx` |
| A3 | **Stop + Retry on stream** — explicit cancel button; retry preserves prompt; handle SSE `error` event | H | S | `Explanation.tsx`, `streamExplain` |
| A4 | **Per-choice streaming** — send choice deltas as discrete SSE events; render into `ChoiceBreakdown` as they arrive (instead of post-stream parse) | M | M | `ai.py` `_explain_prompt` + `parse_per_choice`; `choice-breakdown.tsx` |
| A5 | **Wire `/api/ai/coach` snapshot** — Dashboard coach card reads cached snapshot; "Re-diagnose" calls `/coach/refresh` not `/diagnose` | H | S | `Dashboard.tsx`, `NarrativeCards.tsx`, `recommendation-inbox.tsx` |
| A6 | **Populate `ai_diagnosis` on error-log save** — short Tier-A call from `(stem, reason, note, your answer)`; surface in `error-log-workspace` | H | M | `routers/error_log.py`; `error-log-workspace.tsx` |
| A7 | **Docked coach panel** — collapsible right-rail tutor on Review/Explanation/BR (study mode only); session-scoped chat-like memory | H | L | New `components/coach/docked-coach.tsx` |
| A8 | **Conversational drill builder** — Drills page accepts natural language ("3 harder Parallel, official only") → server intent → `DrillConfig` | M | M | New `POST /api/drills/intent`; `Drills.tsx` |
| A9 | **Per-trap explainer** — from `analytics/traps` + recent error log, generate "Your top trap this month is Reversal on Weaken — here's why you fall for it" card | H | M | `TypeAnalytics.tsx`, traps tab |
| A10 | **Study-mode hint** — `POST /api/ai/hint` returns a nudge without revealing the answer (only when `mode === "study"`) | M | M | New backend route; `section-runner.tsx` |
| A11 | **Quarantine triage assist** — render `GenJob.validation_report` checks; LLM "suggested verdict + reason"; human still decides | M | M | `Quarantine.tsx`, `generation_routes.py` |
| A12 | **Pregenerate cache controls** — Settings "Warm explanation cache for this PT / weak types"; show last warm time | M | S | `Settings.tsx`, `POST /api/ai/pregenerate` |
| A13 | **Trust strip in Settings** — model versions for explain/gen/embed, last explain latency (server + client), embed coverage %, gen queue depth, coach snapshot age | M | M | `Settings.tsx`; needs `GET /api/observability/status` |
| A14 | **Context provenance disclosure** — small "Used 3 notes from your error log" line on cached/live explanations (expandable detail for power users) | M | S | `Explanation.tsx` |
| A15 | **Weekly reflection AI summary** — once `Reflection` entity exists, generate weekly digest narrative | L | M | Depends on F-theme reflection journal |

---

# Theme B — Decision cockpit (Analytics v2)

Move analytics from "tabs of charts" to **a real diagnostic surface that predicts and prescribes**.

| # | Upgrade | Impact | Effort | Anchor |
|---|---------|--------|--------|--------|
| B1 | **Score projection cone with variance bands** — replace fixed-spread cone in `TrendChart` with bootstrapped variance from prior scores; expose 50/80/95% bands | H | M | `viz/TrendChart.tsx`, `analytics/forecast` |
| B2 | **Wire `/api/analytics/forecast`** — replace localStorage goal projection on Dashboard countdown + Analytics hero; on-track logic from server | H | S | `Countdown.tsx`, `Analytics.tsx` |
| B3 | **Time-on-question ridgeline** — visx ridgeline of per-question seconds, faceted by type, with target line | H | M | New `viz/TimeRidgeline.tsx`; Timing tab |
| B4 | **Focus quality timeline** — single-session timeline visualizing flags, answer changes, pauses, BR-corrected misses | H | L | New `viz/FocusTimeline.tsx`; requires backend timeline (B-theme below) |
| B5 | **BR gap Sankey** — timed outcome → BR outcome flow (timing problem / understanding gap / lucky / mastered) | H | M | New `viz/GapSankey.tsx`; Gap tab |
| B6 | **Trap spiral radial** — radial accumulated bar visualizing trap frequency over time; click sector → drill | M | M | New `viz/TrapSpiral.tsx`; Traps tab |
| B7 | **Readiness composite gauge** — multi-ring composite (accuracy / volume / consistency / SRS health) replacing current single-number ReadinessCard | H | M | `motivation/readiness-card.tsx` |
| B8 | **Session compare small multiples** — facet `TrendChart` by section type when comparing two sessions | M | S | `SessionCompare.tsx` |
| B9 | **Wire `/api/analytics/mastery`** — replace raw-accuracy `MasteryMatrix` with recency/difficulty-adjusted mastery from backend | H | S | `analytics/tabs.tsx`, `MasteryMatrix.tsx` |
| B10 | **Server-side date filtering** — backend honors `?days=` on `dashboard`, `by-type`, `traps`, `gap`, `by-difficulty`, `mastery` | H | M | All `analytics_routes.py` endpoints |
| B11 | **Brush persistence** — selected brush range survives tab change + reload; URL `?range=YYYY-MM-DD..YYYY-MM-DD` | M | S | `Analytics.tsx`, `analyticsParams.ts` |
| B12 | **Saved views server-side** — when an account/sync model exists, migrate `saved-views` from localStorage; share view via deep link | L | M | `saved-views.tsx`, future `GET /api/users/saved-views` |
| B13 | **Mastery → error-log drill-through** — click matrix cell → filtered error log; already partially wired, finalize | M | S | `tabs.tsx`, `error-log-workspace.tsx` |
| B14 | **Chart hover tooltips on all bespoke viz** — currently several charts mount without tooltips (`TrapBars`, `OutcomeFunnel`, `DifficultyTypeGrid`) | M | M | `viz/*`, `analytics/*` |
| B15 | **Real `GET /api/analytics/type/:qType`** — single backend payload (gap slice, traps, timing, last N misses) replacing 4–5 client round-trips | H | M | New backend route; `TypeAnalytics.tsx` |

---

# Theme C — Exam fidelity v2

Round 4 shipped accommodations, navigator v3, presets, scratch pad. R5 closes the **content-fidelity** and **second-screen** gaps.

| # | Upgrade | Impact | Effort | Anchor |
|---|---------|--------|--------|--------|
| C1 | **Real annotation persistence** — `PUT/GET/DELETE /api/attempts/{id}/annotations` (currently phantom in `api.ts`); cross-device markup | H | L | Backend new; `section-runner.tsx`, `BlindReview.tsx`, `Explanation.tsx` |
| C2 | **Underline + margin notes** — extend annotation model beyond highlight | H | M | `section-runner.tsx`, `AnnotatedText` |
| C3 | **RC passage pop-out window** — Tauri `WebviewWindow`; passage on second monitor with sync of scroll + line ruler | H | L | New `frontend/src-tauri/src/popout.rs`; `Exam.tsx` |
| C4 | **Section interstitial v2** — score estimate, pacing postmortem chart, "Resume in N minutes" actual break timer with controls | H | M | `section-interstitial.tsx` |
| C5 | **Heat strip during review synced to navigator** — live `HeatStrip` highlights current Q while reviewing | M | S | `BlindReview.tsx`, `HeatStrip.tsx` |
| C6 | **Exam route page transitions** — add `PageTransition` (motion-safe) on `/exam/*` and `/take/*` so entry/exit isn't a hard cut | M | S | `App.tsx` |
| C7 | **Kiosk / OS fullscreen mode** — optional Tauri fullscreen on exam start (Test Mode default off; gated behind setting) | M | M | Tauri capabilities; `Exam.tsx` |
| C8 | **Section presets v2** — remember last-used preset per section; preset chip in start dialog header | M | S | `section-presets-dialog.tsx`, `prefs.ts` |
| C9 | **Pre-submit v2** — list unanswered separately from flagged; "jump to first unanswered"; show timed-vs-elapsed | M | S | `pre-submit-review.tsx` |
| C10 | **Wire `POST /api/exams`** — single full-exam session instead of N section sessions; unified post-exam hub uses real combined PT score | H | M | `Exam.tsx`, `routers/exam_routes.py` |
| C11 | **Real focus quality score** — backend-derived from answer changes + flag toggles + time variance; replace cosmetic measure | M | M | Backend new; `Exam.tsx` post-section hub |
| C12 | **Pause behavior contract** — currently no explicit pause UX; decide rules (study mode pause allowed; test mode locked); document and surface | M | S | `section-runner.tsx`, keyboard help |
| C13 | **Audit accommodations** — verify break duration, extra-time %, hide-timer flag all flow into BR + interstitial + post-exam | M | S | `accommodations-settings.tsx`, `Exam.tsx`, `TakeSection.tsx` |

---

# Theme D — Review & explanation depth

| # | Upgrade | Impact | Effort | Anchor |
|---|---------|--------|--------|--------|
| D1 | **Inbox v2** — Review tabs: Buckets · Error log · Flagged · SRS (today). Replace current Review SRS tab redirect-stub with inline due-card queue | H | M | `Review.tsx` ~50–60 |
| D2 | **Cross-fade timed → BR reveal** — animated transition in `revealed-block` showing how your answer flipped | M | S | `revealed-block.tsx` |
| D3 | **Bucket previews from outcome** — hover any bucket → see preview of typical pattern; click → batch drill | M | S | `bucket-queue.tsx` |
| D4 | **Real flagged-only BR session** — currently `br_flagged` preset navigates away (`TakeSection.tsx` ~128); make it in-place BR session | H | M | `TakeSection.tsx`, `BlindReview.tsx` |
| D5 | **`POST /api/srs/cards` (bulk)** — "Add similar to SRS" actually schedules reviews; flush `srsQueue.ts` localStorage wishlist | H | M | Backend new; `srsQueue.ts`, similar carousel |
| D6 | **Error-log delete + edit reason** — `DELETE /api/error-log/{id}`, `PATCH .../{id}`; undo toast wired to real mutations | M | S | Backend new; `error-log-workspace.tsx` |
| D7 | **Similar carousel sources** — show similarity score + source (PT 73 §2 Q14); link to its explanation | M | S | `similar-questions.tsx` |
| D8 | **Choice breakdown enter motion** — accordion mount stagger; spring on open | L | S | `choice-breakdown.tsx` |
| D9 | **Explanation "what context was used"** — small disclosure of RAG notes used for this explanation | M | S | `Explanation.tsx` |
| D10 | **BR worksheet v2** — include type heading per Q; bigger annotation space; printable A4/Letter | M | S | `br-worksheet-export.ts` |
| D11 | **Inline ask AI on stem** — select stem text → "Ask AI about this" popover (study mode only) | M | M | `section-runner.tsx`, `BlindReview.tsx` |

---

# Theme E — Practice journey & habit (90-day grind)

| # | Upgrade | Impact | Effort | Anchor |
|---|---------|--------|--------|--------|
| E1 | **Server-driven Today plan** — replace `TodayPlan` localStorage + heuristic with `GET /api/study/today` + `PUT /api/study/plan` | H | M | `TodayPlan.tsx`, `study_routes.py` |
| E2 | **Goal & forecast unified** — Settings goal form writes `/study/plan`; Dashboard countdown + Analytics hero read from same `/study/today` | H | M | `goal-settings-form.tsx`, `Countdown.tsx` |
| E3 | **Reflection journal** — backend entity `Reflection(session_id, text, prompts[])`; UI on `SessionHistory` + post-exam wizard step | M | M | Backend new; `SessionHistory.tsx`, `post-exam-wizard.tsx` |
| E4 | **30/60/90 retrospective** — period selector on Analytics; cohort metric "you in week 6 vs week 1" | M | M | `Analytics.tsx` |
| E5 | **Personal best history** — sparkline of section PBs by type | M | S | `Dashboard.tsx`, recap area |
| E6 | **Weekly report v2** — server bundle from `/api/analytics/report` + embedded charts + reflection summary; HTML email-ready | M | M | `weeklyReport.ts`, backend |
| E7 | **Streak insights v2** — best day-of-week, average minutes, on-pace days vs goal | M | S | `streak-insights.tsx` |
| E8 | **Onboarding v3** — baseline 5Q drill writes to analytics so first dashboard isn't empty; resume onboarding mid-flow | H | M | `onboarding-wizard.tsx` |
| E9 | **Goal nudges** — if exam date <30 days and BR completion <70%, prominent (dismissible) banner | M | S | `study-nudge.tsx` |
| E10 | **Resume context cards on dashboard** — "Resume Section 3 of PT 73" with section-aware preview | M | S | `Dashboard.tsx`, `resume.ts` |
| E11 | **Calendar timezone correctness** — verify activity heatmap respects local TZ everywhere | L | S | `ContributionHeatmap.tsx` |

---

# Theme F — Bank as quality cockpit

Bank today reads like internal tooling. Round 5 makes it a **library + quality dashboard**.

| # | Upgrade | Impact | Effort | Anchor |
|---|---------|--------|--------|--------|
| F1 | **Browser-first IA** — default tab `Browse` not `Operations`; admin sections collapsed behind disclosure | H | S | `Bank.tsx` ~189 |
| F2 | **Real bulk-tag endpoint** — backend `POST /api/bank/bulk-tag`; remove phantom in `api.ts`; show tag confidence in browser | M | S | Backend new; `tag-editor.tsx`, `api.ts` |
| F3 | **Audit dashboard** — wire `GET /api/bank/audit` + `/duplicates` into Bank: duplicates count, low-tag-confidence count, missing q_type, near-dup clusters | H | M | New `bank/audit-panel.tsx` |
| F4 | **Tag review queue UI** — `GET /api/bank/tag-review` + accept/correct workflow | M | M | New `pages/BankTagReview.tsx` |
| F5 | **Embedding controls** — coverage % chip + "Embed N missing" button → `POST /api/bank/embed` with progress | M | M | `Bank.tsx`, audit panel |
| F6 | **Gen job queue UI** — `GET /api/gen/jobs` list with status + validation_report preview | M | M | New `bank/gen-jobs.tsx` |
| F7 | **Import diff side-by-side** — keep current verify tree; add side-by-side raw vs parsed view | M | M | `Import.tsx`, `ImportStructureTree` |
| F8 | **Merge/replace rules** — when re-importing same PT detect collisions and offer keep/replace per section | H | L | Backend new; `Import.tsx` |
| F9 | **Backup folder picker** — Tauri fs `pickFolder`; remember location; rotate snapshots | M | M | `tauri.ts`, `Settings.tsx` |
| F10 | **Copy bug fix on Bank** — orphaned `low-confidence items.` sentence (`Bank.tsx` ~341) and admin-facing copy throughout | H | S | `Bank.tsx` |
| F11 | **Question preview drawer** — stem + choices + similar without leaving Bank | M | M | `bank/question-browser.tsx` |
| F12 | **Quarantine v2** — show real validation checks, parent question link, batch reject with reason | M | M | `Quarantine.tsx` |

---

# Theme G — Design system enforcement

| # | Upgrade | Impact | Effort | Anchor |
|---|---------|--------|--------|--------|
| G1 | **Density end-to-end** — Card, tables, lists, exam chrome consume `var(--space-unit)`; compact density visibly tightens Analytics/Review/Bank | H | M | `index.css`, all `ui/*`, `analytics/tabs.tsx` |
| G2 | **Micro-typography tokens** — add `text-2xs` (10/14) and `text-micro` (9/12) to Tailwind; migrate 17+ ad-hoc `text-[9–11px]` sizes | M | S | `tailwind.config.js`, navigator/heatmap/ProgressRing |
| G3 | **Unified elevation on primitives** — replace stock `shadow-sm/md/lg` on `Card/Dialog/Dropdown/Sheet/Switch` with `shadow-e1…e3` | M | S | `components/ui/*` |
| G4 | **Install missing shadcn primitives** — Accordion (replace `choice-breakdown` chevron), Checkbox/RadioGroup (forms + ChoiceList), Popover (reading-controls), Slider (measure/onboarding), Pagination, Table/DataTable, Alert, Toggle/ToggleGroup, Stepper | H | M | `components/ui/` |
| G5 | **Canonicalize empty/loading/error** — migrate all `return null` loaders and inline empties to `Skeleton*` / `EmptyState` / `ErrorState`; ensure every page survives error/empty/loading paths | H | M | `SessionHistory`, `TodayPlan`, `saved-views`, `flagged-queue`, `import-job-history`, `analytics/tabs` |
| G6 | **Motion pass on secondary surfaces** — `AnimatePresence` on bucket/error/flagged/session lists; chart draw-in for `TrendChart`/`GapDumbbell`; `motion-reduce` guards on `animate-pulse` and `GlobalLoadingBar` | M | M | `bucket-queue.tsx`, `viz/*`, `navigator-strip.tsx`, `global-loading-bar.tsx` |
| G7 | **Dark-mode chart/UI polish** — theme-aware marks in `HeatStrip`, `TypeBadge` solid foregrounds via CSS vars; audit Card shadows in dark | M | S | `viz/HeatStrip.tsx`, `viz/TypeBadge.tsx` |
| G8 | **Icon size tokens + lint** — `icon-sm` (12), `icon-md` (16), `icon-lg` (20); doc rule for decorative vs interactive; lint against `h-3/h-3.5` sprawl | L | S | new util, ~50 files |
| G9 | **Graphite ramp tokens** — `--graphite-50…950` in CSS + `graphite` in Tailwind for rare non-semantic uses | L | S | `index.css`, `tailwind.config.js` |
| G10 | **Highlighter token migration** — `.hl-*` rgba in CSS → semantic CSS vars; toolbar uses tokens not raw Tailwind palette | L | S | `index.css` ~246–257; `highlighter-toolbar.tsx` |
| G11 | **Page chrome on loading/error** — pages that currently return bare `LoadingState`/`ErrorState` outside `PageLayout` cause layout jump (PrepTests, Srs, Explanation) | M | S | `PrepTests.tsx`, `Srs.tsx`, `Explanation.tsx` |
| G12 | **Standardize primary CTA labels** — `Start / Open / Continue / Drill this type` all in use for the same action; pick a verb ladder and document | L | S | `docs/07-design-tokens.md`, app-wide |

---

# Theme H — API & backend coordination

These items are **frontend → backend** asks; ship them before depending UI items.

| # | Upgrade | Impact | Effort | Anchor |
|---|---------|--------|--------|--------|
| H1 | **Attempt-scoped annotation CRUD** — `PUT/GET/DELETE /api/attempts/{id}/annotations` (used by exam + BR + Explanation) | H | L | Backend new |
| H2 | **`POST /api/srs/cards` (bulk)** — create SRS cards from question IDs | H | M | Backend new; `srsQueue.ts` |
| H3 | **`GET /api/preptests/{id}/progress`** — sections done, best score, BR%, attempts count per section | H | M | Backend new; `PrepTests.tsx`, `PrepTestAnalytics.tsx` |
| H4 | **`GET /api/analytics/type/{q_type}`** — single payload for TypeAnalytics page | H | M | Backend new; `TypeAnalytics.tsx` |
| H5 | **`DELETE /api/error-log/{id}` + `PATCH .../{id}`** — undo + edit | M | S | Backend new |
| H6 | **`GET /api/observability/status`** — `{gen_queued, gen_running, worker_alive, last_coach_refresh_ms, explain_p50_ms, embed_coverage_pct}` | M | M | Backend new |
| H7 | **`?days=` on all analytics** — server-side date filtering on dashboard / by-type / traps / gap / mastery / forecast | H | M | `analytics.py`, `analytics_routes.py` |
| H8 | **Enriched session list** — extend `GET /api/sessions` with `duration_sec`, `br_accuracy`, `official_only_score` so SessionHistory/timeline don't N+1 results | H | S | `sessions.py` |
| H9 | **Wire existing unwired endpoints** — `/api/ai/coach`, `/api/ai/coach/refresh`, `/api/ai/pregenerate`, `/api/analytics/mastery`, `/forecast`, `/report`, `/api/gen/jobs`, `/api/gen/coverage`, `/api/bank/tag-review`, `/api/bank/embed`, `/api/bank/audit`, `/api/bank/duplicates`, `/api/import/reconcile`, `/api/settings`, `/api/study/*`, `POST /api/exams` | H | L | `api.ts`, `hooks.ts`, page-level wiring |
| H10 | **Remove phantom endpoints** — `GET /api/questions/{id}/similar`, `POST /api/bank/bulk-tag`, `*/annotations` in `api.ts` either backed by real routes (H1, F2) or rewritten | M | S | `api.ts` |
| H11 | **Refresh API contract doc** — `docs/05-api-contract.md` currently documents ~25 of 52 routes; sync with OpenAPI | M | S | `docs/05-api-contract.md` |
| H12 | **Migrate Bank/Explanation/Import to TanStack Query** — currently raw `fetch` + `useEffect` (no cache, no dedup, no offline integration) | H | M | `Bank.tsx`, `Explanation.tsx`, `Import.tsx` |
| H13 | **Fix `DifficultyTypeGrid` `days` key mismatch** — calls `useByType(source)` while parent passes `useByType(source, days)`; duplicate query keys with inconsistent data | M | S | `difficulty-type-grid.tsx` |

---

# Theme I — Native desktop class (Tauri)

| # | Upgrade | Impact | Effort | Anchor |
|---|---------|--------|--------|--------|
| I1 | **Wire dialog + fs plugins end-to-end** — add to `Cargo.toml`, register in `Builder`, add capabilities, install npm packages; unblocks native PDF picker, backup folder, restore | H | S | `frontend/src-tauri/Cargo.toml`, `capabilities/default.json`, `tauri.ts` |
| I2 | **RC passage pop-out window** — second `WebviewWindow` with scroll/highlight sync via Tauri events | H | L | New `src-tauri/src/popout.rs`; `Exam.tsx` |
| I3 | **Bundle Python backend as sidecar** + cross-platform spawn (mac/linux Python at `bin/python`) | H | L | `lib.rs` ~21; tauri sidecar config |
| I4 | **Fix window restore permissions** — `setSize`, `setPosition`, `innerSize`, `outerPosition` are used in `titlebar.tsx` but missing from capabilities (silent failure in packaged build) | H | S | `capabilities/default.json` |
| I5 | **Rich system tray** — dynamic items: "Resume X", "Today: N minutes left", "N SRS due"; live update on dashboard refetch | M | M | `lib.rs` `setup_tray` |
| I6 | **Global hotkeys** — `tauri-plugin-global-shortcut`; ⌘⇧K palette, optional pause; Test Mode safeguards | M | M | New plugin |
| I7 | **OS notifications** — `tauri-plugin-notification`; SRS due, generation finished, weekly report ready | M | M | New plugin |
| I8 | **Kiosk fullscreen mode** — optional setting; engages on `/exam/*` start; releases on done | M | M | Window API |
| I9 | **Deep links (`lsatlab://`)** — protocol handler for share / coach CTAs | M | M | tauri.conf.json + listener |
| I10 | **Code signing pipeline** — Apple notarization + Windows certificate config | M | L | `tauri.conf.json`, CI |
| I11 | **Auto-update channel** — `tauri-plugin-updater`; stable/beta badge in Settings | L | L | New plugin; Settings |
| I12 | **Platform-aware titlebar** — mac traffic-light layout left; native title style | L | S | `titlebar.tsx` |
| I13 | **Crash reporting + file logs** — release-mode `tauri-plugin-log` rotation; surface log file path in Settings | L | M | `lib.rs`, Settings |
| I14 | **Branded icon set** — replace starter icons with LSAT Lab flask (matches in-app titlebar) | L | S | `frontend/src-tauri/icons/*` |

---

# Theme J — Performance & engineering hygiene

Target budgets after Round 5: **initial JS ≤ 300 kB gzipped on `/`**, **dashboard LCP < 2.0s**, **route transitions ≤ 200ms**.

| # | Upgrade | Impact | Effort | Anchor |
|---|---------|--------|--------|--------|
| J1 | **Lazy non-critical shelled routes** — Settings, Review, Practice, PrepTests, Drills, Srs are still static imports | H | S | `App.tsx` ~44–53 |
| J2 | **Split Dashboard below-the-fold** — lazy `StudyCalendar`, `SessionRecap`, `Milestones` (each pulls viz/html-to-image/confetti) | H | S | `Dashboard.tsx` |
| J3 | **Dynamic-import `html-to-image` + confetti at call sites** | H | S | `recapExport.ts`, `confetti.ts` |
| J4 | **Lazy Analytics tab panels** — `tabs.tsx` currently ships every tab in one chunk | H | M | `analytics/tabs.tsx`, `Analytics.tsx` |
| J5 | **Defer Newsreader/Geist Mono fonts** — load only when reading/exam serif active | M | S | `index.css` |
| J6 | **Extend `manualChunks`** — `cmdk`, `html-to-image`, `zod`, `react-hook-form`, `sonner` | M | S | `vite.config.ts` |
| J7 | **Lazy CommandPalette dialog body** — load `cmdk` only on first ⌘K | M | S | `command-palette.tsx` |
| J8 | **Lazy `OnboardingWizard`** — render only after first interaction or idle | L | S | `App.tsx` |
| J9 | **ErrorBoundary on route trees** — catch unhandled render errors without app-wide blank | H | S | new `components/error-boundary.tsx` |
| J10 | **TanStack Query devtools (dev only)** + global staleTime per query class | L | S | `main.tsx` |
| J11 | **Bundle analyzer in CI** — `rollup-plugin-visualizer`; fail PR if main chunk grows >10% | M | S | `vite.config.ts`, CI |
| J12 | **Web vitals reporting** — `web-vitals` lib → console in dev, log to file in Tauri | L | S | `main.tsx` |

---

# Theme K — A11y, testing, and quality gates

| # | Upgrade | Impact | Effort | Anchor |
|---|---------|--------|--------|--------|
| K1 | **`aria-label` sweep on icon-only buttons** — navigator, similar-questions prev/next, saved-views delete, recommendation-inbox menu, section-runner focus mode | H | S | many |
| K2 | **`aria-live` on AI streaming** — wrap streamed markdown in `aria-live="polite"`; `role="status"` for "Generating…" | H | S | `Explanation.tsx` |
| K3 | **`motion-reduce:animate-none`** — navigator unanswered pulse; explanation cursor; `GlobalLoadingBar` | M | S | `navigator-strip.tsx`, `Explanation.tsx`, `global-loading-bar.tsx` |
| K4 | **Contrast pass** — light `--muted-foreground` borderline AA; bump from 49% → ~40% L; avoid `text-muted-foreground/70` on small text | H | S | `index.css`, `app-shell.tsx`, `page-layout.tsx` |
| K5 | **Heading hierarchy audit on exam routes** — ensure single h1 per page incl. `TakeSection`/`Exam` | M | S | exam pages |
| K6 | **Exam progress map text alternative** — current title-only tooltips don't announce; provide ordered list + step state via aria | M | S | `exam-progress-map.tsx` |
| K7 | **Add `eslint-plugin-jsx-a11y`** + CI rule | M | S | `eslint.config.js` |
| K8 | **Add Vitest** — unit tests for `withFallback`, `prefs`, `offline` snapshot stability, `choice-list`, `virtual-list`, label builders | H | M | `package.json`, new tests |
| K9 | **E2E expansion** — exam timed flow, BR full loop, explanation streaming + abort, settings persistence, SRS rating, ⌘K palette, offline queue → sync | H | M | `e2e/*` |
| K10 | **Visual regression baselines** — Playwright `expect(page).toHaveScreenshot()` on Dashboard, Analytics, Exam intro, Explanation | M | M | `e2e/visual/*` |
| K11 | **Lighthouse CI** — score gates on routes / | M | S | CI |
| K12 | **Reduce-motion checked in tests** — toggle prefers-reduced-motion in Playwright; ensure no motion regressions | M | S | `playwright.config.ts` |

---

# Theme L — Page-level polish catch-up (concrete 1-week pass)

Granular fixes called out by the page audit; ship these together so the weakest surfaces stop dragging the product.

| # | Upgrade | Impact | Effort | Anchor |
|---|---------|--------|--------|--------|
| L1 | **Bank: copy bug + browse-first** — kill orphaned `low-confidence items.` sentence; default tab = Browse | H | S | `Bank.tsx` |
| L2 | **TypeAnalytics: kill `accuracy + 0.05`** — wire real BR data; add trend sparkline; render real traps list | H | M | `TypeAnalytics.tsx` |
| L3 | **SessionHistory: empty + error states** — `EmptyState` with CTA to Practice; handle `isError`; reflection snippet doesn't break layout | H | S | `SessionHistory.tsx` |
| L4 | **BlindReview: empty illustration** — replace plain `<p>` with `EmptyState` + nav home link in custom header | M | S | `BlindReview.tsx` |
| L5 | **Dashboard: hover-only actions discoverability** — make Drill/Analytics on weakest types always-visible on touch / small screens; revisit `opacity-0` pattern | M | S | `Dashboard.tsx` ~318 |
| L6 | **Drills: variants + a11y** — source toggles use `Button` + `aria-pressed`; replace native checkbox with `Switch` for consistency with Settings | M | S | `Drills.tsx` |
| L7 | **Quarantine: real keyboard shortcuts** — footer claims `A approve · D dismiss` but no handlers; wire them or remove the hint | M | S | `Quarantine.tsx` |
| L8 | **Review: SRS tab inline** — render due card queue instead of redirect stub | H | M | `Review.tsx` |
| L9 | **Sample badge copy consistency** — "Sample data (backend offline)" vs "Sample data"; pick one and apply everywhere | L | S | Dashboard, PrepTests, others |
| L10 | **Standardize loading shells** — `PageLayout` wraps loading & error in PrepTests, Srs, Explanation so title bar doesn't jump | M | S | many |

---

## Suggested implementation rounds

### R5-A — Wire what we already have (~1.5 weeks)
**Items:** H8, H9, H10, H11, H12, A2, A5, B2, B9, B10, E1, E2, F3, F5
*Outcome:* The largest UX gains come for free — coach snapshot drives the dashboard, mastery model drives the matrix, study plan drives Today, bank exposes its quality dashboard. No new viz, no new backend logic beyond `?days=` filtering.

### R5-B — Continuous tutor (~2 weeks)
**Items:** A1, A3, A4, A6, A7, A10, A11, A12, A13, A14, D7, D9, D11, F6
*Outcome:* The Explanation page goes from "AI on click" to a real conversation; coach docks; error-log gains AI diagnosis; quarantine and gen-job queue become trustable.

### R5-C — Analytics v2 (~2 weeks)
**Items:** B1, B3, B4, B5, B6, B7, B8, B11, B13, B14, B15, H4, H7
*Outcome:* Cone with real variance, time ridgeline, focus timeline, sankey, radial trap spiral. Date filtering is server-side. Saved views feel like cockpit presets.

### R5-D — Exam fidelity v2 (~2 weeks)
**Items:** C1, C2, C3, C4, C5, C6, C7, C10, C11, H1, I2, I4
*Outcome:* Annotations survive across machines, RC pops out to a second window (or fullscreen), exam routes have transitions, focus quality is real.

### R5-E — Design system & page polish (~1.5 weeks)
**Items:** G1–G12, L1–L10, K1–K4
*Outcome:* Density is real; missing primitives installed; every page has canonical empty/loading/error chrome and AA contrast. Weakest pages stop dragging the product.

### R5-F — Habit & motivation v2 (~1 week)
**Items:** E3, E4, E5, E6, E7, E8, E9, E10, A9
*Outcome:* Reflection journal exists; retrospective views; PB sparklines; weekly report v2; per-trap explainer.

### R5-G — Native desktop class (~2 weeks)
**Items:** I1, I3, I5, I6, I7, I8, I9, I12, I14
*Outcome:* PDF picker actually works; backend bundled; tray is alive; global hotkeys; OS notifications; kiosk; branded icons.

### R5-H — Perf, a11y, testing (~1.5 weeks)
**Items:** J1–J11, K5–K12
*Outcome:* Initial JS budget met; Vitest live; E2E covers exam/BR/explanation; bundle analyzer + lighthouse + visual regression in CI.

---

## Top 20 "do these first" (cross-theme prioritized)

1. **H9 + H12** — Wire existing unwired endpoints (coach, mastery, forecast, study, settings, gen jobs, bank audit) and migrate Bank/Explanation/Import to TanStack Query. *The biggest free lift in the entire roadmap.*
2. **A1 + A2 + A3** — Real follow-up explain, cached-vs-live badge, Stop + Retry.
3. **A5** — Dashboard coach card reads scheduled snapshot.
4. **A6** — Populate `ai_diagnosis` on error-log save.
5. **B1 + B2** — Score projection cone with variance + forecast endpoint wiring.
6. **C1 + H1** — Real attempt-scoped annotation API + cross-device markup.
7. **C3** — RC passage pop-out window (Tauri multi-window).
8. **C10** — Wire `POST /api/exams` for unified full-exam flow.
9. **D5 + H2** — `POST /api/srs/cards` bulk; flush srsQueue.
10. **E1 + E2** — Replace localStorage study plan + goal with server endpoints.
11. **G1 + G4** — Density end-to-end + install missing shadcn primitives.
12. **G5 + G11** — Canonicalize empty/loading/error patterns + chrome on loading routes.
13. **I1 + I4** — Wire dialog/fs plugins + fix window restore permissions.
14. **I3** — Bundle Python backend as sidecar.
15. **J1 + J2 + J3** — Lazy non-critical routes, split Dashboard, dynamic html-to-image/confetti.
16. **K1 + K2 + K4** — A11y label sweep + AI stream live region + contrast bump.
17. **K8 + K9** — Vitest + E2E expansion to exam/BR/explanation.
18. **L1 + L2 + L3** — Fix Bank copy + TypeAnalytics fake data + SessionHistory states.
19. **F3 + F5 + F6** — Bank audit dashboard + embed controls + gen job queue.
20. **A7** — Docked coach panel for review/study mode (the conceptual centerpiece).

---

## Success metrics (how to know R5 worked)

1. **Time-to-insight** — dashboard → coach insight rendered in < 200ms (snapshot path).
2. **Explain depth** — % of explanations where user asks at least one follow-up.
3. **Annotation survival** — % of attempts with annotations whose highlights survive reinstall.
4. **Bank quality** — duplicate count, low-confidence tag count, embed coverage % each visible on Bank dashboard, all trending down/up appropriately.
5. **PrepTest workflow** — % of `POST /api/exams` sessions vs legacy per-section sessions.
6. **Native feel** — PDF import via native picker on packaged build (binary metric: works or doesn't).
7. **Performance** — initial JS on `/` ≤ 300 kB gzipped; Dashboard LCP < 2.0s; route transition median ≤ 200ms.
8. **A11y** — axe-core scan reports 0 violations on Dashboard, Analytics, Exam intro, Explanation; muted-foreground passes AA.
9. **Test coverage** — Playwright covers 100% of the top-10 user flows; Vitest covers 100% of `lib/*`.
10. **Tutor continuity** — survey or session metric: % of review sessions where the docked coach is opened.

---

## Backend coordination summary (new endpoints by priority)

| Priority | Endpoint | Used by |
|----------|----------|---------|
| 1 | `?days=` honored on `dashboard`, `by-type`, `traps`, `gap`, `mastery`, `by-difficulty`, `forecast` | All analytics |
| 1 | `PUT/GET/DELETE /api/attempts/{id}/annotations` | C1, C2 |
| 1 | `POST /api/srs/cards` (bulk) | D5 |
| 1 | `GET /api/analytics/type/{q_type}` | A2, B15 |
| 1 | `GET /api/preptests/{id}/progress` | E10, H3 |
| 1 | `GET /api/observability/status` | A13, H6 |
| 2 | `DELETE /api/error-log/{id}`, `PATCH /api/error-log/{id}` | D6 |
| 2 | Enriched `GET /api/sessions` (duration, BR%, official-only score) | B8, E5, SessionHistory |
| 2 | `user_message` + `focus_choice` on `POST /api/ai/explain` | A1 |
| 2 | Per-choice SSE events | A4 |
| 3 | `POST /api/drills/intent` (NL → DrillConfig) | A8 |
| 3 | `POST /api/ai/hint` | A10 |
| 3 | `POST /api/bank/bulk-tag` | F2 |
| 3 | Reflection journal entity + endpoints | E3 |

---

## Explicitly deprioritize (out of scope for R5)

- Multi-user, cloud sync, accounts (vision constraint).
- Mobile / responsive collapse below 1024px (desktop-first stays).
- Heavy gamification (XP / avatars / leaderboards).
- Cloud LLM in realtime tier (Tier A stays local).
- Logic Games (retired).
- Subscription / billing UI.

---

*When a round is locked for implementation, copy the relevant section into `docs/13-ui-round-5a-shipped.md` (etc.) and keep this file as the master backlog. Update [docs/05-api-contract.md](05-api-contract.md) as endpoints land.*
