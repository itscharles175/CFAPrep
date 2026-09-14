import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Practice from "./Practice";

const mocks = vi.hoisted(() => ({
  usePrepTests: vi.fn(),
  usePrepTest: vi.fn(),
  useSrsDue: vi.fn(),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({}),
}));

vi.mock("@lsat/lib/hooks", () => ({
  prefetchPrepTest: vi.fn(),
  prefetchSection: vi.fn(),
  usePrepTests: mocks.usePrepTests,
  usePrepTest: mocks.usePrepTest,
  useSrsDue: mocks.useSrsDue,
}));

vi.mock("@lsat/components/page-layout", () => ({
  PageLayout: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <main><h1>{title}</h1>{children}</main>
  ),
}));
vi.mock("@lsat/components/practice/resume-banner", () => ({ ResumeBanner: () => null }));
vi.mock("@lsat/components/practice/study-pt-wizard", () => ({ StudyPtWizard: () => null }));
vi.mock("@lsat/components/states", () => ({
  ErrorState: () => <div>Error</div>,
  SkeletonListPage: () => <div>Loading</div>,
}));

const query = (data: unknown, usingSample = false) => ({
  data: { data, usingSample },
  isLoading: false,
  isError: false,
  error: null,
  refetch: vi.fn(),
});

describe("Practice sample provenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.usePrepTests.mockReturnValue(query([{ id: 73, name: "Sample Diagnostic" }], true));
    mocks.usePrepTest.mockReturnValue(query({ id: 73, name: "Sample Diagnostic", sections: [] }, true));
    mocks.useSrsDue.mockReturnValue(query({ due_count: 14 }, true));
  });

  it("does not present fallback diagnostics or SRS counts as actionable learner work", () => {
    render(<MemoryRouter><Practice /></MemoryRouter>);

    expect(screen.getByText("Sample data excluded")).toBeInTheDocument();
    expect(screen.getByText(/Practice is unavailable while the LSAT backend is offline/i)).toBeInTheDocument();
    expect(screen.queryByText("Sample Diagnostic")).not.toBeInTheDocument();
    expect(screen.queryByText(/14 SRS due/i)).not.toBeInTheDocument();
  });
});
