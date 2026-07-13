# UI Round 4 (shipped)

Master backlog: [10-ui-round-4-roadmap.md](10-ui-round-4-roadmap.md). This doc tracks what landed across implementation passes.

## R4-A — Close the loop

- Practice hub, resume, recommendation inbox, readiness KPI
- NarrativeCards on Analytics; coach refresh via `ai/diagnose`
- Trap spiral (5Q) on Drills
- TodayPlan v2 — minutes budget + ordered study steps
- Study nudge banner (dismissible)
- Streak insights on dashboard

## R4-B — Exam fidelity

- Accommodations, adjusted timer, navigator v3, pre-submit v2
- Section presets (timed / untimed / BR flagged)
- Scratch pad (typed + canvas drawing)
- Section interstitial pacing recap on full-exam breaks
- Exam progress map, break timer from accommodations
- RC line ruler overlay
- Choice size/spacing in reading prefs
- Optional section-end chime (`examSounds` + settings)

## R4-C — Analytics cockpit

- Timing budget, trend brush → filter, type drill-down, session history/compare
- Saved analytics views, analytics alerts toast
- Trap trends, difficulty×type grid, heatmap session compare
- Per-PrepTest analytics (`/analytics/pt/:ptId`)
- Outcome funnel on post-exam surfaces

## R4-D — Review & explanation

- Unified review inbox (Buckets · Error log · Flagged · SRS)
- BR batch filters + URL `?filter=flagged`
- Error pattern banner, similar questions, timed/BR answer card
- Choice breakdown accordion, annotations in BR + Explanation
- Annotation server sync (localStorage + API fallback)
- BR worksheet export, bucket preview on reveal
- Confidence UX (larger controls, remember last)

## R4-E — Content ops

- Bank Operations / Browse + virtualized browse list
- Bulk tag editor (API with client fallback)
- Import verify tree + diff line highlights + job history (resume parse jobs)
- Quarantine batch approve + local dismiss
- PrepTest progress rings, study PT wizard

## R4-F — Motivation

- Streak freeze confirm, weekly goals readout
- Onboarding keyboard tour + baseline drill step
- Reflection notes (wizard + session history)
- Milestone share PNG cards
- Weekly report HTML with score trend table + SVG chart

## R4-G — Platform

- Lazy routes, command palette recents, global loading bar
- Offline write queue + sync banner
- Virtualized error log (`@tanstack/react-virtual`)
- Undo toasts for offline error-log queue
- E2E smoke expansion (drills, bank browse, review tabs, practice, history)
- `NotFound` + keyboard help from live map

## R4-H / I — Engineering & Tauri (client-side)

- Optimistic/queued attempt saves in exam / BR / error log
- Tauri: PDF picker via plugin-dialog (external in Vite build), tray open event listener, window prefs in titlebar
- Import diff helpers (`importDiff.ts`)

## Explicitly deferred (needs backend or large scope)

- Full LawHub freehand scratch parity, RC pop-out window (I4)
- Full offline IndexedDB + background sync worker
- Virtualized bank table at 10k+ rows without pagination API
- Import merge/replace rules (F5), gen model side-by-side (F7)
- Auto-update channel (I6), OS global hotkeys in exam (I2/C12)
- Type primer content library (D10), full PDF analytics export (E10)
- Storybook sections (H15)

## Verify

```bash
cd frontend && npm run build
cd frontend && npm run test:e2e   # requires dev server or webServer in playwright config
```
