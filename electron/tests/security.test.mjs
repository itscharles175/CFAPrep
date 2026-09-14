import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire, registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {
  ALLOWED_EVENT_CHANNELS,
  ALLOWED_INVOKE_CHANNELS,
  ContractError,
  IPC_CHANNELS,
  IPC_EVENTS,
  validateRequest,
  validateResponse,
} from '../contracts.js';
import { JsonLogger } from '../logging.js';
import { APP_ORIGIN } from '../protocol.js';
import { probeHttpServiceIdentity } from '../sidecar-manager.js';
import {
  MicrophonePermissionLease,
  isAllowedPermission,
  isAllowedSessionRequest,
  isSafeRendererUrl,
  normalizePopoutUrl,
} from '../window-security.js';

// electron/ipc.js and electron/preload.cjs both bind to the `electron` module,
// which outside an Electron runtime resolves to a path string with no named
// exports. A synchronous in-thread loader hook substitutes a recording double
// for that one specifier so the *real* modules can be exercised unmodified;
// every other specifier is delegated untouched.
const ELECTRON_STUB_URL = 'studyvault-electron-stub:/electron.mjs';
const bridgeExposures = [];
const invokeCalls = [];
const subscribeCalls = [];
const unsubscribeCalls = [];
const windowListeners = [];

globalThis.__studyvaultElectronStub = {
  BrowserWindow: { fromWebContents: () => null },
  contextBridge: {
    exposeInMainWorld(key, value) {
      bridgeExposures.push([key, value]);
    },
  },
  ipcRenderer: {
    invoke(channel, payload) {
      invokeCalls.push([channel, payload]);
      return Promise.resolve(null);
    },
    on(channel, listener) {
      subscribeCalls.push([channel, listener]);
    },
    removeListener(channel, listener) {
      unsubscribeCalls.push([channel, listener]);
    },
  },
  webUtils: {
    getPathForFile: (file) => file?.path,
  },
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: ELECTRON_STUB_URL, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === ELECTRON_STUB_URL) {
      return {
        format: 'module',
        shortCircuit: true,
        source: [
          'const stub = globalThis.__studyvaultElectronStub;',
          'export const BrowserWindow = stub.BrowserWindow;',
          'export const contextBridge = stub.contextBridge;',
          'export const ipcRenderer = stub.ipcRenderer;',
          'export const webUtils = stub.webUtils;',
          'export default stub;',
        ].join('\n'),
      };
    }
    return nextLoad(url, context);
  },
});

const { registerIpcHandlers } = await import('../ipc.js');
const require = createRequire(import.meta.url);

const VALID_AGGREGATE = Object.freeze({
  status: 'ok',
  ready: 1,
  required_down: 0,
  optional_down: 0,
  total: 1,
  required_down_names: [],
});

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studyvault-security-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function createIpcHarness({
  devServerUrl = null,
  aggregateResult = VALID_AGGREGATE,
  notificationClass = null,
  navigateNative = () => {},
} = {}) {
  const registered = new Map();
  const removed = [];
  let aggregateCalls = 0;
  const dispose = registerIpcHandlers({
    ipcMain: {
      handle(channel, handler) {
        if (registered.has(channel)) throw new Error(`Duplicate IPC handler for ${channel}`);
        registered.set(channel, handler);
      },
      removeHandler(channel) {
        removed.push(channel);
      },
    },
    app: { getVersion: () => '0.9.0', isPackaged: true },
    shell: { openPath: async () => '', openExternal: async () => {} },
    Notification: notificationClass ?? { isSupported: () => false },
    nativeFiles: {
      pickFolder: async () => null,
      pickFiles: async () => [],
      authorization: {
        listPdfs: async () => [],
        readAuthorizedFile: async () => {
          throw new Error('readAuthorizedFile must not be reached in these tests');
        },
        authorizeDroppedPdfs: async () => [],
        resolveAuthorizedOpenPath: async (target) => target,
      },
    },
    sidecars: {
      getStatus: async () => [],
      getLogs: async () => [],
      getAggregate: async () => {
        aggregateCalls += 1;
        return aggregateResult;
      },
    },
    keyStore: { set: async () => {}, get: async () => null, delete: async () => {} },
    devServerUrl,
    emitEvent: () => {},
    createPopout: async () => ({ id: 1 }),
    navigateNative,
    acknowledgeBeforeQuit: () => {},
    microphoneLease: { grant: () => Date.now() + 5000 },
  });
  return { registered, removed, dispose, calls: () => aggregateCalls };
}

