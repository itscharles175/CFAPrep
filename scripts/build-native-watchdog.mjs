import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const nativeWatchdogOutput = path.join(repoRoot, 'electron', 'resources', 'bin', 'studyvault-watchdog');

export async function buildNativeWatchdog({ platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'darwin') return { built: false, reason: 'not-darwin', path: null };
  if (arch !== 'arm64') throw new Error(`Personal watchdog build requires arm64, received ${arch}`);
  await mkdir(path.dirname(nativeWatchdogOutput), { recursive: true, mode: 0o755 });
  const source = path.join(repoRoot, 'electron', 'native-watchdog.c');
  const args = [
    '--sdk', 'macosx', 'clang', '-Os', '-Wall', '-Wextra', '-Werror',
    '-arch', 'arm64', '-mmacosx-version-min=12.0', source, '-o', nativeWatchdogOutput,
  ];
  await new Promise((resolve, reject) => {
    const child = spawn('xcrun', args, { cwd: repoRoot, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Native watchdog build failed (${code ?? signal ?? 'unknown'})`));
    });
  });
  await chmod(nativeWatchdogOutput, 0o755);
  return { built: true, reason: null, path: nativeWatchdogOutput };
}

export default async function beforePack() {
  await buildNativeWatchdog();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildNativeWatchdog();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
