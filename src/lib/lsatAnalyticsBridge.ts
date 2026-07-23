/**
 * Host-side client for the LSAT backend's ANALYTICS endpoints (StudyVault).
 *
 * ANL-6: the host Analytics page (`src/pages/Analytics.jsx`) renders a unified
 * activity heatmap + confidence-calibration scatter with a CFA | LSAT | All
 * toggle. The CFA series comes from the host's local Dexie telemetry; the LSAT
 * series comes from the LSAT FastAPI sidecar on 127.0.0.1:8100 over HTTP — the
 * same transport System Health uses (see `lsatBackend.ts`). The host can't reach
 * the LSAT React app, but it CAN read the sidecar's analytics, which already
 * expose `/api/analytics/activity` (per-day attempts) and `/api/analytics/
 * calibration` (per-confidence-band accuracy + over/under-confidence verdict).
 *
 * This is a SEPARATE, additive file (it does not touch `lsatBackend.ts`): it
 * owns the analytics boundary only, with the same fully-degrading
 * timeout/AbortController pattern — any failure (sidecar down, timeout, shape
 * drift) resolves to `{ reachable: false, ... }` with empty data so the page
 * degrades to a host-only view rather than throwing or hanging.
 *
 * DATA-1 (K1): the request param boundary is pinned to the LSAT domain's
 * generated OpenAPI types (`@/domains/lsat/lib/api.gen`). Those endpoints type
 * their 2xx body as an open `LegacySuccessResponse`, so the response shapes are
 * read defensively into explicit host-facing interfaces below (mirroring the
 * concrete shapes the backend's `analytics.activity` / `confidence_calibration`
 * return) rather than trusting a fixed generated payload.
 */
import type { operations, paths } from '@/domains/lsat/lib/api.gen';
import { fetchLsatSidecarJson } from './lsatSidecarClient';

const ACTIVITY_PATH = '/api/analytics/activity' satisfies keyof paths;
const CALIBRATION_PATH = '/api/analytics/calibration' satisfies keyof paths;

/** Query window accepted by `GET /api/analytics/activity` (generated contract). */
type ActivityDays = NonNullable<
  operations['activity_api_analytics_activity_get']['parameters']['query']
>['days'];

/** One day of LSAT study activity (mirrors backend `analytics.activity`). */
export interface LsatActivityDay {
  /** YYYY-MM-DD (UTC day key, matching the host heatmap's day keys). */
  date: string;
  /** Attempts logged that day — the heatmap's intensity signal. */
  questions: number;
  /** Minutes studied that day (informational; not plotted). */
  minutes: number;
  /** Correct attempts that day. */
  correct: number;
  /** Distinct sessions that day. */
  sessions: number;
}

/** One confidence band from `GET /api/analytics/calibration`. */
export interface LsatCalibrationBand {
  /** "sure" | "likely" | "guess" — the LSAT confidence vocabulary. */
  confidence: string;
  attempts: number;
  correct: number;
  /** Realized accuracy 0..1, or null when the band has no attempts. */
  accuracy: number | null;
  /** Nominal confidence the band asserts (sure=0.9, likely=0.65, guess=0.3). */
  nominal_confidence: number;
}

export interface LsatActivityReport {
  /** True when the sidecar answered 2xx with a usable activity payload. */
  reachable: boolean;
  /** Per-day activity (empty when unreachable). */
  days: LsatActivityDay[];
}

export interface LsatCalibrationReport {
  /** True when the sidecar answered 2xx with a usable calibration payload. */
  reachable: boolean;
  /** Per-band calibration rows (empty when unreachable). */
  bands: LsatCalibrationBand[];
  /** Over/under-confidence verdict ("overconfident" | "underconfident" |
   *  "calibrated" | "unknown"), or null when unreachable. */
  verdict: string | null;
  /** Signed gap = mean asserted confidence − realized accuracy (positive =
   *  overconfident), or null when there were no rated attempts. */
  calibrationGap: number | null;
}

async function fetchJson(
  path: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; data: unknown } | { ok: false; status: 0; error: string }> {
  const res = await fetchLsatSidecarJson(path, {
    timeoutMs,
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  if (res.reachable) return { ok: res.ok, status: res.status, data: res.data };
  return { ok: false, status: 0, error: res.error ?? 'LSAT backend unreachable' };
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Fetch the LSAT sidecar's per-day study activity for the unified heatmap.
 * Never throws — any failure degrades to `{ reachable: false, days: [] }` so the
 * host heatmap renders its CFA-only view. `days` follows the host heatmap window
 * (12 weeks ≈ 84 days; default 120 matches the backend default).
 */
export async function getLsatActivity(
  days: ActivityDays = 120,
  timeoutMs = 3000,
): Promise<LsatActivityReport> {
  const window = typeof days === 'number' && days > 0 ? Math.min(730, Math.round(days)) : 120;
  const res = await fetchJson(`${ACTIVITY_PATH}?days=${window}`, timeoutMs);
  if (!('ok' in res) || !res.ok || !Array.isArray(res.data)) {
    return { reachable: false, days: [] };
  }
  const rows = (res.data as Array<Record<string, unknown>>)
    .filter((row) => row && typeof row === 'object' && typeof row.date === 'string')
    .map((row) => ({
      date: String(row.date),
      questions: num(row.questions),
      minutes: num(row.minutes),
      correct: num(row.correct),
      sessions: num(row.sessions),
    }));
  return { reachable: true, days: rows };
}

/**
 * Fetch the LSAT sidecar's confidence-calibration bands for the unified scatter.
 * Never throws — any failure degrades to `{ reachable: false, bands: [] }`.
 */
export async function getLsatCalibration(
  days?: number | null,
  timeoutMs = 3000,
): Promise<LsatCalibrationReport> {
  const query = typeof days === 'number' && days > 0 ? `?days=${Math.min(730, Math.round(days))}` : '';
  const res = await fetchJson(`${CALIBRATION_PATH}${query}`, timeoutMs);
  if (!('ok' in res) || !res.ok || !res.data || typeof res.data !== 'object' || Array.isArray(res.data)) {
    return { reachable: false, bands: [], verdict: null, calibrationGap: null };
  }
  const body = res.data as { bands?: unknown; verdict?: unknown; calibration_gap?: unknown };
  const bands = Array.isArray(body.bands)
    ? (body.bands as Array<Record<string, unknown>>)
        .filter((row) => row && typeof row === 'object' && typeof row.confidence === 'string')
        .map((row) => ({
          confidence: String(row.confidence),
          attempts: num(row.attempts),
          correct: num(row.correct),
          accuracy: numOrNull(row.accuracy),
          nominal_confidence: num(row.nominal_confidence),
        }))
    : [];
  return {
    reachable: true,
    bands,
    verdict: typeof body.verdict === 'string' ? body.verdict : null,
    calibrationGap: numOrNull(body.calibration_gap),
  };
}
