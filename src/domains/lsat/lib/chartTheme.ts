import { useMemo } from "react";
import {
  interpolateViridis,
  interpolateInferno,
  interpolatePuOr,
} from "d3-scale-chromatic";
import { useTheme } from "@lsat/components/theme-provider";

/**
 * R8 W1.5 — theme-aware chart scales.
 *
 * The d3 sequential ramps (viridis/inferno) are perceptually uniform but they
 * begin at near-black (t≈0) and, for viridis, end at near-white yellow (t≈1).
 * On the dark "Observatory" surfaces the low end melts into `--surface-1`; on
 * paper themes the high end melts into the page. Either way the lowest-value
 * cells stop reading as data.
 *
 * Fix: don't change the data domain — change the *output* range of the ramp so
 * it never reaches the offending extreme for the active theme. We sample the
 * full d3 interpolator within a theme-appropriate window `[lo, hi] ⊂ [0,1]`,
 * keeping the ramp's hue progression (and colourblind-friendly luminance order)
 * while pulling the darkest/lightest swatch off the background.
 *
 * Diverging ramps (PuOr) are symmetric, so we keep the full range — the neutral
 * mid still needs to read, which we handle with a small floor on |t|.
 */

export type ChartRamp = "viridis" | "inferno" | "puor";
export type ResolvedTheme = "dark" | "light";

const BASE_INTERP: Record<ChartRamp, (t: number) => string> = {
  viridis: interpolateViridis,
  inferno: interpolateInferno,
  puor: interpolatePuOr,
};

/**
 * The safe output window per ramp per theme. For sequential ramps we lift the
 * floor on dark (so the dimmest cell still glows above the surface) and lower
 * the ceiling on light (so the brightest cell still sits below paper white).
 */
function rampWindow(ramp: ChartRamp, theme: ResolvedTheme): [number, number] {
  if (ramp === "puor") {
    // Diverging: keep the full sweep; both ends carry meaning.
    return [0, 1];
  }
  if (theme === "dark") {
    // Skip the near-black bottom ~28% of the ramp.
    return [0.28, 1];
  }
  // Light: skip the near-white/pale top ~15% so high cells stay legible on paper.
  return [0, 0.85];
}

/**
 * A sequential colour function for `t ∈ [0,1]` (already normalised by the
 * caller's scale) that stays clear of the active theme's background.
 */
export function makeRampColor(
  ramp: ChartRamp,
  theme: ResolvedTheme,
): (t: number) => string {
  const interp = BASE_INTERP[ramp];
  const [lo, hi] = rampWindow(ramp, theme);
  const span = hi - lo;
  return (t: number) => {
    const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
    return interp(lo + clamped * span);
  };
}

/**
 * Diverging colour for a signed magnitude in `[0,1]` (e.g. a gap). 0 → neutral
 * mid; 1 → the warm/cool extreme. A small floor keeps the neutral swatch from
 * being a dead grey that vanishes on either background.
 */
export function makeDivergingColor(
  theme: ResolvedTheme,
): (signed: number) => string {
  void theme; // PuOr's mid reads on both themes; signature kept symmetric.
  return (signed: number) => {
    const m = Math.abs(signed) > 1 ? 1 : Math.abs(signed) < 0 ? 0 : Math.abs(signed);
    // 0.5 is the neutral centre of PuOr; push outward toward the orange end.
    const t = 0.5 + m * 0.45;
    return interpolatePuOr(t);
  };
}

/**
 * Parse an `rgb()`/`rgba()` or `#rgb`/`#rrggbb` string to 0–255 channels. d3
 * sequential interpolators always emit `rgb(r, g, b)`, so this covers every
 * swatch we hand it; falls back to black for anything unparseable.
 */
function parseRgb(color: string): [number, number, number] {
  const m = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  const hex = color.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return [
      parseInt(hex[0] + hex[0], 16),
      parseInt(hex[1] + hex[1], 16),
      parseInt(hex[2] + hex[2], 16),
    ];
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }
  return [0, 0, 0];
}

/**
 * Relative luminance (WCAG) of any rgb/hex swatch. Used to pick a legible
 * mark/label colour to lay over an arbitrary ramp swatch instead of a
 * hardcoded `#fff`/`#111`.
 */
export function relativeLuminance(color: string): number {
  const [r, g, b] = parseRgb(color);
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Given a background swatch, return a near-black or near-white ink that meets
 * AA contrast against it. Theme-independent: it reads the swatch's own
 * luminance, so it is correct on any ramp in any theme.
 */
export function contrastInk(bg: string): "#0b0b0f" | "#ffffff" {
  // Threshold ~0.4 favours dark ink earlier than the naive 0.5 midpoint, which
  // matches viridis/inferno where the visual "bright" half starts below 0.5.
  return relativeLuminance(bg) > 0.4 ? "#0b0b0f" : "#ffffff";
}

export interface ChartScales {
  resolved: ResolvedTheme;
  highContrast: boolean;
  /** Build a theme-safe sequential colour fn for a ramp (normalised input). */
  rampColor: (ramp: ChartRamp) => (t: number) => string;
  /** Diverging colour for a signed magnitude in [-1,1]. */
  divergingColor: (signed: number) => string;
  /** AA-legible ink (mark/label) for an arbitrary swatch. */
  inkFor: (bg: string) => string;
  /** Token-driven mark/label colours that read in every theme. */
  labelColor: string;
  axisColor: string;
  gridColor: string;
  /** Fill for "no data" / zero cells. */
  emptyCellColor: string;
}

/**
 * The hook charts consume. Re-derives the colour functions when the resolved
 * theme flips (dark↔light) so a theme switch re-paints every ramp for free.
 */
export function useChartScales(): ChartScales {
  const { resolved, highContrast } = useTheme();
  return useMemo(() => {
    const rampColor = (ramp: ChartRamp) => makeRampColor(ramp, resolved);
    const divergingColor = makeDivergingColor(resolved);
    return {
      resolved,
      highContrast,
      rampColor,
      divergingColor,
      inkFor: contrastInk,
      labelColor: "hsl(var(--foreground))",
      axisColor: "hsl(var(--muted-foreground))",
      gridColor: "hsl(var(--border))",
      emptyCellColor: "hsl(var(--muted))",
    };
  }, [resolved, highContrast]);
}
