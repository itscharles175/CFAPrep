# StudyVault - Stack-Wide Upgrade Roadmap (2026 vNext)

> Status: **EXECUTION IN PROGRESS - roadmap plus implementation evidence log.**
> Authored 2026-07-05 from a GitNexus-grounded, six-agent read-only swarm over
> the live `CFAPrep` tree. This document exists so the upgrade program is not
> trapped in chat history.

## Execution Progress

Implementation has started after the original planning pass. Current completed
guardrails:

- Wave 0 decision record: vNext invariants accepted in
  `docs/decisions/2026-07-05-vnext-invariants.md`.
- Wave 1 architecture fitness: GitNexus circular imports are broken and route
  manifest/render parity is covered by tests.
- Wave 1/2 sidecar boundary: direct LSAT sidecar fetches outside approved
  adapters are now banned with an empty ratchet baseline.
- Wave 3 local API token scaffold: the backend accepts an optional local API
  token and the shared frontend transport injects it when supplied in memory.
- Wave 3 local API token route evidence: representative write, import, backup,
  and AI routes now assert 401 for missing/wrong per-run tokens when
  `LSATLAB_LOCAL_API_TOKEN` is configured, while health and CORS preflight stay
  open for startup probes.
- Wave 3 packaged token handoff: Tauri now generates a per-run token, passes it
  to the LSAT sidecar, exposes it through a read-only command, and gates root
  mount until the frontend has bootstrapped it.
- Wave 5 LSAT sidecar identity: `/api/health` now returns `ok`, `service`, and
  `version`; the Rust supervisor verifies the LSAT identity on a 2xx response
  before classifying port `8100` as healthy, and the OpenAPI/generated client
  contract is updated.
- Wave 4/5 sidecar provenance: sidecar build scripts now emit a bundled
  SHA-256 manifest, release CI verifies the manifest before Tauri bundling,
  LSAT trust reports provenance evidence, and the Rust supervisor refuses a
  manifest-tampered sidecar before launch/respawn.
- Wave 4 release-local trust: `scripts/release_local.py` now produces the
  repo-root release evidence consumed by backend trust, runs the expanded
  frontend/backend/content/RAG/security/static release gates, writes
  `dist/release_trust.json` through `app.trust --check`, and uses a packaged-app
  smoke that launches the built desktop app and verifies LSAT sidecar identity.
- Wave 8 eval release gates: release-local evidence now has named, required
  floors for RAG retrieval eval, citation faithfulness, source-grounded
  CFA/LSAT answer grounding, generated-content gating, explanation golden pass
  rate, prompt-regression fixtures, and generation-quality regression, plus the
  always-on static release labels (content validation, no-egress,
  sidecar-fetch inventory, docs drift, dependency audit); backend trust blocks
  release reports that omit them, and tagged-release verification runs the same
  floors before bundle builds.
- Wave 1 backend test coverage: `.github/workflows/ci.yml` now runs the full
  LSAT backend pytest suite in a dedicated PR job with hermetic loopback model
  env, `pytest-cov`, JSON/XML coverage artifacts, and an 85% floor against the
  measured 85.85% backend app coverage baseline.
- Wave 1 native Rust gate: CI now runs the Tauri Rust supervisor gate on
  `windows-latest` with rustfmt, clippy warnings denied, and
  `cargo test --all-features`; local verification passed 136 tests covering the
  Windows Job Object kill-on-drop path, relocation guard, sidecar identity,
  provenance, port sweep, and supervision paths.
- Wave 1 storage ID safety: SurrealDB record IDs now use reversible UTF-8
  percent encoding instead of lossy slug replacement for chunks, review items,
  mastery snapshots, and generic keyed tables; chunk search/export decode
  Surreal record references back to host chunk IDs. Focused local evidence
  passed the storage ID/conformance/chunk suites, storage durability/cross-domain
  suites, and backend cross-domain mirror tests.
- Wave 1 reasoning-trace safety: host `stripThink` now has a stateful streaming
  filter for split live deltas; `streamText`, TTS sanitization, Socratic turns,
  local RAG, multimodal vision, structured parsing, raw text generation, and
  offline `content:expand` all strip reasoning traces before UI, speech, cache,
  or generated artifacts. Backend `ai.strip_think` / `_ThinkFilter` now match
  the stronger variant/nesting/unclosed/fence contract, and notebook model
  assistance reuses the shared backend primitive.
- Wave 1 offline/no-egress invariant: strict backend offline mode now blocks
  cloud LLM selection at startup, facade routing, and direct Anthropic provider
  construction; cloud egress requires `LSATLAB_ENFORCE_OFFLINE=0` plus
  `LSATLAB_CLOUD_EGRESS_ALLOWED=1`; remote Ollama/LM Studio URLs require
  `LSATLAB_ENFORCE_OFFLINE=0` plus `LSATLAB_ALLOW_REMOTE_LLM=1`.
  Browser-composed sidecar/local-model bases now share a loopback-only runtime
  guard before fetch across LSAT sidecar, local LLM, vision, embeddings,
  open-notebook, and model-routing sync.
  `scripts/check-no-egress.mjs` scans shipped host/backend source for
  non-loopback endpoints, runs in CI/release, and passed locally across 666
  shipped source files.
- Wave 1 recurring scheduler tick: `JobWorker._loop` now polls due
  `ScheduledTask` rows on idle passes through a throttled
  `run_due_scheduled_tasks` call, seeded defaults are created at startup,
  `LSATLAB_SCHEDULER_TICK_SECONDS` controls the cadence, due rows append
  `SchedulerRun` evidence, scheduler failures are isolated, and queued
  generation jobs remain higher priority than maintenance work.
- Wave 5 RAG-less native behavior: SurrealDB is now modeled as optional RAG
  infrastructure, RAG-dependent sidecars self-skip when their resources are
  absent, the stale-port sweep only claims ports for present sidecars, and the
  packaged smoke verifies the desktop app boots to a degraded-not-error state
  with only LSAT port `8100` owned.
- Wave 3 import hardening: Notebook URL imports validate every redirect hop
  before fetch and now enforce the URL byte cap while streaming chunked
  responses, pin validated DNS results through the actual socket-connect window,
  and reject non-global address ranges such as CGNAT, so missing
  `Content-Length` and post-validation DNS rebinding cannot force unsafe fetches.
- Wave 2 host-route contract safety: `/api/adaptivity/next` and
  `/api/study/today` now have permissive FastAPI response models, generated
  OpenAPI/client artifacts were refreshed, and the field-removal guard covers
  both routes so host-consumed planning/adaptive payloads no longer rely on the
  legacy fallback schema.
- Wave 5 native lifecycle hardening: repeated sidecar exits now use a bounded
  exponential respawn backoff, healthy probes clear the failure counter, and
  Windows Job Object kill-on-close behavior is pinned by a real child-process
  test so orphan protection is covered below the supervisor abstraction.
- Wave 5 packaged shutdown evidence: the release-local packaged smoke now checks
  all owned sidecar ports (`8000`, `5055`, and `8100`) after app termination,
  not only the LSAT backend port, so RAG-enabled bundles cannot leave SurrealDB
  or open-notebook listeners behind unnoticed.
