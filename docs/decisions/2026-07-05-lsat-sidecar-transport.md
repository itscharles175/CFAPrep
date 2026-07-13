# LSAT Sidecar Transport Boundary

> Status: Accepted.
> Date: 2026-07-05.

## Decision

All production frontend calls to the LSAT backend sidecar must flow through an
approved client boundary:

- `src/domains/lsat/lib/api.ts` for the LSAT domain's typed API client.
- `src/lib/lsatBackend.ts` for host System Health/model-routing helpers.
- `src/lib/lsatSidecarClient.ts` for shared host-side transport and token
  injection.

`scripts/check-direct-sidecar-fetches.mjs` enforces this with an empty baseline.
Any new direct `127.0.0.1:8100` / `localhost:8100` `fetch()` outside those files
fails CI.

## Rationale

The sidecar boundary is where timeout behavior, offline degradation, and the
optional local API token all need to stay consistent. Keeping direct fetches out
of scattered hooks and bridge modules makes the local-first degraded mode easier
to audit and gives the future packaged Tauri token handshake one frontend
injection point.

## Follow-Up

The native tranche is now wired for packaged desktop runs: Tauri generates a
high-entropy per-run token, passes it to the LSAT backend as
`LSATLAB_LOCAL_API_TOKEN`, exposes it through a read-only command, and the
frontend bootstraps the in-memory browser value before `UnifiedRoot` mounts.
`VITE_LSATLAB_LOCAL_API_TOKEN` remains a dev-only fallback.
