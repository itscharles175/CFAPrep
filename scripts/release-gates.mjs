import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { executableReleaseGateDefinitions } from '../src/lib/releaseGateManifest.ts';
import { scanArtifactDenylist, writeArtifactDenylistReport } from './qa-helpers.mjs';

const gates = executableReleaseGateDefinitions.filter((gate) => gate.id !== 'release-checklist');
const releaseChecklistGate = executableReleaseGateDefinitions.find((gate) => gate.id === 'release-checklist');

function runCommand({ id, command }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    console.log(`\n==> ${command}`);
    const child = spawn(command, {
      shell: true,
      stdio: 'inherit',
      env: process.env,
    });

    child.on('close', async (exitCode) => {
      const durationMs = Date.now() - startedAt;
      const result = {
        id,
        command,
        status: exitCode === 0 ? 'ok' : 'blocked',
        exitCode,
        durationMs,
        completedAt: new Date().toISOString(),
        artifactPaths: gateArtifactPaths(id),
        runtime: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
        },
      };
      const routeFailures = await gateRouteFailures(id);
      if (routeFailures.length) result.routeFailures = routeFailures;
      console.log(`==> ${command} ${result.status} (${Math.round(durationMs / 1000)}s)`);
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
    return (report.routeFailures || (report.routeResults || []).filter((row) => row.status && row.status !== 'ok'))
      .map((row) => ({
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

function gateArtifactPaths(id) {
  return executableReleaseGateDefinitions.find((gate) => gate.id === id)?.artifactPaths || [];
}

const results = [];
await rm('dist', { recursive: true, force: true });
for (const gate of gates) {
  const result = await runCommand(gate);
  results.push(result);
  if (gate.id === 'verify' && result.status !== 'ok') {
    const skipped = gates.slice(gates.indexOf(gate) + 1).map((remainingGate) => ({
      id: remainingGate.id,
      command: remainingGate.command,
      status: 'blocked',
      exitCode: null,
      durationMs: 0,
      completedAt: new Date().toISOString(),
      artifactPaths: gateArtifactPaths(remainingGate.id),
      message: 'Skipped because npm run verify failed; dist-dependent gates require a fresh successful build.',
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
    }));
    results.push(...skipped);
    break;
  }
}

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
    message: artifactDenylist.violations.length
      ? `${artifactDenylist.violations.length} denied release artifact(s) detected.`
      : `${artifactDenylist.scannedFiles} release artifact file(s) passed denylist checks.`,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  });
  await writeGateReport(results);
}

if (releaseChecklistGate && !results.some((result) => result.status !== 'ok')) {
  results.push(await runCommand(releaseChecklistGate));
  await writeGateReport(results);
} else if (releaseChecklistGate) {
  results.push({
    id: releaseChecklistGate.id,
    command: releaseChecklistGate.command,
    status: 'blocked',
    exitCode: null,
    durationMs: 0,
    completedAt: new Date().toISOString(),
    artifactPaths: gateArtifactPaths(releaseChecklistGate.id),
    message: 'Skipped because one or more required release gates failed.',
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  });
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
  const report = {
    generatedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    results: gateResults,
    resultsById: Object.fromEntries(gateResults.map((result) => [result.id, result])),
  };
  await writeFile('dist/reports/release-gate-results.json', `${JSON.stringify(report, null, 2)}\n`);
}
