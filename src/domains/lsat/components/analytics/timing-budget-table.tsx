import { qTypeLabel } from "@lsat/lib/labels";
import { pct, formatMs } from "@lsat/lib/utils";
import type { ByTypeRow } from "@lsat/lib/types";

/** Target seconds per question by section family (R4-E4). */
const TARGET_SEC: Record<string, number> = {
  LR: 84,
  RC: 105,
};

function targetForType(qType: string): number {
  if (qType.startsWith("RC")) return TARGET_SEC.RC;
  return TARGET_SEC.LR;
}

export function TimingBudgetTable({ rows }: { rows: ByTypeRow[] }) {
  if (!rows.length) {
    return (
      <p className="text-sm text-muted-foreground">No timing data for this range.</p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead>
          <tr className="type-overline border-b bg-muted/50 text-left text-muted-foreground">
            <th className="px-3 py-2">Type</th>
            <th className="px-3 py-2 text-right">Target</th>
            <th className="px-3 py-2 text-right">Your avg</th>
            <th className="px-3 py-2 text-right">Delta</th>
            <th className="px-3 py-2 text-right">Accuracy</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const target = targetForType(String(r.q_type));
            const actual = Math.round((r.avg_time_ms ?? 0) / 1000);
            const delta = actual - target;
            const over = delta > 15;
            return (
              <tr key={String(r.q_type)} className="border-b last:border-0">
                <td className="px-3 py-2 font-medium">{qTypeLabel(r.q_type)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {target}s
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMs(r.avg_time_ms ?? 0)}</td>
                <td
                  className={
                    over
                      ? "px-3 py-2 text-right tabular-nums text-warning"
                      : "px-3 py-2 text-right tabular-nums text-success"
                  }
                >
                  {delta > 0 ? "+" : ""}
                  {delta}s
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{pct(r.accuracy ?? 0)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
