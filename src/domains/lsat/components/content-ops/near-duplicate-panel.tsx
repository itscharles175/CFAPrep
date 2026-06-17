import { Loader2, SearchCheck, ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@lsat/components/ui/card";
import { Badge } from "@lsat/components/ui/badge";
import { Button } from "@lsat/components/ui/button";
import type { ContentHealth } from "@lsat/lib/types";

type DuplicateCluster = ContentHealth["duplicates"]["clusters"][number];

/**
 * LSAT-7 — near-duplicate cluster panel. Renders the union-find clusters (cosine
 * >= 0.93 / content_hash) with a one-click "keep canonical + quarantine the rest"
 * merge action. The merge contract mirrors ContentOps' existing duplicate
 * remediation (canonical id + the full expected id set), so the parent owns the
 * mutation and this stays a presentational surface.
 */
export function NearDuplicatePanel({
  clusters,
  onMerge,
  mergingKey,
  max = 8,
}: {
  clusters: DuplicateCluster[];
  onMerge?: (
    clusterKey: string,
    canonicalId: number,
    questionIds: number[],
  ) => void;
  mergingKey?: string | null;
  max?: number;
}) {
  const visible = clusters.slice(0, max);
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-medium">
            <SearchCheck className="h-4 w-4" aria-hidden />
            Near-duplicate clusters
          </div>
          <Badge variant={clusters.length ? "warning" : "success"}>
            {clusters.length} cluster{clusters.length === 1 ? "" : "s"}
          </Badge>
        </div>
        {visible.map((cluster) => {
          const clusterKey = cluster.cluster_key ?? cluster.content_hash;
          const questionIds = cluster.question_ids ?? [];
          const canonicalId = cluster.recommended_canonical_id ?? questionIds[0];
          const retireCount =
            cluster.quarantine_candidate_ids?.length ??
            Math.max(0, questionIds.length - 1);
          const canMerge = Boolean(onMerge && canonicalId && questionIds.length >= 2);
          return (
            <div key={clusterKey} className="rounded-md border p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate font-medium">{clusterKey}</p>
                <Badge variant="warning">{cluster.count} rows</Badge>
              </div>
              {cluster.duplicate_kind && (
                <Badge variant="outline" className="mt-2">
                  {cluster.duplicate_kind.replace(/_/g, " ")}
                </Badge>
              )}
              {!!questionIds.length && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Questions {questionIds.slice(0, 6).map((id) => `#${id}`).join(", ")}
                </p>
              )}
              {cluster.sample && (
                <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                  {cluster.sample}
                </p>
              )}
              {canMerge && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={() => onMerge?.(clusterKey, canonicalId!, questionIds)}
                  disabled={mergingKey === clusterKey}
                  aria-label={`Merge cluster ${clusterKey}: keep #${canonicalId}, quarantine ${retireCount}`}
                >
                  {mergingKey === clusterKey ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <ShieldCheck className="h-4 w-4" aria-hidden />
                  )}
                  Merge: keep #{canonicalId}, retire {retireCount}
                </Button>
              )}
            </div>
          );
        })}
        {!clusters.length && (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            No near-duplicate clusters detected.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
