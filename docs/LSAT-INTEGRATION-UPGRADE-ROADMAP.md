# StudyVault Wave 5+ — Deepening the LSAT ↔ Host Integration

> Status: **PLAN ONLY — nothing implemented.** Authored 2026-06-15, after the LSAT→StudyVault
> merge ([LSAT-INTEGRATION.md](LSAT-INTEGRATION.md)), the seamlessness/polish pass
> ([STUDYVAULT-POLISH-PLAN.md](STUDYVAULT-POLISH-PLAN.md)), and the fully-shipped Waves 1–4
> ([STUDYVAULT-UPGRADE-ROADMAP.md](STUDYVAULT-UPGRADE-ROADMAP.md)).
>
> Method: an 8-dimension **read-only GitNexus audit swarm** (D1–D8) over the live tree +
> the standalone `LSATLab` index + `docs/lsat/` history → ~96 candidates → dedup/prioritize
> synthesis → an adversarial completeness critic. Personal-use, local-first, fully-offline
> app — no multi-tenant / scale / distribution concerns. Every item cites concrete files and
> was checked against what already shipped.

---

## 0. Thesis

Waves 1–4 unified the **shell** (theme, tokens, soft-nav, command palette) and hardened
**resilience** (sidecar supervisor, fallback, atomic writes, observability). But the LSAT↔host
seam is still **one-way and surface-only**: the host reads `/api/srs/due` and `/api/health` —
and that is essentially all. Meanwhile the LSAT backend already runs a mature engine the host
never consumes: **IRT/Elo ability estimation, utility-weighted daily planning, 20+ analytics
endpoints, an 8-gate generation pipeline, a ~1130-line trust manifest, scheduler evidence, and
runtime metrics**.

The next mile converts three seams from *surface patch* to *shared system*:

1. **DATA** — a typed, version-checked, (eventually) bidirectional cross-domain data layer so
   one query answers "what's due / how am I doing" across CFA + Quant + LSAT.
2. **ENGINE** — wire the LSAT learning + intelligence engines (ability, daily plan, analytics,
   generation gates, RAG) to host content, so CFA/Quant questions get the same adaptivity and
   quality bar.
3. **TRUST** — a unified trust/observability cockpit that surfaces the already-built backend
   signals as one "is StudyVault healthy and ready?" view.

Everything is **additive** — the backend infrastructure exists; the gap is the consumption +
contract + UX layer at the boundary.

---

## 1. Keystones (the three load-bearing bets)

| # | Keystone | Why it's the spine |
|---|----------|--------------------|
| **K1** | **Typed cross-domain data contract + bridge** | The host↔backend boundary is hand-written, loosely-typed `fetch` (`lsatReviewBridge.ts` reads only `/api/srs/due`; `lsatBackend.ts` reads `/api/health`). No shared identity between host `ReviewItem`/`QuestionResult` (Dexie) and LSAT `SRSCard`/`Attempt` (SQLite), no generated client, no schema-version handshake. K1 is the prerequisite for **every** cross-domain query. |
| **K2** | **Shared learning + intelligence engine** | The biggest asymmetry in the repo: the host has **no** ability model, daily plan, adaptive selection, blind-review analytics, or generation gates — the LSAT backend has all of them, fully built. K2 makes those engines domain-parameterized so host attempts flow through the same ability estimation, planning, weakness ranking, and content validation. Turns the host from a static vault into an adaptive coach. |
| **K3** | **Unified trust + observability cockpit** | ~820 lines of `observability.py` + ~1130 of `trust.py` + scheduler evidence + runtime metrics + `sqlite_health` are live behind `:8100/api` but invisible in the host; BA8 captured sidecar logs but no UI consumes them; open-notebook `:5055` has no health surface. K3 wires the existing endpoints into one cockpit + an aggregated "ready?" signal + diagnostics export — the operator's release gate and the debuggability layer every other wave needs. |

---

## 2. Tracks

I·E·R = Impact (H/M/L) · Effort (S/M/L) · Risk (L/M/H). "Deps" lists prerequisite item ids.

### Track A — Data & Sync  *(K1)*