function frameEvent(url) {
  const frame = { url };
  return { senderFrame: frame, sender: { mainFrame: frame } };
}

test('IPC registration covers exactly the stable allowlist and is fully reversible', () => {
  const harness = createIpcHarness();
  assert.deepEqual([...harness.registered.keys()].sort(), [...ALLOWED_INVOKE_CHANNELS].sort());
  assert.equal(harness.registered.has(IPC_CHANNELS.OPEN_EXTERNAL), true);
  harness.dispose();
  assert.deepEqual([...harness.removed].sort(), [...ALLOWED_INVOKE_CHANNELS].sort());
});

test('IPC handlers reject sub-frames, detached frames, and untrusted origins', async () => {
  const harness = createIpcHarness();
  const handler = harness.registered.get(IPC_CHANNELS.SIDECAR_AGGREGATE);

  assert.deepEqual(await handler(frameEvent(`${APP_ORIGIN}/`), undefined), VALID_AGGREGATE);
  assert.equal(harness.calls(), 1);

  const mainFrame = { url: `${APP_ORIGIN}/` };
  const subFrame = { url: `${APP_ORIGIN}/embedded` };
  await assert.rejects(
    () => handler({ senderFrame: subFrame, sender: { mainFrame } }, undefined),
    /not an authorized StudyVault main frame/,
  );
  await assert.rejects(() => handler({ senderFrame: null, sender: { mainFrame } }, undefined), /main frame/);
  await assert.rejects(() => handler({ senderFrame: undefined, sender: { mainFrame } }, undefined), /main frame/);

  for (const hostileUrl of [
    'https://evil.example/',
    'http://evil.example/',
    'file:///C:/evil.html',
    'data:text/html,<script>fetch(1)</script>',
    'app://evil/',
    `${APP_ORIGIN}:8100/`,
    `app://user:pass@studyvault/`,
  ]) {
    await assert.rejects(() => handler(frameEvent(hostileUrl), undefined), /main frame/, hostileUrl);
  }

  // No untrusted call reached the underlying implementation.
  assert.equal(harness.calls(), 1);
});

test('IPC sender trust precedes contract validation and covers both directions', async () => {
  const harness = createIpcHarness();
  const trusted = frameEvent(`${APP_ORIGIN}/`);

  const aggregate = harness.registered.get(IPC_CHANNELS.SIDECAR_AGGREGATE);
  await assert.rejects(() => aggregate(trusted, { unexpected: true }), ContractError);
  assert.equal(harness.calls(), 0, 'request validation must run before the handler body');

  const read = harness.registered.get(IPC_CHANNELS.FILES_READ);
  await assert.rejects(() => read(trusted, { path: 'case.pdf', extra: true }), /not allowed/);
  await assert.rejects(() => read(trusted, { path: 1 }), ContractError);
  // A hostile sender fails on identity, never on the (well-formed) payload.
  await assert.rejects(() => read(frameEvent('https://evil.example/'), { path: 'case.pdf' }), /main frame/);

  const invalid = createIpcHarness({ aggregateResult: { status: 'ok' } });
  await assert.rejects(
    () => invalid.registered.get(IPC_CHANNELS.SIDECAR_AGGREGATE)(trusted, undefined),
    ContractError,
    'responses must be validated on the way out',
  );
});

