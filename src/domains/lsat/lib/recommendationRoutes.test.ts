import { describe, expect, it } from "vitest";

import { routeForRecommendation } from "./recommendationRoutes";

describe("routeForRecommendation", () => {
  it("deep-links adaptive coach actions to the right workspace", () => {
    expect(
      routeForRecommendation({
        label: "Drill Weaken",
        action: { type: "drill", payload: { q_type: "Weaken" } },
      }),
    ).toBe("/drills?q_type=Weaken");

    expect(
      routeForRecommendation({
        label: "Blind-review timing",
        action: { type: "blind_review", payload: { q_type: "Flaw" } },
      }),
    ).toBe("/review?tab=buckets&q_type=Flaw");

    expect(
      routeForRecommendation({
        label: "Review calibration",
        action: { type: "analytics", payload: { view: "calibration" } },
      }),
    ).toBe("/analytics?tab=gap");

    expect(
      routeForRecommendation({
        label: "Take a section",
        action: { type: "start_section", payload: {} },
      }),
    ).toBe("/practice");
  });
});
