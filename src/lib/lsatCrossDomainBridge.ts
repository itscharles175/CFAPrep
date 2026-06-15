/**
 * Host-side client for the LSAT backend's CROSS-DOMAIN analytics rollup (ANL-1).
 *
 * ANL-6 shipped `lsatAnalyticsBridge.ts` (activity + calibration). This is a
 * SEPARATE, additive sibling that owns only the new
 * `GET /api/analytics/cross-domain` endpoint, with the SAME fully-degrading
 * timeout/AbortController contract: any failure (sidecar down, timeout, shape
 * drift) resolves to `{ reachable: false, ... }` with empty data so the host
 * Analytics page degrades to its CFA-only view rather than throwing or hanging.
 *
 * The route is bidirectional: the host can pass its own (CFA/Quant/Excel) numbers
 * as query params so the backend merges them, OR omit them and merge the LSAT
 * payload with local Dexie analytics client-side. DATA-4a owns the persisted
 * host->backend snapshot feed; this bridge only reads the live rollup, defaulting
 * to the LSAT-only view (no host numbers passed) so it never depends on DATA-4a.
 */

const LSAT_API_BASE = 'http://127.0.0.1:8100';

/** Per-domain rollup row (mirrors backend `analytics.cross_domain`). */
export interface CrossDomainStat {
  /** "lsat" | "host". */
  domain: string;
  attempts: number;
  correct: number;
  /** Realized accuracy 0..1, or null when the domain has no attempts. */
  accuracy: number | null;
  studyMinutes: number;
  streakDays: number;
}

/** One merged weakest-type entry across domains. */
export interface CrossDomainWeakType {
  domain: string;
  label: string;
  accuracy: number | null;
  attempts: number;
}

/** One day of the combined activity trend. */
export interface CrossDomainTrendPoint {
  date: string;
  lsatQuestions: number;
  hostQuestions: number;
  questions: number;
}

export interface CrossDomainReport {
  /** True when the sidecar answered 2xx with a usable rollup payload. */
  reachable: boolean;
  /** Combined study minutes across domains (0 when unreachable). */
  studyMinutes: number;
  /** Longest active streak across domains (0 when unreachable). */
  combinedStreakDays: number;
  /** Per-domain accuracy/time/streak rows (empty when unreachable). */
  accuracyByDomain: CrossDomainStat[];
  /** Merged weakest-types list, weakest-first (empty when unreachable). */
  weakestTypes: CrossDomainWeakType[];
  /** Combined per-day activity trend (empty when unreachable). */
  trend: CrossDomainTrendPoint[];
}

/** Optional host-side numbers to merge into the backend rollup. */
export interface CrossDomainHostInput {
  /** Window in days for the trend / accuracy slice (default 30). */
  days?: number;
  /** Host (CFA/Quant/Excel) attempt count in the window. */
  hostAttempts?: number;
  /** Host correct count in the window. */
  hostCorrect?: number;
  /** Host study minutes in the window. */
  hostStudyMinutes?: number;
  /** Host current streak (days). */
  hostStreakDays?: number;
}

const EMPTY: CrossDomainReport = {
  reachable: false,
  studyMinutes: 0,
  combinedStreakDays: 0,
  accuracyByDomain: [],
  weakestTypes: [],
  trend: [],
};

async function fetchJson(
  path: string,
  timeoutMs: number,
): Promise<{ ok: boolean; data: unknown } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${LSAT_API_BASE}${path}`, {
      signal: controller.signal,
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON body */
    }
    return { ok: res.ok, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function buildQuery(input: CrossDomainHostInput): string {
  const params = new URLSearchParams();
  const days = typeof input.days === 'number' && input.days > 0
    ? Math.min(730, Math.round(input.days))
    : 30;
  params.set('days', String(days));
  if (typeof input.hostAttempts === 'number' && input.hostAttempts >= 0) {
    params.set('host_attempts', String(Math.round(input.hostAttempts)));
  }
  if (typeof input.hostCorrect === 'number' && input.hostCorrect >= 0) {
    params.set('host_correct', String(Math.round(input.hostCorrect)));
  }
  if (typeof input.hostStudyMinutes === 'number' && input.hostStudyMinutes >= 0) {
    params.set('host_study_minutes', String(input.hostStudyMinutes));
  }
  if (typeof input.hostStreakDays === 'number' && input.hostStreakDays >= 0) {
    params.set('host_streak_days', String(Math.round(input.hostStreakDays)));
  }
  return params.toString();
}

/**
 * Fetch the LSAT sidecar's cross-domain rollup for the unified Analytics summary.
 * Never throws — any failure degrades to a `reachable: false` empty report so the
 * host renders its CFA-only view. Host numbers in `input` are merged server-side;
 * omit them for the LSAT-only view.
 */
export async function getLsatCrossDomain(
  input: CrossDomainHostInput = {},
  timeoutMs = 3000,
): Promise<CrossDomainReport> {
  const res = await fetchJson(`/api/analytics/cross-domain?${buildQuery(input)}`, timeoutMs);
  if (!('ok' in res) || !res.ok || !res.data || typeof res.data !== 'object' || Array.isArray(res.data)) {
    return { ...EMPTY };
  }
  const body = res.data as Record<string, unknown>;
  const accuracyByDomain = Array.isArray(body.accuracy_by_domain)
    ? (body.accuracy_by_domain as Array<Record<string, unknown>>)
        .filter((row) => row && typeof row === 'object' && typeof row.domain === 'string')
        .map((row) => ({
          domain: String(row.domain),
          attempts: num(row.attempts),
          correct: num(row.correct),
          accuracy: numOrNull(row.accuracy),
          studyMinutes: num(row.study_minutes),
          streakDays: num(row.streak_days),
        }))
    : [];
  const weakestTypes = Array.isArray(body.weakest_types)
    ? (body.weakest_types as Array<Record<string, unknown>>)
        .filter((row) => row && typeof row === 'object' && typeof row.label === 'string')
        .map((row) => ({
          domain: typeof row.domain === 'string' ? row.domain : 'lsat',
          label: String(row.label),
          accuracy: numOrNull(row.accuracy),
          attempts: num(row.attempts),
        }))
    : [];
  const trend = Array.isArray(body.trend_30d)
    ? (body.trend_30d as Array<Record<string, unknown>>)
        .filter((row) => row && typeof row === 'object' && typeof row.date === 'string')
        .map((row) => ({
          date: String(row.date),
          lsatQuestions: num(row.lsat_questions),
          hostQuestions: num(row.host_questions),
          questions: num(row.questions),
        }))
    : [];
  return {
    reachable: true,
    studyMinutes: num(body.study_minutes),
    combinedStreakDays: num(body.combined_streak_days),
    accuracyByDomain,
    weakestTypes,
    trend,
  };
}
