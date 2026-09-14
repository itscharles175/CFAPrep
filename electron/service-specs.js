import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { resolveLsatDataDir } from './relocation.js';

export const SERVICE_NAMES = Object.freeze({
  SURREAL: 'SurrealDB',
  NOTEBOOK_API: 'open-notebook API',
  NOTEBOOK_WORKER: 'open-notebook worker',
  LSAT: 'LSAT backend',
});

function executable(stem, platform) {
  return platform === 'win32' ? `${stem}.exe` : stem;
}

export function resolveServicesDirectory({ isPackaged, resourcesPath, cwd, electronDirectory, env = process.env }) {
  if (isPackaged) return path.join(resourcesPath, 'services');
  if (typeof env.QV_SERVICES_DIR === 'string' && env.QV_SERVICES_DIR.trim()) {
    return path.resolve(cwd, env.QV_SERVICES_DIR.trim());
  }
  return path.join(electronDirectory, 'resources', 'services');
}

export function resolveOpenNotebookPrograms({
  servicesDirectory,
  isPackaged,
  env = process.env,
  platform = process.platform,
  exists = existsSync,
}) {
  const notebook = path.join(servicesDirectory, 'open-notebook');
  const frozenApi = path.join(notebook, executable('open-notebook', platform));
  const frozenWorker = path.join(notebook, executable('open-notebook-worker', platform));
  if (exists(frozenApi)) {
    return {
      mode: 'frozen',
      api: { program: frozenApi, args: [], resourcePath: frozenApi, provenanceRequired: true },
      worker: {
        program: frozenWorker,
        args: [],
        resourcePath: frozenWorker,
        provenanceRequired: true,
      },
    };
  }
  const devDirectory = env.QV_OPEN_NOTEBOOK_DEV_DIR?.trim();
  if (!isPackaged && env.QV_ALLOW_UV_DEVELOPMENT_FALLBACK === '1' && devDirectory) {
    const source = path.resolve(devDirectory);
    const envFile = path.join(source, '.env');
    return {
      mode: 'dev-uv',
      api: {
        program: 'uv',
        args: ['run', '--directory', source, '--env-file', envFile, 'python', 'run_api.py'],
        resourcePath: source,
        provenanceRequired: false,
      },
      worker: {
        program: 'uv',
        args: [
          'run',
          '--directory',
          source,
          '--env-file',
          envFile,
          'surreal-commands-worker',
          '--import-modules',
          'commands',
        ],
        resourcePath: source,
        provenanceRequired: false,
      },
    };
  }
  return {
    mode: 'unavailable',
    api: { program: frozenApi, args: [], resourcePath: frozenApi, provenanceRequired: true },
    worker: {
      program: frozenWorker,
      args: [],
      resourcePath: frozenWorker,
      provenanceRequired: true,
    },
  };
}

export function buildServiceSpecs({
  servicesDirectory,
  userDataPath,
  lsatToken,
  lsatDbKeyB64,
  lsatKeyBlockReason = null,
  isPackaged = false,
  env = process.env,
  platform = process.platform,
  logger = null,
}) {
  const notebookPrograms = resolveOpenNotebookPrograms({
    servicesDirectory,
    isPackaged,
    env,
    platform,
  });
  const lsatData = resolveLsatDataDir({ userDataPath, platform, env, logger });
  const surrealProgram = path.join(servicesDirectory, 'bin', executable('surreal2', platform));
  const lsatProgram = path.join(servicesDirectory, 'lsat-backend', executable('lsatlab-backend', platform));
  const servicesDataDirectory = path.join(userDataPath, 'services');
  const surrealDataDirectory = path.join(servicesDataDirectory, 'surreal');

  return [
    {
      name: SERVICE_NAMES.SURREAL,
      program: surrealProgram,
      args: [
        'start',
        '--user',
        'root',
        '--pass',
        'root',
        `rocksdb:${path.join(surrealDataDirectory, 'db')}`,
      ],
      env: {},
      readyPort: 8000,
      dependsOn: [],
      optional: true,
      resourcePath: surrealProgram,
      provenanceRequired: true,
      cwd: servicesDataDirectory,
      dataDirectory: surrealDataDirectory,
      dataRoot: userDataPath,
    },
    {
      name: SERVICE_NAMES.NOTEBOOK_API,
      program: notebookPrograms.api.program,
      args: notebookPrograms.api.args,
      env: { HOST: '127.0.0.1', PORT: '5055' },
      readyPort: 5055,
      dependsOn: [SERVICE_NAMES.SURREAL],
      optional: true,
      resourcePath: notebookPrograms.api.resourcePath,
      provenanceRequired: notebookPrograms.api.provenanceRequired,
      provenanceService: 'open-notebook binary',
      cwd: servicesDirectory,
    },
    {
      name: SERVICE_NAMES.NOTEBOOK_WORKER,
      program: notebookPrograms.worker.program,
      args: notebookPrograms.worker.args,
      env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      readyPort: null,
      dependsOn: [SERVICE_NAMES.NOTEBOOK_API],
      optional: true,
      resourcePath: notebookPrograms.worker.resourcePath,
      provenanceRequired: notebookPrograms.worker.provenanceRequired,
      provenanceService: 'open-notebook worker binary',
      cwd: servicesDirectory,
    },
    {
      name: SERVICE_NAMES.LSAT,
      program: lsatProgram,
      args: ['--host', '127.0.0.1', '--port', '8100'],
      env: {
        LSATLAB_PORT: '8100',
        LSATLAB_DATA_DIR: lsatData.dataDir,
        LSATLAB_LOCAL_API_TOKEN: lsatToken,
        STUDYVAULT_SIDECAR_PROVENANCE: path.join(servicesDirectory, 'sidecar-provenance.json'),
        ...(lsatDbKeyB64 ? { LSATLAB_DB_KEY_B64: lsatDbKeyB64 } : {}),
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      readyPort: 8100,
      readinessIdentity: { path: '/api/health', service: 'lsat-backend' },
      dependsOn: [],
      optional: false,
      resourcePath: lsatProgram,
      provenanceRequired: true,
      launchBlockReason: lsatKeyBlockReason,
      // The containment root has to follow the data dir: a recovered legacy bank
      // is a sibling of userData, not a child, and would otherwise be rejected as
      // an escaped data directory before the sidecar ever launches.
      dataRoot: lsatData.relocated ? lsatData.dataDir : userDataPath,
      dataDirRelocated: lsatData.relocated,
      cwd: path.dirname(lsatProgram),
    },
  ];
}
