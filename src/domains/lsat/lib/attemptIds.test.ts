import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attemptIdFor, clearAttemptIds } from "./attemptIds";

describe("attemptIds — stable client_attempt_id (5.2)", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("returns the SAME id for a (scope, question) across calls — a replay reuses it", () => {
    const scope = "section:42";
    const first = attemptIdFor(scope, 7);
    const replay = attemptIdFor(scope, 7);
    expect(first).toBe(replay);
    // looks like a uuid-ish token
    expect(first).toMatch(/[0-9a-f-]{8,}/i);
  });

  it("mints distinct ids per question within a scope", () => {
    const scope = "section:1";
    expect(attemptIdFor(scope, 1)).not.toBe(attemptIdFor(scope, 2));
  });

  it("isolates ids per scope (a different section never collides)", () => {
    expect(attemptIdFor("section:1", 5)).not.toBe(attemptIdFor("exam:1", 5));
  });

  it("persists across a simulated reload (re-reads from localStorage)", () => {
    const scope = "section:9";
    const id = attemptIdFor(scope, 3);
    // a fresh call (as after reload) reads the persisted map
    expect(attemptIdFor(scope, 3)).toBe(id);
  });

  it("mints a fresh id after the scope is cleared on submit", () => {
    const scope = "section:3";
    const before = attemptIdFor(scope, 1);
    clearAttemptIds(scope);
    const after = attemptIdFor(scope, 1);
    expect(after).not.toBe(before);
  });

  it("still returns an idempotency token with no durable scope", () => {
    const id = attemptIdFor(null, 1);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });
});
