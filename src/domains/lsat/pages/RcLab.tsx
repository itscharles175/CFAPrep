import { BookMarked, Clock, Map, RefreshCw, SearchCheck } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageLayout, PageSection } from "@/components/page-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Icon } from "@/components/ui/icon";
import { api } from "@/lib/api";
import { useRCDashboard, useRCPassageMaps } from "@/lib/hooks";
import { pct } from "@/lib/utils";

export default function RcLab() {
  const qc = useQueryClient();
  const dashboard = useRCDashboard();
  const maps = useRCPassageMaps();
  const d = dashboard.data?.data;
  const usingSample = dashboard.data?.usingSample || maps.data?.usingSample;
  const hasQueryError = dashboard.isError || maps.isError;

  async function refreshMap(passageId: number) {
    await api.rcPassageMap(passageId, true);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["rc-dashboard"] }),
      qc.invalidateQueries({ queryKey: ["rc-passage-maps"] }),
    ]);
    toast.success("RC map refreshed");
  }

  return (
    <PageLayout
      title="RC Lab"
      eyebrow="Content intelligence"
      icon={BookMarked}
      width="2xl"
      description="Passage structure, paragraph roles, and RC timing evidence in one reader-first workspace."
    >
      {(usingSample || hasQueryError) && (
        <div
          role="status"
          className={
            hasQueryError
              ? "rounded-md border border-destructive/35 bg-destructive/10 p-3 text-sm text-destructive"
              : "rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-foreground"
          }
        >
          {hasQueryError
            ? "RC Lab could not load current backend passage evidence."
            : "RC Lab is showing offline fallback data until the backend responds."}
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-5">
        <Metric label="Passages" value={d?.passages ?? 0} />
        <Metric label="Questions" value={d?.questions ?? 0} />
        <Metric label="Mapped" value={d?.mapped_passages ?? 0} />
        <Metric label="Coverage" value={pct(d?.coverage ?? 0)} />
        <Metric label="Tagged" value={pct(d?.tag_coverage?.coverage ?? 0)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Icon as={Clock} size="sm" />
            RC readiness signals
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Progress value={Math.round((d?.coverage ?? 0) * 100)} />
          <div className="grid gap-3 text-sm md:grid-cols-3">
            <div>
              <p className="text-muted-foreground">Attempts</p>
              <p className="font-medium">{d?.timing.attempts ?? 0}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Average time</p>
              <p className="font-medium">
                {d?.timing.avg_time_ms ? `${Math.round(d.timing.avg_time_ms / 1000)}s` : "pending"}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Accuracy</p>
              <p className="font-medium">{d?.timing.accuracy != null ? pct(d.timing.accuracy) : "pending"}</p>
            </div>
          </div>
          <div className="grid gap-3 text-sm md:grid-cols-3">
            <div>
              <p className="text-muted-foreground">Tagged questions</p>
              <p className="font-medium">
                {d?.tag_coverage?.tagged_questions ?? 0} / {d?.tag_coverage?.total_questions ?? 0}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Low confidence tags</p>
              <p className="font-medium">{d?.tag_coverage?.low_confidence ?? 0}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Scope mix</p>
              <p className="font-medium">
                {Object.keys(d?.tag_coverage?.by_scope ?? {}).length || 0} scope(s)
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {(d?.next_actions ?? []).map((action) => (
              <Badge key={action} variant="outline">{action}</Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      <PageSection title="Passage maps" eyebrow="Structure">
        <div className="grid gap-3">
          {(maps.data?.data ?? []).map((map) => (
            <Card key={map.passage_id}>
              <CardContent className="space-y-4 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-medium">
                      Passage {map.passage_id}{map.topic ? ` · ${map.topic}` : ""}
                    </h3>
                    <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                      {map.structure.main_point_hint || "No main point hint yet."}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => refreshMap(map.passage_id)}>
                    <RefreshCw className="h-4 w-4" aria-hidden />
                    Refresh
                  </Button>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {map.paragraph_roles.map((role) => (
                    <div key={role.index} className="rounded-md border bg-surface-1 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium">
                          {role.line_ref ?? `P${role.index}`} · Paragraph {role.index}
                        </p>
                        <Badge variant="secondary">{formatLabel(role.role)}</Badge>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {role.viewpoint?.label && (
                          <Badge variant="outline">{formatLabel(role.viewpoint.label)}</Badge>
                        )}
                        {role.evidence_markers?.slice(0, 2).map((marker) => (
                          <Badge key={marker} variant="outline">
                            {marker}
                          </Badge>
                        ))}
                      </div>
                      <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">
                        {role.text_preview}
                      </p>
                    </div>
                  ))}
                </div>
                {!!map.evidence_refs?.length && (
                  <div className="rounded-md border bg-surface-2 p-3">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <SearchCheck className="h-4 w-4" aria-hidden />
                      Evidence anchors
                    </div>
                    <div className="mt-2 grid gap-2 md:grid-cols-2">
                      {map.evidence_refs.slice(0, 4).map((ref) => (
                        <div key={`${ref.line_ref}-${ref.marker}`} className="text-sm">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant="outline">{ref.line_ref}</Badge>
                            <Badge variant="secondary">{formatLabel(ref.evidence_type)}</Badge>
                            <span className="text-xs text-muted-foreground">{ref.marker}</span>
                          </div>
                          <p className="mt-1 line-clamp-2 text-muted-foreground">{ref.text_preview}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {!!map.question_tags?.length && (
                  <div className="flex flex-wrap gap-2">
                    {map.question_tags.slice(0, 8).map((tag) => (
                      <Badge key={tag.question_id} variant="outline">
                        {tag.q_type} · {formatLabel(tag.scope)}
                        {tag.anchor_ref ? ` · ${tag.anchor_ref}` : ""}
                      </Badge>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
          {!maps.data?.data.length && (
            <Card>
              <CardContent className="p-4 text-sm text-muted-foreground">
                Import or seed RC passages to generate structure maps.
              </CardContent>
            </Card>
          )}
        </div>
      </PageSection>
    </PageLayout>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Map className="h-4 w-4" aria-hidden />
          <p className="text-xs uppercase tracking-normal">{label}</p>
        </div>
        <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}

function formatLabel(value: string) {
  return value.replace(/_/g, " ");
}
