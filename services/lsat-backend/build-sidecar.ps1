<#
.SYNOPSIS
    Build the LSAT Lab backend into a self-contained executable and stage it as
    a Tauri sidecar.

.DESCRIPTION
    1. Runs PyInstaller against lsatlab.spec to freeze the FastAPI backend
       (entry point: sidecar_main.py) into backend/dist/lsatlab-backend[.exe].
    2. Resolves the Rust *host* target triple (e.g. x86_64-pc-windows-msvc) so
       the binary can be renamed the way Tauri's `externalBin` expects:
           binaries/lsatlab-backend-<target-triple>[.exe]
    3. Copies the frozen binary into frontend/src-tauri/binaries/.

    Tauri matches the sidecar to the current build target by the triple suffix,
    so this script must run on (or cross-target for) each platform you ship.
    CI calls it per-OS in the release workflow.

.PARAMETER TargetTriple
    Override the auto-detected Rust target triple (useful for cross-compiles).

.PARAMETER PythonRunner
    How to invoke PyInstaller. Defaults to "uv run" so the project's locked
    environment is used; pass "python -m" if you've installed PyInstaller into
    an already-active venv.

.EXAMPLE
    ./build-sidecar.ps1
    # Builds for the host triple using `uv run pyinstaller`.

.EXAMPLE
    ./build-sidecar.ps1 -TargetTriple aarch64-apple-darwin
#>
[CmdletBinding()]
param(
    [string]$TargetTriple,
    [string]$PythonRunner = "uv run"
)

$ErrorActionPreference = "Stop"
$backendDir = $PSScriptRoot
$sidecarDir = Join-Path $backendDir "..\frontend\src-tauri\binaries"
$specPath = Join-Path $backendDir "lsatlab.spec"
$baseName = "lsatlab-backend"

Write-Host "==> Building backend sidecar with PyInstaller..." -ForegroundColor Cyan
Push-Location $backendDir
try {
    # Ensure PyInstaller is available in the build environment. With uv this is
    # a no-op if it's already a dev/build dependency; otherwise add it on the fly
    # for this invocation only (does not mutate pyproject).
    $runnerParts = $PythonRunner.Split(" ", [System.StringSplitOptions]::RemoveEmptyEntries)
    $runnerExe = $runnerParts[0]
    $runnerArgs = @()
    if ($runnerParts.Length -gt 1) { $runnerArgs = $runnerParts[1..($runnerParts.Length - 1)] }

    if ($runnerExe -eq "uv") {
        # `uv run --with` injects PyInstaller for this command without editing the
        # lockfile, so the spec build works on a clean checkout/CI runner. Pin to a
        # MAJOR so a breaking PyInstaller release can't silently change the freeze
        # (hidden-imports / bundle layout) between otherwise-identical tags.
        & $runnerExe run --with "pyinstaller>=6,<7" pyinstaller $specPath --noconfirm --clean
    }
    else {
        & $runnerExe @runnerArgs pyinstaller $specPath --noconfirm --clean
    }
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed with exit code $LASTEXITCODE" }
}
finally {
    Pop-Location
}

# --- Resolve the Rust target triple ----------------------------------------
if (-not $TargetTriple) {
    Write-Host "==> Detecting Rust host target triple via rustc..." -ForegroundColor Cyan
    $rustcOut = (& rustc -vV) -join "`n"
    $match = [regex]::Match($rustcOut, "host:\s*(\S+)")
    if (-not $match.Success) {
        throw "Could not determine the Rust host triple from 'rustc -vV'. Pass -TargetTriple explicitly."
    }
    $TargetTriple = $match.Groups[1].Value
}
Write-Host "    target triple: $TargetTriple" -ForegroundColor DarkGray

# Windows targets carry the .exe suffix on both the source and destination.
$exeSuffix = if ($TargetTriple -like "*windows*") { ".exe" } else { "" }

# --- Locate the freshly built binary ---------------------------------------
# One-file mode: dist/lsatlab-backend[.exe]
# One-dir  mode: dist/lsatlab-backend/lsatlab-backend[.exe]
$distDir = Join-Path $backendDir "dist"
$oneFile = Join-Path $distDir "$baseName$exeSuffix"
$oneDir = Join-Path $distDir (Join-Path $baseName "$baseName$exeSuffix")

if (Test-Path $oneFile) {
    $builtBinary = $oneFile
}
elseif (Test-Path $oneDir) {
    $builtBinary = $oneDir
}
else {
    throw "Could not find the built binary. Looked for:`n  $oneFile`n  $oneDir"
}

# --- Stage into src-tauri/binaries/ with the triple suffix ------------------
if (-not (Test-Path $sidecarDir)) {
    New-Item -ItemType Directory -Force -Path $sidecarDir | Out-Null
}
$dest = Join-Path $sidecarDir "$baseName-$TargetTriple$exeSuffix"
Copy-Item -Path $builtBinary -Destination $dest -Force

Write-Host "==> Sidecar staged:" -ForegroundColor Green
Write-Host "    $dest"
Write-Host "    (referenced by tauri.conf.json -> bundle.externalBin: binaries/$baseName)" -ForegroundColor DarkGray
