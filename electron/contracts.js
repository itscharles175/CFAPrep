import channelsModule from './channels.cjs';

const { CHANNELS, EVENTS } = channelsModule;

export class ContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContractError';
  }
}

function fail(path, expected) {
  throw new ContractError(`${path} must be ${expected}`);
}

function exactObject(value, path, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'an object');
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ContractError(`${path}.${key} is not allowed`);
    }
  }
  return value;
}

function stringValue(value, path, { min = 0, max = 4096, pattern } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    fail(path, `a string between ${min} and ${max} characters`);
  }
  if (pattern && !pattern.test(value)) {
    fail(path, `a string matching ${pattern}`);
  }
  return value;
}

function finiteInteger(value, path, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(path, `an integer between ${min} and ${max}`);
  }
  return value;
}

function booleanValue(value, path) {
  if (typeof value !== 'boolean') {
    fail(path, 'a boolean');
  }
  return value;
}

function nullable(value, parser) {
  return value === null ? null : parser(value);
}

function arrayValue(value, path, parser, max = 100_000) {
  if (!Array.isArray(value) || value.length > max) {
    fail(path, `an array with at most ${max} entries`);
  }
  return value.map((entry, index) => parser(entry, `${path}[${index}]`));
}

function noPayload(value) {
  if (value !== undefined && value !== null) {
    fail('payload', 'empty');
  }
  return undefined;
}

function pathPayload(value) {
  const object = exactObject(value, 'payload', ['path']);
  return { path: stringValue(object.path, 'payload.path', { min: 1, max: 32_768 }) };
}

