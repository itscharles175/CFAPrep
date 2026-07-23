/**
 * OPS-4 — Maintenance panel for the System Health page.
 *
 * Wires the LSAT sidecar's EXISTING local-maintenance scheduler surfaces
 * (read-only on the backend — no route changes) into one operator panel:
 *  - the scheduled-task registry with run-now / enable-toggle / cadence edit,
 *  - recent run history (newest first),
 *  - client GUARDRAIL banners (cloud-budget pressure, IndexedDB-quota pressure,
 *    local-model outage), evaluated purely from already-loaded page state, and
 *  - a one-click DIAGNOSTICS EXPORT that bundles the trust manifest,
 *    runtime-metric evidence, backend runtime-evidence, sidecar status/logs,
 *    cloud metrics, and the maintenance registry into a timestamped JSON.
 *
 * Fully degrading throughout (the same idiom as the rest of System Health): a
 * down/slow sidecar leaves the panel visible with an honest "offline" note
 * rather than throwing. The guardrail evaluation + bundle building live in the
 * pure, unit-tested `maintenancePanel.ts`; this component does the fetching,
 * the optimistic state, and the file download.
 *
 * LOCAL-ONLY: the diagnostics bundle is a local download the user initiates;
 * nothing is sent anywhere.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CloudCog, Database, Download, RefreshCw, ServerCog, WifiOff, Wrench } from 'lucide-react';
import type { paths } from '../../domains/lsat/lib/api.gen';
import { StatusBadge, Surface } from '../ui/Primitives';
import {
  ensureLsatScheduledDefaults,
  getLsatScheduledTasks,
  getLsatSchedulerRuns,
  runDueLsatScheduledTasks,
  runLsatScheduledTask,
  upsertLsatScheduledTask,
  type LsatCloudBudgetReport,
  type LsatScheduledTask,
  type LsatSchedulerRun,
} from '../../lib/lsatBackend';
import {
  buildDiagnosticsBundle,
  CADENCE_PRESETS,
  diagnosticsFilename,
  evaluateGuardrails,
  formatCadence,
  type GuardrailBanner,
} from '../../lib/maintenancePanel';
import { getRuntimeMetrics } from '../../lib/runtimeMetricsStore';
import { fetchLsatSidecarJson } from '../../lib/lsatSidecarClient';
import { getSidecarLogs, getSidecarStatus, type AggregatedSystemHealth } from '../../lib/systemHealth';
import type { TrustManifest } from '../../hooks/useTrustManifest';

const RUNTIME_EVIDENCE_PATH = '/api/observability/runtime-evidence' satisfies keyof paths;

/** Degrading fetch of the backend runtime-evidence summary (log dir / recent
 *  errors). Never throws — returns null on any failure so the export still
 *  bundles. This is a read-only existing endpoint (/observability/runtime-evidence). */
async function fetchBackendRuntimeEvidence(timeoutMs = 3000): Promise<unknown> {
  const res = await fetchLsatSidecarJson(RUNTIME_EVIDENCE_PATH, {
    timeoutMs,
    headers: { accept: 'application/json' },
  });
  return res.ok ? res.data : null;
}

export interface MaintenancePanelProps {
  /** The release-trust manifest (OPS-2), folded into the diagnostics export. */
  trustManifest: TrustManifest | null;
  /** Aggregated readiness verdict (OPS-3) — drives the model-outage guardrail + export. */
  aggregatedHealth: AggregatedSystemHealth | null;
  /** Cloud-budget report (BB4) — drives the cloud-budget guardrail + export. */
  cloudBudget: LsatCloudBudgetReport | null;
  /** `navigator.storage.estimate()` result — drives the IndexedDB-quota guardrail. */
  storageEstimate: { usage?: number; quota?: number } | null;
  /** Reuse the page's existing JSON downloader so behaviour matches other exports. */
  onDownloadJson: (payload: unknown, filename?: string) => void;
}

/** Tone → Surface status + badge tone for a guardrail banner. */
const BANNER_ICON = {
  'cloud-budget': CloudCog,
  'indexeddb-quota': Database,
  'model-outage': WifiOff,
} as const;

