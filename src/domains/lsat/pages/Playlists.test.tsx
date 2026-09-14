import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Playlists from "./Playlists";

const mocks = vi.hoisted(() => ({
  usePlaylists: vi.fn(),
  usePacingBudget: vi.fn(),
  mutate: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("@lsat/lib/hooks", () => ({
  usePlaylists: mocks.usePlaylists,
  usePacingBudget: mocks.usePacingBudget,
}));

vi.mock("@lsat/lib/mutations", () => ({
  useCreatePlaylist: () => ({ mutate: mocks.mutate }),
  useDeletePlaylist: () => ({ mutate: mocks.mutate }),
  usePlayPlaylist: () => ({ mutate: mocks.mutate }),
  useUpdatePlaylist: () => ({ mutate: mocks.mutate }),
}));

describe("Smart sets availability state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.usePlaylists.mockReturnValue({
      data: { data: [], usingSample: true },
      isLoading: false,
      isError: false,
      error: null,
      refetch: mocks.refetch,
    });
    mocks.usePacingBudget.mockReturnValue({
      data: { data: { budgets: [], over_budget_count: 0 } },
    });
  });

  it("distinguishes backend unavailability from a genuine empty set list", () => {
    render(
      <MemoryRouter>
        <Playlists />
      </MemoryRouter>,
    );

    expect(screen.getByText("Smart sets is unavailable while the LSAT backend is offline.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manual set" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New smart set" })).toBeDisabled();
    expect(screen.queryByText("No smart sets yet")).not.toBeInTheDocument();
  });
});