test('IPC sender trust follows the configured dev server origin exactly', async () => {
  const harness = createIpcHarness({ devServerUrl: 'http://127.0.0.1:5173' });
  const handler = harness.registered.get(IPC_CHANNELS.SIDECAR_AGGREGATE);

  await handler(frameEvent('http://127.0.0.1:5173/lsat'), undefined);
  await handler(frameEvent(`${APP_ORIGIN}/lsat`), undefined);
  assert.equal(harness.calls(), 2);

  for (const hostileUrl of [
    'http://localhost:5173/lsat',
    'http://127.0.0.1:5174/lsat',
    'https://127.0.0.1:5173/lsat',
    'http://127.0.0.1:5173@evil.example/',
    'http://[::1]:5173/lsat',
  ]) {
    await assert.rejects(() => handler(frameEvent(hostileUrl), undefined), /main frame/, hostileUrl);
  }
  assert.equal(harness.calls(), 2);
});

test('microphone lease IPC requires a live renderer user activation', async () => {
  const harness = createIpcHarness();
  const handler = harness.registered.get(IPC_CHANNELS.MICROPHONE_LEASE);
  const frame = { url: `${APP_ORIGIN}/` };
  const executeCalls = [];
  const event = {
    senderFrame: frame,
    sender: {
      id: 42,
      mainFrame: frame,
      executeJavaScript: async (...args) => {
        executeCalls.push(args);
        return true;
      },
    },
  };
  const granted = await handler(event, undefined);
  assert.equal(typeof granted.expiresAt, 'number');
  assert.deepEqual(executeCalls, [['navigator.userActivation?.isActive === true']]);
  assert.equal(executeCalls[0][1], undefined, 'executeJavaScript must not synthesize a user gesture');
  event.sender.executeJavaScript = async () => false;
  await assert.rejects(() => handler(event, undefined), /active user gesture/);
});

test('notification clicks route once and outstanding notifications close on disposal', async () => {
  const instances = [];
  class FakeNotification {
    static isSupported() { return true; }
    constructor(options) {
      this.options = options;
      this.listeners = new Map();
      this.closed = false;
      instances.push(this);
    }
    once(event, listener) { this.listeners.set(event, listener); }
    show() {}
    close() { this.closed = true; this.listeners.get('close')?.(); }
    emit(event) { const listener = this.listeners.get(event); this.listeners.delete(event); listener?.(); }
  }
  const navigations = [];
  const harness = createIpcHarness({
    notificationClass: FakeNotification,
    navigateNative: (...args) => navigations.push(args),
  });
  const handler = harness.registered.get(IPC_CHANNELS.NOTIFICATION);
  assert.deepEqual(await handler(frameEvent(`${APP_ORIGIN}/`), { title: 'Review due', body: 'One item', route: '/review' }), { shown: true });
  instances[0].emit('click');
  instances[0].emit('click');
  assert.deepEqual(navigations, [['/review', 'notification']]);
  await handler(frameEvent(`${APP_ORIGIN}/`), { title: 'Saved', body: 'Ready' });
  harness.dispose();
  assert.equal(instances[1].closed, true);
});

