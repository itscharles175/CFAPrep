# UI Round 2 (shipped)

Round 2 completes partial Round 1 work and adds analytics truth, exam depth, and motivation polish. Backend-safe: client-side date filtering until API adds `days` query params.

## R2-A — Foundation

- `PageLayout` on Import, Bank, SRS, Styleguide
- `AnalyticsFilters` sheet (source, range, compare)
- `useCreateDrill`, `useAddErrorLog`, `useImportCommit` in `lib/mutations.ts`
- `ScrollArea` on Import verify panes
- `lib/dateRange.ts`, `lib/weeklyReport.ts`, `lib/scrollRestore.ts`

## R2-B — Exam

- Reading presets in `READING_PRESETS` + ReadingControls
- RC line jump scroll via `usePassageScroll` in section runner
- BlindReview split: `br-answer-panel`, `revealed-block`
- Keyboard help copy fix
- Explanation error log uses `attempt` query param (API contract)

## R2-C — Analytics

- Client-side trend filter by 7d / 30d / all
- Compare prior period overlay on `TrendChart`
- Brush selection on trend (drag)
- `/analytics?tab=&q_type=` deep links
- CSV export on type mastery table
- NarrativeCards analytics drill CTAs

## R2-D — Motivation

- `MilestoneGallery` on dashboard
- Weekly HTML report download
- Session recap PNG export (`lib/recapExport.ts`)
- Main scroll preserved per route (`scrollRestore.ts`)

## Verify

```bash
cd frontend && npm run build && npm run test:e2e
```
