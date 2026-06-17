import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { TrapPatternsAccordion } from "./trap-patterns-accordion";
import type { TrapPattern } from "@lsat/lib/types-lsat2";

const PATTERNS: TrapPattern[] = [
  {
    attempt_id: 101,
    question_id: 31,
    q_type: "Flaw",
    trap_type: "reversal",
    chosen_answer: "C",
    matched_by: "trap_type",
    similarity: 0.82,
    note_excerpt: "Read 'weakens' as 'strengthens' under time pressure.",
    created_at: "2026-06-01T12:00:00+00:00",
  },
  {
    attempt_id: 102,
    question_id: 18,
    q_type: "Strengthen",
    trap_type: "reversal",
    chosen_answer: "E",
    matched_by: "trap_type",
    similarity: null,
    note_excerpt: null,
    created_at: "2026-05-20T09:30:00+00:00",
  },
];

function renderAccordion(props?: Partial<React.ComponentProps<typeof TrapPatternsAccordion>>) {
  return render(
    <MemoryRouter>
      <TrapPatternsAccordion patterns={PATTERNS} {...props} />
    </MemoryRouter>,
  );
}

describe("TrapPatternsAccordion", () => {
  it("renders nothing when there are no patterns", () => {
    const { container } = render(
      <MemoryRouter>
        <TrapPatternsAccordion patterns={[]} />
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a collapsed disclosure with the pattern count by default", () => {
    renderAccordion();
    const toggle = screen.getByRole("button", { name: /see trap patterns/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The count badge reflects how many prior misses were retrieved.
    expect(within(toggle).getByText("2")).toBeInTheDocument();
  });

  it("toggles open then closed via the disclosure button", async () => {
    const user = userEvent.setup();
    renderAccordion();
    const toggle = screen.getByRole("button", { name: /see trap patterns/i });

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    // The panel the button controls is now revealed with both misses.
    const panelId = toggle.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    const region = screen.getByRole("region");
    expect(region).toBeVisible();
    expect(within(region).getByRole("button", { name: "Q31" })).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Q18" })).toBeInTheDocument();
    // The student's prior note is surfaced when present.
    expect(
      within(region).getByText(/read 'weakens' as 'strengthens'/i),
    ).toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("opens immediately when defaultOpen is set", () => {
    renderAccordion({ defaultOpen: true });
    const toggle = screen.getByRole("button", { name: /see trap patterns/i });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region")).toBeVisible();
  });
});
