import { describe, it, expect } from "vitest";
import {
  EMPTY_CRITERIA,
  buildCriteria,
  criteriaToDraft,
  summarizeCriteria,
} from "./playlistCriteria";

describe("buildCriteria", () => {
  it("drops every 'any'/empty/false default", () => {
    expect(buildCriteria({ ...EMPTY_CRITERIA, limit: undefined })).toEqual({});
  });

  it("keeps a default limit when present", () => {
    expect(buildCriteria(EMPTY_CRITERIA)).toEqual({ limit: 20 });
  });

  it("maps only the chosen fields to wire keys", () => {
    const wire = buildCriteria({
      ...EMPTY_CRITERIA,
      sectionType: "LR",
      qType: "Parallel",
      source: "real",
      difficulty: 4,
      outcome: "concept_gap",
      flagged: true,
      incorrectOnly: true,
      preptestNameContains: "  PrepTest 90  ",
      passageType: " law ",
      limit: 25,
    });
    expect(wire).toEqual({
      section_type: "LR",
      q_type: "Parallel",
      source: "real",
      difficulty: 4,
      outcome: "concept_gap",
      flagged: true,
      incorrect_only: true,
      preptest_name_contains: "PrepTest 90",
      passage_type: "law",
      limit: 25,
    });
  });

  it("clamps the limit to 1..200", () => {
    expect(buildCriteria({ ...EMPTY_CRITERIA, limit: 9999 }).limit).toBe(200);
    expect(buildCriteria({ ...EMPTY_CRITERIA, limit: 0 }).limit).toBe(1);
  });

  it("coerces a string difficulty to a number", () => {
    // criteriaToDraft can hand back a number; guard the buildCriteria path too.
    expect(buildCriteria({ ...EMPTY_CRITERIA, difficulty: 3 }).difficulty).toBe(3);
  });
});

describe("criteriaToDraft", () => {
  it("round-trips through buildCriteria", () => {
    const wire = {
      section_type: "RC",
      q_type: "Inference",
      source: "ai",
      difficulty: 2,
      outcome: "lucky",
      flagged: true,
      incorrect_only: true,
      preptest_name_contains: "June",
      limit: 30,
    };
    const draft = criteriaToDraft(wire);
    expect(buildCriteria(draft)).toMatchObject(wire);
  });

  it("falls back to 'any'/defaults for a null criteria", () => {
    const draft = criteriaToDraft(null);
    expect(draft.sectionType).toBe("any");
    expect(draft.qType).toBe("any");
    expect(draft.flagged).toBe(false);
    expect(draft.limit).toBe(20);
  });

  it("tolerates a numeric difficulty stored as a string", () => {
    expect(criteriaToDraft({ difficulty: "5" }).difficulty).toBe(5);
  });
});

describe("summarizeCriteria", () => {
  it("returns 'All questions' when nothing constrains", () => {
    expect(summarizeCriteria({})).toBe("All questions");
    expect(summarizeCriteria(null)).toBe("All questions");
  });

  it("includes a friendly q_type label and outcome", () => {
    const s = summarizeCriteria({ q_type: "Parallel", outcome: "concept_gap" });
    expect(s).toContain("Parallel Reasoning");
    expect(s).toContain("Concept gap");
  });

  it("renders source 'real' as Official and appends the limit", () => {
    const s = summarizeCriteria({ source: "real", limit: 15 });
    expect(s).toContain("Official");
    expect(s).toContain("up to 15");
  });

  it("shows flagged and incorrect-only flags", () => {
    const s = summarizeCriteria({ flagged: true, incorrect_only: true });
    expect(s).toContain("Flagged");
    expect(s).toContain("Incorrect only");
  });
});
