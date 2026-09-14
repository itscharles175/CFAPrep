import { afterEach, describe, expect, it } from 'vitest';
import { isNativeNavigationEvent, resolveNativeRoute, validatedNativeRoute } from './nativeShell';
import { RESUME_HANDLE_KEY } from './studyTrail';

afterEach(() => localStorage.removeItem(RESUME_HANDLE_KEY));

describe('native shell route validation', () => {
  it('accepts application routes with query and hash state', () => {
    expect(validatedNativeRoute('/review?due=1#next')).toBe('/review?due=1#next');
    expect(isNativeNavigationEvent({ route: '/today', source: 'dock' })).toBe(true);
  });

  it.each([
    'https://example.com',
    '//example.com/review',
    '/../../etc/passwd',
    '/%2e%2e/etc/passwd',
    '/review\\evil',
    '',
  ])('rejects unsafe route %s', (route) => {
    expect(validatedNativeRoute(route)).toBeNull();
  });

  it('rejects unknown native navigation sources', () => {
    expect(isNativeNavigationEvent({ route: '/today', source: 'renderer' })).toBe(false);
  });

  it('resolves workspace shortcuts from current domain and CFA level', () => {
    expect(resolveNativeRoute('/__native/workspace/practice', {
      domain: 'cfa', cfaLevel: 'level3', goal: 'exam-readiness',
    })).toBe('/cfa/level3/mock');
    expect(resolveNativeRoute('/__native/workspace/review', {
      domain: 'lsat', cfaLevel: 'level1', goal: 'retention',
    })).toBe('/lsat/review');
    expect(resolveNativeRoute('/__native/workspace/unknown', {
      domain: 'excel', cfaLevel: 'level1', goal: 'skill-building',
    })).toBeNull();
  });

  it('resolves Resume Study from the durable trail pointer with a safe fallback', () => {
    localStorage.setItem(RESUME_HANDLE_KEY, JSON.stringify({
      domain: 'lsat',
      route: '/lsat/take/session/42',
      label: 'Logical reasoning',
      recordedAt: '2026-09-14T12:00:00.000Z',
    }));
    expect(resolveNativeRoute('/__native/resume')).toBe('/lsat/take/session/42');
    localStorage.setItem(RESUME_HANDLE_KEY, '{broken');
    expect(resolveNativeRoute('/__native/resume')).toBe('/');
  });
});
