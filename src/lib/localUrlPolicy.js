/**
 * Runtime URL policy for local-only browser fetches.
 *
 * Static scans catch literal egress, but several app paths compose URLs from
 * settings/env at runtime. These helpers are the shared last line of defense:
 * sidecar and local-model HTTP bases must be loopback-only before `fetch`.
 */

export class LocalUrlPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LocalUrlPolicyError';
  }
}

export function isLoopbackHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) {
    return true;
  }
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
  }
  return false;
}

export function normalizeLoopbackHttpBaseUrl(value, label = 'URL') {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_error) {
    throw new LocalUrlPolicyError(`${label} must be a valid http(s) URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new LocalUrlPolicyError(`${label} must be a valid http(s) URL.`);
  }
  if (parsed.username || parsed.password) {
    throw new LocalUrlPolicyError(`${label} must not contain embedded credentials.`);
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new LocalUrlPolicyError(
      `${label} must point at a loopback host (localhost, 127.0.0.1, or [::1]).`,
    );
  }
  return raw;
}

export function buildLoopbackHttpUrl(baseUrl, path, label = 'URL') {
  if (/^https?:\/\//i.test(String(path || ''))) {
    return normalizeLoopbackHttpBaseUrl(path, label);
  }
  const base = normalizeLoopbackHttpBaseUrl(baseUrl, label);
  const suffix = String(path || '').startsWith('/') ? String(path || '') : `/${path || ''}`;
  return `${base}${suffix}`;
}
