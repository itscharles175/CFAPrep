import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyReadingTheme,
  bootstrapReadingTheme,
  getStoredReadingTheme,
  setReadingTheme,
  subscribeReadingTheme,
} from './readingTheme';

const ATTR = 'data-reading-theme';
const root = () => document.documentElement;

beforeEach(() => {
  window.localStorage.clear();
  root().removeAttribute(ATTR);
});

afterEach(() => {
  window.localStorage.clear();
  root().removeAttribute(ATTR);
});

describe('reading theme — additive override axis', () => {
  it('defaults to "default" (no attribute) when nothing stored', () => {
    expect(getStoredReadingTheme()).toBe('default');
    bootstrapReadingTheme();
    expect(root().hasAttribute(ATTR)).toBe(false);
  });

  it('removes the attribute for the default theme so the base palette shows through', () => {
    applyReadingTheme('warm-paper');
    expect(root().getAttribute(ATTR)).toBe('warm-paper');
    applyReadingTheme('default');
    expect(root().hasAttribute(ATTR)).toBe(false);
  });

  it('stamps the chosen reading theme', () => {
    applyReadingTheme('high-contrast');
    expect(root().getAttribute(ATTR)).toBe('high-contrast');
  });

  it('persists + applies via setReadingTheme', () => {
    setReadingTheme('warm-paper');
    expect(window.localStorage.getItem('qv-reading-theme')).toBe('warm-paper');
    expect(root().getAttribute(ATTR)).toBe('warm-paper');
    expect(getStoredReadingTheme()).toBe('warm-paper');
  });

  it('rejects a stored value that is not a known theme', () => {
    window.localStorage.setItem('qv-reading-theme', 'neon');
    expect(getStoredReadingTheme()).toBe('default');
  });

  it('notifies subscribers on change and unsubscribes cleanly', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeReadingTheme(listener);
    setReadingTheme('high-contrast');
    expect(listener).toHaveBeenCalledWith('high-contrast');
    unsubscribe();
    setReadingTheme('warm-paper');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
