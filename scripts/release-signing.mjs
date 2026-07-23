#!/usr/bin/env node
/*
 * Fail-closed platform signing policy and post-build artifact verification.
 * Secrets are read from the environment and are never written to evidence.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');

export const SIGNING_EVIDENCE_SCHEMA = 'studyvault.signing-evidence.v1';

const BUILDER_CONFIG_FILE = 'electron-builder.yml';

const CREDENTIALS = Object.freeze({
  windows: ['WINDOWS_CERT_BASE64', 'WINDOWS_CERT_PASSWORD', 'WINDOWS_CERT_THUMBPRINT'],
  macos: [
    'APPLE_CERTIFICATE_BASE64',
    'APPLE_CERTIFICATE_PASSWORD',
    'APPLE_SIGNING_IDENTITY',
    'APPLE_ID',
    'APPLE_PASSWORD',
    'APPLE_TEAM_ID',
  ],
  linux: [],
});

export function normalizePlatform(value = process.platform) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (['win32', 'windows', 'windows-latest'].includes(normalized)) return 'windows';
  if (['darwin', 'macos', 'macos-latest'].includes(normalized)) return 'macos';
  if (['linux', 'ubuntu', 'ubuntu-latest'].includes(normalized)) return 'linux';
  throw new Error(`unsupported signing platform: ${value || '<missing>'}`);
}

export function normalizeThumbprint(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

export function inspectCredentialSet(platformValue, env = process.env) {
  const platform = normalizePlatform(platformValue);
  const required = CREDENTIALS[platform];
  const missing = required.filter((name) => !String(env[name] || '').trim());
  const errors = [];
  if (platform === 'windows' && !missing.includes('WINDOWS_CERT_THUMBPRINT')) {
    const thumbprint = normalizeThumbprint(env.WINDOWS_CERT_THUMBPRINT);
    if (!/^[A-F0-9]{40}$/.test(thumbprint)) {
      errors.push('WINDOWS_CERT_THUMBPRINT must be a 40-character SHA-1 certificate thumbprint');
    }
  }
  return {
    platform,
    required: platform !== 'linux',
    complete: missing.length === 0 && errors.length === 0,
    missing,
    errors,
  };
}

/*
 * `electron-builder --config <path>` REPLACES electron-builder.yml rather than
 * merging with it (app-builder-lib getConfig reads only the given file and never
 * falls back to findAndReadConfig), so an overlay without `extends` silently
 * drops forceCodeSigning, the MSI target, the sidecar extraResources, and the
 * afterPack fuse hook. `extends` is resolved against the project directory, not
 * the overlay's own directory, so it stays a bare repo-relative name even though
 * the overlay is written outside the repo.
 */
export function buildWindowsSigningConfig(thumbprint) {
  const normalized = normalizeThumbprint(thumbprint);
  if (!/^[A-F0-9]{40}$/.test(normalized)) {
    throw new Error('cannot build Windows signing config without a valid certificate thumbprint');
  }
  return {
    extends: BUILDER_CONFIG_FILE,
    win: {
      signtoolOptions: {
        certificateSha1: normalized,
      },
    },
  };
}

function builderTargets(section) {
  const targets = section?.target;
  const list = Array.isArray(targets) ? targets : targets ? [targets] : [];
  return list.map((item) => String(typeof item === 'string' ? item : item?.target || ''));
}

export function validateEffectiveBuilderConfig(config, { expectedThumbprint = '' } = {}) {
  const errors = [];
  if (config?.forceCodeSigning !== true) errors.push('forceCodeSigning must remain true');
  if (config?.directories?.output !== 'release') errors.push("directories.output must remain 'release'");
  for (const target of ['nsis', 'msi']) {
    if (!builderTargets(config?.win).includes(target)) errors.push(`win.target must still include ${target}`);
  }
  if (!(Array.isArray(config?.extraResources) ? config.extraResources : []).some((item) => item?.to === 'services')) {
    errors.push('extraResources must still stage the sidecar services directory');
  }
  if (!config?.afterPack) errors.push('afterPack must still apply the Electron fuses');
  const expected = normalizeThumbprint(expectedThumbprint);
  if (expected && normalizeThumbprint(config?.win?.signtoolOptions?.certificateSha1) !== expected) {
    errors.push('win.signtoolOptions.certificateSha1 does not pin the expected certificate');
  }
  return { ok: errors.length === 0, errors };
}

