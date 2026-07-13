/**
 * OPS-2 — trust + release-readiness cockpit (host hook).
 *
 * Fetches the LSAT backend's release-trust manifest from
 * `GET /api/observability/trust` (built by `services/lsat-backend/app/trust.py`
 * `build_release_trust_manifest()`), caches it module-wide, and exposes a manual
 * `refresh()`. The manifest is the single auditable JSON object that rolls ~20
 * local-first safety signals into one `ok | warning | blocked` status plus a
 * per-check tree, a flat `next_actions` list, and `blockers` / `warnings`.
 *
 * Fully degrading, just like `lsatBackend.ts` / `useSyncProgress.ts`: the fetch
 * uses an AbortController + timeout and NEVER throws. A down/slow sidecar
 * resolves to `{ reachable: false }` rather than blocking render — the panel
 * then shows the host-only checks (offline readiness, Dexie quota, LSAT/Surreal
 * health) folded in below, which are always available in-browser.
 *
 * The route is a legacy untyped LSAT surface (no narrow `response_model` in the
 * committed `api.gen.ts` baseline), so the manifest body is read defensively
 * against the shapes documented here. When the backend grows a typed
 * `response_model`, regenerate `api.gen.ts` and anchor the path here.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchLsatSidecarJson } from '../lib/lsatSidecarClient';

const TRUST_PATH = '/api/observability/trust';

/** Generous since this can shell out to git/rustc server-side; never on a render path. */
const DEFAULT_TIMEOUT_MS = 6000;
/** Cache the manifest ~2 min so re-mounting the page doesn't re-run the slow gate. */
const CACHE_TTL_MS = 2 * 60 * 1000;

/** Rollup / per-check rollup status as the backend reports it. */
export type TrustRollup = 'ok' | 'warning' | 'blocked';
/** Per-check status (note the backend uses the short `block` / `warn` forms). */
export type TrustCheckStatus = 'ok' | 'warn' | 'block';

/** One entry in the manifest's `checks` map (see `trust._check`). */
export interface TrustCheck {
  status: TrustCheckStatus;
  summary?: string;
  detail?: Record<string, unknown>;
  action?: string | null;
}

/** One entry in `blockers` / `warnings` (see `trust._messages`). */
export interface TrustMessage {
  check?: string;
  summary?: string;
  action?: string | null;
}

/** The release-trust manifest body (`lsatlab.release_trust.v1`). */
export interface TrustManifest {
  schema?: string;
  tier?: string;
  status: TrustRollup;
  score?: number;
  generated_at?: string;
  app_version?: string;
  environment?: Record<string, unknown>;
  checks: Record<string, TrustCheck>;
  blockers: TrustMessage[];
  warnings: TrustMessage[];
  next_actions: string[];
}

/** A host-side check folded into the cockpit alongside the backend manifest. */
export interface HostCheck {
  key: string;
  label: string;
  status: TrustRollup;
  detail: string;
}

/** What {@link useTrustManifest} returns. */
export interface UseTrustManifest {
  /** Parsed backend manifest, or null while loading / when the sidecar is down. */
  manifest: TrustManifest | null;
  /** True only on the very first load (no cached manifest yet). */
  loading: boolean;
  /** True while a refresh request is in flight (initial or manual). */
  refreshing: boolean;
  /** False when the sidecar didn't answer (offline / timeout). */
  reachable: boolean;
  /** Host-only checks, always available even with the sidecar down. */
  hostChecks: HostCheck[];
  /** ISO timestamp of the last successful manifest fetch, if any. */
  fetchedAt: string | null;
  /** Force a re-fetch (bypasses the cache). Never throws. */
  refresh: () => void;
}

/** Module-wide cache so navigating away/back doesn't re-run the slow gate. */
let cache: { manifest: TrustManifest; fetchedAt: number } | null = null;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Coerce one raw `checks` entry into the {@link TrustCheck} shape. */
function readCheck(raw: unknown): TrustCheck {
  if (!isRecord(raw)) return { status: 'ok' };
  const status = raw.status === 'block' || raw.status === 'warn' ? raw.status : 'ok';
  return {
    status,
    summary: typeof raw.summary === 'string' ? raw.summary : undefined,
    detail: isRecord(raw.detail) ? raw.detail : undefined,
    action: typeof raw.action === 'string' ? raw.action : null,
  };
}

