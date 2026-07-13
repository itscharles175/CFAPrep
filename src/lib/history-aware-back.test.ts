import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { performBack, resolveBack } from './history-aware-back';
import { clearHistory, getHistory, pushHistory } from './navigationHistory';

// navigateDomain is the cross-domain hop; spy on it to assert the resolver
// routes a different-plane back through it (vs. the same-domain navigator).
vi.mock('./domainNav', async () => {
  const actual = await vi.importActual<typeof import('./domainNav')>('./domainNav');
  return { ...actual, navigateDomain: vi.fn() };
});
import { navigateDomain } from './domainNav';

beforeEach(() => {
  clearHistory();
  vi.clearAllMocks();
});

afterEach(() => {
  clearHistory();
});

describe('resolveBack — what a Back press should do', () => {
  it('is disabled with no previous entry (root of the trail)', () => {
    pushHistory({ path: '/', label: 'Dashboard' });
    const res = resolveBack('/');
    expect(res.canGoBack).toBe(false);
    expect(res.target).toBeNull();
  });

  it('resolves a same-domain back when the previous entry shares the plane', () => {
    pushHistory({ path: '/', label: 'Dashboard' });
    pushHistory({ path: '/analytics', label: 'Analytics' });
    const res = resolveBack('/analytics');
    expect(res.canGoBack).toBe(true);
    expect(res.target).toMatchObject({ path: '/', kind: 'same-domain', label: 'Dashboard' });
  });

  it('resolves a cross-domain back when the previous entry is in the other plane', () => {
    pushHistory({ path: '/cfa', label: 'CFA' });
    pushHistory({ path: '/lsat/srs', label: 'SRS' });
    const res = resolveBack('/lsat/srs');
    expect(res.target).toMatchObject({ path: '/cfa', kind: 'cross-domain', domain: 'host' });
  });
});

describe('performBack — executing the resolved back', () => {
  it('soft-hops cross-domain via navigateDomain and pops the trail head', () => {
    pushHistory({ path: '/cfa', label: 'CFA' });
    pushHistory({ path: '/lsat/srs', label: 'SRS' });
    const target = performBack('/lsat/srs');
    expect(navigateDomain).toHaveBeenCalledWith('/cfa');
    expect(target?.path).toBe('/cfa');
    // The current (lsat) entry is popped so the trail head tracks where we land.
    expect(getHistory().map((e) => e.path)).toEqual(['/cfa']);
  });

  it('delegates a same-domain back to the supplied navigator (router back)', () => {
    pushHistory({ path: '/', label: 'Dashboard' });
    pushHistory({ path: '/analytics', label: 'Analytics' });
    const routerBack = vi.fn();
    performBack('/analytics', routerBack);
    expect(routerBack).toHaveBeenCalledTimes(1);
    expect(navigateDomain).not.toHaveBeenCalled();
  });

  it('returns null and does nothing when there is nowhere to go back', () => {
    pushHistory({ path: '/', label: 'Dashboard' });
    const routerBack = vi.fn();
    expect(performBack('/', routerBack)).toBeNull();
    expect(routerBack).not.toHaveBeenCalled();
    expect(navigateDomain).not.toHaveBeenCalled();
  });
});
