// Copies the locally-ingested CFA source bundle into public/ so the app can
// fetch and import it into IndexedDB on first run. The bundle stays gitignored
// (*.qvsource) and is never committed. Run after `npm run cfa:source:ingest`.
import { existsSync } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const privateDir =
  process.env.QV_SOURCE_VAULT_DIR ||
  (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'QuantVault', 'source-vault')
    : join(homedir(), '.quantvault', 'source-vault'));

const source = resolve(join(privateDir, 'latest.qvsource'));
const destination = resolve('public/cfa-source.qvsource');

if (!existsSync(source)) {
  console.error(`No ingested bundle found at ${source}. Run "npm run cfa:source:ingest" first.`);
  process.exitCode = 1;
} else {
  await mkdir(resolve('public'), { recursive: true });
  await copyFile(source, destination);
  const { size } = await stat(destination);
  console.log(`Installed CFA source bundle -> public/cfa-source.qvsource (${(size / 1e6).toFixed(1)} MB)`);
}
