# StudyVault Cross-Domain Data Dictionary

> **Roadmap items DATA-2 + DATA-3** (Wave 5, Track A / Keystone K1).
> Status: **implemented.** This document is the *single source of truth* for the
> field semantics shared across the two data planes, so the coercions between
> them are explicit instead of silent. It is paired with the executable
> dictionary [`src/lib/dataDictionary.ts`](../src/lib/dataDictionary.ts), the
> backend serializers [`services/lsat-backend/app/serializers.py`](../services/lsat-backend/app/serializers.py),
> and the schema-version handshake (`GET /api/observability/schema-versions`).

---

## 0. Why this exists

StudyVault unifies the *surface* of spaced repetition + attempts across domains
without merging the storage engines:

| Plane | Backend | Review card | Attempt | Identity |
|-------|---------|-------------|---------|----------|
| **Host** (CFA / Quant / Excel) | Dexie (IndexedDB) via the `StorageDriver` | `ReviewItem` (string `id`) | `QuestionResult` (auto-increment `id`, append-only) | string `id` / `questionId` |
| **LSAT** | FastAPI sidecar + SQLite | `SRSCard` (int `id`, FK `question_id`) | `Attempt` (int `id`, FK `question_id`) | integer row ids |

The two planes use **different vocabularies for the same concept** (difficulty,
mastery, identity, correctness). Before DATA-2, a host→LSAT or LSAT→host read
coerced those silently — a host `ReviewItem.fsrsDifficulty` (1–10 FSRS scale) is
*not* the LSAT `difficulty` (1–5), and the host `Difficulty` enum
(`foundation`/`intermediate`/`advanced`) maps to neither without a rule. This
dictionary pins every shared field so the bridge can translate **explicitly,
losslessly where possible, and with a documented rounding rule where not.**

The bridge is **additive and read-first**: it maps between the two shapes on
read (and exposes a canonical common shape) without changing either native
storage layout. Cross-domain *writes* are gated by the DATA-3 schema-version
handshake (§4).

---

## 1. Cross-domain identity (`CrossDomainId`)

Every reviewable / attemptable artifact is addressed by a **namespaced string
id** so the host and the LSAT plane never collide and an id is self-describing:

```
<domain>:<kind>:<nativeId>
e.g.  cfa:review:loiabc-123
      lsat:card:4821
      lsat:attempt:99012
```

- `domain` — `cfa` | `quant` | `excel` | `lsat`. The host domains come from
  `DomainId` in `learningTypes.ts`; `lsat` is the sidecar plane.
- `kind` — `review` (a due card), `attempt` (a logged answer), `question`
  (the underlying item).
- `nativeId` — the plane-native primary key, **stringified** (host ids are
  already strings; LSAT ids are integers rendered as decimal).

LSAT integer ids are stringified, never reinterpreted as numbers on the host
side, so a future id-scheme change on the sidecar can't silently alias a host
id. `parseCrossDomainId` round-trips the parts; an unparseable id yields `null`
rather than throwing.

---

## 2. Difficulty

The two planes encode difficulty on **different scales**. This is the single
highest-risk silent coercion, so the rule is fixed here and implemented once in
`dataDictionary.ts` (`lsatDifficultyToHost` / `hostDifficultyToLsat`).

| Host `Difficulty` (`learningTypes.ts`) | LSAT `difficulty` (int, `models.py` `Question.difficulty`) |
|----------------------------------------|------------------------------------------------------------|
| `foundation`                           | `1` – `2`                                                  |
| `intermediate`                         | `3`                                                        |
| `advanced`                             | `4` – `5`                                                  |

**LSAT → host** (collapsing 5 buckets into 3):

| LSAT `difficulty` | Host `Difficulty` |
|-------------------|-------------------|
| `1`, `2`          | `foundation`      |
| `3`               | `intermediate`    |
| `4`, `5`          | `advanced`        |

Out-of-range / non-integer LSAT values clamp into `[1, 5]` first; anything that
can't be read at all defaults to `intermediate` (the neutral middle).

**Host → LSAT** (the inverse is *lossy* — 3 buckets cannot recover the original
5-point value — so we pick the bucket *midpoint* to minimize round-trip drift):

| Host `Difficulty` | LSAT `difficulty` |
|-------------------|-------------------|
| `foundation`      | `2`               |
| `intermediate`    | `3`               |
| `advanced`        | `4`               |

> Round-trip note: `lsat 1 → foundation → lsat 2` and `lsat 5 → advanced → lsat 4`
> drift by one step at the extremes. This is intentional and documented — the
> 3-bucket host enum genuinely cannot represent 1 vs 2 or 4 vs 5. Callers that
> need the original LSAT value must read it from the LSAT plane, not reconstruct
> it from a host coercion.

