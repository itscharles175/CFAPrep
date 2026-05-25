import { spawn, execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { executableReleaseGateDefinitions } from '../src/lib/releaseGateManifest.ts';
import { scanArtifactDenylist, writeArtifactDenylistReport } from './qa-helpers.mjs';

const execFileAsync = promisify(execFile);
const gates = executableReleaseGateDefinitions.filter((gate) => gate.id !== 'release-checklist');
const releaseChecklistGate = executableReleaseGateDefinitions.find((gate) => gate.id === 'release-checklist');
const releaseHistoryRoot = 'dist/reports/release-history';
const reportRetention = executableReleaseGateDefinitions.find((gate) => gate.reportRetention)?.reportRetention || {
  archiveRoot: releaseHistoryRoot,
  keepLatest: 20,
  immutable: true,
};
const git = await gitInfo();
const runId = `qv-release-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${git.shortSha || 'nogit'}`;
let reportWriteCount = 0;

function runtime() {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}

async function gitValue(args) {
  try {
    const { stdout } = await execFileAsync('git', args, { encoding: 'utf8' });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function gitInfo() {
  const [sha, branch, dirtyStatus] = await Promise.all([
    gitValue(['rev-parse', 'HEAD']),
    gitValue(['branch', '--show-current']),
    gitValue(['status', '--porcelain']),
  ]);
  return {
    sha: sha || undefined,
    shortSha: sha ? sha.slice(0, 12) : undefined,
    branch: branch || undefined,
    dirty: Boolean(dirtyStatus),
  };
}

async function validateGateArtifacts(gate) {
  const requiredPaths = gate.artifactSchema?.requiredPaths || [];
  const missing = [];
  for (const artifactPath of requiredPaths) {
    try {
      await readFile(artifactPath);
    } catch {
      missing.push(artifactPath);
    }
  }
  return missing;
}

function gateArtifactPaths(id) {
  return executableReleaseGateDefinitions.find((gate) => gate.id === id)?.artifactPaths || [];
}

function gateResult(gate, fields = {}) {
  return {
    id: gate.id,
    command: gate.command,
    artifactPaths: gate.artifactPaths || gateArtifactPaths(gate.id),
    dependencies: gate.dependsOn || [],
    parallelGroup: gate.parallelGroup,
    freshnessHours: gate.freshnessHours,
    artifactSchema: gate.artifactSchema,
    runId,
    git,
    failureTriage: gate.failureTriage,
    runtime: runtime(),
    ...fields,
  };
}

function skippedResult(gate, message) {
  return gateResult(gate, {
    status: 'blocked',
    exitCode: null,
    durationMs: 0,
    completedAt: new Date().toISOString(),
    message,
  });
}

function runCommand(gate) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    let timedOut = false;
    console.log(`\n==> [${gate.id}] ${gate.command}`);
    const child = spawn(gate.command, {
      shell: true,
      stdio: 'inherit',
      env: process.env,
    });

    const timeout = gate.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, gate.timeoutMs)
      : null;

    child.on('close', async (exitCode) => {
      if (timeout) clearTimeout(timeout);
      const durationMs = Date.now() - startedAt;
      const missingArtifacts = exitCode === 0 && !timedOut ? await validateGateArtifacts(gate) : [];
      const status = exitCode === 0 && !timedOut && missingArtifacts.length === 0 ? 'ok' : 'blocked';
      const result = gateResult(gate, {
        status,
        exitCode,
        durationMs,
        startedAt: startedAtIso,
        completedAt: new Date().toISOString(),
        ...(timedOut ? { message: `Timed out after ${gate.timeoutMs}ms.` } : {}),
        ...(missingArtifacts.length
          ? { message: `Artifact schema ${gate.artifactSchema?.id || 'unknown'} missing required path(s): ${missingArtifacts.join(', ')}.` }
          : {}),
      });
      const routeFailures = await gateRouteFailures(gate.id);
      if (routeFailures.length) result.routeFailures = routeFailures;
      console.log(`==> [${gate.id}] ${gate.command} ${result.status} (${Math.round(durationMs / 1000)}s)`);
      resolve(result);
    });
  });
}

async function gateRouteFailures(id) {
  const reportPath =
    id === 'visual-regression'
      ? 'dist/reports/visual-regression.json'
      : id === 'accessibility'
        ? 'dist/reports/a11y-check.json'
        : id === 'browser-regression'
          ? 'dist/reports/browser-regression.json'
          : null;
  if (!reportPath) return [];
  try {
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    return (report.routeFailures || (report.routeResults || []).filter((row) => row.status && row.status !== 'ok')).map((row) => ({
      routeId: row.routeId,
      path: row.path,
      expectedText: row.expectedText,
      durationMs: row.durationMs,
      url: row.url,
      message: row.message || (row.violations || []).join('; ') || 'Route check failed.',
    }));
  } catch {
    return [];
  }
}

function dependencyStatus(gate, resultsById) {
  const dependencies = gate.dependsOn || [];
  const missing = dependencies.filter((id) => !resultsById[id]);
  const blocked = dependencies.filter((id) => resultsById[id] && resultsById[id].status !== 'ok');
  return { missing, blocked };
}

