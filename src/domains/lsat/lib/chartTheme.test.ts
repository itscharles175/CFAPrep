import { describe, it, expect } from "vitest";
import { interpolateViridis, interpolateInferno } from "d3-scale-chromatic";
import {
  makeRampColor,
  makeDivergingColor,
  relativeLuminance,
  contrastInk,
} from "./chartTheme";

describe("makeRampColor — theme-aware sequential ramps", () => {
  it("lifts the dark-theme floor off near-black so the lowest cell still reads", () => {
    const dark = makeRampColor("viridis", "dark");
    // Raw viridis(0) is near-black (~0x440154); the remapped floor must be
    // perceptibly brighter than that on dark surfaces.
    const rawFloor = relativeLuminance(interpolateViridis(0));
    const themedFloor = relativeLuminance(dark(0));
    expect(themedFloor).toBeGreaterThan(rawFloor);
  });

  it("caps the light-theme ceiling below paper-white so the brightest cell stays legible", () => {
    const light = makeRampColor("viridis", "light");
    // Raw viridis(1) is a pale near-white yellow; the remapped top must be
    // perceptibly darker than that on paper.
    const rawTop = relativeLuminance(interpolateViridis(1));
    const themedTop = relativeLuminance(light(1));
    expect(themedTop).toBeLessThan(rawTop);
  });

  it("keeps the ramp monotonic in luminance (preserves colourblind ordering)", () => {
    const dark = makeRampColor("inferno", "dark");
    const samples = [0, 0.25, 0.5, 0.75, 1].map((t) =>
      relativeLuminance(dark(t)),
    );
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThan(samples[i - 1]);
    }
  });

  it("clamps out-of-range input instead of overshooting the window", () => {
    const dark = makeRampColor("viridis", "dark");
    expect(dark(-5)).toBe(dark(0));
    expect(dark(5)).toBe(dark(1));
  });

  it("never returns the raw extreme swatches on dark (no background collision)", () => {
    const dark = makeRampColor("inferno", "dark");
    expect(dark(0)).not.toBe(interpolateInferno(0));
  });
});

describe("makeDivergingColor — gap ramp", () => {
  it("returns a stronger (more saturated-toward-orange) colour as the gap grows", () => {
    const div = makeDivergingColor("dark");
    const small = div(0.05);
    const large = div(0.5);
    expect(small).not.toBe(large);
  });

  it("treats sign as magnitude (symmetric around neutral)", () => {
    const div = makeDivergingColor("light");
    expect(div(0.3)).toBe(div(-0.3));
  });
});

describe("relativeLuminance / contrastInk", () => {
  it("parses rgb() strings (the d3 interpolator output format)", () => {
    expect(relativeLuminance("rgb(0, 0, 0)")).toBeCloseTo(0, 5);
    expect(relativeLuminance("rgb(255, 255, 255)")).toBeCloseTo(1, 5);
  });

  it("parses hex swatches too", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(relativeLuminance("#fff")).toBeCloseTo(1, 5);
  });

  it("picks dark ink over a light swatch and light ink over a dark swatch", () => {
    expect(contrastInk("rgb(250, 250, 210)")).toBe("#0b0b0f"); // pale → dark ink
    expect(contrastInk("rgb(20, 10, 40)")).toBe("#ffffff"); // deep → light ink
  });
});
