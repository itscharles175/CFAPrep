import { useEffect, useRef, useState } from 'react';
import { Database, Download, HardDrive, KeyRound, ShieldCheck, WifiOff, Wrench } from 'lucide-react';
import { PageHeader, MetricCard, StatusBadge, Surface } from '../components/ui/Primitives';
import { exportVaultData, getVaultHealthReport, previewVaultRepair } from '../lib/learning';
import { cacheCriticalOfflineRoutes, getOfflineReadinessReport } from '../lib/offlineContentCache';
import { checkLlmConnection, getLlmSettings, LLM_PRESETS, saveLlmSettings } from '../lib/localLlm';
import {
  checkOpenNotebookConnection,
  deleteNotebook as deleteOnbNotebook,
  getOpenNotebookSettings,
  listNotebooks as listOnbNotebooks,
  saveOpenNotebookSettings,
} from '../lib/openNotebook';
import { ingestFolder, ingestPdfPaths, ingestTextSource, isTauri, onTauriPdfDrop, pickCfaFolder } from '../lib/desktopIngestion';
import { useToast } from '../context/ToastContext';
import { deleteCfaSourceDocument, exportCfaSourceBundle, getCfaSourceDocuments, importCfaSourceBundle } from '../lib/cfaSourceVault';
import { getStorage } from '../lib/storage';

// Cache-management constants — used by refreshCacheBuckets / handleClearBucket.
const CACHE_PREFIXES = {
  'ai-questions': 'ai-questions:',
  'generated-mock': 'generated-mock:',
  'open-notebook:answer': 'open-notebook:answer:',
  'open-notebook:topic-notebooks': 'open-notebook:topic-notebooks',
};
const SKIP_KEYS = new Set(['local-llm', 'open-notebook', 'onboarding-dismissed']);

