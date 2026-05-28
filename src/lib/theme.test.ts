import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyTheme, getActiveTheme, getStoredTheme, setTheme } from './theme';

const STORAGE_KEY = 'qv-theme';

describe('theme manager', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  describe('applyTheme', () => {
    it('sets data-theme="dark" on <html> for dark', () => {
      applyTheme('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('sets data-theme="light" on <html> for light', () => {
      applyTheme('light');
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('removes data-theme for system so the CSS media query takes over', () => {
      document.documentElement.setAttribute('data-theme', 'dark');
      applyTheme('system');
      expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    });

    it('does not write to localStorage', () => {
      applyTheme('light');
      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });

  describe('setTheme', () => {
    it('persists the choice to localStorage under the qv-theme key', () => {
      setTheme('light');
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe('light');
    });

    it('also applies the theme to <html>', () => {
      setTheme('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('persists "system" verbatim (and clears data-theme)', () => {
      document.documentElement.setAttribute('data-theme', 'light');
      setTheme('system');
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe('system');
      expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    });
  });

  describe('getStoredTheme', () => {
    it('returns "system" when nothing is stored', () => {
      expect(getStoredTheme()).toBe('system');
    });

    it('returns the stored value when valid', () => {
      window.localStorage.setItem(STORAGE_KEY, 'light');
      expect(getStoredTheme()).toBe('light');
    });

    it('falls back to "system" when an unknown value is stored', () => {
      window.localStorage.setItem(STORAGE_KEY, 'neon');
      expect(getStoredTheme()).toBe('system');
    });
  });

  describe('getActiveTheme', () => {
    it('returns the explicit value when not "system"', () => {
      expect(getActiveTheme('light')).toBe('light');
      expect(getActiveTheme('dark')).toBe('dark');
    });

    it('resolves "system" via matchMedia to dark when prefers-color-scheme:light is false', () => {
      // jsdom returns matches=false for any query by default, which means
      // the OS preference is treated as "not light" → dark.
      expect(getActiveTheme('system')).toBe('dark');
    });
  });
});
