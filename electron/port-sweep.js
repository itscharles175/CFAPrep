// Boot-time stale-port sweep (ported from src-tauri/src/port_sweep.rs).
//
// An orphaned sidecar that survived a hard kill still holds its loopback port,
// and a fresh launch cannot bind it. Without this sweep an occupied port is a
// permanent brick: the supervisor has no path back from "port occupied".
//
// Two deliberate departures from the Rust original, both toward safety:
//   * Discovery and kill sit behind an injectable sweeper so the orchestration
//     is unit-tested without touching the real process table.
//   * A readiness response proves service identity, not process ownership. A
//     listener is reclaimed only when its PID is in the caller's durable owned
//     process set; every unknown listener is reported and left running.
//
// The sweep never throws. A failure to enumerate or kill must not block launch.

import { execFile } from 'node:child_process';
import process from 'node:process';

export const SWEEP_COMMAND_TIMEOUT_MS = 5000;

export const SWEEP_OUTCOMES = Object.freeze({
  FREE: 'free',
  RECLAIMED: 'reclaimed',
  RECLAIM_FAILED: 'reclaim_failed',
  FOREIGN: 'foreign',
  UNIDENTIFIED: 'unidentified',
  SELF: 'self',
  UNRESOLVED: 'unresolved',
});

export function parseNetstatListeningPids(output, port) {
  const suffix = `:${port}`;
  const pids = [];
  for (const line of String(output).split(/\r?\n/)) {
    // netstat -ano TCP rows: Proto  Local  Foreign  State  PID
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5) continue;
    if (columns[0].toLowerCase() !== 'tcp') continue;
    // The `:` anchor keeps a query for :100 from matching a listener on :81000.
    if (!columns[1].endsWith(suffix)) continue;
    if (columns[3].toLowerCase() !== 'listening') continue;
    const pid = Number.parseInt(columns[4], 10);
    if (Number.isSafeInteger(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

export function parseLsofPids(output) {
  const pids = [];
  for (const line of String(output).split(/\r?\n/)) {
    const pid = Number.parseInt(line.trim(), 10);
    if (Number.isSafeInteger(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

export function runSweepCommand(file, args, timeoutMs = SWEEP_COMMAND_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      // A numeric exit code is a normal "no match" answer (lsof exits 1 when the
      // port is free); anything else — ENOENT, a timeout kill — means the tool
      // could not run at all and the port must be reported unresolved.
      resolve({
        ok: !error,
        available: !error || typeof error.code === 'number',
        stdout: typeof stdout === 'string' ? stdout : '',
      });
    });
  });
}

export function createSystemSweeper({
  platform = process.platform,
  runCommand = runSweepCommand,
  killSignal = (pid) => process.kill(pid, 'SIGKILL'),
} = {}) {
  return {
    async pidsOnPort(port) {
      if (platform === 'win32') {
        const result = await runCommand('netstat', ['-ano']);
        return result.available ? parseNetstatListeningPids(result.stdout, port) : null;
      }
      const result = await runCommand('lsof', ['-ti', `:${port}`, '-sTCP:LISTEN']);
      return result.available ? parseLsofPids(result.stdout) : null;
    },
    async kill(pid) {
      if (platform === 'win32') {
        // /T kills the descendant tree: a frozen `uv` tree outlives its root.
        const result = await runCommand('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
        return result.ok;
      }
      try {
        killSignal(pid);
        return true;
      } catch (error) {
        // Already gone is the outcome we wanted.
        return error?.code === 'ESRCH';
      }
    },
  };
}

async function sweepTarget(target, { sweeper, identityProbe, protectedPids, ownedPids }) {
  const result = { name: target.name ?? null, port: target.port, outcome: SWEEP_OUTCOMES.FREE, pids: [] };
  const listeners = await sweeper.pidsOnPort(target.port);
  if (listeners === null || listeners === undefined) {
    result.outcome = SWEEP_OUTCOMES.UNRESOLVED;
    return result;
  }
  const unique = [...new Set(listeners.filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  if (unique.length === 0) return result;

  const foreign = unique.filter((pid) => !protectedPids.has(pid));
  if (foreign.length === 0) {
    result.outcome = SWEEP_OUTCOMES.SELF;
    result.pids = unique;
    return result;
  }
  result.pids = foreign;

  if (foreign.some((pid) => !ownedPids.has(pid))) {
    if (!target.identity || !identityProbe) {
      result.outcome = SWEEP_OUTCOMES.UNIDENTIFIED;
      return result;
    }
    result.outcome = (await identityProbe(target.identity, target.port))
      ? SWEEP_OUTCOMES.UNIDENTIFIED
      : SWEEP_OUTCOMES.FOREIGN;
    return result;
  }

  let reclaimed = true;
  for (const pid of foreign) {
    if (!(await sweeper.kill(pid))) reclaimed = false;
  }
  result.outcome = reclaimed ? SWEEP_OUTCOMES.RECLAIMED : SWEEP_OUTCOMES.RECLAIM_FAILED;
  return result;
}

export async function sweepOwnedPorts({
  targets = [],
  sweeper = null,
  identityProbe = null,
  selfPids = [process.pid],
  ownedPids = [],
  logger = null,
} = {}) {
  const resolvedSweeper = sweeper ?? createSystemSweeper();
  const protectedPids = new Set(selfPids.filter((pid) => Number.isSafeInteger(pid) && pid > 0));
  const reclaimablePids = new Set(ownedPids.filter((pid) => Number.isSafeInteger(pid) && pid > 0));
  const results = [];
  const seen = new Set();
  for (const target of targets) {
    if (!Number.isSafeInteger(target?.port) || seen.has(target.port)) continue;
    seen.add(target.port);
    let result;
    try {
      result = await sweepTarget(target, {
        sweeper: resolvedSweeper,
        identityProbe,
        protectedPids,
        ownedPids: reclaimablePids,
      });
    } catch (error) {
      // Isolated per port: one unusable platform tool cannot abort the rest, and
      // no sweep failure is ever allowed to reach the launch path.
      result = { name: target.name ?? null, port: target.port, outcome: SWEEP_OUTCOMES.UNRESOLVED, pids: [] };
      logger?.warn('port_sweep_failed', { name: result.name, port: result.port, error });
    }
    results.push(result);
    const level = result.outcome === SWEEP_OUTCOMES.FREE ? 'info' : 'warn';
    logger?.[level]?.('port_sweep', result);
  }
  return results;
}
