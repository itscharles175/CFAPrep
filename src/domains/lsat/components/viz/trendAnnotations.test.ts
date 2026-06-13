import { describe, it, expect } from "vitest";
import { deriveTrendAnnotations } from "./trendAnnotations";
import type { TrendDatum } from "./TrendChart";

const at = (scores: number[]): TrendDatum[] =>
  scores.map((score, i) => ({ date: `2026-01-${String(i + 1).padStart(2, "0")}`, score }));

describe("deriveTrendAnnotations", () => {
  it("returns nothing for series shorter than 3 points", () => {
    expect(deriveTrendAnnotations(at([160, 165]))).toEqual([]);
  });

  it("flags the personal best (last occurrence on ties)", () => {
    const a = deriveTrendAnnotations(at([150, 160, 170, 170]));
    const best = a.find((x) => x.label === "Personal best");
    expect(best).toBeTruthy();
    // Last of the two 170s.
    expect(best!.index).toBe(3);
    expect(best!.tone).toBe("success");
  });

  it("flags the biggest single-step jump (when not adjacent to a higher-priority pin)", () => {
    // Jump at index 1 (150 -> 164, +14); best is the last point (index 4), far
    // enough away that the de-overlap keeps both.
    const a = deriveTrendAnnotations(at([150, 164, 163, 162, 170]));
    const jump = a.find((x) => x.label.includes("jump"));
    expect(jump).toBeTruthy();
    expect(jump!.index).toBe(1);
    expect(jump!.label).toBe("+14 jump");
  });

  it("suppresses a jump pin that would overlap the personal-best pin", () => {
    // 151 -> 165 jump at index 2 sits right beside the best at index 3, so the
    // higher-priority best wins and the jump is dropped.
    const a = deriveTrendAnnotations(at([150, 151, 165, 166]));
    expect(a.find((x) => x.label === "Personal best")?.index).toBe(3);
    expect(a.find((x) => x.label.includes("jump"))).toBeUndefined();
  });

  it("caps to the top 2 and de-overlaps adjacent pins", () => {
    // A long climb: best is the last point, jump is somewhere mid.
    const a = deriveTrendAnnotations(at([140, 145, 150, 158, 168, 169, 170]));
    expect(a.length).toBeLessThanOrEqual(2);
    // No two kept pins share or sit immediately beside each other.
    for (let i = 1; i < a.length; i++) {
      expect(Math.abs(a[i].index - a[i - 1].index)).toBeGreaterThan(1);
    }
  });

  it("returns pins ordered left-to-right by index", () => {
    const a = deriveTrendAnnotations(at([140, 160, 150, 152, 154, 175]));
    const indices = a.map((x) => x.index);
    expect([...indices].sort((p, q) => p - q)).toEqual(indices);
  });

  it("does not flag a jump below the +2 threshold", () => {
    const a = deriveTrendAnnotations(at([160, 161, 160, 161, 160]));
    expect(a.find((x) => x.label.includes("jump"))).toBeUndefined();
  });
});
