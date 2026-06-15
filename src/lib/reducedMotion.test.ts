import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prefersReducedMotion } from './reducedMotion';

/**
 * UC6 — deterministic reduced-motion test. No browser: `window.matchMedia` is
 * mocked per-case so the result is fully controlled. Also asserts the global
 * stylesheet ships the `prefers-reduced-motion: reduce` damping block, so the
 * app honours the preference at the CSS layer too.
 */

/** Install a matchMedia stub that reports `matches` for the reduced-motion query. */
function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

describe('prefersReducedMotion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true when the OS requests reduced motion', () => {
    stubMatchMedia(true);
    expect(prefersReducedMotion()).toBe(true);
  });

  it('returns false when the OS does not request reduced motion', () => {
    stubMatchMedia(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it('queries the prefers-reduced-motion media feature exactly', () => {
    const spy = vi.fn(() => ({ matches: true }) as MediaQueryList);
    vi.stubGlobal('matchMedia', spy);
    prefersReducedMotion();
    expect(spy).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
  });

  it('falls back to false when matchMedia is unavailable (jsdom default / SSR)', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe('global stylesheet respects prefers-reduced-motion', () => {
  it('index.css damps animation/transition under prefers-reduced-motion: reduce', () => {
    // Vitest runs with the repo root as cwd; resolve the global stylesheet from
    // there so the assertion is independent of the test file's transform URL.
    const cssPath = resolve(process.cwd(), 'src/index.css');
    const css = readFileSync(cssPath, 'utf8');
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    // The block neutralises both animation and transition durations.
    const block = css.slice(css.indexOf('prefers-reduced-motion'));
    expect(block).toMatch(/animation-duration:\s*1ms\s*!important/);
    expect(block).toMatch(/transition-duration:\s*1ms\s*!important/);
  });
});