test('structured logs redact sensitive keys and bound their own size', async (t) => {
  const root = await temporaryDirectory(t);
  const logDirectory = path.join(root, 'nested', 'logs');
  const logger = new JsonLogger(logDirectory);

  logger.info('sidecar_launch', {
    LSATLAB_LOCAL_API_TOKEN: 'a'.repeat(64),
    Authorization: 'Bearer top-secret-value',
    db_key_b64: 'kkkk',
    userPassword: 'hunter2',
    session_cookie: 'sid=1',
    api_credential: 'c',
    service: 'lsat-backend',
    port: 8100,
    healthy: true,
    nothing: null,
    env: { LSATLAB_DB_KEY_B64: 'nested-secret-value', name: 'ok' },
  });

  const raw = await readFile(logger.mainLog, 'utf8');
  const [record] = raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

  assert.equal(record.level, 'info');
  assert.equal(record.event, 'sidecar_launch');
  assert.equal(record.pid, process.pid);
  assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  for (const key of [
    'LSATLAB_LOCAL_API_TOKEN',
    'Authorization',
    'db_key_b64',
    'userPassword',
    'session_cookie',
    'api_credential',
  ]) {
    assert.equal(record.details[key], '[redacted]', key);
  }
  assert.equal(record.details.env.LSATLAB_DB_KEY_B64, '[redacted]');
  // Non-sensitive values survive verbatim, so redaction is not just blanking everything.
  assert.equal(record.details.service, 'lsat-backend');
  assert.equal(record.details.port, 8100);
  assert.equal(record.details.healthy, true);
  assert.equal(record.details.nothing, null);
  assert.equal(record.details.env.name, 'ok');
  for (const leaked of ['top-secret-value', 'nested-secret-value', 'hunter2', 'a'.repeat(64)]) {
    assert.equal(raw.includes(leaked), false, `log leaked ${leaked}`);
  }

  logger.warn('bounded', {
    deep: { b: { c: { d: { e: 'unreachable-leaf' } } } },
    long: 'z'.repeat(20_000),
    many: Array.from({ length: 150 }, (_, index) => index),
  });
  const bounded = JSON.parse((await readFile(logger.mainLog, 'utf8')).trim().split('\n')[1]);
  assert.equal(bounded.details.deep.b.c.d.e, '[truncated]');
  assert.equal(bounded.details.long.length, 16_384);
  assert.equal(bounded.details.many.length, 100);
});

test('logged Error values keep name, message, and stack without becoming empty objects', async (t) => {
  const root = await temporaryDirectory(t);
  const logger = new JsonLogger(root);
  const failure = new TypeError('sidecar handshake failed');

  logger.error('sidecar_failed', { error: failure, attempt: 3 });
  const record = JSON.parse((await readFile(logger.mainLog, 'utf8')).trim());

  assert.equal(record.details.error.name, 'TypeError');
  assert.equal(record.details.error.message, 'sidecar handshake failed');
  assert.equal(typeof record.details.error.stack, 'string');
  assert.match(record.details.error.stack, /TypeError: sidecar handshake failed/);
  assert.equal(record.details.attempt, 3);
});

test('crash records land in a separate file and never in the main log', async (t) => {
  const root = await temporaryDirectory(t);
  const logger = new JsonLogger(root);

  logger.info('boot', {});
  logger.crash('uncaught_exception', { error: new RangeError('fatal boom'), token: 'crash-secret' });

  assert.notEqual(logger.crashLog, logger.mainLog);
  const main = await readFile(logger.mainLog, 'utf8');
  assert.equal(main.includes('uncaught_exception'), false);
  assert.equal(main.includes('crash-secret'), false);

  const crash = JSON.parse((await readFile(logger.crashLog, 'utf8')).trim());
  assert.equal(crash.level, 'fatal');
  assert.equal(crash.event, 'uncaught_exception');
  assert.equal(crash.details.error.name, 'RangeError');
  assert.equal(crash.details.token, '[redacted]');
});

test('log files are created owner-only on POSIX hosts', async (t) => {
  if (process.platform === 'win32') {
    t.diagnostic('POSIX file modes are not enforced on Windows');
    return;
  }
  const root = await temporaryDirectory(t);
  const logger = new JsonLogger(root);
  logger.info('boot', {});
  logger.crash('boom', {});
  assert.equal((await stat(logger.mainLog)).mode & 0o777, 0o600);
  assert.equal((await stat(logger.crashLog)).mode & 0o777, 0o600);
});

