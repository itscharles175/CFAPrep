import { useEffect, useState } from 'react';
import { Database, Download, HardDrive, KeyRound, ShieldCheck, WifiOff, Wrench } from 'lucide-react';
import { PageHeader, MetricCard, StatusBadge, Surface } from '../components/ui/Primitives';
import { exportVaultData, getVaultHealthReport, previewVaultRepair } from '../lib/learning';
import { cacheCriticalOfflineRoutes, getOfflineReadinessReport } from '../lib/offlineContentCache';
import { checkLlmConnection, getLlmSettings, LLM_PRESETS, saveLlmSettings } from '../lib/localLlm';

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
    return () => {
      active = false;
    };
  }, []);

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
                <input className="input" value={llm.model} onChange={(event) => setLlm({ ...llm, model: event.target.value })} placeholder="llama3.1" aria-label="Local model name" />
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
