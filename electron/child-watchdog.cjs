'use strict';

/* global process */
const { spawnSync } = require('node:child_process');
const readline = require('node:readline');
const { setInterval } = require('node:timers');

const parentPid = Number(process.argv[2]);
if (!Number.isSafeInteger(parentPid) || parentPid < 1 || parentPid === process.pid) process.exit(2);

const ownedProcesses = new Map();
let finishing = false;

function isAllowedPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0 && pid !== parentPid && pid !== process.pid;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function windowsProcessSnapshot() {
  if (process.platform !== 'win32') return null;
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate -OperationTimeoutSec 5 | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress',
    ],
    {
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.status !== 0 || !result.stdout.trim()) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return new Map(
      rows
        .filter((row) => isAllowedPid(Number(row.ProcessId)))
        .map((row) => [
          Number(row.ProcessId),
          {
            parentPid: Number(row.ParentProcessId),
            creationDate: String(row.CreationDate ?? ''),
          },
        ]),
    );
  } catch {
    return null;
  }
}

function discoverOwnedDescendants(snapshot = windowsProcessSnapshot()) {
  if (process.platform !== 'win32' || snapshot === null) return snapshot;

  for (const [pid, record] of ownedProcesses) {
    if (record.creationDate !== null) continue;
    const current = snapshot.get(pid);
    if (!current || current.parentPid !== parentPid) {
      ownedProcesses.delete(pid);
      continue;
    }
    record.creationDate = current.creationDate;
  }

  let added = true;
  while (added) {
    added = false;
    for (const [pid, details] of snapshot) {
      if (ownedProcesses.has(pid) || !ownedProcesses.has(details.parentPid)) continue;
      ownedProcesses.set(pid, {
        creationDate: details.creationDate,
        rootPid: ownedProcesses.get(details.parentPid).rootPid,
      });
      added = true;
    }
  }
  return snapshot;
}

function killOwnedTree(pid, snapshot) {
  if (!ownedProcesses.has(pid) || !isAllowedPid(pid)) return;
  if (process.platform === 'win32') {
    const current = snapshot?.get(pid);
    const record = ownedProcesses.get(pid);
    if (!current) return;
    if (record.creationDate === null) {
      if (current.parentPid !== parentPid) return;
      record.creationDate = current.creationDate;
    }
    if (current.creationDate !== record.creationDate) return;
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 10_000,
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // The explicitly tracked process has already exited.
      }
    }
  }
}

function reapAndExit() {
  if (finishing) return;
  finishing = true;
  const snapshot = discoverOwnedDescendants();
  for (const pid of ownedProcesses.keys()) killOwnedTree(pid, snapshot);
  ownedProcesses.clear();
  process.exit(0);
}

function parentIsAlive() {
  try {
    process.kill(parentPid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function respond(id, ok, callback) {
  if (!Number.isSafeInteger(id) || id < 1) return;
  process.stdout.write(`${JSON.stringify({ id, ok })}\n`, callback);
}

const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message?.op === 'track' && isAllowedPid(message.pid)) {
    if (process.platform === 'win32') {
      if (!isProcessAlive(message.pid)) {
        respond(message.id, false);
        return;
      }
      ownedProcesses.set(message.pid, { creationDate: null, rootPid: message.pid });
    } else {
      ownedProcesses.set(message.pid, { creationDate: 'owned', rootPid: message.pid });
    }
    respond(message.id, true);
  } else if (message?.op === 'untrack' && isAllowedPid(message.pid)) {
    for (const [pid, record] of ownedProcesses) {
      if (record.rootPid === message.pid) ownedProcesses.delete(pid);
    }
    respond(message.id, true);
  } else if (message?.op === 'shutdown') {
    respond(message.id, true, reapAndExit);
  } else {
    respond(message?.id, false);
  }
});
reader.on('close', reapAndExit);
process.stdin.on('end', reapAndExit);
process.stdin.on('error', reapAndExit);

if (process.platform === 'win32' && windowsProcessSnapshot() === null) process.exit(3);

const parentProbe = setInterval(() => {
  if (ownedProcesses.size > 0) discoverOwnedDescendants();
  if (!parentIsAlive()) reapAndExit();
}, 1500);
parentProbe.unref?.();

process.stdout.write('STUDYVAULT_WATCHDOG_READY\n');