| # | Item | What / why | I·E·R | Deps |
|---|------|-----------|-------|------|
| **DATA-1** | **Versioned OpenAPI contract + generated typed client + drift CI gate** | Export `/openapi.json` from the sidecar, diff vs a committed baseline (additive OK, breaking fails CI); **reuse the existing `src/domains/lsat/lib/api.gen.ts` (~17.5k lines)** rather than generating a new client (critic), and refactor `lsatBackend.ts`/`lsatReviewBridge.ts` onto it. Catches a `/api/srs/due` rename at build time. | H·M·L | none |
| **DATA-2** | **Cross-domain identity + storage-bridge namespace** | A `crossDomainBridge` on `StorageDriver` mapping host `ReviewItem`⇄LSAT `SRSCard` and `QuestionResult`⇄`Attempt`; a `dataDictionary.ts` + `docs/DATA-DICTIONARY.md` pinning shared field semantics (difficulty 1–5 vs foundation/intermediate/advanced; mastery) with a CI check. Stops silent coercions. | H·M·M | DATA-1 |
| **DATA-3** | **Schema-version handshake on boot** | Both planes expose a `DataSchemaVersion`; host compares on boot via `/api/observability/schema-versions`, warns + disables *cross-domain* writes (not local) if incompatible. Cheapest guard against the highest-severity multi-backend failure (old SQLite + new Dexie silently losing data). | H·L·L | DATA-1 |
| **DATA-4** | **Two-way progress sync + conflict ledger** — *split per critic* | **4a (read-only feed, low risk):** `POST /api/sync/progress-updates` upserts host session/attempt snapshots into a `HostProgressSnapshot` so the LSAT engine can *see* host progress. **4b (deferred write-back):** full bidirectional FSRS-state sync + `CrossDomainSyncLog` (idempotent, last-write-wins) — higher risk, do after 4a proves out. | H·M·H | DATA-2, DATA-3 |
| **DATA-5** | **Unified bidirectional export/backup** | One `{host, lsat}` artifact with a shared `exportId`/`exportedAt`; import routes to the correct backend; migration path for legacy per-domain exports. Backing up StudyVault becomes one atomic action. | H·M·M | DATA-2 |
| **DATA-6** | **Shared study-profile arbiter** *(critic gap)* | One profile reconciling LSAT `StudyPlan` vs host goals/exam dates so the daily plan (LEARN-3) and readiness (ANL-4) can budget time across domains from a single source of truth. | M·M·L | DATA-2 |
| **DATA-7** | **Cross-store migration + app-data relocation guard** *(critic gap)* | A bundle-id/app-data-dir change orphans the LSAT SQLite store in `%APPDATA%/LSATLab`. Add a detect-and-migrate path + a startup check; DATA-3 only *versions* the contract, it doesn't *move* stores. | M·M·M | DATA-3 |

### Track B — Learning Engine (SRS · ability · adaptivity)  *(K2)*

| # | Item | What / why | I·E·R | Deps |
|---|------|-----------|-------|------|
| **LEARN-1** | **Unified ability model spanning CFA+LSAT** | Extend `adaptivity.ability_estimate` to accept `domain` and operate over LSAT `Attempt`s ∪ synced host attempts; return per-domain θ/mastery/uncertainty/slope; add host `learningTypes.ts` types. The host has zero ability model; LSAT's is the repo gold standard. | H·M·M | DATA-4a |
| **LEARN-2** | **Unified due-today queue (ability-ranked)** | `/api/study/due-unified` returning cross-domain due cards ranked by overdue + interleaved by type + ability-weighted utility; replace the Review Inbox's two-query pattern with one call + combined count. The single "what do I review now?" entry point. | H·M·M | DATA-2 |
| **LEARN-3** | **Unified daily plan spanning domains** | Extend `/study/today` with `include_host`: merge host weakest-by-ability topics with the LSAT task breakdown and rerank by cross-domain utility with time budgets summing to the daily goal; render on host Dashboard + LSAT Today. Removes decision fatigue. | H·M·M | LEARN-1, LEARN-5, DATA-6 |
| **LEARN-4** | **Host-side FSRS parameter parity** | Host loads optimized FSRS weights + desired-retention from `/api/srs/params` (backend = source of truth) instead of local-only fits. Unifies the scheduler truth across domains. | M·M·L | DATA-1 |
| **LEARN-5** | **Leech + concept-gap unification** | Add origin/lapses/leech-flag to the host SRS model mirroring `srs.flag_leech_if_needed`; extend `/api/srs/leeches` + `/concept-gap-queue` with `include_host` into one "Leeches & Gaps" view. A CFA item missed 8× deserves LSAT-grade attention. | M·M·L | DATA-2 |
| **LEARN-6** | **Adaptive next-question routing on host content** | Call `/adaptivity/next` with unified ability + recent attempts; backend returns ranked candidates (reason, zpd_fit, expected_success, utility) to populate host drills/recommendations. Moves the host from random to max-information selection. | H·M·M | LEARN-1, DATA-4a |

