import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isPathWithin } from './path-policy.js';

export const APP_SCHEME = 'app';
export const APP_HOST = 'studyvault';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

export function registerAppScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
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
}

export function appAssetCandidate(distRoot, requestUrl) {
  const url = new URL(requestUrl);
  if (url.protocol !== `${APP_SCHEME}:` || url.hostname !== APP_HOST || url.username || url.password || url.port) {
    throw new Error('Invalid StudyVault app URL');
  }
  let decoded;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    throw new Error('Invalid URL encoding');
  }
  if (decoded.includes('\0') || decoded.includes('\\')) throw new Error('Invalid app path');
  const segments = decoded.split('/');
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new Error('App path traversal is not allowed');
  }
  const relative = decoded.replace(/^\/+/, '') || 'index.html';
  const candidate = path.resolve(distRoot, relative);
  if (!isPathWithin(distRoot, candidate)) throw new Error('App path escaped the distribution root');
  return candidate;
}

async function resolveExistingAsset(distRoot, candidate) {
  const canonicalRoot = await realpath(distRoot);
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) throw new Error('Symbolic app assets are not allowed');
    const target = info.isDirectory() ? path.join(candidate, 'index.html') : candidate;
    const canonicalTarget = await realpath(target);
    if (!isPathWithin(canonicalRoot, canonicalTarget)) throw new Error('App asset escaped the distribution root');
    return canonicalTarget;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const fallback = await realpath(path.join(canonicalRoot, 'index.html'));
    if (!isPathWithin(canonicalRoot, fallback)) {
      throw new Error('App fallback escaped the distribution root', { cause: error });
    }
    return fallback;
  }
}

export async function resolveAppAssetPath(distRoot, requestUrl) {
  return resolveExistingAsset(distRoot, appAssetCandidate(distRoot, requestUrl));
}

export function productionContentSecurityPolicy() {
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "connect-src 'self' http://127.0.0.1:1234 http://127.0.0.1:5055 http://127.0.0.1:8000 http://127.0.0.1:8100 http://127.0.0.1:11434 http://localhost:1234 http://localhost:5055 http://localhost:8000 http://localhost:8100 http://localhost:11434",
  ].join('; ');
}

export function installAppProtocol({ protocol, net, distRoot, logger }) {
  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const asset = await resolveAppAssetPath(distRoot, request.url);
      const response = await net.fetch(pathToFileURL(asset).toString());
      const headers = new Headers(response.headers);
      headers.set('Content-Security-Policy', productionContentSecurityPolicy());
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      logger.error('protocol_request_rejected', { url: request.url, error });
      return new Response('Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  });
}
