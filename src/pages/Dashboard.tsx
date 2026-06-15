import { useEffect, useRef, useState, type ChangeEvent, type ComponentType, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  GraduationCap, BrainCircuit, Table2, Calculator,
  Target, BookOpen, ChevronRight,
  Download, Upload, Trash2, CalendarClock,
  Bookmark, StickyNote, ShieldAlert, Inbox, BadgeCheck, ClipboardList, BarChart3, Lock,
} from 'lucide-react';
import { domains } from '../data/catalog';
import { navigateDomain } from '../lib/domainNav';
import { useProgressSummary } from '../hooks/useProgress';
import { exportVaultData, importVaultData, previewVaultImportPayload, resetVaultData } from '../lib/learning';
import type { VaultImportPreview } from '../lib/learning';
import { parseJsonFile } from '../lib/jsonFilePreflight';
import { getCfaSourceDocuments } from '../lib/cfaSourceVault';
import { getLlmSettings } from '../lib/localLlm';
import { getStorage } from '../lib/storage';
import {
  IconFrame,
  Dialog,
  InlineCluster,
  PageHeader,
  PageSection,
  Panel,
  SegmentedControl,
  StatCell,
  StatGrid,
  StatusBadge,
  Surface,
} from '../components/ui/Primitives';
import { OnboardingWizard } from '../components/Onboarding';
import { Skeleton } from '../components/feedback';
import { DashboardKpiBand } from '../components/dashboard/DashboardKpiBand';
import { DashboardHero } from '../components/dashboard/DashboardHero';
import { useScrollRestoration } from '../lib/scrollRestore';

type LucideIcon = ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;

const domainIcons: Record<string, LucideIcon> = {
  cfa: GraduationCap,
  quant: BrainCircuit,
  excel: Table2,
};

interface QuickTool {
  title: string;
  icon: LucideIcon;
  path: string;
  desc: string;
}

const quickTools: QuickTool[] = [
  { title: 'Today', icon: CalendarClock, path: '/today', desc: 'One screen, one decision — what to study now' },
  { title: 'Review Inbox', icon: Inbox, path: '/review', desc: 'Due work and weak areas' },
  { title: 'Analytics', icon: BarChart3, path: '/analytics', desc: 'Readiness and trends' },
  { title: 'Flashcards', icon: BadgeCheck, path: '/flashcards', desc: 'Formula and objective drills' },
  { title: 'Mock Exam', icon: ClipboardList, path: '/cfa/mock', desc: 'Mixed CFA section' },
  { title: 'TVM Calculator', icon: Calculator, path: '/calculators', desc: 'Time Value of Money' },
  { title: 'Formula Library', icon: BookOpen, path: '/formulas', desc: 'Searchable reference' },
  { title: 'Quick Quiz', icon: Target, path: '/cfa/level1/ethics/quiz', desc: 'Test your knowledge' },
];

type DomainEntry = (typeof domains)[number];

interface DomainCardProps {
  domain: DomainEntry;
  index: number;
}

function DomainCard({ domain, index }: DomainCardProps) {
  const Icon = domainIcons[domain.id] || BookOpen;
  const tone =
    domain.id === 'cfa' ? 'exam' : domain.id === 'quant' ? 'quant' : domain.id === 'lsat' ? 'study' : 'excel';

  // `external` domains (the LSAT sub-app) live under their own router, not the
  // host client router. The anchor keeps a real href (so modifier/middle-click
  // and a11y work), but a plain left-click soft-swaps domains via the unified
  // StudyVault root (no full page reload). (Plan S6.)
  const linkProps = domain.external
    ? {
        as: 'a' as const,
        href: domain.path,
        onClick: (e: MouseEvent) => {
          if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
            return;
          }
          e.preventDefault();
          navigateDomain(domain.path);
        },
      }
    : { as: Link, to: domain.path };

  return (
    <Panel
      {...linkProps}
      tone={domain.id}
      status={tone}
      interactive
      className="domain-cockpit-card animate-fade"
      style={{ animationDelay: `${index * 80}ms` }}
      footer={
        <InlineCluster className={`domain-card-link domain-card-link-${tone}`}>
          Start Learning <ChevronRight size={16} />
        </InlineCluster>
      }
    >
      <div className="domain-card-head">
        <IconFrame icon={Icon} tone={tone} size={24} />
        <StatusBadge tone={tone}>{domain.badge}</StatusBadge>
      </div>
      <div className="domain-card-copy">
        <h3>{domain.title}</h3>
        <small>{domain.subtitle}</small>
        <p>{domain.description}</p>
      </div>
      <StatGrid columns={3}>
        {Object.entries(domain.stats).map(([key, val]) => (
          <StatCell key={key} tone={tone} label={key} value={val} />
        ))}
      </StatGrid>
    </Panel>
  );
}

