import { useNavigate } from "react-router-dom";
import { Zap } from "lucide-react";
import { Button } from "@lsat/components/ui/button";
import { Icon } from "@lsat/components/ui/icon";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@lsat/components/ui/card";
import { Badge } from "@lsat/components/ui/badge";
import { useByType, useTraps } from "@lsat/lib/hooks";
import { useCreateDrill } from "@lsat/lib/mutations";
import { trapLabel } from "@lsat/lib/labels";
import { pct } from "@lsat/lib/utils";
import type { DrillConfig } from "@lsat/lib/types";

/** R4-A5 — 5-question micro-drill from top trap + weakest type. */
export function TrapSpiralCard() {
  const navigate = useNavigate();
  const traps = useTraps(30);
  const byType = useByType("official", 30);
  const createDrill = useCreateDrill();

  const topTrap = traps.data?.data?.[0];
  const weak =
    byType.data?.data
      ?.slice()
      .sort((a, b) => a.accuracy - b.accuracy)[0] ?? null;

  function start() {
    if (!weak) return;
    const config: DrillConfig = {
      section_type: weak.section_type,
      q_type: weak.q_type,
      count: 5,
      source: "any",
      timed: true,
    };
    createDrill.mutate(config, {
      onSuccess: (res) => {
        const first = res.questions[0];
        navigate(`/take/${first ? first.section_id : res.session_id}`);
      },
      onError: () => navigate(`/take/${weak.section_type === "RC" ? 12 : 11}`),
    });
  }

  return (
    <Card className="border-warning/30 bg-warning-subtle">
      <CardHeader>
        <CardTitle voice="display" className="flex items-center gap-2">
          <Icon as={Zap} size="md" className="text-warning" />
          Trap spiral
        </CardTitle>
        <CardDescription>
          Five timed questions on your weakest type — watch for your top trap pattern.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {topTrap && (
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span>Top trap:</span>
            <Badge variant="outline">{trapLabel(topTrap.trap_type)}</Badge>
            <span className="text-muted-foreground">
              ({topTrap.times_fell_for} misses · {pct(topTrap.pct)})
            </span>
          </div>
        )}
        {weak ? (
          <p className="text-sm text-muted-foreground">
            Weakest type: <strong>{weak.q_type}</strong> ({pct(weak.accuracy)} accuracy)
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Complete drills to see weak types.</p>
        )}
        <Button onClick={start} disabled={!weak || createDrill.isPending}>
          {createDrill.isPending ? "Building…" : "Start 5-question spiral"}
        </Button>
      </CardContent>
    </Card>
  );
}