export async function resolveEffectiveBuilderConfig(configPath) {
  // app-builder-lib owns the real precedence rules, so resolve the config the
  // way electron-builder will instead of re-implementing the merge here.
  const { getConfig } = await import('app-builder-lib/out/util/config/config.js');
  return getConfig(REPO_ROOT, configPath ? resolve(configPath) : null, null);
}

function evidencePath(path) {
  const rel = relative(REPO_ROOT, resolve(path));
  return rel && !rel.startsWith('..') ? rel.replace(/\\/g, '/') : basename(path);
}

async function sha256File(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function nonEmptyFile(path) {
  if (!existsSync(path)) return false;
  const info = await stat(path);
  return info.isFile() && info.size > 0;
}

async function filesIn(path, predicate) {
  if (!existsSync(path)) return [];
  const entries = await readdir(path, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && predicate(entry.name)).map((entry) => join(path, entry.name));
}

/*
 * Signing evidence and the release manifest hash the same bundle trees, so both
 * must walk them identically or a .app digest can never bind to its assets.
 * Dirents carry lstat semantics: symlinks — which a real .app bundle is full of
 * — are skipped rather than followed, and zero-byte files are kept, on both
 * sides. release-manifest.mjs reuses this walker for exactly that reason.
 */
export async function walkBundleFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  }
  await visit(root);
  return files;
}

export async function hashDirectory(path) {
  const files = await walkBundleFiles(path);
  files.sort((a, b) => {
    const left = relative(path, a).replace(/\\/g, '/');
    const right = relative(path, b).replace(/\\/g, '/');
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const digest = createHash('sha256');
  let size = 0;
  for (const file of files) {
    const info = await lstat(file);
    const rel = relative(path, file).replace(/\\/g, '/');
    const fileHash = await sha256File(file);
    digest.update(`${rel}\0${fileHash}\0${info.size}\n`);
    size += info.size;
  }
  return { sha256: digest.digest('hex'), size };
}

async function directoriesIn(path, predicate) {
  if (!existsSync(path)) return [];
  const entries = await readdir(path, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() && predicate(entry.name)).map((entry) => join(path, entry.name));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return { stdout: result.stdout || '', stderr: result.stderr || '' };
}

async function collectWindowsArtifacts(bundleRoot) {
  const root = resolve(bundleRoot);
  const entries = await readdir(root, { withFileTypes: true });
  const nsis = entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.exe')
    .map((entry) => join(root, entry.name));
  const msi = entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.msi')
    .map((entry) => join(root, entry.name));
  const unpackedDirs = entries
    .filter((entry) => entry.isDirectory() && /^win(?:-[^-]+)?-unpacked$/i.test(entry.name))
    .map((entry) => join(root, entry.name));
  const apps = [];
  for (const dir of unpackedDirs) {
    apps.push(...(await filesIn(dir, (name) => /^StudyVault\.exe$/i.test(name))));
  }
  const artifacts = [...new Set([...apps, ...nsis, ...msi])];
  if (!apps.length || !nsis.length || !msi.length) {
    throw new Error('Windows signing verification requires the app executable plus non-empty NSIS and MSI artifacts');
  }
  return { apps: new Set(apps), nsis: new Set(nsis), msi: new Set(msi), artifacts };
}

function windowsSignature(path) {
  const script = [
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:STUDYVAULT_SIGN_TARGET',
    '$cert = $signature.SignerCertificate',
    '$timestamp = $signature.TimeStamperCertificate',
    '[ordered]@{ status = [string]$signature.Status; thumbprint = if ($cert) { $cert.Thumbprint } else { $null }; subject = if ($cert) { $cert.Subject } else { $null }; timestampThumbprint = if ($timestamp) { $timestamp.Thumbprint } else { $null } } | ConvertTo-Json -Compress',
  ].join('; ');
  const env = { ...process.env, STUDYVAULT_SIGN_TARGET: resolve(path) };
  let result;
  try {
    result = run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { env });
  } catch (error) {
    if (!String(error.message).includes('ENOENT')) throw error;
    result = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { env });
  }
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  return JSON.parse(line || '{}');
}

