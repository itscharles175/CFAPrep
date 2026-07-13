/**
 * INT-5 — generation-quality observability (host hook).
 *
 * Fetches the LSAT backend's two derived, read-only generation-observability
 * surfaces and folds them into one cached, refreshable result for the System
 * Health panel:
 *   - `GET /api/gen/generation/quality-metrics` — per-type pass rates + a
 *     per-gate (the 8+ pipeline gates) judged/passed/failed breakdown + a
 *     fail-reason histogram, replayed from every recorded `GenJob` candidate.
 *   - `GET /api/gen/generation/audit-log` — recent generate / validate /
 *     firewall events (newest first), derived from `GenCandidate` rows.
 *
 * Reuses the exact fetch/cache/degrade idiom of `useTrustManifest.ts`: a
 * module-wide cache (so re-mounting the page doesn't re-hit the sidecar), an
 * AbortController + timeout, a single in-flight load shared across overlapping
 * refreshes, and a fully-degrading contract — a down/slow sidecar resolves to
 * `{ reachable: false }` with null payloads rather than throwing or blocking
 * render. Both legacy untyped LSAT surfaces (no narrow `response_model` in the
 * committed `api.gen.ts` baseline yet) are read defensively against the shapes
 * documented here.
 *
 * LOCAL-ONLY: every byte is read from the on-device sidecar; nothing leaves the
 * machine and nothing is written back.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchLsatSidecarJson } from '../lib/lsatSidecarClient';

const QUALITY_METRICS_PATH = '/api/gen/generation/quality-metrics';
const AUDIT_LOG_PATH = '/api/gen/generation/audit-log';

/** Read-only aggregation; a couple of seconds is plenty. */
const DEFAULT_TIMEOUT_MS = 5000;
/** Cache ~30s so re-mounting the page doesn't re-aggregate the whole bank. */
const CACHE_TTL_MS = 30 * 1000;
/** Default audit-feed window. */
const DEFAULT_AUDIT_LIMIT = 50;

/** The three derived event classes the audit feed emits. */
export type GenAuditKind = 'generate' | 'validate' | 'firewall';

/** Per-gate pass/fail breakdown for one of the 8+ pipeline gates. */
export interface GenGateMetric {
  gate: string;
  /** Candidates where the gate actually RAN (excludes skipped / short-circuited). */
  judged: number;
  passed: number;
  failed: number;
  /** passed / judged, or null when nothing was judged. */
  passRate: number | null;
  /** Histogram of the per-gate failure reason string. */
  failReasons: Record<string, number>;
}

/** Per-q_type rollup: overall pass/fail + the same per-gate breakdown. */
export interface GenTypeMetric {
  qType: string;
  passed: number;
  failed: number;
  passRate: number | null;
  gates: GenGateMetric[];
}

/** Parsed `quality-metrics` body. */
export interface GenQualityMetrics {
  jobs: number;
  totalCandidates: number;
  passed: number;
  quarantined: number;
  passRate: number | null;
  /** Overall first-failure histogram. */
  failReasons: Record<string, number>;
  /** Per-gate breakdown across the 8+ pipeline gates, in pipeline order. */
  gates: GenGateMetric[];
  byType: GenTypeMetric[];
}

/** One derived generate / validate / firewall event. */
export interface GenAuditEvent {
  id: number | null;
  kind: GenAuditKind;
  genJobId: number | null;
  qType: string | null;
  questionId: number | null;
  candidateIndex: number;
  verdict: string | null;
  reason: string | null;
  solverModel: string | null;
  criticModel: string | null;
  createdAt: string | null;
}

/** Parsed `audit-log` body. */
export interface GenAuditLog {
  events: GenAuditEvent[];
  limit: number;
  /** Tally of the scanned window by kind (pre-filter). */
  counts: Record<string, number>;
  kind: GenAuditKind | null;
}

