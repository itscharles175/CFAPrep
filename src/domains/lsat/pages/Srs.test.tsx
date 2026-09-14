import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient } from "@lsat/test/setup";
import Srs from "./Srs";

const mocks = vi.hoisted(() => ({ useSrsDue: vi.fn() }));

vi.mock("@lsat/lib/hooks", () => ({ useSrsDue: mocks.useSrsDue }));

function renderPage() {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={createTestQueryClient()}>
        <Srs />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("SRS availability state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useSrsDue.mockReturnValue({
      data: {
        data: {
          due_count: 14,
          cards: [
            {
              card_id: 1,
              origin: "attempt",
              q_type: "Weaken",
              stem: "Sample stem",
              prompt: "Sample prompt",
              choices: [],
              correct_answer: "A",
            },
          ],
        },
        usingSample: true,
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  it("blocks sample cards before the grading surface", () => {
    renderPage();

    expect(screen.getByText("SRS is unavailable while the LSAT backend is offline.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText("Sample prompt")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reveal & rate/i })).not.toBeInTheDocument();
  });
});
