#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_PATH = path.join(REPO_ROOT, 'dist', 'reports', 'mutation-floor.json');
const MARKDOWN_PATH = path.join(REPO_ROOT, 'dist', 'reports', 'mutation-floor.md');
const VITEST_CLI = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

export const MUTATION_FLOOR_SCHEMA = 'studyvault.mutation-floor.v1';
export const MIN_MUTATION_SCORE = 1.0;

function backendPython() {
  const windows = path.join(REPO_ROOT, '.venv-lsat', 'Scripts', 'python.exe');
  const posix = path.join(REPO_ROOT, '.venv-lsat', 'bin', 'python');
  if (existsSync(windows)) return windows;
  if (existsSync(posix)) return posix;
  return process.platform === 'win32' ? 'python.exe' : 'python';
}

const PYTHON = backendPython();
const BACKEND_DIR = path.join(REPO_ROOT, 'services', 'lsat-backend');

function frontendCommand(testPath) {
  return {
    cwd: REPO_ROOT,
    args: [process.execPath, VITEST_CLI, 'run', '--project', 'host', testPath],
  };
}

function backendCommand(...testArgs) {
  return {
    cwd: BACKEND_DIR,
    args: [PYTHON, '-m', 'pytest', ...testArgs, '-q'],
    env: { PYTHONPATH: BACKEND_DIR },
  };
}

export const mutationCases = [
  {
    id: 'frontend.fsrs.sample-floor',
    scope: 'host',
    file: 'src/lib/fsrsOptimizer.ts',
    description: 'FSRS optimizer must enforce the minimum-review floor without blocking valid history.',
    find: 'export const MIN_TOTAL_REVIEWS = 50;',
    replace: 'export const MIN_TOTAL_REVIEWS = 5000;',
    command: frontendCommand('src/lib/fsrsOptimizer.test.ts'),
  },
  {
    id: 'frontend.itemPsychometrics.pearson-sign',
    scope: 'host',
    file: 'src/lib/itemPsychometrics.ts',
    description: 'Point-biserial correlation sign must be preserved.',
    find: 'return num / den;',
    replace: 'return -num / den;',
    command: frontendCommand('src/lib/itemPsychometrics.test.ts'),
  },
  {
    id: 'frontend.itemPsychometrics.too-easy-flag',
    scope: 'host',
    file: 'src/lib/itemPsychometrics.ts',
    description: 'Always-correct items must not be silently marked ok.',
    find: "flag = 'too-easy';",
    replace: "flag = 'ok';",
    command: frontendCommand('src/lib/itemPsychometrics.test.ts'),
  },
  {
    id: 'frontend.finance.black-scholes-d2',
    scope: 'host',
    file: 'src/lib/financeMath.ts',
    description: 'Black-Scholes d2 must subtract volatility over sqrt(time).',
    find: 'const d2 = d1 - vol * sqrtT;',
    replace: 'const d2 = d1 + vol * sqrtT;',
    command: frontendCommand('src/lib/financeMath.test.js'),
  },
  {
    id: 'frontend.finance.ytm-bisection',
    scope: 'host',
    file: 'src/lib/financeMath.ts',
    description: 'Bond YTM bisection direction must remain correct.',
    find: 'if (analytics.price > target) low = mid;',
    replace: 'if (analytics.price < target) low = mid;',
    command: frontendCommand('src/lib/financeMath.test.js'),
  },
  {
    id: 'frontend.examReadiness.perfect-accuracy-lift',
    scope: 'host',
    file: 'src/lib/examReadiness.ts',
    description: 'Perfect recent accuracy should produce zero projected learning lift.',
    find: 'const perAttemptLift = clamp(0.75 - averageAccuracy * 0.75, 0, 0.75);',
    replace: 'const perAttemptLift = clamp(0.75 + averageAccuracy * 0.75, 0, 0.75);',
    command: frontendCommand('src/lib/examReadiness.test.ts'),
  },
  {
    id: 'frontend.examReadiness.projection-cap',
    scope: 'host',
    file: 'src/lib/examReadiness.ts',
    description: 'Projection horizon must stay capped at 180 days.',
    find: 'projectionDays = Math.min(180, daysUntilExam);',
    replace: 'projectionDays = Math.max(180, daysUntilExam);',
    command: frontendCommand('src/lib/examReadiness.test.ts'),
  },
  {
    id: 'backend.scoring.low-anchor',
    scope: 'backend',
    file: 'services/lsat-backend/app/scoring.py',
    description: 'The generic score curve lower anchor must stay pinned.',
    find: '    (0.0, 120),',
    replace: '    (0.0, 130),',
    command: backendCommand('tests/test_golden_regression.py'),
  },
  {
    id: 'backend.scoring.zero-total',
    scope: 'backend',
    file: 'services/lsat-backend/app/scoring.py',
    description: 'Scaled prediction must return None when there is no denominator.',
    find: '    if total <= 0:\n        return None',
    replace: '    if total < 0:\n        return None',
    expectedOccurrences: 2,
    command: backendCommand('tests/test_golden_regression.py'),
  },
  {
    id: 'backend.scoring.scale-monotonicity',
    scope: 'backend',
    file: 'services/lsat-backend/app/scoring.py',
    description: 'Official scale tables must reject non-monotonic raw-to-scaled anchors.',
    find: '        if s1 < s0:',
    replace: '        if s1 > s0:',
    command: backendCommand('tests/test_audit_fixes.py', 'tests/test_r7_scheduling.py'),
  },
  {
    id: 'backend.gen_validators.unknown-type-fails-closed',
    scope: 'backend',
    file: 'services/lsat-backend/app/gen_validators.py',
    description: 'Unknown generated question types must fail closed.',
    find:
      '    if fn is None:\n' +
      '        return {\n' +
      '            "ok": False,\n' +
      '            "reason": "unsupported_q_type",\n' +
      '            "check": "unknown_q_type",\n' +
      '            "detail": {"q_type": q_type},\n' +
      '        }',
    replace:
      '    if fn is None:\n' +
      '        return {\n' +
      '            "ok": True,\n' +
      '            "reason": None,\n' +
      '            "check": "unknown_q_type",\n' +
      '            "detail": {"q_type": q_type},\n' +
      '        }',
    command: backendCommand('tests/test_r7_gate.py'),
  },
  {
    id: 'backend.gen_validators.unparseable-critic-fails-closed',
    scope: 'backend',
    file: 'services/lsat-backend/app/gen_validators.py',
    description: 'Unparseable critic replies must not approve necessary-assumption checks.',
    find: '    if obj is None:\n        return _fail("necessary_assumption", "assumption_not_required",\n                     {"parsed": False})',
    replace: '    if obj is None:\n        return _ok("necessary_assumption", {"parsed": False})',
    command: backendCommand('tests/test_r7_gate.py'),
  },
];

