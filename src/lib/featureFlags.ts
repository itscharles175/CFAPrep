/*
 * K4-6 — tiny typed feature-flag registry (Phase 1 of Keystone K4: full UI
 * unification).
 *
 * The only flag today is `LSAT_UNIFIED_SHELL`, which gates the unified host
 * shell (<SharedLayout> + the host Sidebar's LSAT section + the TopBar mode
 * toggle + the merged router/providers). As of K4-13 (Phase 3 cutover) it
 * DEFAULTS ON: the app boots into the unified shell (LSAT under the host
 * Sidebar/TopBar via UnifiedRoot). The legacy split-shell still exists and is
 * one flip away — set the localStorage key `sv.flags.LSAT_UNIFIED_SHELL` to
 * '0' (or `window.__SV_FLAGS__`) to roll back to it — until the legacy shell is
 * deleted in the final K4-13 step.
 *
 * Resolution is SYNCHRONOUS at module load (pre-paint), so a flag read during
 * the first render never flashes the wrong shell. Three layered sources, highest
 * precedence first:
 *
 *   1. a `window.__SV_FLAGS__` global override (e.g. set by an E2E harness or a
 *      `<script>` before the bundle), then
 *   2. a `localStorage` key (`sv.flags.<FLAG>` === '1' | '0'), then
 *   3. the compiled-in default below.
 *
 * Reads are memoized into a module-level cache the first time each flag is
 * resolved, so repeated `isFeatureEnabled` calls (and the React hook) are O(1)
 * and stable within a session. The dev setter updates the cache + localStorage
 * and notifies subscribers so the `useFeatureFlag` hook re-renders live.
 */

import { useSyncExternalStore } from 'react';

/** The flag registry. Add new flags here with their compiled-in default. */
export const FEATURE_FLAG_DEFAULTS = {
  /**
   * K4: the unified host shell (host Sidebar + TopBar host the LSAT surface as a
   * 4th nav section + mode toggle, and <SharedLayout> wraps the merged router).
   * ON by default as of the K4-13 cutover — the app boots into the unified
   * shell. The legacy split-shell remains for instant rollback (set
   * `sv.flags.LSAT_UNIFIED_SHELL` = '0') until it is deleted in the final step.
   */
  LSAT_UNIFIED_SHELL: true,
} as const;

export type FeatureFlag = keyof typeof FEATURE_FLAG_DEFAULTS;

/** localStorage key namespace for persisted dev overrides. */
const STORAGE_PREFIX = 'sv.flags.';

/** Shape of the optional `window.__SV_FLAGS__` global override map. */
type FlagOverrides = Partial<Record<FeatureFlag, boolean>>;

declare global {
  interface Window {
    __SV_FLAGS__?: FlagOverrides;
  }
}

// Memoized resolved values. `undefined` = not yet resolved this session.
const cache: Partial<Record<FeatureFlag, boolean>> = {};

// Subscribers for the React hook (live updates when the dev setter flips a flag).
const listeners = new Set<() => void>();

function readGlobalOverride(flag: FeatureFlag): boolean | undefined {
  if (typeof window === 'undefined') return undefined;
  const override = window.__SV_FLAGS__;
  if (override && Object.prototype.hasOwnProperty.call(override, flag)) {
    return Boolean(override[flag]);
  }
  return undefined;
}

function readStorageOverride(flag: FeatureFlag): boolean | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${flag}`);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return undefined;
  } catch {
    // Private-mode / blocked storage — fall through to the default.
    return undefined;
  }
}

/** Resolve a flag from the layered sources (override > storage > default). */
function resolve(flag: FeatureFlag): boolean {
  const fromGlobal = readGlobalOverride(flag);
  if (fromGlobal !== undefined) return fromGlobal;
  const fromStorage = readStorageOverride(flag);
  if (fromStorage !== undefined) return fromStorage;
  return FEATURE_FLAG_DEFAULTS[flag];
}

/**
 * Synchronously read a feature flag. Safe to call during the first render
 * (pre-paint) — no async, no shell flash. Memoized per session.
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  const cached = cache[flag];
  if (cached !== undefined) return cached;
  const value = resolve(flag);
  cache[flag] = value;
  return value;
}

/**
 * Dev/test setter: flip a flag for this session. Persists to localStorage so a
 * reload keeps it, updates the in-memory cache, and notifies `useFeatureFlag`
 * subscribers so the UI re-renders live. Pass `null` to clear the persisted
 * override and fall back to global/default resolution.
 */
export function setFeatureFlag(flag: FeatureFlag, value: boolean | null): void {
  if (value === null) {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(`${STORAGE_PREFIX}${flag}`);
      } catch {
        // ignore blocked storage
      }
    }
    delete cache[flag];
  } else {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(`${STORAGE_PREFIX}${flag}`, value ? '1' : '0');
      } catch {
        // ignore blocked storage
      }
    }
    cache[flag] = value;
  }
  listeners.forEach((listener) => listener());
}

/**
 * Test-only: drop the memoized cache so the next read re-resolves from the
 * layered sources. Not part of the production API surface, but exported so unit
 * tests can isolate cases without a full module reset.
 */
export function __resetFeatureFlagCache(): void {
  (Object.keys(cache) as FeatureFlag[]).forEach((flag) => delete cache[flag]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * React hook: subscribe to a feature flag. Reads synchronously on mount (so the
 * first render already has the right value — no flash) and re-renders when the
 * dev setter flips it.
 */
export function useFeatureFlag(flag: FeatureFlag): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isFeatureEnabled(flag),
    () => resolve(flag),
  );
}
