import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReadinessCard } from "./readiness-card";
import type { ReadinessStatus } from "@/lib/types";

describe("ReadinessCard", () => {
  it("prefers backend Ability Engine readiness over local heuristic inputs", () => {
    const backendReadiness = {
      section_type: null,
      readiness_score: 67.4,
      status: "building",
      on_track: null,
      predicted_scaled_score: null,
      components: {
        mastery: 0.7,
        accuracy: 0.68,
        blind_review_control: 0.74,
        evidence: 0.55,
        srs_load: 0.85,
        attempts_90d: 72,
        due_srs: 4,
      },
      ability: {
        q_type: null,
        section_type: null,
        ability: 0,
        mastery: 0.7,
        uncertainty: 0.2,
        evidence_n: 72,
        accuracy: 0.68,
        avg_time_ms: null,
        components: {},
      },
      ability_selector: {
        model: "ability_engine_v2",
        theta: 0.42,
        q_type: null,
        section_type: null,
        days: 180,
        zpd: {
          target_difficulty: 3.6,
          lower_difficulty: 2.8,
          upper_difficulty: 4.4,
          target_success_window: [0.42, 0.78],
        },
        srs: { total: 12, due: 4, concept_gap: 3, leech: 1 },
        strategy: "zpd_repair",
        utility_model: "ability_engine_v2_utility_v1",
        utility_weights: {},
        utility: {
          model: "ability_engine_v2_utility_v1",
          days: 180,
          weights: {},
          score: 0.73,
          signals: {
            theta: 0.42,
            mastery: 0.7,
            srs_pressure: 0.2,
          },
          cadence: {
            attempts: 72,
            window_days: 180,
            evidence_density: 0.4,
          },
        },
        evidence: {},
        ability: {
          q_type: null,
          section_type: null,
          ability: 0.42,
          mastery: 0.7,
          uncertainty: 0.2,
          evidence_n: 72,
          accuracy: 0.68,
          avg_time_ms: null,
          components: {},
        },
      },
    } satisfies ReadinessStatus;

    render(
      <ReadinessCard
        streakDays={30}
        srsDue={0}
        timedAccuracy={0.95}
        brGap={0}
        sessionsLast7d={7}
        predictedScore={178}
        readiness={backendReadiness}
      />,
    );

    expect(screen.getByText("Exam readiness")).toBeInTheDocument();
    expect(screen.getByText("67")).toBeInTheDocument();
    expect(screen.getByText("Mastery")).toBeInTheDocument();
    expect(screen.getByText("BR control")).toBeInTheDocument();
    expect(screen.getByText(/Building/)).toBeInTheDocument();
    expect(screen.getByText("Ability selector")).toBeInTheDocument();
    expect(screen.getByText("zpd repair")).toBeInTheDocument();
    expect(screen.getByText("Theta")).toBeInTheDocument();
    expect(screen.getByText("0.42")).toBeInTheDocument();
    expect(screen.getByText("ZPD target")).toBeInTheDocument();
    expect(screen.getByText("3.6")).toBeInTheDocument();
    expect(screen.getByText("Utility")).toBeInTheDocument();
    expect(screen.getByText("73%")).toBeInTheDocument();
  });
});
