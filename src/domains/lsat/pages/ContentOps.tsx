import {
  Activity,
  AlertTriangle,
  DatabaseZap,
  Edit3,
  GitBranch,
  ListChecks,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  SearchCheck,
  ShieldCheck,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageLayout, PageSection } from "@lsat/components/page-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@lsat/components/ui/card";
import { Button } from "@lsat/components/ui/button";
import { Badge } from "@lsat/components/ui/badge";
import { Input } from "@lsat/components/ui/input";
import { Label } from "@lsat/components/ui/label";
import { Switch } from "@lsat/components/ui/switch";
import { Textarea } from "@lsat/components/ui/textarea";
import { ApiError, api } from "@lsat/lib/api";
import type {
  ContentSourceRegistry,
  ContentVersionFilters,
  ContentVersionRecord,
  SourcePolicyReview,
  SourcePolicyUpdate,
  ValidatorRunContext,
  ValidatorRunMeta,
  ValidatorRunRecord,
} from "@lsat/lib/types";
import {
  useBenchmarkRuns,
  useContentHealth,
  useContentRevalidation,
  useContentSources,
  useContentVersions,
  useReleaseTrust,
  useMigrationPreview,
  useScheduledTasks,
  useValidatorRuns,
} from "@lsat/lib/hooks";

type ContentSourceRow = Pick<
  ContentSourceRegistry,
  "key" | "label" | "source_type" | "license" | "eligibility" | "firewall" | "policy_review"
>;

type SourcePolicyDraft = {
  label: string;
  source_type: string;
  license: string;
  cloud: boolean;
  training: boolean;
  exportable: boolean;
  reviewer_note: string;
};

type VersionEntityFilter = "all" | "question" | "source_registry";
type VersionReasonFilter = "all" | "remediation" | "source_policy";