function nativeRoute(value, routePath = 'payload.route') {
  const route = stringValue(value, routePath, { min: 1, max: 2048 });
  if (!route.startsWith('/') || route.startsWith('//') || route.includes('\\')) fail(routePath, 'an in-app route');
  let url;
  try {
    url = new URL(route, 'app://studyvault');
  } catch {
    fail(routePath, 'an in-app route');
  }
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    fail(routePath, 'an in-app route');
  }
  if (url.protocol !== 'app:' || url.hostname !== 'studyvault' || decodedPath.split('/').includes('..')) {
    fail(routePath, 'an in-app route');
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function fileDescriptor(value, path = 'result') {
  const object = exactObject(value, path, ['path', 'name', 'extension', 'size']);
  return {
    path: stringValue(object.path, `${path}.path`, { min: 1, max: 32_768 }),
    name: stringValue(object.name, `${path}.name`, { min: 1, max: 1024 }),
    extension: stringValue(object.extension, `${path}.extension`, {
      min: 4,
      max: 4,
      pattern: /^\.(pdf|txt)$/,
    }),
    size: finiteInteger(object.size, `${path}.size`, 0, Number.MAX_SAFE_INTEGER),
  };
}

const PDF_LISTING_MAX_ROWS = 100_000;

function pdfEntry(value, path = 'result') {
  const object = exactObject(value, path, ['path', 'relative_path', 'name', 'extension', 'size']);
  return {
    path: stringValue(object.path, `${path}.path`, { min: 1, max: 32_768 }),
    relative_path: stringValue(object.relative_path, `${path}.relative_path`, {
      min: 1,
      max: 32_768,
    }),
    name: stringValue(object.name, `${path}.name`, { min: 1, max: 1024 }),
    extension: stringValue(object.extension, `${path}.extension`, {
      min: 4,
      max: 4,
      pattern: /^\.pdf$/,
    }),
    // Metadata only. Bounding this at the 50 MiB read cap made one large PDF
    // reject the entire folder listing; the read cap lives in readResult.
    size: finiteInteger(object.size, `${path}.size`, 0, Number.MAX_SAFE_INTEGER),
  };
}

function pdfListing(value) {
  const rows = arrayValue(value, 'result', pdfEntry, PDF_LISTING_MAX_ROWS);
  // Skip counters ride on the rows array (see PathAuthorization#listPdfs), so they
  // are validated and carried over without changing the listing's array shape.
  const counter = (key) =>
    finiteInteger(value[key] === undefined ? 0 : value[key], `result.${key}`, 0, PDF_LISTING_MAX_ROWS);
  return Object.assign(rows, {
    skipped_links: counter('skipped_links'),
    skipped_oversize: counter('skipped_oversize'),
    skipped_errors: counter('skipped_errors'),
  });
}

function readResult(value) {
  const object = exactObject(value, 'result', ['path', 'name', 'extension', 'size', 'data']);
  const descriptor = fileDescriptor(
    {
      path: object.path,
      name: object.name,
      extension: object.extension,
      size: object.size,
    },
    'result',
  );
  if (!(object.data instanceof Uint8Array) || object.data.byteLength !== descriptor.size) {
    fail('result.data', 'a Uint8Array matching result.size');
  }
  if (descriptor.size > 50 * 1024 * 1024) fail('result.size', 'at most 50 MiB');
  return { ...descriptor, data: object.data };
}

function sidecarStatus(value, path = 'result') {
  const keys = [
    'name',
    'port',
    'ready_port',
    'healthy',
    'ready',
    'depends_on',
    'pid',
    'optional',
    'present',
    'blocked',
    'block_reason',
    'provenance_status',
    'state',
    'restart_count',
  ];
  const object = exactObject(value, path, keys);
  const portParser = (entry, entryPath) => finiteInteger(entry, entryPath, 1, 65_535);
  return {
    name: stringValue(object.name, `${path}.name`, { min: 1, max: 128 }),
    port: nullable(object.port, (entry) => portParser(entry, `${path}.port`)),
    ready_port: nullable(object.ready_port, (entry) => portParser(entry, `${path}.ready_port`)),
    healthy: booleanValue(object.healthy, `${path}.healthy`),
    ready: booleanValue(object.ready, `${path}.ready`),
    depends_on: arrayValue(
      object.depends_on,
      `${path}.depends_on`,
      (entry, entryPath) => stringValue(entry, entryPath, { min: 1, max: 128 }),
      16,
    ),
    pid: nullable(object.pid, (entry) => finiteInteger(entry, `${path}.pid`, 1, 2 ** 31 - 1)),
    optional: booleanValue(object.optional, `${path}.optional`),
    present: booleanValue(object.present, `${path}.present`),
    blocked: booleanValue(object.blocked, `${path}.blocked`),
    block_reason: nullable(object.block_reason, (entry) =>
      stringValue(entry, `${path}.block_reason`, { min: 1, max: 2048 }),
    ),
    provenance_status: nullable(object.provenance_status, (entry) =>
      stringValue(entry, `${path}.provenance_status`, { min: 1, max: 64 }),
    ),
    state: stringValue(object.state, `${path}.state`, {
      min: 2,
      max: 32,
      pattern: /^(pending|starting|ready|degraded|stopped|exited|skipped|blocked|backoff)$/,
    }),
    restart_count: finiteInteger(object.restart_count, `${path}.restart_count`, 0, 1000),
  };
}

function aggregate(value, path = 'result') {
  const object = exactObject(value, path, [
    'status',
    'ready',
    'required_down',
    'optional_down',
    'total',
    'required_down_names',
  ]);
  return {
    status: stringValue(object.status, `${path}.status`, {
      min: 2,
      max: 8,
      pattern: /^(ok|degraded|error)$/,
    }),
    ready: finiteInteger(object.ready, `${path}.ready`, 0, 100),
    required_down: finiteInteger(object.required_down, `${path}.required_down`, 0, 100),
    optional_down: finiteInteger(object.optional_down, `${path}.optional_down`, 0, 100),
    total: finiteInteger(object.total, `${path}.total`, 0, 100),
    required_down_names: arrayValue(
      object.required_down_names,
      `${path}.required_down_names`,
      (entry, entryPath) => stringValue(entry, entryPath, { min: 1, max: 128 }),
      100,
    ),
  };
}

function bootStatus(value, path = 'event') {
  const object = exactObject(value, path, [
    'status',
    'launched',
    'skipped',
    'blocked',
    'skipped_names',
    'blocked_names',
    'required_down_names',
    'degraded_reason',
  ]);
  const names = (entry, entryPath) =>
    arrayValue(entry, entryPath, (name, namePath) => stringValue(name, namePath, { min: 1, max: 128 }), 100);
  return {
    status: stringValue(object.status, `${path}.status`, {
      min: 2,
      max: 8,
      pattern: /^(ok|degraded|error)$/,
    }),
    launched: finiteInteger(object.launched, `${path}.launched`, 0, 100),
    skipped: finiteInteger(object.skipped, `${path}.skipped`, 0, 100),
    blocked: finiteInteger(object.blocked, `${path}.blocked`, 0, 100),
    skipped_names: names(object.skipped_names, `${path}.skipped_names`),
    blocked_names: names(object.blocked_names, `${path}.blocked_names`),
    required_down_names: names(object.required_down_names, `${path}.required_down_names`),
    degraded_reason: stringValue(object.degraded_reason, `${path}.degraded_reason`, { max: 2048 }),
  };
}

function launchEvent(value, path = 'event') {
  const object = exactObject(value, path, ['argv', 'cwd', 'paths']);
  return {
    argv: arrayValue(
      object.argv,
      `${path}.argv`,
      (entry, entryPath) => stringValue(entry, entryPath, { max: 32_768 }),
      256,
    ),
    cwd: stringValue(object.cwd, `${path}.cwd`, { max: 32_768 }),
    paths: arrayValue(
      object.paths,
      `${path}.paths`,
      (entry, entryPath) => stringValue(entry, entryPath, { min: 1, max: 32_768 }),
      256,
    ),
  };
}

function pathEvent(value, path = 'event') {
  const object = exactObject(value, path, ['paths']);
  return {
    paths: arrayValue(
      object.paths,
      `${path}.paths`,
      (entry, entryPath) => stringValue(entry, entryPath, { min: 1, max: 32_768 }),
      256,
    ),
  };
}

function lifecycleEvent(value, path = 'event') {
  const object = exactObject(value, path, ['state', 'at']);
  return {
    state: stringValue(object.state, `${path}.state`, { min: 4, max: 7, pattern: /^(suspend|resume|lock|unlock)$/ }),
    at: finiteInteger(object.at, `${path}.at`, 0, Number.MAX_SAFE_INTEGER),
  };
}

function nativeNavigationEvent(value, path = 'event') {
  const object = exactObject(value, path, ['route', 'source']);
  return {
    route: nativeRoute(object.route, `${path}.route`),
    source: stringValue(object.source, `${path}.source`, {
      min: 4,
      max: 12,
      pattern: /^(menu|dock|notification|deep-link)$/,
    }),
  };
}

function sidebarToggleEvent(value, path = 'event') {
  const object = exactObject(value, path, ['visible']);
  return { visible: booleanValue(object.visible, `${path}.visible`) };
}

function beforeQuitEvent(value, path = 'event') {
  const object = exactObject(value, path, ['requestId', 'at']);
  return {
    requestId: stringValue(object.requestId, `${path}.requestId`, { min: 36, max: 36, pattern: /^[0-9a-f-]{36}$/i }),
    at: finiteInteger(object.at, `${path}.at`, 0, Number.MAX_SAFE_INTEGER),
  };
}

function runtimeInfo(value) {
  const object = exactObject(value, 'result', [
    'app_version',
    'electron_version',
    'chrome_version',
    'node_version',
    'platform',
    'arch',
    'is_packaged',
    'native_shell',
    'release_tier',
  ]);
  return {
    app_version: stringValue(object.app_version, 'result.app_version', { min: 1, max: 64 }),
    electron_version: stringValue(object.electron_version, 'result.electron_version', {
      min: 1,
      max: 64,
    }),
    chrome_version: stringValue(object.chrome_version, 'result.chrome_version', {
      min: 1,
      max: 64,
    }),
    node_version: stringValue(object.node_version, 'result.node_version', { min: 1, max: 64 }),
    platform: stringValue(object.platform, 'result.platform', {
      min: 3,
      max: 16,
      pattern: /^(win32|darwin|linux)$/,
    }),
    arch: stringValue(object.arch, 'result.arch', { min: 3, max: 16 }),
    is_packaged: booleanValue(object.is_packaged, 'result.is_packaged'),
    native_shell: stringValue(object.native_shell, 'result.native_shell', { pattern: /^macos-unified$/ }),
    release_tier: stringValue(object.release_tier, 'result.release_tier', { pattern: /^personal$/ }),
  };
}

function okResult(value) {
  const object = exactObject(value, 'result', ['ok']);
  if (object.ok !== true) {
    fail('result.ok', 'true');
  }
  return { ok: true };
}

function openedResult(value) {
  const object = exactObject(value, 'result', ['opened', 'error']);
  return {
    opened: booleanValue(object.opened, 'result.opened'),
    error: stringValue(object.error, 'result.error', { max: 2048 }),
  };
}

const requestContracts = new Map([
  [CHANNELS.RUNTIME_INFO, noPayload],
  [CHANNELS.MICROPHONE_LEASE, noPayload],
  [CHANNELS.FILES_PICK_FOLDER, noPayload],
  [CHANNELS.FILES_PICK_FILES, noPayload],
  [
    CHANNELS.FILES_LIST_PDFS,
    (value) => {
      const object = exactObject(value, 'payload', ['root']);
      return { root: stringValue(object.root, 'payload.root', { min: 1, max: 32_768 }) };
    },
  ],
  [CHANNELS.FILES_READ, pathPayload],
  [
    CHANNELS.FILES_AUTHORIZE_DROP,
    (value) => {
      const object = exactObject(value, 'payload', ['paths']);
      return {
        paths: arrayValue(
          object.paths,
          'payload.paths',
          (entry, path) => stringValue(entry, path, { min: 1, max: 32_768 }),
          256,
        ),
      };
    },
  ],
  [CHANNELS.SIDECAR_STATUS, noPayload],
  [
    CHANNELS.SIDECAR_LOGS,
    (value) => {
      const object = exactObject(value, 'payload', ['name']);
      return { name: stringValue(object.name, 'payload.name', { min: 1, max: 128 }) };
    },
  ],
  [CHANNELS.SIDECAR_AGGREGATE, noPayload],
  [
    CHANNELS.KEYCHAIN_SET,
    (value) => {
      const object = exactObject(value, 'payload', ['secret']);
      return { secret: stringValue(object.secret, 'payload.secret', { min: 1, max: 8192 }) };
    },
  ],
  [CHANNELS.KEYCHAIN_GET, noPayload],
  [CHANNELS.KEYCHAIN_DELETE, noPayload],
  [CHANNELS.OPEN_PATH, pathPayload],
  [
    CHANNELS.OPEN_EXTERNAL,
    (value) => {
      const object = exactObject(value, 'payload', ['url']);
      const url = stringValue(object.url, 'payload.url', { min: 1, max: 8192 });
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        fail('payload.url', 'an HTTPS URL');
      }
      if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
        fail('payload.url', 'an HTTPS URL');
      }
      return { url: parsed.toString() };
    },
  ],
  [
    CHANNELS.POPOUT,
    (value) => {
      const object = exactObject(value, 'payload', ['route', 'title', 'width', 'height']);
      return {
        route: stringValue(object.route, 'payload.route', { min: 1, max: 2048 }),
        title:
          object.title === undefined ? 'StudyVault' : stringValue(object.title, 'payload.title', { min: 1, max: 128 }),
        width: object.width === undefined ? 960 : finiteInteger(object.width, 'payload.width', 480, 3840),
        height: object.height === undefined ? 720 : finiteInteger(object.height, 'payload.height', 360, 2160),
      };
    },
  ],
  [
    CHANNELS.NOTIFICATION,
    (value) => {
      const object = exactObject(value, 'payload', ['title', 'body', 'route']);
      return {
        title: stringValue(object.title, 'payload.title', { min: 1, max: 128 }),
        body: stringValue(object.body, 'payload.body', { max: 1024 }),
        ...(object.route === undefined ? {} : { route: nativeRoute(object.route) }),
      };
    },
  ],
  [CHANNELS.FULLSCREEN_GET, noPayload],
  [
    CHANNELS.BEFORE_QUIT_ACK,
    (value) => {
      const object = exactObject(value, 'payload', ['requestId']);
      return { requestId: stringValue(object.requestId, 'payload.requestId', { min: 36, max: 36, pattern: /^[0-9a-f-]{36}$/i }) };
    },
  ],
  [
    CHANNELS.FULLSCREEN_SET,
    (value) => {
      const object = exactObject(value, 'payload', ['value']);
      return { value: booleanValue(object.value, 'payload.value') };
    },
  ],
]);

