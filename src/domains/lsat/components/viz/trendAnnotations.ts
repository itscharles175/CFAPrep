import type { ChartAnnotationTone } from "./chart-kit";
import type { TrendDatum } from "./TrendChart";

/**
 * R9 §2 — derive a small set of milestone annotations from a score trend, all
 * client-derivable from the same `TrendDatum[]` the TrendChart already gets:
 *
 *  - **Personal best** — the highest score in the window.
 *  - **Improving run** — the start of the longest non-decreasing streak (≥3
 *    points), where momentum began.
 *  - **Biggest jump** — the largest single point-to-point gain.
 *
 * We then de-overlap and cap to the top 1–2 so labels never collide: candidates
 * are ranked (personal-best first), and any candidate whose index is within
 * `minGap` of an already-kept one is dropped.
 */

export interface TrendAnnotation {
  /** Index into the series. */
  index: number;
  label: string;
  tone: ChartAnnotationTone;
  /** Ranking weight — higher wins when de-overlapping. */
  priority: number;
}

export function deriveTrendAnnotations(
  series: TrendDatum[],
  opts: { max?: number; minGap?: number } = {},
): TrendAnnotation[] {
  const max = opts.max ?? 2;
  const minGap = opts.minGap ?? 1;
  if (series.length < 3) return [];

  const candidates: TrendAnnotation[] = [];

  // Personal best (last occurrence wins ties so the pin sits on the most recent
  // peak rather than an older equal one).
  let bestIdx = 0;
  for (let i = 1; i < series.length; i++) {
    if (series[i].score >= series[bestIdx].score) bestIdx = i;
  }
  // Only worth calling out if the peak isn't the very first point.
  if (bestIdx > 0) {
    candidates.push({
      index: bestIdx,
      label: "Personal best",
      tone: "success",
      priority: 100,
    });
  }

  // Biggest single-step jump.
  let jumpIdx = -1;
  let jumpDelta = 0;
  for (let i = 1; i < series.length; i++) {
    const delta = series[i].score - series[i - 1].score;
    if (delta > jumpDelta) {
      jumpDelta = delta;
      jumpIdx = i;
    }
  }
  if (jumpIdx > 0 && jumpDelta >= 2) {
    candidates.push({
      index: jumpIdx,
      label: `+${Math.round(jumpDelta)} jump`,
      tone: "info",
      // Weight by size so a dramatic jump can edge out a flat-ish run start.
      priority: 40 + jumpDelta,
    });
  }

  // Start of the longest non-decreasing run (momentum began here).
  let runStart = 0;
  let runLen = 1;
  let bestRunStart = -1;
  let bestRunLen = 1;
  for (let i = 1; i < series.length; i++) {
    if (series[i].score >= series[i - 1].score) {
      runLen++;
    } else {
      if (runLen > bestRunLen) {
        bestRunLen = runLen;
        bestRunStart = runStart;
      }
      runStart = i;
      runLen = 1;
    }
  }
  if (runLen > bestRunLen) {
    bestRunLen = runLen;
    bestRunStart = runStart;
  }
  if (bestRunStart > 0 && bestRunLen >= 3) {
    candidates.push({
      index: bestRunStart,
      label: "Improving",
      tone: "primary",
      priority: 30 + bestRunLen,
    });
  }

  // De-overlap: keep highest-priority first, drop anything too close to a kept
  // pin (or a duplicate index), then cap.
  const kept: TrendAnnotation[] = [];
  for (const c of [...candidates].sort((a, b) => b.priority - a.priority)) {
    if (kept.some((k) => Math.abs(k.index - c.index) <= minGap)) continue;
    kept.push(c);
    if (kept.length >= max) break;
  }
  // Render left-to-right for stable paint order.
  return kept.sort((a, b) => a.index - b.index);
}
