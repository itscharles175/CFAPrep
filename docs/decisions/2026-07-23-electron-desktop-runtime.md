# Desktop Runtime: Tauri 2 → Electron

> Status: Accepted.
> Date: 2026-07-23.
> Implemented by commit `264fe5e` ("feat: migrate desktop runtime to Electron").
> Pre-migration tree readable at `353ef67`.

## Decision

StudyVault's desktop shell is Electron. The Tauri 2 shell and its Rust crate
(`src-tauri/`) were deleted, not deprecated in place; `package.json main` points
at `electron/main.js`, packaging runs through `electron-builder.yml`, and the
supervisor that owns the Python/SurrealDB sidecars is
`electron/sidecar-manager.js`.

The frontend's desktop seam moved with it: `src/domains/lsat/lib/tauri.ts` was
replaced by `src/domains/lsat/lib/electron.ts` plus the host-side
`src/lib/desktopBridge.ts`, and the renderer's only capability surface is the
fixed `window.studyvault` contract exposed from `electron/preload.cjs`.

## Rationale

The commit records no written rationale, so this record does not invent one.
What the change itself supports:

- **One toolchain.** The shell is now written in the same language and tested by
  the same runner as the rest of the repo (`node --test`). Building, linting, or
  testing the desktop boundary no longer requires a Rust toolchain; the stack
  doctor's `cargo`/`rustc` probes were replaced by an `electron-builder` probe.
- **A smaller shell to review.** `src-tauri/src/` was ~6,400 lines of Rust
  (supervisor, identity, port sweep, keychain, relocation, crash report, and
  their inline `#[cfg(test)]` modules) plus a 5,500-line `Cargo.lock`. The Electron
  main process is a set of small single-purpose modules (`protocol.js`,
  `path-policy.js`, `window-security.js`, `contracts.js`, `sidecar-manager.js`,
  `provenance.js`, `keychain.js`) with an explicit IPC request/response validator.
- **Declarative packaging hardening.** `scripts/apply-electron-fuses.mjs` runs as
  the `afterPack` hook and requires an explicit value for every Electron fuse, so
  an Electron upgrade that adds an unreviewed option fails packaging instead of
  defaulting silently.

The offline invariant is unchanged: sidecars stay on loopback, `crashReporter`
runs with `uploadToServer: false`, and automatic updates remain disabled.

## What was lost

The migration deleted real, tested guarantees. Naming them is the point of this
record.

1. **The Rust supervisor test suite.** `src-tauri/src/` carried ~137
   `#[test]`/`#[tokio::test]` functions (87 in `lib.rs`, 20 identity, 9 port
   sweep, 7 relocation, 6 crash report, 4 process group, 4 keychain) — the "136
   tests" the 2026 roadmaps cite as TEST-2 evidence. The replacement,
   `electron/tests/runtime.test.mjs`, was 21 `node --test` cases at migration
   time and is being rebuilt (53 as of 2026-07-23). Counts are not equivalent
   across runtimes; what matters is which behaviours are asserted, below.
2. **The kernel-enforced Windows Job Object.** `src-tauri/src/process_group.rs`
   explicitly created a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and
   called `AssignProcessToJobObject` for every child, with a `NoopGroup` fallback
   logged when the kernel call failed. No code creates a Job Object today; the
   mechanism survives only as libuv's implicit one (see below).
3. **`PR_SET_PDEATHSIG = SIGKILL` on Linux.** Children were armed so the kernel
   killed them the moment the supervisor died, crash or not. Nothing arms
   PDEATHSIG today, and that is the one guarantee with no equivalent.
4. **The Rust relocation and port-sweep modules** were deleted with the crate but
   have since been **ported back**: `electron/relocation.js` (from
   `src-tauri/src/relocation.rs`) and `electron/port-sweep.js`, both with runtime
   test coverage. Treat these as recovered, not lost.

## How the equivalent guarantees are provided now

- **Windows.** `electron/sidecar-manager.js` spawns children with
  `detached: process.platform !== 'win32'`, i.e. **non-detached on Windows**, so
  libuv's own per-process job object owns them and the OS tears them down when
  the main process dies. This is the same kernel mechanism as before, but it is
  now an *implicit consequence of a spawn flag* rather than an explicit,
  named, test-asserted policy — flipping that flag silently removes the guarantee.
- **All platforms.** `electron/watchdog.js` starts a detached Node sidecar
  (`electron/child-watchdog.cjs`) that tracks each owned child PID, polls
  `parentIsAlive()` every 1500 ms, and reaps the tracked tree (`taskkill /T /F`
  on Windows, `kill(-pid, SIGKILL)` on the process group elsewhere) when the
  parent disappears or its stdin closes. This is a userspace approximation of
  PDEATHSIG with a bounded reap delay, not a kernel guarantee.
- **Degraded, not blocked.** An unhealthy watchdog no longer stops the launch.
  `SidecarManager` sets `crashGuardDegraded`, logs
  `sidecar_crash_guard_degraded`, and surfaces `crash_guard_unavailable` as the
  boot's `degraded_reason` for a UI banner. The deliberate tradeoff: an
  infrastructure hiccup (EDR blocking PowerShell, corrupt WMI) must not make the
  app's core feature unusable — and on Windows the libuv job object still reaps
  the tree regardless. On Linux and macOS this degradation means **no** crash
  cleanup at all, which is the residual risk.
- **Ownership.** Termination is still restricted to trees the supervisor
  launched; an occupied expected port is retried on a bounded budget without
  terminating the occupant, and boot sweeps owned ports before the first launch.

## Verification debt

Both stack-upgrade roadmaps have been corrected to describe the Electron gate
rather than the deleted `tauri-rust` job. As of 2026-07-23 the relocation guard,
port sweep, keychain migration, and watchdog-degradation paths have Electron
coverage. What remains open:

- **Crash-path reaping is untested.** The watchdog tests exercise the *graceful*
  `watchdog.close()` path and the Windows snapshot-degradation path. Nothing
  kills the main process abruptly and asserts that the 1500 ms parent probe
  reaps the sidecars — the exact scenario the Job Object and PDEATHSIG covered,
  and the reason the Rust suite's `process_group` tests existed.
- **The non-detached Windows spawn is not pinned by a test.** `detached: false`
  on win32 is load-bearing (it is what makes crash-guard degradation tolerable
  there), and it is enforced only by a source comment. No assertion fails if it
  becomes unconditional.
- **No PDEATHSIG equivalent on Linux/macOS.** With the watchdog degraded, a
  crashed main process orphans sidecars outright on those platforms.

Closing these is a prerequisite before any roadmap item again claims the
supervisor's crash-safety is verified.

## Required Alignment

- Docs describing the desktop build, test, or packaging path must name Electron
  commands that exist in `package.json`. `npm run check:docs` enforces the
  structural half of this for `docs/ARCHITECTURE.md`.
- A future record must supersede this one if a Job Object, PDEATHSIG, or an
  equivalent kernel-enforced mechanism is reintroduced explicitly.
- `2026-07-05-lsat-sidecar-transport.md` is left as written. Its Decision still
  holds — the sidecar client boundary is unchanged — but its Follow-Up describes
  the packaged token handshake in Tauri terms; read that paragraph as superseded
  by this record. The handshake itself survived: the Electron main process
  generates the per-run token, passes it to the sidecar as
  `LSATLAB_LOCAL_API_TOKEN`, and the session injects it only for requests to the
  exact `http://127.0.0.1:8100` origin, so it never enters renderer JavaScript.
