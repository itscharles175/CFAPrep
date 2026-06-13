/** Composite pre-exam readiness score (R4-A6) — client-side heuristic. */
import type { ReadinessStatus } from "./types";

export interface ReadinessInput {
  streakDays: number;
  srsDue: number;
  timedAccuracy: number;
  brGap: number;
  sessionsLast7d: number;
  targetScore?: number;
  predictedScore?: number;
}

export interface ReadinessRing {
  name: string;
  /** Normalized 0..1 contribution for the composite gauge (B7). */
  value: number;
  /** CSS color (hsl(var(--…))) for the ring arc. */
  color: string;
}

export interface ReadinessResult {
  score: number;
  label: "On track" | "Building" | "Needs focus";
  factors: { name: string; ok: boolean; detail: string }[];
  /** B7 — per-dimension normalized values for the multi-ring composite gauge. */
  rings: ReadinessRing[];
}

export interface ReadinessEnvelope {
  data: ReadinessStatus;
  usingSample: boolean;
}

export function computeReadiness(input: ReadinessInput): ReadinessResult {
  const factors: ReadinessResult["factors"] = [];

  const volumeOk = input.sessionsLast7d >= 2;
  factors.push({
    name: "Volume",
    ok: volumeOk,
    detail: volumeOk
      ? `${input.sessionsLast7d} timed sessions (7d)`
      : "Fewer than 2 timed sessions this week",
  });

  const gapOk = input.brGap <= 0.06;
  factors.push({
    name: "Timed vs BR",
    ok: gapOk,
    detail: gapOk
      ? "Understanding matches timed performance"
      : "Large timed/BR gap — pacing or traps",
  });

  const srsOk = input.srsDue <= 20;
  factors.push({
    name: "SRS backlog",
    ok: srsOk,
    detail: srsOk ? `${input.srsDue} cards due` : `${input.srsDue} cards due — clear backlog`,
  });

  const accOk = input.timedAccuracy >= 0.65;
  factors.push({
    name: "Accuracy",
    ok: accOk,
    detail: `${Math.round(input.timedAccuracy * 100)}% recent timed accuracy`,
  });

  let score =
    (volumeOk ? 25 : 10) +
    (gapOk ? 25 : 8) +
    (srsOk ? 20 : 5) +
    (accOk ? 20 : 8) +
    Math.min(10, input.streakDays);

  if (
    input.targetScore != null &&
    input.predictedScore != null &&
    input.predictedScore >= input.targetScore - 3
  ) {
    score += 10;
    factors.push({
      name: "Score trend",
      ok: true,
      detail: `Predicted ${input.predictedScore} near target ${input.targetScore}`,
    });
  } else if (input.predictedScore != null) {
    factors.push({
      name: "Score trend",
      ok: false,
      detail: `Predicted ${input.predictedScore} below target`,
    });
  }

  score = Math.min(100, Math.max(0, score));
  const label =
    score >= 75 ? "On track" : score >= 50 ? "Building" : "Needs focus";

  // B7 — normalized dimensions for the composite gauge. Each maps a raw signal
  // onto 0..1 where 1 is "exam-ready" for that dimension.
  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
  const rings: ReadinessRing[] = [
    {
      name: "Accuracy",
      value: clamp01(input.timedAccuracy),
      color: "hsl(var(--verdict-500))",
    },
    {
      name: "Volume",
      value: clamp01(input.sessionsLast7d / 4),
      color: "hsl(var(--info))",
    },
    {
      name: "Consistency",
      value: clamp01(1 - input.brGap / 0.12),
      color: "hsl(var(--success))",
    },
    {
      name: "SRS health",
      value: clamp01(1 - input.srsDue / 40),
      color: "hsl(var(--warning))",
    },
  ];

  return { score, label, factors, rings };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "no signal";
  return `${Math.round(clamp01(n) * 100)}%`;
}

function labelFromStatus(status: string): ReadinessResult["label"] {
  if (status === "ready") return "On track";
  if (status === "building") return "Building";
  return "Needs focus";
}

function labelFromExamStatus(status: string): ReadinessResult["label"] {
  if (status === "ready") return "On track";
  if (status === "at_risk") return "Building";
  return "Needs focus";
}

/** Prefer backend Ability Engine V2 readiness when present, with the historical
 * browser heuristic as the offline/backward-compatible fallback. */
export function readinessFromStatus(
  status: ReadinessStatus | null | undefined,
  fallback: ReadinessInput,
): ReadinessResult {
  if (!status) return computeReadiness(fallback);
  const components = status.components;
  const mastery = clamp01(components.mastery ?? 0);
  const accuracy = clamp01(components.accuracy ?? mastery);
  const brControl = clamp01(components.blind_review_control ?? 0);
  const evidence = clamp01(components.evidence ?? 0);
  const srsLoad = clamp01(components.srs_load ?? 0);
  const score = Math.round(Math.min(100, Math.max(0, status.readiness_score)));
  const simulation = status.exam_simulation;
  const factors =
    simulation?.checks?.length
      ? simulation.checks.map((check) => ({
          name: check.label,
          ok: check.ok,
          detail: check.detail,
        }))
      : [
          {
            name: "Mastery",
            ok: mastery >= 0.62,
            detail: `${pct(mastery)} local mastery`,
          },
          {
            name: "Accuracy",
            ok: accuracy >= 0.65,
            detail: `${pct(components.accuracy)} recent timed accuracy`,
          },
          {
            name: "Timed vs BR",
            ok: brControl >= 0.72,
            detail: `${pct(brControl)} control after Blind Review`,
          },
          {
            name: "SRS backlog",
            ok: srsLoad >= 0.7,
            detail: `${components.due_srs ?? fallback.srsDue} cards due`,
          },
          {
            name: "Evidence",
            ok: evidence >= 0.5,
            detail: `${components.attempts_90d ?? 0} attempts in 90 days`,
          },
        ];
  return {
    score,
    label: simulation
      ? labelFromExamStatus(simulation.status)
      : labelFromStatus(status.status),
    factors,
    rings: [
      {
        name: "Mastery",
        value: mastery,
        color: "hsl(var(--verdict-500))",
      },
      {
        name: "Accuracy",
        value: accuracy,
        color: "hsl(var(--info))",
      },
      {
        name: "BR control",
        value: brControl,
        color: "hsl(var(--success))",
      },
      {
        name: "SRS health",
        value: srsLoad,
        color: "hsl(var(--warning))",
      },
    ],
  };
}

/** Extract live backend readiness from a fallback-enabled query envelope.
 * Offline samples deliberately return null so callers use the historical
 * client heuristic instead of displaying a synthetic backend score. */
export function liveReadinessStatus(
  envelope: ReadinessEnvelope | null | undefined,
): ReadinessStatus | null {
  if (!envelope || envelope.usingSample) return null;
  return envelope.data;
}
