# Testing & type-checking

StudyVault is one repo with two TypeScript projects, a Python backend, and an
Electron main process. Run the gate below before committing.

## Frontend (host + vendored LSAT subtree)

The host app (`src/`, React 19) and the vendored LSAT domain
(`src/domains/lsat/`) are **two TypeScript projects** that share one
`node_modules` and one Vite build:

| Project      | Config               | Scope                                              | Command                         |
| ------------ | -------------------- | -------------------------------------------------- | ------------------------------- |
| Host         | `tsconfig.json`      | `src/` (excludes `src/domains/lsat` as root files) | `npx tsc --noEmit`              |
| LSAT subtree | `tsconfig.lsat.json` | `src/domains/lsat/`                                | `npx tsc -p tsconfig.lsat.json` |

Both are `strict: true`.

### `@lsat/*` cross-domain imports (QA-4)

The LSAT subtree imports its own modules via the `@lsat/*` alias (mirrored by
Vite's `resolve.alias`). The host **`tsconfig.json` maps `@lsat/*` to
`src/domains/lsat/*`**, so when host code (or a host-imported subtree file)
references `@lsat/...`, it resolves to the **real subtree types** and is
type-checked end-to-end.

This replaced the former `declare module '@lsat/*'` ambient shim in
`src/lsat-domain.d.ts`, which resolved every cross-domain import to `any`. That
file is now documentation only — there is no blanket `any` boundary.

A formal TS **`references`** entry (project references via `tsc -b`) is
intentionally **not** used: it requires the referenced project to be
`composite: true` and to emit declarations, which conflicts with this repo's
no-emit / Bundler (Vite) toolchain (`noEmit: true`, `moduleResolution:
"Bundler"`). Because both `tsconfig.json` and `tsconfig.lsat.json` are `strict`,
"the subtree is host-strict-clean" and "`tsc -p tsconfig.lsat.json` is clean"
are equivalent — `tsconfig.lsat.json` remains the subtree's dedicated validator.

### Lint, unit tests, build

```sh
npm run doctor       # local toolchain/manifests/sidecar provenance/ports report
npm run doctor -- --all # doctor plus version/OpenAPI/no-egress/docs/baseline gates
npm run check:versions # package.json, optional .env, backend APP_VERSION
npx eslint .          # 0 errors (a few pre-existing react-refresh warnings in main.jsx are accepted)
npx vitest run        # unit + component tests (jsdom)
npm run test:ci -- --coverage # host coverage floor + JUnit/JSON-summary artifacts
npx vitest run --project host src/swPrivacy.test.js  # service-worker private-cache denylist
npx vite build        # production bundle + PWA precache
```

The TEST-5 host coverage ratchet is enforced through `vite.config.js` with V8
coverage over the host surface (`src/**`, excluding tests, generated clients,
data packs, the LSAT subtree, and bootstrap shims). Current floors are 48%
statements, 37% branches, 49% functions, and 50% lines; CI writes
`dist/reports/coverage/coverage-summary.json`.

`npm run doctor` writes `dist/reports/stack-doctor.json` using the DX-3
read-only stack doctor. Default mode verifies local Node/npm/npx/Python tools and
a non-blocking `electron-builder` probe, required manifests/lockfiles, staged
sidecar provenance hashes, and expected loopback ports. No part of the build
needs a Rust toolchain any more; the `cargo`/`rustc` probes went away with the
Tauri shell. `npm run doctor -- --all` additionally runs the fast static
gates: version sync, OpenAPI drift, no-egress, direct sidecar fetch inventory,
docs drift, baseline catalog, and the vault archive restore drill.

### Visual and accessibility verification

The Playwright-based visual gates run against the production `dist/` bundle and
start their own Vite preview servers. Run them after UI changes, design-token
changes, route-manifest changes, or PWA/offline changes:

```sh
npm run build
npm run browser:regression
npm run perf:regression
npm run mobile-nav:probe
npm run a11y:keyboard
npm run lsat:a11y:semantic
npm run visual:regression
npm run a11y:check
```

`visual:regression` captures the curated host routes in light/dark themes at
desktop and mobile sizes, then compares them with the required
`tests/visual-baselines/` files. The baseline directory is gitignored because screenshots
are environment-sensitive, but the gate now fails closed when any required
route/theme/viewport baseline is missing. To seed or accept an intentional visual
change, rerun with `UPDATE_VISUAL_BASELINES=1` after reviewing the generated
frames.

`a11y:check` runs the axe WCAG A/AA sweep, the focused AA color-contrast
matrix, and the A11Y-4 OS preference probes. The preference pass emulates
`prefers-contrast: more` and `forced-colors: active` on the richest host/LSAT
surfaces, then asserts real outline-based focus, system-color surfaces, visible
chart marks, and no visible interactive `forced-color-adjust:none`. Both gates
resolve an installed Chrome/Edge first; if none is available, install
Playwright's Chromium once:

```sh
npx playwright install chromium
```

`mobile-nav:probe` is the focused keyboard/focus first floor for the shared
mobile drawer. It runs against the production build at 390x844, opens the drawer
on `/today` and `/lsat/srs`, asserts focus enters the visible sidebar, presses
Escape, asserts focus returns to the menu button, and writes
`dist/reports/mobile-nav-focus.json` plus settled screenshots under
`dist/reports/mobile-nav/`.

`a11y:keyboard` is the broader keyboard-flow first floor. It runs against the
production build, verifies skip-link focus/landing on `/today` and `/lsat/srs`,
checks visible focus indicators across sampled host and LSAT tab stops, repeats
the shared mobile drawer focus/restore flow, and exercises LSAT timed-section
keyboard shortcuts against forced offline sample data. It writes
`dist/reports/keyboard-flow.json` plus mobile drawer screenshots under
`dist/reports/keyboard-flow/`.

The shared question-runner primitive is covered at the component layer. After
changing answer-choice UI, roving tabindex, choice shortcuts, CFA runners, or the
LSAT `ChoiceList` adapter, run:

```sh
npx vitest run --project host src/components/a11y/AccessibleChoiceGroup.test.tsx src/components/a11y/AccessibleQuestionRunner.test.tsx
npx vitest run --project lsat src/domains/lsat/components/question/choice-list.test.tsx src/domains/lsat/test/a11y-bundle-f1.test.tsx
npm run typecheck:lsat
```

The hands-free first floor adds read-aloud plus spoken answer selection to the
CFA/LSAT runners while keeping timed/test-mode flows confirmation-gated. After
changing TTS/STT, hands-free controls, CFA quiz/vignette/mock runners, or the
LSAT section runner adapter, run:

```sh
npx vitest run --project host src/components/a11y/AccessibleQuestionRunner.test.tsx src/lib/handsFree.test.ts src/lib/voice.test.js
npx vitest run --project lsat src/domains/lsat/components/question/section-runner.hands-free.test.ts src/domains/lsat/components/question/choice-list.test.tsx
npm run typecheck:lsat
```

`lsat:a11y:semantic` is the focused first-floor semantic axe probe for the LSAT
route surface. It runs against the production build on desktop and mobile for
`/lsat`, `/lsat/preptests`, `/lsat/rc-lab`, `/lsat/srs`,
`/lsat/analytics`, and `/lsat/bank`, checking `button-name`,
`aria-progressbar-name`, `listitem`, `aria-prohibited-attr`, and
`nested-interactive`. It writes `dist/reports/lsat-semantic-a11y.json`.

For the LSAT route surface, use the same built `dist/` and scope both gates with
the CI flags:

```sh
INCLUDE_LSAT_ROUTES=1 LSAT_ROUTES_ONLY=1 npm run visual:regression
INCLUDE_LSAT_ROUTES=1 LSAT_ROUTES_ONLY=1 npm run a11y:check
```

The scoped LSAT `a11y:check` gate must pass the desktop/mobile route sweep in
dark and light themes, the focused analytics, bank, and settings contrast
probes, and the LSAT OS preference probes for bank and analytics surfaces.

Reports are written to `dist/reports/visual/`,
`dist/reports/visual-regression.json`, `dist/reports/perf-regression.json`,
`dist/reports/keyboard-flow.json`,
`dist/reports/lsat-semantic-a11y.json`, and
`dist/reports/a11y-check.json`.

`perf:regression` runs against the production preview and measures cold + warm
navigations for `/`, `/cfa`, representative CFA exam/practice routes, and stable
`/lsat` routes across desktop and mobile viewports. It compares required
navigation/FCP/LCP/CLS/TBT metrics with `tests/performance-baseline.json`;
`UPDATE_PERF_BASELINES=1` rewrites that baseline after an intentional,
reviewed performance-budget change. INP is recorded when Chromium emits it and
can be made required with `REQUIRE_INP_PERF=1`.

`bundle:report` enforces fixed per-asset caps and the committed trend baseline
in `tests/bundle-baseline.json`. It writes `dist/reports/bundle-report.json`
and a human-readable `dist/reports/bundle-report.md`; any tracked asset whose
gzip size grows more than 5% or more than 10,240 bytes over baseline fails the
gate, and new tracked assets over 10,240 gzip bytes are blocked until reviewed.
After an intentional bundle change, run `npm run bundle:baseline` once after
`npm run build`, review the delta, and commit the updated baseline.

`check:baselines` validates `tests/baseline-catalog.json` and the generated
`docs/TESTING-BASELINES.md` catalog so every CI/release baseline has an owner,
storage policy, verification command, refresh command, and review rule. After
editing the catalog, run `npm run baseline:catalog` and commit the regenerated
doc with the catalog change.

`mutation:host` and `mutation:backend` run the TEST-9 first-floor mutation gate.
The gate applies curated critical mutants to the highest-risk pure host modules
(`fsrsOptimizer`, `itemPsychometrics`, `financeMath`, `examReadiness`) and LSAT
backend modules (`scoring.py`, `gen_validators.py`), runs the scoped tests, and
restores the exact source text after each mutant. Both scopes require 100% of
the curated mutants to be killed and write `dist/reports/mutation-host.json`,
`dist/reports/mutation-backend.json`, and matching Markdown reports. The broader
Stryker/mutmut sweep remains nightly expansion work after this first floor.

### Storage driver ID safety

The DATA-4 SurrealDB record-id gate protects against lossy `sanitiseId`
collisions in chunks, review items, mastery snapshots, settings, and generic
keyed tables:

```sh
npx vitest run --project host \
  src/lib/storage/chunkSearch.test.ts \
  src/lib/storage/surrealDriver.test.ts \
  src/lib/storage/schema.test.ts \
  src/lib/storage/driverConformance.test.ts \
  src/lib/storage/storage.test.ts
```

After changing migration, export/import, or cross-domain sync identity paths,
also run:

```sh
npx vitest run --project host \
  src/lib/storage/migrate.test.ts \
  src/lib/storage/integrity.test.ts \
  src/lib/storage/schemaMigration.test.ts \
  src/lib/storage/vaultArchive.test.ts \
  src/lib/dataDictionary.test.ts \
  src/lib/progressStore.test.ts \
  src/lib/progressStore.merge.property.test.ts \
  src/hooks/useSyncProgress.test.ts \
  src/hooks/useSyncFsrsWriteBack.test.ts
```

### AI reasoning-trace safety

The AI-8 gate protects local model output from leaking reasoning traces into UI,
speech, caches, streamed tokens, or generated content artifacts. After changing
host LLM, TTS, RAG, vision, Socratic, structured-output, or content-expansion
paths, run:

```sh
npx vitest run --project host \
  src/lib/stripThink.test.js \
  src/lib/localLlm.test.js \
  src/lib/voice.test.js \
  src/lib/socraticLoop.test.ts \
  src/lib/localRag.test.ts \
  src/lib/llm/structured.test.js \
  src/lib/visionAdapter.test.ts

node scripts/content-expand.mjs --help
```

Backend reasoning-trace parity is covered by:

```sh
.venv-lsat/Scripts/python.exe -m pytest \
  services/lsat-backend/tests/test_ai_explain.py \
  services/lsat-backend/tests/test_notebook_os_expansion.py \
  -q
```

### LSAT exam timer resilience

The GAP-CLOCK-1 gate keeps timed sections anchored to an absolute wall-clock
deadline rather than a decrementing interval, so background throttling, sleep,
visibility changes, and crash/reload resume cannot silently extend an exam.

```sh
npx vitest run --project lsat \
  src/domains/lsat/components/question/section-clock.test.ts \
  src/domains/lsat/lib/sessionDraft.test.ts

npm run typecheck:lsat
```

### Offline / no-egress invariant

The AI-10/GAP-EGRESS-1 gate keeps StudyVault local-first by default. It blocks
cloud LLM selection unless the strict offline fence is explicitly disabled and
cloud egress is separately admitted. It also keeps Ollama/LM Studio URLs
loopback-only unless strict offline is disabled and remote local-model traffic is
explicitly admitted. The static scan fails on shipped-source non-loopback network
endpoints outside the documented allowlist.

```sh
npm run check:no-egress
npm run check:sidecar-fetches

npx vitest run --project host \
  src/lib/localUrlPolicy.test.js \
  src/lib/lsatSidecarClient.test.ts \
  src/lib/localLlm.test.js \
  src/lib/visionAdapter.test.ts \
  src/lib/openNotebook.test.ts \
  src/lib/rag/embedder.test.ts \
  src/lib/lsatBackend.test.ts \
  scripts/check-no-egress.test.mjs

.venv-lsat/Scripts/python.exe -m pytest \
  services/lsat-backend/tests/test_offline_fence.py \
  services/lsat-backend/tests/test_llm.py \
  services/lsat-backend/tests/test_cloud_budget.py \
  -q
```

### Recurring scheduler tick

The BACK-4 gate proves the durable worker now polls due `ScheduledTask` rows on
idle passes without starving queued generation jobs. It also pins the
`LSATLAB_SCHEDULER_TICK_SECONDS` env behavior, scheduler-run evidence writes,
disabled interval behavior, and exception isolation.

```sh
.venv-lsat/Scripts/python.exe -m pytest \
  services/lsat-backend/tests/test_scheduler_tick.py \
  services/lsat-backend/tests/test_tutor_os_trust.py::test_scheduled_defaults_and_benchmark_recording \
  services/lsat-backend/tests/test_tutor_os_trust.py::test_unknown_scheduled_task_type_is_rejected \
  services/lsat-backend/tests/test_tutor_os_trust.py::test_unknown_existing_scheduled_task_type_fails_closed \
  services/lsat-backend/tests/test_backend_perf.py::test_db_maintenance_task_runs_through_scheduler \
  services/lsat-backend/tests/test_backend_perf.py::test_db_maintenance_task_type_supported \
  -q
```

## LSAT backend (FastAPI / SQLite sidecar)

From `services/lsat-backend`:

```sh
../../.venv-lsat/Scripts/python.exe -m pytest -q -p no:cacheprovider \
  --strict-config --durations=25 \
  --cov=app --cov-report=term-missing --cov-fail-under=85
```

Tests use per-PID SQLite isolation. CI runs the suite serially with live model
URLs pinned to closed loopback ports, so `test_live_ollama.py` self-skips when no
local Ollama server is reachable. The current TEST-1 backend coverage ratchet is
85%; CI also writes `dist/reports/lsat-backend-coverage.json` and `.xml`.

### OpenAPI contract

After adding/removing/altering a backend route, regenerate the committed
baseline so the schema-snapshot drift gate passes:

```sh
node scripts/export-lsat-openapi.mjs --write   # writes services/lsat-backend/openapi-baseline.json
```

## Electron Runtime

```sh
npm run test:electron
npm run electron:build:dir
```

The Electron tests are **not** vitest: `vite.config.js` excludes `electron/**`
from the `host` project, so `vitest --project host electron` silently matches
zero files. `npm run test:electron` runs `node --test` over
`electron/tests/**/*.test.mjs`. Budget ~1 minute — several watchdog cases wait on
real child processes (the reap case alone budgets 45s).

Runtime tests cover the custom protocol, IPC contracts, file grants, secure
storage and the one-time Tauri credential import, navigation policy, sidecar
provenance, the relocation guard, boot port sweep, bounded port retry, status
aggregation, LSAT request-header injection, and the degraded-boot path when the
crash-safe watchdog is unavailable.

One supervisor behaviour the retired Tauri Rust suite covered is **not** covered
here: reaping sidecars after an abrupt main-process death. The watchdog cases
exercise the graceful `close()` path and the Windows snapshot-degradation path,
but nothing kills the parent and asserts the 1500 ms probe reaps the tree. Also
unpinned: `detached: false` on win32 in `electron/sidecar-manager.js`, which is
what makes crash-guard degradation survivable on Windows. After changing
`electron/sidecar-manager.js`, `electron/watchdog.js`, or
`electron/child-watchdog.cjs`, verify a packaged run by hand — kill the app
abruptly and confirm no `lsatlab-backend` process survives. See
[docs/decisions/2026-07-23-electron-desktop-runtime.md](docs/decisions/2026-07-23-electron-desktop-runtime.md).

## Sidecar provenance

After building packaged sidecars, verify the manifest Electron will bundle:

```sh
npm run build:lsat-binary
npm run check:sidecar-provenance
```

The release workflow runs the same provenance check before `electron-builder`. A
matching manifest lets startup proceed; a present manifest with a changed binary
is refused by the Electron supervisor before launch.

## Local release gate

From the repository root, run the machine-readable release gate before tagging
or packaging:

```sh
python scripts/release_local.py --timeout 3600
```

It writes `dist/release_local_report.json`, `dist/release_trust.json`, and
`dist/studyvault-release-manifest.json`. A release-ready run must finish with
`release_trust.status == "ok"` and no blockers; skipped Electron, e2e,
sidecar-build, packaged-smoke, or release-manifest legs block at the release
tier. Release trust also requires the always-on static/eval labels from the
machine-readable report, including content validation, no-egress, direct
sidecar-fetch inventory, docs drift, baseline catalog, dependency audit, the RAG
retrieval-eval floor, citation-faithfulness floor, source-grounded answer
benchmark floor, generated-content gate floor, explanation golden floor,
prompt-regression fixture floor, vault archive restore drill, host/backend
mutation score gates, route performance budget gate, and the generation-quality
regression floor.

The explanation floor is directly runnable from `services/lsat-backend`:

```sh
python -m app.eval --release-floor --check --seed
```

Run it with `LSATLAB_DATA_DIR` pointed at a disposable directory when you do not
want the sample LSAT bank written to the default dev data dir.

The answer-grounding benchmark is also directly runnable from the repo root:

```sh
node --import ./scripts/register-ts-loader.mjs scripts/source-grounded-answer-eval.mjs
```

The prompt-regression floor is split by runtime and uses the shared fixture in
`tests/prompt-fixtures/prompt-regression.json`:

```sh
node --import ./scripts/register-ts-loader.mjs scripts/prompt-regression-fixture-floor.mjs
cd services/lsat-backend && python -m app.prompt_contracts --check
```

## Full gate (what CI / a pre-commit pass should be green on)

1. `npx tsc --noEmit` (host)
2. `npx tsc -p tsconfig.lsat.json` (LSAT subtree)
3. `npx eslint .`
4. `npx vitest run`
5. `npx vite build`
6. `npm run bundle:report`
7. `npm run check:no-egress`
8. backend `pytest` with the 85% coverage floor (above)
9. `npm run test:electron` + `npm run electron:build:dir` when `electron/`,
   `electron-builder.yml`, or the sidecar staging path changes
10. `npm run check:sidecar-provenance` (when packaged sidecars changed)
11. `node --import ./scripts/register-ts-loader.mjs scripts/rag-eval.mjs`
12. `node --import ./scripts/register-ts-loader.mjs scripts/citation-faithfulness-eval.mjs`
13. `node --import ./scripts/register-ts-loader.mjs scripts/source-grounded-answer-eval.mjs`
14. `node --import ./scripts/register-ts-loader.mjs scripts/generated-content-gate-eval.mjs`
15. `node --import ./scripts/register-ts-loader.mjs scripts/prompt-regression-fixture-floor.mjs`
16. backend `python -m app.prompt_contracts --check`
17. `npm run mutation:host`
18. `npm run mutation:backend`
19. `npm run perf:regression`
20. `npm run mobile-nav:probe`
21. `npm run a11y:keyboard`
22. `npm run lsat:a11y:semantic`
23. `npm run vault-archive:drill`
24. `npm run check:baselines`
25. OpenAPI baseline regenerated (when backend routes changed)
