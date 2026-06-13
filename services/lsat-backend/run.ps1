# Launch the LSAT Lab backend on 127.0.0.1:8000.
# Usage:  .\run.ps1   (from the backend/ directory)
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
