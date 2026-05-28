/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  applyTheme,
  getActiveTheme,
  getStoredTheme,
  setTheme as persistTheme,
} from '../lib/theme';

const ThemeContext = createContext(null);

const CYCLE = ['light', 'dark', 'system'];

function getSystemPalette() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'dark';
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function ThemeProvider({ children }) {
  // The initial value is whatever bootstrap (`src/main.jsx`) already applied to
  // <html>, so React's first render matches the DOM state exactly — no flash.
  const [theme, setThemeState] = useState(() => getStoredTheme());
  // Track only the OS preference here; `resolved` is then a pure derivation
  // of `theme` + `systemPalette`. This keeps us off the
  // "setState-in-useEffect" antipattern (react-hooks/set-state-in-effect).
  const [systemPalette, setSystemPalette] = useState(() => getSystemPalette());

  // Subscribe to system preference changes so 'system' users follow their OS.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const handle = (event) => setSystemPalette(event.matches ? 'light' : 'dark');
    query.addEventListener?.('change', handle);
    return () => query.removeEventListener?.('change', handle);
  }, []);

  const resolved = theme === 'system' ? systemPalette : theme;

  const setTheme = useCallback((next) => {
    persistTheme(next);
    setThemeState(next);
  }, []);

  // Legacy two-state toggle (light <-> dark) preserved for existing callers.
  // 'system' resolves to its current active palette first, then flips.
  const toggleTheme = useCallback(() => {
    setTheme(getActiveTheme(theme) === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  // Three-state cycle for the TopBar switcher: Light → Dark → System → …
  const cycleTheme = useCallback(() => {
    const index = CYCLE.indexOf(theme);
    const next = CYCLE[(index + 1) % CYCLE.length];
    setTheme(next);
  }, [theme, setTheme]);

  // Keep <html data-theme="…"> in sync if anything else clears it (e.g. HMR).
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const value = useMemo(
    () => ({
      theme,        // 'light' | 'dark' | 'system'
      resolved,     // 'light' | 'dark'  (the palette that is actually showing)
      isDark: resolved === 'dark',
      setTheme,
      toggleTheme,
      cycleTheme,
    }),
    [theme, resolved, setTheme, toggleTheme, cycleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used inside ThemeProvider');
  }
  return context;
}