### Track C — Intelligence (generation · RAG · artifacts)  *(K2)*

| # | Item | What / why | I·E·R | Deps |
|---|------|-----------|-------|------|
| **INT-1** | **Generation-quality service** | `/api/generation-quality` wrapping `validate_candidate` (trap-metadata, distractor-quality, structural-type, self-consistency, permutation-invariance, embedding-dedup) → typed `ValidationReport`; host `mockGenerator` calls it so CFA content is gated against the same rubric, fail-closed on weak distractors. One quality bar across domains. | H·M·M | DATA-1 |
| **INT-2** | **Unified generation config + model routing (read-write)** | An Edit-Model-Routing modal on System Health that writes host + LSAT atomically (the shipped `PUT /api/settings` via `syncProviderToLsat`), re-probes both providers, warns on missing models; stamp `prompt_version`/`schema_version` for replay/A-B. Closes the S5 read-only gap. | M·M·M | DATA-1 |
| **INT-3** | **Shared RAG/notebook driver** | A SurrealDB/open-notebook driver behind the `ChunkSearch` interface so host curriculum chunks and LSAT/open-notebook sources are searched over their union; surface LSAT passages in host search. Today the corpora are disjoint. **Gate on open-notebook optionality first (critic / OPS-5).** | H·M·M | DATA-1, OPS-5 |
| **INT-4** | **Shared study-artifact store** | `/api/study-artifacts` CRUD (SurrealDB-backed) so host explanations + LSAT Socratic notes both persist and are retrievable by question/topic/type — precondition for a RAG tutor that reuses prior explanations. | M·M·M | INT-3 |
| **INT-5** | **Generation-quality observability** | `/api/generation/quality-metrics` (per-type pass rates + fail-reason distribution from `GenJob.validation_report`) + an `/audit-log` of every generate/validate/firewall event; surface in the trust cockpit. Builds on BB5 + BC4. | M·S·L | INT-1 |

### Track D — Analytics & Insight

| # | Item | What / why | I·E·R | Deps |
|---|------|-----------|-------|------|
| **ANL-1** | **Cross-domain analytics route + typed/paged hardening** | `/api/analytics/cross-domain` (study time, accuracy-by-domain, merged weakest types, combined streak, 30-day trend) after applying BC2 response-models + BC3 N+1/pagination guards to dashboard/by-type/activity. Makes analytics bidirectional (host pulls LSAT). | H·M·M | DATA-1 |
| **ANL-2** | **Unified weakness index + Dashboard card** | `/api/analytics/weakness-index` merging LSAT `mastery()` + host per-topic 30-day accuracy into one ranked list with recent-miss ids + recommended drills; top 3 on Dashboard with deep-links. "Tell me where to spend time." | H·M·M | ANL-1, LEARN-1 |
| **ANL-3** | **Blind-review analytics on host (careless vs concept)** | Capture optional timed/BR answer + confidence on host `ReviewItem`; port `blind_review_gap/outcome` to `/api/analytics/blind-review-gap?domain=` emitting the 2×2 (concept/timing/lucky/timed_ok) + careless-rate. LSAT's highest-value signal, absent on host. | H·M·M | ANL-1 |
| **ANL-4** | **Learning curves + mastery-ETA + readiness checklist (host)** | Backport `learning_velocity` + `mastery_eta_days` + `_exam_readiness_simulation` into a host Dashboard sparkline grid (slope/plateau flags) + a green/amber/red readiness checklist. Prevents false confidence/burnout. | M·M·L | LEARN-1, LEARN-3 |
| **ANL-5** | **Shared viz barrel + unified filter context** | Promote LSAT viz primitives (TrendChart, HeatStrip, StatNumber, ReadinessGauge) to `src/domains/shared/components/viz`; refactor host `Analytics.jsx` off bare recharts onto them (lock `@visx@4`); persist range/source/compare filters. Validates the P6 chart-vendor dedup is truly shared. | M·M·M | none |
| **ANL-6** | **Unified activity heatmap + calibration (domain toggle)** | Extend the host streak heatmap + confidence-calibration scatter to pull LSAT `/api/analytics/activity` + `/calibration` with a CFA / LSAT / All toggle. Two quick high-visibility wins on existing scaffolding. | M·S·L | ANL-1 |
| **ANL-7** | **Exportable cross-domain progress report (PDF/CSV)** | One report bundling cross-domain accuracy, weakness index, readiness, streaks; reuses the LSAT PrintReport pattern. | M·M·L | ANL-1, ANL-2 |

