import { describe, expect, it } from "vitest";
import { recPath } from "./docked-coach";
import type { Recommendation } from "@lsat/lib/types";

function rec(type: string, payload?: Record<string, unknown>): Recommendation {
  return { label: type, action: { type, payload } };
}

describe("recPath — coach recommendation routing", () => {
  it("routes drill to /drills with the q_type query", () => {
    expect(recPath(rec("drill", { q_type: "Flaw" }))).toBe("/drills?q_type=Flaw");
  });

  it("encodes the q_type and tolerates a missing payload", () => {
    expect(recPath(rec("drill", { q_type: "Necessary Assumption" }))).toBe(
      "/drills?q_type=Necessary%20Assumption",
    );
    expect(recPath(rec("drill"))).toBe("/drills?q_type=");
  });

  it("routes srs to /srs and analytics to /analytics", () => {
    expect(recPath(rec("srs"))).toBe("/srs");
    expect(recPath(rec("analytics", { view: "calibration" }))).toBe("/analytics");
  });

  it("routes the new blind_review action to /review", () => {
    expect(recPath(rec("blind_review"))).toBe("/review");
  });

  it("routes the new start_section action to /practice", () => {
    expect(recPath(rec("start_section"))).toBe("/practice");
  });

  it("falls back to /practice for an unknown action type", () => {
    expect(recPath(rec("totally_new_thing"))).toBe("/practice");
  });
});