function formatStudyTime(seconds: number): string {
  if (!seconds) return '0m';
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function downloadJson(payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `studyvault-export-${new Date().toISOString().slice(0, 10)}.json`;
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
  const [sourceDocCount, setSourceDocCount] = useState<number | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState(false);

  // UX-1: restore the document scroll position on return to the dashboard,
  // including after a cross-domain soft-hop (which bypasses native scroll
  // restoration). The dashboard renders its full structure on first paint
  // (the progress summary fills in from a stable empty shape), so restoration
  // is enabled immediately.
  useScrollRestoration('host:/');

  useEffect(() => {
    let active = true;
    getCfaSourceDocuments()
      .then((docs) => {
        if (active) setSourceDocCount(docs.length);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

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

  async function handleExport() {
    const payload = await exportVaultData();
    downloadJson(payload);
    setVaultMessage('Local vault exported as JSON.');
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
      downloadJson(payload);
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
    <div className="page-container">
      <OnboardingWizard open={onboardingOpen} onClose={handleOnboardingClose} />
      <PageHeader
        tone="study"
        badge="LOCAL STUDY COMMAND"
        title="StudyVault"
        subtitle="CFA, quantitative finance, and Excel practice organized around today’s next action, local vault safety, and exam readiness."
        meta={
          <>
            <StatusBadge tone="exam">Exam cockpit</StatusBadge>
            <StatusBadge tone="vault">Browser-local</StatusBadge>
          </>
        }
        actions={
          <>
            <button className="btn btn-secondary" onClick={handleExport}><Download size={16} /> Export</button>
            <button className="btn btn-secondary" onClick={() => setExportDialogOpen(true)}><Lock size={16} /> Encrypted Export</button>
            <button className="btn btn-primary" onClick={() => importRef.current?.click()}><Upload size={16} /> Import</button>
          </>
        }
      />

      <DashboardKpiBand
        streakDays={summary.streakDays}
        questionsAnswered={summary.questionsAnswered}
        studyTime={formatStudyTime(summary.studyTimeSeconds)}
        masteryScore={summary.masteryScore}
      />

      {/* UX-1: the "Get started" strip is conditional on an async source-doc
          count. Until that resolves (sourceDocCount === null) reserve its
          footprint with a fixed min-height skeleton so the strip appearing (or
          collapsing away) never shifts the domain cards below it (no CLS). */}
      {sourceDocCount === null ? (
        <Surface
          tone="study"
          status="accent"
          aria-busy="true"
          style={{ marginBottom: 'var(--space-6)', minHeight: '7.5rem' }}
        >
          <Skeleton variant="text-short" />
          <Skeleton variant="text-medium" style={{ marginTop: 'var(--space-3)' }} />
          <Skeleton variant="text" style={{ marginTop: 'var(--space-2)' }} />
        </Surface>
      ) : sourceDocCount === 0 ? (
        <Surface tone="study" status="accent" style={{ marginBottom: 'var(--space-6)', minHeight: '7.5rem' }}>
          <div className="flex-between qv-row-3">
            <div>
              <StatusBadge tone="accent">Get started</StatusBadge>
              <h3 style={{ margin: 'var(--space-1) 0 0' }}>Bring your own curriculum into the vault</h3>
              <p className="muted-copy" style={{ margin: 'var(--space-1) 0 0' }}>
                StudyVault's grounded answers and curriculum reader light up once you have source documents in the local vault. Import a <code>.qvsource</code> bundle, paste raw text, or — in the desktop shell — pick a folder of CFA PDFs directly.
              </p>
            </div>
            <Link to="/system" className="btn btn-primary">Open System Health</Link>
          </div>
        </Surface>
      ) : null}

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
              <button className="btn btn-primary" onClick={handleEncryptedExport} disabled={exportBusy || exportPassphrase.length < 8 || exportPassphrase !== exportPassphraseConfirm}>
                Create Backup
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

      {/* Today */}
      <PageSection
        title="Today"
        subtitle="Adaptive local recommendations from your review queue and mastery snapshots"
        actions={
          <>
            <button className="btn btn-secondary" onClick={handleExport}><Download size={16} /> Export</button>
            <button className="btn btn-secondary" onClick={() => setExportDialogOpen(true)}><Lock size={16} /> Encrypted Export</button>
            <button className="btn btn-secondary" onClick={() => importRef.current?.click()}><Upload size={16} /> Import</button>
            <input ref={importRef} type="file" accept="application/json,.json" onChange={handleImport} style={{ display: 'none' }} />
          </>
        }
      >

        {!summary.indexedDbAvailable && (
          <Surface status="danger" density="compact">
            <InlineCluster>
              <ShieldAlert size={20} color="var(--danger)" aria-hidden="true" />
              <div>
                <div className="panel-emphasis">IndexedDB is unavailable</div>
                <div className="muted-copy">
                  Local progress cannot be saved until browser storage is enabled.
                </div>
              </div>
            </InlineCluster>
          </Surface>
        )}

        <DashboardHero
          recommendation={summary.todayRecommendation}
          dueReviews={summary.dueReviews}
          weakObjectives={summary.weakObjectives}
        />

        <Surface density="compact" className="vault-strip">
          <InlineCluster>
            <InlineCluster>
              <StickyNote size={16} color="var(--accent)" />
              <span>{summary.notesCount} notes</span>
            </InlineCluster>
            <InlineCluster>
              <Bookmark size={16} color="var(--accent)" />
              <span>{summary.bookmarksCount} bookmarks</span>
            </InlineCluster>
            {vaultMessage && <span className="muted-copy">{vaultMessage}</span>}
          </InlineCluster>
          <InlineCluster>
            <button className="btn btn-secondary" onClick={() => handleReset('attempts')}><Trash2 size={16} /> Attempts</button>
            <button className="btn btn-secondary" onClick={() => handleReset('progress')}><Trash2 size={16} /> Progress</button>
            <button className="btn btn-secondary" onClick={() => handleReset('full')}><Trash2 size={16} /> Full Reset</button>
          </InlineCluster>
        </Surface>
      </PageSection>

      {/* Domain Cards */}
      <PageSection title="Knowledge Domains" subtitle="Choose a domain to begin your study journey">
        <div className="grid-3">
          {domains.map((d, i) => <DomainCard key={d.path} domain={d} index={i} />)}
        </div>
      </PageSection>

      {/* Quick Tools */}
      <PageSection title="Quick Access" subtitle="Jump into tools and practice">
        <div className="grid-3">
          {quickTools.map((tool, i) => (
            <Panel
              as={Link}
              key={tool.path}
              to={tool.path}
              tone="study"
              interactive
              className="quick-tool-card animate-fade"
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <IconFrame icon={tool.icon} />
              <div>
                <div className="qv-fw-semibold">{tool.title}</div>
                <div className="qv-fs-xs qv-text-muted">{tool.desc}</div>
              </div>
              <ChevronRight size={16} color="var(--text-muted)" style={{ marginLeft: 'auto' }} />
            </Panel>
          ))}
        </div>
      </PageSection>

      <PageSection title="Learning Momentum" subtitle="Your local progress is saved on this device">
        <div className="grid-3">
          <Panel tone="analytics" density="compact">
            <StatCell label="Modules Completed" value={summary.completedModules} detail={`${summary.visitedModules} visited`} />
          </Panel>
          <Panel tone="analytics" density="compact">
            <StatCell label="Recent Activity" value={summary.lastActivity || 'No activity yet'} detail="Open a module or quiz to start the trail" />
          </Panel>
          <Panel tone="analytics" density="compact">
            <StatCell label="Review Queue" value={summary.upcomingReviews.length} detail="Weak areas from recent quizzes" />
          </Panel>
        </div>
      </PageSection>
    </div>
  );
}