- Wave 4 release manifest/SBOM evidence: `scripts/release-manifest.mjs` now emits
  a dependency-and-asset manifest with Node, Rust, and Python component counts,
  lockfile hashes, sidecar provenance digest, bundle asset hashes, and captured
  signing configuration status; local and GitHub release gates require it after
  Tauri bundle creation, and backend release trust surfaces the manifest as a
  first-class check.
- Wave 4 version/tag sync: package, Tauri, Cargo, and backend `APP_VERSION`
  now agree on `0.9.0`; PR CI runs `npm run check:versions`; release
  verification runs the same gate with `--git-tag` so a `vX.Y.Z` tag cannot
  publish a differently versioned bundle.
- Wave 4 docs-drift gate: `scripts/check-docs-drift.mjs` now validates
  `docs/ARCHITECTURE.md` against the live unified-root boot path and curated
  load-bearing references; PR CI, release verification, and release-local trust
  all require `npm run check:docs`.
- Wave 4/DX stack doctor: `npm run doctor` now writes
  `dist/reports/stack-doctor.json` with local toolchain, required manifest,
  staged sidecar provenance hash, and expected loopback port evidence; `npm run
  doctor -- --all` adds version sync, OpenAPI drift, no-egress,
  sidecar-fetch inventory, docs drift, baseline catalog, and vault archive
  restore checks.
- Wave 2 host coverage ratchet: Vitest and `@vitest/coverage-v8` are aligned at
  `4.1.9`; PR CI runs `npm run test:ci -- --coverage` over the host surface
  with `all:true`, JSON summary artifacts, and floors of 48 statements / 37
  branches / 49 functions / 50 lines. Local evidence passed 149 host test
  files, 1,616 tests, and measured 59.5 / 47.52 / 58.01 / 61.03.
- Wave 4 vendor chunk split: Vite now emits a dedicated
  `react-query-vendor` chunk and an `lsat-ui-vendor` chunk for Radix/motion/
  sonner/cmdk/vaul; the bundle trend policy now normalizes hyphenated
  Rolldown/Vite hashes, and `npm run bundle:report` passes against the current
  production build.
- Wave 6 exam timer resilience: LSAT `ClockStore` now anchors timed sections to
  an absolute wall-clock deadline, reconciles on heartbeat/visibility return,
  persists `deadlineMs` in session drafts for crash/reload resume, and keeps the
  question tree isolated from per-second re-renders.
- Wave 3 secure-vault note encryption pilot: when Secure Vault is enabled and
  unlocked, host Vault note title/body fields are stored as AES-GCM ciphertext
  with plaintext metadata/index fields preserved; read APIs decrypt for the UI,
  enable/disable runs note migrations, and Tauri keychain IPC is constrained to
  the app-owned `studyvault/vault-dek` credential.
- Wave 3 secure-vault artifact encryption expansion: Secure Vault now also
  encrypts host result artifact title, summary, assumptions, and metrics at
  rest while preserving routing/filter metadata; artifact list/CSV APIs decrypt
  when unlocked, and enable/disable migrations cover existing artifact rows.
- Wave 3 secure-vault open-notebook settings encryption: cached grounded
  open-notebook Q&A, answer-history, and topic-notebook map settings rows now
  use Secure Vault AES-GCM envelopes when enabled; raw IndexedDB settings rows
  no longer contain cached question/answer or notebook/source sentinel text,
  while public APIs still decrypt when unlocked, refuse plaintext writes when
  locked, and enable/disable migrations convert existing rows in both
  directions.
- Wave 3 host-only backup export hardening: Dashboard's primary Export action
  now opens the passphrase-gated encrypted export flow, and the command palette
  backup action routes to System Health instead of emitting plaintext JSON.
  Plaintext host-only export remains isolated to the explicit advanced
  diagnostic path.
- Wave 3 secure-vault observability: System Health's Vault Safety report now
  separates backup/export encryption from live at-rest Secure Vault coverage,
  reporting enabled/unlocked status and encrypted-row coverage for notes, result
  artifacts, and sensitive open-notebook settings rows. It also calls out
  source-vault rows that remain outside the live Secure Vault scope so users do
  not confuse passphrase-protected backups with full-store live encryption.
- Wave 3 open-notebook cache cleanup parity: System Health's grounded-Q&A cache
  bucket now counts and clears both `open-notebook:answer:*` and
  `open-notebook:answer-history:*`, so encrypted history rows do not survive a
  user-requested cache purge.
- Wave 3 service-worker privacy denylist: Workbox precache/runtime routes now
  refuse `/api`, backup/export, source-vault/source-bundle, and private-sentinel
  URLs, activation purges any previously cached private entries, and focused
  Vitest coverage proves private requests are removed while public assets stay.
- Wave 3 desktop source-import hardening: the Tauri CFA folder/PDF bridge now
  refuses symlinked roots/files, skips symlinked directories and non-regular
  filesystem entries during recursive scans, caps desktop PDF reads at 50 MiB,
  and covers the guards in Rust tests.
- Wave 3 notebook upload bounds: `/api/notebook-sources/import` now reads
  multipart uploads with the source cap plus one byte before rejecting, enforces
  refs/tags metadata count and length parity with the JSON route, caps extracted
  source text, and refuses oversized DOCX `word/document.xml` members before
  decompression.
- Wave 3 backend dataset import hardening: local dataset paths now go through a
  regular-file-only guard that rejects symlinks, non-regular files, unsupported
  suffixes, and oversized files; JSONL imports are byte/row/line bounded; ReClor
  ZIP imports validate entry count, paths, encrypted flags, member sizes,
  aggregate uncompressed size, compression ratio, expected JSON members, and row
  count before yielding rows.
- Wave 3 host JSON import preflight: `.qvsource` source bundles, unified
  restore files, encrypted restore files, and LSAT Bank raw backup imports now
  use a shared browser-side JSON parser that rejects oversized files before
  reading them into memory.
- Wave 3 encrypted unified backup defaults: the host+LSAT unified export path
  now requires a passphrase by default, downloads the envelope as `.qvenc.json`,
  keeps plaintext export behind an explicit advanced action, and restores
  encrypted unified backups only after passphrase decryption and checksum
  validation.
- Wave 3 backend-native backup encryption defaults: `/api/export/backup` now
  rejects implicit plaintext, can emit the same AES-GCM/PBKDF2 `.qvenc.json`
  wrapper as the host, and `/api/export/validate` plus `/api/export/import`
  decrypt encrypted artifacts only when a passphrase is supplied.
- Wave 3 import provenance and force-commit policy: LSAT research dataset
  imports and portable bank restore now reject write attempts unless
  `force_commit=true` is supplied, while successful restore/import runs record
  force-commit and provenance metadata in the import ledger.
- Wave 3 model-provider egress policy: cloud LLM routing now splits
  configuration from egress admission, requires
  `LSATLAB_CLOUD_EGRESS_ALLOWED=1` in addition to the existing offline-fence
  opt-out, falls back local when configured without egress admission, and logs
  cloud egress decisions with task/model/cost metadata but no prompt content.
- Wave 4 open-notebook source pinning: RAG-enabled release builds now require
  `ONB_GIT_REF` to be a full commit SHA, checkout the source detached at that
  commit, verify the source tree is clean, and record the packaged source
  revision in sidecar provenance.
