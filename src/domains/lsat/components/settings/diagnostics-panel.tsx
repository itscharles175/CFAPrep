import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Bug,
  CircleCheck,
  CircleX,
  DatabaseBackup,
  FolderOpen,
  HardDrive,
  Play,
  RefreshCw,
  Server,
  ShieldCheck,
  ShieldAlert,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/states";
import {
  useBackupIntegrity,
  useBackups,
  useContentHealth,
  useObservability,
  useReleaseTrust,
  useRuntimeEvidence,
  useScheduledTasks,
} from "@/lib/hooks";
import { useCreateBackup, useRestoreBackup } from "@/lib/mutations";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import {
  exportBackendLogs,
  getAppLogDir,
  getBackendStatus,
  openPath,
  restartBackend,
  type BackendStatus,
} from "@/lib/tauri";
import { timeAgo } from "@/lib/utils";

// G6 — crash record shape written by ErrorBoundary.componentDidCatch.
interface LastCrash {
  message: string;
  stack: string;
  componentStack?: string;
  route: string;
  ts: number;
}

const CRASH_KEY = "lsatlab.lastCrash";

function readLastCrash(): LastCrash | null {
  try {
    const raw = localStorage.getItem(CRASH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).message !== "string"
    ) {
      return null;
    }
    return parsed as LastCrash;
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function trustVariant(status: string | undefined): "success" | "warning" | "destructive" | "outline" {
  if (status === "ok") return "success";
  if (status === "block" || status === "blocked" || status === "failed") return "destructive";
  if (status === "warn" || status === "warning") return "warning";
  return "outline";
}

function trustStatus(status: string | undefined): string {
  if (!status) return "pending";
  return status === "block" ? "blocked" : status;
}

interface ReleaseFreshnessContract {
  ready: boolean;
  reasons: string[];
  report_head?: string | null;
  live_head?: string | null;
  branch?: string | null;
  blocking_status_lines: string[];
  ignored_status_lines: string[];
}

function releaseFreshnessContract(
  detail: Record<string, unknown> | undefined,
): ReleaseFreshnessContract | null {
  const raw = detail?.freshness_contract;
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  return {
    ready: record.ready === true,
    reasons: stringArray(record.reasons),
    report_head: stringOrNull(record.report_head),
    live_head: stringOrNull(record.live_head),
    branch: stringOrNull(record.branch),
    blocking_status_lines: stringArray(record.blocking_status_lines),
    ignored_status_lines: stringArray(record.ignored_status_lines),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function shortSha(value: string | null | undefined): string | null {
  return value ? value.slice(0, 7) : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function statusOk(status: string | undefined): boolean {
  return status === "ok";
}

/**
 * X2 / D4 — Diagnostics panel. Surfaces local DB integrity, the AI worker /
 * generation queue, and on-disk backups with create + restore actions.
 */
export function DiagnosticsPanel() {
  const qc = useQueryClient();
  const integrity = useBackupIntegrity();
  const backups = useBackups();
  const obs = useObservability();
  const trust = useReleaseTrust("dev");
  const runtime = useRuntimeEvidence();
  const schedule = useScheduledTasks();
  const createBackup = useCreateBackup();
  const restoreBackup = useRestoreBackup();
  const contentHealth = useContentHealth();
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [logDir, setLogDir] = useState<string | null>(null);
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(null);
  const [backendBusy, setBackendBusy] = useState(false);
  const [runningTask, setRunningTask] = useState<string | null>(null);
  // G6 — last crash stored by ErrorBoundary.componentDidCatch.
  const [lastCrash, setLastCrash] = useState<LastCrash | null>(() =>
    readLastCrash(),
  );

  useEffect(() => {
    void getAppLogDir().then(setLogDir);
    void getBackendStatus().then(setBackendStatus);
  }, []);

  const integrityResult = integrity.data?.data.result;
  const integrityOk = integrityResult === "ok";
  const o = obs.data?.data;
  const list = backups.data?.data.backups ?? [];
  const health = contentHealth.data?.data;
  const trustManifest = trust.data?.data;
  const runtimeEvidence = runtime.data?.data;
  const tasks = schedule.data?.data.tasks ?? [];
  const trustChecks = trustManifest?.checks ?? {};
  const releaseContract = releaseFreshnessContract(trustChecks.release_local?.detail);
  const modelDetail = trustChecks.model_readiness?.detail;
  const backupDetail = trustChecks.backup_integrity?.detail;
  const backupNewest = recordOrNull(backupDetail?.newest);
  const latestBackupName =
    stringOrNull(backupNewest?.name) ??
    (list[0]?.name ? list[0].name : null);
  const backupAgeSeconds = numberOrNull(backupDetail?.newest_age_seconds);
  const providerName =
    stringOrNull(modelDetail?.provider) ??
    o?.models?.local_provider ??
    o?.models?.realtime_provider ??
    "unknown";
  const providerReachable =
    boolOrNull(modelDetail?.provider_reachable) ??
    boolOrNull(modelDetail?.ollama_reachable) ??
    null;
  const recentRuntimeErrors = runtimeEvidence?.recent_errors ?? [];
  const releaseActions = trustManifest
    ? [...trustManifest.blockers, ...trustManifest.warnings]
        .map((item) => item.action)
        .filter((action): action is string => Boolean(action))
    : [];
  const dailyBackupTask = tasks.find((task) => task.key === "daily_backup");
  const evidenceRows = [
    ["release_local", "Release gate"],
    ["model_readiness", "Model readiness"],
    ["runtime_evidence", "Runtime evidence"],
    ["backup_integrity", "Backup freshness"],
    ["scheduler", "Scheduler evidence"],
    ["benchmarks", "Generation gate"],
    ["backend_readiness", "Backend readiness"],
    ["content_health", "Content health"],
  ] as const;
  const readinessRows = [
    {
      key: "backend",
      label: "Backend",
      ok: o?.backend_ready ?? statusOk(trustChecks.backend_readiness?.status),
      detail: o?.db_ready === false ? "DB attention needed" : "Database ready",
    },
    {
      key: "provider",
      label: "Provider",
      ok: providerReachable ?? statusOk(trustChecks.model_readiness?.status),
      detail:
        providerReachable == null
          ? providerName
          : `${providerName}${providerReachable ? " reachable" : " unreachable"}`,
    },
    {
      key: "backup",
      label: "Backup",
      ok: statusOk(trustChecks.backup_integrity?.status) || Boolean(latestBackupName),
      detail: latestBackupName
        ? `${latestBackupName}${backupAgeSeconds != null ? ` · ${Math.round(backupAgeSeconds / 60)}m old` : ""}`
        : "No snapshot yet",
    },
    {
      key: "release",
      label: "Release",
      ok: releaseContract?.ready ?? trustManifest?.status === "ok",
      detail: trustManifest
        ? `${trustManifest.score}/100`
        : "Waiting for trust manifest",
    },
    {
      key: "logs",
      label: "Logs",
      ok:
        runtimeEvidence?.log_dir_writable ??
        trustChecks.runtime_evidence?.status === "ok",
      detail: runtimeEvidence
        ? `${runtimeEvidence.log_file_count} files · ${runtimeEvidence.recent_error_count} recent errors`
        : "Runtime evidence pending",
    },
    {
      key: "crash",
      label: "Crash",
      ok: !lastCrash,
      detail: lastCrash ? "Frontend crash recorded" : "No crashes recorded",
    },
  ];
  const recoveryActions = [
    ...(!releaseContract?.ready ? ["Run the local release gate before shipping."] : []),
    ...(providerReachable === false ? [`Start or repair ${providerName}.`] : []),
    ...(!latestBackupName ? ["Create a local database backup."] : []),
    ...((runtimeEvidence?.recent_error_count ?? 0) > 0 ? ["Inspect recent backend errors."] : []),
    ...(lastCrash ? ["Review the last frontend crash."] : []),
    ...releaseActions,
  ];

  function refreshAllDiagnostics() {
    void integrity.refetch();
    void backups.refetch();
    void obs.refetch();
    void contentHealth.refetch();
    void trust.refetch();
    void runtime.refetch();
    void schedule.refetch();
    void refreshNativeBackend();
  }

  function openLogs() {
    void exportBackendLogs().then((p) => {
      if (p) void openPath(p);
      else if (logDir) void openPath(logDir);
    });
  }

  async function refreshNativeBackend() {
    const next = await getBackendStatus();
    setBackendStatus(next);
  }

  async function restartNativeBackend() {
    setBackendBusy(true);
    try {
      const next = await restartBackend();
      setBackendStatus(next);
      void obs.refetch();
    } finally {
      setBackendBusy(false);
    }
  }

  function confirmRestore() {
    if (!restoreTarget) return;
    const name = restoreTarget;
    setRestoreTarget(null);
    restoreBackup.mutate(name);
  }

  async function runScheduledTask(key: string) {
    setRunningTask(key);
    try {
      const result = await api.runScheduledTask(key);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["scheduled-tasks"] }),
        qc.invalidateQueries({ queryKey: ["release-trust"] }),
        qc.invalidateQueries({ queryKey: ["content-health"] }),
        qc.invalidateQueries({ queryKey: ["backups"] }),
        qc.invalidateQueries({ queryKey: ["backup-integrity"] }),
      ]);
      void trust.refetch();
      void backups.refetch();
      void integrity.refetch();
      if (!result.ok) {
        toast.error(result.error || result.reason || `${key.replace(/_/g, " ")} failed`);
        return;
      }
      toast.success(`${key.replace(/_/g, " ")} ran`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `${key.replace(/_/g, " ")} failed`);
    } finally {
      setRunningTask(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Diagnostics</CardTitle>
        <Button
          size="sm"
          variant="ghost"
          onClick={refreshAllDiagnostics}
          aria-label="Refresh diagnostics"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-3 rounded-md border bg-muted/20 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 font-medium">
              <Wrench className="h-4 w-4 text-muted-foreground" aria-hidden />
              Reliability console
            </span>
            <Badge
              variant={
                readinessRows.every((row) => row.ok)
                  ? "success"
                  : recoveryActions.length
                    ? "warning"
                    : "outline"
              }
            >
              {readinessRows.every((row) => row.ok)
                ? "ready"
                : `${readinessRows.filter((row) => !row.ok).length} attention`}
            </Badge>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {readinessRows.map((row) => (
              <div key={row.key} className="rounded border bg-background/70 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">{row.label}</span>
                  <Badge
                    variant={row.ok ? "success" : "warning"}
                    className="shrink-0"
                  >
                    {row.ok ? "ok" : "check"}
                  </Badge>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground" title={row.detail}>
                  {row.detail}
                </p>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1 text-xs"
              onClick={refreshAllDiagnostics}
              aria-label="Rerun diagnostics"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              Doctor
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1 text-xs"
              disabled={createBackup.isPending}
              onClick={() => createBackup.mutate()}
              aria-label="Create reliability backup"
            >
              <DatabaseBackup className="h-3.5 w-3.5" aria-hidden />
              Backup
            </Button>
            {dailyBackupTask ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1 text-xs"
                disabled={runningTask != null}
                onClick={() => void runScheduledTask(dailyBackupTask.key)}
                aria-label="Run daily backup task"
              >
                <Play className="h-3.5 w-3.5" aria-hidden />
                Daily task
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1 text-xs"
              onClick={openLogs}
              aria-label="Open reliability logs"
              title="Open reliability logs"
            >
              <FolderOpen className="h-3.5 w-3.5" aria-hidden />
              Logs
            </Button>
          </div>
          {recoveryActions.length ? (
            <div className="space-y-1 rounded-md bg-warning/10 px-2 py-1.5 text-xs text-warning">
              {recoveryActions.slice(0, 4).map((action) => (
                <p key={action}>{action}</p>
              ))}
            </div>
          ) : null}
        </div>

        {/* Database integrity */}
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-muted-foreground">
            {integrityOk ? (
              <ShieldCheck className="h-4 w-4 text-success" aria-hidden />
            ) : (
              <ShieldAlert className="h-4 w-4 text-warning" aria-hidden />
            )}
            Database integrity
          </span>
          {integrityOk ? (
            <Badge variant="success">ok</Badge>
          ) : (
            <Badge variant="warning">{integrityResult ?? "unknown"}</Badge>
          )}
        </div>

        {/* AI worker / queue (worker_alive isn't shown in the trust strip above) */}
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-muted-foreground">
            <Activity className="h-4 w-4" aria-hidden />
            AI worker
          </span>
          {o?.worker_alive ? (
            <span className="flex items-center gap-1 text-success">
              <CircleCheck className="h-4 w-4" aria-hidden /> alive
            </span>
          ) : (
            <span className="flex items-center gap-1 text-muted-foreground">
              <CircleX className="h-4 w-4" aria-hidden /> idle
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Native backend</span>
          <span className="flex items-center gap-2">
            <span className="tabular-nums text-muted-foreground">
              {backendStatus
                ? `${backendStatus.managed} · ${backendStatus.healthy ? "healthy" : "degraded"}`
                : "browser"}
            </span>
            {backendStatus?.restartable ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                disabled={backendBusy}
                onClick={restartNativeBackend}
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                {backendBusy ? "Restarting" : "Restart"}
              </Button>
            ) : null}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Generation queue</span>
          <span className="tabular-nums text-muted-foreground">
            {o ? `${o.gen_queued} queued · ${o.gen_running} running` : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Coach snapshot</span>
          <span className="tabular-nums text-muted-foreground">
            {o?.last_coach_refresh_ms != null
              ? `${Math.round(o.last_coach_refresh_ms / 60000)}m ago`
              : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Explain p50 · embed coverage</span>
          <span className="tabular-nums text-muted-foreground">
            {o?.explain_p50_ms != null ? `${(o.explain_p50_ms / 1000).toFixed(1)}s` : "—"}
            {" · "}
            {o ? `${o.embed_coverage_pct}%` : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-muted-foreground">
            <ShieldCheck className="h-4 w-4" aria-hidden />
            Release trust
          </span>
          {trustManifest?.status === "blocked" ? (
            <Badge variant="destructive">{trustManifest.score}/100</Badge>
          ) : trustManifest?.status === "ok" ? (
            <Badge variant="success">{trustManifest.score}/100</Badge>
          ) : (
            <Badge variant="warning">
              {trustManifest ? `${trustManifest.score}/100` : "pending"}
            </Badge>
          )}
        </div>
        {trustManifest?.next_actions[0] ? (
          <p className="rounded-md bg-muted/45 px-3 py-2 text-xs text-muted-foreground">
            {trustManifest.next_actions[0]}
          </p>
        ) : null}

        <div className="space-y-2 rounded-md border bg-muted/20 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 font-medium">
              <Server className="h-4 w-4 text-muted-foreground" aria-hidden />
              Runtime logs
            </span>
            <Badge
              variant={(runtimeEvidence?.recent_error_count ?? 0) > 0 ? "warning" : "success"}
            >
              {runtimeEvidence
                ? `${runtimeEvidence.recent_error_count} errors`
                : "pending"}
            </Badge>
          </div>
          <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
            <span className="flex items-center gap-1">
              <FolderOpen className="h-3.5 w-3.5" aria-hidden />
              {runtimeEvidence?.log_dir_exists ? "Log dir present" : "Log dir missing"}
            </span>
            <span className="flex items-center gap-1">
              <HardDrive className="h-3.5 w-3.5" aria-hidden />
              {runtimeEvidence?.log_dir_writable ? "Writable" : "Read-only or unavailable"}
            </span>
            <span className="flex items-center gap-1">
              <Bug className="h-3.5 w-3.5" aria-hidden />
              {runtimeEvidence
                ? `${runtimeEvidence.log_file_count} log files`
                : "No runtime evidence"}
            </span>
          </div>
          {runtimeEvidence?.last_request_error ? (
            <div className="rounded-md bg-destructive/5 px-2 py-1.5 text-xs">
              <p className="font-medium text-destructive">
                Last request error
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {[runtimeEvidence.last_request_error.status, runtimeEvidence.last_request_error.path]
                  .filter(Boolean)
                  .join(" · ") || runtimeEvidence.last_request_error.file}
              </p>
              <p className="truncate text-muted-foreground">
                {runtimeEvidence.last_request_error.message}
              </p>
            </div>
          ) : recentRuntimeErrors[0] ? (
            <div className="rounded-md bg-warning/10 px-2 py-1.5 text-xs text-warning">
              <p className="font-medium">Recent backend error</p>
              <p className="truncate">
                {[recentRuntimeErrors[0].status, recentRuntimeErrors[0].path]
                  .filter(Boolean)
                  .join(" · ") || recentRuntimeErrors[0].file}
                {": "}
                {recentRuntimeErrors[0].message}
              </p>
            </div>
          ) : null}
        </div>

        <div className="space-y-2 rounded-md border bg-muted/20 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <span className="font-medium">Release evidence</span>
              <p className="text-xs text-muted-foreground">
                {releaseContract
                  ? `${releaseContract.branch ?? "detached"} · ${shortSha(releaseContract.report_head) ?? "no head"}`
                  : "Awaiting release-local report"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant={releaseContract?.ready ? "success" : "warning"}>
                {releaseContract?.ready ? "ship ready" : "needs gate"}
              </Badge>
              <span className="text-xs tabular-nums text-muted-foreground">
                {trustManifest?.generated_at
                  ? timeAgo(trustManifest.generated_at)
                  : "not generated"}
              </span>
            </div>
          </div>
          {releaseContract ? (
            <div className="grid gap-1.5 text-xs text-muted-foreground sm:grid-cols-3">
              <span>
                Live head: {shortSha(releaseContract.live_head) ?? "unknown"}
              </span>
              <span>
                Blocking changes: {releaseContract.blocking_status_lines.length}
              </span>
              <span>
                Ignored policy files: {releaseContract.ignored_status_lines.length}
              </span>
              {releaseContract.reasons.length ? (
                <span className="sm:col-span-3">
                  {releaseContract.reasons.map((reason) => reason.replace(/_/g, " ")).join(", ")}
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="space-y-1.5">
            {evidenceRows.map(([key, label]) => {
              const check = trustChecks[key];
              return (
                <div key={key} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium">{label}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {check?.summary ?? "No current evidence"}
                    </p>
                  </div>
                  <Badge
                    variant={trustVariant(check?.status)}
                    className="shrink-0"
                  >
                    {trustStatus(check?.status)}
                  </Badge>
                </div>
              );
            })}
          </div>
          {trustManifest?.blockers.length ? (
            <div className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
              {trustManifest.blockers.length} blocker
              {trustManifest.blockers.length === 1 ? "" : "s"}:{" "}
              {trustManifest.blockers.map((b) => b.summary).join("; ")}
            </div>
          ) : null}
          {releaseActions.length ? (
            <div className="space-y-1 rounded-md bg-warning/10 px-2 py-1.5 text-xs text-warning">
              {releaseActions.slice(0, 3).map((action) => (
                <p key={action}>{action}</p>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Content health</span>
          <span className="tabular-nums text-muted-foreground">
            {health ? `${health.score}/100 · ${health.warnings.length} warnings` : "—"}
          </span>
        </div>
        {o?.cloud_tokens && o.cloud_tokens.total_tokens > 0 ? (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Cloud Tier-B tokens (session)</span>
            <span className="tabular-nums text-muted-foreground">
              {o.cloud_tokens.total_tokens.toLocaleString()}
              {o.cloud_monthly_budget_usd
                ? ` · budget $${o.cloud_monthly_budget_usd}`
                : ""}
            </span>
          </div>
        ) : null}

        <div className="space-y-2 rounded-md border bg-muted/20 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">Scheduled maintenance</span>
            <Badge variant={tasks.length ? "outline" : "warning"}>
              {tasks.length ? `${tasks.length} tasks` : "not loaded"}
            </Badge>
          </div>
          <div className="space-y-1.5">
            {tasks.slice(0, 5).map((task) => (
              <div key={task.key} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">{task.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {task.status} · last{" "}
                    {task.last_run_at ? timeAgo(task.last_run_at) : "never"} · next{" "}
                    {task.next_run_at ? timeAgo(task.next_run_at) : "pending"}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 gap-1 text-xs"
                  disabled={runningTask != null}
                  onClick={() => void runScheduledTask(task.key)}
                  aria-label={`Run ${task.label}`}
                  title={`Run ${task.label}`}
                >
                  <Play className="h-3.5 w-3.5" aria-hidden />
                  {runningTask === task.key ? "Running" : "Run"}
                </Button>
              </div>
            ))}
            {!tasks.length ? (
              <p className="text-xs text-muted-foreground">
                Scheduler evidence is unavailable until the backend responds.
              </p>
            ) : null}
          </div>
        </div>

        {import.meta.env.DEV && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Developer: MCP server</summary>
            <p className="mt-1">
              MCP (Jarvis): see{" "}
              <span className="font-mono">docs/15-mcp.md</span> — run{" "}
              <span className="font-mono">uv run python -m app.mcp_server</span> from{" "}
              <span className="font-mono">backend/</span>.
            </p>
          </details>
        )}
        {logDir ? (
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <p className="min-w-0">
              Desktop logs:{" "}
              <span className="break-all font-mono">{logDir}</span>
            </p>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 shrink-0 gap-1 text-xs"
              onClick={openLogs}
              aria-label="Open backend log folder"
              title="Open backend log folder"
            >
              <FolderOpen className="h-3.5 w-3.5" aria-hidden />
              Logs
            </Button>
          </div>
        ) : null}

        {/* G6 — Last crash row */}
        <div className="space-y-1 border-t pt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 font-medium">
              <TriangleAlert className="h-4 w-4 text-muted-foreground" aria-hidden />
              Last crash
            </span>
            {lastCrash ? (
              <div className="flex items-center gap-1">
                {logDir ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 text-xs"
                    onClick={() => void openPath(logDir)}
                    aria-label="Open log folder"
                    title="Open log folder"
                  >
                    <FolderOpen className="h-3.5 w-3.5" aria-hidden />
                    Logs
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs text-muted-foreground"
                  onClick={() => {
                    localStorage.removeItem(CRASH_KEY);
                    setLastCrash(null);
                  }}
                >
                  Clear
                </Button>
              </div>
            ) : null}
          </div>
          {lastCrash ? (
            <div className="rounded-md bg-destructive/5 px-3 py-2 text-xs">
              <p className="font-medium text-destructive">
                {lastCrash.message}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {timeAgo(new Date(lastCrash.ts).toISOString())}
                {lastCrash.route ? ` · ${lastCrash.route}` : ""}
              </p>
              {lastCrash.componentStack ? (
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-muted-foreground opacity-70">
                  {lastCrash.componentStack}
                </pre>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No crashes recorded.</p>
          )}
        </div>

        {/* Local backups */}
        <div className="space-y-2 border-t pt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 font-medium">
              <DatabaseBackup className="h-4 w-4 text-muted-foreground" aria-hidden />
              Local backups
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={createBackup.isPending}
              onClick={() => createBackup.mutate()}
            >
              {createBackup.isPending ? "Backing up…" : "Back up now"}
            </Button>
          </div>

          {list.length === 0 ? (
            <EmptyState
              title="No backups yet"
              description="Create a local snapshot of your study database. Backups stay on this machine."
              className="py-8"
              icon={<DatabaseBackup className="h-6 w-6" />}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="w-24 text-right">Size</TableHead>
                  <TableHead className="w-28">Created</TableHead>
                  <TableHead className="w-20 text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((b) => (
                  <TableRow key={b.name}>
                    <TableCell className="max-w-[14rem] truncate font-mono text-xs">
                      {b.name}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {formatBytes(b.size_bytes)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {b.created_at ? timeAgo(b.created_at) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={restoreBackup.isPending}
                        onClick={() => setRestoreTarget(b.name)}
                        aria-label={`Restore ${b.name}`}
                      >
                        Restore
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <p className="text-xs text-muted-foreground">
            Restoring replaces your current database with the selected snapshot.
          </p>
        </div>
      </CardContent>

      <Dialog
        open={restoreTarget != null}
        onOpenChange={(open) => {
          if (!open) setRestoreTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore this backup?</DialogTitle>
            <DialogDescription>
              This replaces your current study database with{" "}
              <span className="font-mono">{restoreTarget}</span>. Recent attempts
              not in the snapshot will be lost, and a restart is recommended
              afterward.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="pt-2">
            <Button variant="outline" onClick={() => setRestoreTarget(null)}>
              Cancel
            </Button>
            <Button
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmRestore}
            >
              Restore
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
