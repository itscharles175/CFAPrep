import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  CloudCog,
  Loader2,
  RotateCcw,
  ShieldAlert,
  Tags,
  TrendingDown,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@lsat/components/ui/card";
import { Button } from "@lsat/components/ui/button";
import { Badge } from "@lsat/components/ui/badge";
import { Icon } from "@lsat/components/ui/icon";
import { Skeleton } from "@lsat/components/states";
import { Meter } from "@lsat/components/bank/meter";
import {
  useAiDrift,
  useBankAudit,
  useBankTagReview,
  useDuplicates,
  useGenJobs,
  useGenQuality,
} from "@lsat/lib/hooks";
import { useEmbedBank, useRequarantine } from "@lsat/lib/mutations";
import { qTypeLabel } from "@lsat/lib/labels";
import { pct } from "@lsat/lib/utils";

const JOB_VARIANT: Record<string, "secondary" | "outline" | "destructive" | "default"> = {
  done: "secondary",
  running: "default",
  queued: "outline",
  planned: "outline",
  failed: "destructive",
};

/** F3/F5/F6 — bank quality cockpit: audit counts, embed coverage + control,
 * near-duplicate clusters, and the generation job queue. */
export function BankAuditPanel() {
  const navigate = useNavigate();
  const audit = useBankAudit();
  const dupes = useDuplicates();
  const jobs = useGenJobs();
  const embed = useEmbedBank();
  const tagReview = useBankTagReview(100);
  const quality = useGenQuality();
  const drift = useAiDrift();
  const requarantine = useRequarantine();
  const reviewCount = tagReview.data?.data.length ?? 0;

  const a = audit.data?.data;
  const coverage = a && a.total ? Math.round((a.embedded / a.total) * 100) : 0;
  const missing = a ? Math.max(0, a.total - a.embedded) : 0;
  const clusters = dupes.data?.data ?? [];
  const jobList = jobs.data?.data ?? [];

  const gq = quality.data?.data;
  const failReasons = gq
    ? Object.entries(gq.fail_reasons).sort((x, y) => y[1] - x[1])
    : [];
  const maxFail = Math.max(1, ...failReasons.map(([, n]) => n));
  const flagged = drift.data?.data.flagged ?? [];

  const metrics: { label: string; value: number; warn?: boolean }[] = a
    ? [
        { label: "Missing q_type", value: a.missing_q_type, warn: a.missing_q_type > 0 },
        { label: "Generic placeholder", value: a.generic_placeholder, warn: a.generic_placeholder > 0 },
        { label: "Answer-length tells", value: a.length_tell, warn: a.length_tell > 0 },
        { label: "Missing trap tags", value: a.missing_trap_tags, warn: a.missing_trap_tags > 0 },
      ]
    : [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Quality audit</CardTitle>
          <Badge
            variant={coverage >= 100 ? "success" : "outline"}
            className="tabular-nums"
          >
            {coverage}% embedded
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {audit.isLoading
              ? Array.from({ length: 4 }).map((_, i) => (
                  <div
                    key={i}
                    className="space-y-2 rounded-md border bg-surface-1 p-3"
                  >
                    <Skeleton className="h-7 w-10" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                ))
              : metrics.map((m) => (
                  <div
                    key={m.label}
                    className={`rounded-md border bg-surface-1 p-3 ${
                      m.warn ? "border-warning/40" : ""
                    }`}
                  >
                    <p className="flex items-center gap-1.5 text-2xl font-semibold tabular-nums">
                      {m.warn && (
                        <Icon
                          as={AlertTriangle}
                          size="sm"
                          className="text-warning"
                          aria-label="Needs attention"
                        />
                      )}
                      <span className={m.warn ? "text-warning" : ""}>
                        {m.value}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">{m.label}</p>
                  </div>
                ))}
          </div>
          <Meter
            value={coverage}
            tone={coverage >= 100 ? "success" : "info"}
            label="Embedding coverage"
            valueText={`${a?.embedded ?? 0} / ${a?.total ?? 0}`}
          />
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              disabled={missing === 0 || embed.isPending}
              onClick={() => embed.mutate(Math.min(missing, 1000))}
            >
              {embed.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldAlert className="h-4 w-4" />
              )}
              {missing > 0 ? `Embed ${missing} missing` : "All embedded"}
            </Button>
            <span className="text-xs text-muted-foreground">
              Embeddings power semantic “similar misses” + near-duplicate detection.
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Tag review queue</CardTitle>
          <Badge variant={reviewCount > 0 ? "secondary" : "outline"} className="tabular-nums">
            {reviewCount} to review
          </Badge>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <Button
            size="sm"
            variant={reviewCount > 0 ? "default" : "outline"}
            onClick={() => navigate("/bank/tag-review")}
          >
            <Tags className="h-4 w-4" />
            {reviewCount > 0 ? `Review ${reviewCount} items` : "Open tag review"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Confirm or correct auto-assigned types/difficulty for low-confidence items.
          </span>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Near-duplicate clusters
            <Badge variant="outline" className="ml-2 tabular-nums">{clusters.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {clusters.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {coverage === 0
                ? "Embed the bank first to detect near-duplicates."
                : "No near-duplicate clusters found."}
            </p>
          ) : (
            clusters.slice(0, 10).map((c) => (
              <div
                key={c.question_ids.join("-")}
                className="rounded-md border bg-surface-1 px-3 py-2 text-sm"
              >
                <Badge variant="secondary" className="mr-2 tabular-nums">{c.size}×</Badge>
                <span className="text-muted-foreground">{c.sample_stem}</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Q2 — generation quality: pass rate, why candidates fail, and which
          types the gate recommends sending to cloud Tier-B. */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Generation quality</CardTitle>
          {gq && gq.total_candidates > 0 && (
            <Badge variant="outline" className="tabular-nums">
              {pct(gq.pass_rate)} pass
            </Badge>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {!gq || gq.total_candidates === 0 ? (
            <p className="text-sm text-muted-foreground">
              No generation candidates evaluated yet. Run a generation job to see
              the gate&apos;s pass rate and failure breakdown.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-md border bg-surface-1 p-3">
                  <p className="stat text-2xl font-semibold tabular-nums">{gq.passed}</p>
                  <p className="text-xs text-muted-foreground">Passed</p>
                </div>
                <div
                  className={`rounded-md border bg-surface-1 p-3 ${
                    gq.quarantined > 0 ? "border-warning/40" : ""
                  }`}
                >
                  <p className="flex items-center gap-1.5 text-2xl font-semibold tabular-nums">
                    {gq.quarantined > 0 && (
                      <Icon
                        as={AlertTriangle}
                        size="sm"
                        className="text-warning"
                        aria-label="Quarantined"
                      />
                    )}
                    <span className={gq.quarantined > 0 ? "text-warning" : ""}>
                      {gq.quarantined}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">Quarantined</p>
                </div>
                <div className="rounded-md border bg-surface-1 p-3">
                  <p className="stat text-2xl font-semibold tabular-nums">{gq.jobs}</p>
                  <p className="text-xs text-muted-foreground">Jobs</p>
                </div>
              </div>

              {failReasons.length > 0 && (
                <div className="space-y-2">
                  <p className="type-overline text-muted-foreground">
                    Why candidates fail
                  </p>
                  {failReasons.map(([reason, n]) => (
                    <Meter
                      key={reason}
                      value={n}
                      max={maxFail}
                      tone="warning"
                      size="sm"
                      label={reason.replace(/_/g, " ")}
                      valueText={n}
                    />
                  ))}
                </div>
              )}

              {gq.cloud_recommended_types.length > 0 && (
                <div className="space-y-1.5">
                  <p className="type-overline flex items-center gap-1.5 text-muted-foreground">
                    <CloudCog className="h-3.5 w-3.5" /> Recommended for cloud Tier-B
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {gq.cloud_recommended_types.map((t) => (
                      <Badge key={t} variant="secondary">
                        {qTypeLabel(t)}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    These types fail the local gate often — consider opt-in cloud
                    generation in Settings.
                  </p>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Q5 — approved-AI drift: items whose live accuracy fell below the floor,
          with a one-click return to quarantine. */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingDown className="h-4 w-4 text-warning" />
            Drifting AI items
          </CardTitle>
          <Badge variant={flagged.length > 0 ? "destructive" : "outline"} className="tabular-nums">
            {flagged.length} flagged
          </Badge>
        </CardHeader>
        <CardContent className="space-y-2">
          {flagged.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No approved AI items are drifting below the accuracy floor
              {drift.data?.data.floor
                ? ` (${pct(drift.data.data.floor)})`
                : ""}
              .
            </p>
          ) : (
            flagged.map((f) => (
              <div
                key={f.question_id}
                className="flex items-center justify-between gap-2 rounded-md border bg-surface-1 px-3 py-2 text-sm"
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="font-medium text-primary underline-offset-2 hover:underline"
                    onClick={() => navigate(`/explanation/${f.question_id}`)}
                  >
                    #{f.question_id}
                  </button>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {pct(f.accuracy)} over {f.attempts} attempt{f.attempts === 1 ? "" : "s"}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={requarantine.isPending}
                  onClick={() => requarantine.mutate(f.question_id)}
                >
                  <RotateCcw className="h-4 w-4" /> Re-quarantine
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Generation jobs</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {jobList.length === 0 ? (
            <p className="text-sm text-muted-foreground">No generation jobs yet.</p>
          ) : (
            jobList.slice(0, 12).map((j) => (
              <div
                key={j.id}
                className="flex items-center justify-between gap-2 rounded-md border bg-surface-1 px-3 py-2 text-sm"
              >
                <div className="flex items-center gap-2">
                  <Badge variant={JOB_VARIANT[j.status] ?? "outline"}>{j.status}</Badge>
                  <span>{qTypeLabel(j.q_type)}</span>
                </div>
                <div className="flex items-center gap-2 text-xs tabular-nums">
                  <span
                    className="inline-flex items-center gap-1 text-success"
                    title={`${j.accepted} accepted`}
                  >
                    <Icon as={CheckCircle2} size="xs" aria-label="accepted" />
                    {j.accepted}
                  </span>
                  <span
                    className="inline-flex items-center gap-1 text-warning"
                    title={`${j.quarantined} quarantined`}
                  >
                    <Icon as={AlertTriangle} size="xs" aria-label="quarantined" />
                    {j.quarantined}
                  </span>
                  <span className="text-muted-foreground" title="produced / requested">
                    {j.produced}/{j.count}
                  </span>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