export default function MaintenancePanel({
  trustManifest,
  aggregatedHealth,
  cloudBudget,
  storageEstimate,
  onDownloadJson,
}: MaintenancePanelProps) {
  const [tasks, setTasks] = useState<LsatScheduledTask[] | null>(null);
  const [runs, setRuns] = useState<LsatSchedulerRun[]>([]);
  const [reachable, setReachable] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(true);
  const [busyKey, setBusyKey] = useState<string | null>(null); // task key being mutated, or '*' for global
  const [note, setNote] = useState<string>('');
  const [exporting, setExporting] = useState<boolean>(false);
  // Guardrail banners the user has dismissed this session (by id).
  const [dismissed, setDismissed] = useState<Set<GuardrailBanner['id']>>(() => new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    const [taskReport, runReport] = await Promise.all([getLsatScheduledTasks(), getLsatSchedulerRuns()]);
    setReachable(taskReport.reachable);
    setTasks(taskReport.ok ? taskReport.tasks : []);
    setRuns(runReport.ok ? runReport.runs : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [taskReport, runReport] = await Promise.all([getLsatScheduledTasks(), getLsatSchedulerRuns()]);
      if (!active) return;
      setReachable(taskReport.reachable);
      setTasks(taskReport.ok ? taskReport.tasks : []);
      setRuns(runReport.ok ? runReport.runs : []);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  // Guardrail banners — recomputed purely from already-loaded page state.
  const banners = useMemo(
    () =>
      evaluateGuardrails({ cloudBudget, storageEstimate, aggregatedHealth }).filter(
        (b) => !dismissed.has(b.id),
      ),
    [cloudBudget, storageEstimate, aggregatedHealth, dismissed],
  );

  async function handleRunTask(key: string) {
    setBusyKey(key);
    setNote('');
    const result = await runLsatScheduledTask(key);
    setNote(result.detail);
    await refresh();
    setBusyKey(null);
  }

  async function handleToggleTask(task: LsatScheduledTask) {
    setBusyKey(task.key);
    setNote('');
    const result = await upsertLsatScheduledTask({
      key: task.key,
      label: task.label,
      task_type: task.task_type,
      cadence_s: task.cadence_s,
      enabled: !task.enabled,
      payload: task.payload,
    });
    setNote(result.detail);
    await refresh();
    setBusyKey(null);
  }

  async function handleCadenceChange(task: LsatScheduledTask, cadence_s: number) {
    setBusyKey(task.key);
    setNote('');
    const result = await upsertLsatScheduledTask({
      key: task.key,
      label: task.label,
      task_type: task.task_type,
      cadence_s,
      enabled: task.enabled,
      payload: task.payload,
    });
    setNote(result.detail);
    await refresh();
    setBusyKey(null);
  }

  async function handleRunDue() {
    setBusyKey('*');
    setNote('');
    const result = await runDueLsatScheduledTasks();
    setNote(result.detail);
    await refresh();
    setBusyKey(null);
  }

  async function handleSeedDefaults() {
    setBusyKey('*');
    setNote('');
    const result = await ensureLsatScheduledDefaults();
    setNote(result.detail);
    await refresh();
    setBusyKey(null);
  }

  async function handleExportDiagnostics() {
    setExporting(true);
    setNote('');
    try {
      // Pull the freshest sidecar status + per-sidecar log tails alongside the
      // backend runtime-evidence; each read degrades to null/empty on its own.
      const [sidecarStatus, backendRuntimeEvidence] = await Promise.all([
        getSidecarStatus(),
        fetchBackendRuntimeEvidence(),
      ]);
      const logs: Record<string, string[]> = {};
      if (sidecarStatus) {
        for (const sidecar of sidecarStatus) {
          const tail = await getSidecarLogs(sidecar.name);
          if (tail) logs[sidecar.name] = tail;
        }
      }
      const bundle = buildDiagnosticsBundle({
        trustManifest,
        aggregatedHealth,
        runtimeEvidence: getRuntimeMetrics(),
        backendRuntimeEvidence,
        cloudMetrics: cloudBudget,
        sidecarStatus,
        sidecarLogs: logs,
        scheduledTasks: tasks ?? [],
        recentRuns: runs,
        // Re-evaluate without the session dismissals so the export reflects the
        // true active guardrails, not what the operator has hidden from view.
        guardrails: evaluateGuardrails({ cloudBudget, storageEstimate, aggregatedHealth }),
      });
      onDownloadJson(bundle, diagnosticsFilename());
      setNote('Diagnostics bundle exported.');
    } catch (error) {
      setNote(error instanceof Error ? `Diagnostics export failed: ${error.message}` : 'Diagnostics export failed.');
    } finally {
      setExporting(false);
    }
  }

  const globalBusy = busyKey === '*';
  const hasTasks = (tasks?.length ?? 0) > 0;

  return (
    <Surface tone="ops" className="ops-report-panel">
      {/* Client guardrail banners — danger-first; dismissible for the session. */}
      {banners.length > 0 && (
        <div className="qv-stack-2" style={{ marginBottom: 'var(--space-4)' }}>
          {banners.map((banner) => {
            const Icon = BANNER_ICON[banner.id] ?? AlertTriangle;
            return (
              <div
                key={banner.id}
                role="alert"
                className={`surface surface-compact surface-status-${banner.tone === 'danger' ? 'danger' : 'warning'}`}
                style={{ padding: 'var(--space-3)' }}
              >
                <div className="flex-between" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}>
                    <strong className={banner.tone === 'danger' ? 'qv-text-danger' : 'qv-text-warning'}>
                      <Icon size={14} aria-hidden="true" style={{ verticalAlign: 'text-bottom', marginRight: 'var(--space-1)' }} />
                      {banner.title}
                    </strong>
                    <p className="qv-m-0 qv-mt-1 qv-fs-sm qv-text-secondary">{banner.detail}</p>
                  </div>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setDismissed((prev) => new Set(prev).add(banner.id))}
                    aria-label={`Dismiss ${banner.title} warning`}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex-between" style={{ gap: 'var(--space-4)', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <StatusBadge tone="ops">Maintenance</StatusBadge>
          <h3 className="qv-m-0 qv-mt-2">
            <Wrench size={18} aria-hidden="true" style={{ verticalAlign: 'text-bottom', marginRight: 'var(--space-1)' }} />
            Local maintenance{' '}
            <span className="qv-mono qv-text-muted qv-fs-sm">
              {loading ? 'loading…' : reachable ? `${tasks?.length ?? 0} task${(tasks?.length ?? 0) === 1 ? '' : 's'}` : 'offline'}
            </span>
          </h3>
          <p className="qv-text-secondary qv-m-0">
            The LSAT backend runs a small registry of local upkeep tasks — backups, difficulty calibration,
            embedding-coverage checks, content audits. Run one now, pause it, or change its cadence. Nothing
            here calls the cloud; every task is local and on-device.
          </p>
        </div>
        <div className="qv-row-2" style={{ flexWrap: 'wrap' }}>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => void refresh()}
            disabled={loading || globalBusy}
          >
            <RefreshCw size={14} /> {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => void handleRunDue()}
            disabled={!reachable || globalBusy || !hasTasks}
            title="Run every task whose next-run time has passed"
          >
            <ServerCog size={14} /> {globalBusy ? 'Working…' : 'Run due now'}
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => void handleExportDiagnostics()}
            disabled={exporting}
            title="Bundle trust manifest, runtime evidence, sidecar logs, and cloud metrics into a local JSON"
          >
            <Download size={14} /> {exporting ? 'Exporting…' : 'Export diagnostics'}
          </button>
        </div>
      </div>

      {note && <p className="qv-mt-3 qv-mb-0 qv-fs-sm qv-text-secondary qv-mono">{note}</p>}

      {/* Task registry */}
      {!reachable ? (
        <p className="qv-text-secondary qv-m-0 qv-mt-3 qv-fs-sm">
          The maintenance scheduler lives in the LSAT backend sidecar (:8100). Start it to manage local upkeep
          tasks. Diagnostics export still works with whatever signals are reachable.
        </p>
      ) : !hasTasks && !loading ? (
        <div className="qv-mt-3">
          <p className="qv-text-secondary qv-m-0 qv-fs-sm">
            No maintenance tasks are registered yet. Seed the local defaults (backup, calibration, embedding,
            content audit) to get a starting schedule.
          </p>
          <button
            className="btn btn-secondary btn-sm qv-mt-2"
            onClick={() => void handleSeedDefaults()}
            disabled={globalBusy}
          >
            {globalBusy ? 'Seeding…' : 'Seed default schedule'}
          </button>
        </div>
      ) : (
        <div className="qv-stack-2" style={{ marginTop: 'var(--space-4)' }}>
          {(tasks ?? []).map((task) => {
            const taskBusy = busyKey === task.key;
            const lastRunFailed = task.status === 'failed';
            return (
              <div
                key={task.key}
                className={`surface surface-compact${lastRunFailed ? ' surface-status-warning' : ''}`}
                style={{ padding: 'var(--space-3)' }}
              >
                <div className="flex-between" style={{ gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <strong className="qv-fs-sm">
                      {task.label}{' '}
                      {!task.enabled && <span className="qv-text-muted qv-fs-xs">(paused)</span>}
                      {lastRunFailed && <span className="qv-text-warning qv-fs-xs"> · last run failed</span>}
                    </strong>
                    <small className="qv-text-muted" style={{ display: 'block' }}>
                      <span className="qv-mono">{task.task_type}</span> · every {formatCadence(task.cadence_s)}
                      {task.last_run_at ? ` · last ${formatTimestamp(task.last_run_at)}` : ' · never run'}
                      {task.enabled && task.next_run_at ? ` · next ${formatTimestamp(task.next_run_at)}` : ''}
                    </small>
                  </div>
                  <div className="qv-row-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                    <label className="qv-fs-xs qv-text-muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                      Cadence
                      <select
                        className="input"
                        value={task.cadence_s}
                        onChange={(event) => void handleCadenceChange(task, Number(event.target.value))}
                        disabled={taskBusy || globalBusy}
                        aria-label={`Cadence for ${task.label}`}
                      >
                        {/* Include the current value if it isn't one of the presets. */}
                        {!CADENCE_PRESETS.some((p) => p.seconds === task.cadence_s) && (
                          <option value={task.cadence_s}>{formatCadence(task.cadence_s)} (current)</option>
                        )}
                        {CADENCE_PRESETS.map((preset) => (
                          <option key={preset.seconds} value={preset.seconds}>
                            {preset.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => void handleToggleTask(task)}
                      disabled={taskBusy || globalBusy}
                    >
                      {task.enabled ? 'Pause' : 'Enable'}
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => void handleRunTask(task.key)}
                      disabled={taskBusy || globalBusy}
                    >
                      {taskBusy ? 'Running…' : 'Run now'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Recent run history */}
      {runs.length > 0 && (
        <>
          <h4 className="qv-mt-4 qv-mb-2">
            Recent runs <span className="qv-mono qv-text-muted qv-fs-sm">last {runs.length}</span>
          </h4>
          <div className="qv-stack-1">
            {runs.slice(0, 10).map((run) => (
              <div
                key={run.id ?? `${run.task_key}-${run.created_at}`}
                className="flex-between qv-fs-sm"
                style={{ gap: 'var(--space-3)', alignItems: 'baseline' }}
              >
                <span className="qv-mono" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {run.task_key}
                </span>
                <span className={run.status === 'ok' ? 'qv-text-success qv-fs-xs' : 'qv-text-warning qv-fs-xs'}>
                  {run.status}
                  {run.duration_ms != null ? ` · ${Math.round(run.duration_ms)}ms` : ''}
                  {run.created_at ? ` · ${formatTimestamp(run.created_at)}` : ''}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </Surface>
  );
}

/** Compact local timestamp ("Jun 16, 14:30"), or the raw string on parse fail. */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
