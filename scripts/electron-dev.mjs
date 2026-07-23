#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import electronPath from 'electron';

const repoRoot = resolve(import.meta.dirname, '..');
const viteEntry = resolve(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173';

if (!existsSync(viteEntry)) {
  throw new Error('Vite is not installed. Run npm install first.');
}

const children = new Set();
let stopping = false;

function start(command, args, env = process.env) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for Vite at ${url}`);
}

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exitCode = exitCode;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(0));
}

const vite = start(process.execPath, [viteEntry, '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
  ...process.env,
  VITE_OPEN_BROWSER: '0',
});

vite.once('exit', (code) => {
  if (!stopping) stop(code ?? 1);
});

try {
  await waitForServer(devUrl);
  const electron = start(electronPath, ['.'], {
    ...process.env,
    VITE_DEV_SERVER_URL: devUrl,
  });
  electron.once('exit', (code) => stop(code ?? 0));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  stop(1);
}