export async function verifyWindowsArtifacts({
  bundleRoot,
  expectedThumbprint,
  signatureInspector = windowsSignature,
}) {
  const expected = normalizeThumbprint(expectedThumbprint);
  if (!/^[A-F0-9]{40}$/.test(expected)) {
    throw new Error('Windows verification requires WINDOWS_CERT_THUMBPRINT');
  }
  const artifacts = [];
  const collected = await collectWindowsArtifacts(bundleRoot);
  for (const path of collected.artifacts) {
    if (!(await nonEmptyFile(path))) throw new Error(`empty Windows release artifact: ${path}`);
    const signature = signatureInspector(path);
    const actual = normalizeThumbprint(signature.thumbprint);
    const timestampThumbprint = normalizeThumbprint(signature.timestampThumbprint);
    if (signature.status !== 'Valid' || actual !== expected || !timestampThumbprint) {
      throw new Error(
        `invalid Authenticode signature for ${path}: status=${signature.status || '<missing>'} thumbprint=${actual || '<missing>'} timestamp=${timestampThumbprint || '<missing>'}`,
      );
    }
    const info = await stat(path);
    artifacts.push({
      path: evidencePath(path),
      kind: collected.msi.has(path) ? 'msi' : collected.nsis.has(path) ? 'nsis' : 'app',
      size: info.size,
      sha256: await sha256File(path),
      published: collected.nsis.has(path) || collected.msi.has(path),
      signed: true,
      verified: true,
      timestamped: true,
      notarized: null,
      stapled: null,
      signer: { subject: signature.subject || null, thumbprint: actual },
      timestamp: { thumbprint: timestampThumbprint },
    });
  }
  return signingEvidence('windows', artifacts);
}

async function collectMacArtifacts(bundleRoot) {
  const root = resolve(bundleRoot);
  const entries = await readdir(root, { withFileTypes: true });
  const apps = [];
  for (const entry of entries.filter((item) => item.isDirectory() && /^mac(?:-[^-]+)?$/i.test(item.name))) {
    apps.push(...(await directoriesIn(join(root, entry.name), (name) => name.endsWith('.app'))));
  }
  const dmgs = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.dmg'))
    .map((entry) => join(root, entry.name));
  if (!apps.length || !dmgs.length) {
    throw new Error('macOS signing verification requires both a .app bundle and a non-empty DMG');
  }
  return { apps, dmgs };
}

function macCodeSignDetails(appPath) {
  const result = run('codesign', ['-dv', '--verbose=4', appPath]);
  const raw = `${result.stdout}\n${result.stderr}`;
  const authority = raw.match(/^Authority=(.+)$/m)?.[1]?.trim() || null;
  const teamIdentifier = raw.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || null;
  const timestamp = raw.match(/^Timestamp=(.+)$/m)?.[1]?.trim() || null;
  return { authority, teamIdentifier, timestamp };
}