test('sidecar identity probe trusts only a matching JSON identity on loopback', async (t) => {
  const identity = { path: '/api/health', service: 'lsat-backend' };
  const server = createServer((request, response) => {
    request.on('error', () => {});
    response.on('error', () => {});
    const route = request.url;
    if (route === '/hang') return;
    if (route === '/error') {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, service: 'lsat-backend' }));
      return;
    }
    if (route === '/html') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html><body>not a StudyVault sidecar</body></html>');
      return;
    }
    if (route === '/huge') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(`{"ok":true,"service":"lsat-backend","pad":"${'x'.repeat(70_000)}"}`);
      return;
    }
    const bodies = {
      '/api/health': { ok: true, service: 'lsat-backend' },
      '/foreign': { ok: true, service: 'open-notebook-api' },
      '/notok': { ok: false, service: 'lsat-backend' },
      '/array': [{ ok: true, service: 'lsat-backend' }],
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(bodies[route] ?? null));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });

  assert.equal(await probeHttpServiceIdentity(identity, port), true);
  assert.equal(await probeHttpServiceIdentity({ ...identity, path: '/foreign' }, port), false);
  assert.equal(await probeHttpServiceIdentity({ ...identity, path: '/notok' }, port), false);
  assert.equal(await probeHttpServiceIdentity({ ...identity, path: '/array' }, port), false);
  assert.equal(await probeHttpServiceIdentity({ ...identity, path: '/html' }, port), false);
  assert.equal(await probeHttpServiceIdentity({ ...identity, path: '/error' }, port), false);
  assert.equal(await probeHttpServiceIdentity({ ...identity, path: '/huge' }, port), false);
  assert.equal(await probeHttpServiceIdentity({ ...identity, path: '/hang' }, port, 250), false);
  // A service answering correctly but under a different name is still foreign.
  assert.equal(await probeHttpServiceIdentity({ path: '/api/health', service: 'open-notebook-api' }, port), false);
});

test('sidecar identity probe reports false for a refused connection', async () => {
  const idle = createServer();
  idle.listen(0, '127.0.0.1');
  await once(idle, 'listening');
  const closedPort = idle.address().port;
  await new Promise((resolve) => idle.close(resolve));
  assert.equal(
    await probeHttpServiceIdentity({ path: '/api/health', service: 'lsat-backend' }, closedPort, 1000),
    false,
  );
});

test('renderer URL policy admits only the bare app origin', () => {
  assert.equal(isSafeRendererUrl(`${APP_ORIGIN}/`), true);
  assert.equal(isSafeRendererUrl(`${APP_ORIGIN}/lsat/practice?set=1#q3`), true);

  for (const rejected of [
    `${APP_ORIGIN}:8100/`,
    'app://user:pass@studyvault/',
    'app://:secret@studyvault/',
    'app://studyvault.evil.example/',
    'app://evil/',
    'app:///index.html',
    'http://studyvault/',
    'https://studyvault/',
    'https://example.com/lsat',
    'file:///C:/Windows/System32/drivers/etc/hosts',
    'file:///etc/passwd',
    'javascript:alert(document.domain)',
    'data:text/html,<script>alert(1)</script>',
    'blob:app://studyvault/1234',
    'http://127.0.0.1:5173/lsat',
    'not a url',
    '',
  ]) {
    assert.equal(isSafeRendererUrl(rejected), false, rejected);
  }
  assert.equal(isSafeRendererUrl(null), false);
  assert.equal(isSafeRendererUrl(undefined), false);
});

test('session egress policy permits app assets and loopback services only', () => {
  for (const url of [
    `${APP_ORIGIN}/assets/app.js`,
    'data:image/png;base64,AA==',
    'blob:app://studyvault/id',
    'http://127.0.0.1:8100/api/health',
    'http://localhost:1234/v1/models',
    'ws://127.0.0.1:5055/events',
    'http://[::1]:11434/api/tags',
  ]) assert.equal(isAllowedSessionRequest(url), true, url);
  for (const url of [
    'https://example.com/content',
    'wss://example.com/socket',
    'http://192.168.1.4:8100/api',
    'file:///etc/passwd',
    'ftp://127.0.0.1/file',
    'http://user:pass@127.0.0.1:8100/api',
  ]) assert.equal(isAllowedSessionRequest(url), false, url);
  assert.equal(isAllowedSessionRequest('/relative'), false);
});

