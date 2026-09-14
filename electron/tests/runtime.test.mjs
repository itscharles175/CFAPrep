import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createRequire } from 'node:module';
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
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
  LSAT_DB_RECORD,
  LsatDbKeyStore,
  SecureKeyStore,
  assertKeychainTarget,
  assertSafeStorageAvailable,
  readLegacyCredential,
} from '../keychain.js';
import { legacyLsatDataDir, lsatStorePath, resolveLsatDataDir } from '../relocation.js';
import {
  FILE_READ_CAP_BYTES,
  PathAuthorization,
  extractDeepLinks,
  extractLaunchFilePaths,
  isPathWithin,
  parseDeepLink,
} from '../path-policy.js';
import {
  appAssetCandidate,
  productionContentSecurityPolicy,
  registerAppScheme,
  resolveAppAssetPath,
} from '../protocol.js';
import {
  SWEEP_OUTCOMES,
  createSystemSweeper,
  parseLsofPids,
  parseNetstatListeningPids,
  sweepOwnedPorts,
} from '../port-sweep.js';
import { manifestRelativePath, verifyServiceProvenance } from '../provenance.js';
import { installLsatAuthorization, isExactLsatApiUrl } from '../session-auth.js';
import { buildServiceSpecs, resolveOpenNotebookPrograms, resolveServicesDirectory } from '../service-specs.js';
import {
  CRASH_GUARD_UNAVAILABLE_REASON,
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

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Uint8Array.from([...value].map((character) => character.charCodeAt(0) ^ 0xaa)),
    decryptString: (value) => [...value].map((byte) => String.fromCharCode(byte ^ 0xaa)).join(''),
  };
}

// Point the platform's OS app-data base at a temp root so the legacy LSAT dir the
// relocation guard looks for resolves inside the test sandbox.
function legacyAppDataEnv(root, platform) {
  if (platform === 'win32') return { APPDATA: root };
  if (platform === 'darwin') return { HOME: root };
  return { XDG_DATA_HOME: root };
}

test('stable IPC allowlist has no LSAT token channel and rejects unknown input', () => {
  assert.equal('SIDECAR_TOKEN' in CHANNELS, false);
  assert.equal(ALLOWED_INVOKE_CHANNELS.includes('studyvault:sidecar:token'), false);
  assert.throws(() => validateRequest('studyvault:sidecar:token'), ContractError);
  assert.throws(() => validateRequest(IPC_CHANNELS.FILES_READ, { path: 'x.pdf', extra: true }), /not allowed/);
  assert.throws(() => validateResponse(IPC_CHANNELS.FULLSCREEN_GET, 'false'), /boolean/);
});

test('packaging prunes node_modules from the asar', async () => {
  // The main process imports only node: builtins and electron, but electron-builder
  // harvests node_modules unless a negated glob prunes it — which is worth 287 MB
  // of app.asar (319 MB -> 32 MB). Nothing else observes packaged output size, so
  // without this assertion a stray edit to files: silently re-inflates the installer.
  const builderConfig = await readFile(path.join(repoRoot, 'electron-builder.yml'), 'utf8');
  assert.match(builderConfig, /^\s+- '!node_modules\/\*\*\/\*'$/m);
});