export async function verifyMacArtifacts({
  bundleRoot,
  expectedIdentity,
  expectedTeamId,
  commandRunner = run,
  codeSignInspector = macCodeSignDetails,
}) {
  const identity = String(expectedIdentity || '').trim();
  const teamId = String(expectedTeamId || '').trim();
  if (!identity || !teamId) {
    throw new Error('macOS verification requires APPLE_SIGNING_IDENTITY and APPLE_TEAM_ID');
  }
  const { apps, dmgs } = await collectMacArtifacts(bundleRoot);
  const artifacts = [];
  for (const path of apps) {
    commandRunner('codesign', ['--verify', '--deep', '--strict', '--verbose=2', path]);
    commandRunner('spctl', ['--assess', '--type', 'execute', '--verbose=4', path]);
    commandRunner('xcrun', ['stapler', 'validate', path]);
    const signer = codeSignInspector(path);
    if (
      signer.authority !== identity ||
      signer.teamIdentifier !== teamId ||
      !signer.timestamp ||
      signer.timestamp.toLowerCase() === 'none'
    ) {
      throw new Error(
        `unexpected macOS signer for ${path}: authority=${signer.authority || '<missing>'} team=${signer.teamIdentifier || '<missing>'} timestamp=${signer.timestamp || '<missing>'}`,
      );
    }
    const directory = await hashDirectory(path);
    artifacts.push({
      path: evidencePath(path),
      kind: 'app',
      size: directory.size,
      sha256: directory.sha256,
      published: true,
      signed: true,
      verified: true,
      timestamped: true,
      notarized: true,
      stapled: true,
      signer,
    });
  }
  for (const path of dmgs) {
    if (!(await nonEmptyFile(path))) throw new Error(`empty macOS release artifact: ${path}`);
    commandRunner('codesign', ['--verify', '--strict', '--verbose=2', path]);
    commandRunner('spctl', [
      '--assess',
      '--type',
      'open',
      '--context',
      'context:primary-signature',
      '--verbose=4',
      path,
    ]);
    const signer = codeSignInspector(path);
    if (
      signer.authority !== identity ||
      signer.teamIdentifier !== teamId ||
      !signer.timestamp ||
      signer.timestamp.toLowerCase() === 'none'
    ) {
      throw new Error(
        `unexpected macOS signer for ${path}: authority=${signer.authority || '<missing>'} team=${signer.teamIdentifier || '<missing>'} timestamp=${signer.timestamp || '<missing>'}`,
      );
    }
    const info = await stat(path);
    artifacts.push({
      path: evidencePath(path),
      kind: 'dmg',
      size: info.size,
      sha256: await sha256File(path),
      published: true,
      signed: true,
      verified: true,
      timestamped: true,
      notarized: null,
      stapled: null,
      signer,
    });
  }
  return signingEvidence('macos', artifacts);
}

function signingEvidence(platform, artifacts) {
  return {
    schema: SIGNING_EVIDENCE_SCHEMA,
    generatedAt: new Date().toISOString(),
    platform,
    required: platform !== 'linux',
    status: platform === 'linux' ? 'not_applicable' : 'verified',
    artifacts,
  };
}