/** What {@link useGenerationQualityMetrics} returns. */
export interface UseGenerationQualityMetrics {
  /** Parsed per-gate metrics, or null while loading / when the sidecar is down. */
  metrics: GenQualityMetrics | null;
  /** Parsed audit feed, or null while loading / when the sidecar is down. */
  auditLog: GenAuditLog | null;
  /** True only on the very first load (no cached payload yet). */
  loading: boolean;
  /** True while a refresh request is in flight (initial or manual). */
  refreshing: boolean;
  /** False when the sidecar didn't answer (offline / timeout). */
  reachable: boolean;
  /** ISO timestamp of the last successful fetch, if any. */
  fetchedAt: string | null;
  /** Force a re-fetch (bypasses the cache). Never throws. */
  refresh: () => void;
}

/** Options for {@link useGenerationQualityMetrics}. */
export interface UseGenerationQualityMetricsOptions {
  /** How many audit events to request (1..500). Defaults to 50. */
  auditLimit?: number;
  /** Override the per-request timeout (ms). */
  timeoutMs?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Coerce a `{reason: count}` histogram defensively (drop non-numeric entries). */
function readHistogram(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    }
  }
  return out;
}

/** Coerce one raw gate entry into {@link GenGateMetric}. */
function readGate(raw: unknown): GenGateMetric {
  const g = isRecord(raw) ? raw : {};
  return {
    gate: typeof g.gate === 'string' ? g.gate : 'unknown',
    judged: num(g.judged),
    passed: num(g.passed),
    failed: num(g.failed),
    passRate: numOrNull(g.pass_rate),
    failReasons: readHistogram(g.fail_reasons),
  };
}

/** Read the legacy untyped `quality-metrics` body into {@link GenQualityMetrics}. */
function parseMetrics(raw: unknown): GenQualityMetrics {
  const body = isRecord(raw) ? raw : {};
  return {
    jobs: num(body.jobs),
    totalCandidates: num(body.total_candidates),
    passed: num(body.passed),
    quarantined: num(body.quarantined),
    passRate: numOrNull(body.pass_rate),
    failReasons: readHistogram(body.fail_reasons),
    gates: Array.isArray(body.gates) ? body.gates.map(readGate) : [],
    byType: Array.isArray(body.by_type)
      ? body.by_type.map((row) => {
          const r = isRecord(row) ? row : {};
          const passed = num(r.passed);
          const failed = num(r.failed);
          return {
            qType: typeof r.q_type === 'string' ? r.q_type : 'Unknown',
            passed,
            failed,
            passRate: numOrNull(r.pass_rate),
            gates: Array.isArray(r.gates) ? r.gates.map(readGate) : [],
          } satisfies GenTypeMetric;
        })
      : [],
  };
}

const AUDIT_KINDS: ReadonlySet<string> = new Set(['generate', 'validate', 'firewall']);

/** Coerce one raw event into {@link GenAuditEvent} (drop unknown kinds defensively). */
function readEvent(raw: unknown): GenAuditEvent | null {
  if (!isRecord(raw)) return null;
  const kind = typeof raw.kind === 'string' && AUDIT_KINDS.has(raw.kind) ? (raw.kind as GenAuditKind) : null;
  if (!kind) return null;
  return {
    id: numOrNull(raw.id),
    kind,
    genJobId: numOrNull(raw.gen_job_id),
    qType: strOrNull(raw.q_type),
    questionId: numOrNull(raw.question_id),
    candidateIndex: num(raw.candidate_index),
    verdict: strOrNull(raw.verdict),
    reason: strOrNull(raw.reason),
    solverModel: strOrNull(raw.solver_model),
    criticModel: strOrNull(raw.critic_model),
    createdAt: strOrNull(raw.created_at),
  };
}

/** Read the legacy untyped `audit-log` body into {@link GenAuditLog}. */
function parseAuditLog(raw: unknown): GenAuditLog {
  const body = isRecord(raw) ? raw : {};
  const events = Array.isArray(body.events)
    ? body.events.map(readEvent).filter((e): e is GenAuditEvent => e !== null)
    : [];
  const kind = typeof body.kind === 'string' && AUDIT_KINDS.has(body.kind) ? (body.kind as GenAuditKind) : null;
  return {
    events,
    limit: num(body.limit) || DEFAULT_AUDIT_LIMIT,
    counts: readHistogram(body.counts),
    kind,
  };
}

/** Outcome of one combined fetch. Never thrown — always returned. */
interface FetchResult {
  metrics: GenQualityMetrics | null;
  auditLog: GenAuditLog | null;
  reachable: boolean;
}

