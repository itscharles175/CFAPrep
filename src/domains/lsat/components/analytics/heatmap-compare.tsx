import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HeatStrip, ColorScaleKey, ChartEmpty, type HeatCell } from "@/components/viz";
import { formatDate } from "@/lib/utils";
import { useChartScales } from "@/lib/chartTheme";
import { useTiming } from "@/lib/hooks";
import { filterSessionsForAnalytics } from "@/lib/analyticsParams";
import { useAnalyticsContext } from "./analytics-context";
import type { SessionSummary } from "@/lib/types";
import { SkeletonChart } from "@/components/states";

function timingCells(
  rows: { question_order: number; time_ms: number; is_correct: boolean }[],
): HeatCell[] {
  return rows.map((r) => ({
    value: Math.round(r.time_ms / 1000),
    correct: r.is_correct,
    label: `Q${r.question_order}`,
  }));
}

function avgSec(rows: { time_ms: number }[]): number {
  if (!rows.length) return 0;
  return Math.round(rows.reduce((s, r) => s + r.time_ms, 0) / rows.length / 1000);
}

/** R4-E5 — two session timing heat strips side by side. */
export function HeatmapCompare({ sessions }: { sessions: SessionSummary[] }) {
  const { range, brushStart, brushEnd } = useAnalyticsContext();
  const list = filterSessionsForAnalytics(sessions, range, brushStart, brushEnd);
  const [aId, setAId] = useState<number | null>(list[0]?.id ?? null);
  const [bId, setBId] = useState<number | null>(list[1]?.id ?? list[0]?.id ?? null);

  const a = aId ?? list[0]?.id ?? 0;
  const b = bId ?? list[1]?.id ?? 0;
  const ta = useTiming(a);
  const tb = useTiming(b);
  const scales = useChartScales();

  if (list.length < 2)
    return (
      <Card className="shadow-e1">
        <CardHeader>
          <CardTitle className="text-base">Heatmap compare</CardTitle>
          <CardDescription>
            Per-question timing strips for two sessions, side by side.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChartEmpty
            title="Need two sessions to compare"
            hint="Finish at least two timed sections to line up their pacing strips."
            height={140}
          />
        </CardContent>
      </Card>
    );

  const rowsA = ta.data?.data ?? [];
  const rowsB = tb.data?.data ?? [];
  const accA = rowsA.length
    ? rowsA.filter((r) => r.is_correct).length / rowsA.length
    : 0;
  const accB = rowsB.length
    ? rowsB.filter((r) => r.is_correct).length / rowsB.length
    : 0;

  return (
    <Card className="shadow-e1">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">Heatmap compare</CardTitle>
          <CardDescription>
            Per-question timing strips for two sessions — brighter = more clock.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-3">
          <SessionPick label="Session A" sessions={list} value={a} onChange={setAId} />
          <SessionPick label="Session B" sessions={list} value={b} onChange={setBId} />
        </div>
        {(ta.isLoading || tb.isLoading) && (
          <SkeletonChart className="border-0 p-0 shadow-none" />
        )}
        {!ta.isLoading && !tb.isLoading && (
          <>
            <p className="text-sm text-muted-foreground">
              Avg time: <strong>{avgSec(rowsA)}s</strong> ({Math.round(accA * 100)}% acc) vs{" "}
              <strong>{avgSec(rowsB)}s</strong> ({Math.round(accB * 100)}% acc)
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">Session A</div>
                {rowsA.length ? (
                  <HeatStrip cells={timingCells(rowsA)} ramp="inferno" showScaleKey={false} />
                ) : (
                  <p className="text-xs text-muted-foreground">No data</p>
                )}
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">Session B</div>
                {rowsB.length ? (
                  <HeatStrip cells={timingCells(rowsB)} ramp="inferno" showScaleKey={false} />
                ) : (
                  <p className="text-xs text-muted-foreground">No data</p>
                )}
              </div>
            </div>
            {/* One shared scale key for both columns (avoids duplicate legends). */}
            <ColorScaleKey
              className="mt-1"
              colorAt={(t) => scales.rampColor("inferno")(t)}
              lowLabel="fast"
              highLabel="slow"
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SessionPick({
  label,
  sessions,
  value,
  onChange,
}: {
  label: string;
  sessions: SessionSummary[];
  value: number;
  onChange: (id: number) => void;
}) {
  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {sessions.map((s) => (
            <SelectItem key={s.id} value={String(s.id)}>
              {s.type} · {formatDate(s.started)}
              {s.scaled_score != null ? ` · ${s.scaled_score}` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
