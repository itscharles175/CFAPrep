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
  it('LSAT_UNIFIED_SHELL defaults OFF', () => {
    expect(FEATURE_FLAG_DEFAULTS.LSAT_UNIFIED_SHELL).toBe(false);
    expect(isFeatureEnabled('LSAT_UNIFIED_SHELL')).toBe(false);
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
    expect(isFeatureEnabled('LSAT_UNIFIED_SHELL')).toBe(false);
    // Mutating storage WITHOUT resetting the cache must not change the read.
    localStorage.setItem('sv.flags.LSAT_UNIFIED_SHELL', '1');
    expect(isFeatureEnabled('LSAT_UNIFIED_SHELL')).toBe(false);
  });

  it('setFeatureFlag persists to localStorage, updates the cache, and clears with null', () => {
    setFeatureFlag('LSAT_UNIFIED_SHELL', true);
    expect(isFeatureEnabled('LSAT_UNIFIED_SHELL')).toBe(true);
    expect(localStorage.getItem('sv.flags.LSAT_UNIFIED_SHELL')).toBe('1');

    setFeatureFlag('LSAT_UNIFIED_SHELL', null);
    expect(localStorage.getItem('sv.flags.LSAT_UNIFIED_SHELL')).toBeNull();
    // Cleared override -> falls back to the compiled-in default (OFF).
    expect(isFeatureEnabled('LSAT_UNIFIED_SHELL')).toBe(false);
  });
});
