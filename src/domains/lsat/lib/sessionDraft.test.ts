import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSessionDraft,
  draftKeyForExamSection,
  draftKeyForSection,
  loadSessionDraft,
  saveSessionDraft,
} from "./sessionDraft";
import { blankState, type QState } from "@lsat/components/question/section-runner";

function st(patch: Partial<QState>): QState {
  return { ...blankState(), ...patch };
}

describe("sessionDraft", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("derives stable, distinct scopes per section", () => {
    expect(draftKeyForSection(7)).toBe("section:7");
    expect(draftKeyForExamSection(7)).toBe("exam:7");
    expect(draftKeyForSection(7)).not.toBe(draftKeyForExamSection(7));
  });

  it("round-trips states (including the eliminated Set), index, timeLeft and deadline", () => {
    const scope = draftKeyForSection(42);
    const states: Record<number, QState> = {
      0: st({ answer: "B", flagged: true, timeMs: 1234, eliminated: new Set(["A", "C"]) }),
      1: st({ highlights: [{ start: 0, end: 4, color: "yellow" }] }),
    };
    saveSessionDraft(scope, { states, index: 1, timeLeft: 600, deadlineMs: 1_700_000 });

    const back = loadSessionDraft(scope);
    expect(back).not.toBeNull();
    expect(back!.index).toBe(1);
    expect(back!.timeLeft).toBe(600);
    expect(back!.deadlineMs).toBe(1_700_000);
    expect(back!.states[0].answer).toBe("B");
    expect(back!.states[0].flagged).toBe(true);
    expect(back!.states[0].timeMs).toBe(1234);
    expect(back!.states[0].eliminated).toBeInstanceOf(Set);
    expect([...back!.states[0].eliminated].sort()).toEqual(["A", "C"]);
    expect(back!.states[1].highlights).toEqual([{ start: 0, end: 4, color: "yellow" }]);
  });

  it("persists null timeLeft for untimed runs", () => {
    const scope = draftKeyForSection(1);
    saveSessionDraft(scope, { states: {}, index: 0, timeLeft: null });
    expect(loadSessionDraft(scope)!.timeLeft).toBeNull();
    expect(loadSessionDraft(scope)!.deadlineMs).toBeNull();
  });

  it("returns null after clearing", () => {
    const scope = draftKeyForSection(9);
    saveSessionDraft(scope, { states: { 0: blankState() }, index: 0, timeLeft: 1 });
    expect(loadSessionDraft(scope)).not.toBeNull();
    clearSessionDraft(scope);
    expect(loadSessionDraft(scope)).toBeNull();
  });

  it("returns null for an absent or corrupt draft", () => {
    expect(loadSessionDraft(draftKeyForSection(123))).toBeNull();
    localStorage.setItem("lsatlab.sessionDraft.section:5", "{not json");
    expect(loadSessionDraft(draftKeyForSection(5))).toBeNull();
  });
});
