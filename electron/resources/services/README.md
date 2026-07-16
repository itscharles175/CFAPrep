# Bundled service binaries

This directory is the production sidecar staging slot. electron-builder's
`extraResources` copies everything here into `resources/services/` inside the
installed app, where the Electron main process discovers and supervises it.

## What goes here

- `open-notebook/open-notebook(.exe)` — produced by
  `npm run build:onb-binary` (script: `scripts/build-onb-binary.mjs`).
  Bundles the FastAPI backend at `spike/open-notebook/api/main.py` via
  PyInstaller. Requires Python 3.11+ and `pip install pyinstaller`
  before the script will succeed.
- `open-notebook/open-notebook-worker(.exe)` - produced by the same build from
  the pinned `surreal-commands-worker` console entry point. The API and worker
  are versioned and provenance-checked as one optional feature set.
- `lsat-backend/lsatlab-backend(.exe)` — produced by
  `npm run build:lsat-binary` from `services/lsat-backend/lsatlab.spec`.
  This is the required StudyVault LSAT FastAPI sidecar on `127.0.0.1:8100`.
- `bin/surreal2(.exe)` - produced by `npm run stage:surreal-binary`. The script
  downloads the pinned target-platform SurrealDB 2.6.5 release asset, verifies
  its SHA-256, and records provenance before the optional RAG feature is enabled.
- `sidecar-provenance.json` — produced by the sidecar build scripts and
  checked by `npm run check:sidecar-provenance`. The Electron supervisor refuses a
  manifest-listed sidecar whose size or SHA-256 no longer matches before launch.

Each subdir is gitignored except this README — the binaries are large
and platform-specific, so they're produced at release time, not stored
in the source tree.
