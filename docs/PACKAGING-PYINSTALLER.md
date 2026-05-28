# Bundling the open-notebook backend via PyInstaller

The Tauri production install needs the FastAPI backend shipped inside
`resources/services/open-notebook/`. We use PyInstaller to produce a
single-file native binary so the user doesn't need a Python install at
runtime.

## What ships now (proven end-to-end against Python 3.12 + PyInstaller 6.20)

- `scripts/onb-minimal-requirements.txt` — focused pin set that
  excludes the heavy provider SDKs (anthropic, google-genai, groq,
  mistralai, sentence-transformers, torch). Keeps the binary near
  ~100 MB instead of 500+ MB.
- `scripts/onb-stub-main.py` — a tiny stub FastAPI that exposes the
  same `/health` route the real backend does, plus a 503 catch-all so
  the Tauri supervisor can probe readiness end-to-end without
  installing the full open-notebook tree. Used as a smoke build target.
- `scripts/build-onb-binary.mjs` — Node CLI driving PyInstaller against
  whichever entry point you point it at:
  - Full backend: `spike/open-notebook/api/main.py` (~150 MB)
  - Stub: `scripts/onb-stub-main.py` (~36 MB)

## Smoke test: build the stub binary and confirm `/health`

```powershell
# 1. install the trivially-small stub deps
python -m pip install fastapi==0.115.0 "uvicorn[standard]==0.30.6" pyinstaller==6.20.0

# 2. build (~36 MB exe)
python -m PyInstaller --onefile --name open-notebook-stub `
       --distpath .pyinstaller-dist --workpath .pyinstaller-build `
       scripts/onb-stub-main.py

# 3. boot on a free port and probe
$env:ONB_PORT='5056'
Start-Process -FilePath '.\.pyinstaller-dist\open-notebook-stub.exe' -PassThru
Start-Sleep -Seconds 4
(Invoke-WebRequest 'http://127.0.0.1:5056/health' -UseBasicParsing).Content
# → {"status":"ok","build":"pyinstaller-stub", ...}
```

Verified output on Windows 11 / Python 3.12.10 / PyInstaller 6.20.0:

```
{"status":"ok","build":"pyinstaller-stub","message":"QuantVault open-notebook stub — replace with full backend for production."}
```

## Building the full backend

```powershell
python -m venv .venv-onb
.\.venv-onb\Scripts\Activate.ps1
python -m pip install --upgrade pip wheel
python -m pip install -r scripts/onb-minimal-requirements.txt
python -m pip install pyinstaller==6.20.0
npm run build:onb-binary
```

The script writes the binary to
`src-tauri/resources/services/open-notebook/open-notebook(.exe)`.
`tauri.conf.json`'s `bundle.resources` ships everything under
`resources/services/` into the installer; `services_dir()` in
`src-tauri/src/lib.rs` discovers and supervises it at runtime.

## When to bump the pinned versions

Re-pin when:
- open-notebook (upstream) ships a version with security fixes against
  one of our pinned packages
- PyInstaller releases a fix for a bootloader bug on a target platform
- Python itself ships a new minor (3.12 → 3.13) — confirm langchain +
  langgraph still publish wheels for that version before bumping the
  base interpreter

After bumping, re-run the smoke test above. Then run the full
`npm run build:onb-binary` against the real entry point and tail
`pyinstaller --log-level WARNING` to confirm no missing hidden
imports.

## What the supervisor sees

`src-tauri/src/lib.rs:spawn_sidecars_with` spawns the binary via
`SidecarLauncher` with `ONB_HOST` and `ONB_PORT` set to `127.0.0.1`
and `5055`. The supervisor exits cleanly on app teardown by stopping
the child process (see `Drop` impl on the supervisor struct).
Integration tests in the same file exercise the supervisor with a
`MockLauncher` so no actual binary is required for CI.
