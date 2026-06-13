# Packaging & Signing — Pillar 0 release pipeline

QuantVault ships as a desktop app built by Tauri. This doc covers the full
release flow: local build, code-signing on Windows/macOS/Linux, the GitHub
Actions release workflow, and the sidecar bundling caveat.

## Local builds

```bash
# Dev (auto-reload, supervises the spike/ sidecars):
npm run tauri:dev

# Debug build (faster compile, larger binary, no signing):
npm run tauri:build:debug

# Production build (optimized, signed if signing env vars are present):
npm run tauri:build
```

Output lands in:

- Windows: `src-tauri/target/release/bundle/{msi,nsis}/`
- macOS:   `src-tauri/target/release/bundle/{dmg,macos}/`
- Linux:   `src-tauri/target/release/bundle/{deb,appimage}/`

The verify gate runs first (`npm run lint && npm run test && npm run build`)
so a release can't ship if the web build is broken.

## Signing

### Windows

Set these env vars at build time:

```bash
# SHA-1 thumbprint of the code-signing cert in your local cert store
export TAURI_WINDOWS_CERT_THUMBPRINT="ABCD1234..."

# Optional — only if the cert is in a non-standard store
export TAURI_WINDOWS_CERT_STORE="My"
```

Get the thumbprint via PowerShell:

```powershell
Get-ChildItem -Path Cert:\CurrentUser\My | Select Thumbprint, Subject
```

The signed binary uses SHA-256 with timestamping via DigiCert. Configured in
`src-tauri/tauri.conf.json` (`bundle.windows`).

### macOS

```bash
# Developer ID Application identity (codesign + notarize)
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"

# Notarization credentials (for `xcrun notarytool`)
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="TEAMID"
```

Tauri will codesign the .app, build the .dmg, then submit it to Apple for
notarization. The first notarization on a fresh CI runner can take 10-15
minutes; subsequent ones are usually < 2 minutes.

Set `bundle.macOS.signingIdentity` in `tauri.conf.json` to the identity name
when running outside CI (it overrides the env var).

### Linux

`.deb` and `.appimage` outputs are unsigned by convention. For Debian
packages you can sign the `.deb` with `dpkg-sig --sign builder <file>` after
the Tauri build completes; for AppImage you can append a detached signature
with `gpg --detach-sign`. Both are handled in the release workflow below.

## GitHub Actions release workflow

Pushing a `v*` tag triggers `.github/workflows/release.yml`. The workflow:

1. Runs the full verify gate (`npm run verify` → lint + test + build).
2. Builds the Tauri bundles for `windows-latest`, `macos-latest`, and
   `ubuntu-latest` matrix entries in parallel.
3. On platforms with signing env vars present (via repository secrets), the
   bundles are signed automatically.
4. Uploads every bundle as a GitHub Release asset.

Required GitHub Actions secrets for signed builds:

- `WINDOWS_CERT_BASE64` — the `.pfx` cert encoded with `base64 -w 0`
- `WINDOWS_CERT_PASSWORD`
- `APPLE_CERTIFICATE_BASE64` — the `Developer ID Application` `.p12` encoded
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY` (e.g. `Developer ID Application: Your Name (TEAMID)`)
- `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`

Without these secrets the workflow still runs and produces unsigned
binaries; consumers will see SmartScreen / Gatekeeper warnings until you
add them.

## Auto-update

Tauri's updater plugin is **not yet enabled** in this build — auto-update
requires a hosted manifest endpoint (typically a GitHub Releases endpoint).
To turn it on:

1. Add `tauri-plugin-updater = "2"` to `src-tauri/Cargo.toml`.
2. Add `tauri_plugin_updater::Builder::new().build()` to the
   plugins list in `src-tauri/src/lib.rs`.
3. Add a top-level `"plugins": { "updater": { "endpoints": ["..."] } }`
   block to `tauri.conf.json` pointing at your update manifest.
4. Generate a signing key with `npx tauri signer generate` and set
   `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in CI.

For a personal-use offline app, you can also just notify users to check the
Releases page — see "Check for updates" in System Health (when wired).

## Sidecar bundling

The Tauri Rust supervisor (`src-tauri/src/lib.rs`) looks for sidecar binaries
under `spike/` in dev, and under `resources/services/` next to the installed
executable in production (`services_dir()` searches both). The packaged
distribution ships the open-notebook Python backend + SurrealDB binary in that
`resources/services/` slot via `tauri.conf.json` → `bundle.resources`.

### Building the open-notebook backend binary

```bash
npm run build:onb-binary               # isolated-venv build (recommended)
npm run build:onb-binary -- --ambient  # build against the Python on PATH
```

`scripts/build-onb-binary.mjs` (default `--venv` mode):

1. Creates an isolated `.venv-onb` from a base Python 3.11/3.12 on PATH.
2. `pip install "spike/open-notebook"` — installs the **authoritative**
   dependency set from open-notebook's own `pyproject.toml` (langchain ≥1.2,
   langgraph, surrealdb, content-core, podcast-creator, numpy, …). No
   hand-maintained pin list to drift.
3. `pip install pyinstaller==6.20.0`.
4. Generates a one-file PyInstaller spec and builds
   `open-notebook(.exe)` into `src-tauri/resources/services/open-notebook/`.

The isolated venv matters: a dev box's **global** Python typically carries
cross-project version pins (e.g. an old `websockets` held back by an unrelated
editable install) that conflict with open-notebook's requirements. The venv
build is reproducible and never mutates global site-packages.