const responseContracts = new Map([
  [CHANNELS.RUNTIME_INFO, runtimeInfo],
  [
    CHANNELS.FILES_PICK_FOLDER,
    (value) => nullable(value, (entry) => stringValue(entry, 'result', { min: 1, max: 32_768 })),
  ],
  [CHANNELS.FILES_PICK_FILES, (value) => arrayValue(value, 'result', fileDescriptor, 256)],
  [CHANNELS.FILES_LIST_PDFS, pdfListing],
  [CHANNELS.FILES_READ, readResult],
  [CHANNELS.FILES_AUTHORIZE_DROP, (value) => arrayValue(value, 'result', fileDescriptor, 256)],
  [CHANNELS.SIDECAR_STATUS, (value) => arrayValue(value, 'result', sidecarStatus, 100)],
  [
    CHANNELS.SIDECAR_LOGS,
    (value) => arrayValue(value, 'result', (entry, path) => stringValue(entry, path, { max: 16_384 }), 500),
  ],
  [CHANNELS.SIDECAR_AGGREGATE, aggregate],
  [CHANNELS.KEYCHAIN_SET, okResult],
  [CHANNELS.KEYCHAIN_GET, (value) => nullable(value, (entry) => stringValue(entry, 'result', { min: 1, max: 8192 }))],
  [CHANNELS.KEYCHAIN_DELETE, okResult],
  [CHANNELS.OPEN_PATH, openedResult],
  [
    CHANNELS.OPEN_EXTERNAL,
    (value) => {
      const object = exactObject(value, 'result', ['opened']);
      if (object.opened !== true) fail('result.opened', 'true');
      return { opened: true };
    },
  ],
  [
    CHANNELS.POPOUT,
    (value) => {
      const object = exactObject(value, 'result', ['id']);
      return { id: finiteInteger(object.id, 'result.id', 1, 2 ** 31 - 1) };
    },
  ],
  [
    CHANNELS.NOTIFICATION,
    (value) => {
      const object = exactObject(value, 'result', ['shown']);
      return { shown: booleanValue(object.shown, 'result.shown') };
    },
  ],
  [CHANNELS.FULLSCREEN_GET, (value) => booleanValue(value, 'result')],
  [CHANNELS.FULLSCREEN_SET, (value) => booleanValue(value, 'result')],
  [CHANNELS.BEFORE_QUIT_ACK, okResult],
  [
    CHANNELS.MICROPHONE_LEASE,
    (value) => {
      const object = exactObject(value, 'result', ['expiresAt']);
      return { expiresAt: finiteInteger(object.expiresAt, 'result.expiresAt', 0, Number.MAX_SAFE_INTEGER) };
    },
  ],
]);

