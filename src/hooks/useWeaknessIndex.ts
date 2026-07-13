/**
 * ANL-2 — unified weakness index (host hook).
 *
 * Fetches the LSAT backend's merged weakness index from
 * `GET /api/analytics/weakness-index` (built by
 * `services/lsat-backend/app/analytics.py` `weakness_index()`), which merges the
 * LSAT per-type `mastery()` with HOST per-topic accuracy (from the DATA-4a
 * `HostProgressSnapshot` attempt mirror) into ONE list ranked by the ~95%
 * credible LOWER bound — a confidently-weak area outranks a tiny noisy one. Each
 * row carries the recent-miss ids and a host-mountable recommended-drill
 * deep-link so the Dashboard card can send the user straight to the weakest area.
 *
 * Fully degrading, exactly like `useTrustManifest.ts` / `lsatBackend.ts`: the
 * fetch uses an AbortController + timeout and NEVER throws. A down/slow sidecar
 * resolves to `{ reachable: false, items: [] }` rather than blocking render, so
 * the Dashboard card shows an "offline" hint instead of hanging the page.
 *
 * The route is a freshly-added LSAT surface (its narrow `response_model` is not
 * in the committed `api.gen.ts` baseline yet), so the body is read defensively
 * against the shapes documented here — the same idiom as `useTrustManifest`. When
 * the backend contract is regenerated, anchor the row type to `api.gen.ts`.
 *
 * NOTE: types live HERE (not in `src/lib/learningTypes.ts`) per the ANL-2 file
 * contract — this hook is self-contained and owns its wire shapes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchLsatSidecarJson } from '../lib/lsatSidecarClient';

const WEAKNESS_INDEX_PATH = '/api/analytics/weakness-index';

/** Read path is cheap server-side but still off the render path; modest timeout. */
const DEFAULT_TIMEOUT_MS = 4000;
/** Cache ~90s so re-mounting the Dashboard doesn't re-hit the sidecar each time. */
const CACHE_TTL_MS = 90 * 1000;
/** Default rows requested — the Dashboard card only shows the top few. */
const DEFAULT_LIMIT = 8;

/** Which evidence plane to rank weakness over (mirrors the backend `?domain=`). */
export type WeaknessDomain = 'all' | 'lsat' | 'host' | 'cfa' | 'quant' | 'excel';

/** One ranked weakness row (the merged LSAT-mastery / host-accuracy shape). */
export interface WeaknessIndexItem {
  /** Originating plane: "lsat" | "cfa" | "quant" | "excel". */
  domain: string;
  /** Native key: LSAT q_type or host topic/objective. */
  key: string;
  /** Human label for the row (q_type, topic, or plane name). */
  label: string;
  /** LSAT section type ("LR" | "RC") when known; null for host topics. */
  sectionType: string | null;
  /** Recency-weighted accuracy (0..1), or null when no signal. */
  accuracy: number | null;
  /** Mastery posterior mean (0..1) where available, else mirrors accuracy. */
  mastery: number | null;
  /** ~95% credible LOWER bound (0..1) — the field the list is RANKED by. */
  lowerBound: number | null;
  /** Effective attempt count behind this row. */
  attempts: number;
  /** Direction of travel ("up" | "down" | "flat") where the plane reports it. */
  trend: string | null;
  /** Recent miss ids (LSAT `question_id` / host `crossId`), newest-first. */
  recentMissIds: string[];
  /** Host-mountable recommended-drill deep-link (already `/lsat/...` or `/<plane>/...`). */
  drillPath: string;
}

/** Provenance + pagination envelope echoed by the backend. */
export interface WeaknessIndexMeta {
  model: string;
  domain: string;
  windowDays: number | null;
  total: number;
  lsatCount: number;
  hostCount: number;
  generatedAt: string | null;
}

