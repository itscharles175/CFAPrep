import { spawn } from 'node:child_process';
import process from 'node:process';
import readline from 'node:readline';

// How long close() lets the child finish its reap before force-killing it. The
// reap is synchronous and bounded by the child's own spawnSync timeouts: on
// Windows a Win32_Process snapshot (8s) plus a taskkill per tracked root (10s).
// Killing the child mid-reap abandons the sidecars it was about to terminate —
// exactly the leak the crash guard exists to prevent — so the grace covers a
// snapshot plus a first taskkill. A normal quit never approaches it: the sidecar
// manager untracks each child as it stops, and an empty tracking table makes the
// child skip the snapshot entirely.
const REAP_GRACE_MS = 25_000;

export function isOwnedChildPid(pid, parentPid = process.pid, watchdogPid = null) {
  return Number.isSafeInteger(pid) && pid > 0 && pid !== parentPid && (watchdogPid === null || pid !== watchdogPid);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export class OwnedChildWatchdog {
  static async start({
    scriptPath,
    logger,
    executable = process.execPath,
    parentPid = process.pid,
    spawnProcess = spawn,
    // The child gates its own readiness on a full Win32_Process CIM query
    // (spawnSync timeout 8s), and end-to-end readiness measured 2.8-4.9s on an
    // IDLE machine. A 10s budget leaves almost no headroom once the machine is
    // loaded, and a timeout here fails the crash guard closed — which blocks
    // every sidecar launch — so the budget is sized off the child's own worst
    // case rather than the observed happy path.
    readyTimeoutMs = 30_000,
  }) {
    const child = spawnProcess(executable, [scriptPath, String(parentPid)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: true,
    });
    const watchdog = new OwnedChildWatchdog({ child, logger, parentPid });
    try {
      await watchdog.waitUntilReady(readyTimeoutMs);
      return watchdog;
    } catch (error) {
      await watchdog.close();
      throw error;
    }
  }

  constructor({ child, logger, parentPid }) {
    this.child = child;
    this.logger = logger;
    this.parentPid = parentPid;
    this.healthy = false;
    this.closing = false;
    this.failureHandlers = new Set();
    this.trackedPids = new Set();
    this.readyWaiters = new Set();
    this.pendingMessages = new Map();
    this.nextMessageId = 1;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (data) => logger.warn('watchdog_stderr', { message: String(data) }));
    this.outputReader = child.stdout ? readline.createInterface({ input: child.stdout, crlfDelay: Infinity }) : null;
    this.outputReader?.on('line', (line) => this.#handleOutputLine(line));
    child.on('error', (error) => {
      logger.crash('watchdog_process_error', { error });
      this.#rejectWaiters(error);
      if (!this.closing) for (const handler of this.failureHandlers) handler();
    });
    child.once('exit', (code, signal) => {
      const unexpected = !this.closing;
      this.healthy = false;
      this.#rejectWaiters(new Error(`Owned-child watchdog exited (${code ?? signal ?? 'unknown'})`));
      if (unexpected) {
        logger.crash('watchdog_exited', { code, signal });
        for (const handler of this.failureHandlers) handler();
      }
    });
  }

  waitUntilReady(timeoutMs) {
    if (this.healthy) return Promise.resolve();
    if (this.child.exitCode !== null) {
      return Promise.reject(new Error('Owned-child watchdog exited before ready'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters.delete(waiter);
        reject(new Error('Owned-child watchdog readiness timed out'));
      }, timeoutMs);
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.readyWaiters.add(waiter);
    });
  }

  #handleOutputLine(line) {
    if (line === 'STUDYVAULT_WATCHDOG_READY') {
      this.healthy = true;
      for (const waiter of this.readyWaiters) waiter.resolve();
      this.readyWaiters.clear();
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const pending = this.pendingMessages.get(message?.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingMessages.delete(message.id);
    if (message.ok === true) pending.resolve();
    else pending.reject(new Error('Owned-child watchdog rejected the operation'));
  }

  #rejectWaiters(error) {
    for (const waiter of this.readyWaiters) waiter.reject(error);
    this.readyWaiters.clear();
    for (const pending of this.pendingMessages.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingMessages.clear();
  }

  onFailure(handler) {
    this.failureHandlers.add(handler);
    return () => this.failureHandlers.delete(handler);
  }

  async track(pid) {
    if (!this.healthy || !isOwnedChildPid(pid, this.parentPid, this.child.pid)) {
      throw new Error('Owned-child watchdog is unavailable or rejected the PID');
    }
    await this.#send({ op: 'track', pid });
    this.trackedPids.add(pid);
  }

  async untrack(pid) {
    if (!this.trackedPids.has(pid)) return;
    if (this.healthy) await this.#send({ op: 'untrack', pid });
    this.trackedPids.delete(pid);
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    if (this.healthy) {
      await this.#send({ op: 'shutdown' }).catch(() => {});
    }
    this.child.stdin?.end();
    if (!(await waitForExit(this.child, REAP_GRACE_MS)) && this.child.exitCode === null) this.child.kill();
    this.healthy = false;
    this.trackedPids.clear();
    this.outputReader?.close();
  }

  #send(message) {
    if (!this.child.stdin?.writable) return Promise.reject(new Error('Watchdog pipe is closed'));
    const id = this.nextMessageId;
    this.nextMessageId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMessages.delete(id);
        reject(new Error('Owned-child watchdog operation timed out'));
      }, 10_000);
      this.pendingMessages.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ ...message, id })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pendingMessages.delete(id);
        reject(error);
      });
    });
  }
}
