import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  Upload, Trash2, Bookmark, StickyNote, ShieldAlert, BarChart3, Lock,
} from 'lucide-react';
import { useProgressSummary } from '../hooks/useProgress';
import { exportVaultData, importVaultData, previewVaultImportPayload, resetVaultData } from '../lib/learning';
import type { VaultImportPreview } from '../lib/learning';
import { parseJsonFile } from '../lib/jsonFilePreflight';
import { getCfaSourceDocuments } from '../lib/cfaSourceVault';
import { getLlmSettings } from '../lib/localLlm';
import { getStorage } from '../lib/storage';
import {
  Dialog,
  InlineCluster,
  PageHeader,
  PageSection,
  Panel,
  SegmentedControl,
  StatCell,
  StatusBadge,
  Surface,
} from '../components/ui/Primitives';
import { OnboardingWizard } from '../components/Onboarding';
import { WeaknessIndexCard } from '../components/dashboard/WeaknessIndexCard';
import { CrossDomainProgressReport } from '../components/dashboard/CrossDomainProgressReport';
import { DashboardSparklineGrid } from '../components/dashboard/DashboardSparklineGrid';
import { DashboardReadinessChecklist } from '../components/dashboard/DashboardReadinessChecklist';
import {
  aggregateReadiness,
  fetchDashboardMetrics,
  scoreReadiness,
  aggregateBlindReviewOutcomes,
  type DashboardMetrics,
} from '../lib/dashboardMetrics';
import { useScrollRestoration } from '../lib/scrollRestore';

