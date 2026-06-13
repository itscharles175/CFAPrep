import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEYBOARD_MAP,
  resolveBrKey,
  resolveExamKey,
} from "./keyboardMap";

function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  // jsdom KeyboardEvent works; we only read .key / .shiftKey / preventDefault.
  return new KeyboardEvent("keydown", init);
}

describe("resolveBrKey", () => {
  const map = DEFAULT_KEYBOARD_MAP;

  it("maps A–E to answer commits", () => {
    expect(resolveBrKey(key({ key: "a" }), map)).toEqual({
      kind: "answer",
      label: "A",
    });
    expect(resolveBrKey(key({ key: "C" }), map)).toEqual({
      kind: "answer",
      label: "C",
    });
  });

  it("maps 1/2/3 to confidence", () => {
    expect(resolveBrKey(key({ key: "1" }), map)).toEqual({
      kind: "confidence",
      value: "sure",
    });
    expect(resolveBrKey(key({ key: "2" }), map)).toEqual({
      kind: "confidence",
      value: "likely",
    });
    expect(resolveBrKey(key({ key: "3" }), map)).toEqual({
      kind: "confidence",
      value: "guess",
    });
  });

  it("maps R and Enter to reveal", () => {
    expect(resolveBrKey(key({ key: "r" }), map)).toEqual({ kind: "reveal" });
    expect(resolveBrKey(key({ key: "R" }), map)).toEqual({ kind: "reveal" });
    expect(resolveBrKey(key({ key: "Enter" }), map)).toEqual({ kind: "reveal" });
  });

  it("does not treat shift+E (eliminate) or unknown keys as a BR action", () => {
    expect(resolveBrKey(key({ key: "e", shiftKey: true }), map)).toBeNull();
    expect(resolveBrKey(key({ key: "z" }), map)).toBeNull();
    // Arrow nav is handled separately by the BR page.
    expect(resolveBrKey(key({ key: "ArrowLeft" }), map)).toBeNull();
  });

  it("leaves the timed-runner resolver behavior intact", () => {
    expect(resolveExamKey(key({ key: "f" }), map)).toBe("flag");
    expect(resolveExamKey(key({ key: "e", shiftKey: true }), map)).toBe(
      "eliminate",
    );
  });
});