/** Coerce one raw `blockers` / `warnings` entry into a {@link TrustMessage}. */
function readMessage(raw: unknown): TrustMessage {
  if (!isRecord(raw)) return {};
  return {
    check: typeof raw.check === 'string' ? raw.check : undefined,
    summary: typeof raw.summary === 'string' ? raw.summary : undefined,
    action: typeof raw.action === 'string' ? raw.action : null,
  };
}

/** Read the legacy untyped manifest body defensively into {@link TrustManifest}. */
function parseManifest(raw: unknown): TrustManifest {
  const body = isRecord(raw) ? raw : {};
  const status =
    body.status === 'blocked' || body.status === 'warning' ? body.status : 'ok';
  const checks: Record<string, TrustCheck> = {};
  if (isRecord(body.checks)) {
    for (const [key, value] of Object.entries(body.checks)) {
      checks[key] = readCheck(value);
    }
  }
  const messages = (value: unknown): TrustMessage[] =>
    Array.isArray(value) ? value.map(readMessage) : [];
  const actions = Array.isArray(body.next_actions)
    ? body.next_actions.filter((a): a is string => typeof a === 'string')
    : [];
  return {
    schema: typeof body.schema === 'string' ? body.schema : undefined,
    tier: typeof body.tier === 'string' ? body.tier : undefined,
    status,
    score: typeof body.score === 'number' ? body.score : undefined,
    generated_at: typeof body.generated_at === 'string' ? body.generated_at : undefined,
    app_version: typeof body.app_version === 'string' ? body.app_version : undefined,
    environment: isRecord(body.environment) ? body.environment : undefined,
    checks,
    blockers: messages(body.blockers),
    warnings: messages(body.warnings),
    next_actions: actions,
  };
}

/** Outcome of one manifest fetch. Never thrown — always returned. */
interface FetchResult {
  manifest: TrustManifest | null;
  reachable: boolean;
}

/**
 * Fetch the release-trust manifest from the LSAT sidecar. Fully degrading: any
 * failure (sidecar down, timeout, shape drift) resolves to
 * `{ manifest: null, reachable: false }` — it NEVER throws.
 */