### Track E — LSAT-domain depth (internal refinements)

| # | Item | What / why | I·E·R | Deps |
|---|------|-----------|-------|------|
| **LSAT-1** | **Passage-aware RC explanations** *(quick win)* | Pass char-budgeted passage text into `ai._explain_prompt` when `q.passage_id` is set (today RC explains over the stem only). Smallest-effort, highest-quality RC win. | H·S·L | none |
| **LSAT-2** | **Trap-keyed RAG + similar-miss injection into explanations** | Wire `embeddings.trap_similar_misses_for_question` into the explanation body with a "See trap patterns" accordion ("you fell for this reversal on Q31, Q18"). Trap-learning is the highest-ROI LSAT fact. | H·M·L | INT-3 |
| **LSAT-3** | **Blind-review rationale capture + auto-cloze gap cards** | Capture `AttemptRationale.br_note` on reveal; `/srs/concept-gap-cards` auto-generates cloze/pattern cards surfaced as a distinct "Gap" SRS card type. Closes the gap→why→practice→SRS loop. | H·M·L | none |
| **LSAT-4** | **Socratic multi-turn dialogue** | Wire the existing `QuestionConversation` table into a nudge→eliminate→confirm→explain flow that elicits a prediction before reveal and cites retrieved misses, using the shipped BB2 streaming. The feature that makes LSAT a tutor, not a quiz engine. | H·M·M | LSAT-2, INT-4 |
| **LSAT-5** | **RC passage-first generation + semantic validators** | Passage-first generation (one coherent passage → 3–4 varied questions) + RC validators (MainPoint coherence, Detail-basis, Inference-support) via `/api/generation/passages`. Makes RC a real discipline. | H·M·M | INT-1, LSAT-1 |
| **LSAT-6** | **Notebook as knowledge base + backlinks + inline authoring** | Wire the `Annotation` model into a full Notebook (FTS5 search, tags, backlinks, auto-built rules/tells wiki) + inline edit on Bank/Review + user-authored explanations. The compounding personal asset. | M·M·L | INT-4 |
| **LSAT-7** | **Content-trust cockpit + drill/playlist depth** | Complete `ContentOps.tsx` (near-dup clusters via union-find over embeddings ≥0.93, lexical-leak heatmap, coverage matrix, audit-log viewer + one-click merge) + per-type pacing budgets, quarantine UX, smart weak-type drills. The LSAT-internal half of K3. | M·M·L | INT-1 |

### Track F — Cross-domain UX & Shell

| # | Item | What / why | I·E·R | Deps |
|---|------|-----------|-------|------|
| **UX-1** | **Cross-domain scroll restoration + skeleton heights** | Port LSAT's `saveScroll/restoreScroll` to the host + deterministic min-height skeletons on Today/Dashboard/Review so soft-domain hops restore scroll and avoid CLS. | H·M·L | none |
| **UX-2** | **Unified global search across host + LSAT content** *(re-scope per critic)* | Merge host + LSAT command registries into one ⌘K that deep-links LSAT results via soft-nav, weighting the active domain. *Critic note:* UB6 already shipped domain-scoped ⌘K + jump rows — re-scope this to **content** search (passages/questions via INT-3), not route search, to avoid duplicating shipped work. | M·M·M | INT-3 |
| **UX-3** | **Unified onboarding/resume across domains** | One onboarding/resume key so a host-dismissed user doesn't re-see the LSAT wizard; extend UB7's resume to surface the most-recent session regardless of domain (consumes DATA-4a). | M·M·L | DATA-4a |
| **UX-4** | **History-aware back + unified breadcrumb + domain badge** | Replace the LSAT shell's hardcoded `navigateDomain('/')` back with referrer-aware history; shared cross-domain breadcrumb + persistent domain indicator so "where am I" is always visible. | M·M·M | none |
| **UX-5** | **Soft-nav transition states + soft Review-Inbox deep-links + drawer parity** | Fire the LSAT GlobalLoadingBar + 120ms fade on domain-nav; switch Review Inbox LSAT deep-links from `window.location` to soft `navigateDomain`; auto-close both drawers on domain change. Completes the Review Inbox as a true unified surface. | M·S·L | UX-1 |
| **UX-6** | **Cross-domain notification surface** *(critic gap)* | A proactive cross-domain due-nudge + a notification center behind the (currently empty) host TopBar bell — "12 reviews due across CFA + LSAT". | M·M·L | LEARN-2 |

