import {
  TrendChart,
  GapDumbbell,
  type TrendDatum,
  type GapRow,
} from "@lsat/components/viz";
import { DifficultyCurve } from "./DifficultyCurve";
import { pct } from "@lsat/lib/utils";
import type { DifficultyRow } from "@lsat/lib/types";

export interface PrintReportProps {
  generatedAt: string;
  rangeLabel: string;
  sourceLabel: string;
  goalBand?: [number, number];
  examDate?: string;
  kpis: {
    predictedScore: number | null;
    scoreDelta30d: number | null;
    accuracy: number; // 0..1
    avgTimeSec: number;
    brGap: number; // 0..1
  };
  trend: TrendDatum[];
  /** Optional projection cone for the printed trend (mirrors the live forecast). */
  projection?: {
    score: number;
    lowSpread?: number;
    highSpread?: number;
    bands?: { level: number; spread: number }[];
  };
  gapRows: GapRow[];
  difficulty: DifficultyRow[];
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="break-inside-avoid rounded-card border border-border p-3">
      <div className="type-overline text-muted-foreground">{label}</div>
      <div className="type-numeric text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/**
 * R9 §7 — a composed, print-only analytics report. Instead of dumping the live
 * (interactive, tab-hidden) page to paper, this renders a deliberate one-page
 * composition: a title block, the KPI cluster, the score trend, the timed-vs-BR
 * gap, and the difficulty curve in a fixed grid. It is `hidden` on screen and
 * only revealed inside `@media print`; every block is `break-inside-avoid` so
 * charts never split across a page boundary. Reuses the existing chart
 * components + the data already on the page — no new metrics.
 */
export function PrintReport({
  generatedAt,
  rangeLabel,
  sourceLabel,
  goalBand,
  examDate,
  kpis,
  trend,
  projection,
  gapRows,
  difficulty,
}: PrintReportProps) {
  return (
    <div
      className="hidden print:block"
      // The interactive page sets print:hidden on its chrome; this report owns
      // the printed page entirely.
      aria-hidden
    >
      {/* Title block */}
      <header className="break-inside-avoid border-b border-border pb-3">
        <p className="type-overline text-muted-foreground">LSATLab · Analytics report</p>
        <h1 className="type-display text-2xl leading-tight">Your diagnostic picture</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Generated {generatedAt.slice(0, 10)} · {rangeLabel} · {sourceLabel}
          {goalBand ? ` · goal ${goalBand[0]}–${goalBand[1]}` : ""}
          {examDate ? ` · exam ${examDate}` : ""}
        </p>
      </header>

      {/* KPI cluster */}
      <section className="mt-4 break-inside-avoid">
        <h2 className="type-display mb-2 text-base">Headline</h2>
        <div className="grid grid-cols-4 gap-3">
          <Metric
            label="Predicted score"
            value={kpis.predictedScore == null ? "n/a" : String(kpis.predictedScore)}
          />
          <Metric label="Accuracy" value={pct(kpis.accuracy)} />
          <Metric label="Avg time / Q" value={`${kpis.avgTimeSec}s`} />
          <Metric label="Blind-review gap" value={`${Math.round(kpis.brGap * 100)} pts`} />
        </div>
      </section>

      {/* Trend */}
      <section className="mt-5 break-inside-avoid">
        <h2 className="type-display mb-2 text-base">Score trend</h2>
        {trend.length > 1 ? (
          <TrendChart
            series={trend}
            goal={goalBand}
            examDate={examDate}
            projection={projection}
            height={200}
            annotate
          />
        ) : (
          <p className="text-xs text-muted-foreground">Not enough score history yet.</p>
        )}
      </section>

      {/* Two-up: gap + difficulty */}
      <section className="mt-5 grid grid-cols-2 gap-6">
        <div className="break-inside-avoid">
          <h2 className="type-display mb-2 text-base">Timed vs blind review</h2>
          {gapRows.length ? (
            <GapDumbbell rows={gapRows} />
          ) : (
            <p className="text-xs text-muted-foreground">No blind-review data yet.</p>
          )}
        </div>
        <div className="break-inside-avoid">
          <h2 className="type-display mb-2 text-base">Difficulty curve</h2>
          {difficulty.length ? (
            <DifficultyCurve rows={difficulty} height={200} />
          ) : (
            <p className="text-xs text-muted-foreground">No difficulty data yet.</p>
          )}
        </div>
      </section>

      <footer className="mt-6 border-t border-border pt-2 text-2xs text-muted-foreground">
        Local-first · figures reflect the filters active when printed.
      </footer>
    </div>
  );
}