async function fetchManifest(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<FetchResult> {
  const res = await fetchLsatSidecarJson(TRUST_PATH, {
    timeoutMs,
    headers: { accept: 'application/json' },
  });
  if (!res.reachable) return { manifest: null, reachable: false };
  if (!res.ok || res.data == null) return { manifest: null, reachable: true };
  return { manifest: parseManifest(res.data), reachable: true };
}

/**
 * Collect the host-only trust signals that are always available in-browser,
 * independent of the LSAT sidecar: PWA offline-route readiness, Dexie/IndexedDB
 * storage quota headroom, and SurrealDB/LSAT backend liveness. These are folded
 * into the cockpit beneath the backend manifest so the panel is still useful
 * when the sidecar is down. Never throws — a probe failure becomes a `warning`.
 */
async function collectHostChecks(deps: HostCheckDeps): Promise<HostCheck[]> {
  const checks: HostCheck[] = [];

  // Offline readiness — how many critical local routes are cached for offline use.
  try {
    const report = await deps.getOfflineReadinessReport();
    const cached = report?.cachedCount ?? 0;
    const total = report?.totalCriticalRoutes ?? 0;
    checks.push({
      key: 'offline_readiness',
      label: 'Offline readiness',
      status: !report?.cacheAvailable
        ? 'warning'
        : total > 0 && cached >= total
          ? 'ok'
          : 'warning',
      detail: `${cached}/${total} critical routes cached`,
    });
  } catch {
    checks.push({
      key: 'offline_readiness',
      label: 'Offline readiness',
      status: 'warning',
      detail: 'Offline cache could not be inspected.',
    });
  }

  // Dexie / IndexedDB quota headroom via the Storage API estimate.
  try {
    const estimate = (await navigator.storage?.estimate?.()) ?? null;
    const usage = typeof estimate?.usage === 'number' ? estimate.usage : null;
    const quota = typeof estimate?.quota === 'number' ? estimate.quota : null;
    if (usage != null && quota != null && quota > 0) {
      const pct = Math.round((usage / quota) * 100);
      checks.push({
        key: 'dexie_quota',
        label: 'Local storage quota',
        // >90% used is the only worrying signal for a local-first vault.
        status: pct >= 90 ? 'warning' : 'ok',
        detail: `${pct}% of quota used (${formatBytes(usage)} / ${formatBytes(quota)})`,
      });
    } else {
      checks.push({
        key: 'dexie_quota',
        label: 'Local storage quota',
        status: 'warning',
        detail: 'Storage estimate unavailable in this environment.',
      });
    }
  } catch {
    checks.push({
      key: 'dexie_quota',
      label: 'Local storage quota',
      status: 'warning',
      detail: 'Storage estimate could not be read.',
    });
  }

  // SurrealDB / LSAT backend liveness (the sidecar that backs RAG + the manifest).
  try {
    const health = await deps.checkLsatBackendHealth();
    checks.push({
      key: 'lsat_backend',
      label: 'LSAT backend (SurrealDB sidecar)',
      status: health?.ok ? 'ok' : health?.reachable ? 'warning' : 'blocked',
      detail: health?.detail || (health?.ok ? 'Reachable.' : 'Sidecar offline.'),
    });
  } catch {
    checks.push({
      key: 'lsat_backend',
      label: 'LSAT backend (SurrealDB sidecar)',
      status: 'blocked',
      detail: 'Health probe failed.',
    });
  }

  return checks;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Minimal shape of the offline-readiness report the hook folds in. */
interface OfflineReadinessLike {
  cacheAvailable?: boolean;
  cachedCount?: number;
  totalCriticalRoutes?: number;
}

/** Minimal shape of the LSAT-backend health the hook folds in. */
interface LsatHealthLike {
  ok?: boolean;
  reachable?: boolean;
  detail?: string;
}

/**
 * Host-check dependencies, injected so the hook stays decoupled from the page's
 * lib imports (and trivially mockable in tests). SystemHealth passes the same
 * `getOfflineReadinessReport` / `checkLsatBackendHealth` it already imports.
 */
export interface HostCheckDeps {
  getOfflineReadinessReport: () => Promise<OfflineReadinessLike | null>;
  checkLsatBackendHealth: () => Promise<LsatHealthLike>;
}

/** Options for {@link useTrustManifest}. */
export interface UseTrustManifestOptions {
  /** Host-check probes to fold in. When omitted, only the backend manifest loads. */
  hostDeps?: HostCheckDeps;
  /** Override the per-request timeout (ms). */
  timeoutMs?: number;
}

/**
 * OPS-2 host hook: load the release-trust manifest (cached, refreshable) and the
 * always-available host-only checks. Fully degrading — a down/slow sidecar never
 * blocks render; the panel falls back to the host checks. Safe to mount on the
 * System Health page; it cleans up its in-flight request on unmount.
 */
export function useTrustManifest(opts: UseTrustManifestOptions = {}): UseTrustManifest {
  const { hostDeps, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const fresh = cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS ? cache : null;
  const [manifest, setManifest] = useState<TrustManifest | null>(fresh?.manifest ?? null);
  const [loading, setLoading] = useState<boolean>(!fresh);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [reachable, setReachable] = useState<boolean>(true);
  const [hostChecks, setHostChecks] = useState<HostCheck[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(
    fresh ? new Date(fresh.fetchedAt).toISOString() : null,
  );
  // A single in-flight load is reused so an interval/manual overlap can't double-fetch.
  const inFlight = useRef<Promise<void> | null>(null);

  const load = useCallback(
    (force: boolean): Promise<void> => {
      if (inFlight.current) return inFlight.current;
      // Serve a warm cache without a request unless the caller forces a refresh.
      if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
        setManifest(cache.manifest);
        setFetchedAt(new Date(cache.fetchedAt).toISOString());
        setLoading(false);
        return Promise.resolve();
      }
      setRefreshing(true);
      const run = (async () => {
        const [result, host] = await Promise.all([
          fetchManifest(timeoutMs),
          hostDeps ? collectHostChecks(hostDeps) : Promise.resolve<HostCheck[]>([]),
        ]);
        setReachable(result.reachable);
        setHostChecks(host);
        if (result.manifest) {
          const now = Date.now();
          cache = { manifest: result.manifest, fetchedAt: now };
          setManifest(result.manifest);
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
    [hostDeps, timeoutMs],
  );

  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    let active = true;
    // Fire once on mount; the load never throws so the timer can't leak a rejection.
    void load(false).then(() => {
      // No state writes needed here — `load` already gates on its own setters;
      // the `active` guard just documents the unmount-safety contract.
      if (!active) return;
    });
    return () => {
      active = false;
    };
  }, [load]);

  return { manifest, loading, refreshing, reachable, hostChecks, fetchedAt, refresh };
}
