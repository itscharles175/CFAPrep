/*
 * K4-6 — unit tests for the feature-flag registry.
 *
 * Pins the contract the shell relies on: `LSAT_UNIFIED_SHELL` defaults OFF, the
 * layered resolution order (window override > localStorage > default) is
 * synchronous/pre-paint, and the dev setter persists + notifies. The cache is
 * reset between cases so each asserts a clean resolution.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FEATURE_FLAG_DEFAULTS,
  __resetFeatureFlagCache,
  isFeatureEnabled,
  setFeatureFlag,
} from './featureFlags';

beforeEach(() => {
  localStorage.clear();
  delete window.__SV_FLAGS__;
  __resetFeatureFlagCache();
});

afterEach(() => {
  localStorage.clear();
  delete window.__SV_FLAGS__;
  __resetFeatureFlagCache();
});

describe('featureFlags', () => {
  it('LSAT_UNIFIED_SHELL defaults ON (K4-13 cutover)', () => {
    expect(FEATURE_FLAG_DEFAULTS.LSAT_UNIFIED_SHELL).toBe(true);
    expect(isFeatureEnabled('LSAT_UNIFIED_SHELL')).toBe(true);
  });

  it('a localStorage override flips the flag (synchronous read)', () => {
    localStorage.setItem('sv.flags.LSAT_UNIFIED_SHELL', '1');
    __resetFeatureFlagCache();
    expect(isFeatureEnabled('LSAT_UNIFIED_SHELL')).toBe(true);

    localStorage.setItem('sv.flags.LSAT_UNIFIED_SHELL', '0');
    __resetFeatureFlagCache();
    expect(isFeatureEnabled('LSAT_UNIFIED_SHELL')).toBe(false);
  });

  it('a window.__SV_FLAGS__ override takes precedence over storage', () => {
    localStorage.setItem('sv.flags.LSAT_UNIFIED_SHELL', '0');
    window.__SV_FLAGS__ = { LSAT_UNIFIED_SHELL: true };
    __resetFeatureFlagCache();
    expect(isFeatureEnabled('LSAT_UNIFIED_SHELL')).toBe(true);
  });

  it('memoizes the resolved value within a session', () => {
    expect(isFeatureEnabled('LSAT_UNIFIED_SHELL')).toBe(true); // compiled default ON, now cached
    // Mutating storage WITHOUT resetting the cache must not change the read
    // (even to the opposite of the default).
    localStorage.setItem('sv.flags.LSAT_UNIFIED_SHELL', '0');
    expect(isFeatureEnabled('LSAT_UNIFIED_SHELL')).toBe(true);
  });

  it('setFeatureFlag persists to localStorage, updates the cache, and clears with null', () => {
    setFeatureFlag('LSAT_UNIFIED_SHELL', true);
    expect(isFeatureEnabled('LSAT_UNIFIED_SHELL')).toBe(true);
    expect(localStorage.getItem('sv.flags.LSAT_UNIFIED_SHELL')).toBe('1');

    setFeatureFlag('LSAT_UNIFIED_SHELL', null);
    expect(localStorage.getItem('sv.flags.LSAT_UNIFIED_SHELL')).toBeNull();
    // Cleared override -> falls back to the compiled-in default (ON as of K4-13).
    expect(isFeatureEnabled('LSAT_UNIFIED_SHELL')).toBe(true);
  });
});