const eventContracts = new Map([
  [EVENTS.BOOT_STATUS, bootStatus],
  [EVENTS.SECOND_INSTANCE, launchEvent],
  [EVENTS.OPEN_FILE, pathEvent],
  [EVENTS.PDF_DROP, pathEvent],
  [EVENTS.LIFECYCLE, lifecycleEvent],
  [EVENTS.NATIVE_NAVIGATE, nativeNavigationEvent],
  [EVENTS.SIDEBAR_TOGGLE, sidebarToggleEvent],
  [EVENTS.BEFORE_QUIT, beforeQuitEvent],
]);

export const IPC_CHANNELS = CHANNELS;
export const IPC_EVENTS = EVENTS;

export function validateRequest(channel, payload) {
  const parser = requestContracts.get(channel);
  if (!parser) throw new ContractError(`IPC channel is not allowed: ${channel}`);
  return parser(payload);
}

export function validateResponse(channel, result) {
  const parser = responseContracts.get(channel);
  if (!parser) throw new ContractError(`IPC channel is not allowed: ${channel}`);
  return parser(result);
}

export function validateEvent(channel, payload) {
  const parser = eventContracts.get(channel);
  if (!parser) throw new ContractError(`IPC event is not allowed: ${channel}`);
  return parser(payload);
}

export const ALLOWED_INVOKE_CHANNELS = Object.freeze([...requestContracts.keys()]);
export const ALLOWED_EVENT_CHANNELS = Object.freeze([...eventContracts.keys()]);
