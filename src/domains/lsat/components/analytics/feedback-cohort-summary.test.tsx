import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FeedbackCohortSummaryCard } from "./feedback-cohort-summary";
import type { FeedbackCohortSummary, FeedbackOutcomeSummary } from "@/lib/types";

const populated: FeedbackCohortSummary = {
  model: "daily_plan_feedback_cohorts_v1",
  window_days: 90,
  generated_at: "2026-06-13T00:00:00Z",
  total_events_seen: 4,
  total: 4,
  complete: 3,
  skip: 1,
  reopen: 0,
  completion_rate: 0.75,
  skip_rate: 0.25,
  reopen_rate: 0,
  minutes_completed: 45,
  avg_utility_score: 0.8,
  selector_adjustment: 0.04,
  status: "reinforcing",
  latest_at: "2026-06-13T00:00:00Z",
  by_q_type: {},
  by_task_type: {},
  outcome_evidence: {
    model: "ability_feedback_outcomes_v1",
    status: "observed",
    attempts_after_acceptance: 3,
    correct_after_acceptance: 2,
    accuracy_after_acceptance: 0.6667,
    q_types_with_outcomes: 1,
  },
  q_type_cohorts: [
    {
      q_type: "Flaw",
      total: 3,
      complete: 3,
      skip: 0,
      reopen: 0,
      completion_rate: 1,
      skip_rate: 0,
      reopen_rate: 0,
      minutes_completed: 45,
      avg_utility_score: 0.8,
      selector_adjustment: 0.08,
      status: "reinforcing",
      latest_at: "2026-06-13T00:00:00Z",
      drill_sequence_multiplier: 1.12,
      sequencing_hint: "sequence_forward",
      rank_score: 3.36,
      selector_policy: {
        model: "ability_feedback_policy_v1",
        window_days: 90,
        base_multiplier: 1,
        drill_sequence_multiplier: 1.12,
        selector_adjustment: 0.08,
        sequencing_hint: "sequence_forward",
        evidence_events: 3,
        accepted_events: 3,
        skipped_events: 0,
        status: "reinforcing",
      },
      outcome_evidence: {
        model: "ability_feedback_outcomes_v1",
        status: "improving",
        accepted_feedback_events: 3,
        attempts_after_acceptance: 3,
        correct_after_acceptance: 2,
        accuracy_after_acceptance: 0.6667,
        avg_time_ms_after_acceptance: 70000,
        baseline_attempts: 2,
        baseline_accuracy: 0.5,
        delta_accuracy: 0.1667,
        first_accepted_at: "2026-06-10T00:00:00Z",
        latest_attempt_at: "2026-06-12T00:00:00Z",
      },
    },
  ],
  task_type_cohorts: [],
  top_q_type: null,
};

const outcomeSummary: FeedbackOutcomeSummary = {
  model: "daily_plan_feedback_outcomes_v1",
  feedback_window_days: 90,
  outcome_window_days: 30,
  source: "official",
  min_attempts: 3,
  generated_at: "2026-06-13T00:00:00Z",
  total_feedback_events_seen: 4,
  qualifying_feedback_events: 3,
  cohorts: [
    {
      q_type: "Flaw",
      action: "complete",
      feedback_events: 3,
      first_feedback_at: "2026-06-10T00:00:00Z",
      latest_feedback_at: "2026-06-13T00:00:00Z",
      status: "improving",
      outcome_attempts: 3,
      correct_outcomes: 2,
      outcome_accuracy: 0.6667,
      avg_time_ms: 70000,
      baseline_attempts: 3,
      baseline_accuracy: 0.5,
      delta_accuracy: 0.1667,
      outcome_window_days: 30,
      min_attempts: 3,
      outcome_min_met: true,
      baseline_min_met: true,
      planner_weight_eligible: true,
      latest_attempt_at: "2026-06-12T00:00:00Z",
    },
  ],
  by_q_type: {
    Flaw: {
      q_type: "Flaw",
      actions: {
        complete: {
          q_type: "Flaw",
          action: "complete",
          feedback_events: 3,
          first_feedback_at: "2026-06-10T00:00:00Z",
          latest_feedback_at: "2026-06-13T00:00:00Z",
          status: "improving",
          outcome_attempts: 3,
          correct_outcomes: 2,
          outcome_accuracy: 0.6667,
          avg_time_ms: 70000,
          baseline_attempts: 3,
          baseline_accuracy: 0.5,
          delta_accuracy: 0.1667,
          outcome_window_days: 30,
          min_attempts: 3,
          outcome_min_met: true,
          baseline_min_met: true,
          planner_weight_eligible: true,
          latest_attempt_at: "2026-06-12T00:00:00Z",
        },
      },
      planner_weight_eligible: true,
    },
  },
  summary: {
    status: "planner_ready",
    cohort_count: 1,
    planner_ready_cohorts: 1,
    best_lift_q_type: "Flaw",
    best_lift_action: "complete",
    best_lift_delta: 0.1667,
  },
};

describe("FeedbackCohortSummaryCard", () => {
  it("renders an accessible loading state", () => {
    render(<FeedbackCohortSummaryCard isLoading />);

    expect(
      screen.getByRole("region", { name: "Plan feedback cohorts" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Plan feedback cohorts loading")).toBeInTheDocument();
  });

  it("renders an empty state before feedback exists", () => {
    render(
      <FeedbackCohortSummaryCard
        summary={{ ...populated, total: 0, q_type_cohorts: [], top_q_type: null }}
      />,
    );

    expect(screen.getByText("No plan feedback yet")).toBeInTheDocument();
  });

  it("renders the top cohort and percent metrics", () => {
    render(<FeedbackCohortSummaryCard summary={populated} />);

    expect(screen.getByText("90d")).toBeInTheDocument();
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getAllByText("Flaw")).toHaveLength(2);
    expect(screen.getAllByText("sequence forward")).toHaveLength(2);
    expect(screen.getAllByText("+12%")).toHaveLength(2);
    expect(screen.getByText("reinforcing")).toBeInTheDocument();
    expect(screen.getByText("Why selected")).toBeInTheDocument();
    expect(screen.getByText("3 events")).toBeInTheDocument();
    expect(screen.getByText("+8%")).toBeInTheDocument();
    expect(screen.getByText("Later outcomes")).toBeInTheDocument();
    expect(screen.getByText("improving")).toBeInTheDocument();
    expect(screen.getByText("67%")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("+17%")).toBeInTheDocument();
  });

  it("renders planner readiness from standalone outcome evidence", () => {
    render(
      <FeedbackCohortSummaryCard
        summary={populated}
        outcomeSummary={outcomeSummary}
      />,
    );

    expect(screen.getByText("Planner lift readiness")).toBeInTheDocument();
    expect(screen.getByText("planner ready")).toBeInTheDocument();
    expect(screen.getByText("Official")).toBeInTheDocument();
    expect(screen.getByText("3 + 3")).toBeInTheDocument();
    expect(screen.getAllByText("+17%")).toHaveLength(2);
    expect(
      screen.getByText(
        "Flaw accepted can inform future planner weights only when both baseline and later attempts meet the sample floor.",
      ),
    ).toBeInTheDocument();
  });
});
