'use strict';

const { spawnSync } = require('node:child_process');
const { readFileSync, writeSync } = require('node:fs');
const readline = require('node:readline');
const { setInterval } = require('node:timers');

const utilityParentPort = process.parentPort ?? null;

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

// Capture both parentage and a process-start fingerprint before accepting an
// owned PID. The same start fingerprint is checked immediately before reap, so
// PID reuse can never redirect a kill to an unrelated process.
function posixProcessIdentity(pid) {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return { parentPid: Number(fields[1]), startFingerprint: fields[19] ?? null };
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    const result = spawnSync('ps', ['-o', 'ppid=', '-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    if (result.status !== 0 || !result.stdout.trim()) return null;
    const match = result.stdout.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) return null;
    return { parentPid: Number(match[1]), startFingerprint: match[2] };
  }
  return null;
}

function posixStartFingerprint(pid) {
  return posixProcessIdentity(pid)?.startFingerprint ?? null;
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

// Tracking needs one process identity, not a machine-wide CIM inventory. The
// targeted query is substantially cheaper and lets the watchdog become ready
// even when a loaded CI host cannot complete the full descendant snapshot.
// Parentage and creation time are still captured before a PID is accepted.
function windowsProcessIdentity(pid) {
  if (process.platform !== 'win32' || !isAllowedPid(pid)) return null;
  const command =
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -OperationTimeoutSec 5; ` +
    "if ($null -ne $p) { $p | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress }";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 8000,
    maxBuffer: 64 * 1024,
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  try {
    const row = JSON.parse(result.stdout);
    const identity = {
      parentPid: Number(row.ParentProcessId),
      creationDate: String(row.CreationDate ?? ''),
    };
    return Number.isSafeInteger(identity.parentPid) && identity.creationDate ? identity : null;
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
  if (utilityParentPort) {
    utilityParentPort.postMessage({ id, ok });
    callback?.();
    return;
  }
  process.stdout.write(`${JSON.stringify({ id, ok })}\n`, callback);
}

function handleMessage(message) {
  if (message?.op === 'track' && isAllowedPid(message.pid)) {
    if (process.platform === 'win32') {
      const identity = windowsProcessIdentity(message.pid);
      if (!identity || identity.parentPid !== parentPid || !isProcessAlive(message.pid)) {
        respond(message.id, false);
        return;
      }
      ownedProcesses.set(message.pid, { startFingerprint: identity.creationDate, rootPid: message.pid });
    } else {
      const identity = posixProcessIdentity(message.pid);
      if (!identity || identity.parentPid !== parentPid || identity.startFingerprint === null) {
        respond(message.id, false);
        return;
      }
      ownedProcesses.set(message.pid, {
        startFingerprint: identity.startFingerprint,
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
}

if (utilityParentPort) {
  utilityParentPort.on('message', (event) => handleMessage(event?.data ?? event));
} else {
  const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  reader.on('line', (line) => {
    try {
      handleMessage(JSON.parse(line));
    } catch {
      // Ignore malformed control lines.
    }
  });
  reader.on('close', reapAndExit);
  process.stdin.on('end', reapAndExit);
  process.stdin.on('error', reapAndExit);
}

// Parent death is already detected within ~100ms by the stdin 'close' above;
// this poll is only the backstop for a parent that dies without the pipe
// closing. It stays a bare process.kill(pid, 0) syscall on purpose — descendant
// discovery is deferred to the reap so the interval costs nothing.
const parentProbe = setInterval(() => {
  if (!parentIsAlive()) reapAndExit();
}, 1500);
parentProbe.unref?.();

if (utilityParentPort) utilityParentPort.postMessage({ type: 'ready' });
else process.stdout.write('STUDYVAULT_WATCHDOG_READY\n');