function countOccurrences(text, needle) {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

export function applyMutationToText(text, mutation) {
  const occurrences = countOccurrences(text, mutation.find);
  const expectedOccurrences = mutation.expectedOccurrences ?? 1;
  if (occurrences !== expectedOccurrences) {
    throw new Error(
      `${mutation.id}: expected ${expectedOccurrences} occurrence(s) of mutation target, found ${occurrences}`,
    );
  }
  return text.split(mutation.find).join(mutation.replace);
}

function outputTail(output) {
  return String(output || '').split(/\r?\n/).filter(Boolean).slice(-18).join('\n');
}

function runCommand(command) {
  const [exe, ...args] = command.args;
  const result = spawnSync(exe, args, {
    cwd: command.cwd,
    env: { ...process.env, ...(command.env || {}) },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error ? result.error.message : null,
    stdoutTail: outputTail(result.stdout),
    stderrTail: outputTail(result.stderr),
  };
}

function commandLabel(command) {
  return command.args.join(' ');
}

function commandKey(command) {
  return JSON.stringify({
    cwd: command.cwd,
    args: command.args,
    env: command.env || {},
  });
}

export function classifyMutationResult(commandResult) {
  if (commandResult.error !== null) return 'error';
  return commandResult.status !== 0 || commandResult.signal !== null ? 'killed' : 'survived';
}

function assertPreflightPassed(command, commandResult) {
  if (commandResult.error === null && commandResult.status === 0 && commandResult.signal === null) return;
  const detail = [
    `${commandLabel(command)} failed before mutation`,
    `status=${commandResult.status ?? 'null'} signal=${commandResult.signal ?? 'null'}`,
    commandResult.error ? `error=${commandResult.error}` : null,
    commandResult.stdoutTail ? `stdout:\n${commandResult.stdoutTail}` : null,
    commandResult.stderrTail ? `stderr:\n${commandResult.stderrTail}` : null,
  ].filter(Boolean);
  throw new Error(detail.join('\n'));
}

function runPreflight(selectedCases) {
  const commands = new Map();
  for (const mutation of selectedCases) {
    commands.set(commandKey(mutation.command), mutation.command);
  }
  for (const command of commands.values()) {
    process.stdout.write(`preflight ${commandLabel(command)} ... `);
    const result = runCommand(command);
    assertPreflightPassed(command, result);
    process.stdout.write('passed\n');
  }
}

async function runMutation(mutation) {
  const absPath = path.join(REPO_ROOT, mutation.file);
  const original = await readFile(absPath, 'utf8');
  const mutated = applyMutationToText(original, mutation);
  let commandResult;
  try {
    await writeFile(absPath, mutated);
    commandResult = runCommand(mutation.command);
  } finally {
    await writeFile(absPath, original);
  }
  const status = classifyMutationResult(commandResult);
  return {
    id: mutation.id,
    file: mutation.file,
    description: mutation.description,
    status,
    command: commandLabel(mutation.command),
    exitCode: commandResult.status,
    signal: commandResult.signal,
    error: commandResult.error,
    stdoutTail: commandResult.stdoutTail,
    stderrTail: commandResult.stderrTail,
  };
}

export function summarizeMutationResults(results, minScore = MIN_MUTATION_SCORE) {
  const killed = results.filter((result) => result.status === 'killed').length;
  const total = results.length;
  const score = total === 0 ? 0 : killed / total;
  const survivors = results.filter((result) => result.status === 'survived');
  const errors = results.filter((result) => result.status === 'error');
  return {
    total,
    killed,
    survived: survivors.length,
    errored: errors.length,
    score,
    minScore,
    ok: total > 0 && score >= minScore && survivors.length === 0 && errors.length === 0,
    survivors: survivors.map((result) => result.id),
    errors: errors.map((result) => result.id),
  };
}

export function formatMutationMarkdown(report) {
  const rows = [
    '| Mutant | File | Status |',
    '|---|---|---:|',
    ...report.results.map((result) => `| ${result.id} | ${result.file} | ${result.status} |`),
  ];
  return [
    '# Mutation Floor Report',
    '',
    `Generated: ${report.generatedAt}`,
    `Score: ${(report.summary.score * 100).toFixed(1)}% (${report.summary.killed}/${report.summary.total})`,
    `Minimum: ${(report.summary.minScore * 100).toFixed(1)}%`,
    '',
    ...rows,
    '',
  ].join('\n');
}

function parseArgs(argv) {
  const scopeArg = argv.find((arg) => arg.startsWith('--scope='));
  const scope = scopeArg ? scopeArg.split('=')[1] : 'all';
  if (!['all', 'host', 'backend'].includes(scope)) {
    throw new Error(`unsupported mutation scope "${scope}"`);
  }
  return { scope };
}

function reportPaths(scope) {
  if (scope === 'all') return { json: REPORT_PATH, markdown: MARKDOWN_PATH };
  return {
    json: path.join(REPO_ROOT, 'dist', 'reports', `mutation-${scope}.json`),
    markdown: path.join(REPO_ROOT, 'dist', 'reports', `mutation-${scope}.md`),
  };
}

async function main() {
  const { scope } = parseArgs(process.argv.slice(2));
  const selectedCases = mutationCases.filter((mutation) => scope === 'all' || mutation.scope === scope);
  const paths = reportPaths(scope);
  const results = [];
  await mkdir(path.dirname(paths.json), { recursive: true });
  runPreflight(selectedCases);
  for (const mutation of selectedCases) {
    process.stdout.write(`mutation ${mutation.id} ... `);
    const result = await runMutation(mutation);
    results.push(result);
    process.stdout.write(`${result.status}\n`);
  }
  const report = {
    schemaVersion: MUTATION_FLOOR_SCHEMA,
    generatedAt: new Date().toISOString(),
    scope,
    targetCount: selectedCases.length,
    summary: summarizeMutationResults(results),
    results,
  };
  await writeFile(paths.json, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(paths.markdown, formatMutationMarkdown(report));
  if (!report.summary.ok) {
    console.error(
      `mutation-floor: FAIL score=${(report.summary.score * 100).toFixed(1)}% ` +
        `survivors=${report.summary.survivors.join(', ') || 'none'} ` +
        `errors=${report.summary.errors.join(', ') || 'none'}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `mutation-floor: PASS score=${(report.summary.score * 100).toFixed(1)}% ` +
      `(${report.summary.killed}/${report.summary.total} killed)`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`mutation-floor: ERROR ${error?.stack || error}`);
    process.exit(2);
  });
}
