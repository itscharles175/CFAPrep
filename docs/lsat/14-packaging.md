# LSAT Lab — Packaging, Signing & Release (S1 / S4 / S5)

How LSAT Lab is turned into a self-contained, signed, auto-updating desktop
install. Covers the backend sidecar (S1), code signing / notarization (S4), and
the auto-updater + release CI (S5). The app stays local-first: the "backend" is
a loopback FastAPI server bundled inside the app, not a hosted service.

---

## 1. Architecture: the backend as a Tauri sidecar (S1)

In dev, Tauri spawns the FastAPI backend from `backend/.venv`. That can't ship —
end users have no Python. So we freeze the backend into a standalone executable
and ship it as a **Tauri sidecar** (`bundle.externalBin`).

```
backend/sidecar_main.py     PyInstaller entry: boots uvicorn against app.main:app
backend/lsatlab.spec        PyInstaller spec -> dist/lsatlab-backend[.exe]
backend/build-sidecar.ps1   builds + copies into src-tauri/binaries/ with the
                            Tauri target-triple suffix
frontend/src-tauri/binaries/
        lsatlab-backend-<target-triple>[.exe]   (gitignored build artifact)
```

`tauri.conf.json` references it as:

```json
"bundle": { "externalBin": ["binaries/lsatlab-backend"] }
```

Tauri appends the current target triple (e.g.
`lsatlab-backend-x86_64-pc-windows-msvc.exe`) and bundles the matching file. The
capability `capabilities/default.json` authorizes launching exactly that sidecar
with fixed `--host 127.0.0.1 --port 8000` args (`shell:allow-execute` scoped to
`binaries/lsatlab-backend`, `sidecar: true`).

### Runtime startup logic (`src-tauri/src/lib.rs`)

On launch the app picks a backend in priority order:

1. **Already listening** on `127.0.0.1:8000` → attach to it, never kill it.
   (This is how `start-dev.ps1` keeps working — it starts uvicorn first.)
2. **`backend/.venv` present** → spawn `python -m uvicorn app.main:app` (dev
   convenience so `tauri dev` works without a separate terminal).
3. **Otherwise** → spawn the bundled sidecar via `tauri-plugin-shell`.

The window starts hidden (`"visible": false`). A background thread HTTP-health-
checks `GET /docs` until it returns an `HTTP/` status line (up to 30s), emits a
`backend-ready` event, then reveals the window (it reveals anyway on timeout so
the UI can show its own error state). On exit, a backend we spawned (sidecar or
`.venv`) is killed; an external dev backend is left running.

### Building the sidecar locally

```powershell
# from repo root
cd backend
./build-sidecar.ps1                       # auto-detects host triple via rustc
# or cross-target (e.g. Intel binary on Apple Silicon):
./build-sidecar.ps1 -TargetTriple x86_64-apple-darwin
```

The script runs `uv run --with pyinstaller pyinstaller lsatlab.spec` (PyInstaller
is injected for the build only — it is not a project dependency), then stages the
binary into `frontend/src-tauri/binaries/`.

> One-file vs one-dir: the spec defaults to **one-file** (`ONE_FILE = True`).
> Flip it to `False` for a faster-starting one-dir build; `build-sidecar.ps1`
> handles either layout.

### Hidden imports / data files

`lsatlab.spec` collects submodules for `uvicorn` (its protocol modules are
imported by string and are invisible to static analysis), `app`, `fastapi`,
`starlette`, `sqlmodel`, `sqlalchemy`, `pydantic[_core]`, `fsrs`, and `mcp`, plus
data files for packages that ship resources (`pymupdf`, etc.). Dev-only deps
(`pytest`, `coverage`, `PyInstaller`) are excluded to keep the binary small. If a
future dependency is imported dynamically and goes missing at runtime, add it to
`hiddenimports` in the spec.

---

## 1b. Native desktop hardening (W8)

Beyond spawning the sidecar, the Rust shell (`src-tauri/src/lib.rs`) wires four
OS-integration features. Everything below is registered/handled natively; the
frontend only **listens for events** and pulls one command — all via the
already-present `@tauri-apps/api`, dynamically imported behind `isTauri()` so the
web bundle is untouched (no extra npm runtime deps were added).

### Plugins (Cargo + capabilities)

| Plugin (crate) | Purpose | Capability grant |
| --- | --- | --- |
| `tauri-plugin-single-instance` | A second launch focuses the running window and forwards its argv (used for the `.pdf` open-with handoff). Registered **first** in the builder (Tauri requirement). | none — setup-only plugin, no IPC commands |
| `tauri-plugin-window-state` | Persists/restores window size, position and maximized state **natively** (replaces the old JS shim). | `window-state:default` |
| `tauri-plugin-global-shortcut` | Registers one OS-wide hotkey. | none — the shortcut is registered in Rust (`app.global_shortcut().register(...)`), not from JS |

