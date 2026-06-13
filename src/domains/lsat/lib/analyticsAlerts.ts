import { qTypeLabel } from "./labels";
import type { BlindReviewGap, RegressionAlert } from "./types";
import {
  getAnalyticsAlertThresholds,
  getAnalyticsGapSnapshot,
  setAnalyticsGapSnapshot,
} from "./prefs";

export interface GapAlert {
  q_type: string;
  gap: number;
  widened: number;
}

export function computeGapAlerts(gap: BlindReviewGap | undefined): GapAlert[] {
  if (!gap?.by_type?.length) return [];
  const { gapMin, widenMin } = getAnalyticsAlertThresholds();
  const snapshot = getAnalyticsGapSnapshot();
  const alerts: GapAlert[] = [];

  for (const row of gap.by_type) {
    const gapVal = row.br_accuracy - row.timed_accuracy;
    if (gapVal < gapMin) continue;
    const key = String(row.q_type);
    const prior = snapshot?.by_type[key];
    const widened = prior != null ? gapVal - prior : 0;
    if (prior == null || widened >= widenMin) {
      alerts.push({ q_type: key, gap: gapVal, widened: Math.max(0, widened) });
    }
  }

  alerts.sort((a, b) => b.gap - a.gap);
  return alerts;
}

export function captureGapSnapshot(gap: BlindReviewGap | undefined): void {
  if (!gap?.by_type?.length) return;
  const by_type: Record<string, number> = {};
  for (const row of gap.by_type) {
    by_type[String(row.q_type)] = row.br_accuracy - row.timed_accuracy;
  }
  setAnalyticsGapSnapshot({
    capturedAt: new Date().toISOString(),
    by_type,
  });
}

export function formatGapAlertMessage(alerts: GapAlert[]): string {
  const top = alerts[0];
  const label = qTypeLabel(top.q_type);
  const pts = Math.round(top.gap * 100);
  const extra =
    alerts.length > 1
      ? ` (+${alerts.length - 1} more type${alerts.length > 2 ? "s" : ""})`
      : "";
  if (top.widened > 0) {
    return `${label} gap widened to ${pts} pts${extra}`;
  }
  return `${label} timed→BR gap is ${pts} pts${extra}`;
}

export function formatRegressionAlertMessage(alerts: RegressionAlert[]): string {
  const top = alerts[0];
  const label = qTypeLabel(String(top.q_type));
  const drop = Math.abs(Math.round(top.delta * 100));
  const recent = Math.round(top.recent_accuracy * 100);
  const extra =
    alerts.length > 1
      ? ` (+${alerts.length - 1} more type${alerts.length > 2 ? "s" : ""})`
      : "";
  const marker = top.statistically_significant ? "regressed" : "slipped";
  return `${label} ${marker} by ${drop} pts to ${recent}%${extra}`;
}
