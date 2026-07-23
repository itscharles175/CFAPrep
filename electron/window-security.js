import { APP_HOST, APP_ORIGIN } from './protocol.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

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

export function isAllowedPermission({ permission, requestingUrl, isMainFrame, mediaTypes = [], devServerUrl = null }) {
  if (!isMainFrame || !isSafeRendererUrl(requestingUrl, devServerUrl)) return false;
  if (permission === 'clipboard-sanitized-write') return true;
  return permission === 'media' && mediaTypes.length > 0 && mediaTypes.every((type) => type === 'audio');
}

export function configureSessionSecurity(session, { devServerUrl = null } = {}) {
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
          devServerUrl,
        }),
    );
  });
  session.setDevicePermissionHandler?.(() => false);

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