test('popout normalization cannot escape the app origin', () => {
  assert.equal(normalizePopoutUrl('/lsat/practice', null), `${APP_ORIGIN}/lsat/practice`);
  assert.equal(normalizePopoutUrl('lsat', null), `${APP_ORIGIN}/lsat`);
  // Traversal is resolved away rather than escaping the origin.
  assert.equal(normalizePopoutUrl('/../../etc/passwd', null).startsWith(`${APP_ORIGIN}/`), true);

  for (const escape of [
    '//evil.example/x',
    'https://evil.example/x',
    'http://127.0.0.1:5173/x',
    'app://evil/x',
    'app://studyvault:8100/x',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
  ]) {
    assert.throws(() => normalizePopoutUrl(escape, null), /inside the StudyVault application/, escape);
  }

  for (const invalid of ['', 'x'.repeat(2049), null, undefined, 42, {}, ['/lsat']]) {
    assert.throws(() => normalizePopoutUrl(invalid, null), /Popout route is invalid/);
  }

  // The dev-server base must not become a bypass either.
  assert.equal(normalizePopoutUrl('/lsat', 'http://127.0.0.1:5173'), 'http://127.0.0.1:5173/lsat');
  assert.throws(() => normalizePopoutUrl('//evil.example/x', 'http://127.0.0.1:5173'), /inside/);
  assert.throws(() => normalizePopoutUrl('/lsat', 'https://example.com'), /loopback/);
});

test('permission policy denies everything except main-frame clipboard writes and leased audio', () => {
  const trusted = { requestingUrl: `${APP_ORIGIN}/`, isMainFrame: true, mediaTypes: [], microphoneLeaseValid: true };

  assert.equal(isAllowedPermission({ ...trusted, permission: 'clipboard-sanitized-write' }), true);
  assert.equal(isAllowedPermission({ ...trusted, permission: 'media', mediaTypes: ['audio'] }), true);
  assert.equal(isAllowedPermission({ ...trusted, permission: 'media', mediaTypes: ['audio', 'audio'] }), true);
  assert.equal(isAllowedPermission({ ...trusted, microphoneLeaseValid: false, permission: 'media', mediaTypes: ['audio'] }), false);

  for (const permission of [
    'media',
    'geolocation',
    'notifications',
    'midi',
    'midiSysex',
    'pointerLock',
    'fullscreen',
    'openExternal',
    'clipboard-read',
    'display-capture',
    'serial',
    'hid',
    'usb',
    'idle-detection',
    'window-management',
    'background-sync',
    'unknown-future-permission',
  ]) {
    assert.equal(isAllowedPermission({ ...trusted, permission }), false, permission);
  }
  for (const mediaTypes of [['video'], ['audio', 'video'], ['video', 'audio'], []]) {
    assert.equal(isAllowedPermission({ ...trusted, permission: 'media', mediaTypes }), false, mediaTypes.join('+'));
  }

  // Sub-frames are denied even for the two otherwise-allowed cases.
  const subFrame = { ...trusted, isMainFrame: false };
  assert.equal(isAllowedPermission({ ...subFrame, permission: 'clipboard-sanitized-write' }), false);
  assert.equal(isAllowedPermission({ ...subFrame, permission: 'media', mediaTypes: ['audio'] }), false);

  // Untrusted requesting URLs are denied even from a main frame.
  for (const requestingUrl of [
    'https://example.com/',
    'file:///etc/passwd',
    'app://evil/',
    `${APP_ORIGIN}:8100/`,
    'javascript:alert(1)',
    '',
  ]) {
    assert.equal(
      isAllowedPermission({ ...trusted, requestingUrl, permission: 'media', mediaTypes: ['audio'] }),
      false,
      requestingUrl,
    );
    assert.equal(
      isAllowedPermission({ ...trusted, requestingUrl, permission: 'clipboard-sanitized-write' }),
      false,
      requestingUrl,
    );
  }
});

