import type { DashboardAnalytics, BlindReviewGap, WeakType } from "./types";
import { pct } from "./utils";

/** R4-G10 — inline SVG bar chart for email-ready reports. */
function buildTrendSvg(points: { date: string; score: number }[]): string {
  if (points.length < 2) return "";
  const w = 400;
  const h = 120;
  const pad = 8;
  const scores = points.map((p) => p.score);
  const min = Math.min(...scores) - 2;
  const max = Math.max(...scores) + 2;
  const range = Math.max(1, max - min);
  const barW = (w - pad * 2) / points.length - 2;
  const bars = points
    .map((p, i) => {
      const bh = ((p.score - min) / range) * (h - pad * 2);
      const x = pad + i * (barW + 2);
      const y = h - pad - bh;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" fill="#6366f1" rx="2"/>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px;height:auto" role="img" aria-label="Score trend chart">${bars}</svg>`;
}

export function buildWeeklyReportHtml(opts: {
  generatedAt: string;
  dashboard: DashboardAnalytics;
  weakTypes: WeakType[];
  gap?: BlindReviewGap | null;
  streakDays: number;
  /** Last N score points for a simple trend table (R4-G10). */
  trend?: { date: string; score: number }[];
}): string {
  const { dashboard: d, weakTypes, gap, streakDays, generatedAt, trend } = opts;
  const weak = weakTypes
    .slice()
    .sort((a, b) => a.accuracy - b.accuracy)
    .slice(0, 5)
    .map(
      (w) =>
        `<li>${w.q_type}: ${pct(w.accuracy)} accuracy · ${Math.round(w.avg_time_ms / 1000)}s avg</li>`,
    )
    .join("");
  const gapNote = gap
    ? `<p>Timed vs blind-review gap: <strong>${pct(gap.gap)}</strong> (${pct(gap.timed_accuracy)} timed → ${pct(gap.br_accuracy)} BR).</p>`
    : "";
  const trendSlice = (trend ?? []).slice(-14);
  const trendChart = buildTrendSvg(trendSlice);
  const trendRows = trendSlice
    .map(
      (t) =>
        `<tr><td>${t.date}</td><td style="text-align:right"><strong>${t.score}</strong></td></tr>`,
    )
    .join("");
  const trendTable = trendRows
    ? `<h2>Score trend (recent)</h2>${trendChart}<table style="width:100%;border-collapse:collapse;font-size:0.875rem;margin-top:0.75rem">
<tr style="border-bottom:1px solid #ddd"><th style="text-align:left;padding:4px 0">Date</th><th style="text-align:right;padding:4px 0">Score</th></tr>${trendRows}</table>`
    : "";
  const predicted = d.predicted_score == null ? "n/a" : String(d.predicted_score);
  const delta =
    d.score_delta_30d == null
      ? "n/a"
      : `${d.score_delta_30d >= 0 ? "+" : ""}${d.score_delta_30d}`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>LSAT Lab Weekly Summary</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:2rem auto;line-height:1.5;color:#111}
h1{font-size:1.5rem}ul{padding-left:1.25rem}.muted{color:#555;font-size:0.875rem}</style></head><body>
<h1>Weekly study summary</h1>
<p class="muted">Generated ${generatedAt}</p>
<p>Predicted score: <strong>${predicted}</strong> (Δ ${delta} over 30d)</p>
<p>Streak: <strong>${streakDays}</strong> days</p>
${gapNote}
<h2>Weakest types</h2><ul>${weak || "<li>No attempts yet</li>"}</ul>
${trendTable}
<p class="muted">LSAT Lab — local report</p></body></html>`;
}

export function downloadWeeklyReport(html: string): void {
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lsatlab-weekly-${new Date().toISOString().slice(0, 10)}.html`;
  a.click();
  URL.revokeObjectURL(url);
}