- Wave 3 secure-vault source chunk encryption: CFA source chunk payload fields
  (`text`, `normalizedText`, optional `heading`, and optional
  `learningOutcomes`) now use Secure Vault AES-GCM envelopes at rest while
  routing/index metadata remains clear; source search, RAG retrieval, exports,
  and imports decrypt only when unlocked, and System Health reports source chunk
  coverage separately from remaining source-vault rows outside scope.
- Wave 3 LSAT SQLite field encryption: the desktop supervisor now owns a
  distinct OS-keychain `studyvault/lsat-db-dek`, passes it only to the LSAT
  backend as `LSATLAB_DB_KEY_B64`, and selected non-FTS local-only SQLite fields
  (`AttemptRationale.rationale_text/br_note`, `TutorTurn.content`,
  `ErrorLogEntry.user_note/ai_diagnosis`, and `LLMCacheEntry.response`) store
  versioned AES-GCM envelopes at rest while ORM/API reads continue returning
  plaintext. Raw row, DB/WAL/SHM, backup snapshot/manifest, restore, key, and
  sidecar-status/log no-leak tests cover the boundary.
- Wave 6 vault archive restore drill: `npm run vault-archive:drill` now proves
  the host vault export -> wipe -> import path against fake-indexeddb, compares
  source-of-truth per-store checksums, and is required by PR CI, tagged release
  verify, release-local evidence, and backend release trust.
- Wave 9 mobile drawer focus parity: host `App.jsx` and LSAT `SharedLayout`
  now focus the first visible sidebar target on mobile open, skip hidden drawer
  controls, close on Escape, and return focus to the menu button. The repeatable
  production-build probe is `npm run mobile-nav:probe`; it writes
  `dist/reports/mobile-nav-focus.json` and settled mobile screenshots for
  `/today` and `/lsat/srs`.
- Wave 9 keyboard-flow first floor: `npm run a11y:keyboard` now runs against the
  production build, makes the host and LSAT `#main` skip targets focusable,
  verifies skip-link focus/landing on `/today` and `/lsat/srs`, checks visible
  focus indicators across sampled host and LSAT tab stops, repeats the mobile
  drawer focus/restore flow, and exercises LSAT timed-section shortcuts against
  forced offline sample data. It writes `dist/reports/keyboard-flow.json` and
  mobile drawer screenshots under `dist/reports/keyboard-flow/`.
- Wave 9 LSAT accessibility backlog evidence: the LSAT-only axe/contrast gate
  (`INCLUDE_LSAT_ROUTES=1 LSAT_ROUTES_ONLY=1 npm run a11y:check`) now passes the
  desktop/mobile LSAT route sweep in dark and light themes plus the focused
  analytics, bank, and settings contrast probes. The first-floor semantic fixes
  cover LSAT progress bars, answer-choice radiogroup/list semantics,
  contribution heatmap cell labels, Bank select names, Bank row nested controls,
  and Notebook mobile icon-action names. The repeatable semantic probe is
  `npm run lsat:a11y:semantic`; it checks `/lsat`, `/lsat/preptests`,
  `/lsat/rc-lab`, `/lsat/srs`, `/lsat/analytics`, and `/lsat/bank` on desktop
  and mobile and writes `dist/reports/lsat-semantic-a11y.json`. Remaining debt:
  broader route focus-order/trap expansion and richer runner composite-widget
  keyboard patterns.
- Wave 9 OS contrast preference first floor: host and LSAT styles now respond
  to `prefers-contrast: more` and `forced-colors: active`. The host remaps
  primitives, shell chrome, shortcut chips, status/value text, progress fills,
  focus outlines, and chart tokens to high-contrast/system-color pairs; the LSAT
  shell mirrors its high-contrast hardening for OS preference users and adds
  forced-colors fallbacks for dense bank controls, highlights, SVG/chart marks,
  and focus rings. `npm run a11y:check` now probes host `/style` and
  `/analytics` under both media modes; the scoped LSAT gate probes `/lsat/bank`
  and `/lsat/analytics` the same way.
- Wave 9 shared question-runner primitive: `AccessibleChoiceGroup` now owns the
  reusable radiogroup contract (one tabbable radio, arrow/Home/End roving focus,
  Space/Enter/direct-letter selection, modifier-key passthrough, and handled-key
  propagation control). `AccessibleQuestionRunner` is the CFA-style adapter,
  `CfaQuiz`, `CfaVignette`, and `MockExam` use the shared path while preserving
  numeric selected indexes, and LSAT `ChoiceList` uses the same primitive while
  preserving elimination/reveal/trap/spotlight behavior and test-mode shortcuts.
  Focused evidence: host shared-runner tests, LSAT `ChoiceList`/semantic bundle
  tests, host `tsc --noEmit`, and `tsc -p tsconfig.lsat.json` passed.
- Wave 2 host-route contract coverage: 48 additional backend routes across
  trust (all 14), observability (all 10), SRS (all 9), settings, search,
  sync/FSRS write-back, unified export (validate/import/list/history),
  adaptivity (ability/plan/readiness/recompute-item-stats), analytics
  calibration, and AI health now declare inline permissive response models
  (`ConfigDict(extra="allow")` + `response_model_exclude_unset=True`) mirroring
  the wire payloads byte-for-byte; `_GUARDED_ROUTES` in
  `services/lsat-backend/tests/test_openapi_contract.py` grew from 7 to 80
  route/method pairs with a baseline-membership assertion so guard extensions
  without a `UPDATE_SCHEMA_BASELINE=1` re-snapshot fail loudly;
  `tests/test_response_models.py` adds a Wave 2 ratchet that fails if any
  typed route regresses to the `LegacySuccessResponse` fallback or a
  schemaless object; `openapi-baseline.json`, `_meta/openapi.json`, and
  `api.gen.ts` were regenerated (additive: +75 component schemas, 0 deletions,
  operations unchanged); `openapi-typescript` is pinned at 7.13.0 and CI's
  `lsat-sidecar-smoke` job gained a full `gen:api` + `git diff --exit-code`
  regeneration drift gate. `POST /api/export/backup` stays deliberately
  untyped (polymorphic encrypted-blob | plaintext envelope).
- Wave 9 hands-free runner first floor: the existing `HandsFreeController` now
  exposes style hooks so it can be embedded in both host and LSAT shells without
  CSS leakage. `CfaQuiz` keeps its existing read-aloud/spoken-answer path with a
  tighter global keyboard guard; `CfaVignette`, `MockExam`, and LSAT
  `SectionRunner` now provide read-aloud question context plus spoken
  answer-selection. Timed/test-mode LSAT and mock flows require explicit
  confirmation before selecting an answer. Focused evidence: host hands-free and
  voice tests, LSAT hands-free/choice-list tests, host `tsc --noEmit`, and
  `tsc -p tsconfig.lsat.json` passed. Remaining expansion: offline Whisper
  wiring in the runner UI and voice commands for eliminate/flag/next/repeat.

