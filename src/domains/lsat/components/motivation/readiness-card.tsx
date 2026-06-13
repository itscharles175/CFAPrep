import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@lsat/components/ui/card";
import { Badge } from "@lsat/components/ui/badge";
import { ReadinessGauge } from "@lsat/components/viz";
import { readinessFromStatus, type ReadinessResult } from "@lsat/lib/readiness";
import { getGoal } from "@lsat/lib/prefs";
import type { ReadinessStatus } from "@lsat/lib/types";

/** One short serif verdict from the readiness label — counsel voice, no new data. */
function verdictLine(label: ReadinessResult["label"]): string {
  if (label === "On track") return "On track — protect the routine and stress-test under time.";
  if (label === "Building") return "Building — a little more timed volume turns this into a trend.";
  return "Needs focus — clear the backlog and drill your weakest type first.";
}

export function ReadinessCard({
  streakDays,
  srsDue,
  timedAccuracy,
  brGap,
  sessionsLast7d,
  predictedScore,
  readiness,
}: {
  streakDays: number;
  srsDue: number;
  timedAccuracy: number;
  brGap: number;
  sessionsLast7d: number;
  predictedScore?: number;
  readiness?: ReadinessStatus | null;
}) {
  const goal = getGoal();
  const selector = readiness?.ability_selector;
  const selectorUtility = selector?.utility?.score;
  const result = useMemo(
    () =>
      readinessFromStatus(
        readiness,
        {
          streakDays,
          srsDue,
          timedAccuracy,
          brGap,
          sessionsLast7d,
          targetScore: goal?.targetScore,
          predictedScore,
        },
      ),
    [
      readiness,
      streakDays,
      srsDue,
      timedAccuracy,
      brGap,
      sessionsLast7d,
      goal?.targetScore,
      predictedScore,
    ],
  );

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Exam readiness</CardTitle>
        <span className="type-overline text-muted-foreground">Instrument</span>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        {/* Engraved center score inside the composite gauge. */}
        <div className="flex items-center gap-4">
          <ReadinessGauge
            rings={result.rings}
            centerTop={
              <span className="type-numeric text-2xl font-semibold leading-none">
                {result.score}
              </span>
            }
            centerBottom={
              <span className="type-numeric text-2xs text-muted-foreground">
                / 100
              </span>
            }
          />
          {/* Metered factor bars — each ring dimension as a thin track. */}
          <ul className="min-w-0 flex-1 space-y-2 text-xs">
            {result.rings.map((ring) => (
              <li key={ring.name} className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">{ring.name}</span>
                  <span className="type-numeric font-medium">
                    {Math.round(ring.value * 100)}%
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.round(Math.max(0, Math.min(1, ring.value)) * 100)}%`,
                      background: ring.color,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* One-line serif verdict replaces the ✓/○ plaintext factor list. */}
        <p className="type-counsel mt-auto border-t pt-3 text-sm text-muted-foreground [text-wrap:pretty]">
          {verdictLine(result.label)}
        </p>
        {selector ? (
          <div className="space-y-2 rounded-md border bg-muted/25 p-2 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">Ability selector</span>
              <Badge variant="secondary">{selector.strategy.replace(/_/g, " ")}</Badge>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <SelectorStat label="Theta" value={selector.theta.toFixed(2)} />
              <SelectorStat
                label="ZPD target"
                value={`${selector.zpd.target_difficulty.toFixed(1)}`}
              />
              <SelectorStat
                label="Utility"
                value={
                  typeof selectorUtility === "number"
                    ? `${Math.round(selectorUtility * 100)}%`
                    : "pending"
                }
              />
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SelectorStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border bg-background/70 px-2 py-1">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="type-numeric font-medium">{value}</p>
    </div>
  );
}