/** What {@link useWeaknessIndex} returns. */
export interface UseWeaknessIndex {
  /** Ranked weakness rows (weakest first). Empty while loading or when offline. */
  items: WeaknessIndexItem[];
  /** Provenance/pagination envelope, or null until the first successful load. */
  meta: WeaknessIndexMeta | null;
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

/** Options for {@link useWeaknessIndex}. */
export interface UseWeaknessIndexOptions {
  /** Evidence plane to rank over (default "all" — LSAT + every host plane). */
  domain?: WeaknessDomain;
  /** Restrict to the last N days (server-side window); omit for all-time. */
  days?: number;
  /** Max rows to request (default 8 — the card only shows the top few). */
  limit?: number;
  /** Skip this many ranked rows (server-side pagination). */
  offset?: number;
  /** Override the per-request timeout (ms). */
  timeoutMs?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Coerce one raw weakness row into the {@link WeaknessIndexItem} shape, defensively. */
function readItem(raw: unknown): WeaknessIndexItem | null {
  if (!isRecord(raw)) return null;
  const domain = str(raw.domain) ?? 'lsat';
  const key = str(raw.key) ?? '';
  const recent = Array.isArray(raw.recent_miss_ids)
    ? raw.recent_miss_ids.map((id) => (typeof id === 'string' ? id : String(id))).filter(Boolean)
    : [];
  return {
    domain,
    key,
    label: str(raw.label) ?? key ?? domain,
    sectionType: str(raw.section_type),
    accuracy: num(raw.accuracy),
    mastery: num(raw.mastery),
    lowerBound: num(raw.lower_bound),
    attempts: num(raw.attempts) ?? 0,
    trend: str(raw.trend),
    recentMissIds: recent,
    // Prefer the backend's deep-link; fall back to a sane host-mountable default.
    drillPath: str(raw.drill_path) ?? fallbackDrillPath(domain, key),
  };
}

/** Best-effort deep-link when the backend omitted `drill_path` (older builds). */
function fallbackDrillPath(domain: string, key: string): string {
  if (domain === 'lsat') return `/lsat/analytics/type/${encodeURIComponent(key)}`;
  const base = `/${encodeURIComponent(domain)}/drills`;
  return key ? `${base}?topic=${encodeURIComponent(key)}` : base;
}

/** Read the meta envelope defensively into {@link WeaknessIndexMeta}. */
function readMeta(raw: unknown): WeaknessIndexMeta {
  const body = isRecord(raw) ? raw : {};
  return {
    model: str(body.model) ?? 'weakness_index_v1',
    domain: str(body.domain) ?? 'all',
    windowDays: num(body.window_days),
    total: num(body.total) ?? 0,
    lsatCount: num(body.lsat_count) ?? 0,
    hostCount: num(body.host_count) ?? 0,
    generatedAt: str(body.generated_at),
  };
}

/** Outcome of one fetch. Never thrown — always returned. */
interface FetchResult {
  items: WeaknessIndexItem[];
  meta: WeaknessIndexMeta | null;
  reachable: boolean;
}

function buildQuery(opts: UseWeaknessIndexOptions): string {
  const params = new URLSearchParams();
  if (opts.domain && opts.domain !== 'all') params.set('domain', opts.domain);
  if (typeof opts.days === 'number' && opts.days > 0) params.set('days', String(opts.days));
  params.set('limit', String(opts.limit ?? DEFAULT_LIMIT));
  if (typeof opts.offset === 'number' && opts.offset > 0) params.set('offset', String(opts.offset));
  const q = params.toString();
  return q ? `?${q}` : '';
}

/**
 * Fetch the weakness index from the LSAT sidecar. Fully degrading: any failure
 * (sidecar down, timeout, shape drift) resolves to
 * `{ items: [], meta: null, reachable: false }` — it NEVER throws.
 */
export async function fetchWeaknessIndex(
  opts: UseWeaknessIndexOptions = {},
): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const res = await fetchLsatSidecarJson(`${WEAKNESS_INDEX_PATH}${buildQuery(opts)}`, {
    timeoutMs,
    headers: { accept: 'application/json' },
  });
  if (!res.reachable) return { items: [], meta: null, reachable: false };
  if (!res.ok || res.data == null) return { items: [], meta: null, reachable: true };
  const body = isRecord(res.data) ? res.data : {};
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const items = rawItems
    .map(readItem)
    .filter((it): it is WeaknessIndexItem => it !== null);
  return { items, meta: readMeta(body.meta), reachable: true };
}

/** Module-wide cache keyed by request signature so re-mounts don't re-fetch. */
const cache = new Map<string, { result: FetchResult; fetchedAt: number }>();

function cacheKey(opts: UseWeaknessIndexOptions): string {
  return [opts.domain ?? 'all', opts.days ?? 0, opts.limit ?? DEFAULT_LIMIT, opts.offset ?? 0].join(
    '|',
  );
}

/**
 * ANL-2 host hook: load the unified weakness index (cached, refreshable). Fully
 * degrading — a down/slow sidecar never blocks render; the card falls back to an
 * "offline" hint. Safe to mount on the Dashboard; cleans up its in-flight request
 * on unmount.
 */
export function useWeaknessIndex(opts: UseWeaknessIndexOptions = {}): UseWeaknessIndex {
  const { domain = 'all', days, limit = DEFAULT_LIMIT, offset, timeoutMs } = opts;
  const key = cacheKey({ domain, days, limit, offset });
  const fresh = (() => {
    const hit = cache.get(key);
    return hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS ? hit : null;
  })();

  const [items, setItems] = useState<WeaknessIndexItem[]>(fresh?.result.items ?? []);
  const [meta, setMeta] = useState<WeaknessIndexMeta | null>(fresh?.result.meta ?? null);
  const [loading, setLoading] = useState<boolean>(!fresh);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [reachable, setReachable] = useState<boolean>(fresh?.result.reachable ?? true);
  const [fetchedAt, setFetchedAt] = useState<string | null>(
    fresh ? new Date(fresh.fetchedAt).toISOString() : null,
  );
  // A single in-flight load is reused so a manual/effect overlap can't double-fetch.
  const inFlight = useRef<Promise<void> | null>(null);

  const load = useCallback(
    (force: boolean): Promise<void> => {
      if (inFlight.current) return inFlight.current;
      const hit = cache.get(key);
      if (!force && hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
        setItems(hit.result.items);
        setMeta(hit.result.meta);
        setReachable(hit.result.reachable);
        setFetchedAt(new Date(hit.fetchedAt).toISOString());
        setLoading(false);
        return Promise.resolve();
      }
      setRefreshing(true);
      const run = (async () => {
        const result = await fetchWeaknessIndex({ domain, days, limit, offset, timeoutMs });
        setReachable(result.reachable);
        setItems(result.items);
        setMeta(result.meta);
        // Only cache + stamp a successful, reachable load; an offline blip keeps
        // any previously-cached payload intact (it just won't be refreshed).
        if (result.reachable) {
          const now = Date.now();
          cache.set(key, { result, fetchedAt: now });
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
    [key, domain, days, limit, offset, timeoutMs],
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

  return { items, meta, loading, refreshing, reachable, fetchedAt, refresh };
}

export default useWeaknessIndex;
