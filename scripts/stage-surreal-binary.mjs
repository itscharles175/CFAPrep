#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { recordSidecarProvenance } from './sidecar-provenance.mjs';

export const SURREALDB_VERSION = '2.6.5';
const RELEASE_ROOT = `https://github.com/surrealdb/surrealdb/releases/download/v${SURREALDB_VERSION}`;
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const OUTPUT_DIRECTORY = path.join(REPO_ROOT, 'electron', 'resources', 'services', 'bin');

export const SURREALDB_ASSETS = Object.freeze({
  'win32-x64': Object.freeze({
    name: `surreal-v${SURREALDB_VERSION}.windows-amd64.exe`,
    sha256: 'dd9b6fa15edacbde96d490dd5727b49b5cf40df80f29074c7dc17acb974f509f',
    executable: 'surreal2.exe',
  }),
  'darwin-x64': Object.freeze({
    name: `surreal-v${SURREALDB_VERSION}.darwin-amd64.tgz`,
    sha256: 'ddb699f19173a3135e160723b6994eed21b02454ff7acc10d7fba268af771729',
    executable: 'surreal2',
  }),
  'darwin-arm64': Object.freeze({
    name: `surreal-v${SURREALDB_VERSION}.darwin-arm64.tgz`,
    sha256: '71d031be990d59ed57e41e147fda7463660a2b449ae91868c83eb0888d07fade',
    executable: 'surreal2',
  }),
  'linux-x64': Object.freeze({
    name: `surreal-v${SURREALDB_VERSION}.linux-amd64.tgz`,
    sha256: '929d73f46c4fb59f237810e6fe6da54c1756064f3ed8d7d1f6a970e8fdf38fb0',
    executable: 'surreal2',
  }),
});

export function resolveSurrealAsset(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const asset = SURREALDB_ASSETS[key];
  if (!asset) throw new Error(`unsupported SurrealDB release target: ${key}`);
  return { ...asset, key, url: `${RELEASE_ROOT}/${asset.name}` };
}

async function sha256File(filePath) {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`SurrealDB download failed (${response.status}): ${url}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

export async function stageSurrealBinary({ platform = process.platform, arch = process.arch } = {}) {
  const asset = resolveSurrealAsset(platform, arch);
  const workDirectory = await mkdtemp(path.join(tmpdir(), 'studyvault-surreal-'));
  try {
    const downloadPath = path.join(workDirectory, asset.name);
    await download(asset.url, downloadPath);
    const actualSha256 = await sha256File(downloadPath);
    if (actualSha256 !== asset.sha256) {
      throw new Error(`SurrealDB SHA-256 mismatch: expected ${asset.sha256}, received ${actualSha256}`);
    }

    let sourcePath = downloadPath;
    if (asset.name.endsWith('.tgz')) {
      execFileSync('tar', ['-xzf', downloadPath, '-C', workDirectory], { stdio: 'inherit' });
      sourcePath = path.join(workDirectory, 'surreal');
      if (!existsSync(sourcePath)) throw new Error(`SurrealDB archive did not contain the expected executable`);
    }

    await mkdir(OUTPUT_DIRECTORY, { recursive: true });
    const outputPath = path.join(OUTPUT_DIRECTORY, asset.executable);
    await copyFile(sourcePath, outputPath);
    if (platform !== 'win32') await chmod(outputPath, 0o755);
    const provenance = await recordSidecarProvenance({
      service: 'SurrealDB',
      binaryPath: outputPath,
      source: `${asset.url}#sha256=${asset.sha256}`,
      optional: true,
    });
    return { ...asset, outputPath, provenance };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stageSurrealBinary()
    .then(({ outputPath, provenance }) => {
      console.log(`Staged SurrealDB ${SURREALDB_VERSION} at ${outputPath}`);
      console.log(`SHA-256 ${provenance.sha256}`);
    })
    .catch((error) => {
      console.error(`stage-surreal-binary: ${error.message}`);
      process.exit(1);
    });
}