async function runDependencyAwareGates() {
  const results = [];
  const resultsById = {};
  const pending = new Map(gates.map((gate) => [gate.id, gate]));

  while (pending.size) {
    const blockedBatch = [...pending.values()].filter((gate) => {
      const { blocked } = dependencyStatus(gate, resultsById);
      return blocked.length > 0;
    });
    for (const gate of blockedBatch) {
      const { blocked } = dependencyStatus(gate, resultsById);
      const result = skippedResult(gate, `Skipped because required dependency gate(s) failed: ${blocked.join(', ')}.`);
      results.push(result);
      resultsById[gate.id] = result;
      pending.delete(gate.id);
    }

    const ready = [...pending.values()].filter((gate) => dependencyStatus(gate, resultsById).missing.length === 0);
    if (!ready.length) {
      for (const gate of pending.values()) {
        const { missing } = dependencyStatus(gate, resultsById);
        const result = skippedResult(gate, `Skipped because required dependency gate(s) never completed: ${missing.join(', ')}.`);
        results.push(result);
        resultsById[gate.id] = result;
      }
      pending.clear();
      break;
    }

    const group = ready[0].parallelGroup || ready[0].id;
    const batch = ready.filter((gate) => (gate.parallelGroup || gate.id) === group);
    const batchResults = await Promise.all(batch.map((gate) => runCommand(gate)));
    for (const result of batchResults) {
      results.push(result);
      resultsById[result.id] = result;
      pending.delete(result.id);
    }
    await writeGateReport(results);
  }

  return results;
}

const results = [];
await rm('dist', { recursive: true, force: true });
results.push(...(await runDependencyAwareGates()));

await mkdir('dist/reports', { recursive: true });
await writeGateReport(results);

if (releaseChecklistGate && !results.some((result) => result.status !== 'ok')) {
  const artifactDenylist = await scanArtifactDenylist();
  await writeArtifactDenylistReport(artifactDenylist);
  results.push({
    id: 'artifact-denylist',
    command: 'npm run stack:audit -- --artifact-only',
    status: artifactDenylist.status,
    exitCode: artifactDenylist.violations.length ? 1 : 0,
    durationMs: 0,
    completedAt: new Date().toISOString(),
    artifactPaths: ['dist/reports/artifact-denylist.json'],
    dependencies: ['stack-audit'],
    parallelGroup: 'finalize',
    freshnessHours: 24,
    artifactSchema: { id: 'qv.release.artifact-denylist.v1', requiredPaths: ['dist/reports/artifact-denylist.json'] },
    runId,
    git,
    message: artifactDenylist.violations.length
      ? `${artifactDenylist.violations.length} denied release artifact(s) detected.`
      : `${artifactDenylist.scannedFiles} release artifact file(s) passed denylist checks.`,
    runtime: runtime(),
  });
  await writeGateReport(results);
}

if (releaseChecklistGate && !results.some((result) => result.status !== 'ok')) {
  results.push(await runCommand(releaseChecklistGate));
  await writeGateReport(results);
} else if (releaseChecklistGate) {
  results.push(
    skippedResult(
      releaseChecklistGate,
      results.some((result) => result.id === 'artifact-denylist' && result.status !== 'ok')
        ? 'Skipped because the release artifact denylist failed.'
        : 'Skipped because one or more required release gates failed.',
    ),
  );
  await writeGateReport(results);
}

const failures = results.filter((result) => result.status !== 'ok');
if (failures.length) {
  console.error(`${failures.length} release gate command(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('All executable release gate commands passed.');
}

async function writeGateReport(gateResults) {
  await mkdir('dist/reports', { recursive: true });
  const report = {
    runId,
    generatedAt: new Date().toISOString(),
    git,
    runtime: runtime(),
    retention: reportRetention,
    results: gateResults,
    resultsById: Object.fromEntries(gateResults.map((result) => [result.id, result])),
  };
  await writeFile('dist/reports/release-gate-results.json', `${JSON.stringify(report, null, 2)}\n`);
  await archiveGateReport(report);
}

async function archiveGateReport(report) {
  const archiveRoot = reportRetention.archiveRoot || releaseHistoryRoot;
  reportWriteCount += 1;
  await mkdir(archiveRoot, { recursive: true });
  const archivePath = `${archiveRoot}/${runId}-${String(reportWriteCount).padStart(2, '0')}.json`;
  await writeFile(archivePath, `${JSON.stringify(report, null, 2)}\n`);
  await pruneReleaseHistory(archiveRoot, reportRetention.keepLatest || 20);
  if (reportWriteCount === 1) {
    await copyFile(archivePath, `${archiveRoot}/${runId}-started.json`).catch(() => undefined);
  }
}

async function pruneReleaseHistory(archiveRoot, keepLatest) {
  const files = (await readdir(archiveRoot).catch(() => [])).filter((file) => file.endsWith('.json')).sort().reverse();
  await Promise.all(files.slice(keepLatest).map((file) => unlink(`${archiveRoot}/${file}`).catch(() => undefined)));
}
