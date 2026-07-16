import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import net from 'node:net';
import process from 'node:process';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { SERVICE_NAMES } from './service-specs.js';
import { verifyServiceProvenance } from './provenance.js';
import { isPathWithin } from './path-policy.js';

export const LOG_RING_CAPACITY = 500;
export const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPAWNS = 6;

export function createLsatToken() {
  return randomBytes(32).toString('hex');
}

export function respawnBackoffMs(failures, baseMs = 7000, capMs = 300_000) {
  const shift = Math.max(0, Math.min(6, failures - 1));
  return Math.min(baseMs * 2 ** shift, capMs);
}

export function portLaunchDecision(occupied, port) {
  return occupied
    ? { blocked: true, reason: `Port ${port} is already occupied by an unknown listener` }
    : { blocked: false, reason: null };
}

export function redactSidecarLine(line, secrets = []) {
  let output = String(line);
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join('[redacted]');
  }
  output = output.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi, '$1[redacted]');
  output = output.replace(/((?:token|secret|password|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]');
  return output.slice(0, 16_384);
}

export function aggregateSidecarHealth(rows) {
  const requiredDownNames = rows.filter((row) => !row.ready && !row.optional).map((row) => row.name);
  const optionalDown = rows.filter((row) => !row.ready && row.optional).length;
  return {
    status: requiredDownNames.length > 0 ? 'error' : optionalDown > 0 ? 'degraded' : 'ok',
    ready: rows.filter((row) => row.ready).length,
    required_down: requiredDownNames.length,
    optional_down: optionalDown,
    total: rows.length,
    required_down_names: requiredDownNames,
  };
}

export async function ensureDirectoryWithinRoot(directory, root) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Data directory is not a regular directory: ${directory}`);
  }
  const canonicalRoot = await realpath(root);
  const canonicalDirectory = await realpath(directory);
  if (!isPathWithin(canonicalRoot, canonicalDirectory)) {
    throw new Error(`Data directory escaped its authorized root: ${directory}`);
  }
  return canonicalDirectory;
}

export function isPortListening(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export function matchesServiceIdentity(payload, expectedService) {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    payload.ok === true &&
    payload.service === expectedService
  );
}

export function probeHttpServiceIdentity(identity, port, timeoutMs = 750) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: identity.path,
        method: 'GET',
        headers: { Accept: 'application/json' },
        agent: false,
      },
      (response) => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          finish(false);
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 65_536) {
            response.destroy();
            finish(false);
            return;
          }
          chunks.push(chunk);
        });
        response.once('end', () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish(matchesServiceIdentity(payload, identity.service));
          } catch {
            finish(false);
          }
        });
        response.once('error', () => finish(false));
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      finish(false);
    });
    request.once('error', () => finish(false));
    request.end();
  });
}

function initialRecord(spec) {
  return {
    spec,
    child: null,
    state: 'pending',
    blockReason: null,
    provenanceStatus: null,
    present: true,
    restartCount: 0,
    respawnTimer: null,
    everLaunched: false,
  };
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export async function terminateSpawnedTree(child, platform = process.platform) {
  if (!child || child.pid === undefined || child.exitCode !== null) return;
  if (platform === 'win32') {
    const graceful = spawn('taskkill.exe', ['/PID', String(child.pid), '/T'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    await waitForChildExit(graceful, 2000);
    if (!(await waitForChildExit(child, 2000)) && child.exitCode === null) {
      const forced = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      await waitForChildExit(forced, 3000);
      await waitForChildExit(child, 3000);
    }
    return;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  if (!(await waitForChildExit(child, 3000))) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
}

export class SidecarManager {
  constructor({
    specs,
    servicesDirectory,
    lsatToken,
    logger,
    spawnProcess = spawn,
    portProbe = isPortListening,
    provenanceVerifier = verifyServiceProvenance,
    terminateTree = terminateSpawnedTree,
    readinessProbe = null,
    watchdog = null,
    readinessTimeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
    maxRespawns = DEFAULT_MAX_RESPAWNS,
  }) {
    this.records = new Map(specs.map((spec) => [spec.name, initialRecord(spec)]));
    this.servicesDirectory = servicesDirectory;
    this.lsatToken = lsatToken;
    this.logger = logger;
    this.spawnProcess = spawnProcess;
    this.portProbe = portProbe;
    this.provenanceVerifier = provenanceVerifier;
    this.terminateTree = terminateTree;
    this.readinessProbe =
      readinessProbe ??
      ((spec, timeoutMs) =>
        spec.readinessIdentity
          ? probeHttpServiceIdentity(spec.readinessIdentity, spec.readyPort, timeoutMs)
          : this.portProbe(spec.readyPort, timeoutMs));
    this.watchdog = watchdog;
    this.readinessTimeoutMs = readinessTimeoutMs;
    this.maxRespawns = maxRespawns;
    this.logs = new Map();
    this.stopping = false;
    this.healthTimer = null;
    this.healthTickRunning = false;
  }

  getAuthorizationTokenForRequest() {
    const record = this.records.get(SERVICE_NAMES.LSAT);
    if (record?.state !== 'ready' || !record.child || record.child.exitCode !== null) return null;
    return this.lsatToken;
  }

  async startAll() {
    this.stopping = false;
    for (const record of this.records.values()) await this.#startRecord(record, false);
    this.#startHealthSupervisor();
    return this.getBootStatus();
  }

  async #startRecord(record, isRespawn) {
    const { spec } = record;
    if (this.stopping) return;
    if (spec.launchBlockReason) {
      this.#blockOrSkip(record, 'blocked', spec.launchBlockReason, 'key_unavailable');
      return;
    }
    record.present = spec.resourcePath ? existsSync(spec.resourcePath) : true;
    if (!record.present) {
      this.#blockOrSkip(record, spec.optional ? 'skipped' : 'blocked', 'Required service resource is missing');
      return;
    }

    const unavailableDependency = spec.dependsOn.find((name) => this.records.get(name)?.state !== 'ready');
    if (unavailableDependency) {
      this.#blockOrSkip(
        record,
        spec.optional ? 'skipped' : 'blocked',
        `Dependency is not ready: ${unavailableDependency}`,
      );
      return;
    }

    if (spec.readyPort !== null) {
      const decision = portLaunchDecision(await this.portProbe(spec.readyPort), spec.readyPort);
      if (decision.blocked) {
        this.#blockOrSkip(record, 'blocked', decision.reason, 'port_occupied');
        return;
      }
    }

    const provenance = await this.provenanceVerifier(spec, this.servicesDirectory);
    record.provenanceStatus = provenance.status;
    if (provenance.blocksLaunch) {
      this.#blockOrSkip(record, 'blocked', provenance.message, provenance.status);
      return;
    }
    if (!this.watchdog?.healthy) {
      this.#blockOrSkip(record, 'blocked', 'Crash-safe owned-child watchdog is unavailable', 'crash_guard_unavailable');
      return;
    }

    if (spec.name === SERVICE_NAMES.LSAT) {
      await ensureDirectoryWithinRoot(spec.env.LSATLAB_DATA_DIR, spec.dataRoot);
    }
    try {
      await this.#launch(record, isRespawn);
    } catch (error) {
      this.#blockOrSkip(record, 'blocked', `Launch failed: ${error.message}`, 'launch_error');
    }
  }

  #blockOrSkip(record, state, reason, provenanceStatus = null) {
    record.state = state;
    record.blockReason = reason;
    if (provenanceStatus) record.provenanceStatus = provenanceStatus;
    this.logger.warn('sidecar_not_launched', { name: record.spec.name, state, reason });
  }

  async #launch(record, isRespawn) {
    const { spec } = record;
    record.state = 'starting';
    record.blockReason = null;
    const child = this.spawnProcess(spec.program, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    let earlyExit = null;
    const captureEarlyExit = (code, signal) => {
      earlyExit = { code, signal };
    };
    child.once('exit', captureEarlyExit);
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    try {
      await this.watchdog.track(child.pid);
    } catch (error) {
      child.off('exit', captureEarlyExit);
      await this.terminateTree(child);
      throw new Error(`Crash guard refused child PID ${child.pid}`, { cause: error });
    }
    child.off('exit', captureEarlyExit);
    if (earlyExit || child.exitCode !== null) {
      await this.watchdog.untrack(child.pid);
      const exit = earlyExit ?? { code: child.exitCode, signal: child.signalCode };
      throw new Error(`Child exited before crash-guard registration completed (${exit.code ?? exit.signal})`);
    }
    record.child = child;
    record.everLaunched = true;
    this.#captureStream(record, child.stdout);
    this.#captureStream(record, child.stderr);
    child.once('exit', (code, signal) => this.#handleExit(record, child, code, signal));
    this.logger.info('sidecar_started', {
      name: spec.name,
      pid: child.pid,
      respawn: isRespawn,
    });

    if (spec.readyPort === null) {
      record.state = 'ready';
      return;
    }
    const ready = await this.#waitForReadiness(record, child);
    if (record.child !== child) return;
    if (ready) {
      record.state = 'ready';
      return;
    }

    record.state = 'degraded';
    record.blockReason = `Readiness timed out on port ${spec.readyPort}`;
    this.logger.error('sidecar_readiness_timeout', { name: spec.name, port: spec.readyPort });
    await this.terminateTree(child);
  }

  async #waitForReadiness(record, child) {
    const deadline = Date.now() + this.readinessTimeoutMs;
    while (Date.now() < deadline && child.exitCode === null && record.child === child && !this.stopping) {
      if (await this.readinessProbe(record.spec, 750)) return true;
      await delay(250);
    }
    return false;
  }

  #captureStream(record, stream) {
    if (!stream) return;
    const secrets = Object.entries(record.spec.env)
      .filter(([key, value]) => /token|secret|password|key/i.test(key) && value)
      .map(([, value]) => value);
    for (let index = 0; index < record.spec.args.length - 1; index += 1) {
      if (/^--(?:pass|password|secret|token|api-key)$/i.test(record.spec.args[index])) {
        secrets.push(record.spec.args[index + 1]);
      }
    }
    const reader = readline.createInterface({ input: stream });
    reader.on('line', (line) => {
      const redacted = redactSidecarLine(line, secrets);
      const ring = this.logs.get(record.spec.name) ?? [];
      if (ring.length >= LOG_RING_CAPACITY) ring.shift();
      ring.push(redacted);
      this.logs.set(record.spec.name, ring);
    });
  }

  #handleExit(record, child, code, signal) {
    if (record.child !== child) return;
    record.child = null;
    void this.watchdog?.untrack(child.pid).catch((error) => {
      this.logger.error('watchdog_untrack_failed', { name: record.spec.name, pid: child.pid, error });
    });
    this.logger.warn('sidecar_exited', { name: record.spec.name, pid: child.pid, code, signal });
    if (this.stopping) {
      record.state = 'stopped';
      return;
    }
    record.state = 'exited';
    record.blockReason = `Process exited (${code ?? signal ?? 'unknown'})`;
    this.#scheduleRespawn(record);
  }

  #scheduleRespawn(record) {
    if (record.restartCount >= this.maxRespawns) {
      this.#blockOrSkip(record, 'blocked', 'Respawn limit reached', 'respawn_exhausted');
      return;
    }
    record.restartCount += 1;
    record.state = 'backoff';
    const waitMs = respawnBackoffMs(record.restartCount);
    record.respawnTimer = setTimeout(() => {
      record.respawnTimer = null;
      void this.#startRecord(record, true);
    }, waitMs);
    record.respawnTimer.unref?.();
    this.logger.warn('sidecar_respawn_scheduled', {
      name: record.spec.name,
      attempt: record.restartCount,
      wait_ms: waitMs,
    });
  }

  #startHealthSupervisor() {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => void this.#healthTick(), 7000);
    this.healthTimer.unref?.();
  }

  async #healthTick() {
    if (this.stopping || this.healthTickRunning) return;
    this.healthTickRunning = true;
    try {
      for (const record of this.records.values()) {
        const child = record.child;
        if (record.state !== 'ready' || record.spec.readyPort === null || !child || child.exitCode !== null) {
          continue;
        }
        if (await this.readinessProbe(record.spec, 750)) continue;
        record.state = 'degraded';
        record.blockReason = `Health probe failed on port ${record.spec.readyPort}`;
        this.logger.warn('sidecar_health_probe_failed', {
          name: record.spec.name,
          port: record.spec.readyPort,
          pid: child.pid,
        });
        await this.terminateTree(child);
      }
    } finally {
      this.healthTickRunning = false;
    }
  }

  async getStatus() {
    const rows = [];
    for (const record of this.records.values()) {
      const childAlive = record.child !== null && record.child.exitCode === null;
      const healthy = childAlive && (record.spec.readyPort === null || (await this.readinessProbe(record.spec, 750)));
      const ready = record.state === 'ready' && healthy;
      rows.push({
        name: record.spec.name,
        port: record.spec.readyPort,
        ready_port: record.spec.readyPort,
        healthy,
        ready,
        depends_on: [...record.spec.dependsOn],
        pid: childAlive ? record.child.pid : null,
        optional: record.spec.optional,
        present: record.present,
        blocked: record.state === 'blocked',
        block_reason: record.blockReason,
        provenance_status: record.provenanceStatus,
        state: ready ? 'ready' : record.state === 'ready' ? 'degraded' : record.state,
        restart_count: record.restartCount,
      });
    }
    return rows;
  }

  getLogs(name) {
    return [...(this.logs.get(name) ?? [])];
  }

  async getAggregate() {
    return aggregateSidecarHealth(await this.getStatus());
  }

  async getBootStatus() {
    const rows = await this.getStatus();
    const aggregate = aggregateSidecarHealth(rows);
    const skippedNames = rows.filter((row) => row.state === 'skipped').map((row) => row.name);
    const blockedNames = rows.filter((row) => row.blocked).map((row) => row.name);
    return {
      status: aggregate.status,
      launched: [...this.records.values()].filter((record) => record.everLaunched).length,
      skipped: skippedNames.length,
      blocked: blockedNames.length,
      skipped_names: skippedNames,
      blocked_names: blockedNames,
      required_down_names: aggregate.required_down_names,
      degraded_reason:
        aggregate.status === 'error'
          ? `Required sidecar(s) not ready: ${aggregate.required_down_names.join(', ')}`
          : aggregate.status === 'degraded'
            ? `Optional feature(s) unavailable: ${[...skippedNames, ...blockedNames].join(', ')}`
            : '',
    };
  }

  async stopAll() {
    this.stopping = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    const terminations = [];
    for (const record of this.records.values()) {
      if (record.respawnTimer) clearTimeout(record.respawnTimer);
      record.respawnTimer = null;
      if (record.child && record.child.exitCode === null) {
        const child = record.child;
        terminations.push(
          this.terminateTree(child).catch((error) => {
            this.logger.error('sidecar_termination_failed', {
              name: record.spec.name,
              pid: child.pid,
              error,
            });
          }),
        );
      }
    }
    await Promise.all(terminations);
    for (const record of this.records.values()) {
      record.child = null;
      if (record.everLaunched) record.state = 'stopped';
    }
  }
}
