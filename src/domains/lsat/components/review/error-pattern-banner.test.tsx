import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorPatternBanner } from "./error-pattern-banner";

const mocks = vi.hoisted(() => ({
  useErrorLog: vi.fn(),
  detectErrorPatterns: vi.fn(),
}));

vi.mock("@lsat/lib/hooks", () => ({
  useErrorLog: mocks.useErrorLog,
  unwrap: (query: {
    data?: { data: unknown; usingSample: boolean };
    refetch: () => unknown;
  }) => ({
    data: query.data?.data,
    usingSample: query.data?.usingSample ?? false,
    refetch: query.refetch,
  }),
}));
vi.mock("@lsat/lib/errorPatterns", () => ({
  detectErrorPatterns: mocks.detectErrorPatterns,
}));

const query = (data: unknown, usingSample = false) => ({
  data: { data, usingSample },
  isLoading: false,
  isError: false,
  isPlaceholderData: false,
  error: null,
  refetch: vi.fn(),
});

describe("ErrorPatternBanner provenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detectErrorPatterns.mockReturnValue([
      { count: 4, label: "trap" },
    ]);
  });

  it("does not calculate or display patterns from fallback error-log rows", () => {
    mocks.useErrorLog.mockReturnValue(query([{ reason: "trap" }], true));

    render(<ErrorPatternBanner />);

    expect(mocks.detectErrorPatterns).not.toHaveBeenCalled();
    expect(screen.getByText("Error patterns is unavailable while the LSAT backend is offline.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText(/4 trap errors/)).not.toBeInTheDocument();
  });

  it("shows recurring patterns only for live learner data", () => {
    mocks.useErrorLog.mockReturnValue(query([{ reason: "trap" }]));

    render(<ErrorPatternBanner />);

    expect(mocks.detectErrorPatterns).toHaveBeenCalledWith([{ reason: "trap" }]);
    expect(screen.getByRole("status")).toHaveTextContent("4 trap errors logged this week");
  });
});
