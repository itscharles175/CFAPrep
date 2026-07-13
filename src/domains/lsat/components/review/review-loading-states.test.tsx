import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorLogWorkspace } from "./error-log-workspace";
import { FlaggedQueue } from "./flagged-queue";

const hookMocks = vi.hoisted(() => ({
  useErrorLog: vi.fn(),
  useMultiSessionResults: vi.fn(),
  useSessions: vi.fn(),
}));

type QueryLike = {
  data?: unknown;
  error?: Error | null;
  isError?: boolean;
  isLoading?: boolean;
  isPlaceholderData?: boolean;
  refetch?: () => unknown;
};

vi.mock("@lsat/lib/hooks", () => ({
  unwrap: (query: QueryLike) => {
    const envelope = query.data as
      | { data?: unknown; usingSample?: boolean }
      | undefined;
    return {
      data: envelope && "data" in envelope ? envelope.data : query.data,
      error: query.error ?? null,
      isError: query.isError ?? false,
      isLoading: query.isLoading ?? false,
      isPlaceholderData: query.isPlaceholderData ?? false,
      refetch: query.refetch ?? vi.fn(),
      usingSample: envelope?.usingSample ?? false,
    };
  },
  useErrorLog: () => hookMocks.useErrorLog(),
  useSessions: () => hookMocks.useSessions(),
}));

vi.mock("@lsat/lib/hooks/useReviewSessions", () => ({
  reviewableSessions: (sessions: unknown[]) => sessions,
  useMultiSessionResults: (...args: unknown[]) =>
    hookMocks.useMultiSessionResults(...args),
}));

describe("review loading states", () => {
  beforeEach(() => {
    hookMocks.useErrorLog.mockReset();
    hookMocks.useMultiSessionResults.mockReset();
    hookMocks.useSessions.mockReset();
  });

  it("shows an accessible loading state for flagged questions", () => {
    hookMocks.useSessions.mockReturnValue({
      data: [{ id: 11, scaled_score: 165 }],
      error: null,
      isError: false,
      isLoading: false,
      refetch: vi.fn(),
    });
    hookMocks.useMultiSessionResults.mockReturnValue({
      isError: false,
      isLoading: true,
      queries: [],
      resultsBySessionId: new Map(),
    });

    render(
      <MemoryRouter>
        <FlaggedQueue />
      </MemoryRouter>,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading flagged questions",
    );
  });

  it("shows an accessible loading state for the error log", () => {
    hookMocks.useErrorLog.mockReturnValue({
      data: undefined,
      error: null,
      isError: false,
      isLoading: true,
      refetch: vi.fn(),
    });

    render(
      <MemoryRouter>
        <ErrorLogWorkspace />
      </MemoryRouter>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Loading error log");
  });
});
