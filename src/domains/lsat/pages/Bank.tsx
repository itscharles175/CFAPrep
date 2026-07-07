import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  CheckCircle2,
  Database,
  Download,
  HardDriveDownload,
  HardDriveUpload,
  Sparkles,
  Wand2,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/Primitives";
import { Checkbox } from "@lsat/components/ui/checkbox";
import { Icon } from "@lsat/components/ui/icon";
import { PageSection } from "@lsat/components/page-layout";
import { SystemNotice } from "@lsat/components/system-notice";
import { QuestionBrowser } from "@lsat/components/bank/question-browser";
import { AnnotationInlineEditor } from "@lsat/components/review/annotation-inline-editor";
import { BankAuditPanel } from "@lsat/components/bank/audit-panel";
import { Meter } from "@lsat/components/bank/meter";
import {
  ProvenanceBadge,
  ProvenanceLegend,
  sourceLabel,
} from "@lsat/components/bank/provenance-badge";
import { Skeleton } from "@lsat/components/states";
import { parseJsonFile } from "@/lib/jsonFilePreflight";
import { api } from "@lsat/lib/api";
import { useBankSources, useBankStats } from "@lsat/lib/hooks";
import { toast } from "@lsat/lib/toast";
import { countLabel } from "@lsat/lib/utils";

const BANK_BACKUP_IMPORT_MAX_BYTES = 100 * 1024 * 1024;

