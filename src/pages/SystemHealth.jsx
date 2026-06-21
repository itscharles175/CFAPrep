import { useEffect, useRef, useState } from 'react';
import { Boxes, CloudCog, Database, Download, Gauge, HardDrive, History, KeyRound, Mic2, Network, RefreshCw, ServerCog, ShieldCheck, Terminal, Upload, WifiOff, Wrench } from 'lucide-react';
import { PageHeader, MetricCard, StatusBadge, Surface } from '../components/ui/Primitives';
import { exportVaultData, getVaultHealthReport, importVaultData, previewVaultRepair, restoreRollbackSnapshot } from '../lib/learning';
// AUDIT-2 — unified {host, lsat} backup/restore (DATA-5 wired into the UI).
import { exportUnifiedBackup, importUnifiedBackup, UnifiedBackupError } from '../lib/unifiedBackup';
import { decryptVaultBackup, encryptVaultBackup } from '../lib/encryptedBackup';
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
import { getStorage, getActiveDriverName, cutoverTo, previewCutover, switchToDexie, setStoredStoragePreference, getStoredStoragePreference } from '../lib/storage';
import { checkLsatBackendHealth, getLsatCloudBudget, syncProviderToLsat, LSAT_SETTINGS_PATH } from '../lib/lsatBackend';
import EditModelRoutingModal from '../components/SystemHealth/EditModelRoutingModal';
import { TrustReleasePanel } from '../components/ui/TrustReleasePanel';
import { useTrustManifest } from '../hooks/useTrustManifest';
import { fetchDataSchemaAlignment } from '../lib/dataDictionary';
import { getSidecarLogs, getSidecarStatus, getAggregatedSystemHealth } from '../lib/systemHealth';
import { recordRuntimeSample } from '../lib/runtimeMetricsStore';
import RuntimeMetricsTab from '../components/SystemHealth/RuntimeMetricsTab';
import MaintenancePanel from '../components/SystemHealth/MaintenancePanel';
import { GenerationQualityPanel } from '../components/SystemHealth/GenerationQualityPanel';
import { recognizeOnceOffline } from '../lib/voice';
import { readLastCrash, clearLastCrash } from '../components/ErrorBoundary';
import {
  clearPersistedParameters,
  persistOptimizedParameters,
  readPersistedParameters,
} from '../lib/fsrsOptimizer';
import { setSchedulerParameters } from '../lib/scheduler';
import { db } from '../lib/progressStore';
import {
  clearPsychometricsCache,
  persistPsychometricsReport,
  readCachedPsychometricsReport,
} from '../lib/itemPsychometrics';
import { computePsychometricsInWorker, fitFSRSInWorker } from '../lib/computeWorker';
import {
  clearQueue as clearTargetedQueue,
  generateTargetedMaterialJobs,
  readQueue as readTargetedQueue,
  runTargetedMaterialJob,
} from '../lib/targetedMaterialQueue';
import FigureExplainer from '../components/FigureExplainer/FigureExplainer';
import { useWebVitals, formatWebVital, getWebVitalThresholds } from '../lib/webVitals';

// Cache-management constants — used by refreshCacheBuckets / handleClearBucket.
const CACHE_PREFIXES = {
  'ai-questions': 'ai-questions:',
  'generated-mock': 'generated-mock:',
  'open-notebook:answer': 'open-notebook:answer:',
  'open-notebook:topic-notebooks': 'open-notebook:topic-notebooks',
};
const SKIP_KEYS = new Set(['local-llm', 'open-notebook', 'onboarding-dismissed']);

