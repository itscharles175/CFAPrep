import { useCallback, useEffect, useState } from "react";
import { AlertCircle, History } from "lucide-react";
import { Button } from "@lsat/components/ui/button";
import { Badge } from "@lsat/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@lsat/components/ui/card";
import { EmptyState, SkeletonList } from "@lsat/components/states";
import { api } from "@lsat/lib/api";
import { formatDate } from "@lsat/lib/utils";
import type { ImportJobSummary } from "@lsat/lib/types";

/** R4-F4 — list past import parse jobs. */
export function ImportJobHistory({
  onResume,
}: {
  onResume: (jobId: number) => void;
}) {
  const [jobs, setJobs] = useState<ImportJobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadJobs = useCallback(() => {
    setLoading(true);
    setError(null);
    void api
      .listImportJobs()
      .then(setJobs)
      .catch((err) => {
        setJobs([]);
        setError(err instanceof Error ? err.message : "Could not load import history.");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  if (loading) {
    return (
      <Card>
        <ImportHistoryHeader />
        <CardContent>
          <div role="status" aria-busy="true" aria-live="polite">
            <span className="sr-only">Loading import history</span>
            <SkeletonList rows={3} />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <ImportHistoryHeader />
        <CardContent>
          <EmptyState
            title="Could not load import history"
            description={error}
            icon={<AlertCircle className="h-5 w-5" aria-hidden />}
            action={
              <Button variant="outline" size="sm" className="min-h-10" onClick={loadJobs}>
                Retry
              </Button>
            }
          />
        </CardContent>
      </Card>
    );
  }

  if (!jobs.length) {
    return (
      <Card>
        <ImportHistoryHeader />
        <CardContent>
          <EmptyState
            title="No import jobs yet"
            description="Parsed PrepTests will appear here so interrupted verification work can be resumed."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <ImportHistoryHeader />
      <CardContent className="space-y-2">
        {jobs.slice(0, 8).map((j) => (
          <div
            key={j.job_id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="truncate font-medium">{j.filename}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatDate(j.created_at)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {j.committed ? (
                <Badge variant="secondary">Committed</Badge>
              ) : (
                <Badge variant="outline">Pending verify</Badge>
              )}
              {!j.committed && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onResume(j.job_id)}
                >
                  Resume
                </Button>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ImportHistoryHeader() {
  return (
    <CardHeader>
      <CardTitle className="flex items-center gap-2 text-base">
        <History className="h-4 w-4" aria-hidden />
        Import history
      </CardTitle>
    </CardHeader>
  );
}
