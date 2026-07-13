import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChoiceList } from "@lsat/components/question/choice-list";
import { ScratchPad } from "@lsat/components/exam/scratch-pad";
import { Progress } from "@lsat/components/ui/progress";
import type { Choice } from "@lsat/lib/types";

// Focused coverage for BUNDLE F1 — frontend ARIA fixes (#13, #15, #18, #19).
// These assert the accessible names / states the fixes introduce; they do not
// re-test unrelated component behavior.

const CHOICES: Choice[] = [
  { id: 1, label: "A", text: "The first answer choice" },
  { id: 2, label: "B", text: "The second answer choice" },
];

function renderChoices(over: Partial<React.ComponentProps<typeof ChoiceList>> = {}) {
  return render(
    <ChoiceList
      choices={CHOICES}
      selected={null}
      eliminated={new Set()}
      onSelect={() => {}}
      onToggleEliminate={() => {}}
      {...over}
    />,
  );
}

describe("#13 ChoiceList radio accessible name includes letter + text", () => {
  it("exposes both the letter and the choice text to the radio's name", () => {
    renderChoices();
    // Accessible name (via aria-labelledby) must contain the choice TEXT, not
    // just "Choice A" — that was the bug.
    const radio = screen.getByRole("radio", { name: /first answer choice/i });
    expect(radio).toBeInTheDocument();
    // ...and the letter is still part of the name.
    expect(radio).toHaveAccessibleName(/A/);
  });

  it("announces eliminated state as part of the name", () => {
    renderChoices({ eliminated: new Set(["A"]) });
    const radio = screen.getByRole("radio", { name: /first answer choice/i });
    expect(radio).toHaveAccessibleName(/eliminated/i);
  });
});

describe("#15 ChoiceList eliminate button is named", () => {
  it("gives the icon-only eliminate button an aria-label naming the choice", () => {
    renderChoices();
    expect(
      screen.getByRole("button", { name: "Eliminate choice A" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Eliminate choice B" }),
    ).toBeInTheDocument();
  });
});

describe("#19 Progress forwards aria attributes", () => {
  it("passes aria-label / aria-valuetext through to the Radix root", () => {
    render(
      <Progress value={42} aria-label="Mastery" aria-valuetext="42 percent" />,
    );
    const bar = screen.getByRole("progressbar", { name: "Mastery" });
    expect(bar).toHaveAttribute("aria-valuetext", "42 percent");
  });
});

describe("#18 ScratchPad disclosure + toggles + canvas are accessible", () => {
  it("disclosure button reflects aria-expanded and points at its panel", () => {
    render(<ScratchPad sectionId={7} />);
    const disclosure = screen.getByRole("button", { name: /scratch pad/i });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(disclosure).toHaveAttribute("aria-controls", "scratch-panel-7");

    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    // The controlled panel now exists with the referenced id.
    expect(document.getElementById("scratch-panel-7")).toBeInTheDocument();
  });

  it("Notes/Draw toggles expose aria-pressed and the canvas is named", () => {
    render(<ScratchPad sectionId={7} />);
    fireEvent.click(screen.getByRole("button", { name: /scratch pad/i }));

    const notes = screen.getByRole("button", { name: "Notes" });
    const draw = screen.getByRole("button", { name: "Draw" });
    // Default tab is "text" → Notes pressed, Draw not.
    expect(notes).toHaveAttribute("aria-pressed", "true");
    expect(draw).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(draw);
    expect(draw).toHaveAttribute("aria-pressed", "true");
    expect(notes).toHaveAttribute("aria-pressed", "false");

    // Canvas (Draw tab) carries the accessible label.
    const canvas = screen.getByLabelText("Scratch drawing canvas");
    expect(canvas.tagName).toBe("CANVAS");
  });
});