> `single-instance` and `global-shortcut` need **no** capability because they are
> driven entirely from Rust; capabilities only gate JS→Rust IPC. `window-state`
> gets `window-state:default` so its save/restore commands are permitted.

### Event flow (native → frontend)

All event names live in the `events` module in `lib.rs` and the matching
listeners in `src/lib/tauri.ts`:

| Trigger | Native emit | Frontend listener (`src/lib/tauri.ts`) | Effect |
| --- | --- | --- | --- |
| Tray **Open** / **Resume last session**; bare second launch; global shortcut **Ctrl/⌘+Shift+L** | `tray-open` | `listenTrayOpen` (in `App.tsx`) | focus window + navigate to the saved resume pointer |
| Tray **Today's SRS** | `tray-navigate` → `"/srs"` | `listenTrayNavigate` (in `App.tsx`) | focus window + `navigate(path)` |
| Tray **Quick drill** | `tray-navigate` → `"/drills"` | `listenTrayNavigate` | focus window + `navigate(path)` |
| Tray **Quit** | — | — | `app.exit(0)` |
| Open-with a `.pdf` (initial launch) | `take_launch_file` **command** (+ `open-file` event after reveal) | `listenOpenFile` (in `App.tsx`) | `navigate("/import", { state: { openFile } })` → `Import.tsx` reads the file via `readFileFromPath` and runs the wizard |
| Open-with a `.pdf` (app already running) | `open-file` event (single-instance forwards argv) | `listenOpenFile` | same as above |

The initial-launch file is captured in `lib.rs` via `std::env::args()` in
`setup` (before the webview exists) and exposed two ways so the startup race
can't drop it: a one-shot `take_launch_file` command the frontend pulls on
mount, **and** an `open-file` event emitted after the window is revealed.
`listenOpenFile` de-dupes so the file is handled at most once.

### Global shortcut

`CmdOrCtrl+Shift+L` (⌘ on macOS, Ctrl elsewhere). Registered in `setup`;
the handler acts only on the `Pressed` state and emits `tray-open` (focus +
resume). A failed registration (e.g. the combo is already taken by another app)
is logged as a warning and is non-fatal.

### `.pdf` file association

`tauri.conf.json → bundle.fileAssociations` claims `.pdf` (role `Viewer`,
description scoped to PrepTest import) so the OS offers **"Open with LSAT Lab"**.
Launching that way routes into the import wizard pre-loaded with the file (see
the event-flow table). NSIS on Windows and the `Info.plist` `CFBundleDocumentTypes`
on macOS are produced from this block by `tauri build`.

### Window-state migration (what was removed)

The previous JS shim — `src/lib/window-state.ts` (deleted) plus the
`loadWindowState`/`saveWindowState` + `beforeunload`/`onResized` persistence and
the **resize-on-show** restore inside `src/components/titlebar.tsx` — is gone.
`tauri-plugin-window-state` now restores the saved geometry to the still-hidden
window during creation, so when `reveal_main_window` shows it there is **no
resize flash**. `titlebar.tsx` now only renders the chrome and tracks the
maximized flag for the button icon; it is a clean no-op in the browser. The
retired `lsatlab.window` localStorage key is left documented-but-unused in
`STORAGE_KEYS` (any stale value is ignored).

---

## 2. Building a signed installer locally

You need the full toolchain (none of this is verifiable in the headless CI
sandbox — see §6):

- Rust stable + the Tauri prerequisites for your OS
- Node 20 + `npm ci` in `frontend/`
- `uv` + `uv sync` in `backend/`
- Platform signing material (below)

```powershell
# 1. Freeze + stage the backend sidecar
cd backend; ./build-sidecar.ps1

# 2. Build the desktop bundle (installers land in
#    frontend/src-tauri/target/release/bundle/)
cd ../frontend; npm run tauri:build
```

### Windows (Authenticode)

Set in `tauri.conf.json → bundle.windows`:

- `certificateThumbprint` — thumbprint of a code-signing cert installed in the
  Windows cert store, **or** leave `null` and provide a custom `signCommand`.
- `timestampUrl` / `digestAlgorithm` are pre-filled (DigiCert RFC-3161, SHA-256).

For CI we keep the cert out of the repo and pass it as a base64 `.pfx`
(`WINDOWS_CERTIFICATE` / `WINDOWS_CERTIFICATE_PASSWORD`). Locally you can either
import the `.pfx` and set `certificateThumbprint`, or sign by thumbprint after
the build with `signtool`.

