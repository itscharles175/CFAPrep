#!/usr/bin/env node
/*
 * Emit and verify a release manifest with SBOM-like dependency evidence.
 *
 * This is intentionally dependency-free: release evidence should not require a
 * second toolchain to be healthy before it can describe the first one.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SIGNING_EVIDENCE_SCHEMA,
  normalizePlatform,
  validateSigningAssetBindings,
  validateSigningEvidence,
} from './release-signing.mjs';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
export const REPO_ROOT = resolve(SCRIPT_DIR, '..');
export const DEFAULT_OUTPUT = resolve(REPO_ROOT, 'dist', 'studyvault-release-manifest.json');
export const SCHEMA = 'studyvault.release-manifest.v1';

function repoPath(...parts) {
  return resolve(REPO_ROOT, ...parts);
}

function normalizePath(path) {
  return relative(REPO_ROOT, resolve(path)).replace(/\\/g, '/');
}

async function readText(path) {
  return readFile(path, 'utf8');
}

async function readJson(path) {
  return JSON.parse(await readText(path));
}

export async function sha256File(path) {
  const data = await readFile(path);
  return createHash('sha256').update(data).digest('hex');
}

async function hashFileEntry(path, { required = true } = {}) {
  if (!existsSync(path)) {
    return {
      path: normalizePath(path),
      present: false,
      required,
      sha256: null,
      size: 0,
    };
  }
  const info = await stat(path);
  return {
    path: normalizePath(path),
    present: info.isFile(),
    required,
    sha256: info.isFile() ? await sha256File(path) : null,
    size: info.isFile() ? info.size : 0,
  };
}

function git(args) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function firstTomlString(raw, key) {
  const match = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return match ? match[1] : null;
}

function parsePackageBlocks(raw) {
  const blocks = [];
  const pattern = /\[\[package\]\]([\s\S]*?)(?=\r?\n\[\[package\]\]|\s*$)/g;
  for (const match of raw.matchAll(pattern)) {
    const block = match[1];
    blocks.push({
      name: firstTomlString(block, 'name'),
      version: firstTomlString(block, 'version'),
      source: firstTomlString(block, 'source'),
      checksum: firstTomlString(block, 'checksum'),
    });
  }
  return blocks.filter((item) => item.name && item.version);
}

export function parseCargoLock(raw) {
  return parsePackageBlocks(raw).map((item) => ({
    ecosystem: 'cargo',
    name: item.name,
    version: item.version,
    source: item.source,
    checksum: item.checksum,
  }));
}

export function parseUvLock(raw) {
  return parsePackageBlocks(raw).map((item) => ({
    ecosystem: 'pypi',
    name: item.name,
    version: item.version,
    source: item.source,
    checksum: item.checksum,
  }));
}

export function parseNpmLock(lock) {
  const packages = lock.packages || {};
  return Object.entries(packages)
    .filter(([path, pkg]) => path.startsWith('node_modules/') && pkg?.version)
    .map(([path, pkg]) => ({
      ecosystem: 'npm',
      name: pkg.name || path.replace(/^node_modules\//, ''),
      version: pkg.version,
      dev: Boolean(pkg.dev),
      resolved: pkg.resolved || null,
      integrity: pkg.integrity || null,
    }))
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}

async function walkFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  async function visit(path) {
    const info = await stat(path);
    if (info.isDirectory()) {
      const entries = await readdir(path);
      for (const entry of entries) {
        await visit(join(path, entry));
      }
      return;
    }
    if (info.isFile() && info.size > 0) {
      out.push(path);
    }
  }
  await visit(root);
  return out;
}

export async function collectBundleAssets({ debug = false } = {}) {
  const roots = debug
    ? [repoPath('src-tauri', 'target', 'debug', 'bundle')]
    : [
        repoPath('src-tauri', 'target', 'release', 'bundle'),
        repoPath('src-tauri', 'target', 'universal-apple-darwin', 'release', 'bundle'),
      ];
  const files = [];
  for (const root of roots) {
    files.push(...(await walkFiles(root)));
  }
  files.sort((a, b) => normalizePath(a).localeCompare(normalizePath(b)));
  return Promise.all(
    files.map(async (path) => {
      const info = await stat(path);
      return {
        path: normalizePath(path),
        sha256: await sha256File(path),
        size: info.size,
      };
    }),
  );
}

async function buildLockEvidence() {
  const entries = [
    ['package-lock.json', true],
    [join('src-tauri', 'Cargo.lock'), true],
    [join('services', 'lsat-backend', 'uv.lock'), true],
    [join('services', 'lsat-backend', 'pyproject.toml'), true],
    [join('src-tauri', 'Cargo.toml'), true],
    [join('src-tauri', 'tauri.conf.json'), true],
  ];
  return Promise.all(entries.map(([path, required]) => hashFileEntry(repoPath(path), { required })));
}

async function buildComponentEvidence() {
  const packageLockPath = repoPath('package-lock.json');
  const cargoLockPath = repoPath('src-tauri', 'Cargo.lock');
  const uvLockPath = repoPath('services', 'lsat-backend', 'uv.lock');
  const npm = existsSync(packageLockPath) ? parseNpmLock(await readJson(packageLockPath)) : [];
  const cargo = existsSync(cargoLockPath) ? parseCargoLock(await readText(cargoLockPath)) : [];
  const pypi = existsSync(uvLockPath) ? parseUvLock(await readText(uvLockPath)) : [];
  return {
    counts: {
      npm: npm.length,
      cargo: cargo.length,
      pypi: pypi.length,
      total: npm.length + cargo.length + pypi.length,
    },
    npm,
    cargo,
    pypi,
  };
}

async function sidecarProvenanceEvidence() {
  const path = repoPath('src-tauri', 'resources', 'services', 'sidecar-provenance.json');
  if (!existsSync(path)) {
    return {
      present: false,
      path: normalizePath(path),
      sha256: null,
      entries: [],
    };
  }
  const manifest = await readJson(path);
  return {
    present: true,
    path: normalizePath(path),
    sha256: await sha256File(path),
    schema: manifest.schema || null,
    entries: Array.isArray(manifest.entries)
      ? manifest.entries.map((entry) => ({
          service: entry.service || null,
          path: entry.path || null,
          sha256: entry.sha256 || null,
          size: Number(entry.size || 0),
          optional: Boolean(entry.optional),
          source: entry.source || null,
        }))
      : [],
  };
}

async function versionEvidence() {
  const packageJson = await readJson(repoPath('package.json'));
  const tauriConf = await readJson(repoPath('src-tauri', 'tauri.conf.json'));
  const cargoToml = await readText(repoPath('src-tauri', 'Cargo.toml'));
  const cargoVersion = firstTomlString(cargoToml, 'version');
  return {
    package: packageJson.version || null,
    tauri: tauriConf.version || null,
    cargo: cargoVersion,
    consistent: Boolean(packageJson.version && packageJson.version === tauriConf.version && packageJson.version === cargoVersion),
  };
}

async function signingEvidence() {
  const evidencePath = String(process.env.STUDYVAULT_SIGNING_EVIDENCE || '').trim();
  if (evidencePath) {
    const evidence = await readJson(resolve(evidencePath));
    const validation = validateSigningEvidence(evidence);
    if (!validation.ok) {
      throw new Error(`invalid signing evidence: ${validation.errors.join('; ')}`);
    }
    return evidence;
  }
  const platform = normalizePlatform(process.platform);
  return {
    schema: SIGNING_EVIDENCE_SCHEMA,
    generatedAt: new Date().toISOString(),
    platform,
    required: platform !== 'linux',
    status: platform === 'linux' ? 'not_applicable' : 'unverified',
    artifacts: [],
  };
}

export async function buildReleaseManifest({ debug = false } = {}) {
  const [versions, lockfiles, components, sidecars, assets, signing] = await Promise.all([
    versionEvidence(),
    buildLockEvidence(),
    buildComponentEvidence(),
    sidecarProvenanceEvidence(),
    collectBundleAssets({ debug }),
    signingEvidence(),
  ]);
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    repository: {
      head: git(['rev-parse', 'HEAD']),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      dirty: Boolean(git(['status', '--porcelain'])),
    },
    versions,
    lockfiles,
    sbom: components,
    sidecarProvenance: sidecars,
    bundleAssets: assets,
    signing,
    attestation: {
      type: 'local-release-manifest',
      predicateType: SCHEMA,
      note: 'Hash manifest generated locally; platform signing status is captured separately above.',
    },
  };
}

export function validateReleaseManifest(
  manifest,
  {
    requireAssets = false,
    requireSidecarProvenance = false,
    requireSigning = false,
    signingPlatform = process.platform,
  } = {},
) {
  const errors = [];
  if (manifest?.schema !== SCHEMA) {
    errors.push(`unsupported schema: ${manifest?.schema || '<missing>'}`);
  }
  if (!manifest?.versions?.consistent) {
    errors.push('package, Tauri, and Cargo versions are not consistent');
  }
  for (const entry of manifest?.lockfiles || []) {
    if (entry.required && (!entry.present || !entry.sha256 || entry.size <= 0)) {
      errors.push(`required lock/config input is missing or empty: ${entry.path}`);
    }
  }
  const counts = manifest?.sbom?.counts || {};
  for (const key of ['npm', 'cargo', 'pypi']) {
    if (!Number.isInteger(counts[key]) || counts[key] <= 0) {
      errors.push(`SBOM has no ${key} components`);
    }
  }
  if (requireSidecarProvenance && !manifest?.sidecarProvenance?.present) {
    errors.push('sidecar provenance manifest is required but missing');
  }
  if (requireSidecarProvenance && !manifest?.sidecarProvenance?.entries?.some((entry) => entry.service === 'LSAT backend')) {
    errors.push('sidecar provenance is missing the required LSAT backend entry');
  }
  if (requireAssets && !manifest?.bundleAssets?.length) {
    errors.push('release bundle assets are required but none were found');
  }
  if (requireSigning) {
    const signing = validateSigningEvidence(manifest?.signing, { requireSigned: true });
    errors.push(...signing.errors.map((error) => `signing: ${error}`));
    if (signing.ok) {
      if (normalizePlatform(manifest.signing.platform) !== normalizePlatform(signingPlatform)) {
        errors.push('signing: evidence platform does not match the current release platform');
      }
      const bindings = validateSigningAssetBindings(manifest.signing, manifest.bundleAssets);
      errors.push(...bindings.errors.map((error) => `signing: ${error}`));
    }
  }
  return { ok: errors.length === 0, errors };
}

async function writeReleaseManifest({ output, debug, requireAssets, requireSidecarProvenance, requireSigning }) {
  const manifest = await buildReleaseManifest({ debug });
  const validation = validateReleaseManifest(manifest, { requireAssets, requireSidecarProvenance, requireSigning });
  if (!validation.ok) {
    throw new Error(`release manifest validation failed: ${validation.errors.join('; ')}`);
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

async function checkReleaseManifest({ output, requireAssets, requireSidecarProvenance, requireSigning }) {
  const manifest = await readJson(output);
  const validation = validateReleaseManifest(manifest, { requireAssets, requireSidecarProvenance, requireSigning });
  if (!validation.ok) {
    throw new Error(`release manifest validation failed: ${validation.errors.join('; ')}`);
  }
  return manifest;
}

function parseArgs(argv) {
  const [command = 'write', ...rest] = argv;
  const opts = {
    command,
    output: DEFAULT_OUTPUT,
    debug: false,
    requireAssets: false,
    requireSidecarProvenance: false,
    requireSigning: false,
  };
  while (rest.length) {
    const arg = rest.shift();
    if (arg === '--output') opts.output = resolve(rest.shift());
    else if (arg === '--debug') opts.debug = true;
    else if (arg === '--require-assets') opts.requireAssets = true;
    else if (arg === '--require-sidecar-provenance') opts.requireSidecarProvenance = true;
    else if (arg === '--require-signing') opts.requireSigning = true;
    else throw new Error(`unknown release-manifest arg: ${arg}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.command === 'write') {
    const manifest = await writeReleaseManifest(opts);
    console.log(
      `release-manifest: wrote ${normalizePath(opts.output)} ` +
        `(${manifest.sbom.counts.total} components, ${manifest.bundleAssets.length} assets)`,
    );
    return;
  }
  if (opts.command === 'check') {
    const manifest = await checkReleaseManifest(opts);
    console.log(
      `release-manifest: OK ${normalizePath(opts.output)} ` +
        `(${manifest.sbom.counts.total} components, ${manifest.bundleAssets.length} assets)`,
    );
    return;
  }
  throw new Error('usage: release-manifest.mjs write|check [--output path] [--debug] [--require-assets] [--require-sidecar-provenance] [--require-signing]');
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(`release-manifest: ${error.message}`);
    process.exit(1);
  });
}