export function validateSigningEvidence(evidence, { requireSigned = false } = {}) {
  const errors = [];
  if (evidence?.schema !== SIGNING_EVIDENCE_SCHEMA) errors.push('invalid signing evidence schema');
  let platform;
  try {
    platform = normalizePlatform(evidence?.platform);
  } catch (error) {
    errors.push(error.message);
  }
  const artifacts = Array.isArray(evidence?.artifacts) ? evidence.artifacts : [];
  if (requireSigned || platform === 'windows' || platform === 'macos') {
    if (evidence?.required !== true) errors.push('platform signing must be marked required');
    if (evidence?.status !== 'verified') errors.push('platform signing status is not verified');
    if (!artifacts.length) errors.push('signing evidence has no artifacts');
    if (artifacts.some((item) => item?.signed !== true || item?.verified !== true)) {
      errors.push('one or more release artifacts are not signature-verified');
    }
    const paths = artifacts.map((item) => String(item?.path || ''));
    if (paths.some((path) => !path) || new Set(paths).size !== paths.length) {
      errors.push('signing evidence paths must be present and unique');
    }
    if (
      artifacts.some(
        (item) =>
          !Number.isInteger(item?.size) || item.size <= 0 || !/^[a-f0-9]{64}$/i.test(String(item?.sha256 || '')),
      )
    ) {
      errors.push('one or more signing artifacts lack size or SHA-256 evidence');
    }
    if (platform === 'windows' && artifacts.some((item) => !item?.signer?.thumbprint)) {
      errors.push('one or more Windows artifacts lack signer thumbprint evidence');
    }
    if (
      platform === 'windows' &&
      artifacts.some((item) => item?.timestamped !== true || !item?.timestamp?.thumbprint)
    ) {
      errors.push('one or more Windows artifacts lack trusted timestamp evidence');
    }
    if (
      platform === 'windows' &&
      !['app', 'nsis', 'msi'].every((kind) => artifacts.some((item) => item?.kind === kind))
    ) {
      errors.push('Windows signing evidence must include app, NSIS, and MSI artifacts');
    }
    if (platform === 'windows' && new Set(artifacts.map((item) => item?.signer?.thumbprint)).size !== 1) {
      errors.push('Windows artifacts do not share one signer thumbprint');
    }
    if (
      platform === 'macos' &&
      artifacts.some((item) => item?.timestamped !== true || !item?.signer?.authority || !item?.signer?.teamIdentifier)
    ) {
      errors.push('one or more macOS artifacts lack timestamp or signer evidence');
    }
    if (
      platform === 'macos' &&
      new Set(artifacts.map((item) => `${item?.signer?.authority || ''}\0${item?.signer?.teamIdentifier || ''}`))
        .size !== 1
    ) {
      errors.push('macOS artifacts do not share one signer identity');
    }
    const macApps = artifacts.filter((item) => item?.kind === 'app');
    if (platform === 'macos' && macApps.some((item) => item?.notarized !== true || item?.stapled !== true)) {
      errors.push('the macOS app lacks notarization/stapling evidence');
    }
    if (platform === 'macos' && !['app', 'dmg'].every((kind) => artifacts.some((item) => item?.kind === kind))) {
      errors.push('macOS signing evidence must include app and DMG artifacts');
    }
  } else if (platform === 'linux' && evidence?.status !== 'not_applicable') {
    errors.push('Linux signing evidence must be not_applicable');
  }
  return { ok: errors.length === 0, errors };
}

