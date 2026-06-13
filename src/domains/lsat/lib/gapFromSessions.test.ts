import { describe, it, expect } from "vitest";
import { outcomeCountsForSessions } from "./gapFromSessions";
import type { Outcome, ResultItem, SessionSummary } from "./types";

function item(outcome: Outcome): ResultItem {
  return {
    question: { q_type: "Flaw" },
    attempt: { outcome, is_correct: outcome === "timed_ok" || outcome === "lucky", time_ms: 60000 },
  } as unknown as ResultItem;
}

function session(id: number): SessionSummary {
  return { id, type: "section", started: "2026-05-01T00:00:00Z" } as unknown as SessionSummary;
}

describe("outcomeCountsForSessions", () => {
  it("tallies the four timed→BR transitions across sessions", () => {
    const results = new Map<number, ResultItem[]>([
      [1, [item("timed_ok"), item("timed_ok"), item("timing_problem")]],
      [2, [item("concept_gap"), item("lucky")]],
    ]);
    const counts = outcomeCountsForSessions([session(1), session(2)], results);
    expect(counts).toEqual({
      timed_ok: 2,
      timing_problem: 1,
      concept_gap: 1,
      lucky: 1,
    });
  });

  it("ignores sessions with no loaded results", () => {
    const counts = outcomeCountsForSessions([session(9)], new Map());
    expect(counts).toEqual({ timed_ok: 0, lucky: 0, concept_gap: 0, timing_problem: 0 });
  });
});
