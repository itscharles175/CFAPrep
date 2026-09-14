import { describe, expect, it } from "vitest";
import { SOURCE_SCOPE_GUIDANCE, sourceScopeActionState } from "./Notebook";

describe("Notebook source scope actions", () => {
  it("keeps transformations and cited chats blocked until a source is selected", () => {
    expect(sourceScopeActionState(null)).toEqual({
      ready: false,
      guidance: SOURCE_SCOPE_GUIDANCE,
    });
  });

  it("enables source-grounded actions when a citation is selected", () => {
    expect(
      sourceScopeActionState({
        target: "artifact:12",
        label: "Argument structure notes",
        target_kind: "artifact",
        official_firewall: false,
      }),
    ).toEqual({ ready: true, guidance: null });
  });
});