function downloadJson(payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `quantvault-backup-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function SystemHealth() {
  const toast = useToast();
  const [storage, setStorage] = useState(null);
  const [cacheNames, setCacheNames] = useState([]);
  const [message, setMessage] = useState('');
  const [backupPassphrase, setBackupPassphrase] = useState('');
  const [vaultHealth, setVaultHealth] = useState(null);
  const [offlineReadiness, setOfflineReadiness] = useState(null);
  const [persisted, setPersisted] = useState(null);
  const [llm, setLlm] = useState(null);
  const [llmStatus, setLlmStatus] = useState(null);
  const [llmTesting, setLlmTesting] = useState(false);
  const [onb, setOnb] = useState(null);
  const [onbStatus, setOnbStatus] = useState(null);
  const [onbTesting, setOnbTesting] = useState(false);
  const desktopAvailable = isTauri();
  const [ingestState, setIngestState] = useState('idle'); // idle | picking | running | done | error | cancelled
  const [ingestProgress, setIngestProgress] = useState(null);
  const [ingestResult, setIngestResult] = useState(null);
  const [ingestError, setIngestError] = useState('');
  const ingestAbortRef = useRef(null);
  const [sourceDocs, setSourceDocs] = useState([]);
  const [sourceDocsBusy, setSourceDocsBusy] = useState(false);
  const [onbNotebooks, setOnbNotebooks] = useState([]);
  const [onbNotebooksBusy, setOnbNotebooksBusy] = useState(false);
  const [cacheBuckets, setCacheBuckets] = useState(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [examDate, setExamDate] = useState('');
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteTopic, setPasteTopic] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteError, setPasteError] = useState('');
  const serviceWorkerReady = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  const cacheReady = typeof caches !== 'undefined';

  useEffect(() => {
    let active = true;
    Promise.all([
      navigator.storage?.estimate?.() || Promise.resolve(null),
      cacheReady ? caches.keys() : Promise.resolve([]),
      navigator.storage?.persisted?.() || Promise.resolve(null),
    ]).then(([estimate, names, nextPersisted]) => {
      if (!active) return;
      setStorage(estimate);
      setCacheNames(names);
      setPersisted(nextPersisted);
    });
    return () => {
      active = false;
    };
  }, [cacheReady]);

  useEffect(() => {
    let active = true;
    getVaultHealthReport()
      .then((report) => {
        if (active) setVaultHealth(report);
      })
      .catch(() => undefined);
    getOfflineReadinessReport()
      .then((report) => {
        if (active) setOfflineReadiness(report);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    getLlmSettings().then((settings) => {
      if (active) setLlm(settings);
    });
    getOpenNotebookSettings().then((settings) => {
      if (active) setOnb(settings);
    });
    refreshSourceDocs();
    return () => {
      active = false;
    };
  }, []);

  // Auto-load embedded-notebook list once we know the backend is enabled.
  useEffect(() => {
    if (onb?.enabled) refreshOnbNotebooks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onb?.enabled, onb?.baseUrl]);

  // Load cache buckets + exam date on mount.
  useEffect(() => {
    let active = true;
    refreshCacheBuckets();
    getStorage().settings.get('exam-date').then((row) => {
      if (active && row?.value) setExamDate(row.value);
    });
    return () => {
      active = false;
    };
  }, []);

  async function handleSaveExamDate() {
    if (examDate) {
      await getStorage().settings.put({ key: 'exam-date', value: examDate, updatedAt: new Date().toISOString() });
      setMessage(`Exam date set to ${examDate}.`);
      toast.success('Exam date saved', 'Countdown will appear on /today.');
    } else {
      await getStorage().settings.delete('exam-date');
      setMessage('Exam date cleared.');
    }
  }

  async function refreshSourceDocs() {
    setSourceDocsBusy(true);
    try {
      const docs = await getCfaSourceDocuments();
      setSourceDocs(docs);
    } finally {
      setSourceDocsBusy(false);
    }
  }

  async function handleImportSourceBundle(file) {
    if (!file) return;
    setSourceDocsBusy(true);
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const result = await importCfaSourceBundle(payload, { mode: 'merge' });
      await refreshSourceDocs();
      const summary = `Imported ${result.documents ?? 0} document(s) and ${result.chunks ?? 0} chunk(s) from ${file.name}.`;
      setMessage(summary);
      toast.success('Source bundle imported', summary);
    } catch (error) {
      const detail = error instanceof Error ? `Bundle import failed: ${error.message}` : 'Bundle import failed.';
      setMessage(detail);
      toast.error('Bundle import failed', detail);
    } finally {
      setSourceDocsBusy(false);
    }
  }

  async function handleExportSourceBundle() {
    setSourceDocsBusy(true);
    try {
      const bundle = await exportCfaSourceBundle();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `quantvault-source-${new Date().toISOString().slice(0, 10)}.qvsource`;
      anchor.click();
      URL.revokeObjectURL(url);
      const summary = `Exported ${bundle.documents?.length ?? 0} source document(s) as a .qvsource bundle.`;
      setMessage(summary);
      toast.success('Source vault exported', summary);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Could not export source bundle.';
      setMessage(detail);
      toast.error('Export failed', detail);
    } finally {
      setSourceDocsBusy(false);
    }
  }

  async function handleDeleteSourceDoc(documentId) {
    if (!documentId) return;
    setSourceDocsBusy(true);
    try {
      await deleteCfaSourceDocument(documentId);
      await refreshSourceDocs();
      setMessage('Source document removed from the local vault.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not delete the source document.');
      setSourceDocsBusy(false);
    }
  }

  async function refreshOnbNotebooks() {
    if (!onb?.enabled) {
      setOnbNotebooks([]);
      return;
    }
    setOnbNotebooksBusy(true);
    try {
      const notebooks = await listOnbNotebooks({ baseUrl: onb.baseUrl });
      setOnbNotebooks(notebooks);
    } catch {
      setOnbNotebooks([]);
    } finally {
      setOnbNotebooksBusy(false);
    }
  }

  async function handleIngestPastedText() {
    setPasteError('');
    setPasteBusy(true);
    try {
      const title = pasteTitle.trim() || 'Pasted source';
      const topicIds = pasteTopic.trim() ? [pasteTopic.trim()] : [];
      const result = await ingestTextSource({ title, text: pasteText, topicIds });
      await refreshSourceDocs();
      const summary = result.deduped
        ? `Same text was already ingested as ${result.documentId}.`
        : `Pasted "${title}" ingested (${result.chunkCount} chunks).`;
      setMessage(summary);
      toast[result.deduped ? 'info' : 'success']('Text source', summary);
      setPasteText('');
      setPasteTitle('');
      setPasteTopic('');
    } catch (error) {
      setPasteError(error instanceof Error ? error.message : 'Could not ingest pasted text.');
    } finally {
      setPasteBusy(false);
    }
  }

  async function handleDeleteOnbNotebook(notebookId) {
    if (!notebookId || !onb?.baseUrl) return;
    setOnbNotebooksBusy(true);
    try {
      await deleteOnbNotebook(onb.baseUrl, notebookId);
      await refreshOnbNotebooks();
      setMessage('Notebook removed from the embedded backend.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not delete the notebook.');
      setOnbNotebooksBusy(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Cache-bucket helpers
  // ---------------------------------------------------------------------------
  async function refreshCacheBuckets() {
    const rows = await getStorage().settings.toArray();
    const counts = {
      'ai-questions': 0,
      'generated-mock': 0,
      'open-notebook:answer': 0,
      'open-notebook:topic-notebooks': 0,
      other: 0,
    };
    for (const row of rows) {
      const { key } = row;
      if (SKIP_KEYS.has(key)) continue;
      if (key.startsWith(CACHE_PREFIXES['ai-questions'])) {
        counts['ai-questions'] += 1;
      } else if (key.startsWith(CACHE_PREFIXES['generated-mock'])) {
        counts['generated-mock'] += 1;
      } else if (key.startsWith(CACHE_PREFIXES['open-notebook:answer'])) {
        counts['open-notebook:answer'] += 1;
      } else if (key === CACHE_PREFIXES['open-notebook:topic-notebooks']) {
        counts['open-notebook:topic-notebooks'] += 1;
      } else {
        counts.other += 1;
      }
    }
    setCacheBuckets(counts);
  }

  async function handleClearBucket(bucket) {
    setCacheBusy(true);
    try {
      const rows = await getStorage().settings.toArray();
      const keysToDelete = [];
      for (const row of rows) {
        const { key } = row;
        if (SKIP_KEYS.has(key)) continue;
        if (bucket === 'other') {
          const isCacheBucket = Object.values(CACHE_PREFIXES).some((prefix) =>
            key === prefix || key.startsWith(prefix),
          );
          if (!isCacheBucket) keysToDelete.push(key);
        } else if (bucket === 'open-notebook:topic-notebooks') {
          if (key === CACHE_PREFIXES['open-notebook:topic-notebooks']) keysToDelete.push(key);
        } else {
          const prefix = CACHE_PREFIXES[bucket];
          if (prefix && key.startsWith(prefix)) keysToDelete.push(key);
        }
      }
      await getStorage().settings.bulkDelete(keysToDelete);
      await refreshCacheBuckets();
      const msg = `Cleared ${keysToDelete.length} row(s) from the "${bucket}" bucket.`;
      setMessage(msg);
      toast.success('Caches cleared', msg);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Could not clear cache bucket.';
      setMessage(detail);
      toast.error('Clear failed', detail);
    } finally {
      setCacheBusy(false);
    }
  }

  async function handleClearAllCaches() {
    setCacheBusy(true);
    try {
      const rows = await getStorage().settings.toArray();
      const keysToDelete = rows
        .map((row) => row.key)
        .filter((key) => !SKIP_KEYS.has(key));
      await getStorage().settings.bulkDelete(keysToDelete);
      await refreshCacheBuckets();
      const msg = `Cleared ${keysToDelete.length} cached row(s) from app caches.`;
      setMessage(msg);
      toast.success('Caches cleared', msg);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Could not clear app caches.';
      setMessage(detail);
      toast.error('Clear failed', detail);
    } finally {
      setCacheBusy(false);
    }
  }

  async function handleSaveLlm() {
    const saved = await saveLlmSettings(llm);
    setLlm(saved);
    setMessage('Local AI settings saved.');
  }

  async function handleTestLlm() {
    setLlmTesting(true);
    const result = await checkLlmConnection(llm);
    setLlmStatus(result);
    setLlmTesting(false);
  }

  async function handleIngestFolder() {
    setIngestError('');
    setIngestResult(null);
    setIngestProgress(null);
    const controller = new AbortController();
    ingestAbortRef.current = controller;
    try {
      setIngestState('picking');
      const folder = await pickCfaFolder();
      if (!folder) {
        setIngestState('idle');
        return;
      }
      setIngestState('running');
      const result = await ingestFolder({
        folder,
        signal: controller.signal,
        onProgress: (event) => setIngestProgress(event),
      });
      setIngestResult(result);
      setIngestState(controller.signal.aborted ? 'cancelled' : 'done');
      const summary = `Ingested ${result.ingested} new document(s) (${result.chunkCount} chunks). Skipped ${result.skipped} duplicate(s).`;
      setMessage(summary);
      if (!controller.signal.aborted) {
        toast.success('Folder ingested', summary);
      }
      await refreshSourceDocs();
    } catch (error) {
      if (controller.signal.aborted) {
        setIngestState('cancelled');
      } else {
        setIngestState('error');
        const detail = error instanceof Error ? error.message : 'Folder ingestion failed.';
        setIngestError(detail);
        toast.error('Folder ingestion failed', detail);
      }
    } finally {
      ingestAbortRef.current = null;
    }
  }

  function handleCancelIngest() {
    ingestAbortRef.current?.abort();
  }

  // Tauri OS drag-drop: PDFs dropped on the window auto-ingest via the same
  // pipeline as the folder picker, with the same progress UX.
  useEffect(() => {
    if (!desktopAvailable) return undefined;
    let active = true;
    let unlistenFn = () => undefined;
    onTauriPdfDrop(async (paths) => {
      if (!active) return;
      const controller = new AbortController();
      ingestAbortRef.current = controller;
      setIngestError('');
      setIngestResult(null);
      setIngestProgress(null);
      setIngestState('running');
      try {
        const result = await ingestPdfPaths({
          paths,
          signal: controller.signal,
          onProgress: (event) => setIngestProgress(event),
        });
        if (!active) return;
        setIngestResult(result);
        setIngestState(controller.signal.aborted ? 'cancelled' : 'done');
        setMessage(`Drag-dropped: ingested ${result.ingested}, skipped ${result.skipped}, ${result.chunkCount} chunks.`);
        await refreshSourceDocs();
      } catch (error) {
        if (!active) return;
        if (controller.signal.aborted) {
          setIngestState('cancelled');
        } else {
          setIngestState('error');
          setIngestError(error instanceof Error ? error.message : 'Drag-drop ingestion failed.');
        }
      } finally {
        ingestAbortRef.current = null;
      }
    }).then((u) => {
      if (!active) {
        u?.();
      } else {
        unlistenFn = u;
      }
    });
    return () => {
      active = false;
      unlistenFn?.();
    };
  }, [desktopAvailable]);

  async function handleSaveOnb() {
    const saved = await saveOpenNotebookSettings(onb);
    setOnb(saved);
    setMessage('Embedded notebook settings saved.');
  }

  async function handleTestOnb() {
    setOnbTesting(true);
    const result = await checkOpenNotebookConnection(onb);
    setOnbStatus(result);
    setOnbTesting(false);
  }

  async function handleEncryptedBackup() {
    if (!backupPassphrase.trim()) {
      setMessage('Enter a backup passphrase before exporting the encrypted vault.');
      return;
    }
    downloadJson(await exportVaultData({ encryption: { passphrase: backupPassphrase } }));
    setBackupPassphrase('');
    setMessage('Encrypted backup exported. Keep the passphrase separate from the backup file.');
  }

  async function handlePlaintextBackup() {
    downloadJson(await exportVaultData());
    setMessage('Plaintext backup exported from the advanced path. Prefer encrypted backups for normal vault moves.');
  }

  async function handleRepairPreview() {
    const report = await previewVaultRepair();
    setVaultHealth(report);
    setMessage(report.repairActions.length ? `Repair preview found ${report.repairActions.length} action(s).` : 'Repair preview found no required action.');
  }

  async function handlePersistStorage() {
    const granted = await navigator.storage?.persist?.();
    setPersisted(Boolean(granted));
    setMessage(granted ? 'Browser persistent storage requested successfully.' : 'Browser did not grant persistent storage yet.');
  }

  async function handleCacheCriticalRoutes() {
    const result = await cacheCriticalOfflineRoutes();
    const report = await getOfflineReadinessReport();
    setOfflineReadiness(report);
    setMessage(`Offline cache refreshed: ${result.cached} critical route(s) cached, ${result.failed} failed.`);
  }

  const usageMb = storage?.usage ? Math.round(storage.usage / 1024 / 1024) : 0;
  const quotaMb = storage?.quota ? Math.round(storage.quota / 1024 / 1024) : 0;
  const usagePct = quotaMb ? Math.round((usageMb / quotaMb) * 100) : 0;

  return (
    <div className="page-container">
      <PageHeader
        badge="SYSTEM HEALTH"
        title="Offline & Data Safety"
        subtitle="Inspect local storage, cache state, service-worker availability, and backup readiness."
        actions={
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              className="input"
              type="password"
              value={backupPassphrase}
              onChange={(event) => setBackupPassphrase(event.target.value)}
              placeholder="Backup passphrase"
              aria-label="Encrypted backup passphrase"
              style={{ minWidth: 190 }}
            />
            <button className="btn btn-primary" onClick={handleEncryptedBackup}><KeyRound size={16} /> Encrypted Backup</button>
          </div>
        }
      />

      <div className="grid-4 page-metrics">
        <MetricCard label="IndexedDB Storage" value={`${usageMb} MB`} detail={`${usagePct}% of estimated quota`} icon={Database} />
        <MetricCard label="Quota" value={`${quotaMb || '-'} MB`} detail="Browser estimate" icon={HardDrive} tone="warning" />
        <MetricCard label="Service Worker" value={serviceWorkerReady ? 'Ready' : 'Unavailable'} detail="Offline shell support" icon={ShieldCheck} tone={serviceWorkerReady ? 'success' : 'danger'} />
        <MetricCard label="Offline Routes" value={`${offlineReadiness?.cachedCount ?? 0}/${offlineReadiness?.totalCriticalRoutes ?? 0}`} detail="Critical local routes cached" icon={WifiOff} tone={offlineReadiness?.cachedCount === offlineReadiness?.totalCriticalRoutes ? 'success' : 'warning'} />
        <MetricCard label="Vault Safety" value={vaultHealth?.status || 'Checking'} detail={`${vaultHealth?.totalRows ?? 0} local rows`} icon={Database} tone={vaultHealth?.status === 'repair-needed' ? 'danger' : vaultHealth?.status === 'warning' ? 'warning' : 'success'} />
      </div>

      <Surface tone="vault" status={vaultHealth?.status === 'repair-needed' ? 'danger' : vaultHealth?.status === 'warning' ? 'warning' : 'success'} className="ops-report-panel">
        <div className="flex-between" style={{ gap: 'var(--space-4)', alignItems: 'flex-start' }}>
          <div>
            <StatusBadge tone="vault">Vault Safety</StatusBadge>
            <h3>Local Vault Health</h3>
            <p style={{ color: 'var(--text-secondary)' }}>
              Schema v{vaultHealth?.schemaVersion || '-'} · {vaultHealth?.schemaHash || 'checking'} · persistent storage {persisted === null ? 'unknown' : persisted ? 'granted' : 'not granted'}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={handleRepairPreview}><Wrench size={16} /> Repair Preview</button>
            <button className="btn btn-secondary" onClick={handlePersistStorage}>Persist Storage</button>
            <button className="btn btn-secondary" onClick={handlePlaintextBackup}><Download size={16} /> Plaintext Export</button>
          </div>
        </div>
        <div className="coverage-grid" style={{ marginTop: 'var(--space-4)' }}>
          <div><strong>{vaultHealth?.malformedRows ?? 0}</strong><small>Malformed rows</small></div>
          <div><strong>{vaultHealth?.orphanedReviews ?? 0}</strong><small>Orphaned reviews</small></div>
          <div><strong>{vaultHealth?.staleIndexes ?? 0}</strong><small>Stale indexes</small></div>
          <div><strong>{vaultHealth?.checksumIssues ?? 0}</strong><small>Checksum issues</small></div>
          <div><strong>{vaultHealth?.rollbackSnapshots?.length ?? 0}</strong><small>Rollback snapshots</small></div>
          <div><strong>{vaultHealth?.importJobs?.length ?? 0}</strong><small>Recent import jobs</small></div>
          <div><strong>{vaultHealth?.sourceBundleManifests?.length ?? 0}</strong><small>Source bundle manifests</small></div>
          <div><strong>{vaultHealth?.calculatorScenarios?.length ?? 0}</strong><small>Calculator scenarios</small></div>
        </div>
        {vaultHealth?.repairActions?.length > 0 && (
          <ul style={{ color: 'var(--text-secondary)', marginTop: 'var(--space-4)' }}>
            {vaultHealth.repairActions.map((action) => <li key={action}>{action}</li>)}
          </ul>
        )}
      </Surface>

      <Surface tone="ops" className="ops-report-panel">
        <div className="flex-between" style={{ gap: 'var(--space-3)', alignItems: 'center' }}>
          <div>
            <StatusBadge tone="exam">Browser Reminders</StatusBadge>
            <h3 style={{ margin: 'var(--space-2) 0 0' }}>Native review reminders</h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>
              Grant permission once and QuantVault will surface a desktop notification when you have reviews due. No network — fires from the local service worker.
            </p>
          </div>
          <button
            className="btn btn-secondary btn-sm"
            disabled={typeof Notification === 'undefined' || Notification.permission === 'granted'}
            onClick={async () => {
              if (typeof Notification === 'undefined') {
                toast.warning('Not supported', 'This browser does not expose the Notification API.');
                return;
              }
              if (Notification.permission === 'granted') return;
              const perm = await Notification.requestPermission();
              if (perm === 'granted') {
                new Notification('QuantVault', { body: 'Reminders enabled — you will be pinged when reviews are due.' });
                toast.success('Reminders enabled', 'You will be notified when reviews are due.');
              } else {
                toast.warning('Reminder declined', 'You can grant permission later from this same button.');
              }
            }}
          >
            {typeof Notification !== 'undefined' && Notification.permission === 'granted' ? 'Enabled' : 'Enable reminders'}
          </button>
        </div>
      </Surface>

      <Surface tone="ops" className="ops-report-panel">
        <div className="flex-between" style={{ gap: 'var(--space-3)', alignItems: 'center' }}>
          <div>
            <StatusBadge tone="exam">Exam Date</StatusBadge>
            <h3 style={{ margin: 'var(--space-2) 0 0' }}>Target exam date (pacing)</h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>
              Drives the countdown on /today and feeds future exam-date pacing logic. Leave empty to disable.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            <input
              type="date"
              className="input"
              value={examDate}
              onChange={(event) => setExamDate(event.target.value)}
              aria-label="Target CFA exam date"
            />
            <button className="btn btn-primary btn-sm" onClick={handleSaveExamDate}>Save</button>
          </div>
        </div>
      </Surface>

      <Surface tone="ops" className="ops-report-panel">
        <div className="flex-between" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-3)', alignItems: 'flex-start' }}>
          <div>
            <StatusBadge tone="accent">Local AI</StatusBadge>
            <h3 style={{ margin: 'var(--space-2) 0 0' }}>On-device generation (Ollama / LM Studio)</h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>
              Point QuantVault at a local OpenAI-compatible model server. Fully offline — no cloud, no API key. Powers practice generated from your ingested curriculum.
            </p>
          </div>
        </div>
        {llm && (
          <>
            <div className="grid-3" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Base URL</span>
                <input className="input" value={llm.baseUrl} onChange={(event) => setLlm({ ...llm, baseUrl: event.target.value })} placeholder="http://localhost:11434/v1" aria-label="Local model base URL" />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Model</span>
                {llmStatus?.ok && llmStatus.models.length > 0 ? (
                  <select
                    className="input"
                    value={llm.model}
                    onChange={(event) => setLlm({ ...llm, model: event.target.value })}
                    aria-label="Local model name"
                  >
                    {!llmStatus.models.includes(llm.model) && llm.model && (
                      <option value={llm.model}>{llm.model} (unloaded)</option>
                    )}
                    {llmStatus.models.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input className="input" value={llm.model} onChange={(event) => setLlm({ ...llm, model: event.target.value })} placeholder="llama3.1" aria-label="Local model name" />
                )}
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-5)' }}>
                <input type="checkbox" checked={llm.enabled} onChange={(event) => setLlm({ ...llm, enabled: event.target.checked })} />
                <span>Enable AI generation</span>
              </label>
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
              {LLM_PRESETS.map((preset) => (
                <button key={preset.label} className="btn btn-secondary btn-sm" onClick={() => setLlm({ ...llm, baseUrl: preset.baseUrl })}>{preset.label}</button>
              ))}
              <button className="btn btn-primary" onClick={handleSaveLlm}>Save</button>
              <button className="btn btn-secondary" onClick={handleTestLlm} disabled={llmTesting}>{llmTesting ? 'Testing…' : 'Test Connection'}</button>
              {llmStatus && (
                <StatusBadge tone={llmStatus.ok ? 'success' : 'danger'}>
                  {llmStatus.ok ? `Connected · ${llmStatus.models.length} model(s)` : `Offline · ${llmStatus.error}`}
                </StatusBadge>
              )}
            </div>
            {llmStatus?.ok && llmStatus.models.length > 0 && (
              <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)', marginTop: 'var(--space-2)' }}>
                Available models: {llmStatus.models.slice(0, 8).join(', ')}
              </p>
            )}
          </>
        )}
      </Surface>

      <Surface tone="ops" className="ops-report-panel">
        <div className="flex-between" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-3)', alignItems: 'flex-start' }}>
          <div>
            <StatusBadge tone="accent">Embedded Notebook</StatusBadge>
            <h3 style={{ margin: 'var(--space-2) 0 0' }}>Grounded RAG over your curriculum (open-notebook)</h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>
              QuantVault embeds open-notebook as a local sidecar (FastAPI + SurrealDB + job worker). It builds per-topic notebooks from your ingested CFA volumes and answers questions with cited, source-grounded synthesis. Fully offline.
            </p>
          </div>
        </div>
        {onb && (
          <>
            <div className="grid-3" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Backend URL</span>
                <input className="input" value={onb.baseUrl} onChange={(event) => setOnb({ ...onb, baseUrl: event.target.value })} placeholder="http://localhost:5055" aria-label="Open-notebook backend URL" />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-5)' }}>
                <input type="checkbox" checked={onb.enabled} onChange={(event) => setOnb({ ...onb, enabled: event.target.checked })} />
                <span>Enable grounded RAG</span>
              </label>
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
              <button className="btn btn-primary" onClick={handleSaveOnb}>Save</button>
              <button className="btn btn-secondary" onClick={handleTestOnb} disabled={onbTesting}>{onbTesting ? 'Testing…' : 'Test Connection'}</button>
              {onbStatus && (
                <StatusBadge tone={onbStatus.ok ? 'success' : 'danger'}>
                  {onbStatus.ok ? `Connected · ${onbStatus.models?.length ?? 0} model(s)` : `Offline · ${onbStatus.error}`}
                </StatusBadge>
              )}
            </div>
            {onbStatus?.ok && (
              <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)', marginTop: 'var(--space-2)' }}>
                Language: {onbStatus.languageModel || '—'} · Embedding: {onbStatus.embeddingModel || '—'}
              </p>
            )}
          </>
        )}
      </Surface>

      {onb?.enabled && (
        <Surface tone="ops" className="ops-report-panel">
          <div className="flex-between" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-3)', alignItems: 'flex-start' }}>
            <div>
              <StatusBadge tone="accent">Notebook Backend</StatusBadge>
              <h3 style={{ margin: 'var(--space-2) 0 0' }}>Embedded open-notebook notebooks ({onbNotebooks.length})</h3>
              <p style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>
                Notebooks the backend currently holds. Deleting one removes its sources, insights, and chat sessions from the embedded SurrealDB; QuantVault re-creates per-topic notebooks on demand when asks resume.
              </p>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={refreshOnbNotebooks} disabled={onbNotebooksBusy}>
              {onbNotebooksBusy ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          {onbNotebooks.length === 0 ? (
            <p className="muted-copy" style={{ margin: 0 }}>
              {onbNotebooksBusy ? 'Loading…' : 'No notebooks yet on the backend. Ask a question on any CFA topic to create one.'}
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
              {onbNotebooks.slice(0, 20).map((notebook) => (
                <div
                  key={notebook.id}
                  className="flex-between"
                  style={{
                    gap: 'var(--space-3)',
                    alignItems: 'center',
                    padding: 'var(--space-2) var(--space-3)',
                    borderRadius: 'var(--radius-md, 8px)',
                    border: '1px solid var(--border)',
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <strong style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{notebook.name || notebook.id}</strong>
                    <small className="muted-copy">
                      {notebook.source_count ?? 0} source(s) · {notebook.note_count ?? 0} note(s)
                      {notebook.description ? ` · ${notebook.description}` : ''}
                    </small>
                  </div>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleDeleteOnbNotebook(notebook.id)}
                    disabled={onbNotebooksBusy}
                    title="Delete this notebook from the embedded backend"
                  >
                    Delete
                  </button>
                </div>
              ))}
              {onbNotebooks.length > 20 && (
                <p className="muted-copy" style={{ margin: 0 }}>
                  Showing 20 of {onbNotebooks.length} notebooks.
                </p>
              )}
            </div>
          )}
        </Surface>
      )}

      {desktopAvailable && (
        <Surface tone="ops" className="ops-report-panel">
          <div className="flex-between" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-3)', alignItems: 'flex-start' }}>
            <div>
              <StatusBadge tone="success">Desktop Shell</StatusBadge>
              <h3 style={{ margin: 'var(--space-2) 0 0' }}>Ingest a local CFA folder</h3>
              <p style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>
                Point QuantVault at a folder of CFA curriculum PDFs on disk; the native shell will walk it, extract text, chunk by page, classify by topic, and store in your local source vault. Duplicates (by SHA-256) are skipped automatically. You can also drag-drop PDFs directly onto this window.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexShrink: 0 }}>
              <button
                className="btn btn-primary"
                onClick={handleIngestFolder}
                disabled={ingestState === 'picking' || ingestState === 'running'}
              >
                {ingestState === 'picking' ? 'Waiting on picker…' : ingestState === 'running' ? 'Ingesting…' : 'Pick folder…'}
              </button>
              {ingestState === 'running' && (
                <button className="btn btn-secondary" onClick={handleCancelIngest}>Cancel</button>
              )}
            </div>
          </div>
          {ingestProgress && ingestState === 'running' && (
            <p className="muted-copy" style={{ margin: 'var(--space-1) 0 0' }}>
              {ingestProgress.index + 1}/{ingestProgress.total} · {ingestProgress.fileName} · {ingestProgress.status}
              {ingestProgress.message ? ` (${ingestProgress.message})` : ''}
            </p>
          )}
          {ingestState === 'cancelled' && (
            <p className="muted-copy" style={{ margin: 'var(--space-2) 0 0' }}>
              Ingestion cancelled. Anything ingested so far has been kept in the vault.
            </p>
          )}
          {ingestState === 'error' && (
            <p style={{ color: 'var(--danger)', margin: 'var(--space-2) 0 0' }}>{ingestError}</p>
          )}
          {ingestState === 'done' && ingestResult && (
            <div style={{ marginTop: 'var(--space-2)' }}>
              <StatusBadge tone="success">
                Ingested {ingestResult.ingested} · Skipped {ingestResult.skipped} · Chunks {ingestResult.chunkCount}
              </StatusBadge>
              {ingestResult.warnings.length > 0 && (
                <p className="muted-copy" style={{ marginTop: 'var(--space-2)' }}>
                  {ingestResult.warnings.length} file(s) had warnings — first: {ingestResult.warnings[0]}
                </p>
              )}
            </div>
          )}
        </Surface>
      )}

      <Surface tone="ops" className="ops-report-panel">
        <div className="flex-between" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-3)', alignItems: 'flex-start' }}>
          <div>
            <StatusBadge tone="accent">App Caches</StatusBadge>
            <h3 style={{ margin: 'var(--space-2) 0 0' }}>App caches</h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>
              Rows written to the settings store by AI-practice, generative mocks, and grounded Q&amp;A. Clearing a bucket removes generated content but not persistent settings (LLM config, open-notebook config, onboarding).
            </p>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexShrink: 0 }}>
            <button
              className="btn btn-secondary btn-sm"
              onClick={async () => {
                await getStorage().settings.delete('onboarding-dismissed');
                setMessage('Onboarding will re-open on your next Dashboard visit.');
                toast.success('Onboarding reset', 'Visit / to see the first-run wizard again.');
              }}
              title="Re-arm the first-run onboarding wizard for your next Dashboard visit"
            >
              Reset onboarding
            </button>
            <button className="btn btn-secondary btn-sm" onClick={refreshCacheBuckets} disabled={cacheBusy}>
              Refresh
            </button>
            <button className="btn btn-secondary btn-sm" onClick={handleClearAllCaches} disabled={cacheBusy}>
              Clear all caches
            </button>
          </div>
        </div>
        {cacheBuckets === null ? (
          <p className="muted-copy" style={{ margin: 0 }}>Loading…</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {[
              { id: 'ai-questions', label: 'AI-practice generated questions', prefix: 'ai-questions:*' },
              { id: 'generated-mock', label: 'Saved generative mock exams', prefix: 'generated-mock:*' },
              { id: 'open-notebook:answer', label: 'Grounded Q&A per topic', prefix: 'open-notebook:answer:*' },
              { id: 'open-notebook:topic-notebooks', label: 'Topic-notebook map', prefix: 'open-notebook:topic-notebooks' },
              { id: 'other', label: 'Other (cfa-* and unknown keys)', prefix: '' },
            ].map(({ id, label, prefix }) => (
              <div
                key={id}
                className="flex-between"
                style={{
                  gap: 'var(--space-3)',
                  alignItems: 'center',
                  padding: 'var(--space-2) var(--space-3)',
                  borderRadius: 'var(--radius-md, 8px)',
                  border: '1px solid var(--border)',
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <strong>{label}</strong>
                  {prefix && <small className="muted-copy" style={{ marginLeft: 'var(--space-2)' }}>{prefix}</small>}
                  <small className="muted-copy" style={{ display: 'block' }}>{cacheBuckets[id] ?? 0} row(s)</small>
                </div>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => handleClearBucket(id)}
                  disabled={cacheBusy || (cacheBuckets[id] ?? 0) === 0}
                  title={`Clear the "${id}" cache bucket`}
                >
                  Clear
                </button>
              </div>
            ))}
          </div>
        )}
      </Surface>

      <Surface tone="ops" className="ops-report-panel">
        <div className="flex-between" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-3)', alignItems: 'flex-start' }}>
          <div>
            <StatusBadge tone="accent">Source Vault</StatusBadge>
            <h3 style={{ margin: 'var(--space-2) 0 0' }}>Ingested source documents ({sourceDocs.length})</h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>
              Everything in your local vault — bundled `.qvsource` imports plus desktop folder ingestion. Deletes are scoped (the document and its chunks only) and irreversible.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexShrink: 0 }}>
            <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }} aria-disabled={sourceDocsBusy}>
              Import .qvsource
              <input
                type="file"
                accept=".qvsource,.json,application/json"
                style={{ display: 'none' }}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) handleImportSourceBundle(file);
                  event.target.value = '';
                }}
                disabled={sourceDocsBusy}
              />
            </label>
            <button className="btn btn-secondary btn-sm" onClick={handleExportSourceBundle} disabled={sourceDocsBusy || sourceDocs.length === 0}>
              Export .qvsource
            </button>
            <button className="btn btn-secondary btn-sm" onClick={refreshSourceDocs} disabled={sourceDocsBusy}>
              {sourceDocsBusy ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>
        {sourceDocs.length === 0 ? (
          <p className="muted-copy" style={{ margin: 0 }}>
            No ingested documents yet. Import a `.qvsource` bundle or ingest a CFA folder from the desktop shell to populate the vault.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {sourceDocs.slice(0, 12).map((doc) => (
              <div
                key={doc.id}
                className="flex-between"
                style={{
                  gap: 'var(--space-3)',
                  alignItems: 'center',
                  padding: 'var(--space-2) var(--space-3)',
                  borderRadius: 'var(--radius-md, 8px)',
                  border: '1px solid var(--border)',
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <strong style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.title || doc.id}</strong>
                  <small className="muted-copy">
                    {doc.level} · {doc.sourceKind} · {doc.publisher || '—'} · {doc.chunkCount ?? 0} chunks · {doc.format || 'unknown'}
                    {doc.topicIds?.length ? ` · ${doc.topicIds.slice(0, 4).join(', ')}` : ''}
                  </small>
                </div>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => handleDeleteSourceDoc(doc.id)}
                  disabled={sourceDocsBusy}
                  title="Delete this document and its chunks from the local vault"
                >
                  Delete
                </button>
              </div>
            ))}
            {sourceDocs.length > 12 && (
              <p className="muted-copy" style={{ margin: 0 }}>
                Showing 12 of {sourceDocs.length} documents.
              </p>
            )}
          </div>
        )}
      </Surface>

      <Surface tone="ops" className="ops-report-panel">
        <div style={{ marginBottom: 'var(--space-3)' }}>
          <StatusBadge tone="accent">Paste a source</StatusBadge>
          <h3 style={{ margin: 'var(--space-2) 0 0' }}>Ingest free text directly into the vault</h3>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>
            For lecture notes, blog excerpts, or any non-PDF material you want to use in grounded answers. Same chunker/dedupe path as PDF ingestion; SHA-256 of the text serves as the document id.
          </p>
        </div>
        <div className="grid-3" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Title</span>
            <input className="input" value={pasteTitle} onChange={(event) => setPasteTitle(event.target.value)} placeholder="e.g. Fixed Income lecture notes" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Topic id (optional)</span>
            <input className="input" value={pasteTopic} onChange={(event) => setPasteTopic(event.target.value)} placeholder="e.g. fixed-income" />
          </label>
        </div>
        <textarea
          className="input"
          rows={6}
          style={{ width: '100%', marginBottom: 'var(--space-2)', fontFamily: 'inherit' }}
          value={pasteText}
          onChange={(event) => setPasteText(event.target.value)}
          placeholder="Paste curriculum text, lecture notes, or any non-PDF source material..."
        />
        <div className="flex-between" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
          <small className="muted-copy">{pasteText.length.toLocaleString()} character(s)</small>
          <button className="btn btn-primary" onClick={handleIngestPastedText} disabled={pasteBusy || !pasteText.trim()}>
            {pasteBusy ? 'Ingesting…' : 'Ingest paste'}
          </button>
        </div>
        {pasteError && <p style={{ color: 'var(--danger)', margin: 'var(--space-2) 0 0' }}>{pasteError}</p>}
      </Surface>

      <Surface tone="ops" className="ops-report-panel">
        <div className="flex-between" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
          <div>
            <h3 style={{ marginTop: 0 }}>Offline Readiness</h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>
              {offlineReadiness?.cacheName || 'quantvault-offline-content'} · {offlineReadiness?.cachedCount ?? 0}/{offlineReadiness?.totalCriticalRoutes ?? 0} critical routes cached
            </p>
          </div>
          <button className="btn btn-secondary" onClick={handleCacheCriticalRoutes}>Cache Critical Routes</button>
        </div>
        {offlineReadiness?.criticalRoutes?.length > 0 && (
          <div className="coverage-grid" style={{ marginBottom: 'var(--space-4)' }}>
            {offlineReadiness.criticalRoutes.slice(0, 8).map((route) => (
              <div key={route.routeId}>
                <strong>{route.label}</strong>
                <small>{route.cached ? 'cached' : 'not cached'} · {route.path}</small>
              </div>
            ))}
          </div>
        )}
        <h3>Cache Buckets</h3>
        {cacheNames.length ? (
          <div className="coverage-grid">
            {cacheNames.map((name) => (
              <div key={name}>
                <strong>{name}</strong>
                <small>Managed by the browser Cache API</small>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ color: 'var(--text-secondary)' }}>No cache buckets are currently visible in this browser context.</p>
        )}
      </Surface>

      <Surface tone="vault">
        <h3 style={{ marginTop: 0 }}>Backup Reminder</h3>
        <p style={{ color: 'var(--text-secondary)' }}>
          QuantVault is local-first. Export a backup before clearing browser data, moving devices, or starting a long mock-exam cycle.
        </p>
        {message && <p style={{ color: 'var(--success)' }}>{message}</p>}
      </Surface>
    </div>
  );
}
