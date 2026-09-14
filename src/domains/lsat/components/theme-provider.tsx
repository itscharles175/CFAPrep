import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  getActiveTheme,
  getStoredTheme,
  setTheme as persistTheme,
  subscribeTheme,
} from "@/lib/theme";
import {
  getDensity,
  getHighContrast,
  setDensity as persistDensity,
  setHighContrast as persistHighContrast,
  type Density,
} from "@lsat/lib/prefs";

type Theme = "dark" | "light" | "system";

interface ThemeProviderState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  /** The base light/dark actually applied (system resolved). */
  resolved: "dark" | "light";
  density: Density;
  setDensity: (d: Density) => void;
  highContrast: boolean;
  setHighContrast: (on: boolean) => void;
}

const ThemeProviderContext = createContext<ThemeProviderState>({
  theme: "dark",
  setTheme: () => null,
  resolved: "dark",
  density: "comfortable",
  setDensity: () => null,
  highContrast: false,
  setHighContrast: () => null,
});

/**
 * R8 — the unified theme engine (docs/18 W1.1). One provider owns the three
 * app-level appearance mechanisms that used to be scattered across this file,
 * prefs.ts, and per-screen classes: the base theme (light/dark/system), UI
 * density, and high-contrast. The host applies the base palette while this
 * adapter keeps LSAT-only preferences and its resolved-theme context in sync.
 * The `hsl(var(--token))` contract is unchanged, so every existing component
 * re-themes for free.
 *
 * UA2 — the *base theme* (light/dark/system) is no longer owned here. It lives in
 * the host's shared `@/lib/theme` store (the single `qv-theme` key), which the
 * host ThemeContext also reads. This provider is now a thin adapter over that
 * store for the base theme, while it keeps full ownership of the LSAT-only
 * concerns it always did — density, high-contrast, and the cross-fade. The host
 * remains the sole writer of `<html data-theme>` and the base theme classes.
 * That prevents the LSAT subtree from overwriting a system preference after the
 * host has applied it. The shared store defaults to "system" (honour the OS
 * until the user chooses), replacing this file's former "dark is the hero"
 * default — a single source of truth can only have one default.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => getStoredTheme());
  const [resolved, setResolved] = useState<"dark" | "light">(() => getActiveTheme(getStoredTheme()));
  const [density, setDensityLocal] = useState<Density>(() => getDensity());
  const [highContrast, setHcLocal] = useState<boolean>(() => getHighContrast());

  useEffect(() => {
    const apply = () => {
      setResolved(getActiveTheme(theme));
    };
    apply();
    // Track the OS preference live while in "system" mode. The host owns the
    // matching DOM mutation; this adapter only keeps its local context honest.
    if (theme === "system" && typeof window.matchMedia === "function") {
      const mq = window.matchMedia("(prefers-color-scheme: light)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme]);

  // UA2 — follow the shared `@/lib/theme` store so a toggle from the host (or
  // another tab) re-renders this provider. Local `setTheme` already updates
  // state, so this is a no-op for in-tab LSAT toggles.
  useEffect(() => subscribeTheme((next) => setThemeState(next)), []);

  // R8 themes-as-environments (docs/18 W5.1): a brief one-shot cross-fade when
  // the environment actually switches (not on first paint). The reduced-motion
  // CSS net neutralizes the transition for users who ask, so this is gated free.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const root = window.document.documentElement;
    root.classList.add("theme-transition");
    const t = window.setTimeout(
      () => root.classList.remove("theme-transition"),
      340,
    );
    return () => window.clearTimeout(t);
  }, [resolved, highContrast]);

  const value: ThemeProviderState = {
    theme,
    resolved,
    setTheme: (t: Theme) => {
      // UA2 — persist through the shared store (notifies the host + other tabs);
      // update local state so consumers immediately receive the resolved value.
      persistTheme(t);
      setThemeState(t);
    },
    density,
    setDensity: (d: Density) => {
      persistDensity(d); // persists + applies data-density
      setDensityLocal(d);
    },
    highContrast,
    setHighContrast: (on: boolean) => {
      persistHighContrast(on); // persists + toggles .high-contrast
      setHcLocal(on);
    },
  };

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}


export function useTheme() {
  return useContext(ThemeProviderContext);
}
