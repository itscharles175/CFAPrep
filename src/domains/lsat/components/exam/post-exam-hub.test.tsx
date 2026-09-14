import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refetch: vi.fn(),
  useSessionResults: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: null, isError: false }),
}));
vi.mock("@lsat/lib/hooks", () => ({ useSessionResults: mocks.useSessionResults }));
vi.mock("@lsat/components/exam/ceremony", () => ({
  Ceremony: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@lsat/components/analytics/outcome-funnel", () => ({
  OutcomeFunnel: () => <div>Outcome funnel</div>,
}));
vi.mock("@lsat/components/sample-data-recovery", () => ({
  SampleDataRecovery: ({ onRetry }: { onRetry: () => void }) => (
    <div>
      Sample data excluded
      <button type="button" onClick={onRetry}>Retry outcome</button>
    </div>
  ),
}));

import { PostExamHub } from "./post-exam-hub";

describe("PostExamHub", () => {
  it("does not render fixture outcomes as completed-exam evidence", () => {
    mocks.useSessionResults.mockReturnValue({
      data: {
        usingSample: true,
        data: { items: [{ attempt: { outcome: "concept_gap" } }] },
      },
      isError: false,
      refetch: mocks.refetch,
    });

    render(
      <MemoryRouter>
        <PostExamHub
          examName="PrepTest 101"
          sections={[]}
          sessionIds={{}}
          examSessionId={1}
          onBlindReview={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Sample data excluded")).toBeInTheDocument();
    expect(screen.queryByText("Outcome funnel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry outcome" }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });

  it("preserves actual outcomes", () => {
    mocks.useSessionResults.mockReturnValue({
      data: {
        usingSample: false,
        data: { items: [{ attempt: { outcome: "concept_gap" } }] },
      },
      isError: false,
      refetch: mocks.refetch,
    });

    render(
      <MemoryRouter>
        <PostExamHub
          examName="PrepTest 101"
          sections={[]}
          sessionIds={{}}
          examSessionId={1}
          onBlindReview={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Outcome funnel")).toBeInTheDocument();
    expect(screen.queryByText("Sample data excluded")).not.toBeInTheDocument();
  });
});
