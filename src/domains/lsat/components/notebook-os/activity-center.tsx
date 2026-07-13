import { Activity } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@lsat/components/ui/card";
import { Icon } from "@lsat/components/ui/icon";
import { Progress } from "@lsat/components/ui/progress";
import type { ActivityEvent } from "@lsat/lib/types";

export function ActivityCenter({ events }: { events: ActivityEvent[] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon as={Activity} size="sm" />
          Activity
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {events.slice(0, 6).map((event) => (
          <div key={event.id} className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 truncate text-sm font-medium">{event.title}</p>
              <span className="shrink-0 text-xs text-muted-foreground">{event.status}</span>
            </div>
            <Progress value={event.progress_pct} className="h-1.5" />
          </div>
        ))}
        {!events.length && (
          <p className="text-sm text-muted-foreground">
            Ingestion, transformations, podcasts, exports, and trust checks will appear here.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
