import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import Dashboard from "./Dashboard";

const mocks = vi.hoisted(() => ({
  refetch: vi.fn(async () => undefined),
}));

vi.mock("@lsat/lib/hooks", () => ({
  useActivity: () => ({}),
  useAdaptivityPlan: () => ({}),
  useBlindReviewGap: () => ({}),
  useByType: () => ({}),
  useCoach: () => ({}),
  useContentHealth: () => ({}),
  useDashboard: () => ({
    data: { data: {}, usingSample: true },
    isError: false,
    isLoading: false,
    refetch: mocks.refetch,
  }),
  useForecast: () => ({}),
  useReadinessStatus: () => ({}),
  useReleaseTrust: () => ({}),
  useSessionResults: () => ({}),
  useSessions: () => ({}),
  useSrsDue: () => ({}),
}));

vi.mock("@lsat/lib/prefs", () => ({
  getGoal: () => ({ targetScore: 167, examDate: "2026-11-14" }),
}));

describe("Dashboard sample provenance", () => {
  it("keeps the real saved goal while excluding offline fixture metrics", () => {
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    expect(
      screen.getByText("LSAT dashboard is unavailable while the LSAT backend is offline."),
    ).toBeInTheDocument();
    expect(screen.getByText("Saved LSAT target")).toBeInTheDocument();
    expect(screen.getByText("167 · 2026-11-14")).toBeInTheDocument();
    expect(screen.queryByText("Predicted score")).not.toBeInTheDocument();
    expect(screen.queryByText("Adaptive cockpit")).not.toBeInTheDocument();
  });
});