Remaining caveat: broad IndexedDB/SQLite/SurrealDB encryption beyond the current
Secure Vault row classes and selected LSAT SQLite fields remains a separate Wave
3 workstream; stale-port native lifecycle smokes plus external platform
signing/notarization enforcement remain separate Wave 5 workstreams.

## Scope

This roadmap is the vNext stack-wide plan for StudyVault after the earlier H2
roadmap. It should be treated as a current planning artifact, not as proof that
any item below has been implemented.

Repository analyzed:

- Local path: `E:\StudyVault\CFAPrep`
- Branch: `codex/performance-level2-content-gate`
- HEAD: `76ed667e897709dfce03aab170be7f59a88907d3`
- HEAD date: `2026-06-21 13:24:06 -0400`
- HEAD subject: `chore(tauri): normalize Cargo manifest (explicit empty features) from tauri build`

## Method

The planning run loaded GitHub, GitNexus, architecture, fullstack, frontend,
backend, DevOps, security, roadmap, and swarm guidance. GitNexus indexed the
repository before synthesis.

GitNexus index snapshot:

- 1,061 files
- 90,247 nodes
- 184,926 edges
- 952 communities
- 300 processes
- 217 routes

Six read-only swarm explorers inspected distinct surfaces:

- Product and learning loop
- Frontend architecture and UX
- Backend, data, API, and AI/RAG
- Native/Tauri packaging and sidecars
- CI, release, observability, and DevOps
- Security, privacy, import, keychain, and local-first trust

No code was intentionally changed during the planning pass.

## Current Ground Truth

StudyVault is already a serious local-first learning shell: Vite/React host,
Tauri desktop packaging, LSAT under the shared app, Dexie-first storage with
SurrealDB migration support, Python sidecar services, RAG/eval rails, FSRS,
offline banners, CFA/Quant/LSAT domains, native sidecar supervision, and broad CI.

The old H2 roadmap should not be repeated blindly. Several earlier gaps are now
partly or fully addressed in the current tree: Windows process-group support,
backend pytest in CI, Rust/Tauri tests in CI, no-egress checks, RAG eval, quota
support, keychain-backed vault work, maintenance surfaces, sidecar supervision,
and storage conformance work all exist in some form.

The current frontier is not basic feature presence. The frontier is integration
freshness, contract safety, release trust, data durability, import security,
learning-loop feedback, native packaged behavior, and evidence-driven AI quality.

## Verified Risks And Hotspots

### GitNexus structural findings

GitNexus reported six circular import cycles:

1. `src/domains/lsat/components/analytics/AnalyticsFilters.tsx` with analytics tabs/context.
2. `src/domains/lsat/components/command-palette-dialog.tsx` with command palette.
3. `src/domains/lsat/components/question/section-runner.tsx` with `sessionDraft.ts`.
4. `src/domains/lsat/components/viz/TrendChart.tsx` with `trendAnnotations.ts`.
5. `src/lib/domainNav.ts` with `src/lib/navigationHistory.ts`.
6. `src/lib/progressStore.ts` with `src/lib/storage/index.ts` and `dexieDriver.ts`.

GitNexus route shape coverage is weak for the frontend/backend boundary:

- `route_map` found 217 routes.
- `shape_check` found no routes with both response shapes and consumers.
- `tool_map` found no tool definitions.
- `explain` found no taint findings, but its model does not cover every callback,
  property, closure, or implicit-flow case. Absence of findings is not a proof
  of safety.

### Large-module hotspots

These files are large enough to deserve explicit ownership and refactor budgets:

- `src/index.css`
- `src/lib/progressStore.ts`
- `services/lsat-backend/app/notebook_os.py`
- `src-tauri/src/lib.rs`
- `src/pages/SystemHealth.jsx`
- `services/lsat-backend/app/generation.py`
- `services/lsat-backend/app/analytics.py`
- `services/lsat-backend/app/adaptivity.py`
- `src/domains/lsat/lib/api.ts`
- `src/domains/lsat/pages/ContentOps.tsx`
- `src/domains/cfa/contentPacks.ts`
- `src/domains/lsat/lib/hooks.ts`
- `src/domains/cfa/CfaModule.jsx`
- `services/lsat-backend/app/migrations.py`
- `src/domains/lsat/pages/Notebook.tsx`
- `src/lib/storage/driverConformance.test.ts`
- `src/components/question/section-runner.tsx`
- `src/pages/Analytics.jsx`

## North Star

StudyVault should become a durable, local-first study operating system that can
prove its trust claims. The product should work offline, protect user data at
rest, recover from broken sidecars, explain why it recommends a task, preserve
source provenance, and ship only through reproducible, verified release gates.

The next roadmap should therefore prioritize:

1. Guardrails before expansion.
2. Contracts before broad refactors.
3. Security and recovery before wider release.
4. Learning-loop evidence before new recommendation layers.
5. Evaluation before AI capability jumps.

## Non-Goals

- No implementation is included in this document.
- Do not re-open already-shipped H2 work unless current evidence proves it is
  incomplete or regressed.
- Do not add multi-tenant, SaaS, cloud-sync, or distribution-server assumptions.
- Do not treat opt-in cloud model support as equivalent to the default local-first
  product promise.

## Wave 0 - Decisions And Invariants

Resolve these before major execution starts:

1. Is SurrealDB a required packaged sidecar or an optional degraded-mode feature?
2. Is live at-rest encryption default-on, opt-in, or staged by profile type?
3. Is the product allowed to egress for updater/model/cloud routes by default, or
   only after explicit opt-in?
4. Which platforms are release-blocking now: Windows only, or Windows plus macOS
   and Linux smoke?
5. Is the unified planner backend authoritative with host fallback, or are host
   and backend planners intentionally parallel?
6. Which generated materials are allowed into the review loop, and under what
   provenance/trust labels?

Exit gate:

- A short `docs/` decision record exists for each invariant above.
- CI and release expectations match those decisions.

## Wave 1 - Architecture Fitness

Purpose: stop architectural drift before adding new capability.

Workstreams:

- Break the six GitNexus circular import cycles.
- Split giant files by ownership and use-case seams, starting with storage,
  system health, notebook OS, Tauri lifecycle, analytics, generation, and
  adaptivity.
- Make `src/routes/routeManifest.ts` authoritative instead of maintaining route
  metadata separately from rendered routes.
- Add dependency rules for frontend and backend layers.
- Ban direct `127.0.0.1` sidecar fetches outside approved API adapters.
- Track JS/JSX and broad `any` counts with ratchets.
- Converge host/LSAT design-system imports through an approved import matrix.

Verification gates:

- GitNexus cycle check is clean.
- Every rendered route has manifest metadata.
- Every manifest route has a render target or explicit exclusion.
- New direct sidecar fetches fail lint outside API/client adapters.
- `verify:all` covers host lint/test/build plus LSAT typecheck and tests.

## Wave 2 - API And Contract Safety

Purpose: make the frontend/backend contract provable.

Workstreams:

- Regenerate and enforce OpenAPI/client contracts for all host-used routes.
  **Done:** `openapi-typescript` is pinned at 7.13.0 as a devDependency,
  `npm run gen:api` uses the local binary, and CI's `lsat-sidecar-smoke` job
  now regenerates both client artifacts and fails on any diff
  (`git diff --exit-code -- src/domains/lsat/_meta/openapi.json
  src/domains/lsat/lib/api.gen.ts`), closing the field-level client-drift and
  stale-`api.gen.ts` gaps the path-key-only `--client` gate left open.