export default function Bank() {
  const qc = useQueryClient();
  const bankStats = useBankStats();
  const bankSources = useBankSources();
  const stats = bankStats.data?.data ?? null;
  const sources = useMemo(
    () => bankSources.data?.data ?? [],
    [bankSources.data],
  );
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [targetTotal, setTargetTotal] = useState(12000);
  const [perTypeCap, setPerTypeCap] = useState(50);
  // Wave 1.2 — ReClor's license requires an explicit non-commercial
  // acknowledgement before the backend will touch the user-supplied zip.
  const [ncAcknowledged, setNcAcknowledged] = useState(false);
  const [localPaths, setLocalPaths] = useState<Record<string, string>>({});
  // Wave 1.6 — optional "treat this import as training corpus" flag.
  const [trainingEligible, setTrainingEligible] = useState(false);
  const [trainingNotes, setTrainingNotes] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (sources.length === 0) return;
    setSelected((prev) =>
      Object.fromEntries(sources.map((x) => [x.key, prev[x.key] ?? true])),
    );
  }, [sources]);

  async function refresh() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["bank-stats"] }),
      qc.invalidateQueries({ queryKey: ["bank-sources"] }),
    ]);
  }

  async function runImport() {
    const keys = Object.entries(selected)
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (keys.length === 0) {
      toast.error("Select at least one dataset.");
      return;
    }
    // Wave 1.2 — block the request client-side too so the user sees a clear
    // error instead of a per-row "requires nc_acknowledged" backend response.
    const needsNc = keys.some(
      (k) => sources.find((s) => s.key === k)?.requires_nc_acknowledgement,
    );
    if (needsNc && !ncAcknowledged) {
      toast.error(
        "ReClor is non-commercial only — tick the acknowledgement first.",
      );
      return;
    }
    const needsLocal = keys.filter(
      (k) => sources.find((s) => s.key === k)?.requires_local_path,
    );
    for (const k of needsLocal) {
      if (!localPaths[k]) {
        toast.error(`'${k}' needs a local file path on this machine.`);
        return;
      }
    }
    setBusy("import");
    try {
      const res = await api.bankImport(keys, undefined, {
        nc_acknowledged: ncAcknowledged,
        local_paths: Object.keys(localPaths).length ? localPaths : undefined,
        training_eligible: trainingEligible || undefined,
        training_notes: trainingNotes.trim() || undefined,
        force_commit: true,
      });
      const errored = res.results.filter((r) => r.error);
      const totalInserted = res.results.reduce(
        (acc, r) => acc + (r.inserted ?? 0),
        0,
      );
      if (errored.length) {
        toast.error(
          `Imported ${totalInserted} new; ${errored.length} dataset(s) failed.`,
        );
      } else {
        toast.success(`Imported ${totalInserted} new questions.`);
      }
      await refresh();
    } catch {
      toast.error("Import failed — backend offline.");
    } finally {
      setBusy(null);
    }
  }

  async function runTag() {
    setBusy("tag");
    try {
      const res = await api.bankTag(500, true);
      toast.success(
        `Tagged ${res.updated} (heuristic ${res.via_heuristic} · model ${res.via_model}).`,
      );
      await refresh();
    } catch {
      toast.error("Tag pass failed — backend offline.");
    } finally {
      setBusy(null);
    }
  }

  async function runBootstrap(planOnly: boolean) {
    setBusy("bootstrap");
    try {
      const res = await api.bankBootstrap({
        target_total: targetTotal,
        per_type_cap: perTypeCap,
        run_generation: !planOnly,
        no_import: false,
      });
      toast.success(
        planOnly
          ? `Planned ${res.job_ids.length} generation jobs.`
          : `Dispatched ${res.job_ids.length} generation jobs.`,
      );
      await refresh();
    } catch {
      toast.error("Bootstrap failed — backend offline.");
    } finally {
      setBusy(null);
    }
  }

  async function exportBank() {
    setBusy("export");
    try {
      const payload = await api.bankExport(true);
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `lsatlab-bank-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Bank exported.");
    } catch {
      toast.error("Export failed — backend offline.");
    } finally {
      setBusy(null);
    }
  }

  async function importBackupFile(file: File) {
    setBusy("import-backup");
    try {
      const { payload } = await parseJsonFile(file, { maxBytes: BANK_BACKUP_IMPORT_MAX_BYTES });
      const res = await api.bankImportBackup(payload as Record<string, unknown>, true);
      toast.success(
        `Restored ${res.questions} new + ${countLabel(res.questions_existing, "existing question")} across ${countLabel(res.preptests, "PrepTest")}.`,
      );
      await refresh();
    } catch {
      toast.error("Backup import failed — check the file format.");
    } finally {
      setBusy(null);
    }
  }

  const total = stats?.total ?? 0;
  const research = stats?.by_source?.research ?? 0;
  const aiGen = stats?.by_source?.ai_generated ?? 0;
  const official = stats?.by_source?.official ?? 0;
  const sample = stats?.by_source?.sample ?? 0;
  const reclor = stats?.by_source?.reclor ?? 0;
  const progressPct = Math.min(100, Math.round((total / targetTotal) * 100));

  return (
    <div className="page-container">
      <PageHeader
        title="Question bank"
        subtitle="Import research datasets, auto-tag, and grow toward your target size."
      />
    <Tabs defaultValue="browse">
      <TabsList>
        <TabsTrigger value="browse">Browse</TabsTrigger>
        <TabsTrigger value="quality">Quality</TabsTrigger>
        <TabsTrigger value="ops">Operations</TabsTrigger>
      </TabsList>
      <TabsContent value="browse" className="mt-4 space-y-6">
        <QuestionBrowser typeCounts={stats?.by_q_type ?? {}} />
        <BankAnnotationAuthoring />
      </TabsContent>
      <TabsContent value="quality" className="mt-4">
        <BankAuditPanel />
      </TabsContent>
      <TabsContent value="ops" className="mt-4 space-y-8">

      {/* Headline counts */}
      <PageSection eyebrow="OVERVIEW" title="Bank summary">
        <Card>
          <CardContent className="space-y-4 pt-[var(--card-pad)]">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
              {bankStats.isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={i}
                    className="space-y-2 rounded-md border bg-surface-1 p-3"
                  >
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="h-7 w-12" />
                  </div>
                ))
              ) : (
                <>
                  <Stat label="Total" value={total} accent />
                  <Stat label="Official" value={official} />
                  <Stat label="Research" value={research} />
                  <Stat label="ReClor (NC)" value={reclor} />
                  <Stat label="AI generated" value={aiGen} />
                  <Stat label="Sample" value={sample} />
                </>
              )}
            </div>

            <Meter
              value={progressPct}
              label={`Toward ${targetTotal.toLocaleString()}`}
              valueText={`${progressPct}%`}
            />
          </CardContent>
        </Card>
      </PageSection>

      {/* Research dataset import */}
      <PageSection
        eyebrow="GROW THE BANK"
        title="Import research datasets"
      >
      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <Icon as={Database} size="sm" className="text-primary" />
          <CardTitle className="text-base">Hugging Face sources</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Pulled live from Hugging Face. Re-running is safe — rows already in
            the bank are skipped by external id or content hash. Sources marked
            non-commercial (ReClor) require a local file you supply yourself.
          </p>
          <div className="space-y-2">
            {sources.map((src) => {
              const needsLocal = !!src.requires_local_path;
              const provenance = src.question_source ?? src.key;
              const ckId = `bank-src-${src.key}`;
              return (
                <div
                  key={src.key}
                  className="space-y-2 rounded-md border bg-surface-1 p-3 text-sm"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Checkbox
                        id={ckId}
                        aria-label={`Include ${sourceLabel(provenance)} source`}
                        checked={!!selected[src.key]}
                        onCheckedChange={(v) =>
                          setSelected((s) => ({
                            ...s,
                            [src.key]: v === true,
                          }))
                        }
                      />
                      <Label htmlFor={ckId} className="cursor-pointer truncate font-medium">
                        {sourceLabel(provenance)}
                      </Label>
                      <Badge variant="outline">{src.section_type}</Badge>
                      <ProvenanceBadge source={provenance} size="xs" />
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {needsLocal
                        ? "local file required"
                        : `${src.hf_dataset} · split ${src.hf_split}`}
                    </span>
                  </div>
                  {needsLocal && selected[src.key] && (
                    <div className="ml-6 space-y-1">
                      <Label className="text-xs" htmlFor={`${ckId}-path`}>
                        Local path
                      </Label>
                      <Input
                        id={`${ckId}-path`}
                        type="text"
                        placeholder="C:\\path\\to\\reclor.zip"
                        value={localPaths[src.key] ?? ""}
                        onChange={(e) =>
                          setLocalPaths((p) => ({
                            ...p,
                            [src.key]: e.target.value,
                          }))
                        }
                      />
                      {src.license && (
                        <p className="text-[11px] text-muted-foreground">
                          License: {src.license}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Wave 1.2 — explicit non-commercial acknowledgement gate. */}
          {sources.some((s) => s.requires_nc_acknowledgement) && (
            <SystemNotice tone="warning">
              <div className="flex items-start gap-2.5">
                <Checkbox
                  id="bank-nc-ack"
                  aria-label="Acknowledge ReClor non-commercial use"
                  checked={ncAcknowledged}
                  onCheckedChange={(v) => setNcAcknowledged(v === true)}
                  className="mt-0.5"
                />
                <Label
                  htmlFor="bank-nc-ack"
                  className="cursor-pointer text-xs font-normal leading-relaxed text-muted-foreground"
                >
                  I confirm I will use ReClor only for non-commercial personal
                  study. I have downloaded the ReClor zip myself from the upstream
                  dataset page; the path above stays on this machine.
                </Label>
              </div>
            </SystemNotice>
          )}

          {/* Wave 1.6 — opt-in training-corpus tagging for the whole import. */}
          <div className="space-y-2 rounded-md border bg-surface-1 p-3">
            <div className="flex items-start gap-2.5 text-xs text-muted-foreground">
              <Checkbox
                id="bank-training-eligible"
                aria-label="Mark this import as training-corpus data"
                checked={trainingEligible}
                onCheckedChange={(v) => setTrainingEligible(v === true)}
                className="mt-0.5"
              />
              <Label
                htmlFor="bank-training-eligible"
                className="cursor-pointer text-xs font-normal leading-relaxed text-muted-foreground"
              >
                Mark this import as training-corpus data. Flagged items get
                preferred few-shot anchor weight in generation, and feed the
                local QLoRA training set later. Off by default — only enable
                for curated material you personally vouch for.
              </Label>
            </div>
            {trainingEligible && (
              <div className="ml-6 space-y-1">
                <Label className="text-xs" htmlFor="bank-training-notes">
                  Source description (optional)
                </Label>
                <Input
                  id="bank-training-notes"
                  type="text"
                  placeholder="e.g. PT 89, June 2024, official"
                  value={trainingNotes}
                  onChange={(e) => setTrainingNotes(e.target.value)}
                />
              </div>
            )}
          </div>

          <Button
            onClick={runImport}
            disabled={busy !== null}
            loading={busy === "import"}
            className="gap-2"
          >
            {busy !== "import" && <Icon as={Download} size="sm" />}
            Import selected
          </Button>
        </CardContent>
      </Card>
      </PageSection>

      {/* Auto-tag */}
      <PageSection eyebrow="GROW THE BANK" title="Auto-tag research items">
      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <Icon as={Wand2} size="sm" className="text-primary" />
          <CardTitle className="text-base">Type &amp; difficulty pass</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Assigns q_type and difficulty. Tries cheap prompt heuristics first,
            then falls back to the Tier-A model for the rest.
          </p>
          <Button
            variant="secondary"
            onClick={runTag}
            disabled={busy !== null}
            loading={busy === "tag"}
            className="gap-2"
          >
            {busy !== "tag" && <Icon as={Sparkles} size="sm" />}
            Tag up to 500
          </Button>
        </CardContent>
      </Card>
      </PageSection>

      {/* Bootstrap orchestrator */}
      <PageSection eyebrow="GROW THE BANK" title="Bootstrap to target">
      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <Icon as={CheckCircle2} size="sm" className="text-primary" />
          <CardTitle className="text-base">Generation plan</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Target total</Label>
              <Input
                type="number"
                min={100}
                value={targetTotal}
                onChange={(e) => setTargetTotal(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Per-type cap</Label>
              <Input
                type="number"
                min={1}
                value={perTypeCap}
                onChange={(e) => setPerTypeCap(Number(e.target.value))}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Plan-only previews the queue without burning GPU time. Run dispatches
            jobs in the background; review pending items in{" "}
            <Link to="/quarantine" className="text-primary underline">
              Quarantine
            </Link>
            .
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => runBootstrap(true)}
              disabled={busy !== null}
            >
              Plan only
            </Button>
            <Button onClick={() => runBootstrap(false)} disabled={busy !== null}>
              Run bootstrap
            </Button>
          </div>
        </CardContent>
      </Card>
      </PageSection>

      {/* Source breakdown */}
      {stats && Object.keys(stats.by_source).length > 0 && (
        <PageSection eyebrow="MAINTENANCE" title="By source">
        <Card>
          <CardContent className="space-y-3 pt-[var(--card-pad)] text-sm">
            <div className="space-y-1.5">
              {Object.entries(stats.by_source)
                .sort((a, b) => b[1] - a[1])
                .map(([src, n]) => (
                  <div
                    key={src}
                    className="flex items-center justify-between gap-3 rounded-md border bg-surface-1 px-3 py-1.5"
                  >
                    <ProvenanceBadge source={src} size="xs" />
                    <span className="font-mono tabular-nums">
                      {n.toLocaleString()}
                    </span>
                  </div>
                ))}
            </div>
            <ProvenanceLegend />
          </CardContent>
        </Card>
        </PageSection>
      )}

      {/* Backup / restore */}
      <PageSection eyebrow="MAINTENANCE" title="Backup & restore">
      <Card>
        <CardContent className="space-y-2 pt-[var(--card-pad)]">
          <p className="text-xs text-muted-foreground">
            Exports the entire bank (questions, choices, explanations, attempts,
            SRS cards) as a single JSON file. Re-importing is idempotent on
            external id / content hash so re-running is safe.
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={exportBank}
              disabled={busy !== null}
              className="gap-2"
            >
              <Icon as={HardDriveDownload} size="sm" />
              {busy === "export" ? "Exporting…" : "Export bank"}
            </Button>
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy !== null}
              className="gap-2"
            >
              <Icon as={HardDriveUpload} size="sm" />
              {busy === "import-backup" ? "Restoring…" : "Restore from backup"}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importBackupFile(file);
                e.target.value = "";
              }}
            />
          </div>
        </CardContent>
      </Card>
      </PageSection>
      </TabsContent>
    </Tabs>
    </div>
  );
}

/**
 * LSAT-6 — author a user explanation + tags for any question by id, straight
 * from the bank browser. Additive + self-contained: it neither reads nor mutates
 * the QuestionBrowser state, and the inline editor is local-first (it persists to
 * localStorage and best-effort syncs to the backend KB).
 */
function BankAnnotationAuthoring() {
  const [idDraft, setIdDraft] = useState("");
  const [questionId, setQuestionId] = useState<number | null>(null);

  return (
    <PageSection
      eyebrow="NOTEBOOK"
      title="Author a note"
    >
      <Card>
        <CardContent className="space-y-3 pt-[var(--card-pad)]">
          <p className="text-xs text-muted-foreground">
            Write your own explanation + tags for a question. Notes are searchable
            in Review &gt; Annotations and surface beside the AI explanation.
          </p>
          <div className="flex items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="bank-annot-qid">Question id</Label>
              <Input
                id="bank-annot-qid"
                type="number"
                min={1}
                value={idDraft}
                onChange={(e) => setIdDraft(e.target.value)}
                className="w-32"
                placeholder="e.g. 42"
              />
            </div>
            <Button
              variant="outline"
              onClick={() => {
                const n = Number(idDraft);
                setQuestionId(Number.isFinite(n) && n > 0 ? n : null);
              }}
              disabled={!idDraft.trim()}
            >
              Open editor
            </Button>
          </div>
          {questionId != null && (
            <AnnotationInlineEditor key={questionId} questionId={questionId} />
          )}
        </CardContent>
      </Card>
    </PageSection>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <div className="rounded-md border bg-surface-1 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={
          accent
            ? "text-2xl font-bold text-primary tabular-nums"
            : "text-xl font-semibold tabular-nums"
        }
      >
        {value.toLocaleString()}
      </div>
    </div>
  );
}
