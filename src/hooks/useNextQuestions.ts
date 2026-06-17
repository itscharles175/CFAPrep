/**
 * LEARN-6 — host hook for adaptive next-question routing over HOST content.
 *
 * The LSAT sidecar's `POST /api/adaptivity/next` ranks the next things to study
 * by expected learning utility. LEARN-6 adds an optional `domain` to that route
 * so it routes over the HOST plane (CFA/Quant/Excel): instead of the LSAT
 * `Question` pool, it scores the host objectives mirrored read-only into
 * `HostProgressSnapshot` (DATA-4a) against the SAME unified cross-domain ability
 * (LEARN-1). The result is a ranked candidate list — each carrying the host
 * `contentId` + objective `key`, the predicted `expectedSuccess`, a `zpdFit`,
 * and a shared `reason` — so a host drill surface can recommend the most
 * productive next objective without re-deriving the math locally.
 *
 * Transport mirrors `lsatBackend.ts` / `blindReviewBridge.ts`: a fully-degrading
 * fetch (AbortController + timeout). It NEVER throws — any failure (sidecar down,
 * timeout, shape drift) resolves to `{ reachable: false, recommendations: [] }`
 * so the caller falls back to its own local ordering rather than hanging. The
 * recommendation candidate TYPES live here (NOT in `learningTypes.ts`) since they
 * are this route's response contract, read defensively from an untyped body.
 *
 * DATA-1: the `domain` body field ships ahead of the next `api.gen.ts`
 * regeneration, so the path is a string literal for now (same precedent as
 * `blindReviewBridge.ts` / `studyProfileBridge.ts`). Swap to the generated
 * operation once the contract is regenerated with the param.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DomainId } from '../lib/learningTypes';

const LSAT_API_BASE = 'http://127.0.0.1:8100';
const NEXT_PATH = '/api/adaptivity/next';

/** Default per-request timeout — generous, this is never on a render-blocking path. */
const DEFAULT_TIMEOUT_MS = 3500;
/** Backend clamps `count` to 1..25; mirror that so the request is never rejected. */
const MIN_COUNT = 1;
const MAX_COUNT = 25;
const DEFAULT_COUNT = 5;

/**
 * Why the engine surfaced a candidate. Mirrors the backend `reason` vocabulary
 * (shared between the LSAT and host planes) so the UI can present one label set:
 *   - `stretch` — below the productive success band (a deliberate challenge),
 *   - `fluency_check` — above the band (already strong; confirm retention),
 *   - `recent_gap_review` — a leech / low-mastery objective worth repairing,
 *   - `maximum_information` — squarely in the ZPD (most informative).
 * The four known reasons are documented as constants; the type stays `string`
 * so an unknown future reason still renders (read defensively from the wire).
 */
export type NextQuestionReason = string;

/** The four known shared reasons (documented; the wire may add more). */
export const NEXT_QUESTION_REASONS = [
  'stretch',
  'fluency_check',
  'recent_gap_review',
  'maximum_information',
] as const;

/** One ranked host-content recommendation (the route's per-item shape). */
export interface NextQuestionCandidate {
  /** Host content id (namespaced cross-domain id) the host maps back to Dexie. */
  contentId: string;
  /** The objective / topic key this candidate drills. */
  key: string;
  /** The host plane this candidate belongs to. */
  domain: DomainId;
  /** Locally observed mastery for this objective (0..1). */
  masteryFraction: number;
  /** Estimated difficulty on the shared 1..5 scale. */
  difficultyEstimate: number;
  /** Predicted probability of a correct first attempt (0..1). */
  expectedSuccess: number;
  /** How well the candidate sits inside the productive success band (0..1). */
  zpdFit: number;
  /** Blended learning-utility score the ranking is sorted by (0..1). */
  utilityScore: number;
  /** Why this candidate was surfaced (shared reason vocabulary). */
  reason: NextQuestionReason;
  /** True when the objective is flagged as a leech (repeated lapses). */
  leech: boolean;
  /** Attempts observed for this objective so far. */
  attempts: number;
}

/** The adaptive-routing report this hook resolves to. Never thrown — always returned. */
export interface NextQuestionsReport {
  /** True when the sidecar answered a 2xx with a usable host-plane payload. */
  reachable: boolean;
  /** The host plane this report covers. */
  domain: DomainId;
  /** Ranked candidates, most-productive first (empty on any failure). */
  recommendations: NextQuestionCandidate[];
  /** The selector strategy the engine used (e.g. `zpd_repair`), when reported. */
  strategy?: string;
  /** Unified ability mastery (0..1) for this plane, when reported. */
  mastery?: number;
  /** Human-readable status for diagnostics. */
  detail: string;
}

// ---------------------------------------------------------------------------
// Defensive readers (the route has no narrow response_model in the baseline).
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readCandidate(raw: unknown, domain: DomainId): NextQuestionCandidate | null {
  if (!isRecord(raw)) return null;
  const key = str(raw.key);
  const contentId = str(raw.content_id) || key;
  // A candidate with neither a content id nor a key is unusable — drop it.
  if (!contentId && !key) return null;
  const reasonRaw = str(raw.reason);
  return {
    contentId,
    key,
    domain,
    masteryFraction: num(raw.mastery_fraction),
    difficultyEstimate: num(raw.difficulty_estimate),
    expectedSuccess: num(raw.expected_success),
    zpdFit: num(raw.zpd_fit),
    utilityScore: num(raw.utility_score),
    reason: reasonRaw || 'maximum_information',
    leech: raw.leech === true,
    attempts: num(raw.attempts),
  };
}