The LSAT `empirical_difficulty` (observed-accuracy re-estimate, a float) is a
**separate, finer signal** and is carried through verbatim on the canonical shape
as `empiricalDifficulty` — never folded into the bucketed `difficulty`.

---

## 3. Mastery

"Mastery" is reported on **two different 0..1-vs-0..100 scales** depending on the
source:

| Source | Field | Range | Meaning |
|--------|-------|-------|---------|
| Host | `MasterySnapshot.score` | `0`–`100` (percent) | per-objective mastery percent |
| LSAT | `mastery()` / `AbilitySnapshot.mastery` | `0.0`–`1.0` (fraction) | per-q_type mastery fraction |

The canonical cross-domain shape carries mastery as a **0..1 fraction**
(`masteryFraction`). `dataDictionary.ts` exposes `toMasteryFraction(value, scale)`
and `fromMasteryFraction(fraction, scale)` so a host percent and an LSAT fraction
are converted through one rounding rule (`round(x * 100) / 100`, clamped to
`[0, 1]`). Never compare a raw host `score` against a raw LSAT `mastery` — always
normalize both to the fraction first.

---

## 4. Correctness, confidence, and attempts

| Concept | Host (`QuestionResult`) | LSAT (`Attempt`) | Canonical |
|---------|-------------------------|------------------|-----------|
| Was it right? | `correct: boolean` | `is_correct: bool` | `correct: boolean` |
| Chosen answer | (selected index on `QuestionAttempt.selected`) | `chosen_answer: "A".."E"` | `chosenAnswer?: string` (verbatim; not normalized across index vs letter) |
| Confidence | `confidence: 'low'\|'medium'\|'high'` | `confidence: Confidence` (same 3 levels) | `confidence?: 'low'\|'medium'\|'high'` |
| Time spent | `elapsedSeconds?: number` | `time_ms: int` | `elapsedSeconds?: number` (LSAT `time_ms / 1000`, rounded) |
| When | `createdAt?: string` (ISO) | `created_at: datetime` | `createdAt?: string` (ISO 8601) |

`chosenAnswer` is intentionally **not** coerced between the host's numeric
selected-index and the LSAT letter answer — they are different addressing schemes
and a blind coercion would corrupt review replay. The canonical shape carries
whichever the source provides, labeled by `domain`.

---

## 5. Schema-version handshake (DATA-3)

Both planes expose a **`DataSchemaVersion`** so the host can detect an
incompatible sidecar *before* attempting any cross-domain write (the highest-
severity multi-backend failure is an old SQLite + new Dexie silently losing
data on a write).

- **Backend** records its cross-domain schema version in SQLite via a
  PRAGMA-guarded migration (migration **22**, `cross_domain_schema_version`,
  `PRAGMA user_version = 22`) and exposes it at
  **`GET /api/observability/schema-versions`**:

  ```json
  {
    "cross_domain_schema_version": 1,
    "db_user_version": 22,
    "latest_migration_version": 22,
    "host_min_supported": 1,
    "generated_at": "2026-06-15T..."
  }
  ```

- **Host** pins `CROSS_DOMAIN_SCHEMA_VERSION` in `dataDictionary.ts` and, on
  boot, calls `fetchDataSchemaAlignment()` to compare. The result is one of:

  | Status | Meaning | Cross-domain writes |
  |--------|---------|---------------------|
  | `aligned` | versions match (or backend ≥ host and host ≥ backend min) | **enabled** |
  | `mismatch` | versions differ within tolerance | **disabled** (read-only bridge) |
  | `unreachable` | sidecar down / unparseable | **disabled** (read-only bridge) |

  Local (host-only Dexie) reads and writes are **never** gated — only
  *cross-domain* writes (host→LSAT / LSAT→host) are disabled on mismatch. This
  is surfaced on **System Health → "Data planes aligned"** as a green / amber
  check with the two version numbers and an explanation.

`CROSS_DOMAIN_SCHEMA_VERSION` is the version of *this contract* (the field
semantics in §1–§4), bumped only when a shared field's meaning changes — it is
deliberately distinct from `VAULT_SCHEMA_VERSION` (the host Dexie table layout)
and from the LSAT `PRAGMA user_version` (the SQLite migration ledger).

---

## 6. Change procedure

When a shared field's **meaning** changes (e.g. the difficulty mapping, the
mastery scale, or a new shared field):

1. Update the relevant section above **and** the matching coercion in
   `dataDictionary.ts` (host) + `serializers.py` (backend) in the same change.
2. Bump `CROSS_DOMAIN_SCHEMA_VERSION` in `dataDictionary.ts` **and** the
   `CROSS_DOMAIN_SCHEMA_VERSION` recorded by the backend migration ledger
   (add a new migration; never rewrite an applied one).
3. The handshake (§5) then forces older/newer peers into read-only cross-domain
   mode until both sides are upgraded, so a half-upgraded install degrades
   safely instead of writing through a stale coercion.
