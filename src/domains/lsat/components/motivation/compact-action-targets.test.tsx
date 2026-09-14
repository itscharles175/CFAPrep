import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProgressLedger } from "./progress-ledger";
import { MasteryMatrix } from "@lsat/components/viz/MasteryMatrix";
import { SessionRecap } from "./SessionRecap";
import type { SessionResults } from "@lsat/lib/types";

vi.mock("./confetti", () => ({ celebratePersonalBest: vi.fn() }));
vi.mock("@lsat/lib/prefs", () => ({ getBestScore: () => null, recordScore: () => false }));

const recapResults = {
  session: { id: 1, type: "drill", started: "2026-09-14T12:00:00Z" },
  items: [
    {
      question: {
        id: 1,
        section_id: 1,
        passage_id: null,
        prompt: "Prompt",
        stem: "Stem",
        q_type: "Flaw",
        difficulty: 3,
        source: "sample",
        choices: [],
      },
      attempt: {
        attempt_id: 1,
        chosen_answer: "A",
        br_answer: "A",
        is_correct: true,
        br_correct: true,
        time_ms: 60_000,
        outcome: "timed_ok",
      },
    },
  ],
} as SessionResults;

describe("compact action targets", () => {
  it("lets recap exports wrap while retaining 40px targets", () => {
    render(<SessionRecap results={recapResults} />);

    expect(screen.getByTestId("session-recap-actions")).toHaveClass("flex-wrap");
    for (const name of ["PNG", "SVG", "Preview card", "Print"]) {
      expect(screen.getByRole("button", { name })).toHaveClass("min-h-10");
    }
  });

  it("keeps dashboard share and error-log drill actions at the touch target floor", () => {
    const onSelect = vi.fn();
    const onDrill = vi.fn();
    const { rerender } = render(
      <ProgressLedger
        byType={[]}
        sessions={[]}
        predictedScore={null}
        unlockedIds={["first-section"]}
      />,
    );

    expect(screen.getByRole("button", { name: "Share First timed section" })).toHaveClass("min-h-10");

    rerender(
      <MasteryMatrix
        rows={[{ q_type: "Flaw", accuracy: 0.75, avgTimeMs: 60_000, volume: 12 }]}
        onSelect={onSelect}
        onDrill={onDrill}
      />,
    );

    const drill = screen.getByRole("button", { name: "Drill Flaw in error log" });
    expect(drill).toHaveClass("h-10", "w-10");
    fireEvent.click(drill);
    expect(onDrill).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