function formatStudyTime(seconds: number): string {
  if (!seconds) return '0m';
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function backupFilename(prefix = 'studyvault-export'): string {
  return `${prefix}-${new Date().toISOString().slice(0, 10)}.json`;
}

function downloadJson(payload: unknown, filename = backupFilename()): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatCount(value: number | undefined | null): string {
  return Number(value || 0).toLocaleString();
}

function formatBackupDate(value: string | null | undefined): string {
  if (!value) return 'Unknown date';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

type ImportMode = 'merge' | 'replace';
type ConflictPolicy = 'keep-existing' | 'prefer-import' | 'replace';
type ResetScope = 'attempts' | 'progress' | 'full';

interface ImportModeOption {
  value: ImportMode;
  label: string;
}

interface ConflictPolicyOption {
  value: ConflictPolicy;
  label: string;
}

const importModeOptions: ImportModeOption[] = [
  { value: 'merge', label: 'Merge' },
  { value: 'replace', label: 'Replace' },
];

const conflictPolicyOptions: ConflictPolicyOption[] = [
  { value: 'prefer-import', label: 'Prefer Import' },
  { value: 'keep-existing', label: 'Keep Existing' },
];

interface PendingImport {
  payload: unknown;
  encrypted: boolean;
  preview: VaultImportPreview | null;
  fileName: string;
  sizeBytes: number;
  parsedInWorker: boolean;
}

interface PendingReset {
  scope: ResetScope;
  label: string;
}

interface RefreshImportPreviewOptions {
  mode?: ImportMode;
  conflictPolicy?: ConflictPolicy;
  includeSourceVault?: boolean;
}

export default function Dashboard() {
  const summary = useProgressSummary();
  const importRef = useRef<HTMLInputElement | null>(null);
  const [vaultMessage, setVaultMessage] = useState('');
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [pendingReset, setPendingReset] = useState<PendingReset | null>(null);
  const [importPassphrase, setImportPassphrase] = useState('');
  const [importMode, setImportMode] = useState<ImportMode>('merge');
  const [conflictPolicy, setConflictPolicy] = useState<ConflictPolicy>('prefer-import');
  const [includeSourceImport, setIncludeSourceImport] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [exportPassphraseConfirm, setExportPassphraseConfirm] = useState('');
  const [includeSourceExport, setIncludeSourceExport] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  // ANL-4: shaped learning curves + study profile (per-domain mastery sparklines
  // and the green/amber/red readiness checklist). fetchDashboardMetrics never
  // throws — a down sidecar yields empty/unreachable curves and the components
  // render honest empty cells, so this never blocks the dashboard.
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);

  // UX-1: restore the document scroll position on return to the dashboard,
  // including after a cross-domain soft-hop (which bypasses native scroll
  // restoration). The dashboard renders its full structure on first paint
  // (the progress summary fills in from a stable empty shape), so restoration
  // is enabled immediately.
  useScrollRestoration('host:/');

  // ANL-4: load the shaped curves + study profile once on mount.
  useEffect(() => {
    let alive = true;
    fetchDashboardMetrics().then((m) => {
      if (alive) setMetrics(m);
    });
    return () => {
      alive = false;
    };
  }, []);

  // ANL-4: derive the readiness checklist rows once metrics load. Pure shaper —
  // a dimension with no signal renders grey 'unknown' rather than a false verdict.
  const readinessChecks = metrics
    ? scoreReadiness(
        { curves: metrics.curves, profile: metrics.profile },
        { blindReview: aggregateBlindReviewOutcomes(metrics.curves) },
      )
    : [];
  const hasReadinessEvidence = summary.questionsAnswered > 0
    || metrics?.curves.some((curve) => curve.reachable && curve.evidenceN > 0) === true;
  const readinessStatus = hasReadinessEvidence ? aggregateReadiness(readinessChecks) : 'unknown';
  const attentionCount = readinessChecks.filter((check) => check.status === 'red' || check.status === 'amber').length;
  const readinessNarrative = metrics === null
    ? 'Building your readiness view from local study evidence.'
    : readinessStatus === 'green'
      ? 'Your available evidence is on track. Keep the current pace and use the detailed view to protect weaker areas.'
      : readinessStatus === 'amber'
        ? `${attentionCount} readiness signal${attentionCount === 1 ? '' : 's'} need watching. Focus on consistency before adding more volume.`
        : readinessStatus === 'red'
          ? `${attentionCount} readiness signal${attentionCount === 1 ? '' : 's'} need attention. Review the weakest areas before the next full assessment.`
          : 'Complete a few scored study sessions to establish a trustworthy readiness baseline.';

  useEffect(() => {
    let active = true;
    async function checkOnboarding() {
      try {
        const [docs, llmSettings, dismissedRow] = await Promise.all([
          getCfaSourceDocuments(),
          getLlmSettings(),
          getStorage().settings.get('onboarding-dismissed').catch(() => undefined),
        ]);
        if (!active) return;
        if (docs.length === 0 && llmSettings.enabled === false && !dismissedRow) {
          setOnboardingOpen(true);
        }
      } catch {
        // Non-fatal: silently skip if storage is unavailable
      }
    }
    checkOnboarding();
    return () => {
      active = false;
    };
  }, []);

  async function handleOnboardingClose() {
    try {
      await getStorage().settings.put({ key: 'onboarding-dismissed', value: true, updatedAt: new Date().toISOString() });
    } catch {
      // Non-fatal
    }
    setOnboardingOpen(false);
  }

  function handleExport() {
    setExportDialogOpen(true);
  }

  async function handleEncryptedExport() {
    if (exportPassphrase.length < 8) {
      setVaultMessage('Use at least 8 characters for encrypted exports.');
      return;
    }
    if (exportPassphrase !== exportPassphraseConfirm) {
      setVaultMessage('Passphrases do not match.');
      return;
    }
    setExportBusy(true);
    try {
      const payload = await exportVaultData({
        encryption: { passphrase: exportPassphrase },
        ...(includeSourceExport ? { includeSourceVault: true } : {}),
      });
      downloadJson(payload, backupFilename('studyvault-encrypted'));
      setVaultMessage(
        includeSourceExport
          ? 'Encrypted local vault export created with explicitly included private source vault data.'
          : 'Encrypted local vault export created without private source vault data.',
      );
      setExportDialogOpen(false);
      setExportPassphrase('');
      setExportPassphraseConfirm('');
      setIncludeSourceExport(false);
    } finally {
      setExportBusy(false);
    }
  }

  async function handleImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const { payload, sizeBytes, parsedInWorker } = await parseJsonFile(file);
      const encrypted = (payload as { encryption?: { encrypted?: boolean } })?.encryption?.encrypted === true;
      const preview = encrypted
        ? null
        : await previewVaultImportPayload(payload, {
            mode: importMode,
            conflictPolicy: importMode === 'replace' ? 'replace' : conflictPolicy,
            includeSourceVault: includeSourceImport,
          });
      if (preview && !preview.valid) throw new Error(preview.errors.join(' '));
      setPendingImport({ payload, encrypted, preview, fileName: file.name, sizeBytes, parsedInWorker });
    } catch (error) {
      setVaultMessage(error instanceof Error ? error.message : 'Import failed.');
    } finally {
      event.target.value = '';
    }
  }

  async function refreshImportPreview(nextOptions: RefreshImportPreviewOptions = {}): Promise<VaultImportPreview | null> {
    if (!pendingImport) return null;
    const nextMode = nextOptions.mode || importMode;
    const nextConflictPolicy: ConflictPolicy =
      nextMode === 'replace' ? 'replace' : nextOptions.conflictPolicy || conflictPolicy;
    const nextIncludeSourceVault = nextOptions.includeSourceVault ?? includeSourceImport;
    setImportBusy(true);
    try {
      const preview = await previewVaultImportPayload(pendingImport.payload, {
        mode: nextMode,
        passphrase: pendingImport.encrypted ? importPassphrase : undefined,
        conflictPolicy: nextConflictPolicy,
        includeSourceVault: nextIncludeSourceVault,
      });
      setPendingImport((current) => (current ? { ...current, preview } : current));
      if (!preview.valid) setVaultMessage(preview.errors.join(' '));
      return preview;
    } finally {
      setImportBusy(false);
    }
  }

  async function handleReset(scope: ResetScope) {
    const labels: Record<ResetScope, string> = {
      attempts: 'quiz attempts and review schedule',
      progress: 'module progress, attempts, review schedule, mastery, artifacts, and study sessions',
      full: 'all local StudyVault data',
    };
    setPendingReset({ scope, label: labels[scope] });
  }

  async function confirmImport() {
    if (!pendingImport) return;
    try {
      const preview = pendingImport.preview?.valid ? pendingImport.preview : await refreshImportPreview();
      if (!preview?.valid) return;
      await importVaultData(pendingImport.payload, {
        mode: importMode,
        passphrase: pendingImport.encrypted ? importPassphrase : undefined,
        conflictPolicy: importMode === 'replace' ? 'replace' : conflictPolicy,
        includeSourceVault: includeSourceImport,
      });
      setVaultMessage(
        pendingImport.encrypted
          ? `Encrypted vault export imported with ${formatCount(preview.totalRows)} local row(s).`
          : `Imported ${formatCount(preview.totalRows)} progress, note, bookmark, and review row(s).`,
      );
      setPendingImport(null);
      setImportPassphrase('');
      setIncludeSourceImport(false);
    } catch (error) {
      setVaultMessage(error instanceof Error ? error.message : 'Import failed.');
    }
  }

  async function confirmReset() {
    if (!pendingReset) return;
    await resetVaultData(pendingReset.scope);
    setVaultMessage(`Reset ${pendingReset.label}.`);
    setPendingReset(null);
  }

  return (
    <div className="page-container progress-page">
      <OnboardingWizard open={onboardingOpen} onClose={handleOnboardingClose} />
      <PageHeader
        tone="analytics"
        badge="PERFORMANCE"
        title="Progress"
        subtitle="A focused view of readiness, learning momentum, and what is changing over time."
        actions={
          <Link to="/analytics" className="btn btn-secondary"><BarChart3 size={16} /> Detailed analytics</Link>
        }
      />

      <input ref={importRef} type="file" accept="application/json,.json" onChange={handleImport} style={{ display: 'none' }} />

      {(pendingImport || pendingReset) && (
        <Dialog
          title={pendingImport ? 'Import Local Vault Data' : 'Reset Local Vault Data'}
          description={
            pendingImport
              ? pendingImport.encrypted
                ? 'Decrypt this StudyVault export, review the contents, then choose how to write it into this browser profile.'
                : 'Review this StudyVault export before writing it into this browser profile.'
              : `Reset ${pendingReset?.label} on this device? This changes only local browser data.`
          }
          onClose={() => { setPendingImport(null); setPendingReset(null); setImportPassphrase(''); }}
          actions={
            <>
              <button className="btn btn-secondary" onClick={() => { setPendingImport(null); setPendingReset(null); setImportPassphrase(''); }}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={pendingImport ? confirmImport : confirmReset}
                disabled={importBusy || (pendingImport != null && (!pendingImport.preview?.valid || (pendingImport.encrypted && !importPassphrase)))}
              >
                {pendingImport ? 'Import Data' : 'Reset Data'}
              </button>
            </>
          }
        >
          {pendingImport && (
            <div className="backup-dialog-flow">
              <div className="backup-summary-grid" aria-live="polite">
                <div>
                  <strong>{pendingImport.fileName}</strong>
                  <small>{formatCount(pendingImport.sizeBytes)} bytes{pendingImport.parsedInWorker ? ' · parsed off main thread' : ''}</small>
                </div>
                <div>
                  <strong>{pendingImport.preview ? formatCount(pendingImport.preview.totalRows) : 'Locked'}</strong>
                  <small>local vault rows</small>
                </div>
                <div>
                  <strong>{pendingImport.preview?.checksumValid ? 'Verified' : pendingImport.preview ? 'Needs attention' : 'Encrypted'}</strong>
                  <small>backup health</small>
                </div>
              </div>

              {pendingImport.encrypted && (
                <div className="backup-passphrase-row">
                  <label className="calc-field">
                    <span>Export passphrase</span>
                    <input
                      type="password"
                      value={importPassphrase}
                      onChange={(event) => {
                        setImportPassphrase(event.target.value);
                        setPendingImport((current) => (current ? { ...current, preview: null } : current));
                      }}
                      autoFocus
                    />
                  </label>
                  <button className="btn btn-secondary" onClick={() => refreshImportPreview()} disabled={!importPassphrase || importBusy}>
                    Preview Decrypted Import
                  </button>
                </div>
              )}

              <SegmentedControl
                label="Import mode"
                options={importModeOptions}
                value={importMode}
                onChange={(value) => {
                  const next = value as ImportMode;
                  setImportMode(next);
                  refreshImportPreview({ mode: next });
                }}
              />
              {importMode === 'merge' && (
                <SegmentedControl
                  label="Conflict policy"
                  options={conflictPolicyOptions}
                  value={conflictPolicy}
                  onChange={(value) => {
                    const next = value as ConflictPolicy;
                    setConflictPolicy(next);
                    refreshImportPreview({ conflictPolicy: next });
                  }}
                />
              )}

              {pendingImport.preview?.sourceAvailable && (
                <label className="backup-checkbox">
                  <input
                    type="checkbox"
                    checked={includeSourceImport}
                    onChange={(event) => {
                      setIncludeSourceImport(event.target.checked);
                      refreshImportPreview({ includeSourceVault: event.target.checked });
                    }}
                  />
                  <span>Explicitly import private CFA Source Vault text from this backup</span>
                </label>
              )}

              {pendingImport.preview && (
                <div className={`backup-health-message ${pendingImport.preview.valid ? 'backup-health-ok' : 'backup-health-danger'}`} role="status">
                  {pendingImport.preview.valid
                    ? `${formatBackupDate(pendingImport.preview.exportedAt)} · ${
                        importMode === 'replace'
                          ? 'Replace mode will clear current local vault rows before import.'
                          : pendingImport.preview.conflicts.total
                            ? `${formatCount(pendingImport.preview.conflicts.total)} existing row conflict(s) will ${conflictPolicy === 'keep-existing' ? 'be kept locally' : 'use the imported value'}.`
                            : 'No keyed merge conflicts detected.'
                      }${pendingImport.preview.sourceAvailable && !includeSourceImport ? ' Private source text is available but will be skipped.' : ''}`
                    : pendingImport.preview.errors.join(' ')}
                </div>
              )}
            </div>
          )}
        </Dialog>
      )}

      {exportDialogOpen && (
        <Dialog
          title="Create Encrypted Backup"
          description="Choose a passphrase for an AES-GCM StudyVault export. Private CFA Source Vault text stays excluded unless you explicitly include it."
          onClose={() => { setExportDialogOpen(false); setExportPassphrase(''); setExportPassphraseConfirm(''); setIncludeSourceExport(false); }}
          actions={
            <>
              <button className="btn btn-secondary" onClick={() => { setExportDialogOpen(false); setExportPassphrase(''); setExportPassphraseConfirm(''); setIncludeSourceExport(false); }}>Cancel</button>
              <button className="btn btn-primary" onClick={handleEncryptedExport} disabled={exportBusy || exportPassphrase.length < 8 || exportPassphrase !== exportPassphraseConfirm} aria-busy={exportBusy || undefined}>
                {exportBusy ? 'Creating…' : 'Create Backup'}
              </button>
            </>
          }
        >
          <div className="backup-dialog-flow">
            <label className="calc-field">
              <span>Passphrase</span>
              <input type="password" value={exportPassphrase} onChange={(event) => setExportPassphrase(event.target.value)} autoFocus />
            </label>
            <label className="calc-field">
              <span>Confirm passphrase</span>
              <input type="password" value={exportPassphraseConfirm} onChange={(event) => setExportPassphraseConfirm(event.target.value)} />
            </label>
            <label className="backup-checkbox">
              <input type="checkbox" checked={includeSourceExport} onChange={(event) => setIncludeSourceExport(event.target.checked)} />
              <span>Explicitly include private CFA Source Vault text in this encrypted backup</span>
            </label>
            <div className="backup-health-message" role="status">
              {includeSourceExport
                ? 'This backup may contain private source text and should stay in your local encrypted storage.'
                : 'Standard privacy mode: private source text will be excluded.'}
            </div>
          </div>
        </Dialog>
      )}

      {!summary.indexedDbAvailable && (
        <Surface status="danger" density="compact" className="progress-storage-alert">
          <InlineCluster>
            <ShieldAlert size={20} color="var(--danger)" aria-hidden="true" />
            <div>
              <div className="panel-emphasis">Progress cannot be saved</div>
              <div className="muted-copy">Enable browser storage before continuing your study session.</div>
            </div>
          </InlineCluster>
        </Surface>
      )}

      <section className={`progress-readiness progress-readiness--${readinessStatus}`} aria-labelledby="progress-readiness-title">
        <div>
          <StatusBadge tone={readinessStatus === 'green' ? 'positive' : readinessStatus === 'red' ? 'danger' : 'analytics'}>
            {readinessStatus === 'unknown' ? 'Baseline pending' : `${readinessStatus} readiness`}
          </StatusBadge>
          <h2 id="progress-readiness-title">Your readiness, without the noise.</h2>
          <p>{readinessNarrative}</p>
        </div>
        <Link to={hasReadinessEvidence ? '/review' : '/'} className="btn btn-primary">
          {hasReadinessEvidence ? 'Review weak areas' : 'Start a study session'}
        </Link>
      </section>

      <PageSection title="Core signals" subtitle="The three measures that best summarize current momentum.">
        <div className="progress-summary-grid">
          <Panel tone="analytics" density="compact">
            <StatCell label="Mastery" value={summary.masteryScore === null ? '—' : `${summary.masteryScore}%`} detail="Current readiness snapshot" />
          </Panel>
          <Panel tone="analytics" density="compact">
            <StatCell label="Questions answered" value={summary.questionsAnswered.toLocaleString()} detail={`${summary.streakDays} day study streak`} />
          </Panel>
          <Panel tone="analytics" density="compact">
            <StatCell label="Study time" value={formatStudyTime(summary.studyTimeSeconds)} detail={`${summary.completedModules} modules completed`} />
          </Panel>
        </div>
      </PageSection>

      {metrics && hasReadinessEvidence && metrics.curves.length > 0 && (
        <PageSection title="Learning curves" subtitle="Direction and pace by domain.">
          <DashboardSparklineGrid curves={metrics.curves} className="progress-learning-curves" />
        </PageSection>
      )}

      <section className="progress-disclosures" aria-label="Progress details">
        <details>
          <summary>
            <span><strong>Readiness details</strong><small>Signals, weak areas, and review priorities</small></span>
          </summary>
          <div className="progress-disclosure-body grid-2">
            {readinessChecks.length > 0 ? (
              <DashboardReadinessChecklist checks={readinessChecks} />
            ) : (
              <Surface density="compact"><p className="muted-copy">No readiness evidence yet.</p></Surface>
            )}
            <WeaknessIndexCard options={{ domain: 'all', days: 30, limit: 8 }} maxRows={5} />
            <div style={{ gridColumn: '1 / -1' }}>
              <CrossDomainProgressReport />
            </div>
          </div>
        </details>

        <details>
          <summary>
            <span><strong>Local data and vault</strong></span>
          </summary>
          <div className="progress-disclosure-body">
            <Surface density="compact" className="vault-strip">
              <InlineCluster>
                <InlineCluster><StickyNote size={16} color="var(--accent)" /><span>{summary.notesCount} notes</span></InlineCluster>
                <InlineCluster><Bookmark size={16} color="var(--accent)" /><span>{summary.bookmarksCount} bookmarks</span></InlineCluster>
                {vaultMessage && <span className="muted-copy" role="status">{vaultMessage}</span>}
              </InlineCluster>
              <InlineCluster>
                <button className="btn btn-secondary" onClick={handleExport}><Lock size={16} /> Export backup</button>
                <button className="btn btn-secondary" onClick={() => importRef.current?.click()}><Upload size={16} /> Import</button>
              </InlineCluster>
            </Surface>
            <div className="progress-reset-controls">
              <span>Reset local data</span>
              <InlineCluster>
                <button className="btn btn-ghost" onClick={() => handleReset('attempts')}><Trash2 size={16} /> Attempts</button>
                <button className="btn btn-ghost" onClick={() => handleReset('progress')}><Trash2 size={16} /> Progress</button>
                <button className="btn btn-ghost" onClick={() => handleReset('full')}><Trash2 size={16} /> Full reset</button>
              </InlineCluster>
            </div>
          </div>
        </details>
      </section>
    </div>
  );
}
