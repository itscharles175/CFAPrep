import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';
import {
  ALLOWED_INVOKE_CHANNELS,
  ContractError,
  IPC_CHANNELS,
  validateRequest,
  validateResponse,
} from '../contracts.js';
import {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  LsatDbKeyStore,
  SecureKeyStore,
  assertKeychainTarget,
  assertSafeStorageAvailable,
} from '../keychain.js';
import { FILE_READ_CAP_BYTES, PathAuthorization, extractLaunchFilePaths, isPathWithin } from '../path-policy.js';
import {
  appAssetCandidate,
  productionContentSecurityPolicy,
  registerAppScheme,
  resolveAppAssetPath,
} from '../protocol.js';
import { manifestRelativePath, verifyServiceProvenance } from '../provenance.js';
import { installLsatAuthorization, isExactLsatApiUrl } from '../session-auth.js';
import { buildServiceSpecs, resolveOpenNotebookPrograms, resolveServicesDirectory } from '../service-specs.js';
import {
  SidecarManager,
  aggregateSidecarHealth,
  matchesServiceIdentity,
  portLaunchDecision,
  redactSidecarLine,
  respawnBackoffMs,
} from '../sidecar-manager.js';
import {
  isAllowedExternalHttpsUrl,
  isAllowedPermission,
  isSafeRendererUrl,
  normalizePopoutUrl,
} from '../window-security.js';
import { isOwnedChildPid, OwnedChildWatchdog } from '../watchdog.js';
import { ELECTRON_FUSE_CONFIG } from '../../scripts/apply-electron-fuses.mjs';
import { FuseV1Options } from '@electron/fuses';

const require = createRequire(import.meta.url);
const { CHANNELS } = require('../channels.cjs');
const quietLogger = { info() {}, warn() {}, error() {}, crash() {} };
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studyvault-electron-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('stable IPC allowlist has no LSAT token channel and rejects unknown input', () => {
  assert.equal('SIDECAR_TOKEN' in CHANNELS, false);
  assert.equal(ALLOWED_INVOKE_CHANNELS.includes('studyvault:sidecar:token'), false);
  assert.throws(() => validateRequest('studyvault:sidecar:token'), ContractError);
  assert.throws(() => validateRequest(IPC_CHANNELS.FILES_READ, { path: 'x.pdf', extra: true }), /not allowed/);
  assert.throws(() => validateResponse(IPC_CHANNELS.FULLSCREEN_GET, 'false'), /boolean/);
});

test('packaging enables hardened fuses without requiring an absent browser snapshot', async () => {
  const builderConfig = await readFile(path.join(repoRoot, 'electron-builder.yml'), 'utf8');
  assert.match(builderConfig, /^afterPack: scripts\/apply-electron-fuses\.mjs$/m);
  assert.equal(ELECTRON_FUSE_CONFIG.strictlyRequireAllFuses, true);
  assert.equal(ELECTRON_FUSE_CONFIG[FuseV1Options.RunAsNode], true);
  assert.equal(ELECTRON_FUSE_CONFIG[FuseV1Options.EnableCookieEncryption], true);
  assert.equal(ELECTRON_FUSE_CONFIG[FuseV1Options.EnableNodeOptionsEnvironmentVariable], false);
  assert.equal(ELECTRON_FUSE_CONFIG[FuseV1Options.EnableNodeCliInspectArguments], false);
  assert.equal(ELECTRON_FUSE_CONFIG[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], true);
  assert.equal(ELECTRON_FUSE_CONFIG[FuseV1Options.OnlyLoadAppFromAsar], true);
  assert.equal(ELECTRON_FUSE_CONFIG[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot], false);
  assert.equal(ELECTRON_FUSE_CONFIG[FuseV1Options.GrantFileProtocolExtraPrivileges], false);
  assert.equal(ELECTRON_FUSE_CONFIG[FuseV1Options.WasmTrapHandlers], true);
});

test('path authorization lists only PDFs and does not authorize arbitrary root files', async (t) => {
  const root = await temporaryDirectory(t);
  const nested = path.join(root, 'nested');
  await mkdir(nested);
  const pdf = path.join(nested, 'case.PDF');
  const text = path.join(root, 'notes.txt');
  await writeFile(pdf, 'pdf bytes');
  await writeFile(text, 'text bytes');

  const authorization = new PathAuthorization();
  const canonicalRoot = await authorization.authorizePickedRoot(root);
  const rows = await authorization.listPdfs(canonicalRoot);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].extension, '.pdf');
  assert.equal((await authorization.readAuthorizedFile(rows[0].path)).data.byteLength, 9);
  await assert.rejects(() => authorization.readAuthorizedFile(text), /not been authorized/);
  await authorization.authorizePickedFiles([text]);
  assert.equal((await authorization.readAuthorizedFile(text)).data.byteLength, 10);
});

