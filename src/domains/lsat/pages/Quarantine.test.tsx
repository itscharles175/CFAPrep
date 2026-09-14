import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Quarantine from "./Quarantine";

const mocks = vi.hoisted(() => ({
  useGenQuarantine: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("@lsat/lib/hooks", () => ({
  useGenQuarantine: mocks.useGenQuarantine,
  unwrap: (query: unknown) => query,
}));

vi.mock("@lsat/lib/api", () => ({
  api: {
    genApprove: vi.fn(),
    quarantineTriage: vi.fn(),
  },
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <Quarantine />
    </MemoryRouter>,
  );
}

describe("Generation quarantine availability state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.refetch.mockResolvedValue({});
  });

  it("does not turn the offline empty fallback into a real quarantine queue", () => {
    mocks.useGenQuarantine.mockReturnValue({
      data: [],
      usingSample: true,
      isLoading: false,
      isError: false,
      error: null,
      refetch: mocks.refetch,
    });

    renderPage();

    expect(screen.getByText("Generation quarantine is unavailable while the LSAT backend is offline.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText("Quarantine empty")).not.toBeInTheDocument();
    expect(screen.queryByText(/questions remaining to review/i)).not.toBeInTheDocument();
  });

  it("shows a real empty state when the backend returns no pending questions", () => {
    mocks.useGenQuarantine.mockReturnValue({
      data: [],
      usingSample: false,
      isLoading: false,
      isError: false,
      error: null,
      refetch: mocks.refetch,
    });

    renderPage();

    expect(screen.getByText("Quarantine empty")).toBeInTheDocument();
    expect(screen.queryByText(/unavailable while the LSAT backend/i)).not.toBeInTheDocument();
  });
});
