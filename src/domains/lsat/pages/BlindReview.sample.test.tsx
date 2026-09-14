import { MemoryRouter, Route, Routes } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BlindReview from "./BlindReview";

const mocks = vi.hoisted(() => ({
  useSessionResults: vi.fn(),
  setResume: vi.fn(),
}));

vi.mock("@lsat/lib/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lsat/lib/hooks")>()),
  useSessionResults: mocks.useSessionResults,
}));
vi.mock("@lsat/lib/resume", () => ({ setResume: mocks.setResume }));
vi.mock("@lsat/lib/mutations", () => ({
  useAddErrorLog: () => ({ mutate: vi.fn() }),
  useBulkSrsCards: () => ({ mutate: vi.fn() }),
}));

const query = (data: unknown, usingSample = false) => ({
  data: { data, usingSample },
  isLoading: false,
  isError: false,
  error: null,
  refetch: vi.fn(),
});

describe("BlindReview provenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useSessionResults.mockReturnValue(query({ items: [] }, true));
  });

  it("stops before exposing fallback answers as a blind-review worksheet", () => {
    render(
      <MemoryRouter initialEntries={["/blind-review/12"]}>
        <Routes>
          <Route path="/blind-review/:sessionId" element={<BlindReview />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("Sample data excluded")).toBeInTheDocument();
    expect(screen.getByText("Blind review is unavailable while the LSAT backend is offline.")).toBeInTheDocument();
    expect(screen.queryByText(/Your timed answer:/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reveal/i })).not.toBeInTheDocument();
  });
});
