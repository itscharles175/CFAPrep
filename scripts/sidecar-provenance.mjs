#!/usr/bin/env node
/*
 * Generate and verify the bundled-sidecar provenance manifest.
 *
 * The manifest lives under electron/resources/services so Electron ships it with
 * the sidecar resources. Build scripts record entries after copying binaries;
 * release/native checks verify that the recorded size and sha256 still match.
 */
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(__filename, '..', '..');
const SERVICES_ROOT = resolve(REPO_ROOT, 'electron', 'resources', 'services');
const DEFAULT_MANIFEST = resolve(SERVICES_ROOT, 'sidecar-provenance.json');
const SCHEMA = 'studyvault.sidecar-provenance.v1';

function normalizeRelativePath(value) {
  return String(value).replace(/\\/g, '/').replace(/^\/+/, '');
}

function relativeToServices(path, servicesRoot = SERVICES_ROOT) {
  const rel = relative(servicesRoot, resolve(path));
  if (rel.startsWith('..') || rel === '') {
    throw new Error(`sidecar path must be inside ${servicesRoot}: ${path}`);
  }
  return normalizeRelativePath(rel);
}

function manifestServicesRoot(manifestPath = DEFAULT_MANIFEST) {
  return dirname(resolve(manifestPath));
}

export async function sha256File(path) {
  const data = await readFile(path);
  return createHash('sha256').update(data).digest('hex');
}

async function readManifest(manifestPath = DEFAULT_MANIFEST) {
  if (!existsSync(manifestPath)) {
    return {
      schema: SCHEMA,
      generatedAt: null,
      servicesRoot: 'electron/resources/services',
      entries: [],
    };
  }
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (parsed.schema !== SCHEMA) {
    throw new Error(`unsupported sidecar provenance schema: ${parsed.schema || '<missing>'}`);
  }
  if (!Array.isArray(parsed.entries)) {
    throw new Error('sidecar provenance manifest entries must be an array');
  }
  return parsed;
}

export async function recordSidecarProvenance({
  service,
  binaryPath,
  source,
  optional = false,
  manifestPath = DEFAULT_MANIFEST,
} = {}) {
  if (!service || !binaryPath) {
    throw new Error('recordSidecarProvenance requires service and binaryPath');
  }
  const abs = resolve(binaryPath);
  const servicesRoot = manifestServicesRoot(manifestPath);
  const stats = statSync(abs);
  if (!stats.isFile() || stats.size <= 0) {
    throw new Error(`sidecar binary is missing or empty: ${binaryPath}`);
  }
  const manifest = await readManifest(manifestPath);
  const entry = {
    service,
    path: relativeToServices(abs, servicesRoot),
    sha256: await sha256File(abs),
    size: stats.size,
    optional: Boolean(optional),
    source: source || null,
    recordedAt: new Date().toISOString(),
  };
  const entries = manifest.entries.filter(
    (item) => item?.service !== service && normalizeRelativePath(item?.path || '') !== entry.path,
  );
  entries.push(entry);
  entries.sort((a, b) => String(a.service).localeCompare(String(b.service)));
  const next = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    servicesRoot: normalizeRelativePath(relative(REPO_ROOT, servicesRoot)),
    entries,
  };
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return entry;
}

export async function verifySidecarProvenance({ manifestPath = DEFAULT_MANIFEST, requireServices = [] } = {}) {
  const manifest = await readManifest(manifestPath);
  const servicesRoot = manifestServicesRoot(manifestPath);
  const failures = [];
  const verified = [];
  const serviceSet = new Set();
  for (const entry of manifest.entries) {
    const service = String(entry?.service || '');
    const relPath = normalizeRelativePath(entry?.path || '');
    serviceSet.add(service);
    const abs = resolve(servicesRoot, relPath.split('/').join(sep));
    if (relative(servicesRoot, abs).startsWith('..')) {
      failures.push({ service, path: relPath, reason: 'path_escapes_manifest' });
      continue;
    }
    if (!service || !relPath || !entry?.sha256) {
      failures.push({ service, path: relPath, reason: 'invalid_entry' });
      continue;
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      failures.push({ service, path: relPath, reason: 'missing_binary' });
      continue;
    }
    const stats = statSync(abs);
    const actualSha256 = await sha256File(abs);
    if (Number(entry.size) !== stats.size || String(entry.sha256) !== actualSha256) {
      failures.push({
        service,
        path: relPath,
        reason: 'digest_mismatch',
        expectedSha256: entry.sha256,
        actualSha256,
        expectedSize: entry.size,
        actualSize: stats.size,
      });
      continue;
    }
    verified.push({ service, path: relPath, sha256: actualSha256, size: stats.size });
  }
  for (const service of requireServices) {
    if (!serviceSet.has(service)) {
      failures.push({ service, path: null, reason: 'missing_required_service' });
    }
  }
  return {
    ok: failures.length === 0,
    manifestPath,
    entryCount: manifest.entries.length,
    verified,
    failures,
  };
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  const opts = { command, requireServices: [] };
  while (rest.length) {
    const arg = rest.shift();
    if (arg === '--service') opts.service = rest.shift();
    else if (arg === '--path') opts.binaryPath = rest.shift();
    else if (arg === '--source') opts.source = rest.shift();
    else if (arg === '--optional') opts.optional = true;
    else if (arg === '--manifest') opts.manifestPath = resolve(rest.shift());
    else if (arg === '--require') opts.requireServices.push(rest.shift());
    else throw new Error(`unknown sidecar-provenance arg: ${arg}`);
  }
  return opts;
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  if (opts.command === 'record') {
    const entry = await recordSidecarProvenance(opts);
    console.log(`sidecar-provenance: recorded ${entry.service} ${entry.path}`);
    return;
  }
  if (opts.command === 'check') {
    const result = await verifySidecarProvenance(opts);
    if (result.ok) {
      console.log(`sidecar-provenance: OK (${result.verified.length}/${result.entryCount} verified)`);
      return;
    }
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  throw new Error('usage: sidecar-provenance.mjs record|check [options]');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;

if (invokedPath === __filename) {
  main().catch((error) => {
    console.error(`sidecar-provenance: ${error.message}`);
    process.exit(1);
  });
}
