import { describe, expect, it } from 'vitest';
import {
  buildLoopbackHttpUrl,
  isLoopbackHostname,
  normalizeLoopbackHttpBaseUrl,
} from './localUrlPolicy';

describe('localUrlPolicy', () => {
  it('accepts loopback hostnames and 127/8 addresses', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('api.localhost')).toBe(true);
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('127.4.5.6')).toBe(true);
    expect(isLoopbackHostname('[::1]')).toBe(true);
    expect(isLoopbackHostname('::1')).toBe(true);
  });

  it('rejects LAN, public, and mDNS-style hosts', () => {
    expect(isLoopbackHostname('192.168.1.5')).toBe(false);
    expect(isLoopbackHostname('10.0.0.8')).toBe(false);
    expect(isLoopbackHostname('model.local')).toBe(false);
    expect(isLoopbackHostname('api.example.com')).toBe(false);
  });

  it('normalizes loopback http(s) bases without trailing slashes', () => {
    expect(normalizeLoopbackHttpBaseUrl('http://localhost:1234/v1/')).toBe(
      'http://localhost:1234/v1',
    );
    expect(normalizeLoopbackHttpBaseUrl('https://127.0.0.1:8443/')).toBe(
      'https://127.0.0.1:8443',
    );
  });

  it('rejects credentials, non-http schemes, malformed URLs, and remote hosts', () => {
    expect(() => normalizeLoopbackHttpBaseUrl('http://u:p@localhost:5055')).toThrow(
      /credentials/i,
    );
    expect(() => normalizeLoopbackHttpBaseUrl('ws://localhost:5055')).toThrow(/http/);
    expect(() => normalizeLoopbackHttpBaseUrl('localhost:5055')).toThrow(/http/);
    expect(() => normalizeLoopbackHttpBaseUrl('http://192.168.1.5:5055')).toThrow(
      /loopback/i,
    );
  });

  it('builds relative paths and rejects absolute remote URLs', () => {
    expect(buildLoopbackHttpUrl('http://127.0.0.1:8100/', '/api/health')).toBe(
      'http://127.0.0.1:8100/api/health',
    );
    expect(buildLoopbackHttpUrl('http://127.0.0.1:8100', 'api/health')).toBe(
      'http://127.0.0.1:8100/api/health',
    );
    expect(() =>
      buildLoopbackHttpUrl('http://127.0.0.1:8100', 'https://api.example.com/x'),
    ).toThrow(/loopback/i);
  });
});
