import { APP_HOST, APP_ORIGIN } from './protocol.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const MICROPHONE_LEASE_MS = 5000;

export class MicrophonePermissionLease {
  constructor({ ttlMs = MICROPHONE_LEASE_MS, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.leases = new Map();
  }

  grant(webContentsId) {
    if (!Number.isSafeInteger(webContentsId) || webContentsId < 1) throw new Error('Invalid webContents ID');
    const expiresAt = this.now() + this.ttlMs;
    this.leases.set(webContentsId, expiresAt);
    return expiresAt;
  }

  valid(webContentsId) {
    const expiresAt = this.leases.get(webContentsId);
    return typeof expiresAt === 'number' && expiresAt >= this.now();
  }

  consume(webContentsId) {
    const valid = this.valid(webContentsId);
    this.leases.delete(webContentsId);
    return valid;
  }
}

export function validatedDevServerUrl(input) {
  if (!input) return null;
  const url = new URL(input);
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password || !url.port) {
    throw new Error('VITE_DEV_SERVER_URL must be an HTTP loopback URL with an explicit port');
  }
  return url;
}

export function isSafeRendererUrl(input, devServerUrl = null) {
  try {
    const url = new URL(input);
    if (url.protocol === 'app:' && url.hostname === APP_HOST && !url.username && !url.password && !url.port) {
      return true;
    }
    const dev = devServerUrl ? validatedDevServerUrl(devServerUrl) : null;
    return dev !== null && url.origin === dev.origin && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function isAllowedExternalHttpsUrl(input) {
  try {
    const url = new URL(input);
    return (
      input.length <= 8192 && url.protocol === 'https:' && url.hostname.length > 0 && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

export function isAllowedSessionRequest(input, devServerUrl = null) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (['app:', 'data:', 'blob:', 'devtools:'].includes(url.protocol)) return true;
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return false;
  if (!LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password) return false;
  if (devServerUrl) {
    const dev = validatedDevServerUrl(devServerUrl);
    if (url.origin === dev.origin) return true;
  }
  return true;
}

export function normalizePopoutUrl(route, devServerUrl = null) {
  if (typeof route !== 'string' || route.length === 0 || route.length > 2048) {
    throw new Error('Popout route is invalid');
  }
  const base = devServerUrl ? validatedDevServerUrl(devServerUrl).toString() : `${APP_ORIGIN}/`;
  const url = new URL(route, base);
  if (!isSafeRendererUrl(url.toString(), devServerUrl)) {
    throw new Error('Popout route must stay inside the StudyVault application');
  }
  return url.toString();
}

export function isAllowedPermission({
  permission,
  requestingUrl,
  isMainFrame,
  mediaTypes = [],
  microphoneLeaseValid = false,
  devServerUrl = null,
}) {
  if (!isMainFrame || !isSafeRendererUrl(requestingUrl, devServerUrl)) return false;
  if (permission === 'clipboard-sanitized-write') return true;
  return (
    permission === 'media' &&
    microphoneLeaseValid === true &&
    mediaTypes.length > 0 &&
    mediaTypes.every((type) => type === 'audio')
  );
}

export function configureSessionSecurity(session, { devServerUrl = null, microphoneLease = null } = {}) {
  const trustedWebContents = (webContents) =>
    webContents !== null &&
    !webContents.isDestroyed() &&
    isSafeRendererUrl(webContents.mainFrame?.url ?? '', devServerUrl);

  session.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) =>
      trustedWebContents(webContents) &&
      isAllowedPermission({
        permission,
        requestingUrl: details.requestingUrl || details.securityOrigin || requestingOrigin,
        isMainFrame: details.isMainFrame,
        mediaTypes: details.mediaType ? [details.mediaType] : [],
        microphoneLeaseValid: microphoneLease?.valid(webContents?.id) === true,
        devServerUrl,
      }),
  );
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      trustedWebContents(webContents) &&
        isAllowedPermission({
          permission,
          requestingUrl: details.requestingUrl,
          isMainFrame: details.isMainFrame,
          mediaTypes: details.mediaTypes ?? [],
          microphoneLeaseValid:
            permission === 'media' && (details.mediaTypes ?? []).every((type) => type === 'audio')
              ? microphoneLease?.consume(webContents?.id) === true
              : false,
          devServerUrl,
        }),
    );
  });
  session.setDevicePermissionHandler?.(() => false);
  session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => callback({ cancel: !isAllowedSessionRequest(details.url, devServerUrl) }),
  );

  // Belt-and-braces for the offline invariant: even if a window is created with
  // spellcheck enabled, point the dictionary fetch at a non-resolving loopback
  // URL so Chromium can never reach Google's CDN. Wrapped because the API is
  // absent on platforms using the OS spellchecker.
  try {
    session.setSpellCheckerDictionaryDownloadURL?.('http://127.0.0.1:0/');
    session.setSpellCheckerEnabled?.(false);
  } catch {
    // Older/other platforms without the spellchecker APIs need no suppression.
  }
}

export function hardenWebContents(webContents, { devServerUrl = null, logger }) {
  webContents.setWindowOpenHandler((details) => {
    logger.warn('window_open_denied', { url: details.url });
    return { action: 'deny' };
  });
  webContents.on('will-navigate', (event, url) => {
    if (!isSafeRendererUrl(url, devServerUrl)) {
      event.preventDefault();
      logger.warn('navigation_denied', { url });
    }
  });
  webContents.on('will-redirect', (event, url) => {
    if (!isSafeRendererUrl(url, devServerUrl)) {
      event.preventDefault();
      logger.warn('redirect_denied', { url });
    }
  });
  webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
    logger.warn('webview_attach_denied');
  });
}
