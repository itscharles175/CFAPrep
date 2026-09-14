#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/services/lsat-backend"
QA_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/studyvault-vizier-lsat.XXXXXX")"
BACKEND_PID=""
PREVIEW_PID=""

assert_port_free() {
  local port="$1"
  if /usr/bin/env python3 - "$port" <<'PY'
import socket
import sys

port = int(sys.argv[1])
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
    probe.settimeout(0.2)
    if probe.connect_ex(("127.0.0.1", port)) == 0:
        raise SystemExit(0)
raise SystemExit(1)
PY
  then
    echo "StudyVault Vizier refused to reuse occupied port $port; stop the stale QA stack and retry." >&2
    exit 1
  fi
}

cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$PREVIEW_PID" ]]; then
    kill -TERM "$PREVIEW_PID" 2>/dev/null || true
    wait "$PREVIEW_PID" 2>/dev/null || true
  fi
  if [[ -n "$BACKEND_PID" ]]; then
    kill -TERM "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  rm -rf "$QA_DATA_DIR"
}
trap cleanup EXIT INT TERM

# A stale Vite preview can satisfy Vizier's baseUrl readiness probe even when a
# new managed launch failed. Refuse that state before starting either child so
# every capture is tied to the bundle built by the current check.
assert_port_free 8100
assert_port_free 5198

(
  cd "$BACKEND"
  LSATLAB_DATA_DIR="$QA_DATA_DIR" \
  LSATLAB_PORT=8100 \
  STUDYVAULT_STRICT_OFFLINE=1 \
  STUDYVAULT_DISABLE_CLOUD_EGRESS=1 \
  exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8100
) &
BACKEND_PID=$!

for _attempt in {1..150}; do
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    wait "$BACKEND_PID"
  fi
  if curl -fsS --max-time 1 http://127.0.0.1:8100/api/health >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
curl -fsS --max-time 2 http://127.0.0.1:8100/api/health >/dev/null

cd "$ROOT"
node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5198 --strictPort &
PREVIEW_PID=$!
wait "$PREVIEW_PID"