### Building the LSAT backend binary (StudyVault)

```bash
npm run build:lsat-binary               # isolated-venv build (recommended)
npm run build:lsat-binary -- --ambient  # build against the Python on PATH
```

`scripts/build-lsat-binary.mjs` mirrors the open-notebook build but reuses the
vendored backend's own, purpose-built spec:

1. Creates an isolated `.venv-lsat` from a base Python **3.12** on PATH.
2. `pip install "services/lsat-backend"` — authoritative deps from the
   backend's `pyproject.toml` (FastAPI, fsrs, sqlmodel, sqlite-vec, pymupdf,
   mcp, textstat, …). No hand-maintained pin list.
3. `pip install pyinstaller==6.20.0`.
4. Runs the backend's own `lsatlab.spec` (collects uvicorn/fastapi/sqlmodel/
   fsrs/mcp/pymupdf/sqlite_vec hidden-imports + data files) and copies
   `lsatlab-backend.exe` into `src-tauri/resources/services/lsat-backend/`.

Validated end-to-end: the produced binary boots, runs its 19 SQLite
migrations, starts the job worker, and serves on `127.0.0.1:8100`
(`/openapi.json` → 200, `/api/health` → `{"ok":true}`). The Rust supervisor's
4th `SidecarSpec` ('LSAT backend') launches it with `LSATLAB_PORT=8100`; the
SQLite bank is created under the OS app-data dir on first run (never shipped).
`tauri.conf.json` CSP `connect-src` includes `http://localhost:8100`.

### Packaging gotchas the spec handles (validated end-to-end)

A naive PyInstaller run produces a binary that builds but crashes on first run.
The spec in `build-onb-binary.mjs` was hardened against the full chain, each
fix verified by booting the bundled binary until the next failure surfaced:

- **`collect_all`** for the langchain ecosystem + open-notebook namespace
  packages — a static hidden-imports list can't keep up with langchain's
  dynamic plugin discovery (it was crashing on `langchain_text_splitters`).
- **`collect_all`** for `surrealdb` + `websockets` (the DB client pulls
  `websockets.sync` submodules the static pass misses).
- **Root-level mypyc glob** — `packaging` and `chardet` ship as mypyc-compiled
  wheels whose hashed `*__mypyc*.pyd`/`.so` extensions live at the
  site-packages **root**, outside any package dir, so `collect_all` misses
  them. The spec globs and bundles them at the bundle root.
- **`copy_metadata`** for `imageio`/`moviepy`/`podcast_creator`/`numpy`/etc. —
  these do `importlib.metadata.version(self)` at import time, which raises
  `PackageNotFoundError` unless their `.dist-info` travels along.
- **`collect_all`** for `content_core`/`esperanto`/`ai_prompter`/
  `surreal_commands` — they ship YAML config + prompt-template data files
  loaded via `pkgutil.get_data` (it was crashing on
  `content_core/models_config.yaml`).

With those in place the bundled binary boots its **entire** application graph —
all imports, all compiled/mypyc extensions, all package data + dist metadata,
and registers every open-notebook command — then reaches FastAPI app config.
The only thing left at that point is runtime configuration (a SurrealDB sidecar
at `:8000` + env), which is operational, not a packaging concern.

### Until the SurrealDB binary is also staged

- The packaged app launches fine and the React UI works.
- Grounded RAG falls back to the **fully-local path** (`src/lib/localRag.ts`)
  through the storage abstraction + local LLM — no sidecar required.
- Features that prefer the open-notebook backend surface their connection
  errors actionably (the existing CORS / no-backend message paths).
- Users running their own LM Studio / Ollama get the in-app AI features with
  no sidecar setup — those are direct HTTP calls.

## Switching the storage backend (SurrealDB cutover)

System Health → **Storage Backend** exposes a live cutover. "Switch to
SurrealDB" probes the `:8000` sidecar, migrates settings + the FSRS review
queue + the attempt log + mastery snapshots into it (curriculum chunks rebuild
on next ingest), and persists the choice. "Roll back to Dexie" reverts; the
IndexedDB data is never cleared, so the toggle is always safe. The preference
is stored in `localStorage` and re-applied at boot (`bootstrapStorage`) — if
the sidecar is down at startup the app silently stays on Dexie.

## Release checklist

Before tagging a release:

```bash
npm run verify              # lint + 450+ tests + build
cargo test --manifest-path src-tauri/Cargo.toml   # Rust unit tests (incl. 4-sidecar supervisor)
npm audit --omit=dev --audit-level=high           # 0 vulnerabilities
npm run content:validate    # all CFA levels exam-ready
npm run build:onb-binary    # open-notebook sidecar → resources/services/open-notebook/
npm run build:lsat-binary   # LSAT sidecar → resources/services/lsat-backend/
npm run tauri:build:debug   # smoke: bundle builds end-to-end (ships both sidecars)
```

The two Python backend sidecars are built locally before tagging (not in CI —
they're large and the personal-use workflow builds on the dev box). Both land
in `src-tauri/resources/services/` and are gitignored.

Then bump the three versions to match:

- `package.json` `"version"`
- `src-tauri/tauri.conf.json` `"version"`
- `src-tauri/Cargo.toml` `version = "..."`

Update `CHANGELOG.md` with the new section. Commit, tag, push:

```bash
git tag v0.x.y
git push origin v0.x.y
```

The GitHub Actions release workflow handles the rest.
