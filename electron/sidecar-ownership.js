import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CONTRACT_VERSION = 1;

export async function executableSha256(file) {
  const bytes = await readFile(file);
  return createHash('sha256').update(bytes).digest('hex');
}

export async function inspectSidecarProcess(pid, platform = process.platform) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  if (platform === 'darwin') {
    try {
      const [{ stdout: psOutput }, { stdout: lsofOutput }] = await Promise.all([
        execFileAsync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart='], {
          timeout: 2000,
          maxBuffer: 64 * 1024,
        }),
        execFileAsync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], {
          timeout: 2000,
          maxBuffer: 64 * 1024,
        }),
      ]);
      const startFingerprint = psOutput.trim();
      const executableLine = lsofOutput.split(/\r?\n/).find((line) => line.startsWith('n/') && line !== 'n/usr/lib/dyld');
      if (!startFingerprint || !executableLine) return null;
      return { startFingerprint, executable: await realpath(executableLine.slice(1)) };
    } catch {
      return null;
    }
  }
  if (platform === 'linux') {
    try {
      const [stat, executable] = await Promise.all([
        readFile(`/proc/${pid}/stat`, 'utf8'),
        realpath(`/proc/${pid}/exe`),
      ]);
      const close = stat.lastIndexOf(')');
      const fields = stat.slice(close + 2).split(' ');
      return { startFingerprint: fields[19], executable };
    } catch {
      return null;
    }
  }
  return null;
}

export class SidecarOwnershipLedger {
  constructor({
    userDataPath,
    logger = null,
    inspectProcess = inspectSidecarProcess,
    hashExecutable = executableSha256,
    canonicalize = realpath,
    launchId = randomUUID(),
  }) {
    this.file = path.join(userDataPath, 'runtime', 'sidecar-ownership-v1.json');
    this.logger = logger;
    this.inspectProcess = inspectProcess;
    this.hashExecutable = hashExecutable;
    this.canonicalize = canonicalize;
    this.launchId = launchId;
    this.entries = null;
    this.writeChain = Promise.resolve();
  }

  async verifiedPids(specs) {
    await this.#load();
    const expected = new Map(specs.map((spec) => [spec.name, spec]));
    const verified = [];
    for (const entry of this.entries) {
      try {
        const spec = expected.get(entry.service);
        if (!spec || !spec.program) continue;
        const [current, expectedPath] = await Promise.all([
          this.inspectProcess(entry.pid),
          this.canonicalize(spec.program),
        ]);
        if (!current || current.startFingerprint !== entry.startFingerprint) continue;
        const observedPath = await this.canonicalize(current.executable);
        if (observedPath !== entry.executable || expectedPath !== entry.executable) continue;
        const currentHash = await this.hashExecutable(expectedPath);
        if (currentHash !== entry.sha256) continue;
        verified.push(entry.pid);
      } catch {
        // Every mismatch and inspection failure is fail-closed: the listener is unknown.
      }
    }
    return verified;
  }

  async track({ pid, service, executable }) {
    await this.#load();
    const [current, canonicalExecutable] = await Promise.all([
      this.inspectProcess(pid),
      this.canonicalize(executable),
    ]);
    if (!current || (await this.canonicalize(current.executable)) !== canonicalExecutable) {
      throw new Error('Sidecar process identity does not match its configured executable');
    }
    const entry = {
      pid,
      service,
      executable: canonicalExecutable,
      sha256: await this.hashExecutable(canonicalExecutable),
      startFingerprint: current.startFingerprint,
      launchId: this.launchId,
    };
    this.entries = this.entries.filter((candidate) => candidate.pid !== pid && candidate.service !== service);
    this.entries.push(entry);
    await this.#persist();
  }

  async untrack(pid) {
    await this.#load();
    const next = this.entries.filter((entry) => entry.pid !== pid);
    if (next.length === this.entries.length) return;
    this.entries = next;
    await this.#persist();
  }

  async #load() {
    if (this.entries !== null) return;
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      this.entries = parsed?.version === CONTRACT_VERSION && Array.isArray(parsed.entries)
        ? parsed.entries.filter((entry) => this.#validEntry(entry))
        : [];
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.warn('sidecar_ownership_ledger_invalid', { error });
      this.entries = [];
    }
  }

  #validEntry(entry) {
    return entry && Number.isSafeInteger(entry.pid) && entry.pid > 1 &&
      typeof entry.service === 'string' && typeof entry.executable === 'string' && path.isAbsolute(entry.executable) &&
      typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256) &&
      typeof entry.startFingerprint === 'string' && entry.startFingerprint.length > 0 &&
      typeof entry.launchId === 'string' && entry.launchId.length > 0;
  }

  async #persist() {
    const payload = `${JSON.stringify({ version: CONTRACT_VERSION, entries: this.entries })}\n`;
    const task = async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.file);
    };
    this.writeChain = this.writeChain.then(task, task);
    await this.writeChain;
  }
}