test('microphone permission leases are renderer-bound, short-lived, and one-shot', () => {
  let now = 1000;
  const leases = new MicrophonePermissionLease({ ttlMs: 5000, now: () => now });
  assert.equal(leases.grant(42), 6000);
  assert.equal(leases.valid(41), false);
  assert.equal(leases.valid(42), true);
  assert.equal(leases.consume(42), true);
  assert.equal(leases.consume(42), false);
  leases.grant(42);
  now = 6001;
  assert.equal(leases.consume(42), false);
  assert.throws(() => leases.grant(0), /Invalid webContents/);
});

test('every allow-listed invoke channel has both a request and a response contract', () => {
  const hasContract = (validate, channel) => {
    try {
      validate(channel, undefined);
      return true;
    } catch (error) {
      return !/is not allowed:/.test(error.message);
    }
  };
  for (const channel of ALLOWED_INVOKE_CHANNELS) {
    assert.equal(hasContract(validateRequest, channel), true, `${channel} request contract`);
    assert.equal(hasContract(validateResponse, channel), true, `${channel} response contract`);
  }
  assert.equal(hasContract(validateRequest, 'studyvault:evil:channel'), false);
  assert.equal(hasContract(validateResponse, 'studyvault:evil:channel'), false);
});

test('preload exposes an exact frozen surface with no arbitrary-channel passthrough', () => {
  const argument = `--studyvault-ipc=${encodeURIComponent(JSON.stringify({ CHANNELS: IPC_CHANNELS, EVENTS: IPC_EVENTS }))}`;
  process.argv.push(argument);
  globalThis.window = {
    addEventListener(type, listener, capture) {
      windowListeners.push({ type, listener, capture });
    },
  };
  try {
    require('../preload.cjs');
  } finally {
    process.argv.splice(process.argv.indexOf(argument), 1);
    delete globalThis.window;
  }

  assert.equal(bridgeExposures.length, 1);
  const [key, api] = bridgeExposures[0];
  assert.equal(key, 'studyvault');
  assert.equal(Object.isFrozen(api), true);
  assert.deepEqual(
    windowListeners.map(({ type, capture }) => ({ type, capture })),
    [{ type: 'drop', capture: true }],
  );

  const paths = [];
  const walk = (value, prefix) => {
    for (const [name, entry] of Object.entries(value)) {
      const full = prefix ? `${prefix}.${name}` : name;
      if (typeof entry === 'function') {
        paths.push(full);
      } else {
        assert.equal(Object.isFrozen(entry), true, `${full} namespace must be frozen`);
        walk(entry, full);
      }
    }
  };
  walk(api, '');
  assert.deepEqual(paths.sort(), [
    'events.onBeforeQuit',
    'events.onBootStatus',
    'events.onLifecycle',
    'events.onNativeNavigate',
    'events.onOpenFile',
    'events.onPdfDrop',
    'events.onSecondInstance',
    'events.onSidebarToggle',
    'files.listPdfs',
    'files.pickFiles',
    'files.pickFolder',
    'files.read',
    'fullscreen.get',
    'fullscreen.set',
    'keychain.delete',
    'keychain.get',
    'keychain.set',
    'lifecycle.acknowledgeBeforeQuit',
    'notification',
    'openExternal',
    'openPath',
    'permissions.requestMicrophoneLease',
    'popout',
    'runtime.info',
    'sidecar.aggregate',
    'sidecar.logs',
    'sidecar.status',
  ]);

  // Drive every exposed function with a hostile channel-shaped argument. A
  // generic passthrough would surface it as the invoke/subscribe channel.
  const POISON = 'studyvault:evil:channel';
  const resolve = (root, dotted) => dotted.split('.').reduce((value, name) => value[name], root);
  for (const dotted of paths) {
    try {
      const result = resolve(api, dotted)(POISON, POISON);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Argument-shape rejections (e.g. non-function event listeners) are fine.
    }
  }

  // Event subscriptions are likewise pinned to declared channels: passing a
  // channel-shaped string as the "listener" must never become the channel.
  for (const dotted of paths.filter((entry) => entry.startsWith('events.'))) {
    resolve(api, dotted)(() => {});
  }
  assert.deepEqual([...new Set(subscribeCalls.map(([channel]) => channel))].sort(), [...ALLOWED_EVENT_CHANNELS].sort());

  const declared = new Set(Object.values(IPC_CHANNELS));
  const invokedChannels = [...new Set(invokeCalls.map(([channel]) => channel))];
  assert.equal(invokedChannels.length, paths.length - ALLOWED_EVENT_CHANNELS.length);
  for (const channel of invokedChannels) {
    assert.equal(declared.has(channel), true, `undeclared invoke channel ${channel}`);
  }
  assert.equal(
    invokeCalls.some(([channel]) => channel === POISON) || subscribeCalls.some(([channel]) => channel === POISON),
    false,
    'no exposed function may take a caller-supplied channel',
  );

  const unhandled = invokedChannels.filter((channel) => !ALLOWED_INVOKE_CHANNELS.includes(channel));
  assert.deepEqual(unhandled, [], `preload invokes channels with no main-process contract: ${unhandled.join(', ')}`);
});