- Replace string-literal sidecar calls with typed generated clients.
  **Unblocked, not started:** all 22 host string-literal callsites now exist in
  the regenerated `api.gen.ts` paths map, so their "ships ahead of the next
  regeneration" comments are stale; migrating them to `satisfies keyof paths`
  + `operations[...]` anchoring is a follow-up slice.
- Add explicit response models for import/export, observability, generation,
  bank, study, adaptivity, backup, and trust routes.
  **Done for host-consumed routes:** 48 additional routes across trust (all
  14), observability (all 10), SRS (all 9), settings, search, sync/FSRS
  write-back, unified export (validate/import/list/history), adaptivity
  (ability/plan/readiness/recompute), analytics calibration, and AI health now
  declare inline permissive response models (`ConfigDict(extra="allow")` +
  `response_model_exclude_unset=True`) that mirror the wire payloads
  byte-for-byte. `POST /api/export/backup` stays deliberately untyped
  (polymorphic encrypted-blob | plaintext envelope with key-absence tests);
  `backup_routes`, bank list/import, generation jobs, and notebook surfaces
  remain for a later slice.
- Expand runtime schemas beyond hot-path LSAT calls.
  (Host-consumed routes still have zero zod validation — follow-up slice.)
- Add consumer contract coverage so route shape changes are tied to frontend
  consumers.
  **Done for field-removal coverage:** `_GUARDED_ROUTES` in
  `services/lsat-backend/tests/test_openapi_contract.py` now snapshots all 80
  typed route/method pairs (every host-consumed route included), with a
  baseline-membership assertion so extending the guard without re-snapshotting
  `tests/schemas-baseline.json` fails loudly; `tests/test_response_models.py`
  adds a Wave 2 ratchet asserting typed routes never regress to the
  `LegacySuccessResponse` fallback or a schemaless object.
- Add API generation drift gates for unified today, due-unified, study profile,
  adaptive next, and FSRS parameter routes.
  **Done:** all five are guarded (`/api/study/today`, `/api/study/due-unified`,
  `/api/study/profile` GET+PUT, `/api/adaptivity/next`, `/api/srs/params`) and
  the whole-artifact regeneration gate runs on every PR.

Verification gates:

- Removing a response field used by the frontend fails CI.
- GitNexus or companion contract tooling no longer reports zero covered route
  shape consumers.
- Generated API artifacts are current in CI.
- Unsupported backend endpoints cannot be called from production frontend code
  without a typed escape hatch and review label.

## Wave 3 - Local-First Security And Privacy

Purpose: make the offline/private promise enforceable.

Workstreams:

- Add a per-run local API token for write/import/backup/AI routes.
  **Done for LSAT sidecar routes:** when `LSATLAB_LOCAL_API_TOKEN` is set, the
  middleware protects every non-health `/api` route; regression tests cover
  write (`/study/profile`), import (`/bank/import`), backup
  (`/export/backup`, `/backup/now`), and AI (`/ai/explain`) samples returning
  401 without a valid token.
- Constrain Tauri keychain IPC to app-owned secrets only.
  **Done for Secure Vault:** keychain commands now reject non-`studyvault/vault-dek`
  targets.
- Finish live at-rest encryption for IndexedDB, SQLite, and SurrealDB-backed data.
  **Pilot done:** Vault note title/body fields are encrypted at rest when Secure
  Vault is enabled. **Expanded:** result artifact title, summary, assumptions,
  and metrics, cached open-notebook grounded Q&A/history and topic-notebook map
  rows, and CFA source chunk payload fields are now encrypted at rest when
  Secure Vault is enabled, with Secure Vault enable/disable migrations covering
  existing rows; broader host tables, source-vault token indexes/metadata,
  SQLite, and SurrealDB coverage remain open. System Health now reports live
  Secure Vault encrypted-row coverage separately from passphrase-protected
  backup/export encryption.
- Make unified and backend backups encrypted by default.
  **Done for unified host+LSAT backups:** System Health's primary unified
  export now emits passphrase-encrypted `.qvenc.json` files and import decrypts
  those wrappers before envelope validation. Plaintext unified export remains
  available only through an explicit advanced diagnostic action. The backend
  `/api/export/backup` route also refuses implicit plaintext, supports
  backend-native encrypted output, and decrypts encrypted validate/import
  requests only with the supplied passphrase. Dashboard's primary host-only
  export and the command-palette backup action no longer generate plaintext
  JSON; plaintext host-only export is confined to System Health's advanced
  diagnostic path.
- Harden notebook URL import against DNS rebinding, redirects, private IPs,
  no-content-length streaming, and oversized responses.
  **Done for URL imports:** redirect-hop validation, DNS pinning through
  `socket.create_connection`, non-global address rejection, and bounded streaming
  are covered by focused tests.
- Stage and constrain local dataset imports; reject symlinks, special files,
  huge JSON, and ZIP bombs.
  **Partial for desktop CFA PDFs:** the Tauri folder/PDF bridge now rejects
  symlink traversal, non-regular entries, and oversized PDF reads before bytes
  cross into the webview.
  **Partial for backend datasets:** local JSONL/ReClor paths now reject symlinks
  and non-regular files, cap JSONL files/rows/lines, and reject ZIP-bomb
  indicators before member decompression.
  **Partial for host JSON imports:** `.qvsource`, unified restore, encrypted
  restore, and LSAT Bank raw backup imports now share a 100 MiB browser-side
  preflight before JSON parsing.
- Bound notebook upload reads at the route level.
  **Done:** notebook multipart imports now use a bounded `UploadFile.read()`
  at the FastAPI route boundary, preserve the existing 25 MiB source limit, and
  reject oversized metadata/extracted text before persistence.
- Tighten import provenance and force-commit policy.
  **Done for LSAT bank imports:** `/api/bank/import` and
  `/api/bank/import-backup` now fail closed without `force_commit=true`; the
  Bank UI and API client send that flag only from explicit import/restore
  actions; successful import ledger entries capture the force-commit decision,
  dataset/license/source metadata, payload hash, and schema/version context.
- Make model-provider egress explicit, logged without prompt content, and
  fail-closed by default.
  **Done for LSAT model providers:** `GEN_PROVIDER=cloud` plus a key now only
  configures the route; actual Anthropic egress also requires
  `LSATLAB_CLOUD_EGRESS_ALLOWED=1` after the strict offline fence is opted out.
  The facade logs allow/deny decisions with provider/model, estimated tokens,
  worst-case cost, budget, and URL host while declaring `prompt_logged=false`;
  tests assert sentinel prompt text is absent from those logs.
- Add a service-worker privacy denylist for `/api`, backups, exports, source
  vault files, and private sentinels.
  **Done:** `src/swPrivacy.js` filters the injected precache manifest and all
  Workbox runtime routes, then purges matching entries from every Cache Storage
  bucket during service-worker activation; `src/swPrivacy.test.js` covers the
  denylist and purge behavior.

Verification gates:

- Protected write/import/backup/AI routes return 401 without the per-run token.
- Tauri client succeeds with the token.
- Sentinel data does not appear in raw IndexedDB, SQLite, Surreal, or backup
  artifacts after encryption migration.
- Wrong-passphrase and tampered-backup tests fail safely.
- Import security tests cover DNS rebinding, private redirects, chunked oversized
  content, symlinks, ZIP bombs, and invalid provenance.
- Cache Storage inventory proves private data is not cached.

## Wave 4 - Release Trust And Supply Chain

Purpose: make a published app more trustworthy than a green PR.

Workstreams:

- Make release verification match PR verification.
- Use locked Python dependency installs from `uv.lock` for backend tests and
  sidecar builds.
- Add version/tag sync using the existing tag-check script.
  **Done for PR/release gates:** package, Tauri, Cargo, and backend
  `APP_VERSION` agree; PR CI runs `npm run check:versions`; tagged releases run
  the same gate with `--git-tag`.
- Emit SHA256 manifests, SBOMs, and provenance for every release asset.
  **Done for local/CI release gates:** the release manifest records lockfile
  hashes, SBOM component counts, sidecar provenance, bundle hashes, and signing
  configuration status.
- Pin optional Open Notebook source by commit SHA.
  **Done for RAG-enabled release builds:** `ONB_GIT_REF` is mandatory when
  `ONB_GIT_URL` is set, must be a full 40-character commit SHA, is checked out
  detached, and is verified before the PyInstaller sidecar build.
- Verify sidecar hashes before Tauri bundling and again at startup.
- Add signed/attested release artifacts.
- Add packaged-app smoke after installer/bundle creation.
- Commit or formalize visual baselines so visual regression fails closed.
  Evidence: `scripts/visual-baseline-policy.mjs` now computes the required
  route/theme/viewport baseline matrix and blocks `visual:regression` before
  browser launch when any baseline is missing, unless
  `UPDATE_VISUAL_BASELINES=1` is explicitly set for an intentional rebaseline.
  CI restores host and LSAT visual baseline caches separately; cache misses now
  fail closed instead of silently bootstrapping screenshots.
- Add runtime performance gates, not only bundle-size gates.
  Evidence: `npm run perf:regression` runs the production preview in headless
  Chromium and writes `dist/reports/perf-regression.json`; CI now has a
  parallel runtime-performance job and release-local trust requires the
  `route performance budget gate` label.

Verification gates:

- A tag cannot publish unless PR-quality jobs or reusable equivalents pass.
- Package, Tauri, Cargo, and `vX.Y.Z` tag versions agree.
- Sidecar binaries are built from locked dependencies and verified hashes.
- Release artifacts have a generated manifest with SBOM counts and SHA-256
  hashes before upload.
- A fresh clone with no baseline cache cannot silently pass missing visual
  baselines.
- Packaged app launches, reports health, starts sidecars, exits cleanly, and
  leaves no orphaned ports/processes.

## Wave 5 - Native And Sidecar Reliability

Purpose: make desktop behavior robust enough to trust daily.

Workstreams:

- Add signed auto-update channel policy for Windows desktop, if updates are in
  scope.
- Make sidecar identity strict, especially the LSAT backend.
- Reject foreign processes on expected sidecar ports.
- Resolve RAG-less release behavior versus SurrealDB supervisor requirements.
  **Done for packaged startup:** RAG resources are optional and absent resources
  produce degraded boot status, not a required-sidecar error.
- Expand Windows sidecar lifecycle tests: parent exit, crash loop, stale port,
  owned-port reclamation, and app shutdown.
  **Partly done:** supervisor crash-loop backoff and Windows Job Object
  kill-on-close behavior are now unit/integration-tested.
- Harden Tauri capabilities and native file access.
- Separate browser PWA update behavior from desktop Tauri lifecycle.
- Add bundled sidecar provenance manifest and startup verification.
- Fix packaging-doc drift and gate it.

Verification gates:

- Foreign process on port `8100` returning a fake health response is rejected.
- LSAT health includes service identity and version.
- RAG-less bundle reports degraded state rather than a required-sidecar error.
- App exit leaves sidecar ports free.
  **Done for packaged smoke:** `scripts/release_local.py` preflights and
  post-cleanup checks every owned packaged sidecar port.
- Crash-looping sidecars are respawned with bounded backoff and reset after a
  healthy probe.
- Native PDF/file reads are limited to selected or granted paths.
- Tampered sidecar refuses launch with a clear status.

## Wave 6 - Data Integrity And Recovery

Purpose: protect the local vault as the user's only source of truth.

Workstreams:

- Make unified restore and history ledger atomic.
- Fix embedding export/import for BLOB-backed vectors, or mark vectors stale and
  trigger rebuild on import.
- Centralize question/test lifecycle cleanup instead of scattering manual cascade
  rules.
- Add full archive restore drills across backend and host data.
  **Done for host vault first floor:** `npm run vault-archive:drill` exercises
  the host fake-indexeddb vault, verifies archive manifests and source-of-truth
  checksums after restore, and is required by CI/release-local/tag verify.
- Enforce migration dry-run and pre-upgrade backup gates.
- Gate SurrealDB cutover on learning-loop integrity, not storage ambition.
- Add cross-store integrity ledger for Dexie, SQLite, SurrealDB, RAG chunks, and
  generated artifacts.
- Add large-vault import/export/restore soak fixtures.

Verification gates:

- Injected failure after imported rows but before history write rolls back fully
  or creates an explicit resumable recovery record.
- Export after real embedding generation restores similarity search or marks
  embeddings stale and rebuilds them.
- FK lifecycle test creates one dependent row per relationship and replace/delete
  leaves no orphans.
- Export, wipe, import round trip verifies row counts, checksums, restore history,
  official-content exclusion, and search/embedding usability.
- Old-schema upgrade requires fresh backup and passes readiness, FK, checksum,
  migration, and backup integrity checks.

## Wave 7 - Learning Loop And Product Intelligence

Purpose: make recommendations respond to learner behavior immediately.

Workstreams:

- Close the host session feedback loop for CFA quizzes, Today sessions, Review
  Inbox actions, and Quant labs.
- Collapse host/backend planners into one learner-facing plan with explicit
  degraded-mode behavior.
- Keep host planning as a local fallback rather than a competing primary plan.
- Make blind review first-class outside LSAT for CFA mocks, topic drills, and
  selected Quant reps.
- Fix or replace host ability snapshot persistence.
- Expose "why this task" recommendation evidence chips.
- Bring Quant/Excel outcomes into adaptive parity with CFA and LSAT.
- Feed generated CFA materials into review only after provenance/trust checks.
- Add prerequisite graph and mastery propagation across domains.

Verification gates:

- Completing, skipping, or reopening a CFA/Quant/LSAT task updates the unified
  plan, due queue, adaptivity, and weakness analytics immediately.
- Host blind-review attempt stores timed answer and blind-review answer, then
  appears in blind-review gap analytics.
- Sidecar killed mid-study leaves Today, Review Inbox, and CFA module usable with
  clear degraded status.
- Recommendations change after learner feedback, not only after periodic sync.
- Generated learning objects carry source citation, confidence, review
  eligibility, and mastery linkage.

## Wave 8 - AI, RAG, And Evaluation