test('folder listing rejects symlinks and enforces its entry cap', async (t) => {
  const root = await temporaryDirectory(t);
  await writeFile(path.join(root, 'a.pdf'), 'a');
  await writeFile(path.join(root, 'b.pdf'), 'b');
  const capped = new PathAuthorization({ entryCap: 1 });
  await capped.authorizePickedRoot(root);
  await assert.rejects(() => capped.listPdfs(root), /entry cap/);
  await assert.rejects(() => capped.readAuthorizedFile(path.join(root, 'a.pdf')), /not been authorized/);

  const target = path.join(root, 'target.pdf');
  const link = path.join(root, 'linked.pdf');
  await writeFile(target, 'target');
  try {
    await symlink(target, link, 'file');
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.diagnostic('Symlink creation is unavailable on this Windows host');
      return;
    }
    throw error;
  }
  const authorization = new PathAuthorization();
  await authorization.authorizePickedRoot(root);
  await assert.rejects(() => authorization.listPdfs(root), /symbolic link/i);
});

test('authorized reads reject files larger than 50 MiB', async (t) => {
  const root = await temporaryDirectory(t);
  const oversized = path.join(root, 'oversized.pdf');
  await writeFile(oversized, 'x');
  await truncate(oversized, FILE_READ_CAP_BYTES + 1);
  const authorization = new PathAuthorization();
  await authorization.authorizePickedFiles([oversized]);
  await assert.rejects(() => authorization.readAuthorizedFile(oversized), /read cap/);
});

test('launch path extraction accepts only PDF and TXT paths', () => {
  const paths = extractLaunchFilePaths(['electron', '.', 'a.pdf', '--flag', 'b.exe', 'c.TXT'], 'C:\\study');
  assert.equal(paths.length, 2);
  assert.equal(
    paths.some((entry) => entry.toLocaleLowerCase('en-US').endsWith('.pdf')),
    true,
  );
  assert.equal(
    paths.some((entry) => entry.toLocaleLowerCase('en-US').endsWith('.txt')),
    true,
  );
});

test('app protocol resolution cannot escape dist and falls back for routes', async (t) => {
  const root = await temporaryDirectory(t);
  await writeFile(path.join(root, 'index.html'), '<main>StudyVault</main>');
  await mkdir(path.join(root, 'assets'));
  await writeFile(path.join(root, 'assets', 'app.js'), 'ok');
  const asset = appAssetCandidate(root, 'app://studyvault/assets/app.js');
  assert.equal(isPathWithin(root, asset), true);
  assert.equal(await resolveAppAssetPath(root, 'app://studyvault/route/inside'), path.join(root, 'index.html'));
  assert.throws(() => appAssetCandidate(root, 'app://other/assets/app.js'), /Invalid StudyVault/);
  assert.throws(() => appAssetCandidate(root, 'app://studyvault/%5c..%5csecret'), /Invalid app path/);
});

test('app protocol is a secure standard origin with service-worker support', () => {
  let registrations = null;
  registerAppScheme({
    registerSchemesAsPrivileged(next) {
      registrations = next;
    },
  });
  assert.deepEqual(registrations, [
    {
      scheme: 'app',
      privileges: {
        secure: true,
        standard: true,
        supportFetchAPI: true,
        allowServiceWorkers: true,
        corsEnabled: false,
        stream: true,
      },
    },
  ]);
});

