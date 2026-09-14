import { Clock, Map, RefreshCw, SearchCheck, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageSection } from "@lsat/components/page-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/Primitives";
import { Progress } from "@lsat/components/ui/progress";
import { Icon } from "@lsat/components/ui/icon";
import { api } from "@lsat/lib/api";
import { useRCDashboard, useRCPassageMaps } from "@lsat/lib/hooks";
import { pct } from "@lsat/lib/utils";
import { SampleDataRecovery } from "@lsat/components/sample-data-recovery";

export default function RcLab() {
  const qc = useQueryClient();
  const dashboard = useRCDashboard();
  const maps = useRCPassageMaps();
  const d = dashboard.data?.data;
  const dashboardIsSample = dashboard.data?.usingSample ?? false;
  const mapsAreSample = maps.data?.usingSample ?? false;
  const usingSample = dashboardIsSample || mapsAreSample;
  const hasQueryError = dashboard.isError || maps.isError;
  const showLiveData = !usingSample && !hasQueryError;

  function retry() {
    void Promise.all([dashboard.refetch(), maps.refetch()]);
  }

  async function refreshMap(passageId: number) {
    await api.rcPassageMap(passageId, true);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["rc-dashboard"] }),
      qc.invalidateQueries({ queryKey: ["rc-passage-maps"] }),
    ]);
    toast.success("RC map refreshed");
  }

  return (
    // K4-9 — host chrome bridge. The page previously routed through the LSAT
    // `PageLayout` (eyebrow + serif title + graphite icon chip + a centered
    // `max-w-6xl` reading column from `width="2xl"`). On host primitives that maps
    // to the host `PageHeader` (eyebrow → badge, description → subtitle) inside the
    // host `.page-container`, with the `max-w-6xl` column preserved via an inner
    // `mx-auto` wrapper so the dashboard keeps its width/layout. The `BookMarked`
    // header chip is dropped (host headers have no icon slot) — an intentional
    // skin delta. Behaviour and child markup are unchanged.
    <div className="page-container">
      <div className="mx-auto max-w-6xl space-y-[calc(var(--space-unit)*4)]">
        <PageHeader
          badge="Library · Passage analysis"
          title="RC Lab"
          subtitle="A reader-first view of passage structure, timing evidence, and traceable line anchors."
        />
        {usingSample ? (
          <SampleDataRecovery
            section="RC Lab"
            affectedSections={["Readiness signals", "Passage maps", "Passage generation"]}
            onRetry={retry}
          />
        ) : hasQueryError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/35 bg-destructive/10 p-3 text-sm text-destructive"
          >
            <span>RC Lab could not load current passage evidence.</span>
            <Button variant="outline" size="sm" onClick={retry}>Retry</Button>
          </div>
        ) : null}
        {showLiveData && (
        <>
      <div className="grid gap-4 md:grid-cols-5">
        <Metric label="Passages" value={d?.passages ?? 0} />
        <Metric label="Questions" value={d?.questions ?? 0} />
        <Metric label="Mapped" value={d?.mapped_passages ?? 0} />
        <Metric label="Coverage" value={pct(d?.coverage ?? 0)} />
        <Metric label="Tagged" value={pct(d?.tag_coverage?.coverage ?? 0)} />
      </div>

      <Card className="border-border/80 shadow-sm">
        <CardHeader className="border-b bg-surface-1/70">
          <CardTitle className="flex items-center gap-2 text-base">
            <Icon as={Clock} size="sm" />
            RC readiness signals
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
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

      <PassageFirstGenerator />

      <PageSection title="Passage maps" eyebrow="Reader notes" description="Paragraph roles remain visible; line-level support is available when you need to inspect it.">
        <div className="grid gap-3">
          {(maps.data?.data ?? []).map((map) => (
            <Card key={map.passage_id} className="border-border/80 shadow-sm">
              <CardContent className="space-y-4 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Passage map</p>
                    <h3 className="mt-1 font-medium">
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
                <div className="grid gap-2 rounded-card bg-surface-1/60 p-2 md:grid-cols-2">
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
                  <details className="rounded-card border bg-surface-1/60 p-3">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium marker:content-none">
                      <span className="flex items-center gap-2"><SearchCheck className="h-4 w-4 text-primary" aria-hidden /> Evidence anchors</span>
                      <Badge variant="outline">{map.evidence_refs.length} refs</Badge>
                    </summary>
                    <div className="mt-3 grid gap-2 border-t pt-3 md:grid-cols-2">
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
                  </details>
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
            <Card className="border-dashed bg-surface-1/40">
              <CardContent className="p-6 text-sm text-muted-foreground">
                <p className="font-medium text-foreground">No passage maps yet</p>
                <p className="mt-1">Import or seed RC passages to generate structure maps and line-level evidence anchors.</p>
              </CardContent>
            </Card>
          )}
        </div>
        </PageSection>
        </>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <Card className="border-border/80 bg-surface-1/60 shadow-sm">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Map className="h-4 w-4" aria-hidden />
          <p className="text-xs uppercase tracking-[0.12em]">{label}</p>
        </div>
        <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}

// LSAT-5 — passage-first RC generation, wired into the UI (the backend endpoints
// existed + were tested but had no consumer). Starts a job, polls its progress,
// and toasts on completion; the generated questions land in the bank for review.
const RC_LEAD_TYPES = [
  "MainPoint",
  "PrimaryPurpose",
  "Inference",
  "Detail",
  "Function",
  "Tone",
  "Structure",
  "Analogy",
];
const TERMINAL = new Set(["done", "failed", "cancelled"]);

function PassageFirstGenerator() {
  const [qType, setQType] = useState("MainPoint");
  const [count, setCount] = useState(4);
  const [job, setJob] = useState<{ id: number; status: string; pct: number } | null>(null);
  const pollRef = useRef<number | undefined>(undefined);
  const pollAbortRef = useRef<AbortController | null>(null);
  const [actionPending, setActionPending] = useState<"cancel" | "retry" | null>(null);
  // Guards every post-await state write / interval creation. Without it, a job
  // started just before unmount would resolve AFTER cleanup ran (so there is no
  // interval to clear yet) and install a permanent interval + setState on a dead
  // component. Set false in the cleanup below; checked after each await.
  const mountedRef = useRef(true);
  const busy = job != null && !TERMINAL.has(job.status);

  useEffect(
    () => () => {
      mountedRef.current = false;
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollAbortRef.current?.abort();
      pollAbortRef.current = null;
    },
    [],
  );

  function stopPolling() {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = undefined;
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
  }

  function beginPolling(jobId: number) {
    stopPolling();
    const controller = new AbortController();
    pollAbortRef.current = controller;
    const poll = async () => {
      try {
        const p = await api.passageJobProgress(jobId, controller.signal);
        if (!mountedRef.current || controller.signal.aborted) return;
        setJob({ id: jobId, status: p.status, pct: Math.round(p.progress_pct ?? 0) });
        if (TERMINAL.has(p.status)) {
          stopPolling();
          if (p.status === "done") {
            toast.success(`Passage generated — ${p.accepted ?? 0} question(s) added to the bank`);
          } else if (p.status === "failed") {
            toast.error("Passage generation failed. You can retry this job.");
          }
        }
      } catch {
        if (!mountedRef.current || controller.signal.aborted) return;
        // Keep the job visible so an interrupted network request can be retried
        // without losing the user's selected generation settings.
        stopPolling();
        setJob((current) => (current?.id === jobId ? { ...current, status: "failed" } : current));
        toast.error("Lost contact with the passage-generation job. Retry when the backend is available.");
      }
    };
    void poll();
    pollRef.current = window.setInterval(() => void poll(), 2500);
  }

  async function start() {
    if (busy || actionPending) return;
    try {
      const res = await api.createPassageJob(qType, count);
      if (!mountedRef.current) return; // unmounted while the create was in flight
      setJob({ id: res.job_id, status: res.status, pct: 0 });
      toast.success(`Queued passage-first job #${res.job_id}`);
      beginPolling(res.job_id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start passage generation");
    }
  }

  async function cancel() {
    if (!job || !busy || actionPending) return;
    setActionPending("cancel");
    try {
      const result = await api.cancelPassageJob(job.id);
      if (!result.ok) throw new Error(result.reason || "The backend did not accept cancellation");
      stopPolling();
      setJob((current) => (current?.id === job.id ? { ...current, status: "cancelled" } : current));
      toast.success(`Passage job #${job.id} cancelled`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not cancel passage generation");
    } finally {
      if (mountedRef.current) setActionPending(null);
    }
  }

  async function retry() {
    if (!job || busy || actionPending) return;
    setActionPending("retry");
    try {
      const result = await api.retryPassageJob(job.id);
      if (!result.ok) throw new Error(result.reason || "The backend did not accept retry");
      setJob((current) => (current?.id === job.id ? { ...current, status: result.status || "pending", pct: 0 } : current));
      toast.success(`Retrying passage job #${job.id}`);
      beginPolling(job.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not retry passage generation");
    } finally {
      if (mountedRef.current) setActionPending(null);
    }
  }

  return (
    <Card className="border-border/80 shadow-sm">
      <CardHeader className="border-b bg-surface-1/70">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon as={Sparkles} size="sm" />
          Passage-first generation
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Generate one coherent RC passage with a varied question set built around a
          lead question type. The durable worker drains the job; new questions land in
          the bank for review.
        </p>
        <div className="flex flex-wrap items-end gap-3 rounded-card bg-surface-1/60 p-3">
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">Lead question type</span>
            <select
              value={qType}
              onChange={(e) => setQType(e.target.value)}
              disabled={busy}
              className="min-h-10 rounded-md border bg-background px-2 py-1.5 text-sm"
            >
              {RC_LEAD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">Questions</span>
            <input
              type="number"
              min={1}
              max={8}
              value={count}
              disabled={busy}
              onChange={(e) => setCount(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
              className="min-h-10 w-20 rounded-md border bg-background px-2 py-1.5 text-sm"
            />
          </label>
          <Button size="sm" onClick={start} disabled={busy}>
            <Icon as={Sparkles} size="sm" />
            {busy ? "Generating…" : "Generate"}
          </Button>
        </div>
        {job && (
          <div className="space-y-2" role="status" aria-live="polite">
            <Progress value={job.pct} aria-label={`Passage generation ${job.pct}%`} />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground tabular-nums">
                Job #{job.id} · {formatLabel(job.status)} · {job.pct}%
              </p>
              <div className="flex flex-wrap gap-2">
                {busy && (
                  <Button size="sm" variant="outline" onClick={() => void cancel()} disabled={actionPending !== null}>
                    {actionPending === "cancel" ? "Cancelling…" : "Cancel generation"}
                  </Button>
                )}
                {!busy && (job.status === "failed" || job.status === "cancelled") && (
                  <Button size="sm" variant="outline" onClick={() => void retry()} disabled={actionPending !== null}>
                    {actionPending === "retry" ? "Retrying…" : "Retry generation"}
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function formatLabel(value: string) {
  return value.replace(/_/g, " ");
}