### macOS (Developer ID + notarization + hardened runtime)

`tauri.conf.json → bundle.macOS` sets `hardenedRuntime: true`,
`entitlements: "entitlements.plist"`, and `signingIdentity: "-"` (the `-`
placeholder makes Tauri read the identity from the `APPLE_SIGNING_IDENTITY` env
var so the cert is never committed).

`src-tauri/entitlements.plist` grants the three hardened-runtime exceptions a
**frozen-Python sidecar** needs (allow-jit, allow-unsigned-executable-memory,
disable-library-validation) plus `network.client`. Tauri signs both the app and
the sidecar with the same identity.

Notarization is driven by env vars consumed by the Tauri CLI / tauri-action:
`APPLE_ID`, `APPLE_PASSWORD` (app-specific password), `APPLE_TEAM_ID`. When
those are present the build notarizes and staples automatically.

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: You (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="abcd-efgh-ijkl-mnop"   # app-specific password
export APPLE_TEAM_ID="ABCDE12345"
cd backend && ./build-sidecar.ps1
cd ../frontend && npm run tauri:build
```

---

## 3. Auto-updater (S5)

Config lives in `tauri.conf.json → plugins.updater`:

- `endpoints` — the committed value is the GitHub "latest release" template
  `https://github.com/lsatlab/lsatlab/releases/latest/download/latest.json`. The
  release CI **rewrites** this at build time to point at the actual repo
  (`https://github.com/<owner>/<repo>/.../latest.json` via `github.repository`),
  so the only manual step is updating the `lsatlab/lsatlab` placeholder if you
  ever build a release **outside** CI.
- `pubkey` — the committed value is the sentinel
  `PLACEHOLDER_TAURI_UPDATER_PUBKEY`. **The real public key is never committed.**
  It is injected at release-build time from the `TAURI_UPDATER_PUBKEY` repo
  secret (see §3.1 and §4); the CI step **fails a tag release** if the key is
  still the placeholder so an unverifiable installer can't be published.
- `windows.installMode: "passive"` — quiet update install.

The plugins are wired in `src-tauri/src/lib.rs`
(`tauri-plugin-updater` + `tauri-plugin-process` for the post-update restart) and
authorized in `capabilities/default.json` (`updater:default`, `process:default`).
The frontend can call the updater JS API to check/install (UI is out of scope for
this track).

### 3.1 Updater signing key generation — EXACT manual steps (human-only)

This is the one step that **cannot** be automated or verified in the sandbox: it
mints a private key that must stay secret. Do it once on a trusted machine.

```bash
# 1. Generate the keypair. Writes the PRIVATE key to the -w path and prints the
#    matching PUBLIC key to stdout (also written to <path>.pub). Use a password.
npx tauri signer generate -w ~/.tauri/lsatlab-updater.key --password "<choose-a-strong-password>"

#    (run from frontend/ so the bundled @tauri-apps/cli is used; equivalently
#    `npm --prefix frontend run tauri -- signer generate -w ...`)

# 2. Read the PUBLIC key back out (base64, single line):
cat ~/.tauri/lsatlab-updater.key.pub
```

Then wire the two halves — **never** swap them:

| Half | Where it goes | How |
| --- | --- | --- |
| **Public** key (`*.pub`) | GitHub repo secret **`TAURI_UPDATER_PUBKEY`** | the release CI injects it into `tauri.conf.json → plugins.updater.pubkey` at build time (replacing the `PLACEHOLDER_TAURI_UPDATER_PUBKEY` sentinel). You may instead paste it directly into `tauri.conf.json` and commit it — the public key is safe to commit — but the secret keeps it out of the diff. |
| **Private** key (file contents) | GitHub repo secret **`TAURI_SIGNING_PRIVATE_KEY`** | consumed by `tauri-action` to sign the installers + `latest.json`. |
| Key **password** | GitHub repo secret **`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`** | the password chosen in step 1. |

> Set secrets with: `gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/lsatlab-updater.key`
> (and likewise `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `TAURI_UPDATER_PUBKEY`).

At release time tauri-action signs the installers and produces `latest.json`
(the updater manifest) signed with the private key; installed apps verify the
download against the embedded public key. **Never commit the private key.**
Losing it means existing installs can't auto-update to new releases (you'd have
to ship a new key in a new build and re-distribute manually).

---

## 4. Release CI (`.github/workflows/release.yml`)

Trigger: push a `v*` tag (or run manually via `workflow_dispatch`).

```bash
git tag v0.2.0 && git push origin v0.2.0
```

Matrix (one job per artifact):

| Platform        | Rust target                  |
| --------------- | ---------------------------- |
| macos-latest    | aarch64-apple-darwin         |
| macos-latest    | x86_64-apple-darwin          |
| ubuntu-22.04    | x86_64-unknown-linux-gnu     |
| windows-latest  | x86_64-pc-windows-msvc       |

Each job: checkout → (Linux: install webkit2gtk/appindicator deps) → Node + Rust
(+ target) + `uv` → `uv sync` → **`pwsh backend/build-sidecar.ps1 -TargetTriple
<target>`** (PowerShell Core is preinstalled on all GitHub runners, so the one
build script runs cross-platform) → `npm ci` → **`tauri-apps/tauri-action@v0`**
which runs `tauri build`, signs, and uploads to a **draft** GitHub Release with
`includeUpdaterJson: true` (emits the signed `latest.json`).

The release is created as a draft so you can review assets before publishing;
flip `releaseDraft: false` to auto-publish.

### Required CI secrets

| Secret | Purpose |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Updater manifest/artifact signing (`tauri signer generate`) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the updater key |
| `TAURI_UPDATER_PUBKEY` | Optional: injects the **public** key into `tauri.conf.json` at release build time (commit the pubkey locally, or set this secret) |
| `WINDOWS_CERTIFICATE` | base64 of the code-signing `.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | `.pfx` password |
| `APPLE_CERTIFICATE` | base64 of the Developer ID `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` password |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: You (TEAMID)` |
| `APPLE_ID` | Apple ID email for notarization |
| `APPLE_PASSWORD` | App-specific password |
| `APPLE_TEAM_ID` | 10-char team id |
| `KEYCHAIN_PASSWORD` | Throwaway password for the temp signing keychain |

`GITHUB_TOKEN` is provided automatically (the workflow requests
`permissions: contents: write`). Without the signing secrets the build still
runs but produces **unsigned** artifacts and **no** valid `latest.json`
signature, so auto-update will reject them — fine for a smoke test, not for a
real release.

---

## 5. CI test gates (`.github/workflows/ci.yml`)

The existing CI was extended (existing jobs untouched in structure):

- **backend** job: coverage now enforces a floor —
  `pytest --cov=app ... --cov-fail-under=70`.
- **frontend** job: added `npm run test` (vitest unit tests) before the build.
- **e2e** job (new): installs Playwright's Chromium (`npx playwright install
  --with-deps chromium`) and runs `npm run test:e2e`. Playwright's own config
  starts a Vite dev server (`webServer`), so no backend is required for these
  visual/route smoke tests.

---

## 6. What still needs the real toolchain / certificates

Everything below was **not** verifiable in the headless dev sandbox and must be
confirmed on a real build machine / in CI:

- **`tauri build` / installer production** — no full Tauri toolchain, signing
  identities, or WebView here. `cargo check` passes for `src-tauri` (deps
  resolved against tauri 2.11.2: tauri-plugin-shell 2.3.5, -updater 2.10.1,
  -process 2.3.1, and the W8 additions -single-instance 2.4.2, -window-state
  2.4.1, -global-shortcut 2.3.1), but a real bundle is unverified.
- **PyInstaller freeze** — `pyinstaller` is not installed here, so the spec was
  validated only as importable/compilable Python. The actual frozen binary,
  hidden-import completeness, and `pymupdf`/`fsrs` data-file bundling must be
  checked by running `build-sidecar.ps1` on each OS.
- **Code signing & notarization** (Windows Authenticode, Apple Developer ID +
  notary) — require real certs/credentials; only the config + secret wiring is
  in place.
- **Auto-update end-to-end** — needs a real signing keypair (§3.1), a published
  release with `latest.json`, and an installed app to verify the update
  handshake. The `pubkey` in `tauri.conf.json` is the `PLACEHOLDER_TAURI_UPDATER_PUBKEY`
  sentinel (injected from the `TAURI_UPDATER_PUBKEY` secret at release time) and
  the updater `endpoints` owner/repo (`lsatlab/lsatlab`) is rewritten to the real
  repo by CI.
- **The release workflow** — YAML is well-formed but the end-to-end run (matrix,
  sidecar build, signing, release upload, the new placeholder-pubkey guard) can
  only be exercised by pushing a tag with the secrets configured.
- **W8 native hardening (`single-instance` / `window-state` / `global-shortcut` /
  file association)** — the Rust + config compile (`cargo check` passes, see
  above), but the actual OS behavior is **only verifiable in a real bundle**:
  the second-launch focus + `.pdf` argv forwarding, native window-geometry
  persistence across restarts, the OS-wide `Ctrl/⌘+Shift+L` binding, and the
  "Open with LSAT Lab" file-association handler (NSIS / `Info.plist`) all need a
  built, installed app on each OS. `tauri dev` exercises most of it except the
  installed file-association registration.