test('provenance requires a matching path, SHA-256, and size', async (t) => {
  const root = await temporaryDirectory(t);
  const binaryDirectory = path.join(root, 'lsat-backend');
  const binary = path.join(binaryDirectory, 'lsatlab-backend.exe');
  await mkdir(binaryDirectory);
  const bytes = 'verified binary';
  await writeFile(binary, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(
    path.join(root, 'sidecar-provenance.json'),
    JSON.stringify({
      schema: 'studyvault.sidecar-provenance.v1',
      entries: [{ service: 'LSAT backend', path: 'lsat-backend/lsatlab-backend.exe', sha256, size: bytes.length }],
    }),
  );
  const spec = { name: 'LSAT backend', program: binary, provenanceRequired: true };
  assert.equal((await verifyServiceProvenance(spec, root)).status, 'verified');
  await writeFile(binary, 'tampered');
  assert.equal((await verifyServiceProvenance(spec, root)).status, 'digest_mismatch');
  assert.equal(manifestRelativePath('../escape.exe'), null);
  assert.equal(manifestRelativePath('C:\\escape.exe'), null);
});

test('service directory resolution follows package, override, then Electron resources', () => {
  assert.equal(
    resolveServicesDirectory({
      isPackaged: true,
      resourcesPath: 'R',
      cwd: 'C',
      electronDirectory: 'E',
      env: {},
    }),
    path.join('R', 'services'),
  );
  assert.equal(
    resolveServicesDirectory({
      isPackaged: false,
      resourcesPath: 'R',
      cwd: 'C',
      electronDirectory: 'E',
      env: { QV_SERVICES_DIR: 'override' },
    }),
    path.resolve('C', 'override'),
  );
  const electronServices = path.join('E', 'resources', 'services');
  assert.equal(
    resolveServicesDirectory({
      isPackaged: false,
      resourcesPath: 'R',
      cwd: 'C',
      electronDirectory: 'E',
      env: {},
    }),
    electronServices,
  );
});

test('open-notebook uses frozen binaries and allows uv only through explicit unpackaged fallback', () => {
  const servicesDirectory = path.resolve('services-root');
  const frozenApi = path.join(servicesDirectory, 'open-notebook', 'open-notebook.exe');
  const frozen = resolveOpenNotebookPrograms({
    servicesDirectory,
    isPackaged: true,
    platform: 'win32',
    env: {},
    exists: (candidate) => candidate === frozenApi,
  });
  assert.equal(frozen.mode, 'frozen');
  assert.equal(frozen.api.program, frozenApi);
  assert.notEqual(frozen.api.program, 'uv');

  const unavailable = resolveOpenNotebookPrograms({
    servicesDirectory,
    isPackaged: true,
    platform: 'win32',
    env: {
      QV_ALLOW_UV_DEVELOPMENT_FALLBACK: '1',
      QV_OPEN_NOTEBOOK_DEV_DIR: 'dev-source',
    },
    exists: () => false,
  });
  assert.equal(unavailable.mode, 'unavailable');
  assert.notEqual(unavailable.api.program, 'uv');

  const development = resolveOpenNotebookPrograms({
    servicesDirectory,
    isPackaged: false,
    platform: 'win32',
    env: {
      QV_ALLOW_UV_DEVELOPMENT_FALLBACK: '1',
      QV_OPEN_NOTEBOOK_DEV_DIR: 'dev-source',
    },
    exists: () => false,
  });
  assert.equal(development.mode, 'dev-uv');
  assert.equal(development.api.program, 'uv');
  assert.equal(development.worker.program, 'uv');
});

test('LSAT service receives only supplied main-process token and DB key values', () => {
  const specs = buildServiceSpecs({
    servicesDirectory: path.resolve('services-root'),
    userDataPath: path.resolve('user-data'),
    lsatToken: 'a'.repeat(64),
    lsatDbKeyB64: 'b'.repeat(43) + '=',
    isPackaged: true,
    platform: 'win32',
    env: {},
  });
  const lsat = specs.find((spec) => spec.name === 'LSAT backend');
  assert.equal(lsat.env.LSATLAB_LOCAL_API_TOKEN, 'a'.repeat(64));
  assert.equal(lsat.env.LSATLAB_DB_KEY_B64, 'b'.repeat(43) + '=');
  assert.equal(
    lsat.env.STUDYVAULT_SIDECAR_PROVENANCE,
    path.join(path.resolve('services-root'), 'sidecar-provenance.json'),
  );
  assert.deepEqual(lsat.readinessIdentity, { path: '/api/health', service: 'lsat-backend' });
});

test('safeStorage rejects basic-text Linux and stores only encrypted bytes', async (t) => {
  assert.throws(() => assertKeychainTarget('studyvault', KEYCHAIN_ACCOUNT), /restricted/);
  assert.throws(
    () =>
      assertSafeStorageAvailable(
        {
          isEncryptionAvailable: () => true,
          getSelectedStorageBackend: () => 'basic_text',
        },
        'linux',
      ),
    /basic-text/,
  );

  const root = await temporaryDirectory(t);
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Uint8Array.from([...value].map((character) => character.charCodeAt(0) ^ 0xaa)),
    decryptString: (value) => [...value].map((byte) => String.fromCharCode(byte ^ 0xaa)).join(''),
  };
  const store = new SecureKeyStore({ safeStorage: fakeSafeStorage, userDataPath: root, platform: 'win32' });
  await store.set(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, 'plain-secret');
  const disk = await readFile(store.filePath, 'utf8');
  assert.equal(disk.includes('plain-secret'), false);
  assert.equal(await store.get(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT), 'plain-secret');
  await store.delete(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  assert.equal(await store.get(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT), null);

  const dbKeys = new LsatDbKeyStore({ safeStorage: fakeSafeStorage, userDataPath: root, platform: 'win32' });
  const first = await dbKeys.getOrCreate();
  const second = await dbKeys.getOrCreate();
  assert.match(first, /^[A-Za-z0-9+/]{43}=$/);
  assert.equal(second, first);
  assert.equal((await readFile(dbKeys.filePath, 'utf8')).includes(first), false);
});

test('LSAT authorization predicate is exact and redirect requests do not receive the token', () => {
  assert.equal(isExactLsatApiUrl('http://127.0.0.1:8100/api/questions?q=1'), true);
  assert.equal(isExactLsatApiUrl('http://localhost:8100/api/questions'), false);
  assert.equal(isExactLsatApiUrl('http://127.1:8100/api/questions'), false);
  assert.equal(isExactLsatApiUrl('http://2130706433:8100/api/questions'), false);
  assert.equal(isExactLsatApiUrl('http://0x7f000001:8100/api/questions'), false);
  assert.equal(isExactLsatApiUrl('https://127.0.0.1:8100/api/questions'), false);
  assert.equal(isExactLsatApiUrl('http://127.0.0.1:8101/api/questions'), false);
  assert.equal(isExactLsatApiUrl('http://user@127.0.0.1:8100/api/questions'), false);

  const listeners = {};
  const fakeSession = {
    webRequest: {
      onBeforeRedirect: (_filter, listener) => {
        listeners.redirect = listener;
      },
      onCompleted: (_filter, listener) => {
        listeners.completed = listener;
      },
      onErrorOccurred: (_filter, listener) => {
        listeners.error = listener;
      },
      onBeforeSendHeaders: (_filter, listener) => {
        listeners.headers = listener;
      },
    },
  };
  installLsatAuthorization(fakeSession, () => 'a'.repeat(64));
  listeners.redirect({ id: 7 });
  let redirectedHeaders;
  listeners.headers({ id: 7, url: 'http://127.0.0.1:8100/api/questions', requestHeaders: {} }, (result) => {
    redirectedHeaders = result.requestHeaders;
  });
  assert.equal(redirectedHeaders.Authorization, undefined);
  listeners.completed({ id: 7 });
  let directHeaders;
  listeners.headers({ id: 8, url: 'http://127.0.0.1:8100/api/questions', requestHeaders: {} }, (result) => {
    directHeaders = result.requestHeaders;
  });
  assert.equal(directHeaders.Authorization, `Bearer ${'a'.repeat(64)}`);
  installLsatAuthorization(fakeSession, () => null);
  listeners.headers({ id: 9, url: 'http://127.0.0.1:8100/api/questions', requestHeaders: {} }, (result) => {
    directHeaders = result.requestHeaders;
  });
  assert.equal(directHeaders.Authorization, undefined);
});

test('window URL predicates allow only app/loopback renderer routes and HTTPS external URLs', () => {
  assert.equal(isSafeRendererUrl('app://studyvault/lsat'), true);
  assert.equal(isSafeRendererUrl('https://example.com'), false);
  assert.equal(isSafeRendererUrl('http://127.0.0.1:5173/lsat', 'http://127.0.0.1:5173'), true);
  assert.equal(isSafeRendererUrl('http://localhost:5173/lsat', 'http://127.0.0.1:5173'), false);
  assert.equal(isAllowedExternalHttpsUrl('https://example.com/study'), true);
  assert.equal(isAllowedExternalHttpsUrl('http://example.com/study'), false);
  assert.equal(normalizePopoutUrl('/lsat', null), 'app://studyvault/lsat');
  assert.throws(() => normalizePopoutUrl('https://example.com', null), /inside/);
});

test('permission policy allows only trusted audio and sanitized clipboard writes', () => {
  const base = { requestingUrl: 'app://studyvault/', isMainFrame: true };
  assert.equal(isAllowedPermission({ ...base, permission: 'media', mediaTypes: ['audio'] }), true);
  assert.equal(isAllowedPermission({ ...base, permission: 'media', mediaTypes: ['video'] }), false);
  assert.equal(isAllowedPermission({ ...base, permission: 'clipboard-sanitized-write', mediaTypes: [] }), true);
  assert.equal(isAllowedPermission({ ...base, permission: 'geolocation', mediaTypes: [] }), false);
  assert.equal(
    isAllowedPermission({ ...base, requestingUrl: 'https://example.com', permission: 'media', mediaTypes: ['audio'] }),
    false,
  );
  assert.equal(isAllowedPermission({ ...base, isMainFrame: false, permission: 'media', mediaTypes: ['audio'] }), false);
});

test('production CSP permits required loopback AI ports', () => {
  const csp = productionContentSecurityPolicy();
  assert.match(csp, /127\.0\.0\.1:1234/);
  assert.match(csp, /127\.0\.0\.1:11434/);
  assert.match(csp, /localhost:1234/);
  assert.match(csp, /localhost:11434/);
});

test('aggregate, backoff, port block, and redaction decisions are bounded', () => {
  const rows = [
    { name: 'LSAT backend', ready: true, optional: false },
    { name: 'open-notebook API', ready: false, optional: true },
  ];
  assert.deepEqual(aggregateSidecarHealth(rows), {
    status: 'degraded',
    ready: 1,
    required_down: 0,
    optional_down: 1,
    total: 2,
    required_down_names: [],
  });
  assert.equal(respawnBackoffMs(1), 7000);
  assert.equal(respawnBackoffMs(100), 300_000);
  assert.equal(portLaunchDecision(true, 8100).blocked, true);
  assert.equal(matchesServiceIdentity({ ok: true, service: 'lsat-backend' }, 'lsat-backend'), true);
  assert.equal(matchesServiceIdentity({ ok: true, service: 'unknown' }, 'lsat-backend'), false);
  assert.equal(redactSidecarLine('Authorization: Bearer abc token=xyz', ['abc']).includes('abc'), false);
});

test('occupied expected port blocks launch without spawning or terminating anything', async () => {
  let spawnCount = 0;
  let terminateCount = 0;
  const spec = {
    name: 'LSAT backend',
    program: 'lsatlab-backend.exe',
    args: [],
    env: { LSATLAB_DATA_DIR: os.tmpdir() },
    readyPort: 8100,
    dependsOn: [],
    optional: false,
    resourcePath: null,
    provenanceRequired: false,
    cwd: os.tmpdir(),
  };
  const manager = new SidecarManager({
    specs: [spec],
    servicesDirectory: os.tmpdir(),
    lsatToken: 'b'.repeat(64),
    logger: quietLogger,
    spawnProcess: () => {
      spawnCount += 1;
    },
    portProbe: async () => true,
    provenanceVerifier: async () => ({ status: 'not_applicable', blocksLaunch: false, message: null }),
    terminateTree: async () => {
      terminateCount += 1;
    },
  });
  await manager.startAll();
  const [status] = await manager.getStatus();
  assert.equal(status.blocked, true);
  assert.equal(status.provenance_status, 'port_occupied');
  assert.equal(manager.getAuthorizationTokenForRequest(), null);
  assert.equal(spawnCount, 0);
  await manager.stopAll();
  assert.equal(terminateCount, 0);
});

test('free-port launch fails closed when crash-safe watchdog is unavailable', async () => {
  let spawnCount = 0;
  const spec = {
    name: 'optional service',
    program: 'service.exe',
    args: [],
    env: {},
    readyPort: 5055,
    dependsOn: [],
    optional: true,
    resourcePath: null,
    provenanceRequired: false,
    cwd: os.tmpdir(),
  };
  const manager = new SidecarManager({
    specs: [spec],
    servicesDirectory: os.tmpdir(),
    lsatToken: 'b'.repeat(64),
    logger: quietLogger,
    spawnProcess: () => {
      spawnCount += 1;
    },
    portProbe: async () => false,
    provenanceVerifier: async () => ({ status: 'not_applicable', blocksLaunch: false, message: null }),
  });
  await manager.startAll();
  const [status] = await manager.getStatus();
  assert.equal(status.provenance_status, 'crash_guard_unavailable');
  assert.equal(spawnCount, 0);
  await manager.stopAll();
});

test('owned-child watchdog reaps an explicitly tracked disposable process', async (t) => {
  assert.equal(isOwnedChildPid(process.pid), false);
  assert.equal(isOwnedChildPid(0), false);
  assert.equal(isOwnedChildPid(process.pid + 1), true);

  const scriptPath = fileURLToPath(new URL('../child-watchdog.cjs', import.meta.url));
  const watchdog = await OwnedChildWatchdog.start({
    scriptPath,
    logger: quietLogger,
    executable: process.execPath,
  });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  await once(child, 'spawn');
  const exited = once(child, 'exit');
  await watchdog.track(child.pid);
  await watchdog.close();
  await Promise.race([
    exited,
    delay(5000).then(() => {
      throw new Error('Tracked child was not reaped by watchdog');
    }),
  ]);
  assert.equal(child.exitCode !== null || child.signalCode !== null, true);
});
