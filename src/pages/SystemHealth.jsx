import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Database, Download, HardDrive, ShieldCheck, WifiOff, XCircle } from 'lucide-react';
import { PageHeader, MetricCard } from '../components/ui/Primitives';
import { exportVaultData } from '../lib/learning';
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
  const [releaseReport, setReleaseReport] = useState(() => buildReleaseGateReport());
  const serviceWorkerReady = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  const cacheReady = typeof caches !== 'undefined';

  useEffect(() => {
    let active = true;
    Promise.all([
      navigator.storage?.estimate?.() || Promise.resolve(null),
      cacheReady ? caches.keys() : Promise.resolve([]),
    ]).then(([estimate, names]) => {
      if (!active) return;
      setStorage(estimate);
      setCacheNames(names);
    });
    return () => {
      active = false;
    };
  }, [cacheReady]);

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

  async function handleBackup() {
    downloadJson(await exportVaultData());
    setMessage('Backup exported. Keep it somewhere safe before long study blocks or browser cleanup.');
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
        actions={<button className="btn btn-primary" onClick={handleBackup}><Download size={16} /> Export Backup</button>}
      />

      <div className="grid-4" style={{ marginBottom: 'var(--space-6)' }}>
        <MetricCard label="IndexedDB Storage" value={`${usageMb} MB`} detail={`${usagePct}% of estimated quota`} icon={Database} />
        <MetricCard label="Quota" value={`${quotaMb || '-'} MB`} detail="Browser estimate" icon={HardDrive} tone="warning" />
        <MetricCard label="Service Worker" value={serviceWorkerReady ? 'Ready' : 'Unavailable'} detail="Offline shell support" icon={ShieldCheck} tone={serviceWorkerReady ? 'success' : 'danger'} />
        <MetricCard label="Caches" value={cacheNames.length} detail="Named cache buckets" icon={WifiOff} tone="accent" />
      </div>

      <div className="glass-card no-hover" style={{ marginBottom: 'var(--space-6)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-4)', flexWrap: 'wrap', marginBottom: 'var(--space-4)' }}>
          <div>
            <h3 style={{ margin: 0 }}>Release Health</h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>
              Generated {new Date(releaseReport.generatedAt).toLocaleString()} · {releaseReport.summary.level1ExamReadyTopics}/{releaseReport.summary.level1TopicCount} Level I topics exam-ready
            </p>
          </div>
          <div className={`badge ${releaseReport.status === 'ok' ? 'badge-green' : releaseReport.status === 'blocked' ? 'badge-red' : 'badge-amber'}`}>
            {releaseReport.status}
          </div>
        </div>

        <div className="coverage-grid">
          {releaseReport.gates.map((gate) => (
            <div key={gate.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <GateIcon status={gate.status} />
                <strong>{gate.label}</strong>
              </div>
              <small style={{ color: `var(--${gateTone(gate.status)})`, textTransform: 'uppercase', fontWeight: 800 }}>{gate.status}</small>
              <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)', margin: 'var(--space-2) 0 0' }}>{gate.detail}</p>
              {gate.command && <code style={{ display: 'inline-block', marginTop: 'var(--space-2)' }}>{gate.command}</code>}
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
      </div>

      <div className="glass-card no-hover" style={{ marginBottom: 'var(--space-6)' }}>
        <h3 style={{ marginTop: 0 }}>Cache Buckets</h3>
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
      </div>

      <div className="glass-card no-hover">
        <h3 style={{ marginTop: 0 }}>Backup Reminder</h3>
        <p style={{ color: 'var(--text-secondary)' }}>
          QuantVault is local-first. Export a backup before clearing browser data, moving devices, or starting a long mock-exam cycle.
        </p>
        {message && <p style={{ color: 'var(--success)' }}>{message}</p>}
      </div>
    </div>
  );
}
