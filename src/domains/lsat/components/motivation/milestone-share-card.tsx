import { forwardRef } from "react";
import { Award } from "lucide-react";

export interface MilestoneShareCardProps {
  label: string;
  progressPct: number;
  predictedScore?: number;
}

/** Branded card for milestone PNG export (R4-G5). */
export const MilestoneShareCard = forwardRef<HTMLDivElement, MilestoneShareCardProps>(
  function MilestoneShareCard({ label, progressPct, predictedScore }, ref) {
    return (
      <div
        ref={ref}
        className="w-[480px] rounded-xl border border-primary/30 bg-gradient-to-br from-[hsl(231,30%,7%)] to-[hsl(262,40%,12%)] p-8 text-white"
        style={{ fontFamily: "system-ui, sans-serif" }}
      >
        <div className="flex items-center gap-2 text-primary">
          <Award className="h-6 w-6" />
          <span className="text-xs font-semibold uppercase tracking-widest">
            Milestone
          </span>
        </div>
        <h2 className="mt-3 text-2xl font-bold">{label}</h2>
        <p className="mt-2 text-sm text-white/70">
          {progressPct >= 100
            ? "Unlocked in StudyVault · LSAT"
            : `${Math.round(progressPct)}% progress`}
        </p>
        {predictedScore != null && (
          <p className="mt-6 text-lg tabular-nums">
            Predicted score: <strong>{predictedScore}</strong>
          </p>
        )}
        <p className="mt-8 text-[10px] text-white/70">
          {new Date().toLocaleDateString()} · StudyVault · LSAT
        </p>
      </div>
    );
  },
);