test('preload event subscriptions hide the IPC event object and unsubscribe cleanly', () => {
  const [, api] = bridgeExposures[0];
  const before = subscribeCalls.length;
  const received = [];
  const unsubscribe = api.events.onBootStatus((...args) => received.push(args));

  const [channel, wrapped] = subscribeCalls[before];
  assert.equal(channel, IPC_EVENTS.BOOT_STATUS);
  wrapped({ sender: 'main-process-webcontents', senderFrame: 'frame' }, { status: 'ok' });
  // Exactly one argument: the IpcRendererEvent (and therefore its sender handle)
  // must never be handed to renderer-supplied listeners.
  assert.deepEqual(received, [[{ status: 'ok' }]]);

  const removedBefore = unsubscribeCalls.length;
  unsubscribe();
  assert.deepEqual(unsubscribeCalls[removedBefore], [IPC_EVENTS.BOOT_STATUS, wrapped]);
  assert.throws(() => api.events.onPdfDrop('not-a-function'), TypeError);
});

test('preload drop handling forwards only PDF paths to the authorization channel', () => {
  // The capturing 'drop' listener was registered when preload.cjs was required.
  const { listener: dropListener } = windowListeners.find((entry) => entry.type === 'drop');
  assert.equal(typeof dropListener, 'function');

  const before = invokeCalls.length;
  let prevented = 0;
  dropListener({
    preventDefault: () => {
      prevented += 1;
    },
    dataTransfer: { files: [{ path: 'C:\\vault\\case.PDF' }, { path: 'C:\\vault\\payload.exe' }, { path: null }] },
  });
  assert.equal(prevented, 1);
  assert.deepEqual(invokeCalls[before], [IPC_CHANNELS.FILES_AUTHORIZE_DROP, { paths: ['C:\\vault\\case.PDF'] }]);

  // A drop with no PDFs must not reach the main process at all.
  const afterPdf = invokeCalls.length;
  dropListener({
    preventDefault: () => {
      prevented += 1;
    },
    dataTransfer: { files: [{ path: 'C:\\vault\\payload.exe' }] },
  });
  assert.equal(invokeCalls.length, afterPdf);
  dropListener({ preventDefault: () => {}, dataTransfer: { files: [] } });
  assert.equal(invokeCalls.length, afterPdf);
});
