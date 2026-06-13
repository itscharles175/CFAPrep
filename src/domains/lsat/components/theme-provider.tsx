import { createContext, useContext, useEffect, useRef, useState } from "react";
import { getRaw, setRaw } from "@lsat/lib/storage";
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

const STORAGE_KEY = "lsatlab-theme";

/**
 * R8 — the unified theme engine (docs/18 W1.1). One provider owns the three
 * app-level appearance mechanisms that used to be scattered across this file,
 * prefs.ts, and per-screen classes: the base theme (light/dark/system), UI
 * density, and high-contrast. It applies them in a single effect and stamps a
 * `data-theme` attribute (e.g. "dark", "light-hc") for the themes-as-environments
 * cross-fade and any theme-scoped selectors. The `hsl(var(--token))` contract is
 * unchanged, so every existing component re-themes for free.
 *
 * Dark is the hero: new installs (no stored preference) default to dark.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const v = getRaw(STORAGE_KEY) as Theme | null;
    return v === "light" || v === "dark" || v === "system" ? v : "dark";
  });
  const [resolved, setResolved] = useState<"dark" | "light">("dark");
  const [density, setDensityLocal] = useState<Density>(() => getDensity());
  const [highContrast, setHcLocal] = useState<boolean>(() => getHighContrast());

  useEffect(() => {
    const root = window.document.documentElement;
    const apply = () => {
      root.classList.remove("light", "dark");
      let next: "dark" | "light";
      if (theme === "system") {
        next = window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
      } else {
        next = theme;
      }
      root.classList.add(next);
      root.dataset.theme = highContrast ? `${next}-hc` : next;
      setResolved(next);
    };
    apply();
    // Track the OS preference live while in "system" mode.
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme, highContrast]);

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
      setRaw(STORAGE_KEY, t);
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
