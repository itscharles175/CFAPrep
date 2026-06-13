import { describe, it, expect } from "vitest";
import { srsOriginLabel } from "./labels";

describe("srsOriginLabel", () => {
  it("maps known origins to friendly labels", () => {
    expect(srsOriginLabel("concept_gap")).toBe("Concept gap");
    expect(srsOriginLabel("lucky")).toBe("Lucky guess");
    expect(srsOriginLabel("timing_problem")).toBe("Timing problem");
    expect(srsOriginLabel("manual")).toBe("Manual");
  });

  it("returns null for missing/blank origins", () => {
    expect(srsOriginLabel(null)).toBeNull();
    expect(srsOriginLabel(undefined)).toBeNull();
    expect(srsOriginLabel("")).toBeNull();
    expect(srsOriginLabel("   ")).toBeNull();
  });

  it("is case-insensitive for known origins", () => {
    expect(srsOriginLabel("CONCEPT_GAP")).toBe("Concept gap");
  });

  it("title-cases an unknown snake_case origin", () => {
    expect(srsOriginLabel("some_new_reason")).toBe("Some new reason");
  });
});
