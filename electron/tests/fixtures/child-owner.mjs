// Fixture for the liveness-poll crash test. Stands in for the Electron main
// process ONLY as the owner of a sidecar: it spawns a long-lived child, reports
// the pid, and idles. It deliberately does NOT start a watchdog — the test owns
// that, so the watchdog's stdin stays open when this process is killed and the
// reap can only come from the liveness poll rather than the stdin-close path.
//
// The child must genuinely be a child of THIS process: the watchdog refuses to
// kill a tracked pid the OS reports as parented elsewhere.
//
// `detached: true` on EVERY platform, deliberately diverging from how the sidecar
// manager spawns (`detached: false` on win32). Non-detached Windows children are
// reaped by libuv's own job object the moment this process dies, which would make
// the test pass whether or not the watchdog did anything — verified by mutation:
// disabling the liveness poll left a non-detached child dying anyway. Detaching
// puts the child outside that job so the watchdog is the only thing that can kill
// it, which is the whole point of the test.
//
// Not named *.test.mjs so the `electron/tests/**/*.test.mjs` runner ignores it.
import { spawn } from 'node:child_process';
import process from 'node:process';

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
child.unref();

process.stdout.write(`${JSON.stringify({ childPid: child.pid })}\n`);

setInterval(() => {}, 1000);
