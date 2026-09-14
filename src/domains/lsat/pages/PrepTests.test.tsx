import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PrepTests from "./PrepTests";

const mocks = vi.hoisted(() => ({
  usePrepTests: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("@lsat/lib/hooks", () => ({
  usePrepTests: mocks.usePrepTests,
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <PrepTests />
    </MemoryRouter>,
  );
}

describe("PrepTests availability state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.refetch.mockResolvedValue({});
  });

  it("does not present fallback tests as imported learner data", () => {
    mocks.usePrepTests.mockReturnValue({
      data: { data: [{ id: 1, name: "Sample PT", section_count: 4, completed_sections: 0 }], usingSample: true },
      isLoading: false,
      isError: false,
      error: null,
      refetch: mocks.refetch,
    });

    renderPage();

    expect(screen.getByText("PrepTests is unavailable while the LSAT backend is offline.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText("Sample PT")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Start full timed exam/i })).not.toBeInTheDocument();
  });

  it("keeps a genuine empty imported bank distinct from offline fallback", () => {
    mocks.usePrepTests.mockReturnValue({
      data: { data: [], usingSample: false },
      isLoading: false,
      isError: false,
      error: null,
      refetch: mocks.refetch,
    });

    renderPage();

    expect(screen.getByText("No PrepTests yet")).toBeInTheDocument();
    expect(screen.queryByText(/unavailable while the LSAT backend/i)).not.toBeInTheDocument();
  });
});
