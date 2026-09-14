import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeyboardSettings } from "./keyboard-settings";

const mocks = vi.hoisted(() => ({
  setKeyboardMap: vi.fn(),
  resetKeyboardMap: vi.fn(() => ({
    answer_A: "A",
    answer_B: "B",
    answer_C: "C",
    answer_D: "D",
    answer_E: "E",
    flag: "F",
    prev: "ArrowLeft",
    next: "ArrowRight",
  })),
}));

vi.mock("@lsat/lib/keyboardMap", () => ({
  actionLabel: (action: string) => action.replace("answer_", "Select ").replace("_", " "),
  getKeyboardMap: () => mocks.resetKeyboardMap(),
  resetKeyboardMap: mocks.resetKeyboardMap,
  setKeyboardMap: mocks.setKeyboardMap,
}));

vi.mock("@lsat/lib/toast", () => ({
  toast: { success: vi.fn() },
}));

describe("KeyboardSettings focus flow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lets Tab leave shortcut capture and reach the next field", async () => {
    const user = userEvent.setup();
    render(<KeyboardSettings />);

    const answerA = screen.getByRole("textbox", { name: "Select A" });
    const answerB = screen.getByRole("textbox", { name: "Select B" });
    answerA.focus();

    await user.tab();

    expect(answerB).toHaveFocus();
  });

  it("still captures a replacement key without inserting text", async () => {
    const user = userEvent.setup();
    render(<KeyboardSettings />);

    const answerA = screen.getByRole("textbox", { name: "Select A" });
    await user.click(answerA);
    await user.keyboard("q");

    expect(answerA).toHaveValue("q");
  });
});
