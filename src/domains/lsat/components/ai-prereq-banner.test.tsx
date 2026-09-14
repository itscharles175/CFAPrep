import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiPrereqBanner } from "./ai-prereq-banner";

const mocks = vi.hoisted(() => ({
  useAiHealth: vi.fn(),
  refetch: vi.fn(),
  isAiPrereqDismissed: vi.fn(() => false),
  setAiPrereqDismissed: vi.fn(),
  offlineStatus: { offline: false, queueDepth: 0 },
}));

vi.mock("@lsat/lib/hooks", () => ({ useAiHealth: mocks.useAiHealth }));
vi.mock("@lsat/lib/prefs", () => ({
  isAiPrereqDismissed: mocks.isAiPrereqDismissed,
  setAiPrereqDismissed: mocks.setAiPrereqDismissed,
}));
vi.mock("@lsat/lib/offline", () => ({
  getOfflineStatus: () => mocks.offlineStatus,
  subscribeOfflineStatus: () => () => undefined,
}));

describe("AiPrereqBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useAiHealth.mockReturnValue({
      data: {
        data: {
          ollama: false,
          provider: "ollama",
          models: [],
        },
        usingSample: true,
      },
      refetch: mocks.refetch,
      isFetching: false,
    });
  });

  it("offers direct retry and settings actions when live AI is unavailable", async () => {
    render(
      <MemoryRouter>
        <AiPrereqBanner />
      </MemoryRouter>,
    );

    expect(screen.getByText("Live AI is off — running in sample-data mode")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveClass("lsat-ai-prereq-notice");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Open AI settings" })).toBeInTheDocument();
  });
});
