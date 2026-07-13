# Shared Study-Profile Contract (DATA-6)

Status: shipped (Wave 7, DATA-6). Local-only personal offline app.

One reconciled **study profile** that the host (CFA/Quant/Excel) and the LSAT
backend agree on. It folds the two pre-existing, independent notions of "the
student's goal" into a single source of truth that LEARN-3 (unified daily plan)
and ANL-4 (readiness) consume next:

| Side  | Pre-existing store | Owns |
|-------|--------------------|------|
| LSAT backend | `StudyPlan` SQLModel row (`target_score`, `exam_date`, `daily_minutes`) | the LSAT scaled-score goal + exam date + daily budget |
| Host | `StudyPlanSettings` Dexie row (`targetLevel`, `dailyTargetMinutes`, `examDate`, `restDays`, `mockCadenceDays`, `topicWeights`) | the CFA level target + budget + planning knobs |

Neither side previously knew about the other. DATA-6 reconciles them.

## Single source of truth

The **LSAT backend arbiter** owns the canonical profile:

- `GET /api/study/profile` → the reconciled profile (idempotent, never mutates).
- `PUT /api/study/profile` → write it (partial; only sent fields change).

The host keeps a **local Dexie mirror** (`StudyPlanSettings`) and dual-writes
through the bridge, so an edit survives a down sidecar and the profile is still
readable offline.

### Storage

| Concern | Where |
|---------|-------|
| Canonical reconciled profile | `SharedStudyProfile` SQLModel row, keyed `profile_key="default"` (single-user; UNIQUE index `ux_sharedstudyprofile_key`, migration 24) |
| LSAT scalars | the active `StudyPlan` row (`PUT` writes through `study_plan.upsert_plan`, preserving the single-active-plan invariant). Migration 24 also adds `studyplan.updated_at` (backfilled from `created_at`) — the last-write-wins ordering key. |
| Host-owned fields the `StudyPlan` can't hold (`target_level`, `rest_days`, `mock_cadence_days`, `topic_weights`) | the `SharedStudyProfile` row |
| Host local mirror | Dexie `studyPlanSettings` (`id="local-study-plan"`) |

## Wire shape

Backend response (`SharedStudyProfileOut`, inline `response_model`) and `PUT`
body (`StudyProfileBody`) are snake_case. The host type
(`src/lib/types/StudyProfile.ts`, NOT in `learningTypes.ts`) is camelCase; the
bridge maps between them.

```jsonc
// GET /api/study/profile  → 200
{
  "has_plan": true,
  "target_score": 172,         // reconciled (LSAT scalar)
  "exam_date": "2026-09-12",   // reconciled (LSAT scalar)
  "daily_minutes": 75,         // reconciled (LSAT scalar)
  "target_level": "level2",    // host-owned
  "rest_days": [0, 6],         // host-owned
  "mock_cadence_days": 10,     // host-owned
  "topic_weights": {"LR": 0.6},// host-owned
  "last_writer": "host",       // informational provenance
  "updated_at": "2026-06-16T..."// the timestamp the arbiter ordered by
}
```

`PUT` accepts any subset of the writable fields (`target_score`, `exam_date`,
`daily_minutes`, `target_level`, `rest_days`, `mock_cadence_days`,
`topic_weights`, `last_writer`). Unsent fields keep their current reconciled
value (no zeroing). Scalars are clamped on write (target 120-180, daily minutes
5-600, rest days 0-6, mock cadence 1-90).

## Conflict policy — last-write-wins by `updated_at`

Every writer stamps a fresh `updated_at`:

- `PUT /api/study/profile` stamps both the `StudyPlan` row and the
  `SharedStudyProfile` row with the same `now`.
- The legacy `PUT /api/study/plan` stamps only the `StudyPlan` row (its
  `updated_at` default_factory fires on insert).

`GET` reconciles per shared scalar: the side whose `updated_at` is more recent
wins. With no profile row, the LSAT `StudyPlan` is returned verbatim; with no
plan, the profile row is. This makes a host edit made while the LSAT side is
stale win on the next sync, and vice-versa, without a merge conflict.

## Degrading host bridge

`src/lib/studyProfileBridge.ts` mirrors the existing degrading-fetch pattern
(`lsatReviewBridge.ts`, `lsatBackend.ts`): never throws.

- `fetchStudyProfile()` — reads the backend profile; on any failure (down,
  timeout, shape drift) returns the host's local Dexie profile with `ok:false`.
- `saveStudyProfile(patch)` — **local-first dual write**: persists to Dexie
  (`StudyPlanSettings`) *before* the remote `PUT`, so a failed backend write
  still keeps the edit locally (`ok:false`); the next successful sync reconciles
  it via last-write-wins.

Field mapping host↔profile lives in `progressStore.ts`
(`studyPlanSettingsToProfile` / `studyProfileToPlanSettingsPatch`). The LSAT side
projects its existing `Goal` + plan budget via `prefs.ts`
(`getStudyProfileScalars` / `setStudyProfileScalars`) — no new storage keys.

## Backward compatibility

Strictly additive. `GET/PUT /api/study/plan`, `GET /api/study/today`, the
`StudyPlan` model, and the host `StudyPlanSettings` store all keep their exact
shapes and behavior. The new `SharedStudyProfile` row, `studyplan.updated_at`
column, and `/api/study/profile` routes are all new.

## Consumers (next batch)

- **LEARN-3** (unified daily plan): reads the reconciled `daily_minutes` /
  `exam_date` / `target_*` to size and target the day across domains.
- **ANL-4** (readiness): reads `target_score` / `exam_date` to compute
  mastery-ETA and the readiness checklist.
