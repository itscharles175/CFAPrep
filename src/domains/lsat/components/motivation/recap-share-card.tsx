import { forwardRef } from "react";
import { TypeBadge } from "@lsat/components/viz";
import { pct } from "@lsat/lib/utils";
import type { QType } from "@lsat/lib/types";

export interface RecapShareCardProps {
  score: string;
  accuracy: string;
  time: string;
  brGap: string;
  best?: { qType: QType; acc: string };
  worst?: { qType: QType; acc: string };
  sessionLabel?: string;
}

/** Branded DOM card captured for PNG/SVG export. */
export const RecapShareCard = forwardRef<HTMLDivElement, RecapShareCardProps>(
  function RecapShareCard(
    { score, accuracy, time, brGap, best, worst, sessionLabel },
    ref,
  ) {
    return (
      <div
        ref={ref}
        className="w-[520px] rounded-xl border border-primary/30 bg-gradient-to-br from-[hsl(231,30%,7%)] to-[hsl(262,40%,12%)] p-8 text-white shadow-e3"
        style={{ fontFamily: "system-ui, sans-serif" }}
      >
        <div className="text-xs font-semibold uppercase tracking-widest text-primary">
          StudyVault · LSAT
        </div>
        <h2 className="mt-1 text-2xl font-bold">Session recap</h2>
        {sessionLabel && (
          <p className="mt-1 text-sm text-white/70">{sessionLabel}</p>
        )}
        <div className="mt-6 grid grid-cols-2 gap-4">
          <StatBox label="Score" value={score} large />
          <StatBox label="Accuracy" value={accuracy} />
          <StatBox label="Time" value={time} />
          <StatBox label="Timed vs BR" value={brGap} />
        </div>
        {(best || worst) && (
          <div className="mt-6 flex flex-wrap gap-4 text-sm">
            {best && (
              <div className="flex items-center gap-2">
                <span className="text-white/70">Best</span>
                <TypeBadge qType={best.qType} />
                <span className="tabular-nums">{best.acc}</span>
              </div>
            )}
            {worst && (
              <div className="flex items-center gap-2">
                <span className="text-white/70">Weakest</span>
                <TypeBadge qType={worst.qType} />
                <span className="tabular-nums">{worst.acc}</span>
              </div>
            )}
          </div>
        )}
        <p className="mt-6 text-[10px] text-white/70">
          {new Date().toLocaleDateString()} · lsatlab.app
        </p>
      </div>
    );
  },
);

function StatBox({
  label,
  value,
  large,
}: {
  label: string;
  value: string;
  large?: boolean;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-3">
      <div className="text-[10px] font-medium uppercase tracking-wide text-white/70">
        {label}
      </div>
      <div
        className={
          large
            ? "mt-1 text-3xl font-bold tabular-nums"
            : "mt-1 text-xl font-semibold tabular-nums"
        }
      >
        {value}
      </div>
    </div>
  );
}

export function recapSharePropsFromStats(stats: {
  score: number | null;
  accuracy: number;
  timeMs: number;
  brGap: number;
  best?: { qType: QType; correct: number; total: number };
  worst?: { qType: QType; correct: number; total: number };
  sessionLabel?: string;
}): RecapShareCardProps {
  return {
    score: stats.score != null ? String(stats.score) : "—",
    accuracy: pct(stats.accuracy),
    time: formatTime(stats.timeMs),
    brGap: `${stats.brGap > 0 ? "+" : ""}${pct(stats.brGap)}`,
    best: stats.best
      ? {
          qType: stats.best.qType,
          acc: pct(stats.best.correct / stats.best.total),
        }
      : undefined,
    worst: stats.worst
      ? {
          qType: stats.worst.qType,
          acc: pct(stats.worst.correct / stats.worst.total),
        }
      : undefined,
    sessionLabel: stats.sessionLabel,
  };
}

function formatTime(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
