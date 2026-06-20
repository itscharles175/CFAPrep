import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selectRootShell } from './rootShellSelection';
import { __resetFeatureFlagCache, setFeatureFlag } from './featureFlags';

// K4-7/K4-13 — proves the flag-gated root selection. As of the K4-13 cutover the
// default (flag unset) resolves to the UNIFIED root; explicitly setting
// LSAT_UNIFIED_SHELL='0' rolls back to the legacy split-shell.

beforeEach(() => {
  // Clear any persisted override + memoized cache so each case resolves fresh.
  setFeatureFlag('LSAT_UNIFIED_SHELL', null);
  __resetFeatureFlagCache();
});

afterEach(() => {
  setFeatureFlag('LSAT_UNIFIED_SHELL', null);
  __resetFeatureFlagCache();
});

describe('selectRootShell (K4-7)', () => {
  it('defaults to the unified root when the flag is unset (K4-13 cutover default)', () => {
    expect(selectRootShell()).toBe('unified');
  });

  it('stays legacy when the flag is explicitly OFF', () => {
    setFeatureFlag('LSAT_UNIFIED_SHELL', false);
    __resetFeatureFlagCache();
    expect(selectRootShell()).toBe('legacy');
  });

  it('selects the unified root only when the flag is ON', () => {
    setFeatureFlag('LSAT_UNIFIED_SHELL', true);
    __resetFeatureFlagCache();
    expect(selectRootShell()).toBe('unified');
  });
});
