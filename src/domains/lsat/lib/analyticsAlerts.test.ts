import { describe, expect, it } from "vitest";
import { formatRegressionAlertMessage } from "./analyticsAlerts";

describe("analyticsAlerts", () => {
  it("formats backend regression alerts with drop and recent accuracy", () => {
    const msg = formatRegressionAlertMessage([
      {
        q_type: "Flaw",
        section_type: "LR",
        recent_attempts: 8,
        baseline_attempts: 12,
        recent_correct: 2,
        baseline_correct: 10,
        recent_accuracy: 0.25,
        baseline_accuracy: 0.8333,
        delta: -0.5833,
        z_score: -2.7,
        statistically_significant: true,
        severity: "high",
        reason: "recent_accuracy_drop",
      },
    ]);

    expect(msg).toContain("Flaw");
    expect(msg).toContain("regressed");
    expect(msg).toContain("58 pts");
    expect(msg).toContain("25%");
  });
});
