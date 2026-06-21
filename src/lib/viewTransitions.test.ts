import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  prefersReducedMotion,
  startViewTransition,
  supportsViewTransitions,
} from './viewTransitions';

function setMatchMedia(reduced: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('reduce') ? reduced : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

// `document.startViewTransition` may or may not be in this lib.dom version; treat
// it as a loose bag in the test so we can set/clear our fake regardless.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doc = document as any;
function setStart(fn: ((cb: () => void | Promise<void>) => { finished: Promise<void> }) | undefined) {
  doc.startViewTransition = fn;
}

beforeEach(() => {
  setMatchMedia(false);
  setStart(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  setStart(undefined);
});

describe('capability detection', () => {
  it('reports no support when the API is absent', () => {
    expect(supportsViewTransitions()).toBe(false);
  });

  it('reports support when document.startViewTransition exists', () => {
    setStart((cb) => {
      cb();
      return { finished: Promise.resolve() };
    });
    expect(supportsViewTransitions()).toBe(true);
  });

  it('reads prefers-reduced-motion live', () => {
    setMatchMedia(true);
    expect(prefersReducedMotion()).toBe(true);
    setMatchMedia(false);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe('startViewTransition — always applies the DOM update', () => {
  it('runs the update instantly when the API is unsupported', async () => {
    const update = vi.fn();
    await startViewTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('runs the update instantly (no transition) under reduced-motion', async () => {
    setMatchMedia(true);
    const startSpy = vi.fn((cb: () => void) => {
      cb();
      return { finished: Promise.resolve() };
    });
    setStart(startSpy);
    const update = vi.fn();
    await startViewTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
    expect(startSpy).not.toHaveBeenCalled(); // short-circuited to instant
  });

  it('runs the update instantly when skip is requested', async () => {
    const startSpy = vi.fn((cb: () => void) => {
      cb();
      return { finished: Promise.resolve() };
    });
    setStart(startSpy);
    const update = vi.fn();
    await startViewTransition(update, { skip: true });
    expect(update).toHaveBeenCalledTimes(1);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('drives the API when supported and motion is allowed', async () => {
    const startSpy = vi.fn((cb: () => void) => {
      cb();
      return { finished: Promise.resolve() };
    });
    setStart(startSpy);
    const update = vi.fn();
    await startViewTransition(update);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('still resolves even if the transition.finished promise rejects', async () => {
    setStart((cb) => {
      cb();
      return { finished: Promise.reject(new Error('interrupted')) };
    });
    const update = vi.fn();
    await expect(startViewTransition(update)).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('clears the temporary view-transition-name after settling', async () => {
    setStart((cb) => {
      cb();
      return { finished: Promise.resolve() };
    });
    await startViewTransition(() => {}, { name: 'page-swap' });
    expect(document.documentElement.style.getPropertyValue('view-transition-name')).toBe('');
  });
});
