# UI Round 3 (shipped)

Flagship depth: analytics truth, review loop, exam craft, quarantine, engineering polish.

## R3-A — Analytics truth

- Optional `days` query on analytics API calls (backend-safe; ignored until supported)
- `AnalyticsProvider` shares source/range/compare across tabs
- True prior-period overlay on trend (real dates from `splitTrendPeriods`)
- `SessionCompare` on Timing tab + session list filtered by range
- CSV export on traps tab; error-log drill link from traps empty state

## R3-B — Review loop

- `ErrorLogWorkspace`: search + reason filters + drill/explain actions
- `BucketQueue`: multi-session review queue (up to 8 sessions, all-recent or single-session scope)
- Explanation links preserve `?attempt=` from buckets / blind review

## R3-C — Exam craft

- Full exam: pre-submit dialog, `finishSession` per section, `PostExamHub` before blind review
- Intro rules + keyboard help shortcut
- Break skip button
- Navigator hover preview (stem snippet)
- Reading line-width slider (`measureCh` 58–75ch)

## R3-D — Motivation

- `computeMilestoneUnlocks` drives `MilestoneGallery` on dashboard

## R3-E — Engineering

- `useImportCommit` wired on Import page
- Gen/quarantine API client + `/quarantine` page + nav
- `useGenQuarantine` hook

## Deferred (completed)

- **Keyboard rebinding** — `KeyboardSettings` + persisted `keyboardMap`; `section-runner` uses `resolveExamKey`
- **Forms** — `GoalSettingsForm` (react-hook-form + zod) on Settings; `ImportNameField` on Import verify
- **Rich recap export** — `RecapShareCard` + `html-to-image` PNG/SVG from Session recap
- **Gap compare** — session-based current vs prior overlay on Gap tab when compare is on (`gapFromSessions` + `GapDumbbell.priorRows`)

## Verify

```bash
cd frontend && npm run build
```
