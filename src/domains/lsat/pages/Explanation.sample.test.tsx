import { MemoryRouter, Route, Routes } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Explanation from "./Explanation";

const mocks = vi.hoisted(() => ({
  useQuestion: vi.fn(),
  useSessionResults: vi.fn(),
  useAiHealth: vi.fn(),
}));

vi.mock("@lsat/lib/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lsat/lib/hooks")>()),
  useQuestion: mocks.useQuestion,
  useSessionResults: mocks.useSessionResults,
  useAiHealth: mocks.useAiHealth,
}));
vi.mock("@lsat/lib/mutations", () => ({
  useAddErrorLog: () => ({ mutate: vi.fn() }),
  useBulkSrsCards: () => ({ mutate: vi.fn() }),
  useExplainFeedback: () => ({ mutate: vi.fn(), isPending: false }),
}));

const query = (data: unknown, usingSample = false) => ({
  data: { data, usingSample },
  isLoading: false,
  isError: false,
  error: null,
  refetch: vi.fn(),
});

describe("Explanation provenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useQuestion.mockReturnValue(query({ id: 7, choices: [], correct_answer: "A" }, true));
    mocks.useSessionResults.mockReturnValue(query({ items: [] }));
    mocks.useAiHealth.mockReturnValue(query({ provider: "ollama" }));
  });

  it("stops before exposing fallback answer or source material", () => {
    render(
      <MemoryRouter initialEntries={["/explanation/7"]}>
        <Routes>
          <Route path="/explanation/:questionId" element={<Explanation />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("Sample data excluded")).toBeInTheDocument();
    expect(screen.getByText("Explanation is unavailable while the LSAT backend is offline.")).toBeInTheDocument();
    expect(screen.queryByText(/Explain my answer/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Per-choice breakdown/i)).not.toBeInTheDocument();
  });
});
