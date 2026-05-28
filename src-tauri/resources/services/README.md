# Bundled service binaries

This directory is the production sidecar staging slot. Tauri's
`bundle.resources` (see `tauri.conf.json`) copies everything here into
`resources/services/` inside the installed app, where `services_dir()`
in `src-tauri/src/lib.rs` will discover and spawn them at runtime.

## What goes here

- `open-notebook/open-notebook(.exe)` — produced by
  `npm run build:onb-binary` (script: `scripts/build-onb-binary.mjs`).
  Bundles the FastAPI backend at `spike/open-notebook/api/main.py` via
  PyInstaller. Requires Python 3.11+ and `pip install pyinstaller`
  before the script will succeed.
- `surreal(.exe)` — copy from `spike/bin/surreal.exe` (or the SurrealDB
  release tarball for your target platform) and rename to match the
  platform convention.

Each subdir is gitignored except this README — the binaries are large
and platform-specific, so they're produced at release time, not stored
in the source tree.
