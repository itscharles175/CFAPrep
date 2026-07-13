import { describe, it, expect } from "vitest";
import { parseAnswerKey } from "./import-integrity-gate";

describe("parseAnswerKey", () => {
  it("parses one answer per line", () => {
    expect(parseAnswerKey("A\nC\nB\nE\nD")).toEqual(["A", "C", "B", "E", "D"]);
  });

  it("parses comma- and space-separated keys", () => {
    expect(parseAnswerKey("A, C ,B;E D")).toEqual(["A", "C", "B", "E", "D"]);
  });

  it("strips leading question numbers and punctuation", () => {
    expect(parseAnswerKey("1. C\n2) A\n3: B\n4 - D")).toEqual([
      "C",
      "A",
      "B",
      "D",
    ]);
  });

  it("upper-cases and ignores non A–E tokens", () => {
    expect(parseAnswerKey("a\nc\nz\n9\n-")).toEqual(["A", "C"]);
  });

  it("returns an empty array for blank input", () => {
    expect(parseAnswerKey("   \n  ")).toEqual([]);
  });
});
