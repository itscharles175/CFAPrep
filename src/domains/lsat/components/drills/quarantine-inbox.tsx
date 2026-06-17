import { ShieldAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@lsat/components/ui/card";
import { Badge } from "@lsat/components/ui/badge";
import { qTypeLabel } from "@lsat/lib/labels";
import type { Question } from "@lsat/lib/types";

/**
 * LSAT-7 — quarantine inbox. Questions held back from drills (the AI quarantine
 * queue) never get served, so this surfaces them for triage. Read-only here: the
 * existing Quarantine page owns approve/requarantine; the drills surface just
 * needs visibility so the user knows what's excluded from their sets.
 */
export function QuarantineInbox({
  questions,
  max = 6,
}: {
  questions: Question[];
  max?: number;
}) {
  const rows = questions.slice(0, max);
  return (
    <Card className="border-warning/30 bg-warning-subtle">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-warning" aria-hidden />
            Quarantine inbox
          </span>
          <Badge variant={questions.length ? "warning" : "success"}>
            {questions.length} held
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map((q) => (
          <div key={q.id} className="rounded-md border bg-background p-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate font-medium">
                #{q.id} · {qTypeLabel(q.q_type)}
              </p>
              <Badge variant="outline">{q.passage_id ? "RC" : "LR"}</Badge>
            </div>
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
              {q.stem || q.prompt}
            </p>
          </div>
        ))}
        {!rows.length && (
          <p className="rounded-md border border-dashed bg-background p-3 text-sm text-muted-foreground">
            Nothing quarantined — all approved content is drill-eligible.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