function directoryDigestFromAssets(assets, directoryPath) {
  const prefix = `${directoryPath.replace(/\/$/, '')}/`;
  const children = assets
    .filter((item) => String(item?.path || '').startsWith(prefix))
    .sort((a, b) => {
      const left = String(a.path);
      const right = String(b.path);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  if (!children.length) return null;
  const digest = createHash('sha256');
  let size = 0;
  for (const child of children) {
    const rel = String(child.path).slice(prefix.length);
    digest.update(`${rel}\0${child.sha256}\0${child.size}\n`);
    size += Number(child.size || 0);
  }
  return { sha256: digest.digest('hex'), size };
}

export function validateSigningAssetBindings(evidence, bundleAssets) {
  const errors = [];
  const platform = normalizePlatform(evidence?.platform);
  const artifacts = Array.isArray(evidence?.artifacts) ? evidence.artifacts : [];
  const assets = Array.isArray(bundleAssets) ? bundleAssets : [];
  if (platform === 'linux') return { ok: true, errors };

  const assetPaths = assets.map((item) => String(item?.path || ''));
  if (assetPaths.some((path) => !path) || new Set(assetPaths).size !== assetPaths.length) {
    errors.push('bundle asset paths must be present and unique');
  }

  const exactAssets = new Map(assets.map((item) => [item?.path, item]));
  for (const artifact of artifacts.filter((item) => item?.published === true)) {
    const bound =
      platform === 'macos' && artifact.kind === 'app'
        ? directoryDigestFromAssets(assets, artifact.path)
        : exactAssets.get(artifact.path);
    if (!bound || bound.sha256 !== artifact.sha256 || Number(bound.size) !== Number(artifact.size)) {
      errors.push(`signing evidence is not bound to bundle asset: ${artifact.path || '<missing>'}`);
    }
  }

  const uncovered = assets.filter((asset) => {
    const path = String(asset?.path || '');
    if (platform === 'windows') {
      const required = path.endsWith('.msi') || /^release\/[^/]+\.exe$/i.test(path);
      return required && !artifacts.some((item) => item?.published === true && item.path === path);
    }
    const app = artifacts.find((item) => item?.kind === 'app' && item?.published === true);
    const required = path.endsWith('.dmg') || path.includes('.app/');
    return (
      required &&
      !artifacts.some((item) => item?.published === true && item.path === path) &&
      !(app && path.startsWith(`${app.path}/`))
    );
  });
  if (uncovered.length) errors.push('one or more published bundle assets lack signing evidence');
  return { ok: errors.length === 0, errors };
}

async function writeJson(path, payload) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function parseArgs(argv) {
  const [command = '', ...rest] = argv;
  const opts = { command, platform: process.platform, bundleRoot: '', output: '', configOutput: '', config: '' };
  while (rest.length) {
    const arg = rest.shift();
    if (arg === '--platform') opts.platform = rest.shift();
    else if (arg === '--bundle-root') opts.bundleRoot = rest.shift();
    else if (arg === '--output') opts.output = rest.shift();
    else if (arg === '--config-output') opts.configOutput = rest.shift();
    else if (arg === '--config') opts.config = rest.shift();
    else throw new Error(`unknown release-signing arg: ${arg}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const platform = normalizePlatform(opts.platform);
  if (opts.command === 'preflight') {
    const credentials = inspectCredentialSet(platform);
    if (!credentials.complete) {
      throw new Error(
        `incomplete ${platform} signing credentials: ${[...credentials.missing, ...credentials.errors].join(', ')}`,
      );
    }
    if (platform === 'windows') {
      if (!opts.configOutput) throw new Error('Windows preflight requires --config-output');
      await writeJson(resolve(opts.configOutput), buildWindowsSigningConfig(process.env.WINDOWS_CERT_THUMBPRINT));
    }
    console.log(`release-signing: ${platform} credential preflight OK`);
    return;
  }
  if (opts.command === 'assert-config') {
    const config = await resolveEffectiveBuilderConfig(opts.config);
    const validation = validateEffectiveBuilderConfig(config, {
      expectedThumbprint: opts.config ? process.env.WINDOWS_CERT_THUMBPRINT : '',
    });
    if (!validation.ok) throw new Error(`effective electron-builder config regressed: ${validation.errors.join('; ')}`);
    console.log(`release-signing: effective electron-builder config OK${opts.config ? ` (${opts.config})` : ''}`);
    return;
  }
  if (opts.command === 'verify') {
    if (!opts.bundleRoot || !opts.output) throw new Error('verify requires --bundle-root and --output');
    const evidence =
      platform === 'windows'
        ? await verifyWindowsArtifacts({
            bundleRoot: opts.bundleRoot,
            expectedThumbprint: process.env.WINDOWS_CERT_THUMBPRINT,
          })
        : platform === 'macos'
          ? await verifyMacArtifacts({
              bundleRoot: opts.bundleRoot,
              expectedIdentity: process.env.APPLE_SIGNING_IDENTITY,
              expectedTeamId: process.env.APPLE_TEAM_ID,
            })
          : signingEvidence('linux', []);
    const validation = validateSigningEvidence(evidence, { requireSigned: platform !== 'linux' });
    if (!validation.ok) throw new Error(validation.errors.join('; '));
    await writeJson(resolve(opts.output), evidence);
    console.log(`release-signing: ${platform} artifact evidence ${evidence.status}`);
    return;
  }
  throw new Error('usage: release-signing.mjs preflight|assert-config|verify --platform windows|macos|linux [options]');
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(`release-signing: ${error.message}`);
    process.exitCode = 1;
  });
}
