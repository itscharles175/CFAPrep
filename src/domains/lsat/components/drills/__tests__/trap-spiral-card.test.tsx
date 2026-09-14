import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TrapSpiralCard } from "../trap-spiral-card";

const mocks = vi.hoisted(() => ({
  useByType: vi.fn(),
  useTraps: vi.fn(),
  mutate: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@lsat/lib/hooks", () => ({
  useByType: mocks.useByType,
  useTraps: mocks.useTraps,
}));

vi.mock("@lsat/lib/mutations", () => ({
  useCreateDrill: () => ({ mutate: mocks.mutate, isPending: false }),
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, useNavigate: () => mocks.navigate };
});

function renderCard() {
  return render(
    <MemoryRouter>
      <TrapSpiralCard />
    </MemoryRouter>,
  );
}

describe("TrapSpiralCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useTraps.mockReturnValue({
      data: {
        data: [{ trap_type: "reversal", times_fell_for: 14, pct: 0.31 }],
        usingSample: false,
      },
      refetch: vi.fn(),
    });
    mocks.useByType.mockReturnValue({
      data: {
        data: [{ section_type: "LR", q_type: "Parallel", accuracy: 0.61 }],
        usingSample: false,
      },
      refetch: vi.fn(),
    });
  });

  it("withholds sample trap and weakness evidence while offline", () => {
    mocks.useTraps.mockReturnValue({
      data: {
        data: [{ trap_type: "reversal", times_fell_for: 14, pct: 0.31 }],
        usingSample: true,
      },
      refetch: vi.fn(),
    });

    renderCard();

    expect(screen.getByText("Trap spiral is unavailable offline")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText("Top trap:")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start 5-question spiral" })).not.toBeInTheDocument();
  });

  it("keeps real trap evidence actionable", async () => {
    mocks.mutate.mockImplementation((_config: unknown, options: { onSuccess?: (result: unknown) => void }) => {
      options.onSuccess?.({ session_id: 77, questions: [] });
    });

    renderCard();
    expect(screen.getByText("Top trap:")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start 5-question spiral" }));
    expect(mocks.mutate).toHaveBeenCalled();
  });
});
