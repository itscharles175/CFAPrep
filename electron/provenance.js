import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isPathWithin } from './path-policy.js';

export const SIDECAR_PROVENANCE_SCHEMA = 'studyvault.sidecar-provenance.v1';
export const SIDECAR_PROVENANCE_FILE = 'sidecar-provenance.json';

export function manifestRelativePath(input) {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) return null;
  const normalized = input.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return segments.join(path.sep);
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  let size = 0;
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return { sha256: hash.digest('hex'), size };
}

function verdict(status, message = null, blocksLaunch = true) {
  return { status, message, blocksLaunch };
}

function parseManifest(raw) {
  const manifest = JSON.parse(raw);
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    manifest.schema !== SIDECAR_PROVENANCE_SCHEMA ||
    !Array.isArray(manifest.entries)
  ) {
    throw new Error('Unsupported sidecar provenance manifest shape or schema');
  }
  return manifest;
}

export async function verifyServiceProvenance(spec, servicesDirectory) {
  if (!spec.provenanceRequired) return verdict('not_applicable', null, false);
  const manifestPath = path.join(servicesDirectory, SIDECAR_PROVENANCE_FILE);
  let manifest;
  try {
    const manifestInfo = await lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
      return verdict('invalid_manifest', 'Provenance manifest is not a regular file');
    }
    manifest = parseManifest(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    return verdict('invalid_manifest', `Provenance manifest unavailable: ${error.message}`);
  }

  const provenanceService = spec.provenanceService ?? spec.name;
  const entry = manifest.entries.find((candidate) => candidate?.service === provenanceService);
  if (!entry) return verdict('missing_entry', `No provenance entry exists for ${spec.name}`);
  if (
    typeof entry.sha256 !== 'string' ||
    !/^[a-fA-F0-9]{64}$/.test(entry.sha256) ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0
  ) {
    return verdict('invalid_entry', `Provenance entry is invalid for ${spec.name}`);
  }
  const relative = manifestRelativePath(entry.path);
  if (!relative) return verdict('path_escapes_manifest', `Invalid provenance path for ${spec.name}`);

  try {
    const canonicalRoot = await realpath(servicesDirectory);
    const declaredPath = path.resolve(canonicalRoot, relative);
    if (!isPathWithin(canonicalRoot, declaredPath)) {
      return verdict('path_escapes_manifest', `Provenance path escapes services root for ${spec.name}`);
    }
    const declaredInfo = await lstat(declaredPath);
    if (!declaredInfo.isFile() || declaredInfo.isSymbolicLink()) {
      return verdict('missing_binary', `Provenance binary is not a regular file for ${spec.name}`);
    }
    const canonicalDeclared = await realpath(declaredPath);
    const canonicalProgram = await realpath(spec.program);
    if (canonicalDeclared !== canonicalProgram || !isPathWithin(canonicalRoot, canonicalProgram)) {
      return verdict('path_mismatch', `Provenance path does not match ${spec.name}`);
    }
    const actual = await sha256File(canonicalProgram);
    if (actual.sha256 !== entry.sha256.toLocaleLowerCase('en-US') || actual.size !== entry.size) {
      return verdict('digest_mismatch', `Provenance digest or size mismatch for ${spec.name}`);
    }
    return verdict('verified', null, false);
  } catch (error) {
    if (error?.code === 'ENOENT') return verdict('missing_binary', `Binary is missing for ${spec.name}`);
    return verdict('unreadable_binary', `Cannot verify ${spec.name}: ${error.message}`);
  }
}
