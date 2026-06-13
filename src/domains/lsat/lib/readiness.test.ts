import { describe, it, expect } from "vitest";
import { computeReadiness, liveReadinessStatus, readinessFromStatus } from "./readiness";
import type { ReadinessStatus } from "./types";

describe("computeReadiness", () => {
  it("rates a strong profile 'On track' with all rings high", () => {
    const r = computeReadiness({
      streakDays: 10,
      srsDue: 5,
      timedAccuracy: 0.82,
      brGap: 0.02,
      sessionsLast7d: 4,
    });
    expect(r.label).toBe("On track");
    expect(r.score).toBeGreaterThanOrEqual(75);
    expect(r.rings).toHaveLength(4);
    for (const ring of r.rings) {
      expect(ring.value).toBeGreaterThanOrEqual(0);
      expect(ring.value).toBeLessThanOrEqual(1);
    }
  });

  it("maps a large BR gap to a low consistency ring", () => {
    const r = computeReadiness({
      streakDays: 0,
      srsDue: 50,
      timedAccuracy: 0.4,
      brGap: 0.2,
      sessionsLast7d: 0,
    });
    const consistency = r.rings.find((x) => x.name === "Consistency");
    expect(consistency?.value).toBe(0); // 1 - 0.2/0.12, clamped to 0
    expect(r.label).toBe("Needs focus");
  });

  it("clamps ring values to [0,1]", () => {
    const r = computeReadiness({
      streakDays: 99,
      srsDue: 0,
      timedAccuracy: 1.5, // out of range on purpose
      brGap: -0.1,
      sessionsLast7d: 99,
    });
    expect(r.rings.every((x) => x.value >= 0 && x.value <= 1)).toBe(true);
  });

  it("prefers backend Ability Engine readiness when provided", () => {
    const backend = {
      readiness_score: 67.4,
      status: "building",
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
      section_type: null,
      on_track: null,
      predicted_scaled_score: null,
    } satisfies ReadinessStatus;

    const result = readinessFromStatus(backend, {
      streakDays: 0,
      srsDue: 99,
      timedAccuracy: 0,
      brGap: 1,
      sessionsLast7d: 0,
    });

    expect(result.score).toBe(67);
    expect(result.label).toBe("Building");
    expect(result.rings.map((ring) => ring.name)).toEqual([
      "Mastery",
      "Accuracy",
      "BR control",
      "SRS health",
    ]);
    expect(result.factors.find((factor) => factor.name === "Evidence")?.ok).toBe(true);
  });

  it("uses backend exam simulation checks when available", () => {
    const backend = {
      readiness_score: 82,
      status: "ready",
      exam_ready: false,
      components: {
        mastery: 0.8,
        accuracy: 0.78,
        blind_review_control: 0.85,
        evidence: 0.75,
        srs_load: 0.9,
        attempts_90d: 90,
        due_srs: 2,
      },
      ability: {
        q_type: null,
        section_type: null,
        ability: 0.5,
        mastery: 0.8,
        uncertainty: 0.15,
        evidence_n: 90,
        accuracy: 0.78,
        avg_time_ms: null,
        components: {},
      },
      section_type: null,
      on_track: null,
      predicted_scaled_score: 168,
      exam_simulation: {
        model: "exam_readiness_v1",
        exam_ready: false,
        status: "at_risk",
        target_score: 170,
        exam_date: "2026-08-01",
        horizon_days: 51,
        current_score: 166,
        projected_score: 169,
        readiness_score: 82,
        checks: [
          {
            key: "forecast",
            label: "Forecast to target",
            status: "watch",
            ok: false,
            detail: "Projected 169 vs target 170",
            threshold: "projected score reaches target",
            action: "Add timed sections.",
          },
        ],
        blockers: [],
        warnings: [],
        summary: "0 blocker(s), 1 watch item(s)",
      },
    } satisfies ReadinessStatus;

    const result = readinessFromStatus(backend, {
      streakDays: 0,
      srsDue: 99,
      timedAccuracy: 0,
      brGap: 1,
      sessionsLast7d: 0,
    });

    expect(result.label).toBe("Building");
    expect(result.factors).toEqual([
      {
        name: "Forecast to target",
        ok: false,
        detail: "Projected 169 vs target 170",
      },
    ]);
  });

  it("only exposes live backend readiness from fallback-enabled query envelopes", () => {
    const backend = {
      readiness_score: 74,
      status: "building",
      components: {
        mastery: 0.74,
        accuracy: 0.7,
        blind_review_control: 0.8,
        evidence: 0.6,
        srs_load: 0.9,
        attempts_90d: 80,
        due_srs: 3,
      },
      ability: {
        q_type: null,
        section_type: null,
        ability: 0.2,
        mastery: 0.74,
        uncertainty: 0.2,
        evidence_n: 80,
        accuracy: 0.7,
        avg_time_ms: null,
        components: {},
      },
      section_type: null,
      on_track: null,
      predicted_scaled_score: null,
    } satisfies ReadinessStatus;

    expect(liveReadinessStatus({ data: backend, usingSample: false })).toBe(backend);
    expect(liveReadinessStatus({ data: backend, usingSample: true })).toBeNull();
    expect(liveReadinessStatus(null)).toBeNull();
  });
});
