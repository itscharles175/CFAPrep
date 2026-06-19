import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selectRootShell } from './rootShellSelection';
import { __resetFeatureFlagCache, setFeatureFlag } from './featureFlags';

// K4-7 — proves the flag-gated root selection. The default (flag OFF / unset)
// MUST resolve to the legacy split-shell so the running app is byte-for-byte
// unchanged; only flipping LSAT_UNIFIED_SHELL on selects the unified root.

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
  it('defaults to the legacy split-shell when the flag is unset (byte-for-byte unchanged path)', () => {
    expect(selectRootShell()).toBe('legacy');
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
