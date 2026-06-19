import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const navigateSpy = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateSpy,
}));

import { LSAT_ROUTE_PREFIX, toLsatPath, useLsatNavigate } from './lsatNavigate';
import { isLsatPath } from './domainNav';

describe('toLsatPath', () => {
  it('prefixes app-relative LSAT paths with /lsat', () => {
    expect(toLsatPath('/srs')).toBe('/lsat/srs');
    expect(toLsatPath('/take/42')).toBe('/lsat/take/42');
    expect(toLsatPath('/analytics/type/LR')).toBe('/lsat/analytics/type/LR');
  });

  it('maps the LSAT plane root "/" to the bare prefix (not "/lsat/")', () => {
    expect(toLsatPath('/')).toBe('/lsat');
  });

  it('preserves query and hash', () => {
    expect(toLsatPath('/take/42?x=1#top')).toBe('/lsat/take/42?x=1#top');
  });

  it('is idempotent on already-prefixed paths', () => {
    expect(toLsatPath('/lsat')).toBe('/lsat');
    expect(toLsatPath('/lsat/srs')).toBe('/lsat/srs');
  });

  it('leaves router-relative and external paths untouched', () => {
    expect(toLsatPath('foo')).toBe('foo');
    expect(toLsatPath('../bar')).toBe('../bar');
    expect(toLsatPath('https://example.com/srs')).toBe('https://example.com/srs');
  });

  it('always produces a path domainNav recognizes as the LSAT plane', () => {
    for (const p of ['/', '/srs', '/take/42', '/analytics/type/LR']) {
      expect(isLsatPath(toLsatPath(p))).toBe(true);
    }
  });

  it('keeps its prefix in sync with domainNav.isLsatPath', () => {
    expect(isLsatPath(LSAT_ROUTE_PREFIX)).toBe(true);
  });
});

describe('useLsatNavigate', () => {
  beforeEach(() => navigateSpy.mockReset());

  it('prefixes a bare string target', () => {
    const { result } = renderHook(() => useLsatNavigate());
    act(() => result.current('/srs'));
    expect(navigateSpy).toHaveBeenCalledWith('/lsat/srs', undefined);
  });

  it('forwards navigate options', () => {
    const { result } = renderHook(() => useLsatNavigate());
    act(() => result.current('/import', { replace: true }));
    expect(navigateSpy).toHaveBeenCalledWith('/lsat/import', { replace: true });
  });

  it('passes numeric deltas straight through', () => {
    const { result } = renderHook(() => useLsatNavigate());
    act(() => result.current(-1));
    expect(navigateSpy).toHaveBeenCalledWith(-1);
  });

  it('prefixes the pathname of an object target', () => {
    const { result } = renderHook(() => useLsatNavigate());
    act(() => result.current({ pathname: '/srs', search: '?due=1' }));
    expect(navigateSpy).toHaveBeenCalledWith({ pathname: '/lsat/srs', search: '?due=1' }, undefined);
  });

  it('does not double-prefix an already-/lsat target', () => {
    const { result } = renderHook(() => useLsatNavigate());
    act(() => result.current('/lsat/srs'));
    expect(navigateSpy).toHaveBeenCalledWith('/lsat/srs', undefined);
  });
});
