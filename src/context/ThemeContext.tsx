/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  applyTheme,
  getActiveTheme,
  getStoredTheme,
  setTheme as persistTheme,
  type ResolvedTheme,
  type ThemeName,
} from '../lib/theme';

export interface ThemeContextValue {
  /** User preference: 'light' | 'dark' | 'system'. */
  theme: ThemeName;
  /** Active palette (after resolving 'system' against the OS preference). */
  resolved: ResolvedTheme;
  isDark: boolean;
  setTheme(next: ThemeName): void;
  /** Legacy two-state toggle (light <-> dark). */
  toggleTheme(): void;
  /** Three-state cycle: Light → Dark → System → … */
  cycleTheme(): void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const CYCLE: ThemeName[] = ['light', 'dark', 'system'];

function getSystemPalette(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'dark';
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  // The initial value is whatever bootstrap (`src/main.jsx`) already applied to
  // <html>, so React's first render matches the DOM state exactly — no flash.
  const [theme, setThemeState] = useState<ThemeName>(() => getStoredTheme());
  // Track only the OS preference here; `resolved` is then a pure derivation
  // of `theme` + `systemPalette`. This keeps us off the
  // "setState-in-useEffect" antipattern (react-hooks/set-state-in-effect).
  const [systemPalette, setSystemPalette] = useState<ResolvedTheme>(() => getSystemPalette());

  // Subscribe to system preference changes so 'system' users follow their OS.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const handle = (event: MediaQueryListEvent) =>
      setSystemPalette(event.matches ? 'light' : 'dark');
    query.addEventListener?.('change', handle);
    return () => query.removeEventListener?.('change', handle);
  }, []);

  const resolved: ResolvedTheme = theme === 'system' ? systemPalette : theme;

  const setTheme = useCallback((next: ThemeName) => {
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

  const value = useMemo<ThemeContextValue>(
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

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used inside ThemeProvider');
  }
  return context;
}
