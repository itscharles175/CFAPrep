import { formatClock, formatMs } from "@lsat/lib/utils";

/**
 * R4-C8 / C4 — pacing postmortem between exam sections. Deliberately shows no
 * score or correctness (the exam keeps answers hidden until blind review); it
 * visualizes only time spent per question against the per-question target.
 */
export function SectionInterstitial({
  answered,
  total,
  flagged,
  avgTimeMs,
  timeLimitSec,
  perQuestionSec = [],
}: {
  answered: number;
  total: number;
  flagged: number;
  avgTimeMs: number;
  timeLimitSec: number;
  perQuestionSec?: number[];
}) {
  const targetPerQ = total > 0 ? Math.round(timeLimitSec / total) : 0;
  const actualPerQ = total > 0 ? Math.round(avgTimeMs / 1000) : 0;
  const pace =
    actualPerQ <= targetPerQ
      ? "on pace"
      : actualPerQ <= targetPerQ * 1.15
        ? "slightly slow"
        : "behind pace";

  const maxSec = Math.max(targetPerQ, ...perQuestionSec, 1);
  const overCount = perQuestionSec.filter((s) => s > targetPerQ * 1.5).length;

  return (
    <div className="mt-4 w-full max-w-sm rounded-md border bg-card p-4 text-left text-sm">
      <p className="font-medium">Section recap</p>
      <ul className="mt-2 space-y-1 text-muted-foreground">
        <li>
          Answered <strong className="text-foreground">{answered}</strong> / {total}
        </li>
        <li>
          Flagged <strong className="text-foreground">{flagged}</strong>
        </li>
        <li>
          Avg time <strong className="text-foreground">{formatMs(avgTimeMs)}</strong> / Q
          (target ~{formatClock(targetPerQ)})
        </li>
        <li className="capitalize">
          Pacing: <strong className="text-foreground">{pace}</strong>
        </li>
      </ul>

      {/* C4 — pacing postmortem chart: one bar per question (seconds), with the
          per-question target line. No correctness shown. */}
      {perQuestionSec.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-2xs text-muted-foreground">
            <span>Time per question</span>
            {overCount > 0 && <span>{overCount} ran long</span>}
          </div>
          <div className="relative flex h-12 items-end gap-px">
            {/* Target line */}
            {targetPerQ > 0 && (
              <div
                className="pointer-events-none absolute inset-x-0 border-t border-dashed border-primary/60"
                style={{ bottom: `${(targetPerQ / maxSec) * 100}%` }}
                title={`Target ~${targetPerQ}s`}
              />
            )}
            {perQuestionSec.map((sec, i) => {
              const over = sec > targetPerQ * 1.5;
              return (
                <div
                  key={i}
                  className={`min-w-[2px] flex-1 rounded-sm ${over ? "bg-warning" : "bg-primary/50"}`}
                  style={{ height: `${Math.max(4, (sec / maxSec) * 100)}%` }}
                  title={`Q${i + 1}: ${sec}s`}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