export default function ContentOps() {
  const qc = useQueryClient();
  const [versionEntityFilter, setVersionEntityFilter] = useState<VersionEntityFilter>("all");
  const [versionReasonFilter, setVersionReasonFilter] = useState<VersionReasonFilter>("all");
  const [versionSourceFilter, setVersionSourceFilter] = useState("");
  const versionFilters: ContentVersionFilters = {
    limit: 200,
    ...(versionEntityFilter !== "all" ? { entity: versionEntityFilter } : {}),
    ...(versionReasonFilter !== "all"
      ? { reason_contains: versionReasonFilter === "source_policy" ? "source_policy" : "remediation" }
      : {}),
    ...(versionSourceFilter.trim() ? { source_key: versionSourceFilter.trim() } : {}),
  };
  const health = useContentHealth();
  const revalidation = useContentRevalidation();
  const sources = useContentSources();
  const validators = useValidatorRuns();
  const versions = useContentVersions(versionFilters);
  const releaseTrust = useReleaseTrust("release");
  const schedule = useScheduledTasks();
  const benchmarks = useBenchmarkRuns();
  const migrations = useMigrationPreview();
  const [revalidating, setRevalidating] = useState(false);
  const [remediatingId, setRemediatingId] = useState<number | null>(null);
  const [remediatingDuplicateKey, setRemediatingDuplicateKey] = useState<string | null>(null);
  const [editingSourceKey, setEditingSourceKey] = useState<string | null>(null);
  const [sourceDraft, setSourceDraft] = useState<SourcePolicyDraft | null>(null);
  const [savingSourceKey, setSavingSourceKey] = useState<string | null>(null);
  const [restoringVersionId, setRestoringVersionId] = useState<number | null>(null);
  const [sourcePolicyReviews, setSourcePolicyReviews] = useState<Record<string, SourcePolicyReview>>({});
  const h = health.data?.data;
  const revalidationSummary = revalidation.data?.data ?? h?.revalidation;
  const revalidationRows = revalidationSummary?.queue ?? [];
  const revalidationFailures = revalidationSummary?.recent_failures ?? [];
  const sourceRows: ContentSourceRow[] = sources.data?.data.length
    ? sources.data.data
    : (h?.source_registry?.sources ?? []);
  const validatorRows = validators.data?.data.length
    ? validators.data.data
    : (h?.validator_runs?.recent ?? []);
  const versionRows = versions.data?.data ?? [];
  const releaseManifest = releaseTrust.data?.data;
  const releaseLocalCheck = releaseManifest?.checks.release_local;
  const benchmarkRows = benchmarks.data?.data.runs ?? [];
  const sourceCounts = Object.entries(h?.by_source ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const sourceRegistryByKey = new Map(sourceRows.map((source) => [source.key, source]));
  const validatorFailures = Object.entries(h?.validator_runs?.failure_reasons ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const duplicateClusters = h?.duplicates.clusters ?? [];
  const provenanceRows = h?.provenance_score?.sources ?? [];
  const visibleProvenanceRows = provenanceRows
    .filter((source) => source.question_count > 0 || source.status !== "ok")
    .slice(0, 8);
  const notebookViolationCount = Object.values(
    h?.official_firewall.notebook_violations ?? {},
  ).reduce((sum, ids) => sum + (Array.isArray(ids) ? ids.length : 0), 0);
  const trustSignals = [
    {
      label: "Provenance score",
      value: `${h?.provenance_score?.score ?? 0}/100`,
      detail: h?.provenance_score?.summary ?? "No source score available",
      icon: ShieldCheck,
      variant: statusVariant(h?.provenance_score?.status),
    },
    {
      label: "Release contract",
      value: releaseManifest ? `${releaseManifest.score}/100` : "0/100",
      detail:
        releaseLocalCheck?.summary ??
        releaseManifest?.next_actions[0] ??
        "Release trust evidence unavailable",
      icon: statusVariant(releaseManifest?.status) === "destructive" ? ShieldAlert : ShieldCheck,
      variant: releaseContractVariant(
        releaseManifest?.status,
        releaseLocalCheck?.status,
      ),
    },
    {
      label: "Official firewall",
      value: h?.official_firewall.ok ? "clean" : "blocked",
      detail: `${h?.official_firewall.training_eligible_official_count ?? 0} training leak candidates · ${notebookViolationCount} notebook violations`,
      icon: ShieldCheck,
      variant: h?.official_firewall.ok ? "success" : "destructive",
    },
    {
      label: "Duplicate clusters",
      value: h?.duplicates.cluster_count ?? 0,
      detail: duplicateClusters.length
        ? `${duplicateClusters[0].count} rows in largest visible cluster`
        : "No duplicate content_hash clusters",
      icon: SearchCheck,
      variant: (h?.duplicates.cluster_count ?? 0) ? "warning" : "success",
    },
    {
      label: "Validator coverage",
      value: h?.validator_coverage.ai_without_validator_count ?? 0,
      detail: `${h?.validator_coverage.known_validator_types.length ?? 0} known validator types`,
      icon: ListChecks,
      variant: (h?.validator_coverage.ai_without_validator_count ?? 0)
        ? "warning"
        : "success",
    },
    {
      label: "Revalidation queue",
      value: revalidationSummary?.due_count ?? 0,
      detail: `${revalidationSummary?.approved_ai_count ?? 0} approved AI · ${revalidationSummary?.rc_count ?? 0} RC`,
      icon: RefreshCw,
      variant: (revalidationSummary?.failed_count ?? 0)
        ? "destructive"
        : (revalidationSummary?.due_count ?? 0)
          ? "warning"
          : "success",
    },
    {
      label: "Tag confidence",
      value: h?.tag_confidence.low ?? 0,
      detail: "Low-confidence tag rows needing review",
      icon: AlertTriangle,
      variant: (h?.tag_confidence.low ?? 0) ? "warning" : "success",
    },
    {
      label: "Choice integrity",
      value: h?.choice_integrity.nonstandard_choice_count ?? 0,
      detail: "Questions without the standard five choices",
      icon: DatabaseZap,
      variant: (h?.choice_integrity.nonstandard_choice_count ?? 0)
        ? "destructive"
        : "success",
    },
    {
      label: "Version snapshots",
      value: h?.versioning.snapshots ?? 0,
      detail: versionBreakdown(h?.versioning.by_entity ?? {}),
      icon: GitBranch,
      variant: (h?.versioning.snapshots ?? 0) ? "outline" : "warning",
    },
  ] as const;
  const usingSample =
    health.data?.usingSample ||
    revalidation.data?.usingSample ||
    sources.data?.usingSample ||
    validators.data?.usingSample ||
    versions.data?.usingSample ||
    releaseTrust.data?.usingSample ||
    schedule.data?.usingSample ||
    benchmarks.data?.usingSample ||
    migrations.data?.usingSample;
  const hasQueryError =
    health.isError ||
    revalidation.isError ||
    sources.isError ||
    validators.isError ||
    versions.isError ||
    releaseTrust.isError ||
    schedule.isError ||
    benchmarks.isError ||
    migrations.isError;

  async function runTask(key: string) {
    const result = await api.runScheduledTask(key);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["scheduled-tasks"] }),
      qc.invalidateQueries({ queryKey: ["content-health"] }),
      qc.invalidateQueries({ queryKey: ["benchmark-runs"] }),
      qc.invalidateQueries({ queryKey: ["release-trust"] }),
    ]);
    if (!result.ok) {
      toast.error(
        result.error ||
          result.reason ||
          `${key.replace(/_/g, " ")} failed`,
      );
      return;
    }
    toast.success(`${key.replace(/_/g, " ")} ran`);
  }

  async function runBenchmark() {
    await api.runBenchmarkSmoke();
    await qc.invalidateQueries({ queryKey: ["benchmark-runs"] });
    await qc.invalidateQueries({ queryKey: ["release-trust"] });
    toast.success("Benchmark smoke recorded");
  }

  async function runRevalidation(force = false) {
    setRevalidating(true);
    try {
      const result = await api.runContentRevalidation({ limit: 25, force });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["content-revalidation"] }),
        qc.invalidateQueries({ queryKey: ["content-health"] }),
        qc.invalidateQueries({ queryKey: ["validator-runs"] }),
        qc.invalidateQueries({ queryKey: ["release-trust"] }),
      ]);
      if (result.failed > 0) {
        toast.error(
          `${result.failed} content item${result.failed === 1 ? "" : "s"} failed revalidation`,
        );
      } else {
        toast.success(`${result.validated} content item${result.validated === 1 ? "" : "s"} revalidated`);
      }
    } catch {
      toast.error("Content revalidation failed");
    } finally {
      setRevalidating(false);
    }
  }

  async function remediateFailedRevalidation(questionId: number) {
    setRemediatingId(questionId);
    try {
      await api.remediateContentRevalidation(questionId, {
        action: "quarantine_failed",
        reason: "content_ops_failed_revalidation",
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["content-revalidation"] }),
        qc.invalidateQueries({ queryKey: ["content-health"] }),
        qc.invalidateQueries({ queryKey: ["validator-runs"] }),
        qc.invalidateQueries({ queryKey: ["content-versions"] }),
        qc.invalidateQueries({ queryKey: ["release-trust"] }),
      ]);
      toast.success(`Question #${questionId} quarantined`);
    } catch {
      toast.error("Failed revalidation remediation failed");
    } finally {
      setRemediatingId(null);
    }
  }

  async function remediateDuplicateCluster(
    clusterKey: string,
    canonicalQuestionId: number,
    questionIds: number[],
  ) {
    setRemediatingDuplicateKey(clusterKey);
    try {
      const result = await api.remediateContentDuplicate({
        action: "quarantine_duplicates",
        cluster_key: clusterKey,
        canonical_question_id: canonicalQuestionId,
        expected_question_ids: questionIds,
        reason: "content_ops_duplicate_remediation",
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["content-health"] }),
        qc.invalidateQueries({ queryKey: ["content-versions"] }),
        qc.invalidateQueries({ queryKey: ["content-revalidation"] }),
        qc.invalidateQueries({ queryKey: ["release-trust"] }),
      ]);
      toast.success(
        `Kept #${result.canonical_question_id}; quarantined ${result.quarantined_question_ids.length} duplicate${result.quarantined_question_ids.length === 1 ? "" : "s"}`,
      );
    } catch {
      toast.error("Duplicate remediation failed");
    } finally {
      setRemediatingDuplicateKey(null);
    }
  }

  function beginSourcePolicyEdit(source: ContentSourceRow) {
    setEditingSourceKey(source.key);
    setSourceDraft(makeSourcePolicyDraft(source));
    setSourcePolicyReviews((current) => {
      const next = { ...current };
      delete next[source.key];
      return next;
    });
  }

  async function saveSourcePolicy(source: ContentSourceRow, reviewed = false) {
    if (!sourceDraft || editingSourceKey !== source.key) return;
    const activeReview = sourcePolicyReviews[source.key] ?? source.policy_review;
    const acknowledged = reviewed
      ? (activeReview?.risks ?? []).map((risk) => risk.code)
      : [];
    const body: SourcePolicyUpdate = {
      key: source.key,
      label: sourceDraft.label.trim() || source.key,
      source_type: sourceDraft.source_type.trim() || "unknown",
      license: sourceDraft.license.trim() || null,
      eligibility: {
        ...(source.eligibility ?? {}),
        export: sourceDraft.exportable,
      },
      firewall: {
        ...(source.firewall ?? {}),
        cloud: sourceDraft.cloud,
        training: sourceDraft.training,
        export: sourceDraft.exportable,
      },
      reviewed,
      acknowledged_risks: acknowledged,
      reviewer_note: sourceDraft.reviewer_note.trim(),
      reason: reviewed ? "content_ops_source_policy_review" : "source_policy_preview",
    };
    setSavingSourceKey(source.key);
    try {
      const result = await api.upsertContentSource(body);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["content-sources"] }),
        qc.invalidateQueries({ queryKey: ["content-health"] }),
        qc.invalidateQueries({ queryKey: ["content-versions"] }),
        qc.invalidateQueries({ queryKey: ["release-trust"] }),
      ]);
      setSourcePolicyReviews((current) => {
        const next = { ...current };
        delete next[source.key];
        return next;
      });
      setEditingSourceKey(null);
      setSourceDraft(null);
      const review = result.policy_review;
      toast.success(
        review?.requires_review
          ? "Reviewed source policy saved"
          : "Source policy saved",
      );
    } catch (error) {
      const review = policyReviewFromError(error);
      if (review) {
        setSourcePolicyReviews((current) => ({
          ...current,
          [source.key]: review,
        }));
        toast.error("Review source policy risks before saving");
      } else {
        toast.error("Source policy save failed");
      }
    } finally {
      setSavingSourceKey(null);
    }
  }

  async function restoreContentVersion(
    version: ContentVersionRecord,
    target: "current" | "previous",
    diff: SourcePolicyDiff,
  ) {
    setRestoringVersionId(version.id);
    const restoringReviewedSnapshot = target === "current" && diff.risks.length > 0;
    try {
      await api.restoreContentVersion(version.id, {
        target,
        reviewed: restoringReviewedSnapshot,
        acknowledged_risks: restoringReviewedSnapshot
          ? diff.risks.map((risk) => risk.code)
          : [],
        reviewer_note:
          target === "previous"
            ? `Rolled back ${diff.sourceKey} source policy from v${version.version}.`
            : `Restored ${diff.sourceKey} source policy snapshot v${version.version}.`,
        reason: "content_ops_source_policy_restore",
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["content-sources"] }),
        qc.invalidateQueries({ queryKey: ["content-health"] }),
        qc.invalidateQueries({ queryKey: ["content-versions"] }),
        qc.invalidateQueries({ queryKey: ["release-trust"] }),
      ]);
      toast.success(
        target === "previous"
          ? "Source policy rolled back"
          : "Source policy restored",
      );
    } catch (error) {
      if (policyReviewFromError(error)) {
        toast.error("Review source policy risks before restoring");
      } else {
        toast.error("Source policy restore failed");
      }
    } finally {
      setRestoringVersionId(null);
    }
  }

  return (
    <PageLayout
      title="Content Ops"
      eyebrow="Trust OS"
      icon={ShieldCheck}
      width="2xl"
      description="Source eligibility, validators, versions, scheduled maintenance, and release evidence."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => runRevalidation(false)} disabled={revalidating}>
            {revalidating ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden />
            )}
            Revalidate due
          </Button>
          <Button onClick={runBenchmark}><Activity className="h-4 w-4" aria-hidden /> Benchmark smoke</Button>
        </div>
      }
    >
      {(usingSample || hasQueryError) && (
        <TrustNotice
          tone={hasQueryError ? "error" : "warning"}
          text={
            hasQueryError
              ? "Content Ops could not load current backend evidence. Values below may be incomplete."
              : "Content Ops is showing offline fallback data until the backend responds."
          }
        />
      )}
      <div className="grid gap-4 md:grid-cols-4">
        <Metric label="Content health" value={`${h?.score ?? 0}/100`} status={h?.status ?? "pending"} />
        <Metric label="Sources" value={sourceRows.length} status="registry" />
        <Metric label="Validators" value={validatorRows.length} status="runs" />
        <Metric label="Migrations" value={`v${migrations.data?.data.pragma_user_version ?? 0}`} status={`${migrations.data?.data.pending_count ?? 0} pending`} />
      </div>

      <PageSection title="Trust cockpit" eyebrow="Evidence">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {trustSignals.map((signal) => (
            <SignalCard key={signal.label} {...signal} />
          ))}
        </div>
      </PageSection>

      <PageSection title="Approved AI revalidation" eyebrow="Validator queue">
        <div className="grid gap-3 md:grid-cols-4">
          <Metric
            label="Approved AI"
            value={revalidationSummary?.approved_ai_count ?? 0}
            status={`${revalidationSummary?.rc_count ?? 0} RC`}
          />
          <Metric
            label="Due"
            value={revalidationSummary?.due_count ?? 0}
            status={`${revalidationSummary?.missing_evidence_count ?? 0} missing evidence`}
          />
          <Metric
            label="Failures"
            value={revalidationSummary?.failed_count ?? 0}
            status="latest validator result"
          />
          <Metric
            label="Mode"
            value={revalidationSummary?.mode ?? "offline"}
            status={`lookback ${revalidationSummary?.lookback ?? 0}`}
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => runRevalidation(false)} disabled={revalidating}>
            {revalidating ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden />
            )}
            Run due queue
          </Button>
          <Button size="sm" variant="outline" onClick={() => runRevalidation(true)} disabled={revalidating}>
            Revalidate all approved AI
          </Button>
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {revalidationRows.slice(0, 8).map((row) => (
            <Card key={row.question_id}>
              <CardContent className="space-y-2 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">Question #{row.question_id}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.section_type ?? "unknown"} · {row.q_type} · {row.choice_count} choices
                    </p>
                  </div>
                  <Badge variant={row.latest_status === "failed" ? "destructive" : "warning"}>
                    {row.latest_status ?? "unvalidated"}
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {row.reasons.slice(0, 4).map((reason) => (
                    <Badge key={reason} variant="outline">{reason.replace(/_/g, " ")}</Badge>
                  ))}
                  {row.has_passage && <Badge variant="secondary">passage-aware</Badge>}
                </div>
              </CardContent>
            </Card>
          ))}
          {!revalidationRows.length && <Empty text="No approved AI content is waiting for revalidation." />}
        </div>
        {!!revalidationFailures.length && (
          <div className="mt-3 space-y-3">
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">
              {revalidationFailures.length} approved AI item{revalidationFailures.length === 1 ? "" : "s"} {revalidationFailures.length === 1 ? "has" : "have"} a failed latest revalidation.
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              {revalidationFailures.slice(0, 4).map((row) => (
                <Card key={`failed-${row.question_id}`}>
                  <CardContent className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium">Question #{row.question_id}</p>
                        <p className="text-xs text-muted-foreground">
                          {row.section_type ?? "unknown"} · {row.q_type} · run #{row.latest_run_id ?? "pending"}
                        </p>
                      </div>
                      <Badge variant="destructive">failed</Badge>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {row.reasons.slice(0, 4).map((reason) => (
                        <Badge key={reason} variant="outline">{reason.replace(/_/g, " ")}</Badge>
                      ))}
                    </div>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => remediateFailedRevalidation(row.question_id)}
                      disabled={remediatingId === row.question_id}
                      aria-label={`Quarantine failed item #${row.question_id}`}
                    >
                      {remediatingId === row.question_id ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      ) : (
                        <ShieldCheck className="h-4 w-4" aria-hidden />
                      )}
                      Quarantine failed item
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}
      </PageSection>

      <PageSection title="Provenance scoring" eyebrow="Source risk">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visibleProvenanceRows.map((source) => (
            <Card key={source.key}>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{source.label || source.key}</p>
                    <p className="text-xs text-muted-foreground">
                      {source.source_type} · {source.license || "license unknown"}
                    </p>
                  </div>
                  <Badge variant={statusVariant(source.status)}>{source.score}/100</Badge>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline">{source.question_count} questions</Badge>
                  <Badge variant="outline">{source.seeded_from ?? "unregistered"}</Badge>
                  {source.reasons.slice(0, 2).map((reason) => (
                    <Badge key={reason} variant="warning">
                      {reason.replace(/_/g, " ")}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
          {!visibleProvenanceRows.length && <Empty text="No active provenance score rows yet." />}
        </div>
      </PageSection>

      <PageSection title="Source trust summary" eyebrow="Provenance">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {sourceCounts.map(([sourceKey, count]) => {
            const registry = sourceRegistryByKey.get(sourceKey);
            return (
              <Card key={sourceKey}>
                <CardContent className="space-y-2 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate font-medium">
                      {registry?.label || sourceKey}
                    </p>
                    <Badge variant="outline">{count} questions</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {registry?.source_type ?? "unregistered"} · license{" "}
                    {registry?.license || "unknown"}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    <PolicyBadge label="cloud" value={registry?.firewall?.cloud} />
                    <PolicyBadge label="training" value={registry?.firewall?.training} />
                    <PolicyBadge label="export" value={registry?.eligibility?.export} />
                  </div>
                </CardContent>
              </Card>
            );
          })}
          {!sourceCounts.length && <Empty text="No per-source question counts yet." />}
        </div>
      </PageSection>

      <PageSection title="Scheduled maintenance" eyebrow="Scheduler">
        <div className="grid gap-3 md:grid-cols-2">
          {(schedule.data?.data.tasks ?? []).map((task) => (
            <Card key={task.key}>
              <CardContent className="flex items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="font-medium">{task.label}</p>
                  <p className="text-sm text-muted-foreground">
                    {task.task_type} · next {task.next_run_at ? new Date(task.next_run_at).toLocaleString() : "pending"}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => runTask(task.key)}>
                  <Play className="h-4 w-4" aria-hidden />
                  Run
                </Button>
              </CardContent>
            </Card>
          ))}
          {!schedule.data?.data.tasks.length && <Empty text="No scheduled tasks loaded." />}
        </div>
      </PageSection>

      <PageSection title="Content trust findings" eyebrow="Audit">
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Near-duplicate clusters</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {duplicateClusters.slice(0, 6).map((cluster) => (
                <div key={cluster.content_hash} className="rounded-md border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate font-medium">{cluster.cluster_key ?? cluster.content_hash}</p>
                    <Badge variant="warning">{cluster.count} rows</Badge>
                  </div>
                  {cluster.duplicate_kind && (
                    <Badge variant="outline" className="mt-2">
                      {cluster.duplicate_kind.replace(/_/g, " ")}
                    </Badge>
                  )}
                  {!!cluster.question_ids?.length && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Questions {cluster.question_ids.slice(0, 6).map((id) => `#${id}`).join(", ")}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {cluster.source_mix && (
                      <Badge variant="outline">sources: {formatMix(cluster.source_mix)}</Badge>
                    )}
                    {cluster.q_type_mix && (
                      <Badge variant="outline">types: {formatMix(cluster.q_type_mix)}</Badge>
                    )}
                  </div>
                  {cluster.sample && (
                    <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                      {cluster.sample}
                    </p>
                  )}
                  {(() => {
                    const clusterKey = cluster.cluster_key ?? cluster.content_hash;
                    const questionIds = cluster.question_ids ?? [];
                    const canonicalId = cluster.recommended_canonical_id ?? questionIds[0];
                    const retireCount =
                      cluster.quarantine_candidate_ids?.length ??
                      Math.max(0, questionIds.length - 1);
                    if (!canonicalId || questionIds.length < 2) return null;
                    return (
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-3"
                        onClick={() =>
                          remediateDuplicateCluster(clusterKey, canonicalId, questionIds)
                        }
                        disabled={remediatingDuplicateKey === clusterKey}
                        aria-label={`Keep question #${canonicalId} and quarantine duplicates in ${clusterKey}`}
                      >
                        {remediatingDuplicateKey === clusterKey ? (
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        ) : (
                          <ShieldCheck className="h-4 w-4" aria-hidden />
                        )}
                        Keep #{canonicalId}; quarantine {retireCount}
                      </Button>
                    );
                  })()}
                </div>
              ))}
              {!duplicateClusters.length && <Empty text="No duplicate clusters found." />}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Validator failure reasons</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {validatorFailures.map(([reason, count]) => (
                <div key={reason} className="rounded-md border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate font-medium">{reason}</p>
                    <Badge variant="warning">{count}</Badge>
                  </div>
                </div>
              ))}
              {!validatorFailures.length && <Empty text="No validator failure reasons recorded." />}
            </CardContent>
          </Card>
        </div>
      </PageSection>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Source registry</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {sourceRows.map((source) => (
              <div key={source.key} className="rounded-md border p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium">{source.label || source.key}</p>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant="outline">{source.source_type}</Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => beginSourcePolicyEdit(source)}
                      aria-label={`Edit source policy for ${source.label || source.key}`}
                    >
                      <Edit3 className="h-4 w-4" aria-hidden />
                    </Button>
                  </div>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Cloud {policyText(source.firewall.cloud)} · training{" "}
                  {policyText(source.firewall.training)} · questions{" "}
                  {h?.by_source[source.key] ?? 0}
                </p>
                {editingSourceKey === source.key && sourceDraft && (
                  <div className="mt-3 space-y-3 rounded-md bg-surface-2 p-3">
                    <div className="grid gap-2 md:grid-cols-3">
                      <div className="space-y-1">
                        <Label htmlFor={`source-${source.key}-label`}>Label</Label>
                        <Input
                          id={`source-${source.key}-label`}
                          value={sourceDraft.label}
                          onChange={(event) =>
                            setSourceDraft({ ...sourceDraft, label: event.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`source-${source.key}-type`}>Type</Label>
                        <Input
                          id={`source-${source.key}-type`}
                          value={sourceDraft.source_type}
                          onChange={(event) =>
                            setSourceDraft({ ...sourceDraft, source_type: event.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`source-${source.key}-license`}>License</Label>
                        <Input
                          id={`source-${source.key}-license`}
                          value={sourceDraft.license}
                          onChange={(event) =>
                            setSourceDraft({ ...sourceDraft, license: event.target.value })
                          }
                        />
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <PolicySwitch
                        label="Cloud"
                        checked={sourceDraft.cloud}
                        onCheckedChange={(cloud) =>
                          setSourceDraft({ ...sourceDraft, cloud })
                        }
                      />
                      <PolicySwitch
                        label="Training"
                        checked={sourceDraft.training}
                        onCheckedChange={(training) =>
                          setSourceDraft({ ...sourceDraft, training })
                        }
                      />
                      <PolicySwitch
                        label="Export"
                        checked={sourceDraft.exportable}
                        onCheckedChange={(exportable) =>
                          setSourceDraft({ ...sourceDraft, exportable })
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`source-${source.key}-reviewer-note`}>Reviewer note</Label>
                      <Textarea
                        id={`source-${source.key}-reviewer-note`}
                        value={sourceDraft.reviewer_note}
                        rows={3}
                        placeholder="Policy review context"
                        onChange={(event) =>
                          setSourceDraft({ ...sourceDraft, reviewer_note: event.target.value })
                        }
                      />
                    </div>
                    {sourcePolicyReviews[source.key]?.risks.length ? (
                      <div className="space-y-2 rounded-md border border-warning/40 p-2 text-sm">
                        <div className="flex items-center gap-2 font-medium">
                          <ShieldAlert className="h-4 w-4" aria-hidden />
                          Policy review
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {sourcePolicyReviews[source.key].risks.map((risk) => (
                            <Badge
                              key={risk.code}
                              variant={risk.severity === "blocker" ? "destructive" : "warning"}
                            >
                              {riskLabel(risk.code)}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        onClick={() => saveSourcePolicy(source, false)}
                        disabled={savingSourceKey === source.key}
                      >
                        {savingSourceKey === source.key ? (
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        ) : (
                          <ShieldAlert className="h-4 w-4" aria-hidden />
                        )}
                        Review policy
                      </Button>
                      {sourcePolicyReviews[source.key]?.requires_review && (
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => saveSourcePolicy(source, true)}
                          disabled={savingSourceKey === source.key}
                        >
                          <Save className="h-4 w-4" aria-hidden />
                          Apply reviewed policy
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setEditingSourceKey(null);
                          setSourceDraft(null);
                        }}
                      >
                        <X className="h-4 w-4" aria-hidden />
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {!sourceRows.length && <Empty text="No source registry rows yet." />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Validator runs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {validatorRows.slice(0, 8).map((run) => {
              const meta = run.meta ?? {};
              const rcContext = validatorRcContext(meta);
              const questionId = metaNumber(meta, "question_id");
              const parentId = metaNumber(meta, "parent_question_id");
              return (
                <div key={run.id} className="rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium">{run.q_type || "unknown"}</p>
                      <p className="text-xs text-muted-foreground">
                        {run.section_type ?? "unknown section"} · {validatorScore(run.score)}
                      </p>
                    </div>
                    <Badge variant={run.status === "failed" ? "destructive" : "outline"}>{run.status}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {(run.failure_reasons.length ? run.failure_reasons.join(", ") : "No rejection reasons recorded")}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {questionId != null && <Badge variant="outline">q#{questionId}</Badge>}
                    {parentId != null && <Badge variant="outline">parent #{parentId}</Badge>}
                    {typeof meta.verdict_reason === "string" && meta.verdict_reason && (
                      <Badge variant="warning">{meta.verdict_reason.replace(/_/g, " ")}</Badge>
                    )}
                  </div>
                  {rcContext && (
                    <div className="mt-2 rounded-md bg-surface-2 p-2 text-xs text-muted-foreground">
                      <p className="font-medium text-foreground">RC generation map</p>
                      <p>{rcMapSummary(rcContext)}</p>
                      {rcTags(rcContext) && <p>Tags: {rcTags(rcContext)}</p>}
                      {rcCoverage(rcContext) && <p>{rcCoverage(rcContext)}</p>}
                    </div>
                  )}
                </div>
              );
            })}
            {!validatorRows.length && <Empty text="No validator run evidence yet." />}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Version history</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2 rounded-md border bg-surface-2 p-3">
              <div className="flex flex-wrap gap-2" role="group" aria-label="Version entity filters">
                <VersionFilterButton
                  active={versionEntityFilter === "all"}
                  onClick={() => setVersionEntityFilter("all")}
                >
                  All entities
                </VersionFilterButton>
                <VersionFilterButton
                  active={versionEntityFilter === "question"}
                  onClick={() => setVersionEntityFilter("question")}
                >
                  Questions
                </VersionFilterButton>
                <VersionFilterButton
                  active={versionEntityFilter === "source_registry"}
                  onClick={() => setVersionEntityFilter("source_registry")}
                >
                  Sources
                </VersionFilterButton>
              </div>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Version reason filters">
                <VersionFilterButton
                  active={versionReasonFilter === "all"}
                  onClick={() => setVersionReasonFilter("all")}
                >
                  All reasons
                </VersionFilterButton>
                <VersionFilterButton
                  active={versionReasonFilter === "remediation"}
                  onClick={() => setVersionReasonFilter("remediation")}
                >
                  Remediation
                </VersionFilterButton>
                <VersionFilterButton
                  active={versionReasonFilter === "source_policy"}
                  onClick={() => setVersionReasonFilter("source_policy")}
                >
                  Source policy
                </VersionFilterButton>
              </div>
              <Input
                aria-label="Filter version history by source key"
                placeholder="Source key"
                value={versionSourceFilter}
                onChange={(event) => setVersionSourceFilter(event.target.value)}
              />
            </div>
            {versionRows.slice(0, 8).map((version) => {
              const remediation = remediationSummary(version);
              const policyDiff = sourcePolicyDiff(version);
              return (
                <div key={version.id} className="space-y-3 rounded-md border p-3 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">
                        {version.entity.replace(/_/g, " ")} #{version.entity_id} · v{version.version}
                      </p>
                      <p className="text-muted-foreground">{version.reason || "snapshot"}</p>
                    </div>
                    <Badge variant={version.entity === "source_registry" ? "warning" : "outline"}>
                      {new Date(version.created_at).toLocaleDateString()}
                    </Badge>
                  </div>
                  {remediation && <RemediationSummaryView summary={remediation} />}
                  {policyDiff && <SourcePolicyDiffView diff={policyDiff} />}
                  {policyDiff && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => restoreContentVersion(version, "previous", policyDiff)}
                        disabled={restoringVersionId === version.id || !policyDiff.hasPrevious}
                        aria-label={`Roll back source policy ${policyDiff.sourceKey} to previous version ${version.version}`}
                      >
                        {restoringVersionId === version.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        ) : (
                          <RotateCcw className="h-4 w-4" aria-hidden />
                        )}
                        Roll back
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => restoreContentVersion(version, "current", policyDiff)}
                        disabled={restoringVersionId === version.id}
                        aria-label={`Restore source policy ${policyDiff.sourceKey} version ${version.version}`}
                      >
                        {restoringVersionId === version.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        ) : (
                          <Save className="h-4 w-4" aria-hidden />
                        )}
                        Restore v{version.version}
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
            {!versionRows.length && <Empty text="No content snapshots yet." />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Benchmarks</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {benchmarkRows.slice(0, 8).map((run) => (
              <div key={run.id} className="rounded-md border p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium">{run.kind}</p>
                  <Badge variant="outline">{run.status}</Badge>
                </div>
                <p className="mt-1 text-muted-foreground">
                  {Object.entries(run.metrics).slice(0, 3).map(([k, v]) => `${k}: ${String(v)}`).join(" · ") || "No metrics"}
                </p>
              </div>
            ))}
            {!benchmarkRows.length && <Empty text="No benchmark runs recorded yet." />}
          </CardContent>
        </Card>
      </div>
    </PageLayout>
  );
}

type TrustVariant = "success" | "warning" | "destructive" | "outline";

function SignalCard({
  label,
  value,
  detail,
  icon: Icon,
  variant,
}: {
  label: string;
  value: string | number;
  detail: string;
  icon: LucideIcon;
  variant: TrustVariant;
}) {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-normal text-muted-foreground">
              {label}
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
          </div>
          <span className="rounded-card bg-surface-2 p-2 text-muted-foreground">
            <Icon className="h-4 w-4" aria-hidden />
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-xs text-muted-foreground">{detail}</p>
          <Badge variant={variant} className="shrink-0">
            {variant === "destructive" ? "blocker" : variant}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, status }: { label: string; value: string | number; status: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <DatabaseZap className="h-4 w-4" aria-hidden />
          <p className="text-xs uppercase tracking-normal">{label}</p>
        </div>
        <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground">{status}</p>
      </CardContent>
    </Card>
  );
}

function VersionFilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? "default" : "outline"}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

type RemediationSummary = {
  action: string;
  validatorRunId: number | null;
  clusterKey: string;
  duplicateKind: string;
  canonicalQuestionId: number | null;
  quarantinedQuestionIds: number[];
  keptAsCanonical: boolean;
  retiredAsDuplicate: boolean;
};

function RemediationSummaryView({ summary }: { summary: RemediationSummary }) {
  return (
    <div className="space-y-2 rounded-md bg-surface-2 p-2">
      <div className="flex flex-wrap gap-1.5">
        <Badge variant="warning">{summary.action.replace(/_/g, " ")}</Badge>
        {summary.validatorRunId != null && (
          <Badge variant="outline">validator #{summary.validatorRunId}</Badge>
        )}
        {summary.clusterKey && (
          <Badge variant="outline">cluster {summary.clusterKey}</Badge>
        )}
        {summary.duplicateKind && (
          <Badge variant="outline">{summary.duplicateKind.replace(/_/g, " ")}</Badge>
        )}
        {summary.canonicalQuestionId != null && (
          <Badge variant="outline">canonical #{summary.canonicalQuestionId}</Badge>
        )}
        {!!summary.quarantinedQuestionIds.length && (
          <Badge variant="destructive">
            quarantined {summary.quarantinedQuestionIds.map((id) => `#${id}`).join(", ")}
          </Badge>
        )}
        {summary.keptAsCanonical && <Badge variant="success">kept canonical</Badge>}
        {summary.retiredAsDuplicate && <Badge variant="destructive">retired duplicate</Badge>}
      </div>
    </div>
  );
}

type SourcePolicyDiff = {
  sourceKey: string;
  rows: {
    label: string;
    before: string;
    after: string;
  }[];
  risks: SourcePolicyReview["risks"];
  reviewerNote: string;
  restoreTarget: string;
  hasPrevious: boolean;
};

function SourcePolicyDiffView({ diff }: { diff: SourcePolicyDiff }) {
  return (
    <div className="space-y-2 rounded-md bg-surface-2 p-2">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">Source policy diff</p>
        <Badge variant="outline">{diff.sourceKey}</Badge>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {diff.rows.map((row) => (
          <div key={row.label} className="rounded-md border bg-background p-2">
            <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
              {row.label}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {row.before} to <span className="text-foreground">{row.after}</span>
            </p>
          </div>
        ))}
      </div>
      {!!diff.risks.length && (
        <div className="flex flex-wrap gap-1.5">
          {diff.risks.map((risk) => (
            <Badge
              key={risk.code}
              variant={risk.severity === "blocker" ? "destructive" : "warning"}
            >
              {riskLabel(risk.code)}
            </Badge>
          ))}
        </div>
      )}
      {(diff.reviewerNote || diff.restoreTarget) && (
        <p className="text-xs text-muted-foreground">
          {[diff.reviewerNote, diff.restoreTarget ? `restore ${diff.restoreTarget}` : ""]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
    </div>
  );
}

function PolicyBadge({ label, value }: { label: string; value: unknown }) {
  return (
    <Badge variant={policyVariant(value)}>
      {label}: {policyText(value)}
    </Badge>
  );
}

function PolicySwitch({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Label className="flex items-center gap-2 rounded-md border bg-background px-3 py-2">
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={`${label} policy`}
      />
      <span>{label}</span>
    </Label>
  );
}

function makeSourcePolicyDraft(source: ContentSourceRow): SourcePolicyDraft {
  return {
    label: source.label || source.key,
    source_type: source.source_type || "unknown",
    license: source.license ?? "",
    cloud: policyEnabled(source.firewall?.cloud),
    training: policyEnabled(source.firewall?.training),
    exportable: policyEnabled(source.eligibility?.export ?? source.firewall?.export),
    reviewer_note: source.policy_review?.reviewer_note ?? "",
  };
}

function policyEnabled(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return ["true", "allow", "allowed", "yes", "y"].includes(
      value.trim().toLowerCase(),
    );
  }
  return false;
}

function policyReviewFromError(error: unknown): SourcePolicyReview | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const detail = error.detail as { review?: SourcePolicyReview } | undefined;
  const review = detail?.review;
  if (!review || !Array.isArray(review.risks)) return null;
  return review;
}

function remediationSummary(version: ContentVersionRecord): RemediationSummary | null {
  const snapshot = version.snapshot;
  const action = stringValue(snapshot.remediation_action);
  if (!action && !version.reason.includes("remediation")) return null;
  return {
    action: action || version.reason || "remediation",
    validatorRunId: numberValue(snapshot.validator_run_id),
    clusterKey: stringValue(snapshot.duplicate_cluster_key),
    duplicateKind: stringValue(snapshot.duplicate_kind),
    canonicalQuestionId: numberValue(snapshot.canonical_question_id),
    quarantinedQuestionIds: numberArray(snapshot.quarantined_question_ids),
    keptAsCanonical: snapshot.kept_as_canonical === true,
    retiredAsDuplicate: snapshot.retired_as_duplicate === true,
  };
}

function sourcePolicyDiff(version: ContentVersionRecord): SourcePolicyDiff | null {
  if (version.entity !== "source_registry") return null;
  const previous = recordValue(version.snapshot.previous);
  const current = recordValue(version.snapshot.current);
  if (!current) return null;
  const review = recordValue(version.snapshot.policy_review);
  const sourceKey =
    stringValue(current.key) ||
    stringValue(previous?.key) ||
    stringValue(review?.source_key) ||
    `source #${version.entity_id}`;
  const rows = [
    sourceDiffRow("Label", sourceString(previous, "label"), sourceString(current, "label")),
    sourceDiffRow("Type", sourceString(previous, "source_type"), sourceString(current, "source_type")),
    sourceDiffRow("License", sourceString(previous, "license"), sourceString(current, "license")),
    sourceDiffRow("Cloud", sourcePolicyText(previous, "cloud"), sourcePolicyText(current, "cloud")),
    sourceDiffRow("Training", sourcePolicyText(previous, "training"), sourcePolicyText(current, "training")),
    sourceDiffRow("Export", sourcePolicyText(previous, "export"), sourcePolicyText(current, "export")),
  ].filter((row) => !previous || row.before !== row.after);
  const risks = Array.isArray(review?.risks)
    ? review.risks.filter(isSourcePolicyRisk)
    : [];
  const restore = recordValue(version.snapshot.restore);
  return {
    sourceKey,
    rows,
    risks,
    reviewerNote: stringValue(version.snapshot.reviewer_note),
    restoreTarget: stringValue(restore?.target),
    hasPrevious: Boolean(previous),
  };
}

function sourceDiffRow(label: string, before: string, after: string) {
  return { label, before, after };
}

function sourceString(
  source: Record<string, unknown> | null,
  key: string,
): string {
  if (!source) return "new source";
  return stringValue(source[key]) || "unknown";
}

function sourcePolicyText(
  source: Record<string, unknown> | null,
  key: "cloud" | "training" | "export",
): string {
  if (!source) return "new source";
  const eligibility = recordValue(source.eligibility);
  const firewall = recordValue(source.firewall);
  const value = key === "export"
    ? eligibility?.export ?? firewall?.export
    : firewall?.[key];
  return policyText(value);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number")
    : [];
}

function isSourcePolicyRisk(value: unknown): value is SourcePolicyReview["risks"][number] {
  const risk = recordValue(value);
  return Boolean(
    risk &&
      typeof risk.code === "string" &&
      typeof risk.severity === "string" &&
      typeof risk.detail === "string",
  );
}

function riskLabel(code: string): string {
  return code.replace(/_/g, " ");
}

function policyVariant(value: unknown): TrustVariant {
  if (value === true || value === "true" || value === "allowed") return "success";
  if (value === false || value === "false" || value === "blocked") return "warning";
  return "outline";
}

function statusVariant(status: unknown): TrustVariant {
  if (status === "ok" || status === "pass" || status === "passed") return "success";
  if (status === "blocked" || status === "failed" || status === "block") return "destructive";
  if (status === "warning" || status === "warn") return "warning";
  return "outline";
}

function releaseContractVariant(
  manifestStatus: unknown,
  releaseLocalStatus: unknown,
): TrustVariant {
  const local = statusVariant(releaseLocalStatus);
  if (local !== "outline") return local;
  return statusVariant(manifestStatus);
}

function policyText(value: unknown): string {
  if (value === true) return "allowed";
  if (value === false) return "blocked";
  if (typeof value === "string" && value.trim()) return value;
  return "unknown";
}

function versionBreakdown(byEntity: Record<string, number>): string {
  const entries = Object.entries(byEntity).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return "No snapshot history yet";
  return entries.slice(0, 2).map(([entity, count]) => `${entity}: ${count}`).join(" · ");
}

function formatMix(values: Record<string, number>): string {
  const entries = Object.entries(values).sort((a, b) => b[1] - a[1]);
  return entries.slice(0, 3).map(([key, count]) => `${key} ${count}`).join(", ") || "none";
}

function validatorRcContext(meta: ValidatorRunMeta): ValidatorRunContext | null {
  const context = meta.rc_generation_context;
  return context && typeof context === "object" ? context : null;
}

function metaNumber(meta: ValidatorRunMeta, key: keyof ValidatorRunMeta): number | null {
  const value = meta[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function validatorScore(score: ValidatorRunRecord["score"]): string {
  if (score == null) return "score pending";
  return `score ${Math.round(score * 100)}%`;
}

function rcMapSummary(context: ValidatorRunContext): string {
  const parts = [
    context.passage_type || "single",
    context.paragraph_count ? `${context.paragraph_count} paragraphs` : null,
    context.target_scope ? `scope ${context.target_scope.replace(/_/g, " ")}` : null,
  ].filter(Boolean);
  return parts.join(" · ") || "RC map context recorded";
}

function rcTags(context: ValidatorRunContext): string {
  return (context.target_tags ?? []).map((tag) => tag.replace(/_/g, " ")).join(", ");
}

function rcCoverage(context: ValidatorRunContext): string {
  const coverage = context.tag_coverage;
  if (!coverage || coverage.total_questions == null) return "";
  return `${coverage.tagged_questions ?? 0}/${coverage.total_questions} tagged`;
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{text}</p>;
}

function TrustNotice({ tone, text }: { tone: "warning" | "error"; text: string }) {
  return (
    <div
      role="status"
      className={
        tone === "error"
          ? "rounded-md border border-destructive/35 bg-destructive/10 p-3 text-sm text-destructive"
          : "rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-foreground"
      }
    >
      {text}
    </div>
  );
}
