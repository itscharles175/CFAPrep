import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient } from "@/test/setup";
import { TodayPlan } from "./TodayPlan";

const mocks = vi.hoisted(() => ({
  useSrsDue: vi.fn(),
  useDashboard: vi.fn(),
  useTodayPlan: vi.fn(),
  diagnose: vi.fn(),
  todayFeedback: vi.fn(),
}));

vi.mock("@/lib/hooks", () => ({
  useSrsDue: mocks.useSrsDue,
  useDashboard: mocks.useDashboard,
  useTodayPlan: mocks.useTodayPlan,
}));

vi.mock("@/lib/api", () => ({
  api: {
    diagnose: mocks.diagnose,
    todayFeedback: mocks.todayFeedback,
  },
}));

function query<T>(data: T) {
  return {
    data: { data, usingSample: false },
    refetch: vi.fn(),
    isError: false,
  };
}

function renderTodayPlan() {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={createTestQueryClient()}>
        <TodayPlan />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("TodayPlan notebook context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.diagnose.mockResolvedValue(null);
    mocks.todayFeedback.mockResolvedValue({
      id: 1,
      kind: "daily_plan_task_feedback",
      status: "done",
      title: "complete: Drill Flaw",
      detail: {},
      entity: "study_plan",
      entity_id: null,
      progress_pct: 100,
      created_at: "2026-06-12T00:00:00Z",
      updated_at: "2026-06-12T00:00:00Z",
    });
    mocks.useSrsDue.mockReturnValue(query({ due_count: 0 }));
    mocks.useDashboard.mockReturnValue(query({ coach: {}, weakest_types: [] }));
    mocks.useTodayPlan.mockReturnValue(
      query({
        has_plan: true,
        target_score: 170,
        exam_date: null,
        daily_minutes: 60,
        days_to_exam: null,
        predicted_score: null,
        forecast: {},
        due_count: 0,
        weakest_types: [],
        tasks: [
          {
            type: "drill",
            label: "Drill Flaw",
            q_type: "Flaw",
            est_minutes: 15,
            utility_score: 0.84,
            utility_model: "ability_engine_v2",
            selector_utility_model: "ability_engine_v2_utility_v1",
            target_difficulty: 0.62,
            feedback_evidence: {
              model: "ability_feedback_v1",
              total: 3,
              complete: 2,
              skip: 1,
              completion_rate: 0.6667,
              label: "Accepted 67%",
              impact: [
                {
                  key: "cadence",
                  status: "reinforced",
                  value: 0.6667,
                },
              ],
            },
            notebook_context: {
              count: 1,
              notes: ["Flaw tells: scope shift"],
              items: [
                {
                  kind: "note",
                  id: 42,
                  title: "Flaw tells",
                  reason: "q_type",
                },
              ],
            },
          },
        ],
        utility: {
          model: "ability_engine_v2_utility_v1",
          days: 180,
          weights: {},
          score: 0.58,
          signals: {
            mastery_gap: 0.46,
            uncertainty_pressure: 0.21,
            srs_pressure: 0,
            blind_review_pressure: 0,
          },
        },
      }),
    );
  });

  it("renders notebook context chips under server plan tasks", () => {
    renderTodayPlan();

    expect(screen.getByText("Drill Flaw")).toBeInTheDocument();
    expect(screen.getByText("Notebook · Flaw tells")).toBeInTheDocument();
    expect(screen.getByText("Priority 84")).toBeInTheDocument();
    expect(screen.getByText("Mastery gap 46%")).toBeInTheDocument();
    expect(screen.getByText("Uncertainty 21%")).toBeInTheDocument();
    expect(screen.getByText("Accepted 67%")).toBeInTheDocument();
  });

  it("persists utility-ranked task completion feedback", async () => {
    const user = userEvent.setup();
    renderTodayPlan();

    await user.click(
      screen.getByRole("checkbox", { name: 'Mark "Drill Flaw" done' }),
    );

    expect(mocks.todayFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: "drill-Flaw",
        task_type: "drill",
        task_label: "Drill Flaw",
        action: "complete",
        minutes: 15,
        q_type: "Flaw",
        utility_score: 0.84,
        utility_model: "ability_engine_v2_utility_v1",
        target_difficulty: 0.62,
        tradeoffs: ["Mastery gap 46%", "Uncertainty 21%", "Accepted 67%"],
      }),
    );
  });
});
