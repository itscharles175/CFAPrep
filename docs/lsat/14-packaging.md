# LSAT Backend Packaging

StudyVault packages the LSAT FastAPI backend as a platform-native Electron
sidecar. Electron owns the desktop lifecycle; the renderer never spawns
processes, reads arbitrary paths, or receives the backend bearer token.

## Runtime Layout

electron-builder copies `electron/resources/services/` to
`process.resourcesPath/services/`:

```text
services/
  lsat-backend/
    lsatlab-backend(.exe)
  open-notebook/
    open-notebook(.exe)
    open-notebook-worker(.exe)
  bin/
    surreal2(.exe)
  sidecar-provenance.json
```

The LSAT backend is required. SurrealDB and open-notebook are optional; a
missing optional resource produces a degraded status instead of preventing the
host from opening.

The supervisor refuses to launch when:

- a required resource is missing;
- a provenance size or SHA-256 check fails;
- a configured port is already occupied by a process StudyVault does not own;
- a required dependency is unavailable; or
- readiness does not succeed within the bounded startup window.

StudyVault never kills an unknown process to reclaim ports 8000, 5055, or 8100.
It terminates only process trees it started.

## Build The Sidecars

From the repository root:

```powershell
npm run build:lsat-binary
npm run stage:surreal-binary
npm run build:onb-binary
npm run check:sidecar-provenance
```

`scripts/build-lsat-binary.mjs` freezes `services/lsat-backend/sidecar_main.py`
with PyInstaller and stages `lsatlab-backend(.exe)` under the Electron service
root. `scripts/build-onb-binary.mjs` performs the equivalent build for the
optional open-notebook API and its installed `surreal-commands-worker` entry
point. `scripts/stage-surreal-binary.mjs` downloads the pinned target-specific
SurrealDB asset and verifies its SHA-256 before staging `bin/surreal2(.exe)`.

Each operating system and architecture must build its own native sidecars.
Do not reuse a Windows provenance manifest for macOS or Linux.

## Desktop Build

Development:

```powershell
npm run electron:dev
```

Unsigned local package smoke:

```powershell
npm run electron:build:debug
```

Signed release package:

```powershell
npm run electron:build
```

The release configuration is `electron-builder.yml`. Release builds fail
closed when platform signing is required but unavailable. The debug command
explicitly disables that release-only requirement and writes to
`release-debug/`.

## Runtime Security Contract

The desktop host uses:

- `contextIsolation: true`;
- `nodeIntegration: false`;
- `sandbox: true`;
- `webSecurity: true`;
- an allowlisted context bridge in `electron/preload.cjs`;
- sender validation for every IPC invocation;
- a privileged `app://studyvault` renderer origin;
- navigation, popup, permission, and external-URL restrictions; and
- OS-backed `safeStorage` for local secret material.

The main process generates a new LSAT API token on each launch. Electron's
session layer adds that token only to exact requests for
`http://127.0.0.1:8100/*`. The token is not exposed through preload, renderer
state, logs, or diagnostics.

File reads require a native picker, launch-file handoff, or validated drop
authorization. The main process canonicalizes paths, rejects symbolic links,
enforces file type and size caps, and rejects paths that were not authorized by
a user action.

## Signing And Notarization

Windows release builds produce NSIS and MSI artifacts. The release workflow
requires the certificate, password, and expected SHA-1 thumbprint. It verifies
Authenticode signatures, signer identity, timestamps, and digest bindings for
the unpacked host and published installers.

macOS release builds produce x64 and arm64 DMGs. The workflow requires a
Developer ID Application identity plus notarization credentials. It verifies
the signed app, hardened runtime, notarization, stapling, Gatekeeper assessment,
DMG evidence, and artifact digests.

Linux release builds produce AppImage and deb packages. Code signing is marked
not applicable, but provenance, package smoke, release-manifest, and digest
checks still apply.

Final signing and release reports are external release evidence. They are not
embedded into the sidecar being evaluated, which avoids a circular trust chain.

## Release Gate

`.github/workflows/release.yml` performs the following per platform:

1. install locked Node and Python dependencies;
2. run host, LSAT, Electron, backend, documentation, no-egress, and provenance
   gates;
3. build and smoke native sidecars;
4. package the Electron application with the actual staged resources;
5. run packaged startup, health, and process-cleanup smoke tests;
6. verify signatures where required;
7. generate signing evidence and the strict release manifest; and
8. upload only verified release artifacts.

Use `docs/PACKAGING.md` for the operator checklist and secret names. Use
`docs/PACKAGING-PYINSTALLER.md` for sidecar freeze troubleshooting.
