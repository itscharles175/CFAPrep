'use strict';

const { spawnSync } = require('node:child_process');
const { readFileSync, writeSync } = require('node:fs');
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

// Written synchronously so the line survives the process.exit(0) that ends a
// reap; a buffered process.stderr write into the parent's pipe would be dropped.
function writeDiagnostic(line) {
  try {
    writeSync(2, `${line}\n`);
  } catch {
    // The parent already closed its end of the pipe; the reap still proceeds.
  }
}

// PID-reuse fingerprint for POSIX, captured at track time and re-read before the
// kill. Linux publishes the process start time as field 22 of /proc/<pid>/stat;
// the comm field can itself contain spaces and parentheses, so the numeric
// fields only start after the LAST ')'. macOS and the BSDs expose no comparably
// cheap source (`ps -o lstart=` costs a process spawn per tracked pid), so they
// return null, which disables the guard and keeps the pre-existing residual
// risk: a stale entry could SIGKILL an unrelated process that reused the pid.
function posixStartFingerprint(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
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

// Deliberately called ONCE, from the reap: the CIM query was measured at
// 3.8-7.5s, so running it on the 1500ms parent probe meant back-to-back queries
// burning CPU for the life of the app. Descendants are only needed at reap time.
function discoverOwnedDescendants() {
  if (process.platform !== 'win32' || ownedProcesses.size === 0) return null;
  const snapshot = windowsProcessSnapshot();
  if (snapshot === null) {
    writeDiagnostic('watchdog_snapshot_unavailable: reaping tracked roots without descendant discovery');
    return null;
  }

  for (const [pid, record] of ownedProcesses) {
    if (record.startFingerprint !== null) continue;
    const current = snapshot.get(pid);
    // Never untrack on a snapshot inconsistency: dropping the entry here is what
    // turned a transient WMI hiccup into a leaked sidecar holding its port, which
    // then blocks the next boot. Leave the root unrefined instead.
    if (!current || current.parentPid !== parentPid) continue;
    record.startFingerprint = current.creationDate;
  }

  let added = true;
  while (added) {
    added = false;
    for (const [pid, details] of snapshot) {
      if (ownedProcesses.has(pid) || !ownedProcesses.has(details.parentPid)) continue;
      ownedProcesses.set(pid, {
        startFingerprint: details.creationDate,
        rootPid: ownedProcesses.get(details.parentPid).rootPid,
      });
      added = true;
    }
  }
  return snapshot;
}

function killOwnedTree(pid, snapshot) {
  const record = ownedProcesses.get(pid);
  if (!record || !isAllowedPid(pid)) return;
  if (process.platform === 'win32') {
    const current = snapshot?.get(pid);
    // An explicitly tracked ROOT was verified alive and parented by us at track
    // time, so only a snapshot that POSITIVELY identifies the pid as another
    // process may veto its kill. A missing, stale, or unavailable snapshot must
    // not: that silent no-op leaked every tracked sidecar. DISCOVERED
    // descendants exist only because a snapshot reported them, so they still
    // require that same snapshot to confirm them.
    if (record.rootPid === pid) {
      if (current && current.parentPid !== parentPid) return;
      if (current && record.startFingerprint !== null && current.creationDate !== record.startFingerprint) return;
    } else if (!current || current.creationDate !== record.startFingerprint) {
      return;
    }
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 10_000,
    });
    return;
  }
  if (record.startFingerprint !== null && posixStartFingerprint(pid) !== record.startFingerprint) return;
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
      ownedProcesses.set(message.pid, { startFingerprint: null, rootPid: message.pid });
    } else {
      ownedProcesses.set(message.pid, {
        startFingerprint: posixStartFingerprint(message.pid),
        rootPid: message.pid,
      });
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

// Parent death is already detected within ~100ms by the stdin 'close' above;
// this poll is only the backstop for a parent that dies without the pipe
// closing. It stays a bare process.kill(pid, 0) syscall on purpose — descendant
// discovery is deferred to the reap so the interval costs nothing.
const parentProbe = setInterval(() => {
  if (!parentIsAlive()) reapAndExit();
}, 1500);
parentProbe.unref?.();

process.stdout.write('STUDYVAULT_WATCHDOG_READY\n');