function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  // OPS-4: accept an optional filename (diagnostics export passes a timestamped
  // name); existing callers omit it and keep the default backup filename.
  anchor.download = filename || `studyvault-backup-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

// UC6: map a web-vital rating to the Surface stat-cell tone classes already in
// the design system (good→success, needs-improvement→warning, poor→danger).
const VITAL_TONE = {
  good: 'qv-text-success',
  'needs-improvement': 'qv-text-warning',
  poor: 'qv-text-danger',
  pending: 'qv-text-muted',
};
const VITAL_LABELS = {
  LCP: 'Largest Contentful Paint',
  CLS: 'Cumulative Layout Shift',
  INP: 'Interaction to Next Paint',
};

// OPS-2: host-side probes the Trust & Release cockpit folds into the backend
// manifest. Defined at module scope so the object reference is stable across
// renders — useTrustManifest keys its load effect on it, and a fresh literal
// each render would re-run the gate every commit.
const TRUST_HOST_DEPS = {
  getOfflineReadinessReport,
  checkLsatBackendHealth,
};

export default function SystemHealth() {
  const toast = useToast();
  // UC6: Core Web Vitals, collected locally via PerformanceObserver — no remote
  // analytics. Latest values stream in as the page is observed/interacted with.
  const webVitals = useWebVitals();
  // OPS-2: release-trust cockpit. Loads the backend manifest (cached, refreshable)
  // and the always-available host-side checks; fully degrading when the LSAT
  // sidecar is slow or absent so it never blocks this page's render.
  const trust = useTrustManifest({ hostDeps: TRUST_HOST_DEPS });
  const [storage, setStorage] = useState(null);
  const [cacheNames, setCacheNames] = useState([]);
  const [message, setMessage] = useState('');
  const [backupPassphrase, setBackupPassphrase] = useState('');
  // AES-GCM-256 encrypted export/import (sibling to plaintext export). The
  // confirm field guards typos before we hand the passphrase to the KDF — once
  // the blob is sealed, there is no recovery.
  const [backupPassphraseConfirm, setBackupPassphraseConfirm] = useState('');
  const [encryptedBusy, setEncryptedBusy] = useState(false);
  const [encryptedImportPassphrase, setEncryptedImportPassphrase] = useState('');
  const [pendingEncryptedFile, setPendingEncryptedFile] = useState(null);
  // AUDIT-2 — unified backup (host + LSAT) state.
  const [unifiedBusy, setUnifiedBusy] = useState(false);
  const [pendingUnifiedFile, setPendingUnifiedFile] = useState(null);
  const [vaultHealth, setVaultHealth] = useState(null);
  const [offlineReadiness, setOfflineReadiness] = useState(null);
  const [persisted, setPersisted] = useState(null);
  const [llm, setLlm] = useState(null);
  const [llmStatus, setLlmStatus] = useState(null);
  const [llmTesting, setLlmTesting] = useState(false);
  const [onb, setOnb] = useState(null);
  const [onbStatus, setOnbStatus] = useState(null);
  const [onbTesting, setOnbTesting] = useState(false);
  // LSAT backend sidecar (:8100) health — probed independently so a down
  // sidecar never blocks the page. null = not yet checked.
  const [lsatHealth, setLsatHealth] = useState(null);
  // OPS-3: one rolled-up ok/degraded/error verdict for the header badge,
  // folding the native sidecar-supervision roll-up (get_system_health_aggregated)
  // with the LSAT backend's own internal health (/observability/health-aggregated).
  // Polled on an interval; each poll also feeds the Runtime Metrics trend store.
  // null = not yet checked.
  const [aggregatedHealth, setAggregatedHealth] = useState(null);
  // DATA-3: cross-domain schema-version handshake. The host reads the LSAT
  // sidecar's reported contract version on mount and compares it to the version
  // this build speaks; on a mismatch, CROSS-DOMAIN writes are disabled (local
  // Dexie data is unaffected). null = not yet checked.
  const [dataAlignment, setDataAlignment] = useState(null);
  // INT-2: model-routing edit modal visibility (LSAT Backend panel).
  const [routingModalOpen, setRoutingModalOpen] = useState(false);
  // OPS-1: unified sidecar console. The desktop shell supervises all four
  // sidecars (SurrealDB :8000, open-notebook API :5055 + worker, LSAT :8100);
  // these mirror the native get_sidecar_status / get_sidecar_logs commands.
  // null = not yet checked (or, after a load, "unavailable outside Tauri").
  const [sidecars, setSidecars] = useState(null);
  const [sidecarsBusy, setSidecarsBusy] = useState(false);
  // Name of the sidecar whose log tail is expanded, or null when collapsed.
  const [openSidecarLog, setOpenSidecarLog] = useState(null);
  const [sidecarLogLines, setSidecarLogLines] = useState([]);
  const [sidecarLogBusy, setSidecarLogBusy] = useState(false);
  // Tracks whether we are running inside the Tauri shell (where the commands
  // exist) vs browser dev, so the panel can render an honest "desktop-app only"
  // note instead of an empty list.
  // BB4: cloud-budget picture + next-call dry-run estimate from the LSAT sidecar
  // (read-only; the sidecar is the only thing that talks to the cloud provider).
  const [cloudBudget, setCloudBudget] = useState(null); // null = not yet checked
  const [cloudBudgetBusy, setCloudBudgetBusy] = useState(false);
  // BB4: local Whisper/voice STT model download visibility. The model is cached
  // in the BROWSER by transformers.js, so the host probes Cache Storage itself;
  // the sidecar's report (cloudBudget.voice) covers any server-side cache.
  const [whisperBrowserCached, setWhisperBrowserCached] = useState(null); // null = unknown
  const [whisperDownloadState, setWhisperDownloadState] = useState('idle'); // idle | downloading | done | error
  const [whisperDownloadPct, setWhisperDownloadPct] = useState(0);
  const [whisperError, setWhisperError] = useState('');
  const browserSttSupported =
    typeof window !== 'undefined' && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  // P5: the last render crash the ErrorBoundary persisted (local-first apps
  // have no remote telemetry). Read once on mount; null when there's none.
  const [lastCrash, setLastCrash] = useState(() => readLastCrash());
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
  const [fsrsCustom, setFsrsCustom] = useState(null);
  const [fsrsFit, setFsrsFit] = useState(null); // last fit report
  const [fsrsBusy, setFsrsBusy] = useState(false);
  const [fsrsError, setFsrsError] = useState('');
  const [psychReport, setPsychReport] = useState(null);
  const [psychBusy, setPsychBusy] = useState(false);
  const [psychError, setPsychError] = useState('');
  const [activeDriver, setActiveDriver] = useState(getActiveDriverName());
  const [driverPref, setDriverPref] = useState(getStoredStoragePreference());
  const [cutoverBusy, setCutoverBusy] = useState(false);
  const [cutoverError, setCutoverError] = useState('');
  const [cutoverReport, setCutoverReport] = useState(null);
  // DATA-2 — dry-run preview of a SurrealDB cutover (counts + loss-safety) shown
  // before the user commits the switch.
  const [cutoverManifest, setCutoverManifest] = useState(null);
  // Auto-generated targeted material queue
  const [targetedQueue, setTargetedQueue] = useState([]);
  const [targetedBusy, setTargetedBusy] = useState(false);
  const [targetedError, setTargetedError] = useState('');
  const [targetedRunningId, setTargetedRunningId] = useState(null);
  // Hybrid curriculum search (vector + BM25 via the active StorageDriver).
  const [chunkQuery, setChunkQuery] = useState('');
  const [chunkHits, setChunkHits] = useState([]);
  const [chunkBusy, setChunkBusy] = useState(false);
  const [chunkError, setChunkError] = useState('');
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
    readPersistedParameters().then((row) => {
      if (active) setFsrsCustom(row);
    });
    readCachedPsychometricsReport().then((row) => {
      if (active) setPsychReport(row);
    });
    readTargetedQueue().then((rows) => {
      if (active) setTargetedQueue(rows);
    });
    checkLsatBackendHealth().then((h) => {
      if (active) setLsatHealth(h);
    });
    fetchDataSchemaAlignment().then((alignment) => {
      if (active) setDataAlignment(alignment);
    });
    refreshSidecars(active);
    refreshCloudBudget(active);
    probeWhisperBrowserCache().then((cached) => {
      if (active) setWhisperBrowserCached(cached);
    });
    return () => {
      active = false;
    };
    // Run-once-on-mount loader; the refresh helpers are stable component
    // functions and intentionally not in the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // OPS-3: aggregated System-Health verdict + Runtime Metrics sampling. Polls
  // the rolled-up health (sidecar supervision + LSAT backend internal health)
  // every ~10s and records each backend report into the local runtime-metrics
  // trend store so the Runtime Metrics tab can draw sparklines. Fully degrading:
  // both sources may be null (browser dev / sidecar down) without throwing.
  useEffect(() => {
    let active = true;
    async function pollHealth() {
      const report = await getAggregatedSystemHealth();
      if (!active) return;
      setAggregatedHealth(report);
      // Feed the runtime trend store from the backend report (null still records
      // a gap sample so the series shows the outage rather than silently pausing).
      recordRuntimeSample(report.backend);
    }
    pollHealth();
    const timer = setInterval(pollHealth, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // OPS-1: unified sidecar console
  //
  // Pulls the live supervisor snapshot (all four sidecars) from the native
  // get_sidecar_status command. Returns null outside Tauri (browser dev / tests)
  // or on an invoke failure, which the panel renders as a "desktop-app only"
  // note rather than an empty list.
  // ---------------------------------------------------------------------------
  async function refreshSidecars(active = true) {
    setSidecarsBusy(true);
    try {
      const rows = await getSidecarStatus();
      if (active) setSidecars(rows);
      // If the currently-expanded sidecar is still present, refresh its tail so
      // an open log keeps pace with a re-check.
      if (active && rows && openSidecarLog && rows.some((row) => row.name === openSidecarLog)) {
        const lines = await getSidecarLogs(openSidecarLog);
        if (active) setSidecarLogLines(lines ?? []);
      }
    } finally {
      if (active) setSidecarsBusy(false);
    }
  }

  // Expand a sidecar's log tail (or collapse it if it's already open). The tail
  // is fetched lazily so we only pull a buffer for the row the user opens.
  async function handleToggleSidecarLog(name) {
    if (openSidecarLog === name) {
      setOpenSidecarLog(null);
      setSidecarLogLines([]);
      return;
    }
    setOpenSidecarLog(name);
    setSidecarLogLines([]);
    setSidecarLogBusy(true);
    try {
      const lines = await getSidecarLogs(name);
      setSidecarLogLines(lines ?? []);
    } finally {
      setSidecarLogBusy(false);
    }
  }

  // ---------------------------------------------------------------------------
  // BB4: cloud-budget + Whisper/voice model visibility
  // ---------------------------------------------------------------------------
  async function refreshCloudBudget(active = true) {
    setCloudBudgetBusy(true);
    try {
      const report = await getLsatCloudBudget();
      if (active) setCloudBudget(report);
    } finally {
      if (active) setCloudBudgetBusy(false);
    }
  }

  /**
   * Best-effort probe of the in-browser transformers.js model cache. The library
   * caches downloaded ONNX/tokenizer files in a Cache Storage bucket named
   * "transformers-cache"; if any cached entry's URL references the Whisper model,
   * it has been downloaded. Returns null when the Cache API is unavailable so the
   * UI shows "unknown" rather than a false "not downloaded".
   */
  async function probeWhisperBrowserCache() {
    if (typeof caches === 'undefined' || !caches.open) return null;
    try {
      const cache = await caches.open('transformers-cache');
      const keys = await cache.keys();
      return keys.some((req) => /whisper-tiny/i.test(req.url));
    } catch {
      return null;
    }
  }

  async function handleWhisperDownload() {
    setWhisperError('');
    setWhisperDownloadState('downloading');
    setWhisperDownloadPct(0);
    try {
      // Trigger the one-time model download by running offline STT over a tiny
      // silent buffer. transformers.js fires `progress_callback` per file while
      // downloading; we track the highest percent seen so the bar never jumps
      // backwards as it switches between files. The transcription result is
      // discarded — we only care that the model is now cached locally.
      const silent = new Float32Array(16000); // 1s of 16kHz silence
      await recognizeOnceOffline({
        audio: silent,
        onProgress: (event) => {
          const pct = typeof event?.progress === 'number' ? Math.round(event.progress) : 0;
          setWhisperDownloadPct((prev) => (pct > prev ? pct : prev));
        },
      });
      setWhisperDownloadPct(100);
      setWhisperDownloadState('done');
      setWhisperBrowserCached(await probeWhisperBrowserCache());
      toast.success('Voice model ready', 'Whisper-tiny is cached locally — offline voice input works without a download next time.');
    } catch (error) {
      setWhisperDownloadState('error');
      const detail = error instanceof Error ? error.message : 'Could not download the voice model.';
      setWhisperError(detail);
      toast.error('Voice model download failed', detail);
    }
  }

  async function handlePsychCompute() {
    setPsychBusy(true);
    setPsychError('');
    try {
      const rows = await db.questionResults.toArray();
      const report = await computePsychometricsInWorker(rows);
      await persistPsychometricsReport(report);
      setPsychReport(report);
      toast.success('Psychometrics updated', `${report.totalItems} items scored across ${report.totalAttempts} attempts.`);
    } catch (error) {
      setPsychError(error?.message || String(error));
    } finally {
      setPsychBusy(false);
    }
  }

  async function handlePsychReset() {
    await clearPsychometricsCache();
    setPsychReport(null);
    toast.info('Psychometrics cleared', 'Cache emptied — recompute any time.');
  }

  async function handlePreviewCutover() {
    // DATA-2 — dry-run: show what a cutover would copy and whether it's loss-safe,
    // WITHOUT switching drivers or mutating anything.
    setCutoverBusy(true);
    setCutoverError('');
    setCutoverReport(null);
    setCutoverManifest(null);
    try {
      const result = await previewCutover('surrealdb');
      if (!result.ok) {
        setCutoverError(result.error || 'Could not reach the SurrealDB sidecar at localhost:8000.');
        return;
      }
      setCutoverManifest(result.manifest);
    } catch (error) {
      setCutoverError(error?.message || String(error));
    } finally {
      setCutoverBusy(false);
    }
  }

  async function handleCutoverToSurreal() {
    setCutoverBusy(true);
    setCutoverError('');
    setCutoverReport(null);
    try {
      const result = await cutoverTo('surrealdb');
      // DATA-2 — surface the manifest (counts / blockers) whether or not the
      // cutover proceeded, so a refusal explains exactly what blocked it.
      if (result.manifest) setCutoverManifest(result.manifest);
      if (!result.ok) {
        setCutoverError(result.error || 'Could not reach the SurrealDB sidecar at localhost:8000.');
        toast.warning('SurrealDB unavailable', 'Staying on the local Dexie store.');
        return;
      }
      setActiveDriver(getActiveDriverName());
      setDriverPref(getStoredStoragePreference());
      if (result.report) {
        setCutoverReport(result.report);
        const copied = result.report.settings + result.report.reviewItems + result.report.questionResults + result.report.masterySnapshots;
        const chunkNote = result.report.chunks
          ? ` and ${result.report.chunks} chunk${result.report.chunks === 1 ? '' : 's'}`
          : '';
        toast.success('Switched to SurrealDB', `Migrated ${copied} rows${chunkNote}.`);
      } else if (result.alreadyActive) {
        toast.info('Already on SurrealDB', 'No migration needed.');
      }
    } catch (error) {
      setCutoverError(error?.message || String(error));
    } finally {
      setCutoverBusy(false);
    }
  }

  async function handleRollbackToDexie() {
    setCutoverBusy(true);
    setCutoverError('');
    setCutoverReport(null);
    setCutoverManifest(null);
    try {
      const result = await switchToDexie();
      if (!result.ok) {
        setCutoverError(result.error || 'Could not switch back to Dexie.');
        return;
      }
      // switchToDexie doesn't touch the preference — clear it explicitly so the
      // next reload boots on Dexie rather than re-probing SurrealDB.
      setStoredStoragePreference('dexie');
      setActiveDriver(getActiveDriverName());
      setDriverPref(getStoredStoragePreference());
      toast.info('Rolled back to Dexie', 'Local IndexedDB is the active store again.');
    } catch (error) {
      setCutoverError(error?.message || String(error));
    } finally {
      setCutoverBusy(false);
    }
  }

  async function handleTargetedGenerate() {
    setTargetedBusy(true);
    setTargetedError('');
    try {
      const snapshots = await db.masterySnapshots.toArray();
      const weakTopics = snapshots
        .filter((snapshot) => snapshot.score < 55)
        .map((snapshot) => ({
          domain: snapshot.domain,
          level: snapshot.topic.split(':')[0] || 'level1',
          topic: snapshot.topic,
          title: snapshot.title,
          mastery: snapshot.score / 100,
        }));
      const jobs = await generateTargetedMaterialJobs({ weakTopics });
      setTargetedQueue(jobs);
      const pending = jobs.filter((job) => job.status === 'pending').length;
      toast.success(
        'Targeted material queue ready',
        `${pending} job${pending !== 1 ? 's' : ''} pending across ${weakTopics.length} weak topic${weakTopics.length !== 1 ? 's' : ''}.`,
      );
    } catch (error) {
      setTargetedError(error?.message || String(error));
    } finally {
      setTargetedBusy(false);
    }
  }

  async function handleTargetedRunAll() {
    setTargetedBusy(true);
    setTargetedError('');
    try {
      const current = await readTargetedQueue();
      const pending = current.filter((job) => job.status === 'pending');
      let errors = 0;
      for (const job of pending) {
        setTargetedRunningId(job.id);
        const result = await runTargetedMaterialJob(job);
        if (result.status === 'error') errors += 1;
      }
      const refreshed = await readTargetedQueue();
      setTargetedQueue(refreshed);
      if (errors > 0) {
        toast.warning('Targeted material partial', `${errors} job${errors !== 1 ? 's' : ''} failed — see status below.`);
      } else if (pending.length > 0) {
        toast.success('Targeted material complete', `${pending.length} job${pending.length !== 1 ? 's' : ''} finished.`);
      }
    } catch (error) {
      setTargetedError(error?.message || String(error));
    } finally {
      setTargetedRunningId(null);
      setTargetedBusy(false);
    }
  }

  async function handleTargetedClear() {
    await clearTargetedQueue();
    setTargetedQueue([]);
    toast.info('Queue cleared', 'Generate jobs again any time.');
  }

  async function handleFsrsFit() {
    setFsrsBusy(true);
    setFsrsError('');
    setFsrsFit(null);
    try {
      const rows = await db.questionResults.toArray();
      const report = await fitFSRSInWorker(rows);
      setFsrsFit(report);
      if (!report.ok) {
        setFsrsError(report.reason || 'Could not fit parameters.');
      }
    } catch (error) {
      setFsrsError(error?.message || String(error));
    } finally {
      setFsrsBusy(false);
    }
  }

  async function handleFsrsApply() {
    if (!fsrsFit?.ok) return;
    await persistOptimizedParameters(fsrsFit);
    setSchedulerParameters({
      request_retention: fsrsFit.optimizedParameters.request_retention,
      w: fsrsFit.optimizedParameters.w,
    });
    setFsrsCustom(await readPersistedParameters());
    toast.success('FSRS parameters applied', 'Future reviews will use your personalised schedule.');
  }

  async function handleFsrsReset() {
    await clearPersistedParameters();
    setSchedulerParameters(undefined);
    setFsrsCustom(null);
    setFsrsFit(null);
    toast.info('FSRS reset', 'Scheduler reverted to FSRS-4.5 defaults.');
  }

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
      anchor.download = `studyvault-source-${new Date().toISOString().slice(0, 10)}.qvsource`;
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
    // Also refresh the LSAT backend's own AI/provider health — the LSAT sidecar
    // talks to the same local model servers, so a host pass with an LSAT
    // failure (e.g. sidecar down, provider switched) is worth surfacing.
    checkLsatBackendHealth().then(setLsatHealth);
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

  // audit M1 — consume the rollback snapshots that were previously write-only.
  // A snapshot is captured before every import/repair/reset; this restores the
  // most recent one (and importVaultData captures a fresh rollback point first,
  // so the restore is itself reversible).
  async function handleRestoreLatestSnapshot() {
    const latest = vaultHealth?.rollbackSnapshots?.[0];
    if (!latest) {
      toast.info('No rollback snapshot', 'One is captured automatically before every import, repair, or reset.');
      return;
    }
    if (
      !window.confirm(
        `Restore the vault from the snapshot taken at ${latest.createdAt}${latest.reason ? ` (${latest.reason})` : ''}? ` +
          'This replaces current local data — a fresh rollback point is captured first.',
      )
    ) {
      return;
    }
    try {
      await restoreRollbackSnapshot(latest.id);
      const report = await getVaultHealthReport();
      setVaultHealth(report);
      setMessage(`Vault restored from the ${latest.reason || 'manual'} snapshot taken at ${latest.createdAt}.`);
      toast.success('Vault restored', `Rolled back to the snapshot from ${latest.createdAt}.`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Restore failed.';
      setMessage(detail);
      toast.error('Restore failed', detail);
    }
  }

  // AUDIT-2 — unified {host, lsat} backup. Bundles the Dexie host vault AND the
  // LSAT bank into one checksummed envelope (official content firewalled out).
  // Needs the LSAT backend; surfaces a clear message when it's offline.
  async function handleUnifiedExport() {
    setUnifiedBusy(true);
    try {
      const envelope = await exportUnifiedBackup();
      const counts = envelope.rowCounts || {};
      setMessage(`Unified backup downloaded (host + LSAT): ${counts.questions ?? 0} questions, ${counts.preptests ?? 0} preptests.`);
      toast.success('Unified backup ready', 'One file holds both your host vault and the LSAT bank.');
    } catch (err) {
      const detail = err instanceof UnifiedBackupError ? err.message : 'Could not build the unified backup.';
      setMessage(detail);
      toast.warning('Unified backup unavailable', detail);
    } finally {
      setUnifiedBusy(false);
    }
  }

  async function handleUnifiedRestore() {
    if (!pendingUnifiedFile) return;
    setUnifiedBusy(true);
    try {
      const text = await pendingUnifiedFile.text();
      const result = await importUnifiedBackup(text);
      setPendingUnifiedFile(null);
      const hostNote = result.hostApplied ? ' Host vault merged.' : '';
      setMessage(`Unified backup restored (LSAT bank).${hostNote} A reload is recommended.`);
      toast.success('Unified backup restored', `Applied from ${result.exportId}.`);
    } catch (err) {
      const detail = err instanceof UnifiedBackupError ? err.message : 'Could not restore the unified backup.';
      setMessage(detail);
      toast.error('Restore failed', detail);
    } finally {
      setUnifiedBusy(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Encrypted export/import (AES-GCM-256 over PBKDF2-SHA256, 200k iterations)
  //
  // Uses the new `encryptedBackup` library — a thin standalone envelope around
  // the existing plaintext export. The legacy "Encrypted Backup" button in the
  // PageHeader still calls the old in-progressStore encryption path; this
  // section is the user-facing replacement that we recommend in the help copy.
  // ---------------------------------------------------------------------------
  async function handleEncryptedExportV2() {
    if (backupPassphrase.length < 8) {
      setMessage('Encrypted export needs a passphrase of at least 8 characters.');
      toast.warning('Passphrase too short', 'Use 8 characters or more.');
      return;
    }
    if (backupPassphrase !== backupPassphraseConfirm) {
      setMessage('Passphrases do not match.');
      toast.warning('Passphrase mismatch', 'Re-type the same passphrase in both fields.');
      return;
    }
    setEncryptedBusy(true);
    try {
      const plaintext = await exportVaultData();
      const blob = await encryptVaultBackup(JSON.stringify(plaintext), backupPassphrase);
      const file = new Blob([JSON.stringify(blob, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(file);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `studyvault-encrypted-${new Date().toISOString().slice(0, 10)}.qvenc.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setBackupPassphrase('');
      setBackupPassphraseConfirm('');
      const summary = 'Encrypted backup downloaded as .qvenc.json. Store the passphrase separately — without it the blob is unrecoverable.';
      setMessage(summary);
      toast.success('Encrypted backup ready', summary);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Could not encrypt the vault backup.';
      setMessage(detail);
      toast.error('Encrypted export failed', detail);
    } finally {
      setEncryptedBusy(false);
    }
  }

  async function handleImportEncryptedBackup() {
    if (!pendingEncryptedFile) {
      setMessage('Pick a .qvenc.json file to import first.');
      return;
    }
    if (!encryptedImportPassphrase) {
      setMessage('Enter the passphrase the file was encrypted with.');
      return;
    }
    setEncryptedBusy(true);
    try {
      const text = await pendingEncryptedFile.text();
      const envelope = JSON.parse(text);
      const plaintext = await decryptVaultBackup(envelope, encryptedImportPassphrase);
      const payload = JSON.parse(plaintext);
      await importVaultData(payload, 'merge');
      setEncryptedImportPassphrase('');
      setPendingEncryptedFile(null);
      const summary = `Imported encrypted backup ${pendingEncryptedFile.name} into the local vault (merge).`;
      setMessage(summary);
      toast.success('Encrypted backup imported', summary);
      const nextHealth = await getVaultHealthReport();
      setVaultHealth(nextHealth);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Could not import the encrypted backup.';
      setMessage(detail);
      toast.error('Encrypted import failed', detail);
    } finally {
      setEncryptedBusy(false);
    }
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

  // Hybrid curriculum search — routes through the active StorageDriver, so
  // it transparently picks up the SurrealDB backend after a successful
  // switchToSurreal() without any UI change.
  async function handleChunkSearch() {
    const q = chunkQuery.trim();
    if (!q) {
      setChunkHits([]);
      setChunkError('');
      return;
    }
    setChunkBusy(true);
    setChunkError('');
    try {
      const driver = getStorage();
      if (!driver.chunks?.search) {
        setChunkError('Active storage driver does not support chunk search.');
        setChunkHits([]);
        return;
      }
      const hits = await driver.chunks.search({ query: q, limit: 6 });
      setChunkHits(hits);
    } catch (err) {
      setChunkError(err?.message || 'Search failed.');
      setChunkHits([]);
    } finally {
      setChunkBusy(false);
    }
  }

  // OPS-3: map the aggregated ok/degraded/error verdict to a StatusBadge tone +
  // label for the header badge. Neutral ("checking") until the first poll lands.
  const healthVerdict = aggregatedHealth?.verdict ?? null;
  const HEALTH_BADGE = {
    ok: { tone: 'vault', label: 'All systems OK' },
    degraded: { tone: 'warning', label: 'Degraded' },
    error: { tone: 'danger', label: 'Service down' },
  };
  const healthBadge = healthVerdict ? HEALTH_BADGE[healthVerdict] : null;

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
          <div className="qv-row-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            {/* OPS-3: single rolled-up health verdict (sidecar supervision +
                LSAT backend internal health). Neutral "checking…" until the
                first poll completes. */}
            <StatusBadge
              tone={healthBadge?.tone ?? 'muted'}
              title={
                aggregatedHealth?.sidecars
                  ? `${aggregatedHealth.sidecars.ready}/${aggregatedHealth.sidecars.total} sidecars ready${
                      aggregatedHealth.sidecars.required_down_names.length
                        ? ` · down: ${aggregatedHealth.sidecars.required_down_names.join(', ')}`
                        : ''
                    }`
                  : 'Aggregated readiness across all local services'
              }
            >
              <Gauge size={12} aria-hidden="true" /> {healthBadge?.label ?? 'Checking…'}
            </StatusBadge>
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

      <Surface tone="vault" status={activeDriver === 'surrealdb' ? 'success' : undefined} className="ops-report-panel">
        <div className="flex-between" style={{ gap: 'var(--space-4)', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <StatusBadge tone="vault">Storage Backend</StatusBadge>
            <h3 className="qv-m-0 qv-mt-2">
              <ServerCog size={18} aria-hidden="true" style={{ verticalAlign: 'text-bottom', marginRight: 'var(--space-1)' }} />
              Active store: <span className="qv-mono">{activeDriver === 'surrealdb' ? 'SurrealDB (:8000)' : 'Dexie (IndexedDB)'}</span>
            </h3>
            <p className="qv-text-secondary qv-m-0">
              StudyVault runs on the local Dexie/IndexedDB store by default. If the SurrealDB sidecar is running (Tauri shell, port 8000) you can cut over to it — settings, the FSRS review queue, attempt log, and mastery snapshots migrate automatically. Curriculum chunks rebuild on the next ingest. Roll back to Dexie any time; your IndexedDB data is never cleared.
            </p>
            {driverPref === 'surrealdb' && activeDriver === 'dexie' && (
              <p className="qv-text-warning qv-m-0 qv-mt-2 qv-fs-sm">
                Preference is SurrealDB but the sidecar was unreachable at startup — currently serving from local Dexie.
              </p>
            )}
            {cutoverReport && (
              <div className="qv-mt-2 qv-fs-sm qv-text-secondary">
                Migrated: <span className="qv-mono">{cutoverReport.settings}</span> settings ·{' '}
                <span className="qv-mono">{cutoverReport.reviewItems}</span> review items ·{' '}
                <span className="qv-mono">{cutoverReport.questionResults}</span> attempts ·{' '}
                <span className="qv-mono">{cutoverReport.masterySnapshots}</span> mastery snapshots ·{' '}
                <span className="qv-mono">{cutoverReport.chunks ?? 0}</span> chunks
                {cutoverReport.chunksEmbeddingsDropped
                  ? ` (${cutoverReport.chunksEmbeddingsDropped} embedding${cutoverReport.chunksEmbeddingsDropped === 1 ? '' : 's'} dropped — dimension mismatch)`
                  : ''}
                .
              </div>
            )}
            {cutoverManifest && (
              <div className="qv-mt-2 qv-fs-sm qv-text-secondary">
                <strong>Migration preview</strong> ({cutoverManifest.from} → {cutoverManifest.to}):{' '}
                {cutoverManifest.namespaces.map((ns) => (
                  <span key={ns.namespace}>
                    <span className="qv-mono">{ns.sourceCount}</span> {ns.namespace} ·{' '}
                  </span>
                ))}
                <span className="qv-mono">{cutoverManifest.chunks.sourceCount}</span> chunks
                {cutoverManifest.chunks.dimension != null
                  ? ` (${cutoverManifest.chunks.embedded} embedded @ dim ${cutoverManifest.chunks.dimension})`
                  : ''}
                .{' '}
                {cutoverManifest.safe ? (
                  <span className="qv-text-success">Safe to migrate.</span>
                ) : (
                  <span className="qv-text-warning">
                    Blocked: {cutoverManifest.blockers.join('; ')}.
                  </span>
                )}
              </div>
            )}
            {cutoverError && <p className="qv-text-danger qv-m-0 qv-mt-2 qv-fs-sm">{cutoverError}</p>}
          </div>
          <div className="qv-row-2" style={{ flexWrap: 'wrap' }}>
            {activeDriver !== 'surrealdb' ? (
              <>
                <button className="btn btn-secondary btn-sm" onClick={handlePreviewCutover} disabled={cutoverBusy}>
                  {cutoverBusy ? 'Working…' : 'Preview migration'}
                </button>
                <button className="btn btn-primary btn-sm" onClick={handleCutoverToSurreal} disabled={cutoverBusy}>
                  {cutoverBusy ? 'Switching…' : 'Switch to SurrealDB'}
                </button>
              </>
            ) : (
              <button className="btn btn-secondary btn-sm" onClick={handleRollbackToDexie} disabled={cutoverBusy}>
                {cutoverBusy ? 'Switching…' : 'Roll back to Dexie'}
              </button>
            )}
          </div>
        </div>
      </Surface>

      <Surface
        tone="ops"
        status={lsatHealth == null ? undefined : lsatHealth.ok ? 'success' : 'warning'}
        className="ops-report-panel"
      >
        <div className="flex-between" style={{ gap: 'var(--space-4)', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <StatusBadge tone="exam">LSAT Backend</StatusBadge>
            <h3 className="qv-m-0 qv-mt-2">
              <ServerCog size={18} aria-hidden="true" style={{ verticalAlign: 'text-bottom', marginRight: 'var(--space-1)' }} />
              LSAT sidecar{' '}
              <span className="qv-mono">
                {lsatHealth == null ? '(checking…)' : lsatHealth.ok ? ':8100 · healthy' : ':8100 · offline'}
              </span>
            </h3>
            <p className="qv-text-secondary qv-m-0">
              The LSAT domain is served by a local FastAPI sidecar (SQLite question bank, spaced repetition, AI explanations). It boots with the desktop shell; in browser dev, start it manually on port 8100.
            </p>
            {lsatHealth && (
              <p
                className={`qv-m-0 qv-mt-2 qv-fs-sm ${lsatHealth.ok ? 'qv-text-success' : 'qv-text-warning'}`}
              >
                {lsatHealth.detail}
                {lsatHealth.ok && lsatHealth.latencyMs != null ? ` (${lsatHealth.latencyMs}ms)` : ''}
                {lsatHealth.ai?.provider ? ` · provider: ${lsatHealth.ai.provider}` : ''}
              </p>
            )}
            {/* S5-A: read-only view of the LSAT backend's effective model
                routing (edit it via the deep-link below). */}
            {lsatHealth?.ai?.models && (
              <p className="qv-m-0 qv-mt-1 qv-fs-sm qv-text-muted qv-mono">
                {[
                  lsatHealth.ai.models.explain && `explain: ${lsatHealth.ai.models.explain}`,
                  lsatHealth.ai.models.gen && `gen: ${lsatHealth.ai.models.gen}`,
                  lsatHealth.ai.models.diagnose && `diagnose: ${lsatHealth.ai.models.diagnose}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            )}
            {lsatHealth?.ai?.missingModels && (
              <p className="qv-m-0 qv-mt-1 qv-fs-sm qv-text-warning">
                Configured model{lsatHealth.ai.missingModels.length > 1 ? 's' : ''} not loaded in the active provider:{' '}
                <span className="qv-mono">{lsatHealth.ai.missingModels.join(', ')}</span> — pull/load{' '}
                {lsatHealth.ai.missingModels.length > 1 ? 'them' : 'it'} or change the routing in LSAT model settings.
              </p>
            )}
            {/* DATA-3: cross-domain schema-version handshake ("data planes
                aligned"). aligned = both planes speak the same shared-field
                contract → cross-domain writes are safe. mismatch / unreachable →
                cross-domain writes disabled (local Dexie data is unaffected). */}
            {dataAlignment && (
              <p
                className={`qv-m-0 qv-mt-2 qv-fs-sm ${
                  dataAlignment.status === 'aligned'
                    ? 'qv-text-success'
                    : dataAlignment.status === 'mismatch'
                      ? 'qv-text-danger'
                      : 'qv-text-warning'
                }`}
              >
                Data planes{' '}
                {dataAlignment.status === 'aligned'
                  ? 'aligned'
                  : dataAlignment.status === 'mismatch'
                    ? 'mismatch'
                    : 'unverified'}
                {' · '}
                <span className="qv-mono">
                  host v{dataAlignment.hostVersion}
                  {dataAlignment.backendVersion != null ? ` / LSAT v${dataAlignment.backendVersion}` : ' / LSAT —'}
                </span>
                {' · '}
                cross-domain writes {dataAlignment.crossDomainWritesEnabled ? 'enabled' : 'disabled'}
                {'. '}
                {dataAlignment.detail}
              </p>
            )}
          </div>
          <div className="qv-row-2" style={{ flexWrap: 'wrap' }}>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setLsatHealth(null);
                checkLsatBackendHealth().then(setLsatHealth);
                setDataAlignment(null);
                fetchDataSchemaAlignment().then(setDataAlignment);
              }}
            >
              Re-check
            </button>
            {/* S5-B: push the host's provider/endpoint to the LSAT backend so
                both domains use the same local model server. */}
            <button
              className="btn btn-secondary btn-sm"
              disabled={!llm?.baseUrl || !lsatHealth?.ok}
              title={
                !llm?.baseUrl
                  ? 'Configure a host model server first (Local AI below)'
                  : !lsatHealth?.ok
                    ? 'LSAT sidecar must be reachable'
                    : 'Set LSAT to use the host model provider'
              }
              onClick={async () => {
                const result = await syncProviderToLsat({ baseUrl: llm?.baseUrl });
                setMessage(result.detail);
                checkLsatBackendHealth().then(setLsatHealth);
              }}
            >
              Match host provider
            </button>
            {/* INT-2: full model-routing editor (per-role ids + provider) —
                writes PUT /api/settings then re-probes both health checks. */}
            <button
              className="btn btn-secondary btn-sm"
              disabled={!lsatHealth?.ok}
              title={lsatHealth?.ok ? 'Edit the LSAT model routing' : 'LSAT sidecar must be reachable'}
              onClick={() => setRoutingModalOpen(true)}
            >
              Edit routing
            </button>
            <a className="btn btn-secondary btn-sm" href={LSAT_SETTINGS_PATH}>
              LSAT model settings
            </a>
          </div>
        </div>
      </Surface>

      {/* INT-2: model-routing edit modal. Seeded from the host Local-AI settings
          and the LSAT AI-health probe; the schema-version stamp is read from the
          DATA-3 schema-version handshake already surfaced above. On save it
          refreshes the read-only routing display via setLsatHealth. */}
      <EditModelRoutingModal
        open={routingModalOpen}
        onClose={() => setRoutingModalOpen(false)}
        host={llm ? { baseUrl: llm.baseUrl, model: llm.model } : null}
        lsat={lsatHealth?.ai ?? null}
        schemaVersion={dataAlignment?.backendVersion ?? null}
        onSaved={(health) => {
          setLsatHealth(health);
          setRoutingModalOpen(false);
        }}
        onMessage={setMessage}
      />

      {/* OPS-1: unified sidecar console. The desktop shell supervises four
          local sidecars — SurrealDB (:8000), the open-notebook API (:5055) and
          its job worker, and the LSAT backend (:8100) — auto-restarting any
          that fall over (BA1) and capturing each one's stdout/stderr into a
          rolling ring buffer (BA8). This panel reads the native
          get_sidecar_status / get_sidecar_logs commands; outside the desktop
          shell (browser dev) those commands don't exist, so it renders a plain
          "desktop-app only" note rather than an empty list. */}
      <Surface
        tone="ops"
        status={
          sidecars == null
            ? undefined
            : sidecars.some((s) => !s.ready)
              ? 'warning'
              : 'success'
        }
        className="ops-report-panel"
      >
        <div className="flex-between" style={{ gap: 'var(--space-4)', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <StatusBadge tone="ops">Sidecars</StatusBadge>
            <h3 className="qv-m-0 qv-mt-2">
              <Boxes size={18} aria-hidden="true" style={{ verticalAlign: 'text-bottom', marginRight: 'var(--space-1)' }} />
              Supervised local services{' '}
              <span className="qv-mono">
                {sidecars == null
                  ? '(desktop only)'
                  : `${sidecars.filter((s) => s.ready).length}/${sidecars.length} ready`}
              </span>
            </h3>
            <p className="qv-text-secondary qv-m-0">
              StudyVault&apos;s data, RAG, and LSAT engines run as background sidecars launched by the desktop shell.
              The supervisor probes each one&apos;s readiness port every few seconds and auto-restarts any that crash;
              expand a service to tail its captured stdout/stderr.
            </p>
            {sidecars == null && (
              <p className="qv-m-0 qv-mt-2 qv-fs-sm qv-text-muted">
                Sidecar supervision is a desktop-app feature — the native status/log commands are only available inside
                the StudyVault desktop shell. In browser dev, start the sidecars manually and use each service&apos;s own
                health card above.
              </p>
            )}
          </div>
          <div className="qv-row-2" style={{ flexWrap: 'wrap' }}>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => refreshSidecars(true)}
              disabled={sidecarsBusy}
            >
              <RefreshCw size={14} style={{ marginRight: 'var(--space-1)' }} />
              {sidecarsBusy ? 'Refreshing…' : 'Re-check'}
            </button>
          </div>
        </div>
        {sidecars && sidecars.length > 0 && (
          <div className="qv-stack-3" style={{ marginTop: 'var(--space-4)' }}>
            {sidecars.map((sidecar) => {
              const expanded = openSidecarLog === sidecar.name;
              const port = sidecar.ready_port ?? sidecar.port;
              return (
                <div
                  key={sidecar.name}
                  className="surface surface-default surface-compact"
                  style={{ padding: 'var(--space-3)' }}
                >
                  <div className="flex-between" style={{ gap: 'var(--space-3)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="qv-row-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                        <StatusBadge tone={sidecar.ready ? 'vault' : 'warning'}>
                          {sidecar.ready ? 'Ready' : 'Down'}
                        </StatusBadge>
                        <strong className="qv-fs-sm">{sidecar.name}</strong>
                        <span className="qv-fs-sm qv-text-muted qv-mono">
                          <Network size={13} aria-hidden="true" style={{ verticalAlign: 'text-bottom', marginRight: 2 }} />
                          {port == null ? 'no socket' : `:${port}`}
                        </span>
                      </div>
                      <p className="qv-m-0 qv-mt-1 qv-fs-sm qv-text-muted qv-mono">
                        {sidecar.healthy ? 'healthy' : 'unhealthy'}
                        {' · '}
                        {sidecar.pid != null ? `pid ${sidecar.pid}` : 'no pid'}
                        {sidecar.depends_on.length > 0 ? ` · depends on ${sidecar.depends_on.join(', ')}` : ''}
                      </p>
                    </div>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleToggleSidecarLog(sidecar.name)}
                      aria-expanded={expanded}
                    >
                      <Terminal size={14} style={{ marginRight: 'var(--space-1)' }} />
                      {expanded ? 'Hide logs' : 'View logs'}
                    </button>
                  </div>
                  {expanded && (
                    <div className="qv-mt-3">
                      {sidecarLogBusy ? (
                        <p className="qv-m-0 qv-fs-sm qv-text-muted">Loading log tail…</p>
                      ) : sidecarLogLines.length === 0 ? (
                        <p className="qv-m-0 qv-fs-sm qv-text-muted">
                          No output captured yet for this sidecar.
                        </p>
                      ) : (
                        <pre
                          aria-label={`${sidecar.name} log tail`}
                          className="qv-fs-xs qv-mono qv-m-0"
                          style={{
                            maxHeight: 220,
                            overflow: 'auto',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            padding: 'var(--space-2)',
                            borderRadius: 'var(--radius-sm)',
                            background: 'var(--color-bg-canvas)',
                            border: '1px solid var(--color-border)',
                          }}
                        >
                          {sidecarLogLines.join('\n')}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {sidecars && sidecars.length === 0 && (
          <p className="qv-text-secondary qv-m-0 qv-mt-3 qv-fs-sm">
            No sidecars are currently tracked by the supervisor.
          </p>
        )}
      </Surface>

      {/* OPS-2: Trust & Release cockpit. Rolls the LSAT backend's release-trust
          manifest (GET /api/observability/trust) into one ok/warning/blocked
          status with an expandable per-check tree + next-actions, and folds in
          host-side checks (offline readiness, Dexie quota, SurrealDB/LSAT
          health) so it stays useful even with the sidecar down. */}
      <TrustReleasePanel
        manifest={trust.manifest}
        loading={trust.loading}
        refreshing={trust.refreshing}
        reachable={trust.reachable}
        hostChecks={trust.hostChecks}
        fetchedAt={trust.fetchedAt}
        onRefresh={trust.refresh}
      />

      {/* OPS-4: Maintenance panel. Wires the LSAT backend's local-upkeep
          scheduler (scheduled tasks: run-now / pause / cadence + recent run
          history) into the cockpit, surfaces client guardrail banners
          (cloud-budget pressure, IndexedDB-quota pressure, local-model outage)
          evaluated from already-loaded page state, and offers a one-click
          diagnostics export bundling the trust manifest, runtime evidence,
          sidecar logs, and cloud metrics into a timestamped JSON. Fully
          degrading — a down sidecar leaves the panel visible with an honest
          offline note. */}
      <MaintenancePanel
        trustManifest={trust.manifest}
        aggregatedHealth={aggregatedHealth}
        cloudBudget={cloudBudget}
        storageEstimate={storage}
        onDownloadJson={downloadJson}
      />

      {/* OPS-3: Runtime Metrics — local runtime-gauge trend sparklines (cloud
          spend, LLM p50, gen queue depth, SQLite contention), the live web-vitals
          readout, and the LSAT backend's SQLite-health PRAGMA/WAL snapshot. The
          parent polls the aggregated health every ~10s and feeds the trend store;
          this tab subscribes to it and re-renders as samples arrive. Charts are
          self-contained inline SVG sparklines — dependency-free, no shared viz
          barrel. */}
      <RuntimeMetricsTab backend={aggregatedHealth?.backend ?? null} webVitals={webVitals} />

      {/* INT-5: Generation Quality — read-only observability over the LSAT
          generation pipeline (per-gate pass rates, worst q_types, validate /
          firewall audit feed). Self-contained + fully degrading: a down sidecar
          shows an honest "offline" note rather than throwing. */}
      <GenerationQualityPanel />

      {/* UC6: Core Web Vitals (LCP / CLS / INP), collected in-process via the
          browser-native PerformanceObserver. LOCAL-ONLY — nothing is sent
          anywhere; this is a self-diagnostic readout in place of remote RUM.
          Each value is rated against the published good / needs-improvement /
          poor thresholds. Values stay "—" until the browser reports an entry
          (LCP after first paint; CLS/INP after layout shifts / interactions). */}
      <Surface
        tone="ops"
        status={
          [webVitals.LCP, webVitals.CLS, webVitals.INP].some((m) => m.rating === 'poor')
            ? 'danger'
            : [webVitals.LCP, webVitals.CLS, webVitals.INP].some((m) => m.rating === 'needs-improvement')
              ? 'warning'
              : [webVitals.LCP, webVitals.CLS, webVitals.INP].some((m) => m.rating !== 'pending')
                ? 'success'
                : undefined
        }
        className="ops-report-panel"
      >
        <div className="flex-between" style={{ gap: 'var(--space-4)', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <StatusBadge tone="exam">Performance</StatusBadge>
            <h3 className="qv-m-0 qv-mt-2">
              <Gauge size={18} aria-hidden="true" style={{ verticalAlign: 'text-bottom', marginRight: 'var(--space-1)' }} />
              Core Web Vitals{' '}
              <span className="qv-mono">{webVitals.supported ? 'observing' : 'unavailable'}</span>
            </h3>
            <p className="qv-text-secondary qv-m-0">
              Render-quality metrics measured in-app with the browser&apos;s PerformanceObserver. Fully local — no
              remote analytics. Lower is better; each is rated against the standard good / needs-improvement / poor
              thresholds. Interact with the app to populate INP.
            </p>
          </div>
        </div>
        <div className="coverage-grid" style={{ marginTop: 'var(--space-4)' }}>
          {[webVitals.LCP, webVitals.CLS, webVitals.INP].map((metric) => {
            const thresholds = getWebVitalThresholds(metric.name);
            return (
              <div key={metric.name}>
                <strong className={VITAL_TONE[metric.rating]}>{formatWebVital(metric.name, metric.value)}</strong>
                <small>
                  {metric.name} · {VITAL_LABELS[metric.name]}
                </small>
                <small className="qv-text-muted">
                  {metric.rating === 'pending' ? 'awaiting data' : metric.rating} · good ≤{' '}
                  {thresholds.unit === 'ms' ? `${thresholds.good} ms` : thresholds.good}
                </small>
              </div>
            );
          })}
        </div>
      </Surface>

      {/* BB4: opt-in cloud spend vs the configured monthly budget, plus a
          read-only NEXT-CALL dry-run cost estimate. The LSAT sidecar is the only
          thing that ever talks to a cloud model; realtime/score-affecting paths
          stay local-only. Card hides when the sidecar is unreachable. */}
      {cloudBudget?.ok && cloudBudget.cloud && (
        <Surface
          tone="ops"
          status={
            cloudBudget.cloud.budget_usd != null && !cloudBudget.cloud.within_budget
              ? 'warning'
              : 'success'
          }
          className="ops-report-panel"
        >
          <div className="flex-between" style={{ gap: 'var(--space-4)', alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <StatusBadge tone="exam">Cloud Budget</StatusBadge>
              <h3 className="qv-m-0 qv-mt-2">
                <CloudCog size={18} aria-hidden="true" style={{ verticalAlign: 'text-bottom', marginRight: 'var(--space-1)' }} />
                Opt-in cloud spend{' '}
                <span className="qv-mono">
                  {cloudBudget.cloud.cloud_enabled ? 'enabled' : 'disabled (local-only)'}
                </span>
              </h3>
              <p className="qv-text-secondary qv-m-0">
                Realtime explanations and all score-affecting content run on local models. Only opt-in Tier-B
                generation may use a cloud provider, and never past the monthly cap.
                {cloudBudget.cloud.budget_usd == null
                  ? ' No monthly budget is set — cloud stays opt-in either way.'
                  : ''}
              </p>
              {cloudBudget.cloud.budget_usd != null && !cloudBudget.cloud.within_budget && (
                <p className="qv-m-0 qv-mt-2 qv-fs-sm qv-text-warning">
                  Monthly budget reached — further cloud calls fall back to the local model until next month.
                </p>
              )}
              {cloudBudget.cloud.next_call?.would_exceed_budget && cloudBudget.cloud.within_budget && (
                <p className="qv-m-0 qv-mt-2 qv-fs-sm qv-text-warning">
                  A typical next call ({cloudBudget.cloud.next_call.estimated_cost_usd.toFixed(4)} USD) would push
                  spend past the cap — it would run locally instead.
                </p>
              )}
            </div>
            <div className="qv-row-2" style={{ flexWrap: 'wrap' }}>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => refreshCloudBudget(true)}
                disabled={cloudBudgetBusy}
              >
                {cloudBudgetBusy ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
          </div>
          <div className="coverage-grid" style={{ marginTop: 'var(--space-4)' }}>
            <div>
              <strong>${cloudBudget.cloud.spend_usd.toFixed(4)}</strong>
              <small>Spent this month</small>
            </div>
            <div>
              <strong>{cloudBudget.cloud.budget_usd == null ? 'None' : `$${cloudBudget.cloud.budget_usd.toFixed(2)}`}</strong>
              <small>Monthly budget</small>
            </div>
            <div>
              <strong>{cloudBudget.cloud.remaining_usd == null ? '∞' : `$${cloudBudget.cloud.remaining_usd.toFixed(4)}`}</strong>
              <small>Remaining</small>
            </div>
            <div>
              <strong>${cloudBudget.cloud.next_call?.estimated_cost_usd?.toFixed(4) ?? '0.0000'}</strong>
              <small>Next-call dry-run</small>
            </div>
          </div>
          {cloudBudget.cloud.next_call && (
            <p className="qv-m-0 qv-mt-3 qv-fs-sm qv-text-muted qv-mono">
              dry-run priced on {cloudBudget.cloud.next_call.input_tokens} in · {cloudBudget.cloud.next_call.output_tokens} out
              {' · '}${cloudBudget.cloud.pricing?.input_cost_per_mtok_usd}/Mtok in · ${cloudBudget.cloud.pricing?.output_cost_per_mtok_usd}/Mtok out
            </p>
          )}
        </Surface>
      )}

      {/* BB4: local Whisper/voice STT model download visibility. The model runs
          fully offline in-browser via transformers.js once cached; the browser-
          STT (Web Speech API) fallback is always available and needs no
          download. The sidecar's voice report covers any server-side cache. */}
      <Surface
        tone="ops"
        status={whisperBrowserCached ? 'success' : whisperDownloadState === 'error' ? 'warning' : undefined}
        className="ops-report-panel"
      >
        <div className="flex-between" style={{ gap: 'var(--space-4)', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <StatusBadge tone="exam">Voice Input</StatusBadge>
            <h3 className="qv-m-0 qv-mt-2">
              <Mic2 size={18} aria-hidden="true" style={{ verticalAlign: 'text-bottom', marginRight: 'var(--space-1)' }} />
              Offline Whisper model{' '}
              <span className="qv-mono">
                {whisperBrowserCached === null
                  ? '(checking…)'
                  : whisperBrowserCached
                    ? 'downloaded'
                    : 'not downloaded'}
              </span>
            </h3>
            <p className="qv-text-secondary qv-m-0">
              Offline voice input runs Whisper-tiny (~40 MB ONNX) entirely in your browser — downloaded once, then
              cached locally with no cloud round-trip during recognition.
              {whisperBrowserCached === false
                ? ' Download it now so the first voice session is instant and works offline.'
                : ''}
            </p>
            <p className="qv-m-0 qv-mt-2 qv-fs-sm qv-text-muted">
              Fallback:{' '}
              {browserSttSupported
                ? 'the browser Web Speech API is available if you skip the download (Chrome uses cloud STT; Safari/Edge are on-device).'
                : 'the browser Web Speech API is unavailable here, so the Whisper download is required for voice input.'}
            </p>
            {cloudBudget?.voice && (
              <p className="qv-m-0 qv-mt-1 qv-fs-sm qv-text-muted qv-mono">
                model: {cloudBudget.voice.model_id}
                {cloudBudget.voice.cache_dir_exists && cloudBudget.voice.downloaded
                  ? ` · server cache: ${Math.round(cloudBudget.voice.size_bytes / 1024 / 1024)} MB`
                  : ''}
              </p>
            )}
            {whisperDownloadState === 'downloading' && (
              <div className="qv-mt-3" aria-live="polite">
                <div
                  role="progressbar"
                  aria-valuenow={whisperDownloadPct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Voice model download progress"
                  style={{ height: 6, borderRadius: 3, background: 'var(--color-border)', overflow: 'hidden' }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${whisperDownloadPct}%`,
                      background: 'var(--color-accent, var(--color-primary))',
                      transition: 'width 0.2s ease',
                    }}
                  />
                </div>
                <p className="qv-m-0 qv-mt-1 qv-fs-sm qv-text-secondary">Downloading voice model… {whisperDownloadPct}%</p>
              </div>
            )}
            {whisperDownloadState === 'error' && whisperError && (
              <p className="qv-m-0 qv-mt-2 qv-fs-sm qv-text-warning">{whisperError}</p>
            )}
          </div>
          <div className="qv-row-2" style={{ flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary btn-sm"
              onClick={handleWhisperDownload}
              disabled={whisperDownloadState === 'downloading'}
              title={
                whisperBrowserCached
                  ? 'Re-download the offline voice model'
                  : 'Download the offline voice model (~40 MB, one time)'
              }
            >
              <Download size={14} style={{ marginRight: 'var(--space-1)' }} />
              {whisperDownloadState === 'downloading'
                ? 'Downloading…'
                : whisperBrowserCached
                  ? 'Re-download'
                  : 'Download voice model'}
            </button>
          </div>
        </div>
      </Surface>

      {/* P5: last render crash, persisted by the host ErrorBoundary. Only shown
          when one exists — a local-first diagnostics readout in place of remote
          telemetry. */}
      {lastCrash && (
        <Surface tone="ops" status="warning" className="ops-report-panel">
          <div className="flex-between" style={{ gap: 'var(--space-4)', alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <StatusBadge tone="exam">Diagnostics</StatusBadge>
              <h3 className="qv-m-0 qv-mt-2">Last render crash</h3>
              <p className="qv-m-0 qv-mt-2 qv-fs-sm qv-text-warning qv-mono" style={{ wordBreak: 'break-word' }}>
                {lastCrash.message || '(no message)'}
              </p>
              <p className="qv-m-0 qv-mt-1 qv-fs-sm qv-text-secondary">
                {lastCrash.name && lastCrash.name !== 'unknown' ? `boundary: ${lastCrash.name} · ` : ''}
                {lastCrash.route ? `route: ${lastCrash.route} · ` : ''}
                {new Date(lastCrash.ts).toLocaleString()}
              </p>
            </div>
            <div className="qv-row-2" style={{ flexWrap: 'wrap' }}>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  clearLastCrash();
                  setLastCrash(null);
                }}
              >
                Clear
              </button>
            </div>
          </div>
        </Surface>
      )}

      <Surface tone="vault" status={vaultHealth?.status === 'repair-needed' ? 'danger' : vaultHealth?.status === 'warning' ? 'warning' : 'success'} className="ops-report-panel">
        <div className="flex-between" style={{ gap: 'var(--space-4)', alignItems: 'flex-start' }}>
          <div>
            <StatusBadge tone="vault">Vault Safety</StatusBadge>
            <h3>Local Vault Health</h3>
            <p className="qv-text-secondary">
              Schema v{vaultHealth?.schemaVersion || '-'} · {vaultHealth?.schemaHash || 'checking'} · persistent storage {persisted === null ? 'unknown' : persisted ? 'granted' : 'not granted'}
            </p>
          </div>
          <div className="qv-row-2" style={{ flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={handleRepairPreview}><Wrench size={16} /> Repair Preview</button>
            <button
              className="btn btn-secondary"
              onClick={handleRestoreLatestSnapshot}
              disabled={!vaultHealth?.rollbackSnapshots?.length}
              title="Restore the vault from the most recent automatic rollback snapshot"
            >
              <History size={16} /> Restore Snapshot
            </button>
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
          <ul className="qv-text-secondary" style={{ marginTop: 'var(--space-4)' }}>
            {vaultHealth.repairActions.map((action) => <li key={action}>{action}</li>)}
          </ul>
        )}
      </Surface>

      <Surface tone="vault" className="ops-report-panel">
        <div className="qv-mb-3">
          <StatusBadge tone="vault">Encrypted Export</StatusBadge>
          <h3 style={{ margin: 'var(--space-2) 0 0' }}>AES-GCM-256 backup &amp; restore</h3>
          <p className="qv-text-secondary" style={{ marginBottom: 0 }}>
            Locally encrypts your full vault export with a passphrase (PBKDF2-SHA256, 200,000 iterations → 256-bit AES-GCM key).
            The downloaded <code className="qv-mono">.qvenc.json</code> is safe to keep alongside cloud sync — without the
            passphrase it is unrecoverable. Importing accepts the same format and merges into your local vault.
          </p>
        </div>
        <div className="grid-3" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
          <label className="qv-stack-1">
            <span className="qv-fs-xs qv-text-muted">Passphrase (min 8 chars)</span>
            <input
              className="input"
              type="password"
              minLength={8}
              value={backupPassphrase}
              onChange={(event) => setBackupPassphrase(event.target.value)}
              placeholder="passphrase"
              aria-label="Encrypted backup passphrase"
              autoComplete="new-password"
            />
          </label>
          <label className="qv-stack-1">
            <span className="qv-fs-xs qv-text-muted">Confirm passphrase</span>
            <input
              className="input"
              type="password"
              minLength={8}
              value={backupPassphraseConfirm}
              onChange={(event) => setBackupPassphraseConfirm(event.target.value)}
              placeholder="passphrase (again)"
              aria-label="Confirm encrypted backup passphrase"
              autoComplete="new-password"
            />
          </label>
          <div className="qv-stack-1" style={{ justifyContent: 'flex-end' }}>
            <button
              className="btn btn-primary"
              onClick={handleEncryptedExportV2}
              disabled={
                encryptedBusy ||
                backupPassphrase.length < 8 ||
                backupPassphrase !== backupPassphraseConfirm
              }
              title={
                backupPassphrase.length < 8
                  ? 'Passphrase must be at least 8 characters'
                  : backupPassphrase !== backupPassphraseConfirm
                    ? 'Passphrases do not match'
                    : 'Encrypt and download .qvenc.json'
              }
            >
              <KeyRound size={16} /> {encryptedBusy ? 'Working…' : 'Encrypted Export'}
            </button>
          </div>
        </div>
        <hr style={{ border: 'none', borderTop: '1px solid var(--color-border)', margin: 'var(--space-4) 0' }} />
        <div className="qv-mb-2">
          <strong>Import Encrypted Backup</strong>
          <p className="qv-text-secondary qv-fs-sm qv-m-0">
            Decrypts a <code className="qv-mono">.qvenc.json</code> file with its passphrase and merges the contained vault data.
          </p>
        </div>
        <div className="grid-3" style={{ gap: 'var(--space-3)' }}>
          <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} aria-disabled={encryptedBusy}>
            <Upload size={14} style={{ marginRight: 'var(--space-1)' }} />
            {pendingEncryptedFile ? pendingEncryptedFile.name : 'Pick .qvenc.json'}
            <input
              type="file"
              accept=".qvenc.json,.json,application/json"
              style={{ display: 'none' }}
              onChange={(event) => {
                const file = event.target.files?.[0] || null;
                setPendingEncryptedFile(file);
                event.target.value = '';
              }}
              disabled={encryptedBusy}
            />
          </label>
          <label className="qv-stack-1">
            <span className="qv-fs-xs qv-text-muted">Passphrase</span>
            <input
              className="input"
              type="password"
              value={encryptedImportPassphrase}
              onChange={(event) => setEncryptedImportPassphrase(event.target.value)}
              placeholder="passphrase used to encrypt"
              aria-label="Encrypted backup import passphrase"
              autoComplete="current-password"
            />
          </label>
          <div className="qv-stack-1" style={{ justifyContent: 'flex-end' }}>
            <button
              className="btn btn-secondary"
              onClick={handleImportEncryptedBackup}
              disabled={encryptedBusy || !pendingEncryptedFile || !encryptedImportPassphrase}
            >
              <Download size={16} /> {encryptedBusy ? 'Working…' : 'Import Encrypted Backup'}
            </button>
          </div>
        </div>
      </Surface>

      <Surface tone="vault" className="ops-report-panel">
        <div className="qv-mb-3">
          <StatusBadge tone="vault">Unified Backup</StatusBadge>
          <h3 style={{ margin: 'var(--space-2) 0 0' }}>One file for the whole vault (host + LSAT)</h3>
          <p className="qv-text-secondary" style={{ marginBottom: 0 }}>
            Bundles your host study vault (CFA / Quant / Excel) and the LSAT question bank into a single
            checksummed <code className="qv-mono">.json</code> envelope. Copyrighted official LSAT content is never
            included (provenance firewall). Requires the LSAT backend to be running — the host-only backups above
            keep working offline.
          </p>
        </div>
        <div className="qv-row-2" style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
          <button className="btn btn-primary" onClick={handleUnifiedExport} disabled={unifiedBusy}>
            <Download size={16} /> {unifiedBusy ? 'Working…' : 'Unified Backup'}
          </button>
          <label
            className="btn btn-secondary"
            style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
            aria-disabled={unifiedBusy}
          >
            <Upload size={14} style={{ marginRight: 'var(--space-1)' }} />
            {pendingUnifiedFile ? pendingUnifiedFile.name : 'Pick backup .json'}
            <input
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={(event) => {
                setPendingUnifiedFile(event.target.files?.[0] || null);
                event.target.value = '';
              }}
              disabled={unifiedBusy}
            />
          </label>
          <button
            className="btn btn-secondary"
            onClick={handleUnifiedRestore}
            disabled={unifiedBusy || !pendingUnifiedFile}
          >
            <Download size={16} /> {unifiedBusy ? 'Working…' : 'Restore Unified Backup'}
          </button>
        </div>
      </Surface>

      <Surface tone="ops" className="ops-report-panel">
        <div className="flex-between" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
          <div>
            <StatusBadge tone="exam">FSRS Tuning</StatusBadge>
            <h3 className="qv-m-0 qv-mt-2">Personalised spaced-repetition weights</h3>
            <p className="qv-text-secondary qv-m-0">
              Fit FSRS parameters to your own review history. Searches a principled subset of weights via coordinate descent against the binary-cross-entropy of your past predictions. Requires at least 50 historical reviews. Reverts to FSRS-4.5 library defaults with one click.
            </p>
            {fsrsCustom && (
              <p className="qv-text-success qv-m-0 qv-mt-2 qv-fs-sm">
                <strong>Active:</strong> request_retention ={' '}
                <span className="qv-mono">{fsrsCustom.request_retention.toFixed(3)}</span>, fit on{' '}
                {new Date(fsrsCustom.fittedAt).toLocaleDateString()} from{' '}
                {fsrsCustom.reviewCount} reviews · improvement{' '}
                {(fsrsCustom.improvement * 100).toFixed(1)}%
              </p>
            )}
            {fsrsFit?.ok && (
              <div className="qv-mt-2 qv-fs-sm qv-text-secondary">
                <div>
                  Original log-loss <span className="qv-mono">{fsrsFit.originalLoss.toFixed(3)}</span>{' '}
                  → fitted <span className="qv-mono">{fsrsFit.optimizedLoss.toFixed(3)}</span>{' '}
                  · <span className="qv-text-success">{(fsrsFit.improvement * 100).toFixed(1)}% improvement</span>
                </div>
                <div>
                  request_retention <span className="qv-mono">{fsrsFit.originalParameters.request_retention.toFixed(3)}</span>{' '}
                  → <span className="qv-mono">{fsrsFit.optimizedParameters.request_retention.toFixed(3)}</span>{' '}
                  · {fsrsFit.cardCount} cards · {fsrsFit.iterations} evaluations
                </div>
              </div>
            )}
            {fsrsError && (
              <p className="qv-text-danger qv-m-0 qv-mt-2 qv-fs-sm">{fsrsError}</p>
            )}
          </div>
          <div className="qv-row-2" style={{ flexWrap: 'wrap' }}>
            <button className="btn btn-secondary btn-sm" onClick={handleFsrsFit} disabled={fsrsBusy}>
              {fsrsBusy ? 'Fitting…' : 'Fit from history'}
            </button>
            {fsrsFit?.ok && (
              <button className="btn btn-primary btn-sm" onClick={handleFsrsApply} disabled={fsrsBusy}>
                Apply
              </button>
            )}
            {fsrsCustom && (
              <button className="btn btn-secondary btn-sm" onClick={handleFsrsReset} disabled={fsrsBusy}>
                Reset to FSRS-4.5
              </button>
            )}
          </div>
        </div>
      </Surface>

      <Surface tone="ops" className="ops-report-panel">
        <div className="flex-between" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <StatusBadge tone="exam">Item Psychometrics</StatusBadge>
            <h3 className="qv-m-0 qv-mt-2">IRT-lite item calibration</h3>
            <p className="qv-text-secondary qv-m-0">
              Per-item difficulty + point-biserial discrimination across your history. Surfaces too-easy, too-hard, and low-discrimination items so you can retire or revise them. All compute is local.
            </p>
            {psychReport && (
              <>
                <div className="qv-row-2 qv-mt-2" style={{ flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                  <span className="qv-chip" title="Total attempts">{psychReport.totalAttempts} attempts</span>
                  <span className="qv-chip" title="Total items">{psychReport.totalItems} items</span>
                  <span className="qv-chip qv-text-danger" title="Items flagged too hard">⚠️ too-hard: {psychReport.itemsByFlag['too-hard']}</span>
                  <span className="qv-chip qv-text-warning" title="Items flagged too easy">↑ too-easy: {psychReport.itemsByFlag['too-easy']}</span>
                  <span className="qv-chip qv-text-secondary" title="Items with low discrimination">↧ low-disc: {psychReport.itemsByFlag['low-discrimination']}</span>
                  <span className="qv-chip qv-text-success" title="Items passing all checks">✓ ok: {psychReport.itemsByFlag['ok']}</span>
                </div>
                {psychReport.items.length > 0 && (
                  <details className="qv-mt-2 qv-fs-sm">
                    <summary className="qv-text-secondary" style={{ cursor: 'pointer' }}>Show top 10 flagged items</summary>
                    <table className="qv-mt-2 qv-fs-xs" style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr className="qv-text-muted">
                          <th style={{ textAlign: 'left', padding: 'var(--space-1)' }}>Item</th>
                          <th style={{ textAlign: 'left', padding: 'var(--space-1)' }}>Topic</th>
                          <th style={{ textAlign: 'right', padding: 'var(--space-1)' }}>n</th>
                          <th style={{ textAlign: 'right', padding: 'var(--space-1)' }}>Acc</th>
                          <th style={{ textAlign: 'right', padding: 'var(--space-1)' }}>Discr</th>
                          <th style={{ textAlign: 'left', padding: 'var(--space-1)' }}>Flag</th>
                        </tr>
                      </thead>
                      <tbody>
                        {psychReport.items.filter((it) => it.flag !== 'ok' && it.flag !== 'insufficient-data').slice(0, 10).map((it) => (
                          <tr key={`${it.domain}-${it.questionId}`}>
                            <td className="qv-mono" style={{ padding: 'var(--space-1)' }}>{it.questionId}</td>
                            <td style={{ padding: 'var(--space-1)' }}>{it.topic}</td>
                            <td className="qv-mono" style={{ padding: 'var(--space-1)', textAlign: 'right' }}>{it.attempts}</td>
                            <td className="qv-mono" style={{ padding: 'var(--space-1)', textAlign: 'right' }}>{(it.accuracy * 100).toFixed(0)}%</td>
                            <td className="qv-mono" style={{ padding: 'var(--space-1)', textAlign: 'right' }}>{it.discrimination.toFixed(2)}</td>
                            <td style={{ padding: 'var(--space-1)' }}>{it.flag}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )}
                <p className="qv-text-muted qv-m-0 qv-mt-2 qv-fs-xs">
                  Last computed {new Date(psychReport.generatedAt).toLocaleString()}.
                </p>
              </>
            )}
            {psychError && (
              <p className="qv-text-danger qv-m-0 qv-mt-2 qv-fs-sm">{psychError}</p>
            )}
          </div>
          <div className="qv-row-2" style={{ flexWrap: 'wrap' }}>
            <button className="btn btn-secondary btn-sm" onClick={handlePsychCompute} disabled={psychBusy}>
              {psychBusy ? 'Computing…' : 'Compute now'}
            </button>
            {psychReport && (
              <button className="btn btn-secondary btn-sm" onClick={handlePsychReset} disabled={psychBusy}>
                Clear cache
              </button>
            )}
          </div>
        </div>
      </Surface>

      <Surface tone="ops" className="ops-report-panel">
        <div className="flex-between" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <StatusBadge tone="exam">Auto-generated material</StatusBadge>
            <h3 className="qv-m-0 qv-mt-2">Targeted AI material queue</h3>
            <p className="qv-text-secondary qv-m-0">
              Generate practice questions, flashcards, and topic summaries on-device for every weak topic. Each job is grounded in your ingested curriculum and saved to the same cache slots the rest of the app reads from.
            </p>
            {targetedQueue.length > 0 && (
              <div className="qv-mt-2" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                {targetedQueue.map((job) => {
                  const tone =
                    job.status === 'done' ? 'qv-text-success'
                      : job.status === 'error' ? 'qv-text-danger'
                      : job.status === 'running' ? 'qv-text-warning'
                      : 'qv-text-secondary';
                  return (
                    <div key={job.id} className="qv-fs-sm" style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', alignItems: 'baseline' }}>
                      <span>
                        <span className="qv-fw-semibold">{job.title}</span>
                        <span className="qv-text-muted"> · {job.kind}</span>
                        {targetedRunningId === job.id && <span className="qv-text-warning"> · running…</span>}
                      </span>
                      <span className={`qv-chip ${tone}`}>{job.status}</span>
                    </div>
                  );
                })}
              </div>
            )}
            {targetedError && (
              <p className="qv-text-danger qv-m-0 qv-mt-2 qv-fs-sm">{targetedError}</p>
            )}
          </div>
          <div className="qv-row-2" style={{ flexWrap: 'wrap' }}>
            <button className="btn btn-secondary btn-sm" onClick={handleTargetedGenerate} disabled={targetedBusy}>
              {targetedBusy ? 'Working…' : 'Generate jobs from weak topics'}
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleTargetedRunAll}
              disabled={targetedBusy || !targetedQueue.some((j) => j.status === 'pending')}
            >
              Run all pending
            </button>
            {targetedQueue.length > 0 && (
              <button className="btn btn-secondary btn-sm" onClick={handleTargetedClear} disabled={targetedBusy}>
                Clear queue
              </button>
            )}
          </div>
        </div>
      </Surface>

      <Surface tone="ops" className="ops-report-panel">
        <div className="flex-between" style={{ gap: 'var(--space-3)', alignItems: 'center' }}>
          <div>
            <StatusBadge tone="exam">Browser Reminders</StatusBadge>
            <h3 style={{ margin: 'var(--space-2) 0 0' }}>Native review reminders</h3>
            <p className="qv-text-secondary" style={{ marginBottom: 0 }}>
              Grant permission once and StudyVault will surface a desktop notification when you have reviews due. No network — fires from the local service worker.
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
                new Notification('StudyVault', { body: 'Reminders enabled — you will be pinged when reviews are due.' });
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
            <p className="qv-text-secondary" style={{ marginBottom: 0 }}>
              Drives the countdown on /today and feeds future exam-date pacing logic. Leave empty to disable.
            </p>
          </div>
          <div className="qv-row-2">
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
            <p className="qv-text-secondary" style={{ marginBottom: 0 }}>
              Point StudyVault at a local OpenAI-compatible model server. Fully offline — no cloud, no API key. Powers practice generated from your ingested curriculum.
            </p>
          </div>
        </div>
        {llm && (
          <>
            <div className="grid-3" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
              <label className="qv-stack-1">
                <span className="qv-fs-xs qv-text-muted">Base URL</span>
                <input className="input" value={llm.baseUrl} onChange={(event) => setLlm({ ...llm, baseUrl: event.target.value })} placeholder="http://localhost:11434/v1" aria-label="Local model base URL" />
              </label>
              <label className="qv-stack-1">
                <span className="qv-fs-xs qv-text-muted">Model</span>
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
              <label className="qv-row-2" style={{ marginTop: 'var(--space-5)' }}>
                <input type="checkbox" checked={llm.enabled} onChange={(event) => setLlm({ ...llm, enabled: event.target.checked })} />
                <span>Enable AI generation</span>
              </label>
            </div>
            <div className="qv-row-2" style={{ flexWrap: 'wrap' }}>
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
              <p className="qv-text-muted qv-fs-xs qv-mt-2">
                Available models: {llmStatus.models.slice(0, 8).join(', ')}
              </p>
            )}
          </>
        )}
      </Surface>

      <Surface tone="ops" className="ops-report-panel">
        <div className="qv-mb-3">
          <StatusBadge tone="accent">Local AI</StatusBadge>
          <h3 style={{ margin: 'var(--space-2) 0 0' }}>Figure understanding (vision)</h3>
          <p className="qv-text-secondary" style={{ marginBottom: 0 }}>
            Drop a curriculum chart or diagram (PNG, JPEG, or WebP) and the locally loaded
            multimodal model will describe it in exam terms. Requires a vision-capable model
            loaded in LM Studio or Ollama — e.g. Gemma 4 E4B (Gemma 3+ accepts image inputs).
            Falls back to a clear error if the loaded model is text-only.
          </p>
        </div>
        <FigureExplainer topicTitle="Curriculum figure" />
      </Surface>

      <Surface tone="ops" className="ops-report-panel">
        <div className="qv-mb-3">
          <StatusBadge tone="accent">Hybrid Search</StatusBadge>
          <h3 style={{ margin: 'var(--space-2) 0 0' }}>Hybrid curriculum search</h3>
          <p className="qv-text-secondary" style={{ marginBottom: 0 }}>
            Search every imported curriculum chunk with a BM25-style lexical scorer
            (and cosine vector similarity, when embeddings are present). Routes through
            the active storage driver — Dexie today, SurrealDB when the sidecar is up.
          </p>
        </div>
        <div className="qv-row-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            className="input"
            type="search"
            value={chunkQuery}
            onChange={(event) => setChunkQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleChunkSearch();
            }}
            placeholder="e.g. effective duration, XLOOKUP, confidence interval"
            aria-label="Hybrid curriculum search query"
            style={{ minWidth: 260, flex: 1 }}
          />
          <button className="btn btn-primary" onClick={handleChunkSearch} disabled={chunkBusy || !chunkQuery.trim()}>
            {chunkBusy ? 'Searching…' : 'Search'}
          </button>
          {chunkHits.length > 0 && (
            <StatusBadge tone="accent">{chunkHits.length} hit{chunkHits.length === 1 ? '' : 's'}</StatusBadge>
          )}
        </div>
        {chunkError && (
          <p className="qv-mt-2" style={{ color: 'var(--danger)' }}>{chunkError}</p>
        )}
        {chunkHits.length > 0 && (
          <ol className="qv-stack-2 qv-mt-3" style={{ listStyle: 'decimal inside', padding: 0 }}>
            {chunkHits.map((hit) => (
              <li
                key={hit.id}
                style={{
                  padding: 'var(--space-2) var(--space-3)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md, 8px)',
                }}
              >
                <div className="flex-between qv-row-2" style={{ alignItems: 'baseline', gap: 'var(--space-2)' }}>
                  <strong style={{ fontSize: 'var(--fs-sm)' }}>{hit.locator || hit.id}</strong>
                  <small className="qv-text-muted">
                    score {hit.score.toFixed(3)}
                    {typeof hit.bm25Score === 'number' ? ` · bm25 ${hit.bm25Score.toFixed(2)}` : ''}
                    {typeof hit.vectorScore === 'number' ? ` · vec ${hit.vectorScore.toFixed(2)}` : ''}
                  </small>
                </div>
                <p className="qv-text-secondary qv-fs-sm qv-m-0" style={{ marginTop: 'var(--space-1)' }}>
                  {hit.text.length > 220 ? `${hit.text.slice(0, 220)}…` : hit.text}
                </p>
                <small className="qv-text-muted">
                  {hit.domain}
                  {hit.level ? ` · ${hit.level}` : ''}
                  {hit.topic ? ` · ${hit.topic}` : ''}
                  {typeof hit.page === 'number' ? ` · p.${hit.page}` : ''}
                </small>
              </li>
            ))}
          </ol>
        )}
      </Surface>

      <Surface tone="ops" className="ops-report-panel">
        <div className="flex-between" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-3)', alignItems: 'flex-start' }}>
          <div>
            <StatusBadge tone="accent">Embedded Notebook</StatusBadge>
            <h3 style={{ margin: 'var(--space-2) 0 0' }}>Grounded RAG over your curriculum (open-notebook)</h3>
            <p className="qv-text-secondary" style={{ marginBottom: 0 }}>
              StudyVault embeds open-notebook as a local sidecar (FastAPI + SurrealDB + job worker). It builds per-topic notebooks from your ingested CFA volumes and answers questions with cited, source-grounded synthesis. Fully offline.
            </p>
          </div>
        </div>
        {onb && (
          <>
            <div className="grid-3" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
              <label className="qv-stack-1">
                <span className="qv-fs-xs qv-text-muted">Backend URL</span>
                <input className="input" value={onb.baseUrl} onChange={(event) => setOnb({ ...onb, baseUrl: event.target.value })} placeholder="http://localhost:5055" aria-label="Open-notebook backend URL" />
              </label>
              <label className="qv-row-2" style={{ marginTop: 'var(--space-5)' }}>
                <input type="checkbox" checked={onb.enabled} onChange={(event) => setOnb({ ...onb, enabled: event.target.checked })} />
                <span>Enable grounded RAG</span>
              </label>
            </div>
            <div className="qv-row-2" style={{ flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={handleSaveOnb}>Save</button>
              <button className="btn btn-secondary" onClick={handleTestOnb} disabled={onbTesting}>{onbTesting ? 'Testing…' : 'Test Connection'}</button>
              {onbStatus && (
                <StatusBadge tone={onbStatus.ok ? 'success' : 'danger'}>
                  {onbStatus.ok ? `Connected · ${onbStatus.models?.length ?? 0} model(s)` : `Offline · ${onbStatus.error}`}
                </StatusBadge>
              )}
            </div>
            {onbStatus?.ok && (
              <p className="qv-text-muted qv-fs-xs qv-mt-2">
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
              <p className="qv-text-secondary" style={{ marginBottom: 0 }}>
                Notebooks the backend currently holds. Deleting one removes its sources, insights, and chat sessions from the embedded SurrealDB; StudyVault re-creates per-topic notebooks on demand when asks resume.
              </p>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={refreshOnbNotebooks} disabled={onbNotebooksBusy}>
              {onbNotebooksBusy ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          {onbNotebooks.length === 0 ? (
            <p className="muted-copy qv-m-0">
              {onbNotebooksBusy ? 'Loading…' : 'No notebooks yet on the backend. Ask a question on any CFA topic to create one.'}
            </p>
          ) : (
            <div className="qv-stack-2">
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
                <p className="muted-copy qv-m-0">
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
              <p className="qv-text-secondary" style={{ marginBottom: 0 }}>
                Point StudyVault at a folder of CFA curriculum PDFs on disk; the native shell will walk it, extract text, chunk by page, classify by topic, and store in your local source vault. Duplicates (by SHA-256) are skipped automatically. You can also drag-drop PDFs directly onto this window.
              </p>
            </div>
            <div className="qv-row-2" style={{ flexShrink: 0 }}>
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
            <div className="qv-mt-2">
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
            <p className="qv-text-secondary" style={{ marginBottom: 0 }}>
              Rows written to the settings store by AI-practice, generative mocks, and grounded Q&amp;A. Clearing a bucket removes generated content but not persistent settings (LLM config, open-notebook config, onboarding).
            </p>
          </div>
          <div className="qv-row-2" style={{ flexShrink: 0 }}>
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
          <p className="muted-copy qv-m-0">Loading…</p>
        ) : (
          <div className="qv-stack-2">
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
            <p className="qv-text-secondary" style={{ marginBottom: 0 }}>
              Everything in your local vault — bundled `.qvsource` imports plus desktop folder ingestion. Deletes are scoped (the document and its chunks only) and irreversible.
            </p>
          </div>
          <div className="qv-row-2" style={{ flexShrink: 0 }}>
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
          <p className="muted-copy qv-m-0">
            No ingested documents yet. Import a `.qvsource` bundle or ingest a CFA folder from the desktop shell to populate the vault.
          </p>
        ) : (
          <div className="qv-stack-2">
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
              <p className="muted-copy qv-m-0">
                Showing 12 of {sourceDocs.length} documents.
              </p>
            )}
          </div>
        )}
      </Surface>

      <Surface tone="ops" className="ops-report-panel">
        <div className="qv-mb-3">
          <StatusBadge tone="accent">Paste a source</StatusBadge>
          <h3 style={{ margin: 'var(--space-2) 0 0' }}>Ingest free text directly into the vault</h3>
          <p className="qv-text-secondary" style={{ marginBottom: 0 }}>
            For lecture notes, blog excerpts, or any non-PDF material you want to use in grounded answers. Same chunker/dedupe path as PDF ingestion; SHA-256 of the text serves as the document id.
          </p>
        </div>
        <div className="grid-3" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
          <label className="qv-stack-1">
            <span className="qv-fs-xs qv-text-muted">Title</span>
            <input className="input" value={pasteTitle} onChange={(event) => setPasteTitle(event.target.value)} placeholder="e.g. Fixed Income lecture notes" />
          </label>
          <label className="qv-stack-1">
            <span className="qv-fs-xs qv-text-muted">Topic id (optional)</span>
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
            <p className="qv-text-secondary" style={{ marginBottom: 0 }}>
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
          <p className="qv-text-secondary">No cache buckets are currently visible in this browser context.</p>
        )}
      </Surface>

      <Surface tone="vault">
        <h3 style={{ marginTop: 0 }}>Backup Reminder</h3>
        <p className="qv-text-secondary">
          StudyVault is local-first. Export a backup before clearing browser data, moving devices, or starting a long mock-exam cycle.
        </p>
        {message && <p style={{ color: 'var(--success)' }}>{message}</p>}
      </Surface>
    </div>
  );
}
