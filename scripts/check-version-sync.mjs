#!/usr/bin/env node
/*
 * Single version source-of-truth gate (Roadmap DX-2).
 *
 * The app version lives in several places that historically drifted apart (the
 * .env shipped 0.1.0 while package.json shipped 0.9.0, so the running app
 * reported the wrong number). This gate READS every version source and fails the
 * build when they disagree. package.json is the canonical source — everything
 * else must match it.
 *
 * Sources checked (all read-only — this script never writes):
 *   - package.json                              .version            (CANONICAL)
 *   - .env                                      VITE_APP_VERSION    (if present)
 *   - services/lsat-backend/app/config.py       APP_VERSION default (if present)
 *
 * Usage:
 *   node scripts/check-version-sync.mjs            # verify every source matches
 *   node scripts/check-version-sync.mjs --git-tag  # ALSO require the current git
 *                                                  # tag (vX.Y.Z) to match the
 *                                                  # canonical version (release gate)
 *
 * Exit codes: 0 = every (present) source agrees with package.json; 1 = at least
 * one source disagrees, or --git-tag was requested and the tag mismatches/absent.
 *
 * NOTE: services/lsat-backend/app/config.py is an enforced source now. A drift
 * there fails the gate because FastAPI health reports that value at runtime.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

/** Read a file as UTF-8, or null when it does not exist (optional sources). */
function readMaybe(relPath) {
  const abs = join(REPO_ROOT, relPath);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, 'utf8');
}

/** package.json .version — the canonical source of truth. */
function packageVersion() {
  const raw = readMaybe('package.json');
  if (raw === null) return null;
  return JSON.parse(raw).version ?? null;
}

/** .env VITE_APP_VERSION (optional — only checked when the key is present). */
function envVersion() {
  const raw = readMaybe('.env');
  if (raw === null) return null;
  const match = raw.match(/^\s*VITE_APP_VERSION\s*=\s*(.+?)\s*$/m);
  return match ? match[1].replace(/^["']|["']$/g, '') : null;
}

/**
 * services/lsat-backend/app/config.py APP_VERSION default. Read-only: another
 * slice owns this file. The default is the second arg of the `_env(...)` call,
 * e.g. APP_VERSION = _env("LSATLAB_APP_VERSION", "0.9.0").
 */
function configPyVersion() {
  const raw = readMaybe(join('services', 'lsat-backend', 'app', 'config.py'));
  if (raw === null) return null;
  const match = raw.match(/APP_VERSION\s*=\s*_env\(\s*"[^"]*"\s*,\s*"([^"]+)"\s*\)/);
  return match ? match[1] : null;
}

/** Normalize vX.Y.Z-style tags to the bare package.json version string. */
function normalizeTagVersion(tag) {
  const clean = tag.trim().replace(/^refs\/tags\//, '');
  return clean.replace(/^v/, '') || null;
}

/** Current release tag (vX.Y.Z), or null when HEAD/ref is not tagged. */
function gitTagVersion() {
  // In GitHub Actions release workflows, prefer the event ref over `git
  // describe`; checkout can be shallow, but github.ref_name is authoritative.
  if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME) {
    return normalizeTagVersion(process.env.GITHUB_REF_NAME);
  }
  if (process.env.GITHUB_REF?.startsWith('refs/tags/')) {
    return normalizeTagVersion(process.env.GITHUB_REF);
  }

  const res = spawnSync('git', ['describe', '--tags', '--exact-match'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (res.status !== 0 || !res.stdout) return null;
  return normalizeTagVersion(res.stdout);
}

const wantGitTag = process.argv.slice(2).includes('--git-tag');

const canonical = packageVersion();
if (!canonical) {
  console.error('check:versions FAILED — could not read package.json .version');
  process.exit(1);
}

// label, value, optional? (optional sources are skipped when null/absent)
const sources = [
  ['package.json', canonical, false],
  ['.env (VITE_APP_VERSION)', envVersion(), true],
  ['services/lsat-backend/app/config.py (APP_VERSION)', configPyVersion(), true],
];

let failures = 0;
console.log(`canonical version (package.json): ${canonical}`);
for (const [label, value, optional] of sources) {
  if (value === null) {
    if (optional) {
      console.log(`${'skip'.padEnd(8)} ${label}: not present`);
    } else {
      failures += 1;
      console.log(`${'MISSING'.padEnd(8)} ${label}: required version source not found`);
    }
    continue;
  }
  const ok = value === canonical;
  if (!ok) failures += 1;
  console.log(`${(ok ? 'ok' : 'MISMATCH').padEnd(8)} ${label}: ${value}`);
}

if (wantGitTag) {
  const tag = gitTagVersion();
  if (tag === null) {
    console.error(`${'MISSING'.padEnd(8)} git tag: HEAD is not tagged vX.Y.Z (required by --git-tag)`);
    failures += 1;
  } else {
    const ok = tag === canonical;
    if (!ok) failures += 1;
    console.log(`${(ok ? 'ok' : 'MISMATCH').padEnd(8)} git tag: ${tag}`);
  }
}

if (failures) {
  console.error(`check:versions FAILED — ${failures} source(s) disagree with package.json (${canonical}).`);
  process.exit(1);
}
console.log('check:versions OK — all version sources agree.');
