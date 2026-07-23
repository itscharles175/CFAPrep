# Freezing Python Sidecars With PyInstaller

Electron production installs carry native Python sidecars under
`resources/services/`; users do not need Python, `uv`, or source checkouts at
runtime. Every release target builds its own binaries with Python 3.12 and
PyInstaller 6.20.0.

## Packaged Inventory

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

The LSAT backend is required. SurrealDB, the Open Notebook API, and the Open
Notebook worker form one optional RAG feature set. The release workflow does
not mark RAG enabled unless all three optional executables are staged and pass
provenance checks.

## LSAT Backend

`scripts/build-lsat-binary.mjs` creates an isolated `.venv-lsat`, installs the
vendored backend from `services/lsat-backend/pyproject.toml`, and runs the
maintained `services/lsat-backend/lsatlab.spec`. The result is staged at
`electron/resources/services/lsat-backend/lsatlab-backend(.exe)`.

```powershell
npm run build:lsat-binary
npm run check:sidecar-provenance
```

## Open Notebook API And Worker

Release builds require a pinned Open Notebook checkout at
`spike/open-notebook`. `ONB_GIT_REF` must be the full commit SHA validated by
`npm run check:onb-source`. `scripts/build-onb-binary.mjs` installs that source
into an isolated `.venv-onb`, freezes `api/main.py`, resolves the installed
`surreal-commands-worker` console entry point, and freezes both entry points.

```powershell
$env:ONB_GIT_REF='<40-character-commit-sha>'
npm run check:onb-source -- --dir spike/open-notebook --expected $env:ONB_GIT_REF
npm run stage:surreal-binary
npm run build:onb-binary
npm run check:sidecar-provenance -- --require "SurrealDB" --require "open-notebook binary" --require "open-notebook worker binary"
```

`npm run stage:surreal-binary` downloads the target-specific SurrealDB 2.6.5
release asset, validates its pinned SHA-256, renames it to
`bin/surreal2(.exe)`, and records provenance. The Open Notebook build writes
both executables under `electron/resources/services/open-notebook/` and records
their independent hashes.

`scripts/onb-stub-main.py` remains a narrow diagnostic fixture. It is not used
by production packaging and cannot satisfy the RAG-enabled release gate.

## Verification

Before packaging, run the frozen binaries and verify the loopback health
contracts. Tagged CI performs this for the required LSAT backend and validates
the full optional inventory whenever RAG is enabled. electron-builder then
copies the staged service root through `extraResources`.

After any Python, PyInstaller, Open Notebook, or SurrealDB pin change:

1. rebuild on every target OS and architecture;
2. run provenance validation;
3. smoke the frozen API endpoints and worker startup;
4. package the Electron app with the real resources; and
5. run packaged startup and process-cleanup smoke tests.

`electron/sidecar-manager.js` owns dependency order, readiness, redacted logs,
bounded restart, and teardown. The crash watchdog tracks only process trees
launched by the current Electron instance.
