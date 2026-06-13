import type { AbilityUtilityPacket } from "./types";

interface UtilityTaskLike {
  type?: string | null;
  kind?: string | null;
  utility_score?: number | null;
  utility?: number | null;
  target_difficulty?: number | null;
  feedback_evidence?: {
    label?: string | null;
    total?: number | null;
  } | null;
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function signal(
  utility: AbilityUtilityPacket | null | undefined,
  key: string,
): number | null {
  return numeric(utility?.signals?.[key]);
}

function pct(value: number | null): string | null {
  if (value == null) return null;
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function addSignal(
  out: string[],
  label: string,
  value: number | null,
  threshold = 0.05,
) {
  if (value == null || value <= threshold) return;
  const rendered = pct(value);
  if (rendered) out.push(`${label} ${rendered}`);
}

export function utilityScoreValue(
  task: UtilityTaskLike | null | undefined,
): number | null {
  return numeric(task?.utility_score) ?? numeric(task?.utility);
}

export function formatUtilityPriority(
  taskOrScore: UtilityTaskLike | number | null | undefined,
): string | null {
  const value =
    typeof taskOrScore === "number"
      ? numeric(taskOrScore)
      : utilityScoreValue(taskOrScore);
  if (value == null) return null;
  return `Priority ${Math.round(Math.max(0, Math.min(1, value)) * 100)}`;
}

export function utilityTradeoffs(
  task: UtilityTaskLike | null | undefined,
  utility: AbilityUtilityPacket | null | undefined,
): string[] {
  if (!task || !utility?.signals) return [];

  const kind = String(task.type ?? task.kind ?? "").toLowerCase();
  const out: string[] = [];
  const srsPressure = signal(utility, "srs_pressure");
  const masteryGap = signal(utility, "mastery_gap");
  const uncertainty = signal(utility, "uncertainty_pressure");
  const blindReview = signal(utility, "blind_review_pressure");
  const fatigue = signal(utility, "fatigue_pressure");
  const cadence = signal(utility, "cadence_pressure");

  if (kind.includes("srs")) {
    addSignal(out, "Due review", srsPressure);
  } else if (kind.includes("leech")) {
    addSignal(out, "Due review", srsPressure);
    addSignal(out, "Fatigue", fatigue);
  } else if (kind.includes("concept")) {
    addSignal(out, "Review gap", blindReview);
    addSignal(out, "Mastery gap", masteryGap);
  } else if (kind.includes("drill")) {
    addSignal(out, "Mastery gap", masteryGap);
    addSignal(out, "Uncertainty", uncertainty);
  } else if (kind.includes("pacing")) {
    addSignal(out, "Fatigue", fatigue);
    addSignal(out, "Review gap", blindReview);
  } else if (kind.includes("section")) {
    addSignal(out, "Cadence", cadence);
    addSignal(out, "Uncertainty", uncertainty);
  }

  if (out.length === 0) {
    addSignal(out, "Due review", srsPressure);
    addSignal(out, "Mastery gap", masteryGap);
    addSignal(out, "Uncertainty", uncertainty);
    addSignal(out, "Review gap", blindReview);
    addSignal(out, "Fatigue", fatigue);
    addSignal(out, "Cadence", cadence);
  }

  const target = numeric(task.target_difficulty);
  if (target != null && out.length < 2) {
    out.push(`ZPD ${target.toFixed(2)}`);
  }

  const feedbackLabel =
    typeof task.feedback_evidence?.label === "string"
      ? task.feedback_evidence.label
      : null;
  let hasFeedback = false;
  if (feedbackLabel != null && (task.feedback_evidence?.total ?? 0) > 0) {
    out.push(feedbackLabel);
    hasFeedback = true;
  }

  return out.slice(0, hasFeedback ? 3 : 2);
}
