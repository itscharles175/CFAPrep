# StudyVault — Upgrade Roadmap ("Perfecting the Program")

> Status: **PLAN ONLY — no implementation.** Authored 2026-06-14, after the
> LSAT→StudyVault merge + the seamlessness/polish pass (PR #1).
> Method: a 6-dimension grounded audit swarm (read-only) over the live tree →
> 75 candidate upgrades → deduped + prioritized synthesis. Focus per request:
> **backend upgrades** + **UI polish & refinement**. Personal-use, local-first,
> offline app — no multi-tenant/scale/distribution concerns.
>
> Builds on the shipped work: S1 (fonts), S6 (single-root soft nav), S5 (model
> settings), P5 (ErrorBoundary), P6 (chart chunking), S2 (LSAT in CI). Several
> items below are the deliberate *next mile* of those.

---

## 0. TL;DR — the two keystones + the quick wins

**Backend keystone — Sidecar resilience.** Today a sidecar crash (SurrealDB,
open-notebook, LSAT backend) silently breaks RAG/storage; the supervisor spawns
once and never re-checks (`is_port_listening` exists but is `#[allow(dead_code)]`).
Adding health-polling + auto-restart + an offline-mode banner + a Dexie
read-through fallback is the single highest reliability ROI for an offline app.

**UI keystone — host hex → HSL palette.** S1 unified the *fonts*; the two color
systems are still hex (host) vs HSL (LSAT). Migrating the host palette to HSL
under the same semantic token names is the lever that unblocks unified elevation,
focus rings, motion, button parity, and one theme provider — i.e. the deep "one
product" finish S1 started.

**Quick wins (high impact / low effort — do first):**
1. **Model warm/unload manager** (BE) — wire the *already-implemented*
   `set_keep_alive(-1/0)` to a System Health panel; kills the ~5-min GPU OOM
   thrash when swapping the 9 GB explain/gen models. *be-ai*
2. **Global `:focus-visible` + skip-to-main link** (UI/a11y) — CSS + one DOM
   node; biggest keyboard-a11y gain per line. *a11y*
3. **Host scroll-restoration + deterministic skeleton heights** (UI) — port the
   LSAT `saveScroll/restoreScroll`; kills back-button scroll loss + CLS jank.
4. **Request dedup in `localLlm`** (BE) — a `Map<key,Promise>` so double-clicking
   "Explain" doesn't double-hit the sidecar. Pure frontend, ~S.
5. **Missing-model recovery UX** (BE) — `health()` already returns
   `missing_models`; return the `ollama pull …` command + a "use fallback" link.

---

## 1. BACKEND track

### B-A — Resilience & reliability (do first; highest "perfecting" value)

| # | Upgrade | What / why | I·E·R |
|---|---------|-----------|-------|
| **BA1** | **Sidecar health-poll + auto-restart** | A Tauri background task probes each readiness port (8000/5055/8100) every 5–10s; restart on failure; surface aggregate status to the top bar. Wakes the dead-code `is_port_listening`. | H·M·M |
| **BA2** | **Ordered startup + readiness gates** | `build_sidecar_specs()` → struct with `readiness_port` + `depends_on`; SurrealDB ready before open-notebook connects; `get_sidecar_status()` command for the UI. | M·M·L |
| **BA3** | **Offline-mode context + banner** | `OfflineContext {isOffline, reason, sidecarsReachable}` + `useOfflineStatus()`; replace silent Dexie fallback with a visible "RAG unavailable — retry" banner + cached last-known notebooks/models. | M·M·L |
| **BA4** | **SurrealDB→Dexie read-through fallback** | Wrap driver methods; on SurrealDB error, fall back to Dexie (synced at cutover) + background resync on recovery. Keeps the app usable through a crash. Depends BA1. | H·L·M |
| **BA5** | **Atomic batch writes** | `atomic_batch(session)` context manager + per-candidate savepoints in the gen worker / `srs_routes` `/cards`; prevents partial-write corruption (e.g. 3 of 5 SRS cards). | H·M·L |
| **BA6** | **Runtime model health + missing-model recovery** | Resolve explain/gen/critic/embed models at startup (fail loudly if all missing); `/observability/model-health` (30 s cache); recovery card with the exact pull command + fallback link. Merges be-lsat#7 + be-ai#14. | M·M·L |
| **BA7** | **Embedding cache invalidation + model fallback** | Tag `EmbeddingVector.model_name`; self-invalidate the `_vec_cache` on model swap (or a SQLite trigger + `cache_version`); add `EMBED_MODEL_FALLBACK`. Stops silent cross-model retrieval rot. Merges be-lsat#8 + be-ai#5/#12. | H·M·L |
| **BA8** | **Sidecar log capture + in-app viewer** | Pipe child stdout/stderr to a rolling buffer; `get_sidecar_logs(name)` + a "System Log" panel so users can self-diagnose a failed Python worker. | M·L·L |

### B-B — AI / LLM experience

| # | Upgrade | What / why | I·E·R |
|---|---------|-----------|-------|
| **BB1** | **Model warm/unload manager** *(quick win)* | System Health panel: loaded models + VRAM + pin/unload buttons; auto-pin explain model during a study session via `set_keep_alive`. Fixes GPU thrash. | H·M·L |
| **BB2** | **Unify streaming + timeout/cancellation** | One `streamingClient.ts` (SSE + events) for both domains; cancellable timeout guard that emits a discrete timeout event (vs. a 120 s generic CORS error); the CFA side gains real streaming. Merges be-ai#1+#2. | H·L·M |
| **BB3** | **Request dedup** *(quick win)* | `Map<key,Promise>` in `localLlm`; coalesce in-flight identical explain/gen calls. | M·S·L |
| **BB4** | **Cloud budget + Whisper-download visibility** | System Health cards: month-to-date spend + next-call dry-run estimate (`LSATLAB_CLOUD_DRY_RUN`); Whisper/voice model cache status + explicit download w/ progress + browser-STT fallback. Merges be-ai#10+#6. | M·M·L |
| **BB5** | **Generation quality signals** | Self-consistency → a `gate_confidence` score (3/3 vs 2/3) instead of binary; schema_version + prompt_version on candidates/explanations for replay + A/B. Merges be-ai#4+#7+#8. | M·M·L |

### B-C — Correctness & maintainability (sequence F1 before any new schema work)

| # | Upgrade | What / why | I·E·R |
|---|---------|-----------|-------|
| **BC1** | **Single migration ledger** | Fold `_ADDITIVE_COLUMNS` into `migrations.py` (the B8 TODO); kill the split-brain that passes tests (`create_all`) but skips pre-existing tables in prod. **Do before new schema.** | H·M·M |
| **BC2** | **Typed `response_model` + pagination** | Pydantic response models on all routers (start with high-traffic) + `limit/offset` envelopes on list endpoints; a CI warn for missing models / unbounded lists. Type-safe FE↔BE boundary. Merges be-lsat#2+#9. | H·M·L |
| **BC3** | **N+1 batch helpers + query-count CI gate** | A `query` module of bulk-aggregate helpers (proven by the B5 comment) + a pytest `@max_queries(N)` gate on `/preptests`, `/analytics`. | M·M·L |
| **BC4** | **Observability hardening** | SQLite busy-retry/WAL metrics + `/observability/sqlite-health`; central exception→(status,code,retryable) map + per-operation trace IDs; surface the `release_trust.json` manifest at `/observability/trust-status` + a UI indicator + a release gate. Merges be-lsat#4+#6+#11. | M·M·L |

---

## 2. UI track (polish & refinement)

### U-A — Design-system unification (the S1 finish; **BA-style keystone = UA1**)

| # | Upgrade | What / why | I·E·R |
|---|---------|-----------|-------|
| **UA1** ⭐ | **Host hex → HSL palette** | Convert `index.css` `:root` hex → `hsl()` mapped to LSAT's semantic names (`--primary`, `--destructive`, graphite/verdict ramps already WCAG-vetted), in an `@layer colors`. Additive (2 passes). **Unblocks UA2–UA6.** | H·M·M |
| **UA2** | **One theme provider** | Merge host `ThemeContext` + LSAT `theme-provider` into one source of truth (data-theme/contrast/reading-mode); converge host dark navy → LSAT graphite ramp. Depends UA1. | H·M·M |
| **UA3** | **Unify elevation / focus-ring / motion / radius tokens** | Adopt LSAT's 5-step `--elevation-*`, ring+offset focus, 3 canonical eases + durations, and a 4-value radius scale (drop the dead `--radius-xl`). Depends UA1. | M·S–M·L |
| **UA4** | **Button / input / card primitive parity** | Lift LSAT's CVA button + ring-offset focus + `active:scale` + interactive card lift into a shared `@layer components`; host buttons gain tactile feedback. Depends UA1–UA3. | H·M·M |
| **UA5** | **Unified typography scale + type-voice** | Converge on LSAT's size ramp (17 px base) + `type-display/counsel/numeric` voices; host headings adopt them. (Visible reflow — audit layouts.) | M·M·M |
| **UA6** | **`.qv-*` → Tailwind** | Deprecate the 43 bespoke `.qv-*` utilities → Tailwind/`@apply`; one utility vocabulary, smaller CSS. Continuous, after UA4. | M·M·L |
| **UA7** | **Design-token gallery + visual regression** | A tokens Storybook/gallery (colors, spacing, elevation, motion, type) + Playwright/Chromatic visual snapshots across light/dark/high-contrast — the regression net for all UA work. | H·M·L |

### U-B — UX refinement

| # | Upgrade | What / why | I·E·R |
|---|---------|-----------|-------|
| **UB1** | **Host scroll-restoration + skeleton heights + soft-nav feedback** *(quick wins)* | Port LSAT `scrollRestore`; reserve `min-height` on Today/Dashboard panels (CLS); a 120 ms fade + top loading-bar on cross-domain soft-swap. Merges ux#2+#11+#12. | H·S·L |
| **UB2** | **Dashboard information hierarchy** | Above-fold = a sticky KPI band + ONE dominant "what to study now" card; push domains/tools below. Reduces the 4-viewport scroll. | H·M·M |
| **UB3** | **Quiz/drill micro-interactions** | Press feedback, correct/incorrect reveal (gold glow / red shake), score count-up — using the existing `motion/react`. | M·M·L |
| **UB4** | **Responsive pass** | Mobile drawer sidebar (auto-hide on nav, swipe-close, 48 px targets); explicit Tailwind grid breakpoints; mobile full-screen dialogs/sheets. Merges ux#5+#9+#14. | H·M·M |
| **UB5** | **Shared states + toast polish** | Promote LSAT's `EmptyState/ErrorState/Skeleton` to a shared barrel for the host; toast dedupe + progress (loading→success) + undo on destructive ops. Merges ux#6+#10. | M·M·L |
| **UB6** | **Palette scope + keyboard help** | Domain badges (CFA/LSAT/Quant) + current-domain priority in ⌘K + a "jump to domain" row; shared `?` keyboard-help overlay for the host. Merges ux#7+#15. | M·M·L |
| **UB7** | **Study-session card + onboarding resume** | Group timer/plan/journal into one sticky tabbed session card; persist onboarding step + "resume" prompt + a "you're ready" CTA. Merges ux#4+#13. | M·M·M |

### U-C — Accessibility & performance

| # | Upgrade | What / why | I·E·R |
|---|---------|-----------|-------|
| **UC1** | **Keyboard/focus hardening** *(quick win)* | Global `*:focus-visible` ring; skip-to-main link + `<main>` landmark; focus-trap every overlay (Radix Dialog); arrow-key list nav. Merges a11y#5+#11+#12. | H·S·L |
| **UC2** | **WCAG contrast test suite** | Wire the existing `@axe-core/playwright` + `a11y:check` into CI; assert AA on Primitives + chart SVGs in both themes + the per-domain light-mode accents. Merges a11y#1 + ui-ds#11. | H·M·L |
| **UC3** | **Lazy-load ML + chart routes + domain prefetch** | `import()` transformers/kokoro inside the synth handler (not module scope) + a progress UI; wrap chart routes in `React.lazy` so CFA-only users skip visx (and vice-versa) — the next mile of P6; `prefetchDomainChunk()` on nav intent. Merges a11y#2+#3+#8. | H·M·M |
| **UC4** | **Virtualize large lists** | Apply the existing `VirtualizedList` / `@tanstack/react-virtual` to the question bank, source-vault results, exam history (1000+ rows). | H·M·M |
| **UC5** | **Accessible charts (ARIA-live)** | Announce hover values + brush-range summaries via the existing `LiveRegion`; arrow-key data-point navigation on `TrendChart`. | H·M·L |
| **UC6** | **Perf instrumentation + font-display** | `font-display: swap` on the fontsource faces; web-vitals (LCP/CLS/INP) → a System-page metrics panel (local-only, no remote analytics) + a reduced-motion test. Merges a11y#4+#9+#13. | M·S–M·L |

---

## 3. Suggested sequencing

The two tracks run in parallel (different files, low conflict). Within each,
respect the dependency arrows.

- **Wave 1 — Quick wins + keystones kickoff (1–2 wks).** BB1, BB3, BA6, UC1, UB1
  (all S, high-felt) ‖ start **BA1→BA2** (backend keystone) ‖ start **UA1**
  (UI keystone). Land **BC1** before any new schema.
- **Wave 2 — Resilience + design-system core.** BA3, BA4, BA5, BA7 ‖ UA2, UA3,
  UA4 (now unblocked by UA1) ‖ UC2 (contrast gate) + UA7 (visual-regression net)
  so the design-system churn is protected.
- **Wave 3 — Experience depth.** BB2 (streaming), BB4, BB5 ‖ UB2, UB3, UB4
  (responsive) ‖ UC3, UC4 (perf), UC5 (accessible charts).
- **Wave 4 — Maintainability + finish.** BC2, BC3, BC4, BA8 ‖ UA5, UA6, UB5,
  UB6, UB7, UC6.

Each item ends green on `npm run verify` + `npm run test:all` + `typecheck:lsat`
+ `cargo test`; UI items that touch rendering get a browser pass; per
`docs/STUDYVAULT-POLISH-PLAN.md` discipline (GitNexus impact before shared-symbol
edits, `detect_changes` before commits).

---

## 4. Deferred / lower tier (real but low impact — revisit later)

Differential/incremental export; open-notebook notebook snapshots; source-vault
repair-UI automation; configurable vector-fusion (RRF/re-rank) settings;
embedding-dimension validation + rebuild UI; async splash-screen progressive
unlock; per-choice *incremental* streaming parse. All are sound but marginal for
a single-user app; pull them forward only if a concrete need appears.

---

## 5. Method note

6 read-only audit agents (Explore) over the live tree (LSAT FastAPI/SQLite,
data+RAG+sidecars, AI/LLM pipeline; design-system, UX flows, a11y+perf) →
**75 candidate upgrades** → this synthesis deduped to ~32 tracked items + a
deferred tier. Every candidate cited concrete files; this doc keeps the
highest impact×effort×risk set. Nothing here is implemented.
