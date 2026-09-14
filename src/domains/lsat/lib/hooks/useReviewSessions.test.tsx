import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sessionResults: vi.fn(),
}));

vi.mock("../api", () => ({
  api: { sessionResults: mocks.sessionResults },
}));

import { useMultiSessionResults } from "./useReviewSessions";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useMultiSessionResults", () => {
  beforeEach(() => {
    mocks.sessionResults.mockReset();
  });

  it("keeps real results and marks only a failed session unavailable", async () => {
    mocks.sessionResults.mockImplementation((id: number) =>
      id === 12
        ? Promise.reject(new TypeError("Failed to fetch"))
        : Promise.resolve({ session: { id }, items: [{ question: { id: 101 }, attempt: {} }] }),
    );

    const { result } = renderHook(() => useMultiSessionResults([11, 12]), {
      wrapper,
    });

    await waitFor(() => expect(result.current.hasUnavailableResults).toBe(true));
    expect(result.current.resultsBySessionId.get(11)).toEqual([
      { question: { id: 101 }, attempt: {} },
    ]);
    expect(result.current.resultsBySessionId.has(12)).toBe(false);
    expect(result.current.unavailableSessionIds).toEqual([12]);
  });

  it("does not manufacture a fixture for any unavailable session", async () => {
    mocks.sessionResults.mockRejectedValue(new TypeError("Failed to fetch"));

    const { result } = renderHook(() => useMultiSessionResults([999]), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.resultsBySessionId.size).toBe(0);
    expect(result.current.unavailableSessionIds).toEqual([999]);
  });
});