Purpose: make AI quality measurable before expanding AI scope.

Workstreams:

- Promote RAG and generation evals into release gates.
  Evidence: `scripts/release_local.py` now runs required
  `rag retrieval-eval floor`, `citation faithfulness floor`,
  `source-grounded answer benchmark floor`, `generated content gate floor`,
  `explanation golden floor`, `prompt regression fixture floor`, and
  `generation quality regression floor` checks before broad pytest/build legs,
  `app.trust` treats those labels as mandatory release evidence, and
  `.github/workflows/release.yml` mirrors the deterministic floors during tag
  verification.
- Version deterministic LLM cache keys with system, schema, format, model, and
  sampling contract.
  Evidence: backend + host cache key contract is now v2 and hashes provider,
  model, system, canonical format/schema, temperature, top_p, seed, and prompt;
  focused backend/Vitest parity tests prove different system/format/schema
  contracts do not collide while equivalent schema key order canonicalizes.
- Add answer faithfulness, citation entailment, local model drift, and generated
  content quality floors.
  Evidence: deterministic host CLIs now exercise the RAG-4 verifier and shared
  content gate offline: supported cited claims must pass, unsupported cited
  claims must fail, malformed answer keys are quarantined, and ungrounded
  generated content cannot enter the accepted batch. The host RAG path now also
  treats invalid citation markers and no-marker answers as ungrounded, and the
  CFA question generator preserves bad model answer indexes until the shared
  content gate quarantines them instead of clamping them to option 0.
- Add prompt regression fixtures for explanation, tutor, generation, and review
  workflows.
  Evidence: `tests/prompt-fixtures/prompt-regression.json` now hashes host CFA
  prompt-registry renders, captured host chat request bodies, LSAT explanation
  messages, Socratic hint messages, coach chat messages, LSAT generation
  prompts, and LSAT review/critic prompts. The host gate is
  `node --import ./scripts/register-ts-loader.mjs scripts/prompt-regression-fixture-floor.mjs`;
  the backend gate is `python -m app.prompt_contracts --check`; release-local,
  release trust, CI, and tag verification require or mirror the
  `prompt regression fixture floor` label. `app.eval.run_release_floor()` also
  runs the seeded LSAT explanation golden set with injected explainer/judge
  fakes, proving golden pass rate and mean overall thresholds without touching a
  local model through `python -m app.eval --release-floor --check --seed`.
- Add local benchmark corpus for CFA/LSAT source-grounded answers.
  Evidence: `tests/rag-fixtures/source-grounded-answers.json` now carries
  synthetic CFA and LSAT cited-answer cases plus an unsupported cross-domain
  rejection case; `scripts/source-grounded-answer-eval.mjs` verifies every cited
  claim offline through the RAG-4 citation verifier and is required by
  release-local, release trust, CI, and tag verification.
- Add provider capability negotiation and degradation matrix.
  Evidence: `llm.provider_info()` now exposes provider capabilities for
  Ollama, LM Studio, and Anthropic; `offline_generate` negotiates unsupported
  knobs before provider invocation and cache keying, so Anthropic seed is
  omitted and cannot make a warm cloud call cacheable, and unsupported format
  strings are omitted consistently.
- Make AI routes log provider and egress class without prompt content.
  Evidence: the shared `time_llm_call` seam now logs provider, model,
  egress_class (`local_loopback` / `cloud_provider` / `unknown`), success, and
  latency with `prompt_logged=false`; cloud selection logs keep the same
  no-prompt contract.
- Add generated-content quarantine until checks pass.

Verification gates:

- Same prompt with different system/schema/format cannot collide in cache.
- Release trust includes retrieval recall, nDCG, explanation golden pass rate,
  prompt-regression fixtures, and generation-quality regression floors.
  **Done for deterministic floors:** release-local and tag verification now
  require RAG retrieval, citation faithfulness, generated-content quarantine,
  source-grounded CFA/LSAT answer grounding, explanation golden pass rate, and
  prompt-regression fixture hashes, and generation-quality regression evidence.
- RAG citation checks prove answer spans are grounded in retrieved source chunks.
- Packaged profile cannot egress for AI unless explicit opt-in is enabled.
- Generated content that fails provenance or quality checks cannot enter review.

## Wave 9 - Frontend UX, Accessibility, And Design System

Purpose: make StudyVault feel like one polished tool across domains.

Workstreams:

- Harden LSAT mobile shell accessibility to match host focus behavior.
  **Done for mobile drawer first floor:** SharedLayout and the host shell share
  visible-target focus handoff, Escape close, focus return, and production
  mobile screenshots via `npm run mobile-nav:probe`.
- De-risk `UNSAFE_*` React Router rebasing with contract tests.
- Finish design-system convergence between host UI, LSAT UI, and primitives.
- Unify command/search across CFA chunks, LSAT questions/passages, notes,
  generated explanations, review history, and hidden test-mode routes.
- Expand visual/a11y coverage for LSAT take, blind review, popout, notebook, and
  analytics routes.
- Add route-level bundle budgets for `/`, `/cfa`, `/lsat`, and exam routes.
  **Done for asset trend floor:** `npm run bundle:report` now enforces the
  fixed caps plus `tests/bundle-baseline.json`, fails tracked asset gzip growth
  over 5% or 10,240 bytes, blocks new tracked assets over 10,240 gzip bytes,
  and writes `dist/reports/bundle-report.md`.
  Route-attributed bundle accounting remains a deeper follow-on.
- Confirm ML/ONNX assets do not enter precache unless intentionally enabled.
- Continue JS-to-TS and broad-`any` ratchets for high-fan-in libraries first.

Verification gates:

- Mobile nav supports open, first focus, Escape close, and focus return.
  **Done for host + LSAT drawers:** focused SharedLayout regression plus
  `npm run mobile-nav:probe` verify `/today` and `/lsat/srs` against the
  production build at 390x844, including settled screenshots.
- Keyboard-flow first floor is automated.
  **Done for sampled host + LSAT flows:** `npm run a11y:keyboard` verifies
  skip-link focus/landing, visible focus indicators across sampled tab stops,
  mobile drawer focus/restore, and LSAT timed-section shortcuts against forced
  offline sample data.
  **Done for shared runner primitive:** CFA quiz/vignette/mock and LSAT
  `ChoiceList` now share `AccessibleChoiceGroup` for radiogroup semantics and
  roving tabindex, with focused host/LSAT tests. Remaining work is broader
  per-route focus-order/trap coverage.
- Axe semantic first floor and the scoped LSAT contrast sweep are clean.
  **Done for LSAT semantics:** `npm run lsat:a11y:semantic` verifies `/lsat`,
  `/lsat/preptests`, `/lsat/rc-lab`, `/lsat/srs`, `/lsat/analytics`, and
  `/lsat/bank` on desktop/mobile for `button-name`, `aria-progressbar-name`,
  `listitem`, `aria-prohibited-attr`, and `nested-interactive`; the scoped
  `INCLUDE_LSAT_ROUTES=1 LSAT_ROUTES_ONLY=1 npm run a11y:check` gate passes the
  LSAT route sweep in dark/light themes plus focused contrast and OS preference
  probes. Remaining accessibility work is broader route focus order/traps,
  composite runner keyboard drivability, and manual Windows HCM validation.
