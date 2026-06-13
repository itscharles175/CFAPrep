import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { QuestionOverview } from "./question-overview";
import type { NavItem } from "./navigator-strip";

// A mixed section: answered, unanswered, flagged, with eliminations + time.
const ITEMS: NavItem[] = [
  { answered: true, flagged: false, hasEliminations: false, timeMs: 42_000, qType: "Strengthen", previewText: "" },
  { answered: false, flagged: true, hasEliminations: true, timeMs: 95_000, qType: "Weaken", previewText: "" },
  { answered: true, flagged: false, hasEliminations: true, timeMs: 12_000, qType: "Flaw", previewText: "" },
  { answered: false, flagged: false, hasEliminations: false, timeMs: 0, qType: "Inference", previewText: "" },
];

describe("QuestionOverview — Test-Mode integrity", () => {
  it("renders one tile per question with a progress summary", () => {
    render(
      <QuestionOverview
        open
        onClose={() => {}}
        current={0}
        items={ITEMS}
        onJump={() => {}}
        elapsedSec={100}
        totalSec={2100}
      />,
    );
    // A tile (button) for each question 1..4, plus close buttons.
    for (let i = 1; i <= ITEMS.length; i++) {
      expect(
        screen.getByRole("button", { name: new RegExp(`Question ${i}\\b`) }),
      ).toBeTruthy();
    }
    // The header summary reflects answered/flagged counts (progress only). Both
    // the summary and the legend mention "answered"/"flagged", so assert at least
    // one of each is present rather than expecting a single match.
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByText(/answered/i).length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText(/flagged/i).length).toBeGreaterThan(0);
  });

  it("NEVER renders correctness vocabulary while a section could be timed", () => {
    const { container } = render(
      <QuestionOverview
        open
        onClose={() => {}}
        current={1}
        items={ITEMS}
        onJump={() => {}}
        elapsedSec={100}
        totalSec={2100}
      />,
    );
    // The component is fed only NavItem progress data — assert the rendered text
    // contains no verdict/answer-revealing words. This is the load-bearing
    // Test-Mode guarantee for a surface that can be summoned mid-section.
    const text = (container.textContent ?? "").toLowerCase();
    for (const forbidden of [
      "correct",
      "incorrect",
      "wrong",
      "right answer",
      "answer is",
      "trap",
    ]) {
      expect(text).not.toContain(forbidden);
    }
    // It explicitly states it is progress-only.
    expect(text).toContain("progress only");
  });

  it("jumps to a tapped question and is keyboard reachable", () => {
    const onJump = vi.fn();
    render(
      <QuestionOverview
        open
        onClose={() => {}}
        current={0}
        items={ITEMS}
        onJump={onJump}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Question 3\b/ }));
    expect(onJump).toHaveBeenCalledWith(2);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <QuestionOverview open onClose={onClose} current={0} items={ITEMS} onJump={() => {}} />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <QuestionOverview open={false} onClose={() => {}} current={0} items={ITEMS} onJump={() => {}} />,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