/** A reachable-false report (used on every failure path). */
function unreachable(domain: DomainId, detail: string): NextQuestionsReport {
  return { reachable: false, domain, recommendations: [], detail };
}

async function fetchJson(
  path: string,
  body: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; data: unknown } | { ok: false; status: 0; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${LSAT_API_BASE}${path}`, {
      signal: controller.signal,
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body,
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON body */
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the adaptive next-question routing for one HOST plane from the LSAT
 * sidecar. Never throws — any failure degrades to `{ reachable: false,
 * recommendations: [] }` so the caller can fall back to its own ordering.
 *
 * `count` is clamped to the backend's 1..25 window. `domain` is required (the
 * host plane to route over); the LSAT-only `q_type`/`section_type` filters are
 * intentionally not exposed here.
 */
export async function fetchNextQuestions(
  opts: { domain: DomainId; count?: number; timeoutMs?: number },
): Promise<NextQuestionsReport> {
  const { domain, count = DEFAULT_COUNT, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const clamped = Math.max(MIN_COUNT, Math.min(MAX_COUNT, Math.round(count)));
  const body = JSON.stringify({ domain, count: clamped });
  const res = await fetchJson(NEXT_PATH, body, timeoutMs);

  if (!('ok' in res) || !res.ok) {
    const reason = 'error' in res ? res.error : `responded ${('status' in res ? res.status : 0)}`;
    return unreachable(domain, `Adaptive routing unavailable — ${reason}.`);
  }
  if (!isRecord(res.data)) {
    return unreachable(domain, 'Adaptive routing returned an unexpected shape.');
  }

  const body0 = res.data;
  const rawRecs = Array.isArray(body0.recommendations) ? body0.recommendations : [];
  const recommendations = rawRecs
    .map((r) => readCandidate(r, domain))
    .filter((r): r is NextQuestionCandidate => r !== null);

  const selector = isRecord(body0.selector) ? body0.selector : {};
  const ability = isRecord(body0.ability) ? body0.ability : {};
  const strategy = str(selector.strategy) || undefined;
  const masteryRaw = ability.mastery;
  const mastery = typeof masteryRaw === 'number' && Number.isFinite(masteryRaw) ? masteryRaw : undefined;

  return {
    reachable: true,
    domain,
    recommendations,
    strategy,
    mastery,
    detail: recommendations.length
      ? `Ranked ${recommendations.length} next ${recommendations.length === 1 ? 'objective' : 'objectives'}.`
      : 'No host content to route yet — keep studying to build a signal.',
  };
}

/** Options for {@link useNextQuestions}. */
export interface UseNextQuestionsOptions {
  /** The host plane to route over. */
  domain: DomainId;
  /** How many recommendations to request (clamped 1..25). Defaults to 5. */
  count?: number;
  /** Disable the hook (skips all fetching). Defaults to enabled. */
  enabled?: boolean;
  /** Override the per-request timeout (ms). */
  timeoutMs?: number;
}

/** What {@link useNextQuestions} returns. */
export interface UseNextQuestions {
  /** The latest report, or null before the first fetch resolves. */
  report: NextQuestionsReport | null;
  /** True while a fetch is in flight. */
  loading: boolean;
  /** Re-run the routing now (e.g. after a study session). Never throws. */
  refresh: () => Promise<NextQuestionsReport>;
}

/**
 * LEARN-6 host hook: load adaptive next-question routing for one host plane and
 * keep it refreshable. Fetches once on mount (and whenever `domain`/`count`
 * change) and exposes `refresh()` for the caller to re-run after a session.
 * Fully degrading — a down sidecar yields a `reachable: false` report rather
 * than an error, and a stale in-flight response is discarded on unmount.
 */
export function useNextQuestions(opts: UseNextQuestionsOptions): UseNextQuestions {
  const { domain, count = DEFAULT_COUNT, enabled = true, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const [report, setReport] = useState<NextQuestionsReport | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  // Guards against setting state after unmount / on a superseded fetch.
  const aliveRef = useRef(true);
  const requestIdRef = useRef(0);

  const run = useCallback(async (): Promise<NextQuestionsReport> => {
    const requestId = ++requestIdRef.current;
    if (aliveRef.current) setLoading(true);
    const next = await fetchNextQuestions({ domain, count, timeoutMs });
    // Only the latest request may publish (discard a superseded/stale response).
    if (aliveRef.current && requestId === requestIdRef.current) {
      setReport(next);
      setLoading(false);
    }
    return next;
  }, [domain, count, timeoutMs]);

  useEffect(() => {
    aliveRef.current = true;
    if (enabled) void run();
    return () => {
      aliveRef.current = false;
    };
  }, [enabled, run]);

  return { report, loading, refresh: run };
}
