import { describe, expect, it } from "vitest";
import {
  formatUtilityPriority,
  utilityScoreValue,
  utilityTradeoffs,
} from "./utilityTradeoffs";
import type { AbilityUtilityPacket } from "./types";

const utility = {
  model: "ability_engine_v2_utility_v1",
  days: 180,
  weights: {},
  score: 0.58,
  signals: {
    mastery_gap: 0.46,
    uncertainty_pressure: 0.21,
    srs_pressure: 0.34,
    blind_review_pressure: 0.18,
    fatigue_pressure: 0.09,
    cadence_pressure: 0.12,
  },
} satisfies AbilityUtilityPacket;

describe("utility tradeoff formatting", () => {
  it("formats task utility scores as compact priority labels", () => {
    expect(formatUtilityPriority({ utility_score: 0.84 })).toBe("Priority 84");
    expect(formatUtilityPriority({ utility: 1.3 })).toBe("Priority 100");
    expect(utilityScoreValue({ utility: 0.7 })).toBe(0.7);
  });

  it("explains drill ranking from mastery and uncertainty signals", () => {
    expect(
      utilityTradeoffs(
        { type: "drill", utility_score: 0.84, target_difficulty: 0.62 },
        utility,
      ),
    ).toEqual(["Mastery gap 46%", "Uncertainty 21%"]);
  });

  it("adds accepted-task feedback when the selector has evidence", () => {
    expect(
      utilityTradeoffs(
        {
          type: "drill",
          utility_score: 0.84,
          target_difficulty: 0.62,
          feedback_evidence: { total: 3, label: "Accepted 67%" },
        },
        utility,
      ),
    ).toEqual(["Mastery gap 46%", "Uncertainty 21%", "Accepted 67%"]);
  });

  it("falls back to generic selector signals when task kind is unknown", () => {
    expect(utilityTradeoffs({ type: "custom" }, utility)).toEqual([
      "Due review 34%",
      "Mastery gap 46%",
    ]);
  });
});
