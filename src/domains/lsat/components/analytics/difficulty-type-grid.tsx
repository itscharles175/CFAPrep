import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { qTypeLabel } from "@/lib/labels";
import { useByDifficulty, useByType, useSessions } from "@/lib/hooks";
import {
  reviewableSessions,
  useMultiSessionResults,
} from "@/lib/hooks/useReviewSessions";
import { filterSessionsForAnalytics } from "@/lib/analyticsParams";
import { pct } from "@/lib/utils";
import type { ByTypeRow, ResultItem } from "@/lib/types";
import { useAnalyticsContext } from "./analytics-context";
import { ChartDataTable } from "./chart-data-table";
import { SkeletonChart } from "@/components/states";

interface GridCell {
  accuracy: number;
  attempts: number;
}

function buildGridFromResults(
  items: ResultItem[],
  types: ByTypeRow[],
): Map<string, GridCell> {
  const map = new Map<string, GridCell>();
  for (const it of items) {
    const diff = it.question.difficulty;
    const key = `${String(it.question.q_type)}|${diff}`;
    const agg = map.get(key) ?? { accuracy: 0, attempts: 0 };
    agg.attempts++;
    if (it.attempt.is_correct) agg.accuracy++;
    map.set(key, agg);
  }
  for (const agg of map.values()) {
    if (agg.attempts > 0) agg.accuracy = agg.accuracy / agg.attempts;
  }
  if (types.length === 0 && map.size === 0) return map;
  return map;
}

function cellColor(acc: number | null): string {
  if (acc == null) return "hsl(var(--muted))";
  if (acc >= 0.85) return "hsl(var(--success) / 0.35)";
  if (acc >= 0.7) return "hsl(var(--primary) / 0.25)";
  if (acc >= 0.55) return "hsl(var(--warning) / 0.35)";
  return "hsl(var(--destructive) / 0.35)";
}

/** R4-E8 — difficulty × type accuracy grid (client aggregate from session results). */
export function DifficultyTypeGrid({ source }: { source: "official" | "all" }) {
  const navigate = useNavigate();
  const { range, brushStart, brushEnd, days } = useAnalyticsContext();
  const byType = useByType(source, days);
  const byDiff = useByDifficulty(source, days);
  const sessionsQ = useSessions();

  const filtered = useMemo(
    () =>
      filterSessionsForAnalytics(
        reviewableSessions(sessionsQ.data?.data ?? []),
        range,
        brushStart,
        brushEnd,
      ),
    [sessionsQ.data, range, brushStart, brushEnd],
  );

  const multi = useMultiSessionResults(filtered.map((s) => s.id));

  const types = useMemo(
    () =>
      [...(byType.data?.data ?? [])]
        .sort((a, b) => b.attempts - a.attempts)
        .slice(0, 6),
    [byType.data],
  );

  const difficulties = useMemo(
    () =>
      [...(byDiff.data?.data ?? [])]
        .map((d) => d.difficulty)
        .sort((a, b) => a - b),
    [byDiff.data],
  );

  const grid = useMemo(() => {
    const items: ResultItem[] = [];
    for (const id of filtered.map((s) => s.id)) {
      items.push(...(multi.resultsBySessionId.get(id) ?? []));
    }
    return buildGridFromResults(items, types);
  }, [filtered, multi.resultsBySessionId, types]);

  if (byType.isLoading || byDiff.isLoading || multi.isLoading) {
    return <SkeletonChart />;
  }

  if (!types.length || !difficulties.length) {
    return null;
  }

  const tableRows: string[][] = [];
  for (const diff of difficulties) {
    for (const t of types) {
      const key = `${String(t.q_type)}|${diff}`;
      const cell = grid.get(key);
      tableRows.push([
        "★".repeat(diff),
        String(t.q_type),
        cell ? pct(cell.accuracy) : "—",
        cell ? String(cell.attempts) : "0",
      ]);
    }
  }

  return (
    <Card className="shadow-e1">
      <CardHeader>
        <CardTitle className="text-base">Difficulty × type</CardTitle>
        <CardDescription>
          Where your ceiling sits by family and star level — from finished session results.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[480px] border-collapse text-sm">
          <thead>
            <tr>
              <th className="p-2 text-left text-xs text-muted-foreground">Diff</th>
              {types.map((t) => (
                <th
                  key={String(t.q_type)}
                  className="p-2 text-center text-xs font-medium"
                >
                  <button
                    type="button"
                    className="hover:underline"
                    onClick={() =>
                      navigate(
                        `/analytics/type/${encodeURIComponent(String(t.q_type))}`,
                      )
                    }
                  >
                    {qTypeLabel(t.q_type).split(" ")[0]}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {difficulties.map((diff) => (
              <tr key={diff}>
                <td className="p-2 text-xs text-muted-foreground">
                  {"★".repeat(diff)}
                </td>
                {types.map((t) => {
                  const key = `${String(t.q_type)}|${diff}`;
                  const cell = grid.get(key);
                  return (
                    <td key={key} className="p-1">
                      <div
                        className="flex min-h-[2.5rem] flex-col items-center justify-center rounded-md px-1 py-2 text-center"
                        style={{ backgroundColor: cellColor(cell?.accuracy ?? null) }}
                        title={
                          cell
                            ? `${qTypeLabel(t.q_type)} · ${"★".repeat(diff)}: ${pct(cell.accuracy)} accuracy (n=${cell.attempts})`
                            : `${qTypeLabel(t.q_type)} · ${"★".repeat(diff)}: no attempts`
                        }
                      >
                        <span className="stat text-xs font-semibold tabular-nums">
                          {cell ? pct(cell.accuracy) : "—"}
                        </span>
                        {cell && cell.attempts > 0 && (
                          <span className="text-[10px] text-muted-foreground">
                            n={cell.attempts}
                          </span>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <ChartDataTable
          caption="Difficulty by type grid"
          headers={["Difficulty", "Type", "Accuracy", "Attempts"]}
          rows={tableRows}
        />
      </CardContent>
    </Card>
  );
}
