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
import { sweepOwnedPorts } from './port-sweep.js';
import { verifyServiceProvenance } from './provenance.js';
import { isPathWithin } from './path-policy.js';

export const LOG_RING_CAPACITY = 500;
export const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPAWNS = 6;
export const DEFAULT_MAX_PORT_RETRIES = 5;
export const DEFAULT_RESPAWN_BASE_MS = 7000;
export const DEFAULT_PORT_RETRY_BASE_MS = 1000;
export const DEFAULT_HEALTH_INTERVAL_MS = 7000;
export const CRASH_GUARD_UNAVAILABLE_REASON = 'crash_guard_unavailable';

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
    portRetryCount: 0,
    crashGuardDegraded: false,
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
    identityProbe = probeHttpServiceIdentity,
    portSweep = sweepOwnedPorts,
    watchdog = null,
    ownershipLedger = null,
    readinessTimeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
    maxRespawns = DEFAULT_MAX_RESPAWNS,
    maxPortRetries = DEFAULT_MAX_PORT_RETRIES,
    respawnBaseMs = DEFAULT_RESPAWN_BASE_MS,
    portRetryBaseMs = DEFAULT_PORT_RETRY_BASE_MS,
    healthIntervalMs = DEFAULT_HEALTH_INTERVAL_MS,
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
    this.identityProbe = identityProbe;
    this.portSweep = portSweep;
    this.watchdog = watchdog;
    this.ownershipLedger = ownershipLedger;
    this.readinessTimeoutMs = readinessTimeoutMs;
    this.maxRespawns = maxRespawns;
    this.maxPortRetries = maxPortRetries;
    this.respawnBaseMs = respawnBaseMs;
    this.portRetryBaseMs = portRetryBaseMs;
    this.healthIntervalMs = healthIntervalMs;
    this.logs = new Map();
    this.stopping = false;
    this.healthTimer = null;
    this.healthTickRunning = false;
    this.quiesced = false;
  }

  getAuthorizationTokenForRequest() {
    const record = this.records.get(SERVICE_NAMES.LSAT);
    if (record?.state !== 'ready' || !record.child || record.child.exitCode !== null) return null;
    return this.lsatToken;
  }

  async startAll() {
    this.stopping = false;
    this.quiesced = false;
    await this.#sweepStalePorts();
    for (const record of this.records.values()) await this.#startRecord(record, false);
    this.#startHealthSupervisor();
    return this.getBootStatus();
  }

  async recover(reason = 'resume') {
    this.stopping = false;
    this.quiesced = false;
    this.logger.info('sidecar_recovery_started', { reason });
    for (const record of this.records.values()) {
      if (record.respawnTimer) clearTimeout(record.respawnTimer);
      record.respawnTimer = null;
      const child = record.child;
      if (record.spec.launchBlockReason) {
        record.child = null;
        if (child && child.exitCode === null) {
          await this.watchdog?.untrack(child.pid).catch((error) => {
            this.logger.error('watchdog_untrack_failed', { name: record.spec.name, pid: child.pid, error });
          });
          await this.ownershipLedger?.untrack(child.pid).catch((error) => {
            this.logger.error('sidecar_ownership_untrack_failed', { name: record.spec.name, pid: child.pid, error });
          });
          await this.terminateTree(child);
        }
        record.state = 'pending';
        record.blockReason = null;
        record.portRetryCount = 0;
        await this.#startRecord(record, true);
        continue;
      }
      if (child && child.exitCode === null) {
        const healthy = record.spec.readyPort === null || (await this.readinessProbe(record.spec, 1000));
        if (healthy) {
          record.state = 'ready';
          this.#markHealthy(record);
          continue;
        }
        record.child = null;
        await this.watchdog?.untrack(child.pid).catch((error) => {
          this.logger.error('watchdog_untrack_failed', { name: record.spec.name, pid: child.pid, error });
        });
        await this.ownershipLedger?.untrack(child.pid).catch((error) => {
          this.logger.error('sidecar_ownership_untrack_failed', { name: record.spec.name, pid: child.pid, error });
        });
        await this.terminateTree(child);
      }
      record.state = 'pending';
      record.blockReason = null;
      record.portRetryCount = 0;
      await this.#startRecord(record, true);
    }
    this.#startHealthSupervisor();
    const status = await this.getBootStatus();
    this.logger.info('sidecar_recovery_completed', { reason, status: status.status });
    return status;
  }

  quiesce(reason = 'suspend') {
    this.quiesced = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.logger.info('sidecar_supervisor_quiesced', { reason });
  }

  setLsatEncryptionKey(keyB64, blockReason = null) {
    const record = this.records.get(SERVICE_NAMES.LSAT);
    if (!record) return false;
    if (keyB64) record.spec.env.LSATLAB_DB_KEY_B64 = keyB64;
    else delete record.spec.env.LSATLAB_DB_KEY_B64;
    record.spec.launchBlockReason = keyB64 ? null : blockReason;
    return true;
  }

  #ownPids() {
    const pids = new Set([process.pid]);
    if (Number.isSafeInteger(process.ppid)) pids.add(process.ppid);
    if (this.watchdog?.child?.pid) pids.add(this.watchdog.child.pid);
    for (const record of this.records.values()) {
      if (record.child?.pid && record.child.exitCode === null) pids.add(record.child.pid);
    }
    return [...pids];
  }

  async #sweepStalePorts() {
    const targets = [];
    for (const record of this.records.values()) {
      const { spec } = record;
      if (spec.readyPort === null || spec.launchBlockReason) continue;
      // Only sweep a port this launch will actually try to bind: a service whose
      // binary is absent never owns its port, so a listener there is not ours.
      if (spec.resourcePath && !existsSync(spec.resourcePath)) continue;
      targets.push({ name: spec.name, port: spec.readyPort, identity: spec.readinessIdentity ?? null });
    }
    if (targets.length === 0) return;
    try {
      const ownedPids = this.ownershipLedger ? await this.ownershipLedger.verifiedPids([...this.records.values()].map((record) => record.spec)) : [];
      await this.portSweep({
        targets,
        identityProbe: (identity, port) => this.identityProbe(identity, port, 750),
        selfPids: this.#ownPids(),
        ownedPids,
        logger: this.logger,
      });
    } catch (error) {
      // sweepOwnedPorts already isolates per-port failures; this guard exists so
      // that no sweep defect whatsoever can stop the app from launching.
      this.logger.warn('port_sweep_unavailable', { error });
    }
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
        this.#retryOccupiedPort(record, decision.reason);
        return;
      }
    }

    const provenance = await this.provenanceVerifier(spec, this.servicesDirectory);
    record.provenanceStatus = provenance.status;
    if (provenance.blocksLaunch) {
      this.#blockOrSkip(record, 'blocked', provenance.message, provenance.status);
      return;
    }
    // Tauri's contract was explicit: a process group is a safety net, never a
    // launch gate (it degraded to a NoopGroup). An infrastructure hiccup —
    // PowerShell blocked by policy or EDR, corrupt WMI, a slow readiness
    // handshake — must degrade the boot, not make the app's core feature
    // unusable, so the sidecar launches with the guard absent and the boot
    // status carries the reason for the UI banner.
    record.crashGuardDegraded = !this.watchdog?.healthy;
    if (record.crashGuardDegraded) {
      this.logger.warn('sidecar_crash_guard_degraded', {
        name: spec.name,
        reason: CRASH_GUARD_UNAVAILABLE_REASON,
      });
    }

    if (spec.dataDirectory && spec.dataRoot) {
      await ensureDirectoryWithinRoot(spec.dataDirectory, spec.dataRoot);
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

  // An occupied port is transient — a stale sidecar the sweep just killed needs a
  // moment to release its socket — so it schedules a bounded retry instead of
  // latching 'blocked', which nothing but a restart could ever clear.
  #retryOccupiedPort(record, reason) {
    if (record.portRetryCount >= this.maxPortRetries) {
      this.#blockOrSkip(record, 'blocked', `${reason} (retry budget exhausted)`, 'port_occupied');
      return;
    }
    record.portRetryCount += 1;
    record.state = 'backoff';
    record.blockReason = reason;
    record.provenanceStatus = 'port_occupied';
    const waitMs = respawnBackoffMs(record.portRetryCount, this.portRetryBaseMs);
    record.respawnTimer = setTimeout(() => {
      record.respawnTimer = null;
      void this.#startRecord(record, true);
    }, waitMs);
    record.respawnTimer.unref?.();
    this.logger.warn('sidecar_port_occupied_retry', {
      name: record.spec.name,
      port: record.spec.readyPort,
      attempt: record.portRetryCount,
      wait_ms: waitMs,
    });
  }

  // Mirrors the Tauri supervisor's `consecutive_failures = 0` on every healthy
  // poll. Reset only from the health supervisor, never at launch: a sidecar that
  // binds its port and immediately dies must still consume its respawn budget.
  #markHealthy(record) {
    record.restartCount = 0;
    record.portRetryCount = 0;
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
      // On win32 `detached: false` is load-bearing: libuv puts every
      // non-detached child into its own job object with KILL_ON_JOB_CLOSE, so
      // the OS still reaps this tree when the app dies. That is why launching
      // with the crash guard degraded is safe there.
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
    if (this.watchdog?.healthy) {
      try {
        await this.watchdog.track(child.pid);
      } catch (error) {
        child.off('exit', captureEarlyExit);
        await this.terminateTree(child);
        throw new Error(`Crash guard refused child PID ${child.pid}`, { cause: error });
      }
    }
    if (this.ownershipLedger) {
      try {
        await this.ownershipLedger.track({ pid: child.pid, service: spec.name, executable: spec.program });
      } catch (error) {
        await this.watchdog?.untrack(child.pid).catch(() => {});
        await this.terminateTree(child);
        throw new Error(`Ownership ledger refused child PID ${child.pid}`, { cause: error });
      }
    }
    child.off('exit', captureEarlyExit);
    if (earlyExit || child.exitCode !== null) {
      await this.watchdog?.untrack(child.pid);
      await this.ownershipLedger?.untrack(child.pid);
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
    void this.ownershipLedger?.untrack(child.pid).catch((error) => {
      this.logger.error('sidecar_ownership_untrack_failed', { name: record.spec.name, pid: child.pid, error });
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
    const waitMs = respawnBackoffMs(record.restartCount, this.respawnBaseMs);
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
    this.healthTimer = setInterval(() => void this.#healthTick(), this.healthIntervalMs);
    this.healthTimer.unref?.();
  }

  async #healthTick() {
    if (this.stopping || this.quiesced || this.healthTickRunning) return;
    this.healthTickRunning = true;
    try {
      for (const record of this.records.values()) {
        const child = record.child;
        if (this.quiesced || record.state !== 'ready' || !child || child.exitCode !== null) continue;
        if (record.spec.readyPort === null) {
          this.#markHealthy(record);
          continue;
        }
        if (await this.readinessProbe(record.spec, 750)) {
          this.#markHealthy(record);
          continue;
        }
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
    const crashGuardNames = [...this.records.values()]
      .filter((record) => record.everLaunched && record.crashGuardDegraded)
      .map((record) => record.spec.name);
    const reasons = [];
    if (aggregate.status === 'error') {
      reasons.push(`Required sidecar(s) not ready: ${aggregate.required_down_names.join(', ')}`);
    } else if (aggregate.status === 'degraded') {
      reasons.push(`Optional feature(s) unavailable: ${[...skippedNames, ...blockedNames].join(', ')}`);
    }
    if (crashGuardNames.length > 0) {
      reasons.push(
        `Crash guard unavailable (${CRASH_GUARD_UNAVAILABLE_REASON}); running unguarded: ${crashGuardNames.join(', ')}`,
      );
    }
    return {
      status: aggregate.status === 'ok' && crashGuardNames.length > 0 ? 'degraded' : aggregate.status,
      launched: [...this.records.values()].filter((record) => record.everLaunched).length,
      skipped: skippedNames.length,
      blocked: blockedNames.length,
      skipped_names: skippedNames,
      blocked_names: blockedNames,
      required_down_names: aggregate.required_down_names,
      degraded_reason: reasons.join('; ').slice(0, 2048),
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
    const ownedChildren = [...this.records.values()]
      .filter((record) => Number.isSafeInteger(record.child?.pid))
      .map((record) => ({ name: record.spec.name, pid: record.child.pid }));
    await Promise.all(ownedChildren.map(({ name, pid }) =>
      this.ownershipLedger?.untrack(pid).catch((error) => {
        this.logger.error('sidecar_ownership_untrack_failed', { name, pid, error });
      })));
    for (const record of this.records.values()) {
      record.child = null;
      if (record.everLaunched) record.state = 'stopped';
    }
  }
}
