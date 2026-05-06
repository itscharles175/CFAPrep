import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { executableReleaseGateDefinitions } from '../src/lib/releaseGateManifest.ts';

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

    child.on('close', (exitCode) => {
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
      console.log(`==> ${command} ${result.status} (${Math.round(durationMs / 1000)}s)`);
      resolve(result);
    });
  });
}

function gateArtifactPaths(id) {
  return executableReleaseGateDefinitions.find((gate) => gate.id === id)?.artifactPaths || [];
}

const results = [];
for (const gate of gates) {
  results.push(await runCommand(gate));
}

await mkdir('dist/reports', { recursive: true });
await writeGateReport(results);

if (releaseChecklistGate) {
  results.push(await runCommand(releaseChecklistGate));
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
