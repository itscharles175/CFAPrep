#!/usr/bin/env node
/*
 * DX-3 first floor: local stack doctor.
 *
 * This is intentionally read-only. It gives a contributor one fast command that
 * answers "is this checkout locally sane enough to develop/release from?" without
 * starting sidecars or rewriting generated artifacts.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_REPORT = join(REPO_ROOT, 'dist', 'reports', 'stack-doctor.json');
const SERVICES_ROOT_REL = join('electron', 'resources', 'services');
const PROVENANCE_REL = join(SERVICES_ROOT_REL, 'sidecar-provenance.json');

export const DOCTOR_SCHEMA = 'studyvault.stack_doctor.v1';

export const PORTS = [
  { id: 'port-vite', label: 'Vite dev server port', port: 5173, expected: 'vite' },
  { id: 'port-surrealdb', label: 'SurrealDB sidecar port', port: 8000, expected: 'surrealdb' },
  { id: 'port-open-notebook', label: 'Open Notebook sidecar port', port: 5055, expected: 'open-notebook' },
  {
    id: 'port-lsat-backend',
    label: 'LSAT backend sidecar port',
    port: 8100,
    expected: 'lsat-backend',
    healthPath: '/api/health',
    expectedService: 'lsat-backend',
  },
];

export const REQUIRED_FILES = [
  ['package.json', 'Root package manifest'],
  ['package-lock.json', 'Root npm lockfile'],
  [join('services', 'lsat-backend', 'pyproject.toml'), 'LSAT backend Python manifest'],
  [join('services', 'lsat-backend', 'uv.lock'), 'LSAT backend Python lockfile'],
  [join('electron-builder.yml'), 'Electron builder manifest'],
  [join('electron', 'main.js'), 'Electron main process'],
  [join('electron', 'preload.cjs'), 'Electron preload bridge'],
];

export const ALL_GATES = [
  {
    id: 'gate-version-sync',
    label: 'version sync',
    command: npmBin(),
    args: ['run', 'check:versions'],
    timeoutMs: 30_000,
  },
  {
    id: 'gate-openapi-drift',
    label: 'OpenAPI drift',
    command: 'node',
    args: ['scripts/export-lsat-openapi.mjs', '--check'],
    timeoutMs: 120_000,
    addPythonArg: true,
  },
  {
    id: 'gate-no-egress',
    label: 'no-egress gate',
    command: npmBin(),
    args: ['run', 'check:no-egress'],
    timeoutMs: 60_000,
  },
  {
    id: 'gate-sidecar-fetches',
    label: 'direct sidecar fetch inventory gate',
    command: npmBin(),
    args: ['run', 'check:sidecar-fetches'],
    timeoutMs: 60_000,
  },
  {
    id: 'gate-docs-drift',
    label: 'docs-drift gate',
    command: npmBin(),
    args: ['run', 'check:docs'],
    timeoutMs: 60_000,
  },
  {
    id: 'gate-baseline-catalog',
    label: 'baseline catalog gate',
    command: npmBin(),
    args: ['run', 'check:baselines'],
    timeoutMs: 60_000,
  },
  {
    id: 'gate-vault-archive-drill',
    label: 'vault archive restore drill',
    command: npmBin(),
    args: ['run', 'vault-archive:drill'],
    timeoutMs: 60_000,
  },
];

function npmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function npxBin() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function rel(file, root = REPO_ROOT) {
  return relative(root, file).split('\\').join('/');
}

function tail(text, limit = 2000) {
  return text.length > limit ? text.slice(-limit) : text;
}

export function makeCheck({
  id,
  label,
  status,
  severity = status === 'fail' ? 'error' : status === 'warn' ? 'warning' : 'info',
  details = '',
  remediation = '',
  data = {},
}) {
  return { id, label, status, severity, details, remediation, data };
}

export function summarizeChecks(checks, { strict = false } = {}) {
  const summary = {
    passed: checks.filter((check) => check.status === 'pass').length,
    warned: checks.filter((check) => check.status === 'warn').length,
    failed: checks.filter((check) => check.status === 'fail').length,
    skipped: checks.filter((check) => check.status === 'skip').length,
    total: checks.length,
  };
  summary.status = summary.failed > 0 || (strict && summary.warned > 0) ? 'failed' : 'passed';
  return summary;
}

export function exitCodeForSummary(summary) {
  return summary.status === 'passed' ? 0 : 1;
}

export function parseArgs(argv) {
  const out = {
    all: false,
    json: false,
    strict: false,
    output: DEFAULT_REPORT,
    python: defaultPython(),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') out.all = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--strict') out.strict = true;
    else if (arg === '--output') {
      const value = argv[++i];
      if (!value) throw new Error('--output requires a path');
      out.output = resolve(REPO_ROOT, value);
    } else if (arg === '--python') {
      const value = argv[++i];
      if (!value) throw new Error('--python requires a command/path');
      out.python = value;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return out;
}

function usage() {
  return [
    'Usage: node scripts/stack-doctor.mjs [--all] [--strict] [--json] [--output path] [--python path]',
    '',
    'Default mode checks local toolchain, required manifests, sidecar provenance,',
    'and expected loopback ports. --all also runs the fast static gates used by',
    'CI/release trust: version sync, OpenAPI drift, no-egress, sidecar-fetch',
    'inventory, docs drift, and baseline catalog.',
  ].join('\n');
}

function defaultPython() {
  if (process.env.LSAT_E2E_PYTHON) return process.env.LSAT_E2E_PYTHON;
  if (process.env.PYTHON) return process.env.PYTHON;
  const winVenv = join(REPO_ROOT, '.venv-lsat', 'Scripts', 'python.exe');
  if (existsSync(winVenv)) return winVenv;
  const unixVenv = join(REPO_ROOT, '.venv-lsat', 'bin', 'python');
  if (existsSync(unixVenv)) return unixVenv;
  return 'python';
}

export function runCommand(command, args = [], { cwd = REPO_ROOT, timeoutMs = 15_000 } = {}) {
  const started = Date.now();
  const shim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  const spawnCommand = shim ? process.env.ComSpec || 'cmd.exe' : command;
  const spawnArgs = shim ? ['/d', '/s', '/c', [command, ...args].map(quoteCmdArg).join(' ')] : args;
  const proc = spawnSync(spawnCommand, spawnArgs, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    command: [command, ...args],
    cwd,
    exitCode: proc.status,
    signal: proc.signal,
    timedOut: proc.error?.code === 'ETIMEDOUT',
    error: proc.error ? String(proc.error.message || proc.error) : '',
    stdoutTail: tail(proc.stdout || ''),
    stderrTail: tail(proc.stderr || ''),
    durationMs: Date.now() - started,
  };
}

function quoteCmdArg(arg) {
  const text = String(arg);
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

export function evaluateCommandCheck(
  { id, label, command, args = [], timeoutMs = 15_000, required = true },
  runner = runCommand,
) {
  const result = runner(command, args, { timeoutMs });
  const ok = result.exitCode === 0 && !result.timedOut;
  if (ok) {
    return makeCheck({
      id,
      label,
      status: 'pass',
      details: firstLine(result.stdoutTail || result.stderrTail) || 'Command passed.',
      data: result,
    });
  }
  return makeCheck({
    id,
    label,
    status: required ? 'fail' : 'warn',
    details: result.timedOut
      ? 'Command timed out.'
      : result.error || firstLine(result.stderrTail || result.stdoutTail) || 'Command failed.',
    remediation: required
      ? `Install/fix ${label} or run ${[command, ...args].join(' ')} directly for full output.`
      : `Optional tool not found or not ready: ${label}.`,
    data: result,
  });
}

function firstLine(text) {
  return (
    String(text || '')
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() || ''
  );
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function evaluateRequiredFiles(root = REPO_ROOT) {
  return REQUIRED_FILES.map(([relPath, label]) => {
    const abs = join(root, relPath);
    if (existsSync(abs)) {
      return makeCheck({
        id: `file-${relPath.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
        label,
        status: 'pass',
        details: `${relPath} exists.`,
        data: { path: relPath },
      });
    }
    return makeCheck({
      id: `file-${relPath.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
      label,
      status: 'fail',
      details: `${relPath} is missing.`,
      remediation: 'Restore the manifest/lockfile before running install, build, or release gates.',
      data: { path: relPath },
    });
  });
}

export function evaluateSidecarProvenance(root = REPO_ROOT) {
  const manifestPath = join(root, PROVENANCE_REL);
  if (!existsSync(manifestPath)) {
    return [
      makeCheck({
        id: 'sidecar-provenance-manifest',
        label: 'sidecar provenance manifest',
        status: 'warn',
        details: `${PROVENANCE_REL} is missing.`,
        remediation: 'Run npm run build:lsat-binary before packaging or release smoke checks.',
        data: { path: PROVENANCE_REL },
      }),
    ];
  }

  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (err) {
    return [
      makeCheck({
        id: 'sidecar-provenance-manifest',
        label: 'sidecar provenance manifest',
        status: 'fail',
        details: `Manifest is not valid JSON: ${err.message}`,
        remediation: 'Regenerate sidecar provenance with npm run build:lsat-binary.',
        data: { path: PROVENANCE_REL },
      }),
    ];
  }

  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  const checks = [
    makeCheck({
      id: 'sidecar-provenance-manifest',
      label: 'sidecar provenance manifest',
      status: entries.length ? 'pass' : 'warn',
      details: entries.length
        ? `${PROVENANCE_REL} lists ${entries.length} sidecar artifact(s).`
        : `${PROVENANCE_REL} has no entries.`,
      remediation: entries.length ? '' : 'Regenerate sidecar provenance with npm run build:lsat-binary.',
      data: { path: PROVENANCE_REL, entries: entries.length, schema: manifest.schema },
    }),
  ];

  for (const [index, entry] of entries.entries()) {
    const service = String(entry.service || `sidecar ${index + 1}`);
    const relEntryPath = String(entry.path || '');
    const optional = Boolean(entry.optional);
    const expectedHash = String(entry.sha256 || '');
    const expectedSize = Number(entry.size);
    const abs = join(root, SERVICES_ROOT_REL, relEntryPath);
    const id = `sidecar-${service.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;

    if (!relEntryPath || !expectedHash) {
      checks.push(
        makeCheck({
          id,
          label: `${service} provenance`,
          status: optional ? 'warn' : 'fail',
          details: 'Manifest entry is missing path or sha256.',
          remediation: 'Regenerate sidecar provenance before packaging.',
          data: { entry },
        }),
      );
      continue;
    }

    if (!existsSync(abs)) {
      checks.push(
        makeCheck({
          id,
          label: `${service} artifact`,
          status: optional ? 'warn' : 'fail',
          details: `${join(SERVICES_ROOT_REL, relEntryPath)} is missing.`,
          remediation: optional
            ? 'Optional sidecar is not staged; RAG-enabled builds may need it.'
            : 'Run the sidecar build before packaging or release smoke checks.',
          data: { path: rel(abs, root), optional },
        }),
      );
      continue;
    }

    let actualSize;
    let actualHash;
    try {
      actualSize = statSync(abs).size;
      actualHash = sha256File(abs);
    } catch (err) {
      checks.push(
        makeCheck({
          id,
          label: `${service} artifact`,
          status: optional ? 'warn' : 'fail',
          details: `Could not hash artifact: ${err.message}`,
          remediation: 'Regenerate the sidecar artifact and provenance manifest.',
          data: { path: rel(abs, root), optional },
        }),
      );
      continue;
    }

    const hashOk = actualHash === expectedHash;
    const sizeOk = Number.isFinite(expectedSize) ? actualSize === expectedSize : true;
    checks.push(
      makeCheck({
        id,
        label: `${service} artifact`,
        status: hashOk && sizeOk ? 'pass' : optional ? 'warn' : 'fail',
        details:
          hashOk && sizeOk
            ? `${join(SERVICES_ROOT_REL, relEntryPath)} matches recorded SHA-256.`
            : 'Staged sidecar does not match recorded provenance.',
        remediation:
          hashOk && sizeOk ? '' : 'Regenerate the sidecar artifact and provenance manifest before packaging.',
        data: {
          path: rel(abs, root),
          optional,
          expectedHash,
          actualHash,
          expectedSize: Number.isFinite(expectedSize) ? expectedSize : null,
          actualSize,
        },
      }),
    );
  }

  return checks;
}

export function evaluatePortProbe(spec, probe) {
  if (!probe.open) {
    return makeCheck({
      id: spec.id,
      label: spec.label,
      status: 'warn',
      details: `127.0.0.1:${spec.port} is not accepting connections.`,
      remediation: `Start the ${spec.expected} service when you need the live dev stack; this is expected before dev-up.`,
      data: { port: spec.port, open: false },
    });
  }

  if (!spec.expectedService) {
    return makeCheck({
      id: spec.id,
      label: spec.label,
      status: 'warn',
      details: `127.0.0.1:${spec.port} is already in use.`,
      remediation: `Confirm this is the expected ${spec.expected} process before starting sidecars.`,
      data: { port: spec.port, open: true },
    });
  }

  if (probe.health?.ok === true && probe.health?.service === spec.expectedService) {
    return makeCheck({
      id: spec.id,
      label: spec.label,
      status: 'pass',
      details: `127.0.0.1:${spec.port} reports ${spec.expectedService} ${probe.health.version || ''}`.trim(),
      data: { port: spec.port, open: true, health: probe.health },
    });
  }

  return makeCheck({
    id: spec.id,
    label: spec.label,
    status: 'fail',
    details: probe.healthError
      ? `Port is open but health probe failed: ${probe.healthError}`
      : `Port is open but did not report service=${spec.expectedService}.`,
    remediation: 'Stop the foreign/stale process on this port before starting the desktop stack.',
    data: { port: spec.port, open: true, health: probe.health || null },
  });
}

async function probePort(spec) {
  const open = await tcpOpen(spec.port);
  if (!open || !spec.healthPath) return { open };
  try {
    const health = await fetchJson(`http://127.0.0.1:${spec.port}${spec.healthPath}`);
    return { open, health };
  } catch (err) {
    return { open, healthError: err.message };
  }
}

function tcpOpen(port) {
  return new Promise((resolveOpen) => {
    const socket = net.createConnection({ host: '127.0.0.1', port, timeout: 500 });
    socket.once('connect', () => {
      socket.destroy();
      resolveOpen(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolveOpen(false);
    });
    socket.once('error', () => resolveOpen(false));
  });
}

function fetchJson(url) {
  return new Promise((resolveJson, reject) => {
    const req = http.get(url, { timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolveJson(JSON.parse(body));
        } catch (err) {
          reject(new Error(`invalid JSON from ${url}: ${err.message}`));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`timed out probing ${url}`));
    });
    req.on('error', reject);
  });
}

function toolChecks() {
  return [
    evaluateCommandCheck({ id: 'tool-node', label: 'Node.js', command: 'node', args: ['--version'] }),
    evaluateCommandCheck({ id: 'tool-npm', label: 'npm', command: npmBin(), args: ['--version'] }),
    evaluateCommandCheck({ id: 'tool-npx', label: 'npx', command: npxBin(), args: ['--version'] }),
    evaluateCommandCheck({
      id: 'tool-python',
      label: 'Python',
      command: defaultPython(),
      args: ['--version'],
    }),
    evaluateCommandCheck({
      id: 'tool-cargo',
      label: 'Cargo',
      command: 'cargo',
      args: ['--version'],
      required: false,
    }),
    evaluateCommandCheck({
      id: 'tool-rustc',
      label: 'rustc',
      command: 'rustc',
      args: ['--version'],
      required: false,
    }),
  ];
}

function gateChecks(options) {
  if (!options.all) {
    return [
      makeCheck({
        id: 'static-gates',
        label: 'extended static gates',
        status: 'skip',
        details: 'Run with --all to execute version, OpenAPI, no-egress, docs, and baseline gates.',
        remediation: 'Use npm run doctor -- --all before release-quality handoff.',
      }),
    ];
  }

  const checks = [];
  for (const gate of ALL_GATES) {
    const args = gate.addPythonArg ? [...gate.args, '--python', options.python] : gate.args;
    checks.push(evaluateCommandCheck({ ...gate, args, required: true }));
  }
  return checks;
}

export async function buildReport(options = {}) {
  const checks = [...toolChecks(), ...evaluateRequiredFiles(REPO_ROOT), ...evaluateSidecarProvenance(REPO_ROOT)];

  for (const spec of PORTS) {
    checks.push(evaluatePortProbe(spec, await probePort(spec)));
  }

  checks.push(...gateChecks(options));

  const summary = summarizeChecks(checks, { strict: options.strict });
  return {
    schema: DOCTOR_SCHEMA,
    generatedAt: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    mode: {
      all: Boolean(options.all),
      strict: Boolean(options.strict),
    },
    summary,
    checks,
  };
}

function printHuman(report) {
  const { summary } = report;
  console.log(
    `stack-doctor: ${summary.status.toUpperCase()} ` +
      `(${summary.passed} pass, ${summary.warned} warn, ${summary.failed} fail, ${summary.skipped} skip)`,
  );
  for (const check of report.checks) {
    const marker =
      check.status === 'pass' ? 'ok' : check.status === 'warn' ? 'WARN' : check.status === 'fail' ? 'FAIL' : 'skip';
    console.log(`${marker.padEnd(5)} ${check.label}: ${check.details}`);
    if (check.remediation && check.status !== 'pass') {
      console.log(`      fix: ${check.remediation}`);
    }
  }
}

function writeReport(output, report) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error(`stack-doctor: ${err.message}`);
    console.error(usage());
    return 2;
  }

  if (options.help) {
    console.log(usage());
    return 0;
  }

  const report = await buildReport(options);
  writeReport(options.output, report);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
    console.log(`wrote ${rel(options.output)}`);
  }
  return exitCodeForSummary(report.summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main();
  process.exit(code);
}
