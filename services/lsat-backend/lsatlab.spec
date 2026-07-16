# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the LSAT Lab backend sidecar.

Build (from backend/):
    pyinstaller lsatlab.spec --noconfirm

Produces a single-file executable in ``dist/`` named ``lsatlab-backend`` (with
the platform's executable suffix, e.g. ``lsatlab-backend.exe`` on Windows). The
``build-sidecar.ps1`` helper then copies it into
``../../electron/resources/services/lsat-backend/`` where electron-builder
stages it as an ``extraResource``.

Why one-file: the desktop app ships a single sidecar; one-file keeps the bundle
layout simple. On startup PyInstaller's bootloader
unpacks to a temp dir, which costs ~1s — acceptable for a long-lived local
server. Switch ``ONE_FILE = False`` below for a faster-starting one-dir build if
you'd rather ship a folder.

The entry point is ``sidecar_main.py`` which boots uvicorn against
``app.main:app`` programmatically (see that file). We bundle the whole ``app``
package as data + hidden imports because the routers are imported dynamically
and PyInstaller's static analysis does not always follow FastAPI's include_router
graph or uvicorn's lazy protocol imports.
"""
from PyInstaller.utils.hooks import collect_submodules, collect_data_files
from pathlib import Path

ONE_FILE = True

block_cipher = None

# --- Hidden imports ---------------------------------------------------------
# uvicorn lazily imports its websocket/http/lifespan protocol implementations by
# string, so PyInstaller cannot see them statically. Collect everything under
# uvicorn plus the app package and the ASGI/validation stack it leans on.
hiddenimports = []
hiddenimports += collect_submodules("uvicorn")
hiddenimports += collect_submodules("app")
hiddenimports += collect_submodules("fastapi")
hiddenimports += collect_submodules("starlette")
hiddenimports += collect_submodules("sqlmodel")
hiddenimports += collect_submodules("sqlalchemy")
hiddenimports += collect_submodules("pydantic")
hiddenimports += collect_submodules("pydantic_core")
hiddenimports += collect_submodules("fsrs")
# The runtime uses MCP server modules, not the optional CLI. Importing mcp.cli
# during collection requires the `mcp[cli]` Typer extra and breaks clean
# packaged sidecar builds, so exclude that subtree from the sweep.
hiddenimports += collect_submodules("mcp", filter=lambda name: not name.startswith("mcp.cli"))
# uvicorn[standard] optional speedups — included when present, harmless if not.
hiddenimports += [
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.http.httptools_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.protocols.websockets.wsproto_impl",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    "anyio._backends._asyncio",
    "httptools",
    "websockets",
    "watchfiles",
    "python_multipart",
    "multipart",
    "email_validator",
    # Optional fast vector backend (H1). The runtime import is guarded + falls
    # back to pure-Python cosine, so a missing bundle is non-fatal.
    "sqlite_vec",
]

# --- Data files -------------------------------------------------------------
# Some deps ship non-Python resources (e.g. pymupdf shared libs/fonts) that the
# binary needs at runtime. collect_data_files pulls those into the bundle.
datas = []
for pkg in ("fastapi", "sqlmodel", "pymupdf", "fsrs", "mcp", "sqlite_vec", "textstat"):
    try:
        datas += collect_data_files(pkg)
    except Exception:
        # A package without data files (or not installed in this env) is fine.
        pass

# Frozen sidecars embed only immutable, pre-sign build contracts. Final release
# reports and signatures are generated after packaging and remain external
# GitHub Release evidence, avoiding a circular trust chain.
repo_root = Path.cwd().parents[1]
release_contracts = [
    (repo_root / "openapi.json", "release_contracts"),
    (repo_root / "electron" / "resources" / "services" / "sidecar-provenance.json", "release_contracts"),
]
for source, dest in release_contracts:
    if source.exists():
        datas.append((str(source), dest))


a = Analysis(
    ["sidecar_main.py"],
    pathex=["."],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Trim heavy dev-only deps that would otherwise bloat the binary. None of
    # these are imported by the runtime server.
    excludes=[
        "pytest",
        "pytest_cov",
        "coverage",
        "tkinter",
        "PyInstaller",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

if ONE_FILE:
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.zipfiles,
        a.datas,
        [],
        name="lsatlab-backend",
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        upx_exclude=[],
        runtime_tmpdir=None,
        console=True,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
    )
else:
    exe = EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        name="lsatlab-backend",
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        console=True,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
    )
    coll = COLLECT(
        exe,
        a.binaries,
        a.zipfiles,
        a.datas,
        strip=False,
        upx=False,
        upx_exclude=[],
        name="lsatlab-backend",
    )
