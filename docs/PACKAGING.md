# Electron Packaging And Signing

StudyVault ships through electron-builder. `package.json` supplies the app
version and desktop entrypoint; `electron-builder.yml` owns installer targets,
resources, file associations, hardened runtime settings, and platform signing.

## Local Builds

```bash
npm run electron:dev
npm run electron:build:dir
npm run electron:build
```

Outputs land under `release/`:

- Windows: `win-unpacked/StudyVault.exe`, NSIS `.exe`, and `.msi`.
- macOS: `mac*/StudyVault.app` and `.dmg`.
- Linux: `linux-unpacked/studyvault`, `.AppImage`, and `.deb`.

The required LSAT sidecar must exist under
`electron/resources/services/lsat-backend/` before a release build. Build and
verify it with:

```bash
npm run build:lsat-binary
npm run check:sidecar-provenance
```

electron-builder copies the services directory to
`process.resourcesPath/services`. Startup verifies the provenance manifest
before launching the required backend. Optional Open Notebook resources degrade
cleanly when absent.

The packaged fuse policy disables `NODE_OPTIONS`, inspector arguments, and
legacy file-protocol privileges; enables cookie encryption, embedded ASAR
integrity, and ASAR-only loading; and keeps `runAsNode` enabled only for the
owned-child watchdog. WebAssembly trap handlers remain enabled. The dedicated
fuse hook requires an explicit value for every Electron fuse, so packaging fails
when an Electron upgrade introduces an unreviewed option. Sidecars fail closed
if the watchdog cannot start.

## Signing

Tagged releases are fail-closed. Windows and macOS jobs cannot publish an
unsigned or unverifiable artifact.

Windows secrets:

- `WINDOWS_CERT_BASE64`
- `WINDOWS_CERT_PASSWORD`
- `WINDOWS_CERT_THUMBPRINT`

The workflow maps the certificate to `CSC_LINK` and `CSC_KEY_PASSWORD`.
Post-build verification requires valid Authenticode signatures, the expected
signer thumbprint, and trusted timestamps on the app executable, NSIS installer,
and MSI installer.

macOS secrets:

- `APPLE_CERTIFICATE_BASE64`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD` (app-specific password)
- `APPLE_TEAM_ID`

The workflow maps these to electron-builder's `CSC_*` and Apple notarization
variables. Verification requires strict `codesign`, Gatekeeper assessment, the
expected identity/team, and a stapled notarization ticket on the `.app`.

Linux package signing is currently `not_applicable`; SHA-256 release-manifest
evidence still covers the produced AppImage and DEB.

## Release Workflow

Pushing a `v*` tag runs `.github/workflows/release.yml`:

1. Run frontend, backend, contract, privacy, content, and regression gates.
2. Freeze and smoke-test the LSAT sidecar on each target OS.
3. Optionally build pinned Open Notebook resources.
4. Build Electron installers for the current runner.
5. Launch the unpacked app and verify sidecar health and shutdown cleanup.
6. Verify signatures/notarization and write signing evidence.
7. Generate `studyvault.release-manifest.v2` with npm/Python SBOM evidence,
   resource provenance, installer hashes, and signing bindings.
8. Publish only after every matrix job succeeds.

## Local Release Gate

```bash
python scripts/release_local.py --timeout 3600
```

Use `--electron-debug` for an unpacked desktop build or `--skip-electron` only
for development diagnostics. A release-tier trust report with the Electron,
sidecar, packaged-smoke, or signing legs skipped is blocked.

## Updates

Automatic updates are intentionally disabled. A future updater must use signed
metadata, a defined channel policy, rollback evidence, and the same artifact
verification rules as tagged releases before it is enabled.