test('packaging enables hardened fuses without requiring an absent browser snapshot', async () => {
  const builderConfig = await readFile(path.join(repoRoot, 'electron-builder.yml'), 'utf8');
  assert.match(builderConfig, /^beforePack: scripts\/build-native-watchdog\.mjs$/m);
  assert.match(builderConfig, /^afterPack: scripts\/apply-electron-fuses\.mjs$/m);
  assert.match(builderConfig, /^\s+- studyvault-watchdog$/m);
  assert.equal(ELECTRON_FUSE_CONFIG.strictlyRequireAllFuses, true);
  assert.equal(ELECTRON_FUSE_CONFIG[FuseV1Options.RunAsNode], false);
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

test('folder listing skips symlinks and enforces its entry cap', async (t) => {
  const root = await temporaryDirectory(t);
  await writeFile(path.join(root, 'a.pdf'), 'a');
  await writeFile(path.join(root, 'b.pdf'), 'b');
  const capped = new PathAuthorization({ entryCap: 1 });
  await capped.authorizePickedRoot(root);
  await assert.rejects(() => capped.listPdfs(root), /entry cap/);
  await assert.rejects(() => capped.readAuthorizedFile(path.join(root, 'a.pdf')), /not been authorized/);

  const target = path.join(root, 'target.pdf');
  const link = path.join(root, 'linked.pdf');
  const linkedDirectory = path.join(root, 'real');
  const junction = path.join(root, 'junction');
  await writeFile(target, 'target');
  await mkdir(linkedDirectory);
  await writeFile(path.join(linkedDirectory, 'inside.pdf'), 'inside');

  // Windows refuses file symlinks without developer mode but always allows a
  // directory junction, which lstat reports as a link just the same — so at least
  // one of the two exercises the skip on every host.
  let links = 0;
  let fileLink = false;
  for (const [source, destination, type] of [
    [target, link, 'file'],
    [linkedDirectory, junction, process.platform === 'win32' ? 'junction' : 'dir'],
  ]) {
    try {
      await symlink(source, destination, type);
      links += 1;
      fileLink ||= type === 'file';
    } catch (error) {
      if (error?.code !== 'EPERM') throw error;
      t.diagnostic(`Creating a ${type} link is unavailable on this host`);
    }
  }
  assert.notEqual(links, 0);

  const authorization = new PathAuthorization();
  await authorization.authorizePickedRoot(root);
  const rows = await authorization.listPdfs(root);
  // Links are skipped, not fatal: every real PDF beside them still lists, and the
  // junction's target is reached once through the real directory instead.
  assert.deepEqual(
    rows.map((row) => row.name),
    ['a.pdf', 'b.pdf', 'inside.pdf', 'target.pdf'],
  );
  assert.equal(rows.skipped_links, links);
  assert.equal(rows.skipped_oversize, 0);
  assert.equal(rows.skipped_errors, 0);
  if (fileLink) await assert.rejects(() => authorization.readAuthorizedFile(link), /symbolic link/i);
});

test('folder listing skips oversized and unstattable entries instead of aborting', async (t) => {
  const root = await temporaryDirectory(t);
  const nested = path.join(root, 'nested');
  await mkdir(nested);
  await writeFile(path.join(root, 'good.pdf'), 'good');
  await writeFile(path.join(nested, 'deep.pdf'), 'deep');
  await writeFile(path.join(root, 'broken.pdf'), 'broken');
  const oversized = path.join(root, 'huge.pdf');
  await writeFile(oversized, 'x');
  await truncate(oversized, FILE_READ_CAP_BYTES + 1);

  const authorization = new PathAuthorization({
    statEntry: async (candidate) => {
      if (path.basename(candidate) === 'broken.pdf') throw Object.assign(new Error('simulated'), { code: 'EIO' });
      return lstat(candidate);
    },
  });
  await authorization.authorizePickedRoot(root);
  const rows = await authorization.listPdfs(root);
  assert.deepEqual(
    rows.map((row) => row.name),
    ['good.pdf', 'deep.pdf'],
  );
  assert.equal(rows.skipped_oversize, 1);
  assert.equal(rows.skipped_errors, 1);
  assert.equal(rows.skipped_links, 0);
  // Skipping must not widen authorization: neither skipped file became readable.
  await assert.rejects(() => authorization.readAuthorizedFile(oversized), /not been authorized/);
  await assert.rejects(() => authorization.readAuthorizedFile(path.join(root, 'broken.pdf')), /not been authorized/);
});

test('folder listing skips an unreadable subtree but still fails on an unreadable root', async (t) => {
  const root = await temporaryDirectory(t);
  const locked = path.join(root, 'locked');
  await mkdir(locked);
  await writeFile(path.join(root, 'top.pdf'), 'top');
  await writeFile(path.join(locked, 'inner.pdf'), 'inner');

  const authorization = new PathAuthorization({
    readDirectory: async (directory, options) => {
      if (path.basename(directory) === 'locked') throw Object.assign(new Error('simulated'), { code: 'EACCES' });
      return readdir(directory, options);
    },
  });
  await authorization.authorizePickedRoot(root);
  const rows = await authorization.listPdfs(root);
  assert.deepEqual(
    rows.map((row) => row.name),
    ['top.pdf'],
  );
  assert.equal(rows.skipped_errors, 1);

  const unreadableRoot = new PathAuthorization({
    readDirectory: async () => {
      throw Object.assign(new Error('root is unreadable'), { code: 'EACCES' });
    },
  });
  await unreadableRoot.authorizePickedRoot(root);
  await assert.rejects(() => unreadableRoot.listPdfs(root), /root is unreadable/);
});

test('pdf listing contract carries large metadata and skip counters without loosening the read cap', () => {
  const listing = Object.assign(
    [
      {
        path: path.join('C:', 'study', 'huge.pdf'),
        relative_path: 'huge.pdf',
        name: 'huge.pdf',
        extension: '.pdf',
        size: FILE_READ_CAP_BYTES + 1,
      },
    ],
    { skipped_links: 2, skipped_oversize: 1, skipped_errors: 3 },
  );
  const validated = validateResponse(IPC_CHANNELS.FILES_LIST_PDFS, listing);
  assert.equal(validated.length, 1);
  assert.equal(validated[0].size, FILE_READ_CAP_BYTES + 1);
  assert.equal(validated.skipped_links, 2);
  assert.equal(validated.skipped_oversize, 1);
  assert.equal(validated.skipped_errors, 3);
  assert.equal(validateResponse(IPC_CHANNELS.FILES_LIST_PDFS, []).skipped_links, 0);
  assert.throws(
    () =>
      validateResponse(IPC_CHANNELS.FILES_READ, {
        path: path.join('C:', 'study', 'huge.pdf'),
        name: 'huge.pdf',
        extension: '.pdf',
        size: FILE_READ_CAP_BYTES + 1,
        data: new Uint8Array(FILE_READ_CAP_BYTES + 1),
      }),
    /at most 50 MiB/,
  );
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

test('launch path extraction accepts only absolute, traversal-free PDF and TXT paths', () => {
  const studyRoot = path.resolve('study');
  const absolutePdf = path.join(studyRoot, 'a.pdf');
  const absoluteText = path.join(studyRoot, 'c.TXT');
  const paths = extractLaunchFilePaths([
    'electron',
    '.',
    'a.pdf',
    '--flag',
    absolutePdf,
    path.join(studyRoot, 'b.exe'),
    absoluteText,
    absolutePdf,
    // A relative argument would previously have been resolved against the cwd.
    path.join('nested', 'relative.pdf'),
    // `..` is rejected on the raw argument: normalize() would collapse it away.
    `${studyRoot}${path.sep}..${path.sep}..${path.sep}secret.pdf`,
  ]);
  assert.deepEqual(paths, [absolutePdf, absoluteText]);
});

test('deep-link URLs are routed as URLs and never reach the launch file extractor', () => {
  assert.deepEqual(parseDeepLink('studyvault://open/lsat/srs'), {
    action: 'open',
    route: '/lsat/srs',
    href: 'studyvault://open/lsat/srs',
  });
  assert.equal(parseDeepLink('studyvault://ROUTE/dashboard').action, 'route');
  assert.equal(parseDeepLink('studyvault://open').route, '/');
  // Anything that is not an allowlisted studyvault action, or that carries path
  // syntax instead of route segments, is refused outright.
  assert.equal(parseDeepLink('studyvault://exfiltrate/a'), null);
  assert.equal(parseDeepLink('studyvault:C:\\Windows\\secret.pdf'), null);
  assert.equal(parseDeepLink('studyvault:///c:/Windows/secret.pdf'), null);
  assert.equal(parseDeepLink('file:///C:/Windows/win.ini'), null);
  assert.equal(parseDeepLink('https://example.com/x'), null);
  assert.equal(parseDeepLink('not a url'), null);
  assert.equal(parseDeepLink(''), null);

  const hostile = [
    'studyvault://open/../../../Windows/System32/config/SAM.txt',
    'studyvault://open/%2e%2e/secret.pdf',
    'studyvault://open/notes.pdf',
    'file:///C:/Windows/win.ini',
  ];
  // The deep-link parser accepts some of these as in-app routes, but the launch
  // extractor — the only path to file authorization — accepts none of them.
  assert.deepEqual(extractLaunchFilePaths(hostile), []);
  assert.deepEqual(
    extractDeepLinks(hostile).map((link) => link.route),
    ['/Windows/System32/config/SAM.txt', '/secret.pdf', '/notes.pdf'],
  );
});

test('app protocol resolution cannot escape dist and falls back for routes', async (t) => {
  const root = await temporaryDirectory(t);
  await writeFile(path.join(root, 'index.html'), '<main>StudyVault</main>');
  await mkdir(path.join(root, 'assets'));
  await writeFile(path.join(root, 'assets', 'app.js'), 'ok');
  const asset = appAssetCandidate(root, 'app://studyvault/assets/app.js');
  assert.equal(isPathWithin(root, asset), true);
  assert.equal(
    await resolveAppAssetPath(root, 'app://studyvault/route/inside'),
    path.join(await realpath(root), 'index.html'),
  );
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
  const surreal = specs.find((spec) => spec.name === 'SurrealDB');
  const userDataPath = path.resolve('user-data');
  assert.equal(surreal.dataRoot, userDataPath);
  assert.equal(surreal.dataDirectory.startsWith(userDataPath + path.sep), true);
  assert.equal(surreal.args.some((arg) => arg.includes(path.resolve('services-root', 'surreal_data'))), false);
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
  // `env: {}` leaves no OS app-data base, so the relocation guard cannot reach
  // this machine's real LSAT bank; `readLegacy` keeps the OS credential store out.
  const options = {
    safeStorage: fakeSafeStorage(),
    userDataPath: root,
    platform: 'win32',
    env: {},
    readLegacy: () => null,
  };
  const store = new SecureKeyStore(options);
  await store.set(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, 'plain-secret');
  const disk = await readFile(store.filePath, 'utf8');
  assert.equal(disk.includes('plain-secret'), false);
  assert.equal(await store.get(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT), 'plain-secret');
  await store.delete(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  assert.equal(await store.get(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT), null);

  const dbKeys = new LsatDbKeyStore(options);
  const first = await dbKeys.getOrCreate();
  const second = await dbKeys.getOrCreate();
  assert.match(first, /^[A-Za-z0-9+/]{43}=$/);
  assert.equal(second, first);
  assert.equal((await readFile(dbKeys.filePath, 'utf8')).includes(first), false);
});

test('LSAT DB key store refuses to rotate a key an existing database still depends on', async (t) => {
  const root = await temporaryDirectory(t);
  const dataDir = path.join(root, 'lsat-backend');
  await mkdir(dataDir, { recursive: true });
  await writeFile(lsatStorePath(dataDir), 'sqlite-bank-bytes');
  const dbKeys = new LsatDbKeyStore({
    safeStorage: fakeSafeStorage(),
    userDataPath: root,
    platform: 'win32',
    env: {},
    readLegacy: () => null,
  });
  await assert.rejects(() => dbKeys.getOrCreate(), /refusing to mint a replacement key/);
  assert.equal(dbKeys.protectedStorePath(), lsatStorePath(dataDir));

  // A 0-byte file is a stub, not a protected bank: minting stays available.
  await truncate(lsatStorePath(dataDir), 0);
  assert.equal(dbKeys.protectedStorePath(), null);
  assert.match(await dbKeys.getOrCreate(), /^[A-Za-z0-9+/]{43}=$/);
});

test('first run imports the Tauri credential once and a delete is never resurrected', async (t) => {
  const root = await temporaryDirectory(t);
  const legacyKey = `${'c'.repeat(43)}=`;
  let probes = 0;
  const dbKeys = new LsatDbKeyStore({
    safeStorage: fakeSafeStorage(),
    userDataPath: root,
    platform: 'win32',
    env: {},
    readLegacy: ({ account }) => {
      probes += 1;
      return account === 'lsat-db-dek' ? legacyKey : null;
    },
  });
  assert.equal(await dbKeys.getOrCreate(), legacyKey);
  assert.equal(await dbKeys.getOrCreate(), legacyKey);
  assert.equal(probes, 1);

  const vault = new SecureKeyStore({
    safeStorage: fakeSafeStorage(),
    userDataPath: root,
    platform: 'win32',
    env: {},
    readLegacy: () => 'legacy-vault-dek',
  });
  assert.equal(await vault.get(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT), 'legacy-vault-dek');
  await vault.delete(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  assert.equal(await vault.get(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT), null);
});

test('legacy credential lookup targets the Tauri names and tolerates absence', () => {
  const refuse = () => {
    throw new Error('the credential store must not be probed here');
  };
  const calls = [];
  assert.equal(
    readLegacyCredential({
      account: 'lsat-db-dek',
      platform: 'darwin',
      runCommand: (file, args) => {
        calls.push([file, ...args]);
        return { status: 0, stdout: 'legacy-secret\n' };
      },
    }),
    'legacy-secret',
  );
  assert.deepEqual(calls[0], ['security', 'find-generic-password', '-s', 'studyvault/lsat-db-dek', '-w']);
  assert.equal(
    readLegacyCredential({ account: 'lsat-db-dek', platform: 'darwin', runCommand: () => ({ status: 44, stdout: '' }) }),
    null,
  );
  assert.equal(readLegacyCredential({ account: 'lsat-db-dek', platform: 'linux', runCommand: refuse }), null);
  assert.equal(readLegacyCredential({ account: 'not-a-target', platform: 'darwin', runCommand: refuse }), null);

  // cmdkey only proves presence, so an absent target must skip the blob read.
  const windowsCalls = [];
  assert.equal(
    readLegacyCredential({
      account: 'vault-dek',
      platform: 'win32',
      runCommand: (file, args) => {
        windowsCalls.push([file, ...args]);
        return { status: 0, stdout: '* NONE *' };
      },
    }),
    null,
  );
  assert.deepEqual(windowsCalls, [['cmdkey', '/list:studyvault/vault-dek']]);
});

test('encrypted records are bound to their record name and reject a swapped file', async (t) => {
  const root = await temporaryDirectory(t);
  const safeStorage = fakeSafeStorage();
  const options = { safeStorage, userDataPath: root, platform: 'win32', env: {}, readLegacy: () => null };
  const vault = new SecureKeyStore(options);
  const dbKeys = new LsatDbKeyStore(options);
  await vault.set(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, 'vault-secret');
  const minted = await dbKeys.getOrCreate();
  assert.equal(path.basename(dbKeys.filePath), `${LSAT_DB_RECORD}.bin`);
  assert.equal(JSON.parse(safeStorage.decryptString(await readFile(vault.filePath))).name, KEYCHAIN_ACCOUNT);

  // A same-app attacker swaps the vault ciphertext into the LSAT record's path.
  await writeFile(dbKeys.filePath, await readFile(vault.filePath));
  await assert.rejects(() => dbKeys.getOrCreate(), /bound to a different record/);
  assert.notEqual(minted, 'vault-secret');
});

test('relocation guard adopts a legacy LSAT bank only while the new store is empty', async (t) => {
  const root = await temporaryDirectory(t);
  const platform = process.platform;
  const env = legacyAppDataEnv(root, platform);
  const legacyDir = legacyLsatDataDir({ platform, env });
  const userDataPath = path.join(root, 'userData');
  const newDir = path.join(userDataPath, 'lsat-backend');
  await mkdir(legacyDir, { recursive: true });
  await mkdir(newDir, { recursive: true });

  assert.equal(resolveLsatDataDir({ userDataPath, platform, env }).dataDir, newDir);
  await writeFile(lsatStorePath(legacyDir), '');
  assert.equal(resolveLsatDataDir({ userDataPath, platform, env }).dataDir, newDir);

  await writeFile(lsatStorePath(legacyDir), 'sqlite-bank-bytes');
  const adopted = resolveLsatDataDir({ userDataPath, platform, env });
  assert.equal(adopted.dataDir, legacyDir);
  assert.equal(adopted.relocated, true);

  const logged = [];
  const specs = buildServiceSpecs({
    servicesDirectory: path.resolve('services-root'),
    userDataPath,
    lsatToken: 'a'.repeat(64),
    lsatDbKeyB64: `${'b'.repeat(43)}=`,
    platform,
    env,
    logger: { info: (event, details) => logged.push([event, details]) },
  });
  const lsat = specs.find((spec) => spec.name === 'LSAT backend');
  assert.equal(lsat.env.LSATLAB_DATA_DIR, legacyDir);
  // The containment root must follow, or the sidecar rejects its own data dir.
  assert.equal(lsat.dataRoot, legacyDir);
  assert.equal(logged[0][0], 'lsat_data_dir_resolved');

  // A populated new store always wins — the guard never redirects live data.
  await writeFile(lsatStorePath(newDir), 'newer-bank-bytes');
  assert.equal(resolveLsatDataDir({ userDataPath, platform, env }).dataDir, newDir);
});

// The guard resolves the legacy directory from `platform` + `env`, so all three
// platform branches are testable from any host. Without this the macOS and Linux
// branches ship entirely unverified: the electron CI job runs windows-latest only,
// so a wrong path there would strand every Mac and Linux user's question bank and
// nothing would catch it. A fake statFile keeps the cases pure path resolution.
test('relocation guard resolves the legacy bank location on every platform', () => {
  const userDataPath = path.join(path.sep, 'app-data', 'StudyVault');
  const cases = [
    { platform: 'win32', env: { APPDATA: path.join('C:', 'Users', 'x', 'AppData', 'Roaming') } },
    { platform: 'darwin', env: { HOME: path.join(path.sep, 'Users', 'x') } },
    { platform: 'linux', env: { XDG_DATA_HOME: path.join(path.sep, 'home', 'x', '.local', 'share') } },
    // Linux falls back to ~/.local/share when XDG_DATA_HOME is unset.
    { platform: 'linux', env: { HOME: path.join(path.sep, 'home', 'x') } },
    // macOS keeps its own layout rather than borrowing the XDG one.
    { platform: 'darwin', env: { HOME: path.join(path.sep, 'Users', 'x'), XDG_DATA_HOME: path.join(path.sep, 'ignored') } },
  ];

  for (const { platform, env } of cases) {
    const legacyDir = legacyLsatDataDir({ platform, env });
    assert.ok(legacyDir, `${platform} must resolve a legacy dir from ${JSON.stringify(env)}`);
    assert.equal(path.basename(legacyDir), 'LSATLab', `${platform} legacy dir must be the LSATLab leaf`);

    // A populated legacy store with an empty current one is the adopt case, and it
    // must hold identically on every platform.
    const statFile = (target) =>
      target === lsatStorePath(legacyDir) ? { isFile: () => true, size: 4096 } : { isFile: () => true, size: 0 };
    const decision = resolveLsatDataDir({ userDataPath, platform, env, statFile });
    assert.equal(decision.dataDir, legacyDir, `${platform} should adopt the populated legacy bank`);
    assert.equal(decision.relocated, true);
  }

  assert.equal(legacyLsatDataDir({ platform: 'darwin', env: { HOME: path.join(path.sep, 'Users', 'x') } }).includes('Application Support'), true);
});

test('relocation guard never relocates onto itself and survives an unresolvable environment', () => {
  // The same-path branch guards against "adopting" a directory that is already the
  // active one, which would log a migration that never happened. It is unreachable
  // while the leaves differ (`lsat-backend` vs `LSATLab`), and that is exactly what
  // is worth pinning: if someone renames either constant into a collision, the
  // guard would start relocating a directory onto itself and this fails first.
  const populated = { isFile: () => true, size: 4096 };
  for (const platform of ['win32', 'darwin', 'linux']) {
    const env = legacyAppDataEnv(path.join(path.sep, 'same-path-root'), platform);
    const legacyDir = legacyLsatDataDir({ platform, env });
    const decision = resolveLsatDataDir({
      userDataPath: path.dirname(legacyDir),
      platform,
      env,
      statFile: () => populated,
    });
    assert.equal(decision.samePath, false, `${platform}: legacy and current dirs must not collide`);
    assert.notEqual(decision.currentDir, decision.legacyDir);
    // Both stores read as populated, so the current one must win outright.
    assert.equal(decision.relocated, false, `${platform}: a populated current store is never displaced`);
    assert.equal(decision.dataDir, decision.currentDir);
  }

  // Unresolvable environment: no APPDATA, no HOME, no XDG_DATA_HOME. The guard runs
  // during boot before any window exists, so throwing here would be an unrecoverable
  // startup crash rather than a degraded sidecar.
  for (const unresolvable of [{ platform: 'win32', env: {} }, { platform: 'darwin', env: {} }, { platform: 'linux', env: {} }]) {
    assert.equal(legacyLsatDataDir(unresolvable), null);
    const decision = resolveLsatDataDir({
      userDataPath: path.join(path.sep, 'app-data', 'StudyVault'),
      ...unresolvable,
      statFile: () => populated,
    });
    assert.equal(decision.legacyDir, null);
    assert.equal(decision.relocated, false, 'no legacy base means nothing to adopt');
    assert.equal(decision.dataDir, decision.currentDir);
  }
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
  const base = { requestingUrl: 'app://studyvault/', isMainFrame: true, microphoneLeaseValid: true };
  assert.equal(isAllowedPermission({ ...base, permission: 'media', mediaTypes: ['audio'] }), true);
  assert.equal(isAllowedPermission({ ...base, microphoneLeaseValid: false, permission: 'media', mediaTypes: ['audio'] }), false);
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

function sidecarSpec(overrides = {}) {
  return {
    name: 'test service',
    program: 'service.exe',
    args: [],
    env: {},
    readyPort: 8100,
    dependsOn: [],
    optional: false,
    resourcePath: null,
    provenanceRequired: false,
    cwd: os.tmpdir(),
    ...overrides,
  };
}

function stubChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = null;
  child.stderr = null;
  // The manager attaches its 'spawn' listener synchronously, so a microtask is
  // the earliest safe point to report a successful spawn.
  void Promise.resolve().then(() => child.emit('spawn'));
  return child;
}

function stubManager(options) {
  return new SidecarManager({
    servicesDirectory: os.tmpdir(),
    lsatToken: 'b'.repeat(64),
    logger: quietLogger,
    provenanceVerifier: async () => ({ status: 'not_applicable', blocksLaunch: false, message: null }),
    terminateTree: async () => {},
    portSweep: async () => [],
    ...options,
  });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error('Condition was not met before the deadline');
}

test('occupied expected port is retried on a bounded budget instead of latching blocked', async () => {
  let spawnCount = 0;
  let terminateCount = 0;
  const retrying = stubManager({
    specs: [sidecarSpec({ name: 'LSAT backend', env: { LSATLAB_DATA_DIR: os.tmpdir() } })],
    spawnProcess: () => {
      spawnCount += 1;
    },
    portProbe: async () => true,
    terminateTree: async () => {
      terminateCount += 1;
    },
    portRetryBaseMs: 50,
  });
  await retrying.startAll();
  const [retried] = await retrying.getStatus();
  assert.equal(retried.blocked, false);
  assert.equal(retried.state, 'backoff');
  assert.equal(retried.provenance_status, 'port_occupied');
  assert.equal(retrying.records.get('LSAT backend').portRetryCount, 1);
  assert.equal(retrying.getAuthorizationTokenForRequest(), null);
  assert.equal(spawnCount, 0);
  await retrying.stopAll();
  assert.equal(terminateCount, 0);

  // The budget is bounded: an occupancy that never clears still latches blocked.
  const exhausted = stubManager({
    specs: [sidecarSpec()],
    spawnProcess: () => {},
    portProbe: async () => true,
    maxPortRetries: 0,
  });
  await exhausted.startAll();
  const [latched] = await exhausted.getStatus();
  assert.equal(latched.blocked, true);
  assert.equal(latched.provenance_status, 'port_occupied');
  await exhausted.stopAll();
});

test('free-port launch degrades instead of blocking when the crash guard is unavailable', async () => {
  let spawnCount = 0;
  const manager = stubManager({
    specs: [sidecarSpec({ name: 'optional service', readyPort: 5055, optional: true })],
    spawnProcess: () => {
      spawnCount += 1;
      return stubChild(4242);
    },
    portProbe: async () => false,
    readinessProbe: async () => true,
    watchdog: null,
  });
  const boot = await manager.startAll();
  const [status] = await manager.getStatus();
  assert.equal(spawnCount, 1);
  assert.equal(status.ready, true);
  assert.equal(manager.records.get('optional service').crashGuardDegraded, true);
  assert.equal(boot.status, 'degraded');
  assert.match(boot.degraded_reason, new RegExp(CRASH_GUARD_UNAVAILABLE_REASON));
  await manager.stopAll();
});

test('resume recovery keeps healthy owned sidecars and restarts an unhealthy owned child', async () => {
  let spawnCount = 0;
  let probeCount = 0;
  let terminateCount = 0;
  const manager = stubManager({
    specs: [sidecarSpec({ readyPort: 8100 })],
    spawnProcess: () => stubChild(5000 + ++spawnCount),
    portProbe: async () => false,
    readinessProbe: async () => {
      probeCount += 1;
      return probeCount !== 3;
    },
    terminateTree: async () => {
      terminateCount += 1;
    },
  });
  await manager.startAll();
  assert.equal(spawnCount, 1);
  manager.quiesce('suspend');
  assert.equal(manager.quiesced, true);
  assert.equal(manager.healthTimer, null);
  const recovered = await manager.recover('resume');
  assert.equal(manager.quiesced, false);
  assert.equal(spawnCount, 2);
  assert.equal(terminateCount, 1);
  assert.match(recovered.status, /^(ok|degraded)$/);
  await manager.stopAll();
});

test('LSAT encryption failure stays blocked until a refreshed key is supplied', async () => {
  const manager = stubManager({
    specs: [
      sidecarSpec({
        name: 'LSAT backend',
        launchBlockReason: 'safeStorage unavailable',
        env: { LSATLAB_DATA_DIR: os.tmpdir() },
        dataRoot: os.tmpdir(),
      }),
    ],
    spawnProcess: () => stubChild(6001),
    portProbe: async () => false,
    readinessProbe: async () => true,
  });
  const blocked = await manager.startAll();
  assert.equal(blocked.status, 'error');
  assert.equal(manager.records.get('LSAT backend').spec.env.LSATLAB_DB_KEY_B64, undefined);
  assert.equal(manager.setLsatEncryptionKey('secure-key', null), true);
  const recovered = await manager.recover('unlock');
  assert.match(recovered.status, /^(ok|degraded)$/);
  assert.equal(manager.records.get('LSAT backend').spec.env.LSATLAB_DB_KEY_B64, 'secure-key');
  await manager.stopAll();
});

test('resume blocks and terminates an existing LSAT sidecar when encryption becomes unavailable', async () => {
  let terminateCount = 0;
  const manager = stubManager({
    specs: [
      sidecarSpec({
        name: 'LSAT backend',
        env: { LSATLAB_DATA_DIR: os.tmpdir(), LSATLAB_DB_KEY_B64: 'initial-key' },
        dataRoot: os.tmpdir(),
      }),
    ],
    spawnProcess: () => stubChild(6002),
    portProbe: async () => false,
    readinessProbe: async () => true,
    terminateTree: async () => { terminateCount += 1; },
  });
  await manager.startAll();
  assert.equal(manager.records.get('LSAT backend').state, 'ready');
  manager.quiesce('suspend');
  manager.setLsatEncryptionKey(null, 'safeStorage unavailable after wake');
  const recovered = await manager.recover('resume');
  const record = manager.records.get('LSAT backend');
  assert.equal(terminateCount, 1);
  assert.equal(record.child, null);
  assert.equal(record.state, 'blocked');
  assert.equal(record.blockReason, 'safeStorage unavailable after wake');
  assert.equal(recovered.status, 'error');
  await manager.stopAll();
});

test('boot sweep reclaims only a durably owned stale listener and leaves every unknown process alone', async () => {
  const killed = [];
  const sweeper = {
    async pidsOnPort(port) {
      if (port === 8100) return [4242];
      if (port === 8000) return [777];
      if (port === 5055) return [process.pid];
      return [];
    },
    async kill(pid) {
      killed.push(pid);
      return true;
    },
  };
  const results = await sweepOwnedPorts({
    targets: [
      { name: 'LSAT backend', port: 8100, identity: { path: '/api/health', service: 'lsat-backend' } },
      { name: 'SurrealDB', port: 8000, identity: { path: '/health', service: 'surreal' } },
      { name: 'self held', port: 5055, identity: { path: '/health', service: 'self' } },
      { name: 'unclaimed', port: 4321, identity: null },
      // A repeated port must not be swept — and killed — twice.
      { name: 'LSAT backend', port: 8100, identity: { path: '/api/health', service: 'lsat-backend' } },
    ],
    sweeper,
    identityProbe: async (_identity, port) => port === 8100,
    selfPids: [process.pid],
    ownedPids: [4242],
    logger: quietLogger,
  });
  assert.deepEqual(
    results.map((result) => result.outcome),
    [SWEEP_OUTCOMES.RECLAIMED, SWEEP_OUTCOMES.FOREIGN, SWEEP_OUTCOMES.SELF, SWEEP_OUTCOMES.FREE],
  );
  assert.deepEqual(killed, [4242]);
});

test('boot sweep never throws and never kills an unidentified or unreachable listener', async () => {
  const killed = [];
  const results = await sweepOwnedPorts({
    targets: [
      { name: 'exploding', port: 8100, identity: { path: '/api/health', service: 'lsat-backend' } },
      { name: 'no identity contract', port: 8000, identity: null },
    ],
    sweeper: {
      async pidsOnPort(port) {
        if (port === 8100) throw new Error('netstat is blocked by policy');
        return [999];
      },
      async kill(pid) {
        killed.push(pid);
        return true;
      },
    },
    identityProbe: async () => true,
    selfPids: [process.pid],
    logger: quietLogger,
  });
  assert.deepEqual(
    results.map((result) => result.outcome),
    [SWEEP_OUTCOMES.UNRESOLVED, SWEEP_OUTCOMES.UNIDENTIFIED],
  );
  assert.deepEqual(killed, []);

  // An unusable discovery tool reports the port unresolved rather than free.
  const sweeper = createSystemSweeper({
    platform: 'win32',
    runCommand: async () => ({ ok: false, available: false, stdout: '' }),
  });
  assert.equal(await sweeper.pidsOnPort(8100), null);
  assert.deepEqual(parseNetstatListeningPids('  TCP  127.0.0.1:81000  0.0.0.0:0  LISTENING  55\n', 100), []);
  assert.deepEqual(
    parseNetstatListeningPids(
      '  TCP    127.0.0.1:8100    0.0.0.0:0    LISTENING    4242\n' +
        '  TCP    127.0.0.1:8100    127.0.0.1:51000    ESTABLISHED    9999\n',
      8100,
    ),
    [4242],
  );
  assert.deepEqual(parseLsofPids('4242\n9999\n4242\n\n'), [4242, 9999]);
});

test('boot sweeps every present owned port before the first launch attempt', async () => {
  const observed = [];
  const manager = stubManager({
    specs: [
      sidecarSpec({
        name: 'identified service',
        readinessIdentity: { path: '/api/health', service: 'lsat-backend' },
      }),
      sidecarSpec({ name: 'missing service', readyPort: 5055, resourcePath: path.join(os.tmpdir(), 'absent.exe') }),
      sidecarSpec({ name: 'worker', readyPort: null }),
    ],
    spawnProcess: () => stubChild(4242),
    portProbe: async () => false,
    readinessProbe: async () => true,
    portSweep: async ({ targets }) => {
      observed.push(...targets);
      return [];
    },
  });
  await manager.startAll();
  assert.deepEqual(observed, [
    { name: 'identified service', port: 8100, identity: { path: '/api/health', service: 'lsat-backend' } },
  ]);
  await manager.stopAll();
});

test('restart budget is restored once a respawned sidecar polls healthy again', async () => {
  let pid = 5000;
  const manager = stubManager({
    specs: [sidecarSpec({ name: 'flaky service' })],
    spawnProcess: () => {
      pid += 1;
      return stubChild(pid);
    },
    portProbe: async () => false,
    readinessProbe: async () => true,
    respawnBaseMs: 10,
    healthIntervalMs: 10,
  });
  await manager.startAll();
  const record = manager.records.get('flaky service');
  assert.equal(record.state, 'ready');
  assert.equal(record.restartCount, 0);

  const first = record.child;
  first.exitCode = 1;
  first.emit('exit', 1, null);
  // A transient blip consumes budget immediately and must not be permanent.
  assert.equal(record.restartCount, 1);
  assert.equal(record.state, 'backoff');

  await waitFor(() => record.state === 'ready' && record.child !== first);
  await waitFor(() => record.restartCount === 0);
  assert.equal(record.child.pid, 5002);
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
  // The reap budget must exceed the watchdog's own internal timeouts, not just a
  // typical reap. On Windows the shutdown path runs a PowerShell CIM snapshot
  // (spawnSync timeout 8s) and then taskkill (timeout 10s); a deadline below that
  // sum fails on a loaded machine while the implementation is working correctly.
  const REAP_BUDGET_MS = 45_000;
  await Promise.race([
    exited,
    delay(REAP_BUDGET_MS).then(() => {
      throw new Error(`Tracked child was not reaped by watchdog within ${REAP_BUDGET_MS}ms`);
    }),
  ]);
  assert.equal(child.exitCode !== null || child.signalCode !== null, true);
});

test('owned-child watchdog speaks the utilityProcess message protocol without RunAsNode', async () => {
  const messages = [];
  const forkProcess = () => {
    const child = new EventEmitter();
    child.pid = 7001;
    child.stdout = null;
    child.stderr = null;
    child.postMessage = (message) => {
      messages.push(message);
      queueMicrotask(() => {
        child.emit('message', { data: { id: message.id, ok: true } });
        if (message.op === 'shutdown') child.emit('exit', 0, null);
      });
    };
    child.kill = () => child.emit('exit', null, 'SIGKILL');
    queueMicrotask(() => child.emit('message', { data: { type: 'ready' } }));
    return child;
  };
  const watchdog = await OwnedChildWatchdog.start({
    scriptPath: '/unused/utility-watchdog.cjs',
    logger: quietLogger,
    parentPid: 7000,
    forkProcess,
  });
  await watchdog.track(7002);
  await watchdog.untrack(7002);
  await watchdog.close();
  assert.deepEqual(messages.map((message) => message.op), ['track', 'untrack', 'shutdown']);
  assert.equal(watchdog.healthy, false);
});

const SNAPSHOT_DIAGNOSTIC = 'watchdog_snapshot_unavailable';

function stderrRecordingLogger() {
  const lines = [];
  return {
    lines,
    info() {},
    warn(event, payload) {
      if (event === 'watchdog_stderr') lines.push(String(payload?.message ?? ''));
    },
    error() {},
    crash() {},
  };
}

async function hasStderrLine(logger, marker, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (logger.lines.some((line) => line.includes(marker))) return true;
    await delay(50);
  } while (Date.now() < deadline);
  return false;
}

// Starts a real watchdog whose Win32_Process snapshot can be broken ON DEMAND:
// `breakSnapshot()` drops an unusable `powershell.exe` at the front of the
// child's PATH. The stub is written only after readiness, so the child's startup
// snapshot probe still resolves the genuine PowerShell.
async function watchdogWithBreakableSnapshot(t) {
  const stubDirectory = await temporaryDirectory(t);
  const logger = stderrRecordingLogger();
  const spawnWithStubPath = (executable, args, options) => {
    const env = { ...options.env };
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === 'PATH') delete env[key];
    }
    env.PATH = `${stubDirectory}${path.delimiter}${process.env.PATH}`;
    return spawn(executable, args, { ...options, env });
  };
  const watchdog = await OwnedChildWatchdog.start({
    scriptPath: fileURLToPath(new URL('../child-watchdog.cjs', import.meta.url)),
    logger,
    executable: process.execPath,
    spawnProcess: spawnWithStubPath,
  });
  t.after(() => watchdog.close());
  return { watchdog, logger, breakSnapshot: () => writeFile(path.join(stubDirectory, 'powershell.exe'), '') };
}

function spawnDisposableChild(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  return child;
}

test('reap still kills a tracked root PID when the process snapshot is unavailable', async (t) => {
  if (process.platform !== 'win32') {
    t.diagnostic('The CIM snapshot degradation path only exists on Windows');
    return;
  }
  const { watchdog, logger, breakSnapshot } = await watchdogWithBreakableSnapshot(t);
  const child = spawnDisposableChild(t);
  await once(child, 'spawn');
  const exited = once(child, 'exit');
  await watchdog.track(child.pid);
  await breakSnapshot();
  await watchdog.close();

  const REAP_BUDGET_MS = 45_000;
  await Promise.race([
    exited,
    delay(REAP_BUDGET_MS).then(() => {
      throw new Error(`Tracked root was not reaped without a snapshot within ${REAP_BUDGET_MS}ms`);
    }),
  ]);
  assert.equal(child.exitCode !== null || child.signalCode !== null, true);
  // Also proves the sabotage actually took effect, which the probe test below
  // relies on when it asserts the diagnostic is ABSENT.
  assert.equal(await hasStderrLine(logger, SNAPSHOT_DIAGNOSTIC), true);
});

test('the parent probe never takes a process snapshot while the app is alive', async (t) => {
  if (process.platform !== 'win32') {
    t.diagnostic('The CIM snapshot degradation path only exists on Windows');
    return;
  }
  const { watchdog, logger, breakSnapshot } = await watchdogWithBreakableSnapshot(t);
  const child = spawnDisposableChild(t);
  await once(child, 'spawn');
  await watchdog.track(child.pid);
  await breakSnapshot();

  // Three 1500ms probe ticks. A probe that still ran descendant discovery would
  // hit the broken stub and emit the snapshot diagnostic on every tick.
  await delay(5000);
  assert.equal(
    logger.lines.some((line) => line.includes(SNAPSHOT_DIAGNOSTIC)),
    false,
  );
  // A discovery call on the interval blocks the child's event loop for seconds
  // (spawnSync), so a prompt round trip is the second, independent signal.
  const startedAt = Date.now();
  await watchdog.track(child.pid);
  assert.equal(Date.now() - startedAt < 2500, true);
  assert.equal(child.exitCode, null);
});

// Stand-in watchdog child that acknowledges shutdown and then takes longer to
// exit than the old 5s close() grace, the way a real reap does while it waits on
// its own snapshot and taskkill timeouts.
const SLOW_REAP_CHILD = [
  "process.stdout.write('STUDYVAULT_WATCHDOG_READY\\n');",
  "require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {",
  "  process.stdout.write(JSON.stringify({ id: JSON.parse(line).id, ok: true }) + '\\n');",
  '  setTimeout(() => process.exit(0), 7000);',
  '});',
].join('\n');

test('close waits out a slow reap instead of killing the watchdog part-way through it', async (t) => {
  let forceKilled = false;
  const spawnSlowReaper = () => {
    const child = spawn(process.execPath, ['-e', SLOW_REAP_CHILD], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const nativeKill = child.kill.bind(child);
    child.kill = (...args) => {
      forceKilled = true;
      return nativeKill(...args);
    };
    return child;
  };
  const watchdog = await OwnedChildWatchdog.start({
    scriptPath: 'unused-by-the-stand-in',
    logger: quietLogger,
    spawnProcess: spawnSlowReaper,
  });
  t.after(() => {
    if (watchdog.child.exitCode === null) watchdog.child.kill('SIGKILL');
  });

  await watchdog.close();
  // Force-killing here abandons whatever the child was still terminating, which
  // is the leak the crash guard exists to prevent.
  assert.equal(forceKilled, false);
  assert.equal(watchdog.child.exitCode, 0);
});
