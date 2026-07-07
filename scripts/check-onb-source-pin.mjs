#!/usr/bin/env node
/*
 * Verify the optional open-notebook sidecar source is pinned to an immutable
 * commit SHA before a RAG-enabled release build packages it.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_ONB_DIR = resolve(REPO_ROOT, 'spike', 'open-notebook');

export function isFullCommitSha(value) {
  return /^[0-9a-f]{40}$/i.test(String(value || '').trim());
}

export function evaluateOpenNotebookSourcePin({
  dirPresent,
  expectedRef,
  actualHead,
  dirtyOutput = '',
  optional = false,
} = {}) {
  const expected = String(expectedRef || '').trim();
  const actual = String(actualHead || '').trim();
  const errors = [];

  if (!dirPresent) {
    return optional
      ? { ok: true, skipped: true, errors: [] }
      : { ok: false, skipped: false, errors: ['open-notebook source directory is missing'] };
  }

  if (!expected) {
    errors.push('ONB_GIT_REF/--expected is required when open-notebook source is present');
  } else if (!isFullCommitSha(expected)) {
    errors.push('open-notebook source must be pinned to a full 40-character commit SHA');
  }

  if (!actual) {
    errors.push('could not read open-notebook HEAD commit');
  } else if (isFullCommitSha(expected) && actual.toLowerCase() !== expected.toLowerCase()) {
    errors.push(`open-notebook HEAD ${actual} does not match pinned commit ${expected}`);
  }

  if (String(dirtyOutput || '').trim()) {
    errors.push('open-notebook source tree has uncommitted changes');
  }

  return { ok: errors.length === 0, skipped: false, errors };
}

function git(dir, args) {
  const result = spawnSync('git', ['-C', dir, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function checkOpenNotebookSourcePin({
  dir = DEFAULT_ONB_DIR,
  expectedRef = process.env.ONB_GIT_SHA || process.env.ONB_GIT_REF || '',
  optional = false,
} = {}) {
  const sourceDir = resolve(dir);
  const dirPresent = existsSync(sourceDir);
  const actualHead = dirPresent ? git(sourceDir, ['rev-parse', 'HEAD']) : null;
  const dirtyOutput = dirPresent ? git(sourceDir, ['status', '--porcelain']) || '' : '';
  return evaluateOpenNotebookSourcePin({
    dirPresent,
    expectedRef,
    actualHead,
    dirtyOutput,
    optional,
  });
}

function parseArgs(argv) {
  const opts = { dir: DEFAULT_ONB_DIR, expectedRef: undefined, optional: false };
  const rest = [...argv];
  while (rest.length) {
    const arg = rest.shift();
    if (arg === '--dir') opts.dir = resolve(rest.shift() || '');
    else if (arg === '--expected') opts.expectedRef = rest.shift() || '';
    else if (arg === '--optional') opts.optional = true;
    else throw new Error(`unknown check-onb-source-pin arg: ${arg}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = checkOpenNotebookSourcePin(opts);
  if (result.ok) {
    console.log(result.skipped ? 'check:onb-source-pin SKIP - open-notebook source absent' : 'check:onb-source-pin OK');
    return;
  }
  console.error(`check:onb-source-pin FAILED - ${result.errors.join('; ')}`);
  process.exit(1);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;

if (invokedPath === __filename) {
  try {
    main();
  } catch (error) {
    console.error(`check:onb-source-pin FAILED - ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
