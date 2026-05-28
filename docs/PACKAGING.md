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

The Tauri Rust supervisor (`src-tauri/src/lib.rs`) currently looks for the
sidecar binaries under `spike/`, a dev-time arrangement that's gitignored.
For a packaged distribution the SurrealDB binary + the open-notebook Python
backend (PyInstaller-bundled) need to live in `resources/` next to the
installed app, and `services_dir()` needs to read from Tauri's
`app.path().resource_dir()` instead of `cwd`.

This is open (Pillar 0 packaging tail). Until it's wired:

- The packaged app launches fine and the React UI works.
- Grounded RAG features that need open-notebook surface their connection
  errors actionably (the existing CORS / no-backend message paths).
- Users running their own LM Studio / Ollama still get the in-app AI
  features without any sidecar setup — those are direct HTTP calls.

## Release checklist

Before tagging a release:

```bash
npm run verify              # lint + 200+ tests + build
cargo test --manifest-path src-tauri/Cargo.toml   # Rust unit tests
npm audit --omit=dev --audit-level=high           # 0 vulnerabilities
npm run content:validate    # all CFA levels exam-ready
npm run tauri:build:debug   # smoke: bundle builds end-to-end
```

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
