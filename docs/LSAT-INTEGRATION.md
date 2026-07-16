# LSAT domain — integration guide

How LSAT Lab is vendored into StudyVault as the `/lsat` domain. For the overall
picture see [ARCHITECTURE.md](ARCHITECTURE.md); for the original step-by-step
merge see [LSAT-LAB-MERGE-PLAN.md](LSAT-LAB-MERGE-PLAN.md).

## What was vendored

- **Frontend** → `src/domains/lsat/` — the complete LSAT Lab SPA (App, AppShell,
  command palette, ~30 routes, providers), with its original `@/` alias rewritten
  to `@lsat/` so it never collides with the host's `@/` → `/src`.
- **Backend** → `services/lsat-backend/` — the FastAPI + SQLite app (committed),
  with `sidecar_main.py` (PyInstaller entry) + `lsatlab.spec`.
- **Design docs** → `docs/lsat/` — LSAT Lab's own design system / roadmap notes,
  kept as **reference** (not the source of truth for StudyVault decisions; this
  file + ARCHITECTURE.md are).

## How it builds + type-checks alongside the host

| Concern           | Mechanism                                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module resolution | `vite.config.js` alias `@lsat` → `/src/domains/lsat` (most-specific first, before `@` → `/src`)                                                                |
| Host strict tsc   | `tsconfig.json` **excludes** `src/domains/lsat`; an ambient shim (`src/lsat-domain.d.ts`) declares `@lsat/*` so host code that references it still type-checks |
| LSAT types        | `tsconfig.lsat.json` type-checks the subtree on its own (strict, TS 6) — clean; run `npm run typecheck:lsat`                                                   |
| Tests             | vitest `lsat` **project** in `vite.config.js` (own setup file, 25s timeout); `npm run test:lsat`                                                               |
| Lint              | the subtree is excluded from the host flat config (vendored, different toolchain conventions; tests + strict types are its safety net)                         |

There is **no separate `node_modules`** for the subtree — its dependencies were
merged into the host `package.json`, so it runs on the host's hoisted toolchain
(React 19 / vitest 4 / TS 6), newer than its original React 18 era.

## How it mounts at runtime

`src/main.jsx` → `src/domains/lsat/LsatRoot.tsx` when the URL is under `/lsat`.
`LsatRoot` wraps the LSAT `App` in its providers (`QueryClient`, theme/mode/
motion, tooltip) and its own `BrowserRouter basename="/lsat"`. See
[ARCHITECTURE.md](ARCHITECTURE.md) §2 for why domain switches reload today and
the soft-nav branch.

## The backend sidecar

`services/lsat-backend` is frozen by `scripts/build-lsat-binary.mjs` (isolated
`.venv-lsat`, the backend's own `lsatlab.spec`) into
`electron/resources/services/lsat-backend/lsatlab-backend(.exe)`. The Electron
supervisor launches it on `127.0.0.1:8100`; it binds loopback-only unless
`LSATLAB_ALLOW_REMOTE_API=1`. Data lives in `%APPDATA%/LSATLab` (override:
`LSATLAB_DATA_DIR`) — reused from any prior standalone LSAT Lab install.

Local API token contract: the backend accepts optional `LSATLAB_LOCAL_API_TOKEN`.
If unset, current calls keep working. If set, every non-health `/api/*` request
must include `Authorization: Bearer <token>`; `X-LSATLAB-API-Token` is accepted
as a local fallback. `GET /api/health` and CORS `OPTIONS` preflight stay
unauthenticated for readiness. The packaged Electron supervisor generates a
high-entropy token per run and passes it to the sidecar via env. The token never
enters renderer JavaScript; the Electron session injects it only for requests to
the exact `http://127.0.0.1:8100` origin.
The shared frontend transport (`src/lib/lsatSidecarClient.ts`) retains an
explicit development-token path for browser-only runs.
`VITE_LSATLAB_LOCAL_API_TOKEN` remains reserved for local development only; the
token is never persisted.

Local SQLite field encryption: the packaged supervisor also owns a separate
OS-keychain credential, `studyvault/lsat-db-dek`, and passes it only to the LSAT
sidecar as `LSATLAB_DB_KEY_B64`. With that key present, selected non-FTS
local-only text fields are AES-GCM envelopes at rest while API reads still return
plaintext: rationale text/Blind Review notes, tutor turns, error-log
note/diagnosis, and deterministic LLM cache responses. The key is not exposed to
the webview keychain commands and is redacted from sidecar logs/status.

Key endpoints the host uses: `GET /api/health →
{ok:true,service:"lsat-backend",version:"..."}` for liveness and sidecar
identity, and `GET /api/ai/health` for provider + effective model routing +
missing models. The Electron supervisor treats the LSAT sidecar as verified only
when the health probe returns a 2xx response with `service:"lsat-backend"`;
legacy `{"ok":true}` responses are still "listening" but unverified.
Both endpoints are surfaced read-only on the host's **System Health** page.

## Cross-domain seams (host ↔ LSAT)

- `src/lib/lsatBackend.ts` — host client for the sidecar's health + model routing
  (System Health card + a deep-link to `/lsat/settings`).
- `src/lib/lsatReviewBridge.ts` — the host Review Inbox pulls LSAT due cards
  (`/api/srs/due`), degrading on timeout.
- Theme bridge in `main.jsx` (host `qv-theme` → LSAT `lsatlab-theme`).
- Shared fonts via `src/styles/unified-palette.css` (ARCHITECTURE.md §3).

## Reference: vendored LSAT design docs

`docs/lsat/` holds LSAT Lab's original design-system and feature notes. They
describe the LSAT app's _internal_ conventions and remain accurate for the
vendored subtree, but StudyVault-level architecture/decisions live in
[ARCHITECTURE.md](ARCHITECTURE.md) and this file — consult `docs/lsat/` only for
LSAT-internal detail.
