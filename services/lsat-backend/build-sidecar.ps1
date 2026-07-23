<#
.SYNOPSIS
    Build the LSAT Lab backend into a self-contained executable and stage it as
    an Electron extra resource.

.DESCRIPTION
    1. Runs PyInstaller against lsatlab.spec to freeze the FastAPI backend
       (entry point: sidecar_main.py) into backend/dist/lsatlab-backend[.exe].
    2. Copies the frozen binary into
       electron/resources/services/lsat-backend/ using its platform-native
       executable suffix. electron-builder stages that directory unchanged.

.PARAMETER PythonRunner
    How to invoke PyInstaller. Defaults to "uv run" so the project's locked
    environment is used; pass "python -m" if you've installed PyInstaller into
    an already-active venv.

.EXAMPLE
    ./build-sidecar.ps1
    # Builds for the host platform using `uv run pyinstaller`.
#>
[CmdletBinding()]
param(
    [string]$PythonRunner = "uv run"
)

$ErrorActionPreference = "Stop"
$backendDir = $PSScriptRoot
$sidecarDir = Join-Path $backendDir "..\..\electron\resources\services\lsat-backend"
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

# Windows builds carry the .exe suffix on both the source and destination.
$exeSuffix = if ($IsWindows -or $env:OS -eq "Windows_NT") { ".exe" } else { "" }

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

# --- Stage into Electron's packaged services directory ----------------------
if (-not (Test-Path $sidecarDir)) {
    New-Item -ItemType Directory -Force -Path $sidecarDir | Out-Null
}
$dest = Join-Path $sidecarDir "$baseName$exeSuffix"
Copy-Item -Path $builtBinary -Destination $dest -Force

Write-Host "==> Sidecar staged:" -ForegroundColor Green
Write-Host "    $dest"
Write-Host "    (staged by electron-builder extraResources)" -ForegroundColor DarkGray