### Track G — Ops, Trust & Observability  *(K3)*

| # | Item | What / why | I·E·R | Deps |
|---|------|-----------|-------|------|
| **OPS-1** | **Unified System Health console: all 4 sidecars + logs** | Wire the shipped `get_sidecar_status`/`get_sidecar_logs` (BA1/BA2/BA8) into a Sidecars panel showing SurrealDB :8000, open-notebook :5055 (currently unsurfaced), LSAT :8100, worker — name/port/healthy/ready/depends_on/pid/latency + a per-sidecar log tail. | H·M·L | none |
| **OPS-2** | **Unified trust + release-readiness cockpit** | A Trust & Release panel fetching `/api/observability/trust` (`build_release_trust_manifest`) + host checks (offline readiness, Dexie/SurrealDB health), rolling up to ok/warning/blocked with an expandable check tree + `next_actions`. `trust.py` is ~1130 lines and currently dormant. | H·M·M | OPS-1 |
| **OPS-3** | **Aggregated readiness API + runtime-metric trends + DB health** | A Tauri `get_system_health_aggregated` → one ok/degraded/error header badge; a Runtime Metrics tab (cloud-spend trend, LLM p50 from `MetricSample`, queue depth, web vitals) + `sqlite_health` (PRAGMA/WAL/BUSY-retry). Turns BA8/BC4 point-in-time data into trends. | M·M·L | OPS-1 |
| **OPS-4** | **Maintenance panel + active guardrails + diagnostics export** | Wire `/api/observability/scheduled-tasks` + runs into a Maintenance panel (run-now/toggle/cadence); client guardrails (cloud-budget ≥80%, IndexedDB ≥85% quota, model-outage banners); one-click Diagnostics Export bundling trust + diagnostics + sidecar logs + vitals into a timestamped JSON. | M·M·M | OPS-2, OPS-3 |
| **OPS-5** | **Sidecar packaging + offline contract (open-notebook optionality)** *(critic gap)* | `release.yml` ships RAG-less builds when `ONB_GIT_URL` is unset; INT-3/4 and LSAT-2/4/6 assume open-notebook is present. Define required-vs-optional sidecars explicitly, degrade gracefully, and surface "RAG unavailable" in the cockpit. **Resolve before INT-3.** | H·M·M | OPS-1 |

### Track H — Quality & CI (integration boundary)