/** Degrading JSON GET — resolves to null on any failure (never throws). */
async function getJson(path: string, timeoutMs: number): Promise<{ data: unknown; reachable: boolean }> {
  const res = await fetchLsatSidecarJson(path, {
    timeoutMs,
    headers: { accept: 'application/json' },
  });
  return { data: res.ok ? res.data : null, reachable: res.reachable };
}

/**
 * Fetch both observability surfaces in parallel. Fully degrading: any failure
 * (sidecar down, timeout, shape drift) resolves to nulls + `reachable: false`.
 * `reachable` is true only when at least one request actually answered.
 */
async function fetchAll(auditLimit: number, timeoutMs: number): Promise<FetchResult> {
  const [metricsRes, auditRes] = await Promise.all([
    getJson(QUALITY_METRICS_PATH, timeoutMs),
    getJson(`${AUDIT_LOG_PATH}?limit=${encodeURIComponent(String(auditLimit))}`, timeoutMs),
  ]);
  return {
    metrics: metricsRes.data != null ? parseMetrics(metricsRes.data) : null,
    auditLog: auditRes.data != null ? parseAuditLog(auditRes.data) : null,
    reachable: metricsRes.reachable || auditRes.reachable,
  };
}

/** Module-wide cache, keyed by audit window so a different limit re-fetches. */
let cache: { key: number; result: FetchResult; fetchedAt: number } | null = null;

/**
 * INT-5 host hook: load the generation-quality metrics + recent audit feed
 * (cached, refreshable) from the LSAT sidecar. Fully degrading — a down/slow
 * sidecar never blocks render; the consumer shows an honest "offline" state.
 * Safe to mount on the System Health page; it cleans up its in-flight request
 * on unmount.
 */
export function useGenerationQualityMetrics(
  opts: UseGenerationQualityMetricsOptions = {},
): UseGenerationQualityMetrics {
  const { auditLimit = DEFAULT_AUDIT_LIMIT, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const fresh =
    cache && cache.key === auditLimit && Date.now() - cache.fetchedAt < CACHE_TTL_MS ? cache : null;

  const [metrics, setMetrics] = useState<GenQualityMetrics | null>(fresh?.result.metrics ?? null);
  const [auditLog, setAuditLog] = useState<GenAuditLog | null>(fresh?.result.auditLog ?? null);
  const [loading, setLoading] = useState<boolean>(!fresh);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [reachable, setReachable] = useState<boolean>(true);
  const [fetchedAt, setFetchedAt] = useState<string | null>(
    fresh ? new Date(fresh.fetchedAt).toISOString() : null,
  );
  // A single in-flight load is reused so an interval/manual overlap can't double-fetch.
  const inFlight = useRef<Promise<void> | null>(null);

  const load = useCallback(
    (force: boolean): Promise<void> => {
      if (inFlight.current) return inFlight.current;
      // Serve a warm cache (same audit window) without a request unless forced.
      if (!force && cache && cache.key === auditLimit && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
        setMetrics(cache.result.metrics);
        setAuditLog(cache.result.auditLog);
        setReachable(cache.result.reachable);
        setFetchedAt(new Date(cache.fetchedAt).toISOString());
        setLoading(false);
        return Promise.resolve();
      }
      setRefreshing(true);
      const run = (async () => {
        const result = await fetchAll(auditLimit, timeoutMs);
        setReachable(result.reachable);
        if (result.metrics) setMetrics(result.metrics);
        if (result.auditLog) setAuditLog(result.auditLog);
        if (result.reachable && (result.metrics || result.auditLog)) {
          const now = Date.now();
          cache = { key: auditLimit, result, fetchedAt: now };
          setFetchedAt(new Date(now).toISOString());
        }
        setLoading(false);
        setRefreshing(false);
      })().finally(() => {
        inFlight.current = null;
      });
      inFlight.current = run;
      return run;
    },
    [auditLimit, timeoutMs],
  );

  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    let active = true;
    void load(false).then(() => {
      if (!active) return;
    });
    return () => {
      active = false;
    };
  }, [load]);

  return { metrics, auditLog, loading, refreshing, reachable, fetchedAt, refresh };
}
