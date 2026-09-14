import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import process from 'node:process';
import readline from 'node:readline';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { buildNativeWatchdog } from '../../scripts/build-native-watchdog.mjs';

const require = createRequire(import.meta.url);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitUntilGone(pid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await delay(50);
  }
  throw new Error(`PID ${pid} remained alive after ${timeoutMs}ms`);
}

test('native watchdog survives Electron main SIGKILL and reaps its tracked sidecar', { timeout: 30_000 }, async (t) => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    t.skip('The personal native watchdog is an Apple Silicon macOS executable');
    return;
  }

  const { path: watchdogPath } = await buildNativeWatchdog();
  const electronBinary = require('electron');
  const fixture = fileURLToPath(new URL('./fixtures/native-watchdog-electron-parent.mjs', import.meta.url));
  const parent = spawn(electronBinary, [fixture], {
    env: {
      ...process.env,
      STUDYVAULT_NATIVE_WATCHDOG: watchdogPath,
      STUDYVAULT_NODE_BINARY: process.execPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let tracked = null;
  t.after(async () => {
    for (const pid of [tracked?.sidecarPid, tracked?.watchdogPid, parent.pid]) {
      if (Number.isSafeInteger(pid) && isAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Best-effort cleanup after the assertion path.
        }
      }
    }
  });

  const lines = readline.createInterface({ input: parent.stdout, crlfDelay: Infinity });
  const stderr = [];
  parent.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  const [line] = await Promise.race([
    once(lines, 'line'),
    delay(10_000).then(() => { throw new Error(`Electron fixture did not become ready: ${stderr.join('')}`); }),
  ]);
  tracked = JSON.parse(line);
  assert.equal(tracked.ready, true);
  assert.equal(isAlive(tracked.watchdogPid), true);
  assert.equal(isAlive(tracked.sidecarPid), true);

  const parentExit = once(parent, 'exit');
  process.kill(parent.pid, 'SIGKILL');
  await parentExit;
  await Promise.all([waitUntilGone(tracked.sidecarPid), waitUntilGone(tracked.watchdogPid)]);
});