| # | Item | What / why | I·E·R | Deps |
|---|------|-----------|-------|------|
| **QA-1** | **/lsat routes in the a11y + visual + smoke gates** | Merge the LSAT route manifest into `screenshotRoutes`/`smokeRoutes` and crawl it in `a11y-check.mjs` + `visual-regression.mjs` + `smoke.mjs` (both themes); bootstrap LSAT baselines. CI covers only host routes today. | H·M·L | none |
| **QA-2** | **Cross-domain e2e + sidecar integration harness** | A Playwright `e2e-integration.mjs` booting the LSAT sidecar (test db): Review Inbox → due populates → deep-link /lsat/srs → complete a card → back → assert count decremented; plus a suite that kills the sidecar mid-request and asserts graceful `{ok:false}`. Today the bridge is tested only with mocked fetch. | H·M·M | QA-1 |
| **QA-3** | **PR-gate sidecar smoke + schema-snapshot baseline** *(re-scope per critic)* | *Binary smoke already runs in `release.yml`* — re-scope to a **PR-gate** run of `smoke-sidecar.mjs` + a `schemas-baseline.json` snapshot diff in `test_openapi_contract.py` (catch silent field removals). | M·S·M | DATA-1 |
| **QA-4** | **Replace the `@lsat/*` any-shim with typed project references** | Swap `src/lsat-domain.d.ts`'s blanket `declare module '@lsat/*'` (resolves everything to `any`) for a tsconfig project reference + a granular `d.ts` of the real public surface; document a host↔LSAT API coverage matrix in `docs/TESTING.md`. Hardens the boundary's type-safety. | M·M·M | DATA-1 |

---

## 3. Sequencing — Waves 5–8

Tracks run in parallel; respect the dependency arrows. Keystones + quick wins land first so
everything downstream builds on a typed contract and a visible cockpit.

- **Wave 5 — Spine + quick wins.** Lay the typed contract/bridge + observability foundation and
  bank the cheap high-impact wins: **DATA-1, DATA-2, DATA-3, OPS-1, OPS-5, QA-1, QA-3, UX-1,
  LSAT-1, ANL-6, LSAT-3.** *(Critic: protect DATA-2 from being crowded out — it gates Wave 6.)*
- **Wave 6 — Shared engines.** Wire ability/plan/generation/RAG to host content: **DATA-4a,
  LEARN-1, LEARN-2, LEARN-5, LEARN-4, INT-1, INT-3, INT-2, ANL-1, OPS-2, QA-2.**
- **Wave 7 — Insight payoff + trust cockpit.** Turn engines into user-facing intelligence:
  **LEARN-3, LEARN-6, ANL-2, ANL-3, ANL-4, ANL-5, INT-4, INT-5, OPS-3, OPS-4, UX-2, UX-3,
  UX-6, DATA-6.**
- **Wave 8 — Depth, polish + capstones.** Complete LSAT depth + cross-domain UX + unified
  export/report: **LSAT-2, LSAT-4, LSAT-5, LSAT-6, LSAT-7, UX-4, UX-5, DATA-4b, DATA-5,
  DATA-7, ANL-7, QA-4.**

**Quick wins (do early):** LSAT-1, ANL-6, UX-1, OPS-1, QA-3, DATA-3, INT-5, UX-5.

---

## 4. Critic adjustments (folded in above)

The completeness critic independently re-checked the synthesis. Applied:

- **Cut / re-scope (already shipped or duplicative):**
  - **DATA-1** → *reuse the existing `src/domains/lsat/lib/api.gen.ts` (~17.5k lines)* rather
    than generating a fresh client.
  - **QA-3** → binary smoke already runs in `release.yml`; re-scoped to a PR-gate run + a schema
    snapshot baseline.
  - **UX-2** → UB6 already shipped domain-scoped ⌘K + jump rows; re-scoped to *content* search.
- **Added (missed seams):** DATA-6 (shared study-profile arbiter), DATA-7 (cross-store
  migration / app-data relocation), UX-6 (cross-domain notification surface), OPS-5 (sidecar
  packaging + open-notebook optionality).
- **Sequencing risks honored:** OPS-5 resolved **before** INT-3/4 + LSAT-2/4/6 (they assume
  open-notebook present); **DATA-4 split** into 4a (read-only feed, Wave 6) and 4b (deferred
  write-back, Wave 8) because the full bidirectional sync is HIGH-risk yet a linchpin; DATA-2
  must finish Wave 5.

---

## 5. Deferred / lower tier (real but marginal for one user)

- **Argument-map extraction + structure view** — offline `qwen3` extraction + a visx graph;
  great pedagogy but heavy vs. LSAT-1/LSAT-2 which deliver most of the explanation-quality gain.
- **Always-on-top timer + tray SRS badge + multi-window coach** — high-risk Tauri tray/global-
  shortcut work; LSAT-internal delight, no cross-domain leverage. Dedicated native-shell pass.
- **OpenMetrics/Prometheus export** — the Diagnostics Export (OPS-4) already produces a sharable
  JSON for one operator.
- **Per-request-id log search + live-tail** — the basic logs viewer (OPS-1) + export (OPS-4)
  cover the single-user debugging loop.
- **Full bidirectional per-card FSRS-state sync via a Tauri background task** — DATA-4a +
  LEARN-4 give the engine what it needs; full sync (clock skew, idempotency, offline merge) is
  HIGH-risk for marginal benefit. (This is DATA-4b — kept in Wave 8 but defer further if needed.)
- **Watch-mode/devx scripts** — pure developer ergonomics; fold into QA opportunistically.

---

## 6. Method note

8 read-only GitNexus audit agents (D1 data/storage · D2 SRS/adaptivity · D3 generation/RAG ·
D4 analytics · D5 LSAT depth · D6 UX/shell · D7 ops/trust · D8 testing/CI) over the integrated
`CFAPrep` tree, cross-referenced against the standalone `LSATLab` index and `docs/lsat/`
history → ~96 candidates → one synthesis pass (dedup by integration seam, prioritize, sequence)
→ an adversarial completeness critic. Load-bearing claims were verified against the source:
`lsatReviewBridge.ts` reads only `/api/srs/due` (one-way, loosely typed); `lsatBackend.ts`'s
`syncProviderToLsat` already does `PUT /api/settings` (so INT-2 is an edit-UI on a shipped
write, not new backend work); `storage/types.ts` has no cross-domain namespace; and
`study_routes.py` + `analytics_routes.py` already expose `/study/today`, `/study/plan`, and 20+
analytics endpoints that the host simply never consumes. Nothing here is implemented.
