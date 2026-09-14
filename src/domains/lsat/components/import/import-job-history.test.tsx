import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImportJobHistory } from "./import-job-history";
import type { ImportJobSummary } from "@lsat/lib/types";

const apiMocks = vi.hoisted(() => ({
  listImportJobs: vi.fn(),
}));

vi.mock("@lsat/lib/api", () => ({
  api: {
    listImportJobs: apiMocks.listImportJobs,
  },
}));

function job(overrides: Partial<ImportJobSummary> = {}): ImportJobSummary {
  return {
    committed: false,
    created_at: "2026-05-26T00:00:00Z",
    filename: "PT 90.pdf",
    job_id: 90,
    preptest_id: null,
    warnings: [],
    ...overrides,
  };
}

describe("ImportJobHistory", () => {
  beforeEach(() => {
    apiMocks.listImportJobs.mockReset();
  });

  it("shows an accessible loading state while jobs are fetched", () => {
    apiMocks.listImportJobs.mockReturnValue(new Promise(() => {}));

    render(<ImportJobHistory onResume={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading import history",
    );
  });

  it("shows a stable empty state when there are no import jobs", async () => {
    apiMocks.listImportJobs.mockResolvedValue([]);

    render(<ImportJobHistory onResume={vi.fn()} />);

    expect(await screen.findByText("No import jobs yet")).toBeInTheDocument();
  });

  it("lets an interrupted import be resumed by job id", async () => {
    const onResume = vi.fn();
    apiMocks.listImportJobs.mockResolvedValue([job()]);

    render(<ImportJobHistory onResume={onResume} />);

    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));

    expect(onResume).toHaveBeenCalledWith(90);
  });

  it("surfaces a retry path when import history cannot be loaded", async () => {
    apiMocks.listImportJobs
      .mockRejectedValueOnce(new Error("backend unavailable"))
      .mockResolvedValueOnce([job({ job_id: 91, filename: "PT 91.pdf" })]);

    render(<ImportJobHistory onResume={vi.fn()} />);

    expect(
      await screen.findByText("Could not load import history"),
    ).toBeInTheDocument();

    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry).toHaveClass("min-h-10");

    fireEvent.click(retry);

    expect(await screen.findByText("PT 91.pdf")).toBeInTheDocument();
  });
});
