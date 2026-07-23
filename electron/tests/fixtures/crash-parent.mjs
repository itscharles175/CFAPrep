// Fixture for the end-to-end crash-path test. Plays the role of the Electron main
// process: starts the owned-child watchdog, spawns a long-lived grandchild, tracks
// it, then idles forever. The test SIGKILLs this process — no graceful close, no
// stopAll — and asserts the grandchild still dies.
//
// Not named *.test.mjs so the `electron/tests/**/*.test.mjs` runner ignores it.
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { OwnedChildWatchdog } from '../../watchdog.js';

const quietLogger = { info() {}, warn() {}, error() {}, crash() {} };
const scriptPath = path.join(fileURLToPath(new URL('../../', import.meta.url)), 'child-watchdog.cjs');

const watchdog = await OwnedChildWatchdog.start({ scriptPath, logger: quietLogger });

// A bare interval keeps the grandchild alive with no exit path of its own, so if
// it dies it can only be because something reaped it.
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: process.platform !== 'win32',
  stdio: 'ignore',
  windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});

await watchdog.track(grandchild.pid);

// The test waits on this line before killing us, so tracking is guaranteed to have
// completed first — otherwise the reap could be a false pass from a race.
process.stdout.write(`${JSON.stringify({ grandchildPid: grandchild.pid })}\n`);

setInterval(() => {}, 1000);
