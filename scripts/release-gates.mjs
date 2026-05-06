import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const gates = [
  { id: 'verify', command: 'npm run verify' },
  { id: 'audit', command: 'npm run audit' },
  { id: 'content-validation', command: 'npm run content:validate' },
  { id: 'bundle-report', command: 'npm run bundle:report' },
  { id: 'smoke', command: 'npm run smoke' },
  { id: 'browser-regression', command: 'npm run browser:regression' },
  { id: 'fresh-import', command: 'npm run fresh-import:check' },
  { id: 'content-report', command: 'npm run content:report' },
];

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

const results = [];
for (const gate of gates) {
  results.push(await runCommand(gate));
}

const report = {
  generatedAt: new Date().toISOString(),
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  results,
  resultsById: Object.fromEntries(results.map((result) => [result.id, result])),
};

await mkdir('dist/reports', { recursive: true });
await writeFile('dist/reports/release-gate-results.json', `${JSON.stringify(report, null, 2)}\n`);

await runCommand({ id: 'release-checklist', command: 'npm run release:checklist' });

const failures = results.filter((result) => result.status !== 'ok');
if (failures.length) {
  console.error(`${failures.length} release gate command(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('All executable release gate commands passed.');
}
