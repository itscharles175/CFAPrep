import { History } from "lucide-react";
import { Card, CardContent } from "@lsat/components/ui/card";
import { Badge } from "@lsat/components/ui/badge";
import type { AuditLogEntry } from "@lsat/lib/types";

/**
 * LSAT-7 — audit-log viewer. Renders the recent AuditLog feed (content edits:
 * tag/difficulty/approval/quarantine changes) newest-first with by-entity/by-field
 * tallies, so a reviewer can see "what changed recently" inside the cockpit.
 */
export function AuditLogViewer({
  edits,
  byEntity,
  byField,
  max = 12,
}: {
  edits: AuditLogEntry[];
  byEntity?: Record<string, number>;
  byField?: Record<string, number>;
  max?: number;
}) {
  const rows = edits.slice(0, max);
  const entityTallies = Object.entries(byEntity ?? {}).sort((a, b) => b[1] - a[1]);
  const fieldTallies = Object.entries(byField ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-medium">
            <History className="h-4 w-4" aria-hidden />
            Audit log
          </div>
          <Badge variant="outline">{edits.length} recent</Badge>
        </div>
        {(entityTallies.length > 0 || fieldTallies.length > 0) && (
          <div className="flex flex-wrap gap-1.5">
            {entityTallies.map(([entity, count]) => (
              <Badge key={`e-${entity}`} variant="secondary">
                {entity.replace(/_/g, " ")}: {count}
              </Badge>
            ))}
            {fieldTallies.map(([field, count]) => (
              <Badge key={`f-${field}`} variant="outline">
                {field.replace(/_/g, " ")} ×{count}
              </Badge>
            ))}
          </div>
        )}
        <div className="space-y-2">
          {rows.map((edit) => (
            <div key={edit.id} className="rounded-md border p-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate font-medium">
                  {edit.entity.replace(/_/g, " ")} #{edit.entity_id} ·{" "}
                  {edit.field.replace(/_/g, " ")}
                </p>
                {edit.created_at && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {new Date(edit.created_at).toLocaleString()}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {(edit.old_value ?? "∅")} → <span className="text-foreground">{edit.new_value ?? "∅"}</span>
              </p>
            </div>
          ))}
        </div>
        {!rows.length && (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            No recent content edits.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