- `/lsat`, dynamic routes, query/hash, back/forward, and cross-domain navigation
  survive router upgrades.
- Visual regression fails closed when baselines are missing.
  **Done for baseline policy:** `scripts/visual-regression.mjs` preflights
  required baselines through `evaluateVisualBaselinePolicy`, writes the blocking
  reason to `dist/reports/visual-regression.json`, and no longer bootstraps
  missing shots in normal runs.
- Cmd/Ctrl+K works consistently in host and LSAT with keyboard and screen-reader
  tests.
- Bundle budgets report per route, not only per asset.
  **Partial evidence:** per-asset trend deltas now exist with an intentional
  `npm run bundle:baseline` refresh path; true route-attributed bundle ownership
  is still open.
- Baseline and golden refresh paths are explicit.
  **Done for catalog floor:** `tests/baseline-catalog.json` now inventories the
  CI/release baselines, `docs/TESTING-BASELINES.md` is generated from it, and
  `npm run check:baselines` fails catalog/doc drift in CI and release-local
  trust.
- Critical mutation testing exists before full Stryker/mutmut rollout.
  **Done for first floor:** `npm run mutation:host` mutates the four named host
  pure modules and killed 7/7 curated mutants; `npm run mutation:backend`
  mutates LSAT scoring/validator fail-closed logic and killed 5/5 curated
  mutants. Both write `dist/reports/mutation-*.json`, run in nightly/manual
  mutation workflow, and are release-local trust labels.

## Wave 10 - Performance, Observability, And Diagnostics

Purpose: make reliability and speed visible, durable, and exportable.

Workstreams:

- Add runtime route budgets for LCP, CLS, INP, route TBT, sidecar boot, and key
  endpoint latency.
  **Done for route-load floor:** `scripts/route-performance-budget.mjs`
  measures cold/warm route-ready time, FCP, LCP, CLS, TBT, max long task, and
  report-only INP across desktop/mobile for `/`, `/cfa`, CFA exam/practice
  routes, and stable `/lsat` routes. It compares against
  `tests/performance-baseline.json`, writes `dist/reports/perf-regression.json`,
  runs in CI, and is required by release-local trust. Sidecar boot and endpoint
  latency budgets remain separate Wave 10 work.
- Add 10k-question backend latency and memory benchmarks.
- Add EXPLAIN/index assertions for bank browse, analytics, and similar-question
  search.
- Persist SLO evidence, not just in-memory counters.
- Add privacy-safe desktop diagnostics/support bundle.
- Export crash logs, Tauri logs, sidecar tails, backend diagnostics, trust
  manifest, backup age, and redacted health status.
- Add synthetic failure fixtures for diagnostics.

Verification gates:

- CI publishes cold/warm route performance JSON and fails on regressions beyond
  agreed tolerance.
  Evidence: `.github/workflows/ci.yml` uploads `reports-perf` with
  `dist/reports/perf-regression.json`; the conservative first-floor baseline can
  be ratcheted with `UPDATE_PERF_BASELINES=1` after stable CI data.
- 10k-question fixture meets p95 budgets for browse, analytics, and search.
- Diagnostic export contains readiness, sqlite health, trust status, recent
  metric samples, backup age, and redacted logs.
- Redaction tests prove no key material, official content payload, prompt text,
  or private sentinel leaks into the support bundle.

## Wave 11 - Content And Data Quality

Purpose: make source-grounded learning material trustworthy.

Workstreams:

- Reconcile CFA LOS coverage against available source packs.
- Add formula/table mining and structured extraction quality checks.
- Track content provenance, licensing eligibility, and training/review eligibility.
- Add duplicate and near-duplicate detection for questions, cards, and generated
  explanations.
- Calibrate difficulty and discrimination from local performance.
- Add generated-content quarantine and promotion workflow.
- Add import reports that separate official, user-provided, generated, and
  training-eligible material.

Verification gates:

- Every reviewable generated object has source, confidence, provenance, and
  eligibility state.
- Duplicate/near-duplicate checks run before promotion.
- CFA coverage reports identify LOS gaps and unsupported generated claims.
- Official/training-eligible conflicts are rejected.

## Recommended Execution Sequence

Do not start with the flashiest AI or UI work. Start with the work that reduces
future regression cost.

1. Wave 0: lock product invariants.
2. Wave 1: remove architectural drift and define fitness gates.
3. Wave 2: make contracts generated, typed, and enforceable.
4. Wave 3: close local-first security and privacy gaps.
5. Wave 4: make releases reproducible and smoke-tested.
6. Wave 5: harden native sidecar behavior.
7. Wave 6: prove backup, restore, migration, and vault integrity.
8. Wave 7: close the learning-loop feedback gap.
9. Wave 8: expand AI only after eval gates exist.
10. Wave 9: polish UX and design-system consistency under test.
11. Wave 10: add durable performance and diagnostics evidence.
12. Wave 11: raise content quality and provenance.

## First 30 Days

The first month should produce gates and decisions, not a pile of disconnected
features.

Week 1:

- Write decision records for SurrealDB required/optional behavior, encryption
  default, egress policy, supported release platforms, and planner authority.
- Add `verify:all` design and decide whether it becomes developer-default or CI-only.
- Add the route/contract inventory for direct sidecar fetches and untyped routes.

Week 2:

- Break the lowest-risk circular imports.
- Add route manifest/render parity tests.
- Start OpenAPI response-model coverage for host-used routes.
- Define the local API token handshake design.

Week 3:

- Add contract drift gate for regenerated API artifacts.
- Define backup/encryption migration plan and sentinel tests.
- Draft release provenance manifest format.
- Define packaged-app smoke requirements.

Week 4:

- Wire first release-trust dry run without publishing.
- Add first live cross-domain e2e gate candidate.
- Produce initial large-vault restore fixture design.
- Publish the next execution board from this roadmap.

## Cross-Cutting Gates

These gates should become non-negotiable once introduced:

- No circular imports.
- No untyped production sidecar fetches.
- No route without response-shape contract for host-used APIs.
- No release without PR-quality checks or equivalent reusable workflows.
- No packaged release without sidecar provenance and packaged smoke.
- No private data in service-worker cache, support bundles, or plaintext backup.
- No generated learning content in review without provenance and quality state.
- No storage cutover without export/wipe/import/restore proof.
- No AI expansion without eval floors and cache-key correctness.

## Related Existing Documents

- [Stack-Wide Upgrade Roadmap 2026 H2](STACK-UPGRADE-ROADMAP-2026-H2.md)
- [StudyVault Upgrade Roadmap](STUDYVAULT-UPGRADE-ROADMAP.md)
- [Fullstack Audit 2026-06](FULLSTACK-AUDIT-2026-06.md)
- [Architecture](ARCHITECTURE.md)
- [Roadmap](ROADMAP.md)
- [LSAT Integration](LSAT-INTEGRATION.md)
- [Content Expansion](CONTENT-EXPANSION.md)
- [Content Licensing](CONTENT-LICENSING.md)
- [Packaging](PACKAGING.md)
- [SurrealDB Migration](SURREALDB-MIGRATION.md)
