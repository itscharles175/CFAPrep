// Crash-path coverage for the owned-child watchdog.
//
// The existing reap test in runtime.test.mjs drives `watchdog.close()`, which is
// the GRACEFUL path: close() ends the child's stdin and the child reaps from
// `reader.on('close')`. That is the shutdown a normal quit takes, and it is not
// the reason the watchdog exists. The crash guard exists for the case where the
// main process dies without running any code — SIGKILL, Task Manager, a renderer
// OOM taking the app down — leaving the sidecars parented to nothing.
//
// Under Tauri that case was covered by a kernel primitive with its own test
// (`windows_job_object_kills_assigned_child_on_drop`). The migration replaced it
// with a userland watchdog and did not replace the test, so the whole point of
// the component was unverified. These tests close that gap from both directions:
// the liveness-poll mechanism in isolation, and a real SIGKILL end to end.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { OwnedChildWatchdog } from '../watchdog.js';

const quietLogger = { info() {}, warn() {}, error() {}, crash() {} };
const electronDir = fileURLToPath(new URL('..', import.meta.url));
const watchdogScript = path.join(electronDir, 'child-watchdog.cjs');

// Sized off the watchdog's own worst case rather than an observed happy path: the
// win32 reap runs a Win32_Process CIM snapshot (spawnSync timeout 8s) and then a
// taskkill per tracked root (10s), and the liveness poll only ticks every 1500ms.
// A tighter budget fails on a loaded machine while the implementation is correct.
const REAP_BUDGET_MS = 60_000;
const POLL_INTERVAL_MS = 250;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to someone else — still alive.
    return error?.code === 'EPERM';
  }
}

async function waitForDeath(pid, budgetMs = REAP_BUDGET_MS) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await delay(POLL_INTERVAL_MS);
  }
  return false;
}

function spawnDisposable() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
}

function killIfAlive(child) {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

function spawnFixture(name) {
  return spawn(process.execPath, [path.join(electronDir, 'tests', 'fixtures', name)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
}

// Fixtures report their spawned pid on stdout once setup is complete. Waiting for
// that line before killing anything keeps a reap from being a false pass produced
// by killing the fixture mid-setup.
async function firstLine(child, stderrSink) {
  const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const line = await Promise.race([
    once(reader, 'line').then(([value]) => value),
    once(child, 'exit').then(() => null),
    delay(REAP_BUDGET_MS).then(() => null),
  ]);
  reader.close();
  assert.ok(line, `fixture never reported a pid. stderr: ${stderrSink.join('')}`);
  return JSON.parse(line);
}

function collectStderr(child) {
  const chunks = [];
  child.stderr.on('data', (chunk) => chunks.push(String(chunk)));
  return chunks;
}

test('the liveness poll alone reaps a tracked child after the guarded parent is SIGKILLed', async (t) => {
  // Isolates the poll (`parentIsAlive` -> `reapAndExit`) from the stdin-close
  // path: the watchdog is started by THIS process, so its stdin stays open for
  // the whole test, while the process it is told to guard is a separate fixture.
  // Killing that fixture leaves the pipe intact, so a reap can only come from the
  // poll noticing the parent is gone.
  const owner = spawnFixture('child-owner.mjs');
  t.after(() => killIfAlive(owner));
  const ownerStderr = collectStderr(owner);
  const { childPid } = await firstLine(owner, ownerStderr);

  const watchdog = await OwnedChildWatchdog.start({
    scriptPath: watchdogScript,
    logger: quietLogger,
    parentPid: owner.pid,
  });
  t.after(() => watchdog.close());
  await watchdog.track(childPid);

  assert.equal(isAlive(childPid), true, 'tracked child should be alive before the parent dies');

  owner.kill('SIGKILL');
  await once(owner, 'exit');

  assert.equal(
    await waitForDeath(childPid),
    true,
    `tracked child ${childPid} survived its parent being SIGKILLed — the liveness poll is not reaping`,
  );
});

test('the watchdog refuses to kill a tracked pid the OS says is not its parent’s child', async (t) => {
  // The ownership guard, and the reason the poll test above needs a real
  // parent/child pair. A pid can be tracked in error, or reused by an unrelated
  // process between track and reap; killing on the tracked pid alone would then
  // take down something that was never ours. The watchdog only vetoes on a
  // snapshot that POSITIVELY identifies the pid as parented elsewhere — a missing
  // or unavailable snapshot must still reap, which is the leak fixed separately.
  if (process.platform !== 'win32') {
    t.skip('Parentage is established from the Win32_Process snapshot; POSIX uses the start fingerprint');
    return;
  }

  const owner = spawnFixture('child-owner.mjs');
  t.after(() => killIfAlive(owner));
  const ownerStderr = collectStderr(owner);
  await firstLine(owner, ownerStderr);

  // Parented by the TEST, never by `owner` — exactly the state the guard exists
  // to refuse.
  const bystander = spawnDisposable();
  t.after(() => killIfAlive(bystander));
  await once(bystander, 'spawn');

  const watchdog = await OwnedChildWatchdog.start({
    scriptPath: watchdogScript,
    logger: quietLogger,
    parentPid: owner.pid,
  });
  t.after(() => watchdog.close());
  await watchdog.track(bystander.pid);

  owner.kill('SIGKILL');
  await once(owner, 'exit');

  // Give the reap the same budget the positive cases get, then assert the
  // bystander is STILL alive.
  await delay(20_000);
  assert.equal(
    isAlive(bystander.pid),
    true,
    `the watchdog killed pid ${bystander.pid}, which the OS reports as parented by this test rather than by ` +
      'the process it was guarding — the ownership guard is not holding',
  );
});

test('a SIGKILLed main process does not orphan its sidecar grandchild', async (t) => {
  // End-to-end shape of the real failure, using the sidecar manager's OWN spawn
  // options (`detached: false` on win32). Nothing in the killed process gets to
  // run — no before-quit, no stopAll, no close.
  //
  // What this proves is the user-facing guarantee — a hard-killed app leaves no
  // sidecar holding :8100 — NOT that the watchdog delivered it. On Windows libuv
  // puts non-detached children in a KILL_ON_JOB_CLOSE job, so the OS reaps them
  // first; confirmed by mutation, this test still passes with the liveness poll
  // disabled. The watchdog itself is covered by the detached-child test above.
  // Both matter: the job object is what actually protects Windows users today,
  // and it is an undocumented libuv side effect that this test pins in place.
  const parent = spawnFixture('crash-parent.mjs');
  t.after(() => killIfAlive(parent));
  const stderr = collectStderr(parent);

  const { grandchildPid } = await firstLine(parent, stderr);
  assert.equal(isAlive(grandchildPid), true, 'grandchild should be alive before the crash');

  parent.kill('SIGKILL');
  await once(parent, 'exit');

  assert.equal(
    await waitForDeath(grandchildPid),
    true,
    `grandchild ${grandchildPid} outlived a SIGKILLed parent — this is the orphaned-sidecar defect the ` +
      'watchdog replaced the Windows Job Object to prevent',
  );
});
