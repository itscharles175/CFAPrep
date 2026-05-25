import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Database, Download, HardDrive, KeyRound, ShieldCheck, WifiOff, Wrench, XCircle } from 'lucide-react';
import { PageHeader, MetricCard, StatusBadge, Surface } from '../components/ui/Primitives';
import { exportVaultData, getVaultHealthReport, previewVaultRepair } from '../lib/learning';
import { cacheCriticalOfflineRoutes, getOfflineReadinessReport } from '../lib/offlineContentCache';
import { buildReleaseGateReport } from '../lib/releaseHealth';

function downloadJson(payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `quantvault-backup-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function gateTone(status) {
  if (status === 'ok') return 'success';
  if (status === 'blocked') return 'danger';
  if (status === 'warning') return 'warning';
  return 'accent';
}

function GateIcon({ status }) {
  if (status === 'ok') return <CheckCircle2 size={18} color="var(--success)" aria-hidden="true" />;
  if (status === 'blocked') return <XCircle size={18} color="var(--danger)" aria-hidden="true" />;
  if (status === 'warning') return <AlertTriangle size={18} color="var(--warning)" aria-hidden="true" />;
  return <Clock size={18} color="var(--accent)" aria-hidden="true" />;
}

export default function SystemHealth() {
  const [storage, setStorage] = useState(null);
  const [cacheNames, setCacheNames] = useState([]);
  const [message, setMessage] = useState('');
  const [backupPassphrase, setBackupPassphrase] = useState('');
  const [releaseReport, setReleaseReport] = useState(() => buildReleaseGateReport());
  const [vaultHealth, setVaultHealth] = useState(null);
  const [offlineReadiness, setOfflineReadiness] = useState(null);
  const [persisted, setPersisted] = useState(null);
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
    fetch('/reports/release-manifest.json', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((report) => {
        if (active && report?.gates) setReleaseReport(report);
      })
      .catch(() => {
        // Dev servers may not have generated release artifacts yet; the runtime report remains useful.
      });
    return () => {
      active = false;
    };
  }, []);

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

      <Surface tone="ops" status={releaseReport.status === 'ok' ? 'success' : releaseReport.status === 'blocked' ? 'danger' : releaseReport.status} className="ops-report-panel">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-4)', flexWrap: 'wrap', marginBottom: 'var(--space-4)' }}>
          <div>
            <h3 style={{ margin: 0 }}>Release Health</h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>
              Generated {new Date(releaseReport.generatedAt).toLocaleString()} · {releaseReport.summary.level1ExamReadyTopics}/{releaseReport.summary.level1TopicCount} Level I, {releaseReport.summary.level2ExamReadyTopics}/{releaseReport.summary.level2TopicCount} Level II, and {releaseReport.summary.level3ExamReadyTopics}/{releaseReport.summary.level3TopicCount} Level III topics exam-ready
            </p>
            <p style={{ color: 'var(--text-muted)', margin: 'var(--space-1) 0 0', fontSize: 'var(--fs-sm)' }}>
              Run {releaseReport.runId || 'runtime-preview'} · Git {releaseReport.git?.shortSha || 'unknown'}{releaseReport.git?.branch ? ` on ${releaseReport.git.branch}` : ''} · {releaseReport.staleGateCount || 0} stale gate(s)
            </p>
          </div>
          <StatusBadge tone={releaseReport.status === 'ok' ? 'success' : releaseReport.status === 'blocked' ? 'danger' : 'warning'}>
            {releaseReport.status}
          </StatusBadge>
        </div>

        <div className="coverage-grid">
          {releaseReport.gates.map((gate) => (
            <div key={gate.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <GateIcon status={gate.status} />
                <strong>{gate.label}</strong>
              </div>
              <small style={{ color: `var(--${gateTone(gate.status)})`, textTransform: 'uppercase', fontWeight: 800 }}>
                {gate.status} · {gate.category}
                {typeof gate.ageHours === 'number' ? ` · ${gate.ageHours}h old` : ''}
                {gate.stale ? ' · stale' : ''}
              </small>
              <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)', margin: 'var(--space-2) 0 0' }}>{gate.detail}</p>
              {gate.command && <code style={{ display: 'inline-block', marginTop: 'var(--space-2)' }}>{gate.command}</code>}
              {(gate.parallelGroup || gate.dependencies?.length || gate.artifactSchema?.id) && (
                <small style={{ display: 'block', color: 'var(--text-muted)', marginTop: 'var(--space-2)' }}>
                  {gate.parallelGroup ? `Group: ${gate.parallelGroup}` : ''}
                  {gate.dependencies?.length ? `${gate.parallelGroup ? ' · ' : ''}Depends: ${gate.dependencies.join(', ')}` : ''}
                  {gate.artifactSchema?.id ? `${gate.parallelGroup || gate.dependencies?.length ? ' · ' : ''}Schema: ${gate.artifactSchema.id}` : ''}
                </small>
              )}
              {gate.artifactPaths?.length > 0 && (
                <small style={{ display: 'block', color: 'var(--text-muted)', marginTop: 'var(--space-2)' }}>
                  Artifacts: {gate.artifactPaths.join(', ')}
                </small>
              )}
            </div>
          ))}
        </div>

        {releaseReport.blockers.length > 0 && (
          <div style={{ marginTop: 'var(--space-4)' }}>
            <strong>Public release blockers</strong>
            <ul style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>
              {releaseReport.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          </div>
        )}
      </Surface>

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
