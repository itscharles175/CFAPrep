# Testing & type-checking

StudyVault is one repo with two TypeScript projects, a Python backend, and a
Rust supervisor. Run the gate below before committing.

## Frontend (host + vendored LSAT subtree)

The host app (`src/`, React 19) and the vendored LSAT domain
(`src/domains/lsat/`) are **two TypeScript projects** that share one
`node_modules` and one Vite build:

| Project | Config | Scope | Command |
|---|---|---|---|
| Host | `tsconfig.json` | `src/` (excludes `src/domains/lsat` as root files) | `npx tsc --noEmit` |
| LSAT subtree | `tsconfig.lsat.json` | `src/domains/lsat/` | `npx tsc -p tsconfig.lsat.json` |

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
npx eslint .          # 0 errors (a few pre-existing react-refresh warnings in main.jsx are accepted)
npx vitest run        # unit + component tests (jsdom)
npx vite build        # production bundle + PWA precache
```

## LSAT backend (FastAPI / SQLite sidecar)

From `services/lsat-backend`:

```sh
../../.venv-lsat/Scripts/python.exe -m pytest -q -p no:cacheprovider \
  --timeout=120 --timeout-method=thread -k "not live_ollama"
```

Tests use per-PID SQLite isolation, so parallel runs are safe. `-k "not
live_ollama"` skips the tests that require a running local LLM.

### OpenAPI contract

After adding/removing/altering a backend route, regenerate the committed
baseline so the schema-snapshot drift gate passes:

```sh
node scripts/export-lsat-openapi.mjs --write   # writes services/lsat-backend/openapi-baseline.json
```

## Tauri supervisor (Rust)

From `src-tauri`:

```sh
cargo check          # type-check the supervisor
cargo test --lib     # supervisor unit tests
```

## Full gate (what CI / a pre-commit pass should be green on)

1. `npx tsc --noEmit` (host)
2. `npx tsc -p tsconfig.lsat.json` (LSAT subtree)
3. `npx eslint .`
4. `npx vitest run`
5. `npx vite build`
6. backend `pytest` (above)
7. `cargo check` (when `src-tauri/` changed)
8. OpenAPI baseline regenerated (when backend routes changed)
